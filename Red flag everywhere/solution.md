## [**Red flags everywhere**](https://github.com/WintermuteResearch/Alpha-Challenge-2025/tree/main/02-red-flags-everywhere)

### 题意

这道题更偏向于投资机构研究员对一个主网项目的客观分析，同样对于我这种掌握点pvp技巧的是极为陌生的。

对一个新的以太坊SVM L2项目Eclipse做一个尽职调查。最终由于存在多个问题（Red Flag，风险）而被放弃投资，现在由我们调查一下。

1. 他们的测试网没有停机，但 Celestia 上的 blob 发布是否也一致？如果不是，发布中的差距是什么？
2. 无论好坏，这个 L2 已经上线了。上个月的前 5 大活动来源是什么？它们的经济意义是什么？
3. 在鲸鱼存款者中，你发现了一个做市商https://etherscan.io/address/0x88cf132d5d46c390391344a1ec8bb98340d8a066 。他们在 L2 上做什么？提供他们在那里的一些 DeFi 仓位示例。如果可能，提供浏览器链接。

### 解题思路

首先需要了解一些基础概念，

blob：高效存储和管理大块二进制数据，Blob是附加到区块的大数据块（约128kB），存储L2批量交易数据，但不永久保留在链上（约18天后自动删除），以减少主网负担。

1. 
这个是我在第一次解题的时候所找的Celenium 上的blobhttps://celenium.io/namespace/00000000000000000000000000000000000000000065636c69707365?tab=Blobs ，其中错误的点主要是题目要求我们找到的是测试网的，所以错误了。

正确的blob：https://mocha-4.celenium.io/namespace/0000000000000000000000000000000000000000000065636c74330a?tab=Blobs 。

原回答：

The blob posting on Celestia for Eclipse L2's testnet was not consistent. The data usage dropped sharply after March 2025, indicating gaps or reduced posting frequency/size. Specific gaps: 

From April 1 to May 1, 2025, usage fell 88.11% (from ~488B bytes to ~58B bytes); 

from March 1 to April 1, a 62.46% drop (from ~1.3T bytes to ~488B bytes). 

These suggest missing or incomplete postings, potentially due to configuration issues or network changes, raising data availability risks despite no downtime.

原本答案我是找了数据和信息扔给ai进行分析，可是由于信息提供的不够准确和全面，以及ai的瞎分析，导致了答案其实存在严重不正确的。

经过阅读 https://github.com/Frodan/wintermute-alpha-2025-writeups/blob/main/Red%20Flags%20Everywhere/Writeup.md ，以下是我对正确答案的学习和总结。

首先要直接点击Celenium的save可以发现能够下载和得到的blob数据是非常少的，题目是通过查阅Celenium的文档，去得到完整的数据。但是由于api是需要花钱的，所以秉持的节省的理念，我先查看了下前端，实际是可以直接拿到所有数据的。

可以直接请求后，存储下载这些数据，https://api-mocha-4.celenium.io/v1/namespace/0000000000000000000000000000000000000000000065636c74330a/0/blobs?sort_by=time&limit=10&offset=10 ，拿到数据后保存为json格式的，数据格式如下，

```json
  {
    "id": 19478693,
    "commitment": "IJmsVnks5f2Ew9DSQ5elSXXuDiETusfnMDkmCfPcaog=",
    "size": 110435,
    "height": 1663137,
    "time": "2024-04-22T06:48:13.559571Z",
    "content_type": "application/octet-stream",
    "tx": {
      "id": 4765709,
      "height": 1663137,
      "position": 1,
      "gas_wanted": 1038697,
      "gas_used": 1002897,
      "timeout_height": 0,
      "events_count": 9,
      "messages_count": 1,
      "hash": "2c72f1bccd7049dae66f443d11d86efb3d22a8fa4b854f50441e5d5a515c1941",
      "fee": "2285",
      "time": "2024-04-22T06:48:13.559571Z",
      "message_types": [
        "MsgPayForBlobs"
      ],
      "status": "success"
    },
    "signer": {
      "hash": "celestia1rh9z568fqpm9hv2nv02sm2rusq8q9np3yc9qum"
    }
  },
```

blob是用于存储数据的，如果blob的发布，存在时间不连续，或者是异常间隔等情况，则是说明L2出现了问题，那么这么多数据我们需要对其进行可视化后，才能更为直观的分析其是否存在异常。

![gaps_over_time.png](https://github.com/0xTyche/Wintermute-Alpha-Challenge-2025-Solution/blob/main/Red%20flag%20everywhere/pic/gaps_over_time.png?raw=true)

这张图是在看**相邻两次 Celestia blob 发布之间的时间间隔，**会出现两个blob间隔时间越来越长的情况，就说明没有新的blob发布，导致举例前一个blob的时间间隔变长。

说明可能出现了宕机、网络/索引器停机等问题（当然也有可能是数据抓取中断），但是长时间的间隔增加大概率是由于宕机问题所导致的。

表格说明：

| **Gap #** | **Duration (s)** | **Hours** | **Days** | **Before Time (UTC)** | **After Time (UTC)** |
| --- | --- | --- | --- | --- | --- |
| 4116 | 32159 | 8.9 | 0.4 | 2023-12-13 21:01:01 | 2023-12-14 05:57:01 |
| 11595 | 2066173 | 573.9 | 23.9 | 2023-12-16 02:31:30 | 2024-01-09 00:27:43 |
| 41948 | 213585 | 59.3 | 2.5 | 2024-02-17 14:31:12 | 2024-02-20 01:50:57 |
| 48044 | 3683413 | 1023.2 | 42.6 | 2024-02-25 12:52:25 | 2024-04-08 04:02:38 |

### 原第二问错误解答

https://defillama.com/chain/eclipse

Total Value Locked in DeFi **$14.27m**

https://dune.com/hkey/eclipse-mainnet-bridge 

https://dune.com/angry/eclipse-mainnet-dashboard-and-wallet-rank

https://l2beat.com/scaling/projects/eclipse

跨链桥流量（Eclipse Canonical Bridge + Hyperlane）：196,325 ETH

**Canonically Bridged：$28.99 M**

https://defillama.com/dexs/chain/eclipse

https://www.coingecko.com/en/exchanges/orca-eclipse

现货 DEX 交易（Invariant, Orca 等）:
DeFiLlama 显示 Eclipse 近 30 天 DEX 成交约 **$51.8m**；CoinGecko 列出 Orca(Eclipse) 活跃交易对（如 USDC/ETH）；Invariant 在 6-9 累计量已破 **$500m**（为总量概念，可佐证 7 月具备活跃交易基础）。
主要集中在USDC/ETH（占比70.68%）、SOL/ETH、SOL/ETH交易对，7 月成交主要集中在蓝筹对（USDC/ETH），价差/滑点正常，属健康活跃。

https://coingape.com/trending/eclipse-airdrop-live-how-to-claim-es-tokens-before-august-15/

$ES 空投申领（claims.eclipse.xyz）：“真实经济活跃度”贡献有限，7 月链上交互以“领币+转出”为主，是短期红旗。

https://www.eclipse.xyz/articles/everything-eclipse-ed-12

AllDomains .turbo 域名铸造/续费（身份类交互）：单笔金额小、笔数多；对“活跃地址/交互次数”有贡献，但直接经济价值有限。疑似“任务型”短期冲量。认为短期红旗。

Turbo Tap 游戏内交互（点按/Boost 任务）：
官方文章与媒体报道确认 Turbo Tap 为压力测试/积分玩法，grass 积分**不**与代币 1:1 对应；7 月空投叙事中被纳入参与度参考。对 TPS/交易笔数“极友好”但经济含金量低

Eclipse L2's July 2025 activity showed moderate growth with TVL reaching $14.27m (per DeFiLlama) and total tx volume ~5.2 million (estimated from Dune dashboards like angry/eclipse-mainnet-dashboard-and-wallet-rank). However, sources highlight mixed sustainability. Top-5 activity sources (ranked by tx contribution/volume from Dune/L2BEAT data, e.g., bridge ~35% of inflows, DEX ~25% of tx):

1. Bridge Deposits (Canonical Bridge + Hyperlane): 196,325 ETH bridged ($28.99m canonical value, per L2BEAT). Economic sense: Positive for bootstrapping liquidity and user acquisition (80% of TVL growth), but high churn risk if withdrawals spike post-incentives—good for initial adoption but a red flag for long-term stability.
2. DEX Trading (Invariant, Orca, etc.): $51.8m in 30-day volume (DeFiLlama), focused on USDC/ETH (70.68%), SOL/ETH pairs; Invariant's July portion estimated at ~$150m from cumulative $500m trend. Economic sense: Strongly positive for organic demand and price discovery, with low slippage indicating real user engagement—healthy if volume persists beyond hype.
3. $ES Airdrop Claims (via claims.eclipse.xyz): High tx count from claims/transfers (Dune bridge data shows spike in outflows). Economic sense: Negative; boosts short-term metrics but promotes farming with low retention—major red flag for inflated, non-genuine activity.
4. AllDomains .turbo Domain Minting/Renewals: Small-value, high-frequency tx (contributing ~10-15% to active addresses, per official articles). Economic sense: Neutral; enhances community identity and tx counts, but task-driven and low economic value—potential red flag if not evolving into broader utility.
5. Turbo Tap Game Interactions (taps/boosts): Points-based gameplay inflating TPS (official Eclipse articles note as stress-test, Grass points not 1:1 token-linked). Economic sense: Negative; gamifies volume for incentives but lacks substantive value—red flag signaling artificial engagement that may drop post-event.

Overall, positive aspects include genuine DeFi traction (bridges/DEX contributing ~60% sustainable value), but negative dominance from incentives (airdrop/game/domains ~40%) suggests potential user exodus, a common L2 red flag.

Reference:

https://dune.com/hkey/eclipse-mainnet-bridge 

https://dune.com/angry/eclipse-mainnet-dashboard-and-wallet-rank

https://l2beat.com/scaling/projects/eclipse

https://www.coingecko.com/en/exchanges/orca-eclipse

https://coingape.com/trending/eclipse-airdrop-live-how-to-claim-es-tokens-before-august-15/

https://www.eclipse.xyz/articles/everything-eclipse-ed-12

1. 由于要寻找大户或者做市商所以他们最佳的仓位应该是大额的u本位，这样能够确保本金安全并且可以参与做市，所以我在token页选择usdc token，然后寻找持有排名靠前的用户。

https://eclipsescan.xyz/token/AKEWE7Bgh87GPp171b4cJPSSZfmZwQ3KaqYqXoKLNAEE#holders

我选择排名第二的大户进行答题，[ATuknQhKuySnp8sCV6kAn1mdBraLKwMq24cGU8rF2xEW](https://eclipsescan.xyz/account/ATuknQhKuySnp8sCV6kAn1mdBraLKwMq24cGU8rF2xEW)

添加流动性：使用usdc 兑换代币ETH，并将USDC和ETH添加到流动性 https://eclipsescan.xyz/tx/JAqL6RyFHiNgzMirHXwGDKdA1owQBcUawkCeq5vkm3b31323cPiVuhcLjHgjACFM51bA2nuqSJKTowWBwdLmc1G

创建代币并添加流动性：[3nGKWoit9HuH7mPon8pyj8d5H7nv47ucMUQXFAQMPd1TRLqY77FRRUGH7rYNHMPNig74tRzp3KHVgVsDPnKgHkM2](https://eclipsescan.xyz/tx/3nGKWoit9HuH7mPon8pyj8d5H7nv47ucMUQXFAQMPd1TRLqY77FRRUGH7rYNHMPNig74tRzp3KHVgVsDPnKgHkM2)

移除流动性：https://eclipsescan.xyz/tx/QEL71bDy2SLeSb6qVdZnEGdWna1AD2tBz57AJjeFHTsgEk5UQAiKU2mpRPanLZ6Xoe8dX1GnwGakJiNwbp3C6f8

相关的defi交互可以从该地址寻找：https://eclipsescan.xyz/amm/orca 在usdc持有排行orca的地址是排第一的。

通过查询得知astrol 是Eclipse上的借贷平台，从而通过查询前端接口知道astrol bank地址 

usdc 借贷bank

[7NeDyW6MA7zLdTWDbctFoXfJ6vSQX7YvtBh7EbdXqDi9](https://eclipsescan.xyz/account/7NeDyW6MA7zLdTWDbctFoXfJ6vSQX7YvtBh7EbdXqDi9)

ETH 借贷bank

https://eclipsescan.xyz/account/5UYMqm6tSdkukzmYnpDXgKbiL7vgv7cKgHCjqk8NfRRa

可以通过选择**Instructions找到借贷操作，比如（但是该地址不是做市商地址）**

[2BBiJHdY9YS1XdwkXExadbuF7dAC4ykLVH7soTw8Gooy67aFHjGif6L6Qu47o2kTLKiT59PmB68tEMJcLTndCCiR](https://eclipsescan.xyz/tx/2BBiJHdY9YS1XdwkXExadbuF7dAC4ykLVH7soTw8Gooy67aFHjGif6L6Qu47o2kTLKiT59PmB68tEMJcLTndCCiR)

Among the whale depositors on Eclipse L2, I identified a likely market maker based on large USDC holdings (optimal for capital safety and market making). From the USDC token holders page

[(https://eclipsescan.xyz/token/AKEWE7Bgh87GPp171b4cJPSSZfmZwQ3KaqYqXoKLNAEE#holders)](https://eclipsescan.xyz/token/AKEWE7Bgh87GPp171b4cJPSSZfmZwQ3KaqYqXoKLNAEE#holders)

, I selected the second-ranked holder: ATuknQhKuySnp8sCV6kAn1mdBraLKwMq24cGU8rF2xEW

[(https://eclipsescan.xyz/account/ATuknQhKuySnp8sCV6kAn1mdBraLKwMq24cGU8rF2xEW)](https://eclipsescan.xyz/account/ATuknQhKuySnp8sCV6kAn1mdBraLKwMq24cGU8rF2xEW)

. This address ranks first in USDC holdings on Orca AMM

[(https://eclipsescan.xyz/amm/orca)](https://eclipsescan.xyz/amm/orca)

, suggesting active liquidity provision.On L2, this market maker primarily engages in liquidity management and token creation/swaps, focusing on DeFi positions like LP pools. Examples:

1. Adding Liquidity: Swapped USDC for ETH and added both to a liquidity pool on Orca/Invariant DEX. Position: USDC-ETH LP (estimated value ~$X based on tx amounts). Tx link: https://eclipsescan.xyz/tx/JAqL6RyFHiNgzMirHXwGDKdA1owQBcUawkCeq5vkm3b31323cPiVuhcLjHgjACFM51bA2nuqSJKTowWBwdLmc1G
2. Creating Token and Adding Liquidity: Created a new token and provided initial liquidity (likely for a custom pair). Position: Custom token-USDC LP. Tx link: https://eclipsescan.xyz/tx/3nGKWoit9HuH7mPon8pyj8d5H7nv47ucMUQXFAQMPd1TRLqY77FRRUGH7rYNHMPNig74tRzp3KHVgVsDPnKgHkM2
3. Removing Liquidity: Withdrew from a liquidity pool, possibly rebalancing. Position: Exited USDC-ETH LP. Tx link: https://eclipsescan.xyz/tx/QEL71bDy2SLeSb6qVdZnEGdWna1AD2tBz57AJjeFHTsgEk5UQAiKU2mpRPanLZ6Xoe8dX1GnwGakJiNwbp3C6f8

For lending interactions on Astrol (Eclipse's lending platform), while this specific whale has no direct borrows/loans in visible tx, general market makers use banks like ETH Bank

[(https://eclipsescan.xyz/account/5UYMqm6tSdkukzmYnpDXgKbiL7vgv7cKgHCjqk8NfRRa)](https://eclipsescan.xyz/account/5UYMqm6tSdkukzmYnpDXgKbiL7vgv7cKgHCjqk8NfRRa)

. Example lending tx (from a similar whale): Deposited USDC and borrowed ETH for leverage. Position: USDC collateralized loan. Tx link:

https://eclipsescan.xyz/tx/2BBiJHdY9YS1XdwkXExadbuF7dAC4ykLVH7soTw8Gooy67aFHjGif6L6Qu47o2kTLKiT59PmB68tEMJcLTndCCiR

Overall, activities indicate market making (LP provision/rebalancing) with some speculative token creation, but frequent removals could signal liquidity risks.

### 说明

原本没能找对做市商的地址的原因在于没有注意到题目提供了做市商eth的钱包地址。导致了整道题目的解答都是错误的。