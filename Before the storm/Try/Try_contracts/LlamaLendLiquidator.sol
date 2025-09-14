// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// --------------------
/// Minimal Interfaces
/// --------------------
interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

interface IBalancerVault {
    function flashLoan(
        address recipient,
        address[] calldata tokens,
        uint256[] calldata amounts,
        bytes calldata userData
    ) external;
}

interface ILlamaLendController {
    function collateral_token() external view returns (address);
    function borrowed_token() external view returns (address);
    function stablecoin() external view returns (address);
    function user_state(address user) external view returns (uint256 collateral, uint256 debt);
    function debt(address user) external view returns (uint256);
    function collateral(address user) external view returns (uint256);

    function liquidate(address user, uint256 min_x) external returns (uint256);
    function liquidate_extended(
        address user,
        uint256 min_x,
        uint256 frac,
        bool use_eth,
        address callbacker,
        bytes32 callback_sig,
        uint256[5] calldata args
    ) external returns (uint256);
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline
    ) external returns (uint[] memory amounts);

    function swapTokensForExactTokens(
        uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline
    ) external returns (uint[] memory amounts);

    function getAmountsIn(uint amountOut, address[] calldata path)
        external view returns (uint[] memory amounts);
}

interface IUniswapV2Pair {
    function token0() external view returns (address);
    function swap(uint amount0Out, uint amount1Out, address to, bytes calldata data) external;
}

interface ICurvePoolUint {
    function get_dy(uint256 i, uint256 j, uint256 dx) external view returns (uint256);
    function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) external returns (uint256);
}
interface ICurvePoolInt {
    function get_dy(int128 i, int128 j, uint256 dx) external view returns (uint256);
    function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) external returns (uint256);
}
interface ICurvePoolCoins {
    function coins(uint256) external view returns (address);
}

/// --------------------------------------
/// LlamaLendLiquidatorV2 (WETH-only)
/// --------------------------------------
contract LlamaLendLiquidatorV2 {
    // Protocols
    address constant BALANCER_VAULT     = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address constant UNISWAP_V2_ROUTER  = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D; // 回调外可用
    address constant SUSHI_V2_ROUTER    = 0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F; // 回调内使用
    address constant CURVE_CRVUSD_USDT  = 0x390f3595bCa2Df7d23783dFd126427CCeb997BF4;
    address constant WETH_USDT_PAIR     = 0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852; // UniV2 WETH/USDT

    // Tokens
    address constant CRV    = 0xD533a949740bb3306d119CC777fa900bA034cd52;
    address constant CRVUSD = 0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E;
    address constant WETH   = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant USDT   = 0xdAC17F958D2ee523a2206206994597C13D831ec7;

    // Errors
    error NotVault();
    error UnexpectedFlashToken();
    error WrongTokens();
    error UserNotLiquidatable();
    error InsufficientCollateral();
    error RepayFailed();
    error CurveSwapFailed();
    error UniSwapFailed();
    error LiquidationFailed();
    error NotEnoughCRVLeft();
    error FlashLoanFailed(bytes lowLevelData);

    // Events
    event Debug(string tag, uint256 val);
    event Liquidated(address controller, address borrower, uint256 crvKept);

    /// --------------------
    /// Math / helpers
    /// --------------------
    function _ceilDiv(uint256 x, uint256 y) internal pure returns (uint256) {
        return (x + y - 1) / y;
    }
    function _repayWETHForSameToken(uint256 amountOut) internal pure returns (uint256) {
        // UniswapV2 fee=0.3%: repay = ceil(out * 1000 / 997)
        return _ceilDiv(amountOut * 1000, 997);
    }

    /// Curve helpers
    function _getIdx(address pool, address a, address b) internal view returns (uint256 i, uint256 j) {
        address c0 = ICurvePoolCoins(pool).coins(0);
        address c1 = ICurvePoolCoins(pool).coins(1);
        if (c0 == a && c1 == b) return (0, 1);
        if (c0 == b && c1 == a) return (1, 0);
        revert WrongTokens();
    }
    function _curveGetDy(address pool, uint256 i, uint256 j, uint256 dx) internal view returns (uint256) {
        try ICurvePoolUint(pool).get_dy(i, j, dx) returns (uint256 q) { return q; } catch {}
        int128 ii = int128(int256(i)); int128 jj = int128(int256(j));
        require(uint256(uint128(ii)) == i && uint256(uint128(jj)) == j, "idx>int128");
        try ICurvePoolInt(pool).get_dy(ii, jj, dx) returns (uint256 q2) { return q2; } catch {
            revert CurveSwapFailed();
        }
    }
    function _curveExchange(address pool, uint256 i, uint256 j, uint256 dx, uint256 minDy) internal returns (uint256) {
        try ICurvePoolUint(pool).exchange(i, j, dx, minDy) returns (uint256 o) { return o; } catch {}
        int128 ii = int128(int256(i)); int128 jj = int128(int256(j));
        require(uint256(uint128(ii)) == i && uint256(uint128(jj)) == j, "idx>int128");
        try ICurvePoolInt(pool).exchange(ii, jj, dx, minDy) returns (uint256 o2) { return o2; } catch {
            revert CurveSwapFailed();
        }
    }
    function _curveExchangeExternal(address pool, uint256 i, uint256 j, uint256 dx, uint256 minDy) external returns (uint256) {
        require(msg.sender == address(this), "only self");
        return _curveExchange(pool, i, j, dx, minDy);
    }

    /// --------------------
    /// UniswapV2 flash-swap callback (WETH only)
    /// --------------------
    function uniswapV2Call(
        address sender,
        uint amount0,
        uint amount1,
        bytes calldata data
    ) external {
        require(msg.sender == WETH_USDT_PAIR, "only WETH/USDT pair");
        require(sender == address(this), "sender must be this");

        (address controller, address borrower, address beneficiary, uint256 debtHint, uint256 minCrvLeft)
            = abi.decode(data, (address, address, address, uint256, uint256));

        bool wethIsToken0 = _getWETHPosition();
        uint256 borrowedWETH = (wethIsToken0 ? amount0 : amount1);
        require(borrowedWETH > 0, "WETH-only flash");

        emit Debug("flash_weth_out", borrowedWETH);

        uint256 repayWETH = _repayWETHForSameToken(borrowedWETH);
        emit Debug("repay_weth_needed", repayWETH);

        bool success = false;
        try this._executeLiquidationFlow(controller, borrower, borrowedWETH, repayWETH, minCrvLeft) {
            success = true;
            emit Debug("main_flow_success", 1);
        } catch {
            emit Debug("main_flow_failed", 0);
            _emergencyUnwindToWETH(repayWETH); // 兜底：先把应还的 WETH 凑够
        }

        // 归还 WETH 给 pair
        uint256 wethBal = IERC20(WETH).balanceOf(address(this));
        require(wethBal >= repayWETH, "insufficient WETH for repay");
        require(IERC20(WETH).transfer(WETH_USDT_PAIR, repayWETH), "repay WETH failed");

        if (success) {
            _payoutCRV(beneficiary, minCrvLeft);
            emit Liquidated(controller, borrower, IERC20(CRV).balanceOf(address(this)));
        } else {
            emit Debug("emergency_mode", 1);
        }
    }

    // 主流程：外部函数以便 try/catch
    function _executeLiquidationFlow(
        address controller,
        address borrower,
        uint256 wethAmount,
        uint256 repayWETH,
        uint256 minCrvLeft
    ) external {
        require(msg.sender == address(this), "only self");

        // WETH -> USDT（Sushi），再 USDT -> crvUSD（Curve）
        _swapExactWETHToUSDTWithRouter(wethAmount, SUSHI_V2_ROUTER);
        uint256 usdtBal = IERC20(USDT).balanceOf(address(this));
        require(usdtBal > 0, "no USDT after WETH swap");

        uint256 debt = _validateAndGetDebt(controller, borrower, 0);

        _acquireCrvUSD_fromUSDT(usdtBal, debt);

        _executeLiquidation(controller, borrower, debt);

        // 用 CRV 补足应还的 WETH
        uint256 wethBal = IERC20(WETH).balanceOf(address(this));
        if (wethBal < repayWETH) {
            uint256 shortWETH = repayWETH - wethBal;
            _sellCRVForExactWETHWithRouter(shortWETH, minCrvLeft, SUSHI_V2_ROUTER);
        }
    }

    // 自救：把手里任何资产换回 WETH 来还款
    function _emergencyUnwindToWETH(uint256 targetWETH) internal {
        uint256 wethBal = IERC20(WETH).balanceOf(address(this));
        if (wethBal >= targetWETH) return;

        uint256 needWETH = targetWETH - wethBal;

        // 1) USDT -> WETH
        uint256 usdtBal = IERC20(USDT).balanceOf(address(this));
        if (usdtBal > 0 && needWETH > 0) {
            address[] memory p = new address[](2);
            p[0] = USDT; p[1] = WETH;
            IERC20(USDT).approve(SUSHI_V2_ROUTER, 0);
            IERC20(USDT).approve(SUSHI_V2_ROUTER, usdtBal);
            IUniswapV2Router(SUSHI_V2_ROUTER).swapExactTokensForTokens(
                usdtBal, 0, p, address(this), block.timestamp + 300
            );
            IERC20(USDT).approve(SUSHI_V2_ROUTER, 0);
            wethBal = IERC20(WETH).balanceOf(address(this));
            if (wethBal >= targetWETH) return;
            needWETH = targetWETH - wethBal;
        }

        // 2) crvUSD -> USDT -> WETH
        uint256 crvusdBal = IERC20(CRVUSD).balanceOf(address(this));
        if (crvusdBal > 0 && needWETH > 0) {
            (uint256 iUSDT, uint256 jCRVUSD) = _getIdx(CURVE_CRVUSD_USDT, USDT, CRVUSD);
            IERC20(CRVUSD).approve(CURVE_CRVUSD_USDT, 0);
            IERC20(CRVUSD).approve(CURVE_CRVUSD_USDT, crvusdBal);
            _curveExchange(CURVE_CRVUSD_USDT, jCRVUSD, iUSDT, crvusdBal, 0);
            IERC20(CRVUSD).approve(CURVE_CRVUSD_USDT, 0);

            uint256 usdtGot = IERC20(USDT).balanceOf(address(this));
            if (usdtGot > 0) {
                address[] memory p2 = new address[](2);
                p2[0] = USDT; p2[1] = WETH;
                IERC20(USDT).approve(SUSHI_V2_ROUTER, 0);
                IERC20(USDT).approve(SUSHI_V2_ROUTER, usdtGot);
                IUniswapV2Router(SUSHI_V2_ROUTER).swapExactTokensForTokens(
                    usdtGot, 0, p2, address(this), block.timestamp + 300
                );
                IERC20(USDT).approve(SUSHI_V2_ROUTER, 0);
                wethBal = IERC20(WETH).balanceOf(address(this));
                if (wethBal >= targetWETH) return;
                needWETH = targetWETH - wethBal;
            }
        }

        // 3) CRV -> WETH（保留 20%）
        uint256 crvBal = IERC20(CRV).balanceOf(address(this));
        if (crvBal > 0 && needWETH > 0) {
            uint256 useAmount = crvBal * 80 / 100;
            address[] memory path = new address[](2);
            path[0] = CRV; path[1] = WETH;

            IERC20(CRV).approve(SUSHI_V2_ROUTER, 0);
            IERC20(CRV).approve(SUSHI_V2_ROUTER, useAmount);
            IUniswapV2Router(SUSHI_V2_ROUTER).swapExactTokensForTokens(
                useAmount, 0, path, address(this), block.timestamp + 300
            );
            IERC20(CRV).approve(SUSHI_V2_ROUTER, 0);
        }
    }

    /// --------------------
    /// Balancer flash-loan (WETH only)
    /// --------------------
    function receiveFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external {
        if (msg.sender != BALANCER_VAULT) revert NotVault();
        (address controller, address borrower, address beneficiary, , uint256 minCrvLeft, address flashToken)
            = abi.decode(userData, (address, address, address, uint256, uint256, address));

        require(tokens.length == 1 && amounts.length == 1 && feeAmounts.length == 1, "bad lens");
        require(tokens[0] == flashToken, "flash token mismatch");
        require(flashToken == WETH, "WETH-only");

        emit Debug("flash_amount", amounts[0]);
        emit Debug("flash_fee", feeAmounts[0]);

        // 获取债务
        uint256 debt = _validateAndGetDebt(controller, borrower, 0);

        // WETH -> USDT -> crvUSD
        _acquireCrvUSD_fromWETH_withRouter(amounts[0], debt, UNISWAP_V2_ROUTER);

        // 清算
        _executeLiquidation(controller, borrower, debt);

        // 归还（WETH），必要时卖 CRV
        uint256 repay = amounts[0] + feeAmounts[0];
        uint256 wethBal = IERC20(WETH).balanceOf(address(this));
        if (wethBal < repay) {
            uint256 shortWETH = repay - wethBal;
            _sellCRVForExactWETH(shortWETH, minCrvLeft);
        }
        bool ok = IERC20(WETH).transfer(BALANCER_VAULT, repay);
        if (!ok) revert RepayFailed();

        _payoutCRV(beneficiary, minCrvLeft);
        emit Liquidated(controller, borrower, IERC20(CRV).balanceOf(address(this)));
    }

    /// --------------------
    /// Validation / state
    /// --------------------
    function _getBorrowedToken(address controller) internal view returns (address) {
        try ILlamaLendController(controller).borrowed_token() returns (address t) { return t; } catch {}
        try ILlamaLendController(controller).stablecoin() returns (address t2) { return t2; } catch {
            revert WrongTokens();
        }
    }

    function _getUserState(address controller, address user) internal view returns (uint256, uint256) {
        try ILlamaLendController(controller).user_state(user) returns (uint256 c, uint256 d) { return (c, d); } catch {}
        try ILlamaLendController(controller).collateral(user) returns (uint256 c2) {
            try ILlamaLendController(controller).debt(user) returns (uint256 d2) { return (c2, d2); } catch {
                revert UserNotLiquidatable();
            }
        } catch {
            revert InsufficientCollateral();
        }
    }

    function _validateAndGetDebt(address controller, address borrower, uint256 /*debtHint*/) internal returns (uint256) {
        address collateralToken = ILlamaLendController(controller).collateral_token();
        address borrowedToken   = _getBorrowedToken(controller);
        require(collateralToken == CRV && borrowedToken == CRVUSD, "Wrong controller tokens");

        (uint256 col, uint256 debt) = _getUserState(controller, borrower);
        emit Debug("user_col", col);
        emit Debug("user_debt", debt);
        if (debt == 0) revert UserNotLiquidatable();
        if (col == 0)  revert InsufficientCollateral();
        return debt;
    }

    /// --------------------
    /// Acquire crvUSD
    /// --------------------
    function _acquireCrvUSD_fromUSDT(uint256 usdtIn, uint256 debtCRVUSD) internal {
        (uint256 iUSDT, uint256 jCRVUSD) = _getIdx(CURVE_CRVUSD_USDT, USDT, CRVUSD);
        uint256 dyFull = _curveGetDy(CURVE_CRVUSD_USDT, iUSDT, jCRVUSD, usdtIn);
        require(dyFull > 0, "curve no dy");

        uint256 target = debtCRVUSD * 1005 / 1000; // debt * 1.005
        if (target > dyFull) target = dyFull;

        uint256 needUSDT = usdtIn * target / dyFull;
        if (needUSDT == 0) needUSDT = usdtIn;
        uint256 minDy = target * 995 / 1000; // 0.5% slippage

        IERC20(USDT).approve(CURVE_CRVUSD_USDT, 0);
        IERC20(USDT).approve(CURVE_CRVUSD_USDT, needUSDT);
        try this._curveExchangeExternal(CURVE_CRVUSD_USDT, iUSDT, jCRVUSD, needUSDT, minDy) { } catch {
            revert CurveSwapFailed();
        }
        IERC20(USDT).approve(CURVE_CRVUSD_USDT, 0);

        emit Debug("acq_crvusd_from_usdt", IERC20(CRVUSD).balanceOf(address(this)));
    }

    function _acquireCrvUSD_fromWETH_withRouter(uint256 wethIn, uint256 debtCRVUSD, address router) internal {
        _swapExactWETHToUSDTWithRouter(wethIn, router);
        uint256 usdtBal = IERC20(USDT).balanceOf(address(this));
        require(usdtBal > 0, "weth->usdt failed");
        _acquireCrvUSD_fromUSDT(usdtBal, debtCRVUSD);
    }

    /// --------------------
    /// Liquidation
    /// --------------------
    function _executeLiquidation(address controller, address borrower, uint256 debtCRVUSD) internal {
        uint256 have = IERC20(CRVUSD).balanceOf(address(this));
        require(have > 0, "no crvUSD");

        uint256 pay  = have < debtCRVUSD ? have : debtCRVUSD;
        uint256 frac = pay * 1e18 / debtCRVUSD;
        require(frac > 0, "frac=0");

        IERC20(CRVUSD).approve(controller, 0);
        IERC20(CRVUSD).approve(controller, pay);

        bool ok = false;
        try ILlamaLendController(controller).liquidate(borrower, 0) returns (uint256) {
            ok = true; emit Debug("liq_simple", pay);
        } catch {
            try ILlamaLendController(controller).liquidate_extended(
                borrower, 0, frac, false, address(0), bytes32(0), [uint256(0),0,0,0,0]
            ) returns (uint256) {
                ok = true; emit Debug("liq_ext", frac);
            } catch {
                revert LiquidationFailed();
            }
        }
        require(ok, "liquidation failed");
        emit Debug("crv_after_liq", IERC20(CRV).balanceOf(address(this)));
    }

    /// --------------------
    /// Swaps
    /// --------------------
    function _swapExactWETHToUSDTWithRouter(uint256 wethIn, address router) internal {
        IERC20(WETH).approve(router, 0);
        IERC20(WETH).approve(router, wethIn);

        address[] memory path = new address[](2);
        path[0] = WETH; path[1] = USDT;

        try IUniswapV2Router(router).swapExactTokensForTokens(
            wethIn, 0, path, address(this), block.timestamp + 300
        ) { } catch { revert UniSwapFailed(); }

        IERC20(WETH).approve(router, 0);
        emit Debug("weth_to_usdt", wethIn);
    }

    function _sellCRVForExactWETH(uint256 wethOut, uint256 minCrvLeft) internal {
        _sellCRVForExactWETHWithRouter(wethOut, minCrvLeft, UNISWAP_V2_ROUTER);
    }
    function _sellCRVForExactWETHWithRouter(uint256 wethOut, uint256 minCrvLeft, address router) internal {
        address[] memory path = new address[](2);
        path[0] = CRV; path[1] = WETH;

        uint[] memory amountsIn;
        try IUniswapV2Router(router).getAmountsIn(wethOut, path) returns (uint[] memory arr) {
            amountsIn = arr;
        } catch { revert UniSwapFailed(); }

        uint256 needCRV = amountsIn[0];
        uint256 maxCRV  = needCRV * 103 / 100; // +3% buffer

        uint256 crvBal = IERC20(CRV).balanceOf(address(this));
        if (crvBal < maxCRV + minCrvLeft) revert NotEnoughCRVLeft();

        IERC20(CRV).approve(router, 0);
        IERC20(CRV).approve(router, maxCRV);
        try IUniswapV2Router(router).swapTokensForExactTokens(
            wethOut, maxCRV, path, address(this), block.timestamp + 300
        ) { } catch { revert UniSwapFailed(); }
        IERC20(CRV).approve(router, 0);
        emit Debug("crv_to_weth_exactOut", wethOut);
    }

    /// --------------------
    /// Payout
    /// --------------------
    function _payoutCRV(address beneficiary, uint256 minCrvLeft) internal {
        uint256 crvBal = IERC20(CRV).balanceOf(address(this));
        if (crvBal < minCrvLeft) revert NotEnoughCRVLeft();
        IERC20(CRV).transfer(beneficiary, crvBal);
        emit Debug("payout_crv", crvBal);
    }

    /// --------------------
    /// Helpers
    /// --------------------
    function _getWETHPosition() internal view returns (bool wethIsToken0) {
        address token0 = IUniswapV2Pair(WETH_USDT_PAIR).token0();
        return token0 == WETH; // 主网该对 token0 = WETH
    }

    /// --------------------
    /// Public entrypoints (WETH only)
    /// --------------------
    // UniV2 flash swap：借 WETH
    function flashSwapAndLiquidate(
        address controller,
        address borrower,
        address beneficiary,
        uint256 debtHint,
        uint256 wethAmount,
        uint256 minCrvLeft
    ) external {
        bool wethIsToken0 = _getWETHPosition();
        uint256 amount0Out = wethIsToken0 ? wethAmount : 0;
        uint256 amount1Out = wethIsToken0 ? 0 : wethAmount;

        // 只编码业务参数（不编码数量），数量以回调的 amount0/1 为准
        bytes memory data = abi.encode(controller, borrower, beneficiary, debtHint, minCrvLeft);
        IUniswapV2Pair(WETH_USDT_PAIR).swap(amount0Out, amount1Out, address(this), data);
    }

    // Balancer：仅支持 WETH 闪贷（CRVUSD/USDT 不考虑）
    function flashAndLiquidateV2(
        address controller,
        address borrower,
        address beneficiary,
        uint256 debtHint,
        uint256 flashAmount,
        uint256 minCrvLeft,
        address flashToken
    ) external {
        require(flashToken == WETH, "WETH-only");
        address[] memory toks = new address[](1);
        toks[0] = flashToken;
        uint256[] memory amts = new uint256[](1);
        amts[0] = flashAmount;

        bytes memory data = abi.encode(controller, borrower, beneficiary, debtHint, minCrvLeft, flashToken);
        try IBalancerVault(BALANCER_VAULT).flashLoan(address(this), toks, amts, data) { } catch (bytes memory low) {
            revert FlashLoanFailed(low);
        }
    }

    fallback() external payable { revert("use flashSwapAndLiquidate (WETH)"); }
    receive() external payable { revert("no direct ETH"); }
}
