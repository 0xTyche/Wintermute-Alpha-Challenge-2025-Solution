const hre = require("hardhat");
const { ethers } = hre;
require("dotenv").config();

// Balancer Vault地址
const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";

// 主要代币配置（地址、精度、近似价格）
const MAJOR_TOKENS = [
    {
        name: "USDT",
        address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        decimals: 6,
        priceUSD: 1.0
    },
    {
        name: "USDC", 
        address: "0xA0b86a33E6441c8C8D8CD1D0A2eB9c40d58D7b0E",
        decimals: 6,
        priceUSD: 1.0
    },
    {
        name: "DAI",
        address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        decimals: 18,
        priceUSD: 1.0
    },
    {
        name: "WETH",
        address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        decimals: 18,
        priceUSD: 3000 // 假设ETH价格$3000
    },
    {
        name: "WBTC",
        address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
        decimals: 8,
        priceUSD: 60000 // 假设BTC价格$60000
    },
    {
        name: "FRAX",
        address: "0x853d955aCEf822Db058eb8505911ED77F175b99e",
        decimals: 18,
        priceUSD: 1.0
    },
    {
        name: "LUSD",
        address: "0x5f98805A4E8be255a32880FDeC7F6728C6568bA0",
        decimals: 18,
        priceUSD: 1.0
    },
    {
        name: "crvUSD",
        address: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E",
        decimals: 18,
        priceUSD: 1.0
    },
    {
        name: "BUSD",
        address: "0x4Fabb145d64652a948d72533023f6E7A623C7C53",
        decimals: 18,
        priceUSD: 1.0
    },
    {
        name: "TUSD", 
        address: "0x0000000000085d4780B73119b644AE5ecd22b376",
        decimals: 18,
        priceUSD: 1.0
    }
];

async function main() {
    console.log("🔍 检查Balancer Vault中各种代币的可借余额...\n");
    
    console.log("📍 Balancer Vault地址:", BALANCER_VAULT);
    console.log("⏰ 检查时间:", new Date().toLocaleString());
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    const tokenBalances = [];

    for (let i = 0; i < MAJOR_TOKENS.length; i++) {
        const token = MAJOR_TOKENS[i];
        
        try {
            // 检查代币合约是否存在
            const tokenCode = await ethers.provider.getCode(token.address);
            if (tokenCode === "0x") {
                console.log(`❌ ${token.name}: 合约不存在`);
                continue;
            }

            // 创建代币合约实例
            const tokenContract = await ethers.getContractAt([
                "function balanceOf(address) external view returns (uint256)",
                "function symbol() external view returns (string)",
                "function name() external view returns (string)"
            ], token.address);

            // 获取Vault中的余额
            const balance = await tokenContract.balanceOf(BALANCER_VAULT);
            const balanceFormatted = parseFloat(ethers.formatUnits(balance, token.decimals));
            const valueUSD = balanceFormatted * token.priceUSD;

            // 尝试获取真实的symbol（备用验证）
            let realSymbol = token.name;
            try {
                realSymbol = await tokenContract.symbol();
            } catch (e) {
                // 使用预设名称
            }

            const tokenInfo = {
                name: token.name,
                realSymbol: realSymbol,
                address: token.address,
                balance: balance,
                balanceFormatted: balanceFormatted,
                valueUSD: valueUSD,
                priceUSD: token.priceUSD
            };

            tokenBalances.push(tokenInfo);

            // 显示进度
            const status = balanceFormatted > 0 ? "✅" : "⭕";
            console.log(`${status} ${token.name.padEnd(8)} | ${balanceFormatted.toLocaleString().padStart(15)} | $${valueUSD.toLocaleString().padStart(15)}`);

        } catch (error) {
            console.log(`❌ ${token.name}: 检查失败 - ${error.message.substring(0, 50)}...`);
        }
    }

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    // 按USD价值排序
    tokenBalances.sort((a, b) => b.valueUSD - a.valueUSD);

    console.log("\n🏆 按可借价值排序的代币清单:");
    console.log("排名 | 代币     | 余额                | USD价值              | 单价");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    tokenBalances.forEach((token, index) => {
        if (token.valueUSD > 0) {
            const rank = (index + 1).toString().padStart(2);
            const name = token.name.padEnd(8);
            const balance = token.balanceFormatted.toLocaleString().padStart(15);
            const value = ("$" + token.valueUSD.toLocaleString()).padStart(18);
            const price = ("$" + token.priceUSD.toLocaleString()).padStart(10);
            
            console.log(`${rank}   | ${name} | ${balance} | ${value} | ${price}`);
        }
    });

    // 找出最大余额的代币
    const topToken = tokenBalances[0];
    if (topToken && topToken.valueUSD > 0) {
        console.log("\n🎯 推荐使用的代币:");
        console.log(`📍 最大可借代币: ${topToken.name} (${topToken.realSymbol})`);
        console.log(`📊 可借余额: ${topToken.balanceFormatted.toLocaleString()} ${topToken.name}`);
        console.log(`💰 USD价值: $${topToken.valueUSD.toLocaleString()}`);
        console.log(`📍 合约地址: ${topToken.address}`);
        
        // 计算与目标债务的关系
        const targetDebtUSD = 4349978; // 434.9万crvUSD债务
        const coverage = (topToken.valueUSD / targetDebtUSD * 100).toFixed(1);
        console.log(`📈 债务覆盖率: ${coverage}%`);
        
        if (topToken.valueUSD >= targetDebtUSD) {
            console.log("✅ 该代币余额足够完全清算目标债务!");
        } else {
            console.log("⚠️ 该代币余额不足以完全清算，但可以进行部分清算");
        }

        // 建议的闪贷金额（95%安全边际）
        const suggestedAmount = topToken.balanceFormatted * 0.95;
        console.log(`💡 建议闪贷金额: ${suggestedAmount.toLocaleString()} ${topToken.name}`);
        console.log(`🔢 Wei格式: ${ethers.parseUnits(suggestedAmount.toFixed(topToken.name === 'WBTC' ? 8 : topToken.name.includes('USD') && topToken.name !== 'crvUSD' ? 6 : 18).toString(), topToken.name === 'WBTC' ? 8 : topToken.name.includes('USD') && topToken.name !== 'crvUSD' ? 6 : 18)}`);

        console.log("\n📋 下一步操作:");
        console.log("1. 如果该代币不是USDT，需要修改清算合约的swap路径");
        console.log("2. 更新partial-liquidate.js中的FLASH_AMOUNT参数");
        console.log("3. 重新执行清算获得更大收益");

    } else {
        console.log("\n❌ 未找到有余额的代币");
    }

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🔍 检查完成!");
}

main().then(() => {
    process.exit(0);
}).catch(error => {
    console.error("❌ 检查失败:", error);
    process.exit(1);
}); 