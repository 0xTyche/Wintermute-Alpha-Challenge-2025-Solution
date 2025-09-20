## [**Shedding light**](https://alpha.wintermute.com/case-studies#shedding-light)

### 题意：

简要描述用于实现结果的方法，如果必要，提供一个**私有Dune查询**的链接。

1. 仅关注2025年7月期间的SOL/USDC市场，并且仅通过Jupiter的流量，找到：
按成交量排名的前3个dark AMMs。
    
    对于前3个中的每一个，按成交量排名的顶级taker。
    
    注意，如果您发现难以获取交易时的准确价格，您可以将SOL固定为$150，USDC为$1。
    
2. 对于这部分，简短的书面答案就足够了。

（1）解释您如何估计dark AMMs的PNL。
（2）复杂的参与者如何利用dark AMMs？
（3）dark AMMs如何管理来自复杂参与者的威胁？

1. 假设参与者是理性的，并且只有在pnl >= 0时才会操作dark AMM。计算SolFi自2025年初以来的收入下限。

### 解题思路：

首先要清楚的了解dark amm是什么东西，所以我首先在推特上搜索了相关内容，这是一篇比较具体能否比较好的了解的科普文章
（ https://x.com/ec_unoxx/status/1957005022178447452 ）。

在该科普文章中有这么一句话，（简单来说，暗池这个东西对于寻找alpha来说，具有极大的价值）

> **专业做市商驱动 (Private/Proprietary)**：暗池流动性通常不来自于散户LP，而是由少数几个专业的做市商团队提供。这个团队使用自己复杂的、链下的做市算法来决定报价。
> 

同样对于没写过dune的我来说是比较有难度的，借助AI辅助，https://dune.com/queries/5697898/9252008/b9d07337-c32b-4d94-8a37-20ec70e2a181 写了一个简单的查询，但是出现了一个比较大的问题，就是只能查到2个dark amm。

```solidity
SELECT
  amm_name,
  SUM(COALESCE(input_usd, output_usd)) AS volume_july
FROM jupiter_solana.aggregator_swaps AS sp
WHERE
  block_time >= CAST('2025-07-01' AS TIMESTAMP)
  AND block_time < CAST('2025-08-01' AS TIMESTAMP)
  AND (
    (
      input_mint = 'So11111111111111111111111111111111111111112'
      AND output_mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    )
    OR (
      input_mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
      AND output_mint = 'So11111111111111111111111111111111111111112'
    )
  )
  AND amm_name IN ('HumidiFi', 'SolFi', 'ZeroFi', 'GoonFi', 'Obric', 'Tessera V', 'Lifinity') /* 基于搜索结果的黑暗 AMM 列表，可扩展 */
GROUP BY
  amm_name
ORDER BY
  volume_july DESC
LIMIT 3
```

那么我就在想，是不是查询过程中，一些dark amm实际是被计算在unknow里面了，所以不知道具体的交易量是多少，于是我决定从program入手，因为只要是经过确定的program就知道是谁的dark amm。

这是通过查询solscan得到

| Address | Name |
| --- | --- |
| 9H6tua7jkLhdm3w8BvgpTn5LZNU7g4ZynDmCiNN3q6Rp | HumidiFi program |
| TessVdML9pBGgG9yGks7o4HewRaXVAMuoVj4x83GLQH | Tessera V |
| SoLFiHG9TfgtdUXUjWAxi3LtvYuFyDLVhBWxdMZxyCe | SolFi |
| goonERTdGsjnkZqWuVjs73BZ3Pb9qoCUdBUL17BnS5j | GoonFI |
| 2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c | Lifinity |
| obriQD1zbpyLz95G5n7nJe6a4DPjpFwa5XYPoNm113y | Obric |

但是新的问题出现了，使用program 去编写dune会出现超时的情况，应该是program的数据太多了，导致了超时的情况。所以我第一次答题的答案只给出了SolFi、ZeroFi 的精确数据，而HumidiFi是通过估算的，虽然有经过多途径相互印证。

HumidiFi: 6081335034

SolFi: 7993236220.675474

ZeroFi: 5308862873.601681

在比赛结束后，我复盘时，我找到了jupiter的dune面板，其中具有比较全的信息 https://dune.com/jupiterexchange/jupiter-aggregator-solana ，以及面板中有关于 https://dune.com/queries/3099670/5172147 ，在这两个的基础上，我们可以就可以写出所有amm在2025年7月份的sol-usdc成交量 https://dune.com/queries/5754707/9337192/。

```solidity
-- SOL–USDC 各 AMM 在 2025-07 的成交量（降序）
WITH july_sol_usdc AS (
  SELECT *
  FROM jupiter_solana.aggregator_swaps sp
  WHERE
    -- 时间范围：2025-07-01 00:00:00 至 2025-08-01 00:00:00（UTC）
    sp.block_time >= CAST('2025-07-01' AS TIMESTAMP)
    AND sp.block_time <  CAST('2025-08-01' AS TIMESTAMP)
    -- 仅保留 SOL <-> USDC 交易，不论方向
    AND (
      (UPPER(sp.input_symbol)  IN ('SOL','WSOL') AND UPPER(sp.output_symbol) IN ('USDC','USDC.E','USDCET'))
      OR
      (UPPER(sp.output_symbol) IN ('SOL','WSOL') AND UPPER(sp.input_symbol)  IN ('USDC','USDC.E','USDCET'))
    )
)

SELECT
  'SOL-USDC'                                     AS pair,          -- 标准化展示
  amm_name,
  COUNT(*)                                       AS swaps,
  COUNT(DISTINCT tx_signer)                      AS traders,
  SUM(COALESCE(input_usd, output_usd))          AS volume_july_2025
FROM july_sol_usdc
GROUP BY 1, 2
ORDER BY volume_july_2025 DESC;

```

| **Token Pair** | **AMM Name** | **# Swaps** | **# Traders** | **volume_july_2025** |
| --- | --- | --- | --- | --- |
| **SOL-USDC** | **SolFi** | **7.0m** | **392.0k** | **7993236220.675473** |
| **SOL-USDC** | **ZeroFi** | **3.3m** | **96.4k** | **5308862873.601683** |
| SOL-USDC | OpenBookV2 | 994.0k | 10.9k | 2391443978.648524 |
| SOL-USDC | Jupiter Perps | 31.6k | 1.8k | 806571146.840907 |
| **SOL-USDC** | **Lifinity v2** | **3.3m** | **260.4k** | **654158124.8905284** |
| SOL-USDC | Meteora | 5.7m | 397.2k | 372162359.2279413 |

但是可以发现还是没有HumidiFi，是查询漏了还是没有走jupiter呢？

经过查询发现，HumidiFi是于2025年6月份推出的，所以可能是jupiter还为对其数据进行收集或者对program进行标记。

这个是Humidifi sol-usdc 交易对在2025年7月份的成交量 https://dune.com/queries/5755513/9338460/ ，查询后发现为0，jupiter_solana 确实没有Humidifi的数据。

https://solanafloor.com/zh/news/how-humidifi-became-a-top-solana-dex-by-volume-in-under-three-months

但是查询发现已经有不少的交易量了，所以必须得考虑 HumidiFi。

首先换个方式查询一下池子，就不从jupiter去查询，而是通过program/已有humidifi的数据，去查询其在7月份的成交量。我尝试使用program的地址去查询，结果发现查询给我的提示都是超时，所以我不得已去寻找dune上已有的humidifi数据 (https://dune.com/stepanalytics_team/humidifi-stats)。

https://dune.com/queries/5758576/9343024/ 可以发现sol-usdc还是成交量为0，那么是不是humidifi上的sol和usdc的兑换是通过 wsol-usdc 池子进行的呢？所以我找到了humidifi 四个wsol-usdc的池子，然后查询这四个池子在2025年7月份的总成交量。

```solidity
/* Humidifi 指定 4 个池：2025-07 月度成交量（USD） */
WITH target_pools AS (
  SELECT
    *
  FROM (VALUES
    ('DB3sUCP2H4icbeKmK6yb6nUxU5ogbcRHtGuq7W2RoRwW', 'WSOL-USDC 1'),
    ('AvGeFw71N5sNfV97mZ1uNrHg4yfufRicCJUrS9j2ehTX', 'WSOL-USDC 2'),
    ('6n9VhCwQ7EwK6NqFDjnHPzEk6wZdRBTfh43RFgHQWHuQ', 'WSOL-USDC 3'),
    ('FksffEqnBRixYGR791Qw2MgdU7zNCpHVFYBL4Fa4qVuH', 'WSOL-USDC 4')) AS v(pool_address, pool_label)
), pool_txs /* 找出 2025-07 期间“涉及这些池地址”的交易 tx_id */ AS (
  SELECT DISTINCT
    aa.tx_id,
    aa.address AS pool_address
  FROM solana.account_activity AS aa
  JOIN target_pools AS p
    ON aa.address = p.pool_address
  WHERE
    aa.block_time >= TRY_CAST('2025-07-01' AS DATE)
    AND aa.block_time < TRY_CAST('2025-08-01' AS DATE)
), trades_july /* 把这些交易与 dex_solana.trades 交集，并只保留 Humidifi 的成交腿 */ AS (
  SELECT
    t.tx_id,
    pt.pool_address,
    t.amount_usd
  FROM dex_solana.trades AS t
  JOIN pool_txs AS pt
    ON t.tx_id = pt.tx_id
  WHERE
    t.block_time >= TRY_CAST('2025-07-01' AS DATE)
    AND t.block题意
```

非常遗憾，这一份代码的查询结果是No results from query。

最后没办法，还是只能用solscan查询地址去估算其成交量，大致是在6081335034左右。

关于humidifi更多的信息可以查看这里：https://x.com/0xSharples/status/1963582629665485222

### 补充

frodan 完成了对答案的更新，也说明了也确实没在dune寻找到humidifi的数据，他在学习该 https://dune.com/queries/5683337 查询的基础上，添加了限制条件，完成了对humidifi的查询。

```sql
SELECT
    case 
        when a.amm = '9H6tua7jkLhdm3w8BvgpTn5LZNU7g4ZynDmCiNN3q6Rp' then 'Humidifi'
        when a.amm = 'SoLFiHG9TfgtdUXUjWAxi3LtvYuFyDLVhBWxdMZxyCe' then 'SolFi'
        when a.amm = 'ZERor4xhbUycZ6gb9ntrhqscUcZmAbQDjEAtCf4hbZY' then 'ZeroFi'
        when a.amm = 'goonERTdGsjnkZqWuVjs73BZ3Pb9qoCUdBUL17BnS5j' then 'GoonFi'
        when a.amm = 'TessVdML9pBGgG9yGks7o4HewRaXVAMuoVj4x83GLQH' then 'Tessera'
        when a.amm = 'REALQqNEomY6cQGZJUGwywTBD2UmDT32rZcNnfxQ5N2' then 'Byreal'
        when a.amm = 'obriQD1zbpyLz95G5n7nJe6a4DPjpFwa5XYPoNm113y' then 'Obric'
    end as AMM_Name
    , COUNT(*) as total_trades
    , SUM((input_amount * b.price / POWER(10, b.decimals) + output_amount * c.price / POWER(10, c.decimals)) / 2) AS total_volume_usd
FROM jupiter_v6_solana.jupiter_evt_swapevent AS a
JOIN dex_solana.price_hour AS b
    ON a.input_mint = b.contract_address
    AND DATE_TRUNC('hour', a.evt_block_time) = b.hour and b.price < pow(10, 6)
JOIN dex_solana.price_hour AS c
    ON a.output_mint = c.contract_address
    AND DATE_TRUNC('hour', a.evt_block_time) = c.hour and c.price < pow(10, 6)
WHERE
    amm in (
        '9H6tua7jkLhdm3w8BvgpTn5LZNU7g4ZynDmCiNN3q6Rp' -- Humidifi
        , 'SoLFiHG9TfgtdUXUjWAxi3LtvYuFyDLVhBWxdMZxyCe' -- SolFi
        , 'ZERor4xhbUycZ6gb9ntrhqscUcZmAbQDjEAtCf4hbZY' -- ZeroFi
        , 'goonERTdGsjnkZqWuVjs73BZ3Pb9qoCUdBUL17BnS5j' -- GoonFi
        , 'TessVdML9pBGgG9yGks7o4HewRaXVAMuoVj4x83GLQH' -- Tessera
        , 'REALQqNEomY6cQGZJUGwywTBD2UmDT32rZcNnfxQ5N2' -- Byreal
        , 'obriQD1zbpyLz95G5n7nJe6a4DPjpFwa5XYPoNm113y' --Obric
        )
    AND evt_block_time >= date'2025-07-01' 
    AND evt_block_time < date'2025-08-01'
    AND (
        (b.symbol = 'WSOL' AND c.symbol = 'USDC') OR
        (b.symbol = 'USDC' AND c.symbol = 'WSOL')
    )
GROUP BY 1
ORDER BY total_volume_usd DESC
```

### 第二个问题

（1）第一种方法，参考自一篇论文，其讲述的是被动流动性供应的盈亏（PnL）*与市场条件（例如交易费、价格波动性和交易量）之间的关系。https://arxiv.org/html/2508.08152v1 ，如果参考cex的方法来估算cex的话，

首先，论文将LP 绩效是分为两个部分，一个是未对冲的PnL，另一个是已对冲的PnL。

基准价格：就比如sol-usdc代币对，我们以 sol = 150 u，为基准价格，或者是选择cex的价格去做基准价格也可以。

未对冲PnL：$PnL^{unhedged}=[V_T​−V_0​]+∑^{T}_{t=1}​Fees_t​$

> 其中，$V_T=Y_t+S_tX_t$，$V_t$sol-usdc就以usdc为计价资产。
$X_t$是池中的风险资产，sol-usdc对中，就相当于sol。
$Y_t$是在sol-usdc中就是usdc，稳定币计价资产。
$S_t$是基准价格；$Fees_t$为按费率×成交量（或者是连链上查其收取手续费的地址）
> 

这个逻辑是根据论文中所提到的，未对冲收益=池资产按CEX估值的变动+全部手续费

剩下要计算的部分自然就是已对冲收益：可以通过借贷协议/CEX/DEX构造对冲投资组合，每个时间都要将持仓调整到和池中风险资产的数量相抵消（就比如10sol的持仓，就要有10sol的空单去进行对冲，当然对冲自然要考虑到交易手续费以及资金费率等的损耗）。

已对冲收益本质就是“手续费+跟踪误差”，即

$PnL^{hedged}=[V_t​−H_t​​​]_{0→T}​+∑Fees_t​$

其中跟踪误差就是$V_t-H_t$,以上就是第一种PnL的估算方法，关于基准价格可以依靠bianace分钟线价格+Uniswap V2池数据做校准和回测，从而找到最有PnL轨迹。

dark amm总的Pnl，将该dark amm所有的池子按上述方法计算后，累加。

第二种方法就是利用逐笔基准中价法（execution vs. mid）估算dark amm的PNL，对每一笔成交i，设成交价

$p_i$、数量$q_i$（以基础资产计），方向$\text{side}_i \in \{+1,-1\}$（买入为 +1，卖出为 −1），基准中价 $m_i$

（来自外部参考，如 CEX/预言机/TWAP）。

单笔交易毛利：$TradePNL_i​≈side_i​⋅(p_i​−m_i​)⋅q_i​+fees_i​$

全期：$GrossPNL=∑​_{i}TradePNL_i​$

算完总收益后，要再扣除对冲成本、**库存持有的市值波动**（期末按基准价重估）与**基础设施成本**，得到净 PnL。

第三种方法（来自于chatgpt提出的）库存记账法：https://arxiv.org/abs/2208.06046?utm_source=chatgpt.com

![image.png](https://github.com/0xTyche/Wintermute-Alpha-Challenge-2025-Solution/blob/main/Shedding%20Light/pic/method3.png?raw=true)

（2）题目中所提及的复杂的参与者或者是说有复杂需求的交易者，应该如何应用或者参与dark amm，

1. **大单/机构做 Taker**：通过聚合器（比如okx）把订单路由到 dark AMM，因其主动流动性与更快对齐外盘的定价，**冲击成本更低**、信息泄露更少，适合分块成交与再平衡。
2. **跨盘做市/套利**：自营团队可**运行自家 dark AMM**（或与之合作），用外盘（CEX/订单簿 DEX）作实时对冲，**内部化订单流**、赚取微小点差 + 费用；报道中提到 Wintermute 运营的 Tessera V 就是此类代表。
3. **时延与信息优势**：在行情剧烈波动时，若 dark AMM 的报价更新仍有“极短暂滞后”，高频者可能**择时提交**获取正向价差；不过由于 dark AMM **高频主动改价**并参考链下数据，这种空间比传统 AMM **小得多**。

（3）dark AMMs 如何应对复杂参与者的威胁？ 可以查阅这些dark amm的推特号，发现都是没有给出网页前端，基本是仅接入聚合器，无公开前端/LP。

- **主动做市 + 外部中价锚定**：持续更新买卖盘、紧跟外盘（CEX/预言机），把“**被动价格滞后 → 被套利**”的 LVR 成本压低。
- **风控与准入**：可设置**最大单笔/频率限制、钱包或路由白名单、报价 TTL/最后审视（last-look）**、滑点保护与拒单逻辑，降低“毒性流”命中率。行业综述与实践均指出“私有/半私有撮合 + 主动定价”能显著缓解机器人与信息不对称带来的侵蚀。
- **快速对冲与库存管理**：基于库存暴露（delta/skew）**自适应点差**与**即时对冲**，把价格风险外包给外盘；与传统被动 AMM 相比，dark AMM 的核心竞争力就在于**把 LVR 转化为可控的对冲成本**。

1. 假设参与者理性，只在 PNL >=0 时运行 SolFi，这意味着收入至少覆盖成本，包括 Gas 费用作为主要变量成本。

即 收入下限 = PNL = 0，我们可以利用第二问中所列出的PnL公式，将其置为0后进行推导。

首先查询一下SolFi相关的数据面板https://dune.com/web3precious/solfi，然后查询一下前8个月的。

```sql
SELECT
  TRY_CAST(DATE_TRUNC('month', block_date) AS DATE) AS month, /* 每月的第一天 */
  SUM(amount_usd) AS monthly_volume_usd /* 每月成交量(USD) */
FROM dex_solana.trades
WHERE
  block_date >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '12' month
  AND project = 'solfi'
GROUP BY
  1
ORDER BY
  1 DESC
```

就以第二问中的第一种方法去估算，

- 成交量 (V): 从 Dune Analytics 或链上数据查询获取（https://solscan.io/account/SoLFiHG9TfgtdUXUjWAxi3LtvYuFyDLVhBWxdMZxyCe、https://solscan.io/account/SV2EYYJyRz2YhfXwXnhNAevDEui5Q6yrfyo13WtupPF）。
- 费用率 (f): AMM 收取的交易费用率，根据查询链上数据SolFI收取 0.1%。
- 波动率 (σ): 资产年化波动率（如 SOL 或 ETH 的历史/预期值）
- 流动性池规模 (L): AMM 池中锁定的总流动性价值
- 对冲频率 (h): 已对冲场景下 delta 再平衡频率（如每日或每小时）。假设每日 1 次。
- 对冲成本率 (c): 每次对冲的交易费用 + 滑点，假设 0.01% - 0.05% 的池规模，实际应该会比预估的更小。
- 固定成本 (FC): 基础设施（服务器、云服务如 AWS）、员工、合规等，年化假设 1M - 5M USD（中小型 Dark AMM，来自于Gork 估算）。
- 其他成本

PnL = 总收入-成本，总收入=成本，即为总收入下限，这样才能正常运行。

- 收入 (Revenue): 主要来自交易费用。Revenue = V × f
- 无常损失/流动性提供的基础成本 $LVR ≈ (1/2) × γ × σ² × V × Δt$
    - $γ$: 池曲率（CPMM 为 $1/L$）。
    - $σ$: 波动率（0.6）。
    - $Δt$: 时间周期（年化为 1）。
- 对冲成本 (Hedging Costs):
    - Hedged PnL = Revenue - (Hedged LVR) - Hedging Costs - FC（固定成本）
- 未对冲成本
    - Unhedged PnL = Revenue - LVR - FC
- 总成本 = 对冲成本+未对冲成本+其他运行成本，根据上面的估算至少会达到9m。

【说明】对于这一问许多数据我是通过大致估算得到的，其中还有包括了各种运营成本、人员成本、以及其他损耗，但是dark amm要维持基本的经营就必须确保其盈利能够覆盖成本，算是一次学习和尝试吧，其中可能还是存在许多不合理的地方。

### 收获总结

1. dune 数据查询优先考虑站在前人的肩膀上去寻找答案，从基础查询费时费力，同时可能会遇到超时的问题。
2. dune 查询是对代币数据、代币情况分析极佳的工具，不是无用的炫技党，客观的数据分析能够客观的分析其具体情况。
3. 暗池如今已经逐渐的占据市场很大一部分成交量，也是做市商喜欢的交易路径，对其了解和学习是十分必要的。
4. 利用AI以及浏览器查询，快速掌握总结不熟悉的信息和知识，要多考虑论文，以及项目的信息文档和开源代码。