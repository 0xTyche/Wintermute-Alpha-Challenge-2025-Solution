const hre = require("hardhat");
const { ethers } = hre;
require("dotenv").config();

async function main() {
    console.log("🚀 开始部署 LlamaLendLiquidatorV2 合约...\n");

    // 获取部署者信息
    const [deployer] = await ethers.getSigners();
    console.log("部署账户:", deployer.address);
    
    const balance = await ethers.provider.getBalance(deployer.address);
    console.log("账户余额:", ethers.formatEther(balance), "ETH\n");

    // 部署合约
    console.log("正在编译和部署合约...");
    const LlamaLendLiquidatorV2 = await ethers.getContractFactory("LlamaLendLiquidatorV2");
    const liquidator = await LlamaLendLiquidatorV2.deploy();
    
    console.log("⏰ 等待部署确认...");
    await liquidator.waitForDeployment();
    
    const contractAddress = await liquidator.getAddress();
    console.log("✅ 合约部署成功!");
    console.log("📍 合约地址:", contractAddress);
    
    // 验证合约代码
    console.log("\n🔍 验证合约部署...");
    const deployedCode = await ethers.provider.getCode(contractAddress);
    if (deployedCode === "0x") {
        throw new Error("❌ 合约部署失败：地址上没有代码");
    }
    console.log("✅ 合约代码验证通过");

    // 显示重要的常量地址
    console.log("\n📝 合约内置地址确认:");
    console.log("- Balancer Vault:", "0xBA12222222228d8Ba445958a75a0704d566BF2C8");
    console.log("- Uniswap V2 Router:", "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D");
    console.log("- CRV Token:", "0xD533a949740bb3306d119CC777fa900bA034cd52");
    console.log("- crvUSD Token:", "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E");
    console.log("- USDT Token:", "0xdAC17F958D2ee523a2206206994597C13D831ec7");
    console.log("- Curve crvUSD/USDT Pool:", "0x390f3595bCa2Df7d23783dFd126427CCeb997BF4");

    console.log("\n🎯 下一步操作:");
    console.log("1. 将此合约地址添加到.env文件:");
    console.log(`   LIQUIDATOR_V2_ADDRESS=${contractAddress}`);
    console.log("\n2. 选择清算方式（三种选择）:");
    console.log("   🚀 专用UniV2脚本（推荐）:");
    console.log("     npx hardhat run scripts/univ2-flash-liquidate.js --network tenderly");
    console.log("   🔧 通用安全脚本（默认UniV2，可切换）:");
    console.log("     npx hardhat run scripts/run-weth-liquidate-safe.js --network tenderly");
    console.log("   ⚠️ 仅Balancer模式（可能失败）:");
    console.log("     USE_FLASH_SWAP=0 npx hardhat run scripts/run-weth-liquidate-safe.js --network tenderly");
    console.log("\n💰 开始大额清算，绕过Balancer问题！");

    return contractAddress;
}

main()
    .then((contractAddress) => {
        console.log("\n🎉 部署完成!");
        console.log("合约地址:", contractAddress);
        process.exit(0);
    })
    .catch((error) => {
        console.error("❌ 部署失败:", error);
        process.exit(1);
    }); 