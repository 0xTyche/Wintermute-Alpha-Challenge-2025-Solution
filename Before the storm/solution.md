## [**Before the storm**](https://github.com/WintermuteResearch/Alpha-Challenge-2025/tree/main/04-before-the-storm)

### 题目

几天前，UwU Lend 被盗取了 2000 万美元，你发现漏洞利用者（https://etherscan.io/address/0x6F8C5692b00c2eBbd07e4FD80E332DfF3ab8E83c）的 Llamalend 仓位变得不健康，所以是时候清算了。你目前没有资金，所以唯一的办法就是使用闪电贷。

清算后，尽一切努力确保你的注册钱包中至少有 2 万 CRV。

### 说明

这个问题算是我个人最为感兴趣的一道问题了，主要由于闪电贷这个东西。这个是我接触web3以来，觉得最有意思的一个东西，它能够利用区块链的特性，让人们能够通过合约调用完成上亿美金的借贷调用，即使是身无分文的普通人，只要凑够足够的手续费就能够进行。曾经尝试过在remix上编写自己的闪电贷合约，但和实战相比总是觉得食之无味。

https://x.com/vanisaxxm/status/1958396749485400213 关于闪电的科普视频推荐这位博主的。

### 第一次尝试的思路

首先通过题目中给的地址（0x6F8C5692b00c2eBbd07e4FD80E332DfF3ab8E83c），通过链接进去会发现这个其实不是攻击者的地址，而是一个合约地址，但是基于这个合约地址就可以知道攻击者的地址（ https://etherscan.io/address/0x841ddf093f5188989fa1524e7b893de64b421f47 ），这个合约实际是攻击者的借贷仓位。

```solidity
markets: 14 Controller[3]=0xEdA215b7666936DEd834f76f3fBC6F323295110A coll=0xD533a949740bb3306d119CC777fa900bA034cd52 borr=0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E borrower debt = 8127727396534152807708083 >> TARGET CONTROLLER = 0xEdA215b7666936DEd834f76f3fBC6F323295110A
```

- **Controller**: `0xEdA215b7666936DEd834f76f3fBC6F323295110A`
- **抵押**: CRV，**借款**: crvUSD
- **Exploiter 债务**: `8127727396534152807708083` wei ≈ **8,127,727.396534153 crvUSD**

清算的基本路径应该怎么做？部署合约-写好脚本，然后使用脚本调用已经部署在链上的合约对其仓位执行交互。

这个是部署在fork chain上的合约，我最开始的思路是借贷usdt，然后兑换成crvUSD。

（1）结果发现脚本调用合约的时候，早期就直接被revert，经过排查发现可借贷usdt数量不够我完成这么巨额的清算。

```tsx
// 查看借贷合约中有该种代币有多少
const balance = await tokenContract.balanceOf(BALANCER_VAULT);
const balanceFormatted = parseFloat(ethers.formatUnits(balance, token.decimals));
const valueUSD = balanceFormatted * token.priceUSD;
```

在查阅完，我们可以发现借贷合约中的ETH是价值最多的，那么用其去进行清算最为合适。

```solidity
PS E:\library\web3\Before the storm\uwu-llama-liquidation> npm run deploy

> uwu-llama-liquidation@1.0.0 deploy
> hardhat run scripts/deploy.ts --network tenderly

Deployer: 0x0cf6b1bBa533AfCBb6014e40385a5B26dbB0dA5c
UltiLiquidator deployed at: 0x326A937B0ACd264e6F35b5d0d2C6557b93115378
✅ 地址已保存到 deployments.json
📁 文件路径: E:\library\web3\Before the storm\uwu-llama-liquidation\deployments.json
```

这是我部署完合约后，写的脚本

```solidity
const [s] = await ethers.getSigners();
const liquidator = await ethers.getContractAt(
  "UltiLiquidator",
  "0xC0D97B8d708b419d62D5476A725B41e33D77877c",
  s
);

const controllerAddress = "0xEdA215b7666936DEd834f76f3fBC6F323295110A";
const borrowerAddress   = "0x6F8C5692b00c2eBbd07e4FD80E332DfF3ab8E83c";
const beneficiary       = "0x0cf6b1bBa533AfCBb6014e40385a5B26dbB0dA5c";

// 1) 读债务
const ctl = await ethers.getContractAt(
  ["function debt(address) view returns (uint256)",
   "function user_state(address) view returns (uint256 collateral, uint256 debt)"],
  controllerAddress, s
);
let debt;
try { debt = await ctl.debt(borrowerAddress); } catch { [,debt] = await ctl.user_state(borrowerAddress); }

// 2) Quoter 估算 USDC -> 精确买出 debt crvUSD 所需的 USDC（500 失败则用 3000）
const USDC   = "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const CRVUSD = "0xF939E0A03FB07F59A73314E73794Be0E57ac1b4E";
const QUOTER = "0x61fFE014bA179E9aBfDEB4DfD0b4eAAdA6d6f2A3";

const quoter = await ethers.getContractAt(
  ["function quoteExactOutputSingle((address,address,uint256,uint24,uint160)) view returns (uint256,uint160,uint32,uint256)"],
  QUOTER, s
);

let fee = 500;
let needUSDC;
try {
  [needUSDC] = await quoter.quoteExactOutputSingle([USDC, CRVUSD, debt, fee, 0n]);
} catch {
  fee = 3000;
  [needUSDC] = await quoter.quoteExactOutputSingle([USDC, CRVUSD, debt, fee, 0n]);
  console.log("用 0.3% 费档");
}
const flashUSDC = (needUSDC * 101n) / 100n;

// 3) 发送交易（给足 gasLimit）
const tx = await liquidator.flashAndLiquidate(
  controllerAddress,
  borrowerAddress,
  beneficiary,
  debt,
  flashUSDC,
  ethers.parseUnits("20000", 18),
  { gasLimit: 25_000_000 }
);
console.log("tx:", tx.hash);
const rcpt = await tx.wait();
console.log("done. gasUsed:", rcpt.gasUsed.toString());

```

```solidity
Target:
Controller: 0xEdA215b7666936DEd834f76f3fBC6F323295110A
Exploiter: 0x6F8C5692b00c2eBbd07e4FD80E332DfF3ab8E83c
Debt: 4349978.843031908306047379 crvUSD
Collateral: 12072666.352370194900945047 CRV

Liquidation:
Debt Amount: 4349978.843031908306047379 crvUSD
Flash Loan Amount: 2084.3648622861224 WETH
Debt Value: ~$4349979

🔧 验证基础设施...
Controller: ✅
Balancer Vault: ✅
Uniswap V2 Router: ✅
CRV Token: ✅
crvUSD Token: ✅
WETH Token: ✅
USDT Token: ✅
Curve crvUSD/USDT Pool: ✅

🔍 验证当前用户状态...
当前抵押品: 12072666.352370194900945047 CRV
当前债务: 4349978.843031908306047379 crvUSD
```

（2）在比赛时，反复尝试清算都失败了，经过赛后查看https://github.com/Frodan/wintermute-alpha-2025-writeups/blob/main/Before%20The%20Storm/Writeup.md 的解答，发现正确的方式是分批清算。

**这个是UwU lend只允许清算一小部分。这一点没能意识到和解决的主要原因在于我没能很好的查阅借贷协议提供的文档（** https://github.com/UwU-Lend/uwu-contracts/blob/main/aave-protocol-v2/protocol/lendingpool/LendingPoolCollateralManager.sol **）。**

```solidity
 uint256 internal constant LIQUIDATION_CLOSE_FACTOR_PERCENT = 5000;

 vars.maxLiquidatableDebt = vars.userStableDebt.add(vars.userVariableDebt).percentMul(
      LIQUIDATION_CLOSE_FACTOR_PERCENT
    );
```

后续就是部署具体的清算合约，然后多次清算，每次清算一小部分。

【以下是正确代码，截取部分】既可以合约多次清算，也可以用脚本多次调用，异曲同工。

```solidity
// Execute liquidation
            try liquidator.liquidate(LIQUIDATION_FRACTION) {
                uint256 balanceAfter = IERC20(CRV).balanceOf(deployer);
                uint256 profit = balanceAfter - balanceBefore;
                successfulLiquidations++;
                
                console2.log("Liquidation SUCCESS!");
                console2.log("Profit this round:", profit / 1e18, "CRV");
                console2.log("Current total CRV:", balanceAfter / 1e18);
                
                // Check if we have enough CRV
                if (balanceAfter >= TARGET_CRV_AMOUNT) {
                    console2.log("");
                    console2.log("SUCCESS! Reached target of", TARGET_CRV_AMOUNT / 1e18, "CRV");
                    console2.log("Total liquidations performed:", successfulLiquidations);
                    break;
                }
                console2.log("Still need:", (TARGET_CRV_AMOUNT - balanceAfter) / 1e18, "more CRV");
                console2.log("");
                
            } catch Error(string memory reason) {
                console2.log("Liquidation FAILED:", reason);
                break;
            } catch {
                console2.log("Liquidation FAILED: Unknown error");
                break;
            }
```

### 总体思路

目标是清算 UwU exploiter 在 **Curve LlamaLend 的 CRV-long 市场**的坏账，用**闪电贷**拿到 crvUSD 偿还债务，拿回折价的 CRV 作为清算奖励，并在还清闪电贷后，保证你的**已注册钱包**里至少留有 20,000 枚 CRV。

UwU Lend 上的不健康仓位是 CRV/crvUSD 仓位。在典型的清算中，清算人支付 crvUSD 并获得 CRV 及溢价作为奖励。有趣的是，UwU Lend 支持闪电清算，允许您先收到 CRV，然后在交易结束前返还所需的 crvUSD 金额。此外，虽然仓位规模很大，但 UwU Lend 每次只允许清算一小部分。