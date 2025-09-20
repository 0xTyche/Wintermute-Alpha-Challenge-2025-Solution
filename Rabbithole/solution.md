## **Rabbithole**

### 说明

这一题我一开始的思路是，1. 寻找黑客的资金路径，一个是资金来源，一个是资金去向 2.寻找类似的攻击手段。

赛后来看，我没有很好的追踪混币器资金去向的能力，而且在寻找类似的攻击的手段的思路上，我过于着重去寻找他人对于攻击行为的分析文章，而忽略了从攻击者部署的合约入手，算是一份很宝贵的经验。

### 题意

事实证明 Vyper 有 bug，一些 Curve 池子易受攻击，所以你观察到尽管有白帽努力，但三个不同池子被 drain 了。几天后，你发现 exploiter 返回了其中两个的资金，但 CRV/ETH 那个呢？你有理由相信这个 exploiter 负责同年发生的其他 DeFi exploits。请提供至少两个例子（不同 exploiter EOAs），包括之前的 exploits 带有 Etherscan 链接，以及证明连接的 reasoning（一些 high-level methodology 细节有助于加强证明）。你不能使用 2023 年 8 月 5 日后的数据证明你的观点。

0xb752def3a1fded45d6c4b9f4a8f18e645b41b324 CRV/ETH Exploiter1
0xb1c33b391c2569b737ec387e731e88589e8ec148 CRV/ETH Exploiter2

### 题解

本篇题解主要学习 https://github.com/Frodan/wintermute-alpha-2025-writeups/blob/main/Rabbithole/Writeup.md 以及添加自己学习过程中的理解和补充知识。

排查思路（黑客活动要点）

- 资金来源（黑客需要 ETH 支付 gas 费，资金来源）
- 漏洞执行（这一点主要在于反编译合约，以及研究合约的部署、执行）
- 提现地址（资金去向）
- 交易行为模式

接下来就按照上面四个方面逐一分析

- 资金来源

这一点非常有意思，像我们在冲狗的时候都会注意dev的资金来源是否是安全的，比如dev资金来源于coinbase或者是bianace的大盘子，很多时候我们就会认为其是安全的，最少安全性是高于类似抹茶这一类无需KYC的交易所的。

但是这个黑客的资金是直接来源于bianace，难道说黑客就不担心自己的身份遭到币安的审查，或者说资金被币安冻结吗？

因此认为资金来自币安，很可能绕过了安全监控。虽然监控系统主要关注 Tornado Cash、Railgun、FixedFloat 和其他混合器，但攻击者可能使用伪造的 KYC 文件，然后将资金注入了bianace后取出。

CRV/ETH Exploiter1的资金来源 1：[bianace 16](https://etherscan.io/address/0xdfd5293d8e347dfe59e90efd55b2956a1343963d)

CRV/ETH Exploiter1的资金来源 2：[bianace 17](https://etherscan.io/address/0x56eddb7aa87536c09ccc2793473599fd21a8b17f)

暂时无法从这个资金来源发现其他的信息，如果具有时效性的话或许可以联系币安进行查询，以及请求其注入资金的来源。

- 提现地址（资金去向）

不妨列一个表格，对资金的所有去向做一个统计。

| 去向 | 说明 |
| --- | --- |
| 0x5181547A3fdEa1ac79f1F06EAA22EdFe7d077c6b | 创建合约/合约交互 |
| 0xb1833a4879a12ee9b8D75190f74f5bA43D436eA6 | 创建合约/合约交互 |
| 0xA757328FF7ab8C36e7286C559d8aB03578036b95 | 创建合约/合约交互 |
| 0xB1C33b391C2569B737eC387E731E88589e8ec148 | 漏洞攻击者的第二地址；CRV/ETH Exploiter 2 |
| 0xc772BdB4588414D8401aB90aA9DA084eB52E7475 | 攻击者2转出ETH到该地址 |

0xB1C33b391C2569B737eC387E731E88589e8ec148 可以发现ETH 都被攻击者转移到了这个地址。

https://etherscan.io/tx/0x8c82ba8010687de3ee501195a33795868fec2995eedbc082171fb7170ac315bc 一共转移了7680个WETH

截至2025年9月15日，攻击者的钱包中仍有6180个WETH，是攻击者落网了还是由于什么原因导致剩下的WETH没有处理，或者转出。

![image.png](https://github.com/0xTyche/Wintermute-Alpha-Challenge-2025-Solution/blob/main/Rabbithole/pic/exploiter'%20eth%20posittion.png?raw=true)


可能很多人查看攻击者地址2会感觉到很奇怪没有看到直接转入混币器的交易，攻击者是先把资金再转移到该地址https://etherscan.io/address/0xc772BdB4588414D8401aB90aA9DA084eB52E7475 ，然后将资金拆分成每一笔100ETH，转入了混币器。

![image.png](https://github.com/0xTyche/Wintermute-Alpha-Challenge-2025-Solution/blob/main/Rabbithole/pic/transer%20to%20tomado1.png?raw=true)

攻击者2先转出一笔1ETH（0xebf4f4eedd4aca5cfe3fc370aa47b06a6ff4b1a49875d8eb2c7a1201cd1f4964）

确认没有问题后，又转出了1499ETH

（0x8183db87e201923efa3b36bce72745f406e729dc994a46a79bcc811a30fb44df）

![image.png](https://github.com/0xTyche/Wintermute-Alpha-Challenge-2025-Solution/blob/main/Rabbithole/pic/transer%20to%20tomado2.png?raw=true)

总共只有1500ETH经过了混币器的处理（还有部分作为手续费留存）

关于为什么只处理了这1500，以下是猜测，

攻击者已经试过把部分资金经中转地址拆分后送入 Tornado（2024-07-10 那轮），说明钥匙在手、资金可动。留大头不动，往往是为了降低当下暴露风险，等待更合适的出场窗口或更“干净”的路径（比如新的跨链桥/混币器/OTC通道）。

Tornado 本身长期处在制裁与高监控之下，直接大额走混币器很容易被链上分析串联。很多黑客会选择**长时间“冷存”** + **少量多次**的“剥皮链”来降维可见度。

从盗取时间到现在，如果黑客的目的在于价格博弈，那么留存的ETH确实迎来了价格新高，算是成功“投资”了。

- 交易行为分析

我们可以注意到我们之前分析的资金去向，在2023年7月28日实际是创建了三个合约，在Frodan的题解中提到，“该账户最初是为了攻击 MiningRig 合约而创建的”，对该点其实我挺疑惑的，要如何判断出之前创建的合约是为了攻击哪个目标呢？

因为一般攻击合约是不会写明具体的攻击对象的，而是会在调用的时候将攻击目标的合约地址作为参数传入部署的攻击合约从而进行攻击。

我们其实可以发现2025年7月28日 创建（[0xfdd41e68ac5d07a6c95715a75d84f3418abcace9059430ed1832fade00e227f9](https://etherscan.io/tx/0xfdd41e68ac5d07a6c95715a75d84f3418abcace9059430ed1832fade00e227f9)）的合约，发现实际在28号当日就调用了一次 https://etherscan.io/tx/0x845d8c3dc6427629306c7f8bfe0f7c0531d1c8729a6449232b7e8b6f8ba9a846 ，显然也是一次攻击。

那么我们不妨搜索一下他攻击的是什么？[0xE0E907e3743715294c2A5f52618d278CBc006CEd](https://x.com/search?q=0xE0E907e3743715294c2A5f52618d278CBc006CEd&src=typeahead_click)

![image.png](https://github.com/0xTyche/Wintermute-Alpha-Challenge-2025-Solution/blob/main/Rabbithole/pic/miningrig%20twitter%20infomation.png?raw=true)

我们可以看到不少对该被攻击合约的分析。于是我们能够得到该结论了“该账户最初是为了攻击 MiningRig 合约而创建的。”

https://etherscan.io/tx/0x845d8c3dc6427629306c7f8bfe0f7c0531d1c8729a6449232b7e8b6f8ba9a846#eventlog

“c0ffeebabe.eth于 7 月29 日率先利用了该漏洞（可能抢先了其他黑客的先机）。这表明 CRV/ETH 漏洞利用者试图利用一个已知的漏洞。”  但是经过查看这个CRV/ETH Exploiter早在7月28日就执行了攻击了。

于是我考虑是不是c0ffeebabe早在28号就有攻击了，只是报告推文上挂的是29日的攻击记录呢？

https://etherscan.io/txs?a=0xc0ffeebabe5d496b2dde509f9fa189c25cf29671&p=1196 首先查询c0ffeebabe所有的交易记录，

https://etherscan.io/tx/0xa3cd2c9c3be457f5c4b08e377279cd29b30e108d417d09d9380411200a7586ed 还真是发现在Jul-28-2023 01:37:47 PM UTC就开始动手了，说明确实这个漏洞被人提前利用了。

![CRVETH Exploiter att MiningRig.png](https://github.com/0xTyche/Wintermute-Alpha-Challenge-2025-Solution/blob/main/Rabbithole/pic/Exploiter%E8%B0%83%E7%94%A8%E5%90%88%E7%BA%A6%E4%B8%8Eminingrig%E4%BA%A4%E4%BA%92%E7%9A%84%E8%AF%A6%E7%BB%86%E8%BF%87%E7%A8%8B.png?raw=true)

这个是CRV/ETH Exploiter调用合约与miningrig交互的详细过程。

可以认为这是原本黑客想要攻击的目标，也可以认为这是黑客想要做一次链上的测试。

【28日首先是做了一下尝试，CRV/ETH Exploiter 通过代理合约去调 MiningRig，只用 0.005 ETH 先换了点 PEPE，随后在 Uniswap v3 加了一个极小的 LP；结果只是给代理地址铸了 55,494,586 枚 PNDX，没有得到可兑现资产，净效果是亏了 gas】

然后29日，黑客正式动手，但是实际上已经被人撸的差不多了，这个是对该时间的报告 https://x.com/0xjustadev/status/1685277465483026432。

![CRVETH Exploiter att MiningRig2.png](https://github.com/0xTyche/Wintermute-Alpha-Challenge-2025-Solution/blob/main/Rabbithole/pic/%E8%BF%99%E6%98%AF%E5%AE%8C%E6%88%90%E4%B8%80%E6%AC%A1%E8%B0%83%E5%8F%96miningrig%E8%8E%B7%E5%88%A9%E7%9A%84%E5%AE%8C%E6%95%B4%E6%B5%81%E7%A8%8B.png?raw=true)

这是完成一次调取miningrig获利的完整流程，黑客进行了多次，最后获利32.291419732496523585 ETH。 https://etherscan.io/address/0xa757328ff7ab8c36e7286c559d8ab03578036b95#tokentxns

https://docs.google.com/spreadsheets/d/1gUi7Nxs6V4wHKUMfSq85d2ShFW3fsMfggKIEV846ROQ/edit?gid=0#gid=0

这里我们可以直接查看 https://github.com/Frodan/wintermute-alpha-2025-writeups/blob/main/Rabbithole/Writeup.md 制作的时间表格。

“攻击者并非独立发现 Vyper 漏洞。至少有 5 名不同的攻击者已经利用了该漏洞，Twitter 上也对该漏洞进行了热议。CRV/ETH 漏洞利用者只是针对这个已知漏洞编写了自己的利用程序。Vyper 重入漏洞公开后，分秒必争。攻击者很可能重复利用该钱包进行 CRV/ETH 攻击，以节省匿名存款的时间。”

而不必采用新伪造kyc获取新的资金来进行攻击。

![hyver.png](https://github.com/0xTyche/Wintermute-Alpha-Challenge-2025-Solution/blob/main/Rabbithole/pic/hyver.png?raw=true)

下面根据上面的根据上面所示资金流图（标号 [1]–[12]）说明利用“Vyper 重入锁失效”盗取资金的流程。

**[1] 从 Balancer Vault 闪电贷 10,000 WETH**

这些钱直接打到攻击合约（图中 *Receiver* https://etherscan.io/address/0x83e056ba00beae4d8aa83deb326a90a4e100d0c1 ）。

**[2] / [3] WETH 与原生 ETH 互换（像WETH、WSOL其存在的意义就是打包给合约，便于合约去使用）**

攻击合约把拿到的 WETH 按需要**解包/打包**，为下一步与 Curve 池（Vyper 合约）交互做准备。

**[4] 向 Vyper 合约（Curve CRV/ETH 池）转入 26,000 ETH**

这一步等价于**加入流动性/换入仓位**，从而在池子里获得/更新一份 crvCRVETH 的 LP 份额（下一步会被“赎回”）。

**[5]、[6] LP 份额被烧毁（crvCRVETH → 0x00…00）**

在图上可以看到两条“烧毁”记录，直观反映了**一次调用过程中发生了异常的多次赎回/结算**——这是重入漏洞被成功触发的信号。

[5] 攻击者先 `add_liquidity` 或等价操作，获得一笔 LP 份额（日志显示从 0x00…00 转给他）。这只是拿到“赎回凭证”。

**第一次赎回并销毁（receiver → 0x00…00）**进入 remove_liquidity* 路径，LP 被 _burn，池子应按当前储备与总供给计算应付的 ETH/CRV 并转给攻击者。

（注意可能对销毁存在疑问，为什么销毁了合约却还需要兑付资产呢？实际上这里销毁，销毁的是凭证而不是我们常说的销毁代币，当你销毁凭证，拿到销毁的证明了，合约就应该给你兑付相应的资产，表示你当前已经取出原先存放的LP）

0x000…000 不是一个真的账户，不能发起转账；它只用来在日志里表示“总供应减少/增加”。

**[7] 池子向攻击合约支付 33,680.49 ETH**

这是“赎回流动性”拿到的 ETH，但由于漏洞，**这笔 ETH 远超其应得份额**（超额部分就是被盗走的价值）。

**[8] / [9] 与池子的 CRV 资产对冲流转**

攻击在过程中还**搬动了大量 CRV（约 1.06 亿进、9,867 万出）**。具体哪一步“加/减流动性”取决于调用路径，但核心结论是：

- 攻击者**最终从池子拿到了巨量 CRV**（图示 [9] 直接从 Vyper 合约流向攻击合约）。
- 配合 [7] 的超额 ETH，一起构成“净获利”。

**[10] / [11] 把其中 17,680.49 ETH 再次打包成 WETH**

这是为了归还闪电贷做准备。

**[12] 归还 10,000 WETH 给 Balancer Vault**

闪电贷结清后，攻击合约**仍然留有多余的 ETH/CRV**（ETH 的净增量大致可视作 [7] − [4] ≈ **+7,680 ETH**，再叠加抢出的 CRV 余额），这部分就是**纯利润**。

---

如何理解该漏洞？

多次兑付是怎么做到的呢？

合约当看到用户取出流动性销毁凭证后，支付给用户相应的资产，然后不就结束了，用户怎么做到让合约多次兑付资产的？

核心就在于重入（reentrancy）：合约在“给用户打钱”的那一刻把执行权交还给了用户地址（或用户控制的合约），而**关键状态还没来得及更新**，再加上当时 Vyper 的 `@nonreentrant` 锁**失效（**Vyper 的 `@nonreentrant` 编译器漏洞让“锁”不起作用。**）**，于是用户可以在同一笔交易里**再次调用同一赎回函数**，让合约**按旧状态又算了一次、又付了一次**——就出现了“多次兑付”。

（如何做到呢？就是一次remove_liqudity没完成，用户又调用了一次）

- **双重 LP 烧毁**（[5]/[6] 同高数额）：典型重入/重复结算迹象。
- **赎回得到的 ETH 远大于先前注入**（[7] 远高于 [4] 的应得比例）。
- **瞬时大体量 CRV 出入**（[8]/[9]）：配合 LP 重入路径，常用于错位计价套利/抽干。

这次利用的核心是**Vyper 编译器导致的重入保护失效**。攻击者先用**闪电贷**放大弹药，往池子里**短暂加仓**，随后在**赎回流程中重入**，让合约在**状态更新前后错位**地给自己**重复兑付**，最终拿到**超额的 ETH 与 CRV**；归还闪电贷后，**剩余资产即为利润**。

### 漏洞利用技术-发现合约特点

每个漏洞利用合约都使用相同的独特混淆技术：双重 keccak256 哈希运算，并对所有者进行字节操作检查，从而防止 MEV 机器人抢先利用漏洞。

或者是编码习惯有什么特殊的。于是我们反编译攻击者创建的合约代码 https://app.dedaub.com/ethereum/address/0x83e056ba00beae4d8aa83deb326a90a4e100d0c1/decompiled

可以发现

```sql
function 0x9b9() private { 
    if (32 < 32) {
        v0 = v1 = uint256(v0);
    }
    return keccak256(keccak256(address(tx.origin))) == v0;
}
```

这是一个**混淆后的“白名单/所有者校验”函数**，常用于防 MEV 机器人“抄交易”。它做的事只有一件：

把当前交易的外层发起人tx.origin做**两次 keccak256**，再跟合约里预先存好的 32 字节常量（v0）对比；相等才放行。

经过询问gpt，发现这种加密混淆的手段并不是攻击者常用的，所以可以作为攻击者的一大特征。

![image.png](https://github.com/0xTyche/Wintermute-Alpha-Challenge-2025-Solution/blob/main/Rabbithole/pic/chatgpt%20for%20keccak.png?raw=true)

基于上面所述内容，总结攻击者的特征如下

- 资金来源 bianace
- 资金去向混币器，有留存资金的行为（可能是习惯），证明不缺钱
- 对于小利润也不放过（已泄露漏洞仍会尝试攻击）
- 合约编写 双重 keccak256
- 同一钱包多次遭黑客攻击
- 针对无需审计的小型项目

**以下内容完全来自于frodan的题解，仅做了翻译记录。**（比较头疼该新闻归档查询还需要花钱订阅）

https://newsletter.blockthreat.io/archive

通过寻找新闻归档寻找具有上述类似特征的黑客攻击事件。

**案例 #1**

攻击者 EOA：活动时间：2022-11-04 至 2023-01-26 [`0xceed34f03a3e607cc04c2d0441c7386b190d7cf4`](https://etherscan.io/address/0xceed34f03a3e607cc04c2d0441c7386b190d7cf4)

与 CRV/ETH 攻击者的共同特征

- 币安融资
- 双重 keccak 检查漏洞（无需字节操作 - 可能在后续攻击中有所改进，因为这是在 2022 年底部署的）
- 部分资金仍留在漏洞合约中
- 同一地址多次遭黑客攻击
- 瞄准低市值代币

攻击示例

攻击包括操纵不同的代币对（$CANDLE、$BCI、$RINU）。该账户曾多次遭遇黑客攻击，涉及多个协议：

- 弹性交换： [0x23bc33d17cb268a7588a9c0dde9127705b464b7c12a44b5ca41fa911bc26d583](https://etherscan.io/tx/0x23bc33d17cb268a7588a9c0dde9127705b464b7c12a44b5ca41fa911bc26d583)
- $CANDLE、$BCI、$RINU 操纵： [BlockSec 分析](https://x.com/blocksecteam/status/1618572725643276288)
- 凸锁窃取： [0xdb0ec2d6ddef41f599b804e6022a4b6eea6ba6cf3a919dc880a7472be2e1d58c](https://etherscan.io/tx/0xdb0ec2d6ddef41f599b804e6022a4b6eea6ba6cf3a919dc880a7472be2e1d58c)
- UPS 令牌 skim() 攻击： [0x4b3df6e9c68ae482c71a02832f7f599ff58ff877ec05fed0abd95b31d2d7d912](https://etherscan.io/tx/0x4b3df6e9c68ae482c71a02832f7f599ff58ff877ec05fed0abd95b31d2d7d912)

额外的行为洞察

这个钱包的活动证实了我最初的标记并揭示了新的模式：

- 已确认：同一账户在较长时间内被多次用于黑客攻击
- 已确认：针对任何易受攻击的协议，无论其潜在利润如何（有些收益低于 100 美元）
- 新标记：从不使用自毁合同，尽管当时这种合同很流行

**案例 #2**

攻击者 EOA：活动时间：2023-04-09 至 2023-04-24[`0xdbdf5f801da11d65fe9b1d449cbed6ebe2f04fd3`](https://etherscan.io/address/0xdbdf5f801da11d65fe9b1d449cbed6ebe2f04fd3)

与 CRV/ETH 攻击者的共同特征

- 币安融资
- 漏洞利用中的双重 keccak 检查
- 同一地址多次遭黑客攻击
- 通过 Tornado Cash 提款
- 瞄准低市值代币

攻击示例

- Swapos 破解： [0x87a34e9d1d991c6747242fc64f25be05da68522aa14aaffdcbb44dc78b66c50c](https://etherscan.io/tx/0x87a34e9d1d991c6747242fc64f25be05da68522aa14aaffdcbb44dc78b66c50c)
- DefiGreek 破解：[0xa32c84ad09369880dfbdf01bcacc2de632ab8c49d97c33ef695fd0d344955b3d](https://etherscan.io/tx/0xa32c84ad09369880dfbdf01bcacc2de632ab8c49d97c33ef695fd0d344955b3d)

**案例 #3**

攻击者 EOA：活动时间：2023-04-27 至 2023-04-28[`0x3bfe2a46f0050c76ea95b65abfa826bbfb27596d`](https://etherscan.io/address/0x3bfe2a46f0050c76ea95b65abfa826bbfb27596d)

与 CRV/ETH 攻击者的共同特征

- 币安融资
- 漏洞利用中的双重 keccak 检查
- 部分资金仍留在漏洞合约中
- 在其他黑客之后利用漏洞
- 瞄准低市值代币

攻击示例

- Fortube 黑客攻击： [交易](https://etherscan.io/tx/0x082144b012cf4cb266569085829a12fa64fb3a4a9931289e930e14ead4a3737d)

**案例#4：BSC 运营开始**

攻击者 EOA：活动时间：2023-04-03 至 ~2023-05-06注意：与主网操作不同，攻击者在所有已识别的钱包中使用 BSC 上的 Tornado Cash 存款，而不是 Binance。[`0x2d2bcd3caed4b51b7090c78cfd73ea091a4b44de`](https://bscscan.com/address/0x2d2bcd3caed4b51b7090c78cfd73ea091a4b44de)

与 CRV/ETH 攻击者的共同特征

- 漏洞利用中的双重 keccak 检查
- 同一地址多次遭黑客攻击
- 通过 Tornado Cash 提款
- 瞄准低市值代币

攻击示例

- FryingDutchManSailingBusd： [交易](https://bscscan.com/tx/0x10f290b3f71a7ad0296d481c9ac0b63815a9609e60f79aa0b84d09ae2eda0118)
- CHATGPT： [交易](https://bscscan.com/tx/0xc944855bf9060ad4dc261d96ce66ea331b00bcc0ed89169542c1a2156c443e06)
- Andre Anonymous (AA)： [交易](https://bscscan.com/tx/0x7b41ed2db8606953984bb131ca103444037f82923fa2a8f7b9fc5627dffc5e0e)

**案例 #5**

攻击者 EOA：活动时间：2023-05-21 至 2023-05-24 [`0x054a3574d8082112575843dd944ff42c58dda38d`](https://bscscan.com/address/0x054a3574d8082112575843dd944ff42c58dda38d)

与 CRV/ETH 攻击者的共同特征

- 漏洞利用中的双重 keccak 检查
- 同一地址多次遭黑客攻击
- 瞄准低市值代币

攻击示例

- GCCombinedSwap： [交易](https://bscscan.com/tx/0x913b6313250675ef9fecefe371928bcc4be20ed234fae44e8e6bf409e9208e49)

**案例 #6**

攻击者 EOA：活动时间：2023-05-28 至 2023-06-01 [`0x0A3feE894eb8fCB6f84460d5828d71Be50612762`](https://bscscan.com/address/0x0A3feE894eb8fCB6f84460d5828d71Be50612762)

与 CRV/ETH 攻击者的共同特征

- 漏洞利用中的双重 keccak 检查
- 同一地址多次遭黑客攻击
- 瞄准低市值代币

攻击示例

- Marketplace：[交易](https://bscscan.com/tx/0xd92bf51b9bf464420e1261cfcd8b291ee05d5fbffbfbb316ec95131779f80809)

**案例 #7**

攻击者 EOA：活动时间：2023-06-02 至 2023-06-10 [`0x0060129430df7ea188be3d8818404a2d40896089`](https://bscscan.com/address/0x0060129430df7ea188be3d8818404a2d40896089)

与 CRV/ETH 攻击者的共同特征

- 漏洞利用中的双重 keccak 检查
- 同一地址多次遭黑客攻击
- 瞄准低市值代币

攻击示例

- SELLC： [交易](https://bscscan.com/tx/0xd91cf50e8c0d12f521dcfa909c0c139e007eb26cb0868b0a22b36532ececc192)

**结论**

攻击者在所有案例中都表现出一致的行为模式：

- 目标选择：专注于低安全性且无需审计的项目
- 利润容忍度：愿意利用最低利润（<100 美元）
- 攻击类型：主要是流动性/奖励操纵攻击
- 技术签名：独特的双 keccak256 所有者检查实现
- 钱包管理：轮换热钱包以应对连续多次黑客攻击
- 帐户迁移：清晰地按时间顺序从一个帐户迁移到另一个帐户
- 提现模式：延迟提现，同时新钱包持续攻击
- 资金来源：
    - 主网：币安存款（可能使用假的 KYC）
    - BSC：Tornado Cash 存款

### 总结收获

1. 能够更好的阅读链上哈希、合约
2. 合约有许多的细节是我曾经不曾去注意到的，但是如今却发现它能够很大程度的凸显攻击者的某些特征，以及暴露攻击者的一些信息
3. 工具：
    1. https://app.dedaub.com/ 可以用于反编译合约
    2. https://blocksec.com/explorer 哈希交易的流程可视化
    3. https://newsletter.blockthreat.io/archive 区块链新闻归档
4. 利用掌握的特征查询归档新闻，寻找同类项