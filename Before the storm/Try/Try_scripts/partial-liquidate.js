// scripts/partial-liquidate.js
require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;

const ADDR = {
  CONTROLLER: process.env.CONTROLLER || "0xEdA215b7666936DEd834f76f3fBC6F323295110A",
  BORROWER:   process.env.BORROWER   || "0x6F8C5692b00c2eBbd07e4FD80E332DfF3ab8E83c",
  BENEFICIARY:process.env.BENEFICIARY_ADDRESS, // 必填：你的收款地址
  LIQUIDATOR: process.env.LIQUIDATOR || "0x962DfbCD46945fDa27d07299070454fd423480d8",

  BALANCER_VAULT: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
  USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  CRV:  "0xD533a949740bb3306d119CC777fa900bA034cd52",
};

const ABI = {
  ERC20: [
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)"
  ],
  CTRL: [
    "function user_state(address) view returns (uint256 collateral, uint256 debt)",
    "function collateral_token() view returns (address)",
    "function borrowed_token() view returns (address)",
    "function stablecoin() view returns (address)"
  ],
};

const pow10 = (n) => 10n ** BigInt(n);

// 计算参数
const VAULT_MARGIN_BPS = 9800n;   // 98.00%：不把 Vault 余额借到极限
const NEED_MARGIN_BPS  = 10200n;  // +2%：覆盖兑换滑点/费用
const MIN_CRV_LEFT     = 20_000n * pow10(18); // 至少 20k CRV
const MIN_FLASH_USDT6  = 200_000n * pow10(6); // 下限 200k USDT，避免太小（可调）

// ============ 工具：revert 数据解码 ============
function startsWith(data, sig) {
  return data && data.toLowerCase().startsWith(sig.toLowerCase());
}
function strip0x(x) {
  return x.startsWith("0x") ? x.slice(2) : x;
}
function hexToBytes(hex) {
  hex = strip0x(hex);
  if (hex.length % 2) hex = "0" + hex;
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function tryDecodeInnerRevert(innerHex) {
  // 标准 Error(string): 0x08c379a0
  if (startsWith(innerHex, "0x08c379a0")) {
    try {
      const [, reason] = ethers.AbiCoder.defaultAbiCoder().decode(
        ["bytes4", "string"],
        innerHex
      ); // 直接 decode 可能报错，用低级方式更稳
    } catch {}
    try {
      const reason = ethers.AbiCoder.defaultAbiCoder().decode(
        ["string"],
        "0x" + strip0x(innerHex).slice(8 + 64) // 跳过 selector 和 offset
      );
      return { kind: "Error(string)", detail: reason[0] };
    } catch {}
  }
  // Panic(uint256): 0x4e487b71
  if (startsWith(innerHex, "0x4e487b71")) {
    try {
      const code = ethers.AbiCoder.defaultAbiCoder().decode(
        ["uint256"],
        "0x" + strip0x(innerHex).slice(8)
      );
      return { kind: "Panic(uint256)", detail: code[0].toString() };
    } catch {}
  }
  // 尝试 UTF-8 文本
  try {
    const utf = ethers.toUtf8String(innerHex);
    if (utf && utf.trim().length) {
      return { kind: "utf8", detail: utf };
    }
  } catch {}

  // 无法解析，返回原始 hex
  return { kind: "raw", detail: innerHex };
}

async function main() {
  const [signer] = await ethers.getSigners();
  if (!ADDR.BENEFICIARY) {
    throw new Error("请在 .env 设置 BENEFICIARY_ADDRESS=你的收款地址");
  }

  console.log("🎯 执行部分清算（自动按 Vault 实时余额）");
  console.log("Signer:", signer.address);
  console.log("Liquidator:", ADDR.LIQUIDATOR);
  console.log("Controller:", ADDR.CONTROLLER);
  console.log("Borrower:", ADDR.BORROWER);
  console.log("Beneficiary:", ADDR.BENEFICIARY);

  // 基本检查：合约存在
  const liqCode = await ethers.provider.getCode(ADDR.LIQUIDATOR);
  if (liqCode === "0x") {
    throw new Error("LIQUIDATOR 地址上没有代码，请先部署或改地址");
  }

  // 绑定实例（务必用 signer）
  const liquidator = await ethers.getContractAt("LlamaLendLiquidator", ADDR.LIQUIDATOR, signer);
  const ctrl = new ethers.Contract(ADDR.CONTROLLER, ABI.CTRL, ethers.provider);
  const usdt = new ethers.Contract(ADDR.USDT, ABI.ERC20, ethers.provider);

  // 1) 债务（18位）
  const { debt } = await ctrl.user_state(ADDR.BORROWER);
  const debt18 = BigInt(debt);
  console.log("📌 借款人实时债务(crvUSD, 18):", debt18.toString());
  if (debt18 === 0n) {
    console.log("❌ 债务为 0，无法清算。重置 fork 后重试。");
    return;
  }

  // 2) Vault USDT（6位）
  const vaultUsdt6 = BigInt(await usdt.balanceOf(ADDR.BALANCER_VAULT));
  console.log("🏦 Vault USDT(6):", vaultUsdt6.toString());

  // 3) 计算 flashUSDT6
  // debt(18) → 近似 USDT(6)：/1e12
  const debtUSDT6 = (debt18 + 999_999_999_999n) / 1_000_000_000_000n; // ceil
  let needUSDT6 = (debtUSDT6 * NEED_MARGIN_BPS) / 10_000n;     // +2%
  let capByVault = (vaultUsdt6 * VAULT_MARGIN_BPS) / 10_000n;  // 98%
  let flashUSDT6 = needUSDT6 < capByVault ? needUSDT6 : capByVault;
  if (flashUSDT6 < MIN_FLASH_USDT6) flashUSDT6 = MIN_FLASH_USDT6;

  console.log("🔧 计划闪贷 USDT(6):", flashUSDT6.toString(),
              "≈", Number(ethers.formatUnits(flashUSDT6, 6)).toLocaleString(), "USDT");

  // 4) 打印 calldata 头，确保不是空交易
  const iface = (await ethers.getContractFactory("LlamaLendLiquidator")).interface;
  const calldata = iface.encodeFunctionData("flashAndLiquidate", [
    ADDR.CONTROLLER,
    ADDR.BORROWER,
    ADDR.BENEFICIARY,
    0n,             // 合约内部会用链上真实 debt
    flashUSDT6,     // USDT(6)
    MIN_CRV_LEFT    // CRV(18)
  ]);
  console.log("calldata starts with:", calldata.slice(0, 10));

  // 5) 先做 callStatic：如果 Vault 在 flashLoan 处拒绝，会被包装成 FlashLoanFailed(bytes)
  console.log("🧪 callStatic 预验（不会上链）...");
  let canSendRealTx = false;
  try {
    await liquidator.callStatic.flashAndLiquidate(
      ADDR.CONTROLLER,
      ADDR.BORROWER,
      ADDR.BENEFICIARY,
      0n,
      flashUSDT6,
      MIN_CRV_LEFT
    );
    console.log("✅ callStatic 通过（理论上可以发送真实交易）");
    canSendRealTx = true;
  } catch (e) {
    console.log("❌ callStatic revert，尝试解码原因…");
    const errData = e?.data || e?.error?.data || e?.value; // 兼容不同节点/版本
    try {
      // 先尝试解码为合约自定义错误（FlashLoanFailed(bytes)）
      const parsed = iface.parseError(errData);
      console.log("  ↪️ CustomError:", parsed?.name || "(unknown)");
      if (parsed?.name === "FlashLoanFailed") {
        const inner = parsed.args[0]; // bytes
        const innerHex = typeof inner === "string" ? inner : ethers.hexlify(inner);
        console.log("  ↪️ Vault revert hex:", innerHex);

        const decoded = tryDecodeInnerRevert(innerHex);
        console.log("  ↪️ Decoded kind:", decoded.kind);
        console.log("  ↪️ Detail:", decoded.detail);

        console.log("\n📌 结论：Balancer Vault 在 flashLoan 处拒绝了 USDT 闪电贷。");
        console.log("👉 可选动作：");
        console.log("  1) 把合约改成支持借 CRVUSD 或 WETH（推荐 CRVUSD，可少一腿兑换）");
        console.log("  2) 若坚持 USDT，尝试将 flashUSDT6 再降低 1–3%，或重置 fork 重试");
      } else {
        // 不是我们自定义错误，打印原始数据
        console.log("  ↪️ 非自定义错误（原始数据）:", errData);
      }
    } catch {
      console.log("  ↪️ 无法 parseError，原始数据:", errData);
    }
  }

  if (!canSendRealTx) {
    console.log("\n🛑 已停止发送真实交易（因为 callStatic 已经失败）。");
    return;
  }

  // 6) 发送真实交易
  console.log("🚀 发送真实清算交易…");
  const tx = await liquidator.flashAndLiquidate(
    ADDR.CONTROLLER,
    ADDR.BORROWER,
    ADDR.BENEFICIARY,
    0n,
    flashUSDT6,
    MIN_CRV_LEFT,
    { gasLimit: 15_000_000 }
  );
  console.log("tx:", tx.hash);
  const rc = await tx.wait();
  console.log("⛓️ 成功打包，区块：", rc.blockNumber);

  // 7) 解析事件（可看到 DebugStep/Liquidated）
  try {
    for (const log of rc.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed.name === "DebugStep") {
          console.log("↪️", parsed.args.step, parsed.args.value.toString());
        } else if (parsed.name === "Liquidated") {
          const crvKept = parsed.args.crvKept;
          console.log("🎉 Liquidated, CRV kept:", ethers.formatUnits(crvKept, 18));
        }
      } catch {}
    }
  } catch {}

  // 8) 校验收益是否 ≥ 20k CRV
  const crv = new ethers.Contract(ADDR.CRV, ["function balanceOf(address) view returns (uint256)"], ethers.provider);
  const crvBal = await crv.balanceOf(ADDR.BENEFICIARY);
  console.log("👛 Beneficiary CRV:", ethers.formatUnits(crvBal, 18));
  if (crvBal < MIN_CRV_LEFT) {
    console.log("⚠️ 小于 20k CRV。可尝试：提高闪贷额度（贴近 Vault 余额，但保留 1–2%），或分多次执行。");
  } else {
    console.log("✅ 达成题目要求：≥ 20k CRV");
  }
}

main().catch((e) => {
  console.error("❌ 执行失败：", e);
  process.exit(1);
});
