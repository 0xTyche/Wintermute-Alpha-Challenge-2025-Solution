// Run: npx hardhat run scripts/weth-liquidate.js --network tenderly
//
// .env 需要：
//   BENEFICIARY_ADDRESS=0xYourWallet
//   LIQUIDATOR_V2_ADDRESS=0xDeployedV2
// 可选：
//   ETH_PRICE_USD=3000
//   TARGET_RATIO_BPS=6000         // 60%
//   DRY_RUN=1                     // 只做 staticCall 预验

const hre = require("hardhat");
const { ethers } = hre;
require("dotenv").config();

async function main() {
  console.log("=== 安全版 WETH 闪贷清算（V2） ===");

  // 0) RPC 断言（确保用你的 Tenderly 端点）
  console.log("Active network:", hre.network.name);
  const cfg = hre.config.networks[hre.network.name];
  console.log("RPC URL from config:", cfg?.url);
  const MUST_URL = "virtual.mainnet.eu.rpc.tenderly.co/7f4d204b-2e6c-47e4-9963-f57ad5bdda11";
  if (!cfg?.url || !cfg.url.includes(MUST_URL)) {
    throw new Error(`❌ Not using expected Tenderly RPC (${MUST_URL})`);
  }
  try {
    const clientVersion = await ethers.provider.send("web3_clientVersion", []);
    console.log("web3_clientVersion:", clientVersion);
  } catch {}
  const net = await ethers.provider.getNetwork();
  console.log("chainId:", Number(net.chainId));
  console.log("latest block:", await ethers.provider.getBlockNumber());

  // 1) 常量 & 环境
  const CONTROLLER = "0xEdA215b7666936DEd834f76f3fBC6F323295110A";
  const BORROWER   = "0x6F8C5692b00c2eBbd07e4FD80E332DfF3ab8E83c";
  const BENEFICIARY= mustEnv("BENEFICIARY_ADDRESS");
  const LIQUIDATOR = mustEnv("LIQUIDATOR_V2_ADDRESS");

  const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
  const WETH  = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const CRV   = "0xD533a949740bb3306d119CC777fa900bA034cd52";
  const CRVUSD= "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E";

  const ETH_PRICE = Number(process.env.ETH_PRICE_USD || "3000");
  const TARGET_RATIO_BPS = Number(process.env.TARGET_RATIO_BPS || "6000"); // 60%
  const MIN_CRV_LEFT = ethers.parseUnits("20000", 18);

  const [signer] = await ethers.getSigners();
  console.log("Signer      :", signer.address);
  console.log("LiquidatorV2:", LIQUIDATOR);
  console.log("Controller  :", CONTROLLER);
  console.log("Borrower    :", BORROWER);
  console.log("Beneficiary :", BENEFICIARY);

  // 2) 读取仓位
  const controller = new ethers.Contract(
    CONTROLLER,
    [
      "function user_state(address) view returns (uint256 collateral, uint256 debt)",
      "function collateral(address) view returns (uint256)",
      "function debt(address) view returns (uint256)",
      "function collateral_token() view returns (address)",
      "function borrowed_token() view returns (address)",
      "function stablecoin() view returns (address)"
    ],
    ethers.provider
  );

  const { debt18, col18 } = await getDebtAndCollateral(controller, BORROWER);
  console.log("📌 债务(crvUSD,18):", ethers.formatUnits(debt18, 18));
  console.log("📌 抵押(CRV,18)   :", ethers.formatUnits(col18, 18));

  const colToken = await controller.collateral_token();
  const borToken = await getBorrowedTokenCompat(controller);
  if (colToken.toLowerCase() !== CRV.toLowerCase() || borToken.toLowerCase() !== CRVUSD.toLowerCase()) {
    throw new Error(`❌ Controller tokens mismatch. collateral=${colToken} borrowed=${borToken}`);
  }

  // 3) Balancer WETH 余额
  const weth = new ethers.Contract(WETH, ["function balanceOf(address) view returns (uint256)"], ethers.provider);
  const vaultWeth = await weth.balanceOf(BALANCER_VAULT);
  const vaultWethF = Number(ethers.formatUnits(vaultWeth, 18));
  console.log("🏦 Vault WETH(18):", vaultWethF);

  // 目标闪贷 = min( 目标覆盖比例, 金库余额95% )
  const debtUSD = Number(ethers.formatUnits(debt18, 18));
  const targetUSD = (debtUSD * TARGET_RATIO_BPS) / 10000;
  const needWeth = targetUSD / ETH_PRICE;
  const safeCapWeth = vaultWethF * 0.95;
  let initialWeth = Math.min(needWeth, safeCapWeth);
  if (!isFinite(initialWeth) || initialWeth <= 0) {
    throw new Error("❌ Invalid initial WETH amount computed");
  }

  // 4) 内联 ABI 连接 V2 合约
  const LIQUIDATOR_ABI = [
    "function flashAndLiquidateV2(address controller,address borrower,address beneficiary,uint256 debtHint,uint256 flashAmount,uint256 minCrvLeft,address flashToken) external",
    "function flashAndLiquidate(address controller,address borrower,address beneficiary,uint256 debtHint,uint256 flashUSDTAmount,uint256 minCrvLeft) external",
    "event Debug(string tag,uint256 val)",
    "event Liquidated(address controller,address borrower,uint256 crvKept)"
  ];
  const bytecode = await ethers.provider.getCode(LIQUIDATOR);
  if (bytecode === "0x") throw new Error("❌ LIQUIDATOR_V2_ADDRESS has no code");
  const liquidator = new ethers.Contract(LIQUIDATOR, LIQUIDATOR_ABI, signer);

  const FULL_SIG = "flashAndLiquidateV2(address,address,address,uint256,uint256,uint256,address)";
  let preparedMethod;
  try {
    preparedMethod = liquidator.getFunction(FULL_SIG);
  } catch {
    throw new Error(`❌ 当前 ABI 中不存在 ${FULL_SIG}，请检查 LIQUIDATOR_ABI 是否正确`);
  }
  // ✅ ethers v6：用 ethers.id 计算 selector（可选，仅打印）
  const selector = ethers.id(FULL_SIG).slice(0, 10);
  console.log("flashAndLiquidateV2 selector:", selector);

  // 5) staticCall 预验 + 降档
  console.log(
    "🔧 计划闪贷 WETH:",
    fmt(initialWeth),
    "目标清算比例:",
    (TARGET_RATIO_BPS / 100).toFixed(2) + "%"
  );
  let tryAmt = ethers.parseUnits(initialWeth.toFixed(18), 18);
  let ok = false;

  for (let i = 0; i < 8; i++) {
    console.log(`🧪 staticCall: WETH=${ethers.formatUnits(tryAmt, 18)}`);
    try {
      await preparedMethod.staticCall(
        CONTROLLER,
        BORROWER,
        BENEFICIARY,
        0n,          // debtHint=0，链上读取
        tryAmt,      // WETH 闪贷数量（18）
        MIN_CRV_LEFT,
        WETH,
        { gasLimit: 6_000_000 }
      );
      console.log("✅ 预验通过");
      ok = true;
      break;
    } catch (e) {
      console.log("❌ 预验回滚:", shorten(e?.message || String(e)));
      tryAmt = (tryAmt * 9000n) / 10000n; // 降 10%
      if (tryAmt < ethers.parseUnits("5", 18)) {
        console.log("🛑 金额降至 5 WETH 以下，停止预验");
        break;
      }
      console.log("↪️ 降档至:", ethers.formatUnits(tryAmt, 18), "WETH");
    }
  }

  if (!ok) {
    console.log("🛑 预验始终失败，建议：");
    console.log(" - 降低 TARGET_RATIO_BPS（如 3000）");
    console.log(" - 检查 Curve/Uni 路由在当前 fork 是否可用");
    console.log(" - 重置 fork 高度或降低 MIN_CRV_LEFT");
    return;
  }

  if (process.env.DRY_RUN) {
    console.log("🟡 DRY_RUN=1：仅预验，不发送真实交易");
    return;
  }

  // 6) 发送真实交易
  console.log("🚀 发送真实交易...");
  const tx = await preparedMethod(
    CONTROLLER, BORROWER, BENEFICIARY, 0n, tryAmt, MIN_CRV_LEFT, WETH, { gasLimit: 6_000_000 }
  );
  console.log("tx:", tx.hash);
  const r = await tx.wait();
  console.log("📦 status:", r.status, "gasUsed:", r.gasUsed?.toString());
  if (r.status !== 1) {
    console.log("❌ 交易失败");
    return;
  }

  // 7) 解析事件（只看清算合约自己的日志）
  console.log("🔎 解析事件日志");
  for (const log of r.logs || []) {
    if ((log.address || "").toLowerCase() !== LIQUIDATOR.toLowerCase()) continue;
    try {
      const parsed = liquidator.interface.parseLog(log);
      if (parsed?.name === "Debug") {
        console.log(`  [Debug] ${parsed.args.tag}: ${parsed.args.val}`);
      } else if (parsed?.name === "Liquidated") {
        console.log(`  [Liquidated] crvKept: ${ethers.formatUnits(parsed.args.crvKept, 18)} CRV`);
      }
    } catch {}
  }

  console.log("✅ 完成");
}

main().catch((e) => {
  console.error("❌ 执行失败:", e);
  process.exit(1);
});

// ---------- Helpers ----------
function mustEnv(k) {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env ${k}`);
  return v;
}
function fmt(n) {
  try { return Number(n).toLocaleString(undefined, { maximumFractionDigits: 6 }); }
  catch { return String(n); }
}
function shorten(s, n = 200) {
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
