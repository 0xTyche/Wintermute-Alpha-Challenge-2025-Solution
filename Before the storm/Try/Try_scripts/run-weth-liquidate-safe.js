// npx hardhat run scripts/run-weth-liquidate-safe.js --network tenderly
//
// .env 需要：
//   BENEFICIARY_ADDRESS=0xYourWallet
//   LIQUIDATOR_V2_ADDRESS=0xDeployedV2
// 可选：
//   ETH_PRICE_USD=3000
//   FLASH_WETH=10                 // 覆盖默认闪贷数量（单位 WETH）
//   MIN_CRV_LEFT=20000            // 覆盖默认最小保留 CRV（单位 CRV）
//   SKIP_STATIC=1                 // 默认跳过 staticCall 预验
//   TARGET_RATIO_BPS=6000         // 若未指定 FLASH_WETH，用债务比例推算（默认60%）
//   USE_FLASH_SWAP=1              // 默认使用 UniV2 Flash Swap（推荐）
//   USE_FLASH_SWAP=0              // 使用 Balancer Flash Loan（可能不可用）

const hre = require("hardhat");
const { ethers } = hre;
require("dotenv").config();

const ADDR = {
  CONTROLLER: "0xEdA215b7666936DEd834f76f3fBC6F323295110A",
  BORROWER:   "0x6F8C5692b00c2eBbd07e4FD80E332DfF3ab8E83c",
  VAULT:      "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
  WETH:       "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  USDT:       "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  CRVUSD:     "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E",
  CRV:        "0xD533a949740bb3306d119CC777fa900bA034cd52",
  UNI_V2:     "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
  CURVE_CRVUSD_USDT: "0x390f3595bCa2Df7d23783dFd126427CCeb997BF4",
  WETH_USDT_PAIR: "0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852",
};

const LIQUIDATOR_ABI = [
  "function flashSwapAndLiquidate(address controller,address borrower,address beneficiary,uint256 debtHint,uint256 wethAmount,uint256 minCrvLeft) external",
  "function flashAndLiquidateV2(address controller,address borrower,address beneficiary,uint256 debtHint,uint256 flashAmount,uint256 minCrvLeft,address flashToken) external",
  "event Debug(string tag,uint256 val)",
  "event Liquidated(address controller,address borrower,uint256 crvKept)",
  "error FlashLoanFailed(bytes lowLevelData)"
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

const CTRL_ABI = [
  "function user_state(address) view returns (uint256 collateral, uint256 debt)",
  "function collateral(address) view returns (uint256)",
  "function debt(address) view returns (uint256)",
  "function collateral_token() view returns (address)",
  "function borrowed_token() view returns (address)",
  "function stablecoin() view returns (address)"
];

const UNI_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"
];

const CURVE_ABI = [
  "function coins(uint256) view returns (address)",
  "function get_dy(uint256 i, uint256 j, uint256 dx) view returns (uint256)"
];

const PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)", 
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)"
];

async function main() {
  console.log("=== 安全版 WETH 清算（V3: UniV2 + Balancer 双支持） ==="); // ← 运行即应看到这一行

  console.log("Active network:", hre.network.name);
  const cfg = hre.config.networks[hre.network.name];
  console.log("RPC URL from config:", cfg?.url);
  try {
    const v = await ethers.provider.send("web3_clientVersion", []);
    console.log("web3_clientVersion:", v);
  } catch {}
  const net = await ethers.provider.getNetwork();
  console.log("chainId:", Number(net.chainId));
  console.log("latest block:", await ethers.provider.getBlockNumber());

  const BENEFICIARY = mustEnv("BENEFICIARY_ADDRESS");
  const LIQUIDATOR  = mustEnv("LIQUIDATOR_V2_ADDRESS");
  const ETH_PRICE   = Number(process.env.ETH_PRICE_USD || "3000");
  const TARGET_RATIO_BPS = Number(process.env.TARGET_RATIO_BPS || "1000"); // 默认 10%（小额测试）
  const MIN_CRV_LEFT = ethers.parseUnits(process.env.MIN_CRV_LEFT || "0", 18); // 默认 0（兜底测试）
  const SKIP_STATIC = process.env.SKIP_STATIC ? process.env.SKIP_STATIC !== "0" : true;
  const USE_FLASH_SWAP = process.env.USE_FLASH_SWAP ? process.env.USE_FLASH_SWAP !== "0" : true; // 默认使用 UniV2

  const [signer] = await ethers.getSigners();
  console.log("Signer      :", signer.address);
  console.log("LiquidatorV2:", LIQUIDATOR);
  console.log("Controller  :", ADDR.CONTROLLER);
  console.log("Borrower    :", ADDR.BORROWER);
  console.log("Beneficiary :", BENEFICIARY);

  // 1) 读取仓位与 token 校验
  const controller = new ethers.Contract(ADDR.CONTROLLER, CTRL_ABI, ethers.provider);
  const { debt18, col18 } = await getDebtAndCollateral(controller, ADDR.BORROWER);
  console.log("📌 债务(crvUSD,18):", ethers.formatUnits(debt18, 18));
  console.log("📌 抵押(CRV,18)   :", ethers.formatUnits(col18, 18));

  const borToken = await getBorrowedTokenCompat(controller);
  const colToken = await controller.collateral_token();
  if (colToken.toLowerCase() !== ADDR.CRV.toLowerCase() || borToken.toLowerCase() !== ADDR.CRVUSD.toLowerCase()) {
    throw new Error(`❌ Controller tokens mismatch. collateral=${colToken} borrowed=${borToken}`);
  }

  // 2) Balancer WETH 可借
  const weth = new ethers.Contract(ADDR.WETH, ERC20_ABI, ethers.provider);
  const vaultWeth = await weth.balanceOf(ADDR.VAULT);
  console.log("🏦 Vault WETH(18):", Number(ethers.formatUnits(vaultWeth, 18)));

  // 3) 路由可用性快速检查（不写状态）
  await preflightRouters(ADDR.WETH, ADDR.USDT, ADDR.CRVUSD);
  
  // 4) 如果使用 UniV2 Flash Swap，检查 pair 流动性
  let pairWethReserve = 0n;
  if (USE_FLASH_SWAP) {
    const pair = new ethers.Contract(ADDR.WETH_USDT_PAIR, PAIR_ABI, ethers.provider);
    const token0 = await pair.token0();
    const [reserve0, reserve1] = await pair.getReserves();
    const wethIsToken0 = token0.toLowerCase() === ADDR.WETH.toLowerCase();
    pairWethReserve = wethIsToken0 ? reserve0 : reserve1;
    
    const pairWethF = Number(ethers.formatUnits(pairWethReserve, 18));
    console.log("🏦 UniV2 Pair WETH储备:", pairWethF.toLocaleString(), "WETH");
    
    if (pairWethF < 100) {
      console.log("⚠️ UniV2 WETH储备较少，可能影响闪借金额");
    }
  }

  // 5) 计算或采用手动 FLASH_WETH
  let flashWeth;
  if (process.env.FLASH_WETH) {
    flashWeth = ethers.parseUnits(process.env.FLASH_WETH, 18);
  } else {
    const debtUSD = Number(ethers.formatUnits(debt18, 18));
    const targetUSD = (debtUSD * TARGET_RATIO_BPS) / 10000;
    const needWeth = targetUSD / ETH_PRICE;
    
    // 根据使用的方法选择储备上限
    let safeCapWeth;
    if (USE_FLASH_SWAP) {
      // UniV2: 不超过储备的 30%（防止价格影响过大）
      safeCapWeth = Number(ethers.formatUnits(pairWethReserve, 18)) * 0.30;
      console.log("📊 使用 UniV2 Flash Swap 模式");
    } else {
      // Balancer: 95% vault 余额
      safeCapWeth = Number(ethers.formatUnits(vaultWeth, 18)) * 0.95;
      console.log("📊 使用 Balancer Flash Loan 模式");
    }
    
    const initialWeth = Math.max(1, Math.min(needWeth, safeCapWeth)); // 至少 1 WETH
    flashWeth = ethers.parseUnits(initialWeth.toFixed(18), 18);
  }

  console.log("🔧 计划闪贷 WETH:", ethers.formatUnits(flashWeth, 18),
              "（SKIP_STATIC=", SKIP_STATIC, ", USE_FLASH_SWAP=", USE_FLASH_SWAP, "）");

  // 6) 连接清算合约
  const bytecode = await ethers.provider.getCode(LIQUIDATOR);
  if (bytecode === "0x") throw new Error("❌ LIQUIDATOR_V2_ADDRESS has no code");
  const liquidator = new ethers.Contract(LIQUIDATOR, LIQUIDATOR_ABI, signer);

  // 检查目标方法是否存在
  const targetMethod = USE_FLASH_SWAP ? "flashSwapAndLiquidate" : "flashAndLiquidateV2";
  try {
    liquidator.getFunction(targetMethod);
    console.log("✅ 目标方法可用:", targetMethod);
  } catch {
    throw new Error(`❌ 合约中不存在 ${targetMethod} 方法，请重新部署V2合约`);
  }

  // 7) （可选）staticCall 仅用于 ABI/选择器验证；默认跳过
  if (!SKIP_STATIC) {
    try {
      if (USE_FLASH_SWAP) {
        await liquidator.flashSwapAndLiquidate.staticCall(
          ADDR.CONTROLLER, ADDR.BORROWER, BENEFICIARY,
          0n, flashWeth, MIN_CRV_LEFT, { gasLimit: 6_000_000 }
        );
      } else {
        await liquidator.flashAndLiquidateV2.staticCall(
          ADDR.CONTROLLER, ADDR.BORROWER, BENEFICIARY,
          0n, flashWeth, MIN_CRV_LEFT, ADDR.WETH, { gasLimit: 6_000_000 }
        );
      }
      console.log("✅ staticCall 预验通过");
    } catch (e) {
      console.log("🟡 staticCall 回滚（忽略）：", shorten(e?.message || String(e)));
    }
  }

  // 8) 发送真实交易
  console.log("🚀 发送真实交易...");
  let tx;
  try {
    if (USE_FLASH_SWAP) {
      // 使用 UniV2 Flash Swap
      tx = await liquidator.flashSwapAndLiquidate(
        ADDR.CONTROLLER, ADDR.BORROWER, BENEFICIARY,
        0n, flashWeth, MIN_CRV_LEFT,
        { gasLimit: 4_000_000 } // UniV2 路径相对简单
      );
    } else {
      // 使用 Balancer Flash Loan
      tx = await liquidator.flashAndLiquidateV2(
        ADDR.CONTROLLER, ADDR.BORROWER, BENEFICIARY,
        0n, flashWeth, MIN_CRV_LEFT, ADDR.WETH,
        { gasLimit: 6_000_000 }
      );
    }
  } catch (e) {
    decodeAndPrintError(liquidator.interface, e, "发送阶段");
    throw e;
  }
  console.log("tx:", tx.hash);
  let r;
  try {
    r = await tx.wait();
  } catch (e) {
    decodeAndPrintError(liquidator.interface, e, "等待确认阶段");
    throw e;
  }

  console.log("📦 status:", r.status, "gasUsed:", r.gasUsed?.toString());
  if (r.status !== 1) {
    console.log("❌ 交易失败（无状态变更）");
    return;
  }

  // 9) 解析事件（仅本合约）
  console.log("🔎 解析事件日志");
  for (const log of r.logs || []) {
    if ((log.address || "").toLowerCase() !== LIQUIDATOR.toLowerCase()) continue;
    try {
      const parsed = liquidator.interface.parseLog(log);
      if (parsed?.name === "Debug") {
        console.log(`  [Debug] ${parsed.args.tag}: ${parsed.args.val}`);
      } else if (parsed?.name === "Liquidated") {
        const crvKept = ethers.formatUnits(parsed.args.crvKept, 18);
        console.log(`  [Liquidated] crvKept: ${crvKept} CRV`);
        console.log(`  💰 按$0.25计算价值: $${(parseFloat(crvKept) * 0.25).toLocaleString()}`);
      }
    } catch {}
  }

  // 成功总结
  console.log("\n🎉 清算执行完成!");
  if (USE_FLASH_SWAP) {
    console.log("✅ 使用方法: UniV2 Flash Swap（推荐）");
    console.log("✅ 绕过了 Balancer 问题");
    console.log("✅ 使用 WETH/USDT Pair 流动性");
  } else {
    console.log("✅ 使用方法: Balancer Flash Loan");
    console.log("💡 如果遇到问题，建议设置 USE_FLASH_SWAP=1 使用 UniV2 方式");
  }
  console.log("💰 请检查受益人钱包中的 CRV 余额!");
}

// ---------- helpers ----------
function mustEnv(k) {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env ${k}`);
  return v;
}
function shorten(s, n = 180) {
  if (!s) return s;
  return s.length > n ? s.slice(0, n) + "..." : s;
}
async function getBorrowedTokenCompat(controller) {
  try { return await controller.borrowed_token(); } catch {}
  try { return await controller.stablecoin(); } catch {}
  throw new Error("Controller lacks borrowed_token & stablecoin");
}
async function getDebtAndCollateral(controller, user) {
  try {
    const [c, d] = await controller.user_state(user);
    return { col18: c, debt18: d };
  } catch {}
  const c = await controller.collateral(user);
  const d = await controller.debt(user);
  return { col18: c, debt18: d };
}
async function preflightRouters(WETH, USDT, CRVUSD) {
  const uni = new ethers.Contract(ADDR.UNI_V2, UNI_ABI, ethers.provider);

  // 1) Uni: WETH -> USDT
  try {
    const amtIn = ethers.parseUnits("1", 18);
    const out = await uni.getAmountsOut(amtIn, [WETH, USDT]);
    if (!out || !out[1] || out[1] === 0n) throw new Error("Uni V2 getAmountsOut zero");
    console.log("🧭 UniV2 OK: 1 WETH ≈", Number(ethers.formatUnits(out[1], 6)), "USDT");
  } catch (e) {
    throw new Error("❌ UniV2 路由不可用: " + (e?.message || e));
  }

  // 2) Curve: USDT -> crvUSD
  // 先读 coins 确认 index
  const curveCoins = new ethers.Contract(ADDR.CURVE_CRVUSD_USDT, [
    "function coins(uint256) view returns (address)"
  ], ethers.provider);

  let iUSDT, jCRVUSD;
  try {
    const c0 = await curveCoins.coins(0);
    const c1 = await curveCoins.coins(1);
    if (c0.toLowerCase() === USDT.toLowerCase() && c1.toLowerCase() === CRVUSD.toLowerCase()) {
      iUSDT = 0; jCRVUSD = 1;
    } else if (c0.toLowerCase() === CRVUSD.toLowerCase() && c1.toLowerCase() === USDT.toLowerCase()) {
      iUSDT = 1; jCRVUSD = 0;
    } else {
      console.log("⚠️ Curve coins 不匹配，继续尝试 get_dy 探测");
      iUSDT = 0; jCRVUSD = 1; // 先假定 0/1
    }
  } catch (e) {
    console.log("⚠️ 读取 Curve coins 失败（忽略）：", e?.message || e);
    iUSDT = 0; jCRVUSD = 1;
  }

  const dx = ethers.parseUnits("1000", 6);

  // 2.1 先用 uint256 版本 ABI
  const curveUint = new ethers.Contract(ADDR.CURVE_CRVUSD_USDT, [
    "function get_dy(uint256 i, uint256 j, uint256 dx) view returns (uint256)"
  ], ethers.provider);

  try {
    const dy = await curveUint.get_dy(iUSDT, jCRVUSD, dx);
    if (!dy || dy === 0n) throw new Error("Curve get_dy(uint) zero");
    console.log("🧭 Curve OK(uint): 1000 USDT ≈", Number(ethers.formatUnits(dy, 18)), "crvUSD");
    return;
  } catch (e1) {
    // 2.2 回退到 int128 版本 ABI
    const curveInt = new ethers.Contract(ADDR.CURVE_CRVUSD_USDT, [
      "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)"
    ], ethers.provider);
    try {
      const dy2 = await curveInt.get_dy(iUSDT, jCRVUSD, dx);
      if (!dy2 || dy2 === 0n) throw new Error("Curve get_dy(int128) zero");
      console.log("🧭 Curve OK(int128): 1000 USDT ≈", Number(ethers.formatUnits(dy2, 18)), "crvUSD");
      return;
    } catch (e2) {
      // 两种都失败：只警告，不中断
      console.log("⚠️ Curve 预检失败（uint&int128 均失败），继续执行：",
        (e2?.message || e2), "| 首个错误：", (e1?.message || e1));
      return;
    }
  }
}
function decodeAndPrintError(iface, e, phase) {
  const data =
    e?.error?.data ?? e?.data ?? e?.receipt?.revertReason ?? e?.transaction?.data ?? null;
  console.log(`❌ ${phase} revert`);
  if (!data) {
    console.log("  ↪️ 无 revert data");
    console.log("  raw:", e);
    return;
  }
  try {
    const perr = iface.parseError(data);
    console.log("  ↪️ CustomError:", perr?.name, perr?.args);
    if (perr?.name === "FlashLoanFailed") {
      const low = perr.args?.[0];
      console.log("  ↪️ FlashLoan lowLevelData:", low ? String(low) : "(empty)");
    }
  } catch {
    console.log("  ↪️ 非本合约错误数据(hex首10B):", String(data).slice(0, 22), "…");
  }
}

// ---------- 必须：调用 main ----------
if (require.main === module) {
  main().catch((e) => {
    console.error("❌ 执行失败:", e);
    process.exit(1);
  });
}
