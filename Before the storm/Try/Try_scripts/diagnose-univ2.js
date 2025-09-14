// UniV2 Flash Swap 诊断脚本
// 检查 WETH/USDT pair 的详细信息和潜在问题

const hre = require("hardhat");
const { ethers } = hre;

const ADDR = {
  WETH_USDT_PAIR: "0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852",
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  LIQUIDATOR_V2: "0xC0D97B8d708b419d62D5476A725B41e33D77877c"
};

const PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)", 
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function factory() view returns (address)"
];

const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) view returns (address pair)"
];

async function main() {
  console.log("=== UniV2 Flash Swap 诊断 ===\n");
  
  const [signer] = await ethers.getSigners();
  console.log("诊断账户:", signer.address);
  
  // 1) 验证 WETH/USDT Pair 地址
  console.log("\n📍 验证 Pair 地址...");
  const pair = new ethers.Contract(ADDR.WETH_USDT_PAIR, PAIR_ABI, ethers.provider);
  
  try {
    const token0 = await pair.token0();
    const token1 = await pair.token1();
    console.log("✅ Pair 地址有效:", ADDR.WETH_USDT_PAIR);
    console.log("   Token0:", token0);
    console.log("   Token1:", token1);
    
    // 检查 token 顺序
    const wethIsToken0 = token0.toLowerCase() === ADDR.WETH.toLowerCase();
    const usdtIsToken1 = token1.toLowerCase() === ADDR.USDT.toLowerCase();
    const wethIsToken1 = token1.toLowerCase() === ADDR.WETH.toLowerCase();
    const usdtIsToken0 = token0.toLowerCase() === ADDR.USDT.toLowerCase();
    
    console.log("\n🔍 Token 顺序验证:");
    console.log("   WETH 是 token0:", wethIsToken0);
    console.log("   USDT 是 token1:", usdtIsToken1);
    console.log("   WETH 是 token1:", wethIsToken1);
    console.log("   USDT 是 token0:", usdtIsToken0);
    
    if ((wethIsToken0 && usdtIsToken1) || (wethIsToken1 && usdtIsToken0)) {
      console.log("✅ Token 配对正确");
    } else {
      console.log("❌ Token 配对错误！这不是 WETH/USDT pair");
      console.log("   预期: WETH + USDT");
      console.log("   实际: Token0=" + token0 + ", Token1=" + token1);
    }
    
  } catch (e) {
    console.log("❌ Pair 地址无效:", e.message);
    return;
  }
  
  // 2) 检查储备
  console.log("\n💰 检查储备...");
  try {
    const [reserve0, reserve1] = await pair.getReserves();
    const token0 = await pair.token0();
    const wethIsToken0 = token0.toLowerCase() === ADDR.WETH.toLowerCase();
    
    const wethReserve = wethIsToken0 ? reserve0 : reserve1;
    const usdtReserve = wethIsToken0 ? reserve1 : reserve0;
    
    console.log("   WETH 储备:", ethers.formatUnits(wethReserve, 18), "WETH");
    console.log("   USDT 储备:", ethers.formatUnits(usdtReserve, 6), "USDT");
    
    if (wethReserve > ethers.parseUnits("100", 18)) {
      console.log("✅ WETH 储备充足");
    } else {
      console.log("⚠️ WETH 储备不足");
    }
    
  } catch (e) {
    console.log("❌ 无法读取储备:", e.message);
  }
  
  // 3) 验证合约 _getWETHPosition 逻辑
  console.log("\n🔧 验证合约逻辑...");
  const liquidator = new ethers.Contract(ADDR.LIQUIDATOR_V2, [
    "function _getWETHPosition() view returns (bool wethIsToken0)"
  ], ethers.provider);
  
  try {
    // 这个调用可能会失败，因为 _getWETHPosition 是 internal
    console.log("合约 _getWETHPosition 函数是 internal，无法直接调用");
    
    // 手动验证逻辑
    const token0 = await pair.token0();
    const expectedWethIsToken0 = token0.toLowerCase() === ADDR.WETH.toLowerCase();
    console.log("   预期 wethIsToken0:", expectedWethIsToken0);
    
  } catch (e) {
    console.log("   合约方法验证跳过（internal 函数）");
  }
  
  // 4) 检查工厂合约验证
  console.log("\n🏭 验证工厂合约...");
  try {
    const factory = await pair.factory();
    console.log("   Factory 地址:", factory);
    
    const factoryContract = new ethers.Contract(factory, FACTORY_ABI, ethers.provider);
    const officialPair = await factoryContract.getPair(ADDR.WETH, ADDR.USDT);
    
    console.log("   官方 WETH/USDT Pair:", officialPair);
    console.log("   我们使用的 Pair:   ", ADDR.WETH_USDT_PAIR);
    
    if (officialPair.toLowerCase() === ADDR.WETH_USDT_PAIR.toLowerCase()) {
      console.log("✅ Pair 地址正确");
    } else {
      console.log("❌ Pair 地址不匹配！");
      console.log("   建议使用:", officialPair);
    }
    
  } catch (e) {
    console.log("⚠️ 工厂合约验证失败:", e.message);
  }
  
  // 5) 测试小额 flash swap 计算
  console.log("\n🧮 测试 Flash Swap 参数计算...");
  const testWethAmount = ethers.parseUnits("1", 18); // 1 WETH
  
  try {
    const token0 = await pair.token0();
    const wethIsToken0 = token0.toLowerCase() === ADDR.WETH.toLowerCase();
    
    const amount0Out = wethIsToken0 ? testWethAmount : 0n;
    const amount1Out = wethIsToken0 ? 0n : testWethAmount;
    
    console.log("   测试金额: 1 WETH");
    console.log("   wethIsToken0:", wethIsToken0);
    console.log("   amount0Out:", amount0Out.toString());
    console.log("   amount1Out:", amount1Out.toString());
    
    // 检查是否有一个是0，一个非0
    if ((amount0Out > 0n && amount1Out === 0n) || (amount0Out === 0n && amount1Out > 0n)) {
      console.log("✅ Flash Swap 参数计算正确");
    } else {
      console.log("❌ Flash Swap 参数计算错误");
    }
    
  } catch (e) {
    console.log("❌ Flash Swap 参数计算失败:", e.message);
  }
  
  // 6) 建议修复方案
  console.log("\n💡 建议修复方案:");
  console.log("1. 如果 Pair 地址不正确，更新为官方地址");
  console.log("2. 如果 Token 顺序有问题，检查 _getWETHPosition 逻辑");
  console.log("3. 可能需要在合约中添加更多的检查和错误处理");
  console.log("4. 考虑先用小额测试（如 0.1 WETH）");
  
  console.log("\n✅ 诊断完成");
}

main().catch((e) => {
  console.error("❌ 诊断失败:", e);
  process.exit(1);
}); 