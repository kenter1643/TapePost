/*
 * grok.js — TapePost 的「AI 能力 + 官方链接判定」共享层
 *
 * 被三处加载（同一份代码，不重复维护）：
 *   - background.js：importScripts('grok.js')，Service Worker 里组装 Grok 请求
 *   - popup.html：设置面板读取默认提示词
 *   - panel.html：TapeOut 生态面板做本地白名单判定与结果渲染
 *
 * 设计原则（防伪功能的安全底线）：
 *   1. 「是否被 TapeOut 生态导航认可」只由本地内置白名单的精确匹配决定。
 *      Grok 只负责解释理由、识别相似域名/短链/Punycode 等仿冒特征；模型结论
 *      与本地结论冲突时一律以本地为准 —— 大模型会幻觉，不能让它给钓鱼站发绿标。
 *   2. 清单分三档 tier：official（项目方官方 OFFICIAL 标记）/ listed（导航站
 *      编辑收录）/ deweb（web.tapeout.link 已索引的链上容器）。三者都算「导航认可」
 *      并给绿标，但 UI 必须区分等级，避免把社区容器误读成项目方背书。
 *   3. 只有少数独立品牌官网允许「同域任意路径 / 子域」命中；网关域名
 *      （tapekit.org 等）一律按精确地址比对，否则任何人部署的容器都会拿到绿标。
 *
 * 清单由 `node tools/refresh-sites.mjs` 从导航站公开数据文件生成，见 GENERATED 区块。
 */
'use strict';

var TapeAI = (function () {
  'use strict';

  // ---------- 1. 官方认定清单（生成区块） ----------
  // BEGIN GENERATED TAPEOUT SITES
  // 由 `node tools/refresh-sites.mjs` 生成，请勿手工编辑；数据源与口径见工具脚本头部注释。
  var SOURCE = {
    "name": "TapeOut.link 生态导航收录 + web.tapeout.link DeWeb 索引",
    "url": "https://tapeout.link/",
    "dataUrl": "https://tapeout.link/data/sites.js",
    "dewebUrl": "https://web.tapeout.link/",
    "dewebApi": "https://web.tapeout.link/api/sites",
    "checkedAt": "2026-11-08",
    "navCount": 61,
    "dewebCount": 234,
    "total": 295,
    "note": "绿标 = TapeOut.link 编辑收录的链接 + web.tapeout.link 已索引的链上容器。tier 区分「项目方官方 / 导航站收录 / 链上容器已索引」，三者均属生态导航认可，但只有 official 档是项目方官方。"
  };

  // 编辑审核收录的链接（含 5 条 OFFICIAL 标记）；全部给绿标。
  var OFFICIAL_SITES = [
    {"name":"TapeOut","url":"https://tapeout.net/","category":"官方入口","desc":"链上流片协议官方入口：mint NAND / LATCH 元件，在画布上连线设计电路，确认后流片为电路 NFT。","tier":"official","badges":["OFFICIAL"],"scope":"domain","added":"2026-09-12","source":"nav"},
    {"name":"Blonskr · X","url":"https://x.com/blonskr","category":"官方入口","desc":"TapeOut 发起人的账号。协议公告、功能上线与重要决定基本由这里首发——从宣布链上 CPU、开源协议，到放弃交易市场与挖矿合约的管理权。","tier":"official","badges":["OFFICIAL"],"scope":"exact","added":"2026-09-13","source":"nav"},
    {"name":"TapeHub.ai","url":"https://tapehub.ai/","category":"官方入口","desc":"TapeOut 生态的发射平台：任何人都能创建矿币项目（底池币可选 BEM / BNB / USD1），用底池币 Mint 晶体管，满额或创建满 6 小时且过半即毕业；毕业后…","tier":"official","badges":["OFFICIAL","HOT"],"scope":"domain","added":"2026-09-16","source":"nav"},
    {"name":"TapeKit","url":"https://tapekit.org/","category":"官方入口","desc":"tape:// 的公共网关：网站存进 TapeOut 电路容器后，用它就能在普通浏览器里打开。首页输入链上地址（电路编号 + 处理器编号，写法如 4246.0、#4246@0…","tier":"official","badges":["OFFICIAL"],"scope":"exact","added":"2026-09-16","source":"nav"},
    {"name":"TapeCode.ai","url":"https://tapecode.ai/","category":"官方入口","desc":"TapeOut 官方的 AI 应用生成器：用一句自然语言（例如「发一个代币，任何人都能领 1 枚」）生成合约与前端，10 分钟一键发布到线上运营。生成的合约由你的 TapeO…","tier":"official","badges":["OFFICIAL","NEW"],"scope":"domain","added":"2026-10-11","source":"nav"},
    {"name":"TapeOut Protocol 数据","url":"https://tapeout.work/","category":"链上数据","desc":"TapeOut 协议数据面板（TapeOut Labs）：处理器与电路数量、铸造进度、BEM 成交、空投领取、活动热力图与时间序列，并直接读链上 Linux 的机器状态。与官…","tier":"listed","badges":[],"scope":"exact","added":"2026-09-18","source":"nav"},
    {"name":"TapeOut VIP","url":"https://tapeout.vip/","category":"链上数据","desc":"全网矿机实时看板：矿工数与已验证 / 未验证权重、BEM 已挖出量与每日 7,200 BEM 产出、BEM 价格，中英韩三语。另含榜单、流片与开矿辅助（收编自某生态盘点：此前…","tier":"listed","badges":[],"scope":"exact","added":"2026-09-13","source":"nav"},
    {"name":"TapeWeb · DeWEB 查看器","url":"https://web.tapeout.link/","category":"链上数据","desc":"全网DeWEB网站扫描看板：每条记录都能直接打开对应站点，","tier":"listed","badges":["HOT"],"scope":"exact","added":"2026-09-19","source":"nav"},
    {"name":"TapeOutScan","url":"https://tapeoutscan.io/","category":"链上数据","desc":"TapeOut 公开数据浏览器：把承诺、流片、启动、榜首、转移与地址算力等记录逐条索引，每条都对应 BNB Smart Chain 上的公开链上证据，可点回原始交易核对。页面…","tier":"listed","badges":["NEW","HOT"],"scope":"exact","added":"2026-10-28","source":"nav"},
    {"name":"TapeOut Market","url":"https://tapeout.market/","category":"第三方交易所","desc":"TapeOut 生态的市场与服务平台：元件与电路实时行情、BEM 订单簿、矿机与容器、AI 顾问与工具集，另有一整套上手指南（NAND 与 LATCH 的区别、Behemot…","tier":"listed","badges":[],"scope":"exact","added":"2026-09-12","source":"nav"},
    {"name":"Firsto TapeOut","url":"https://tapeout.firsto.ai/","category":"第三方交易所","desc":"TapeOut 的专业交易终端（v2.1）：晶体管与电路实时行情、订单簿与成交明细，支持批量买卖与限价/市价挂单；带市值、24h 成交额、持仓地址、流通/燃烧/铸造量等指标，…","tier":"listed","badges":[],"scope":"exact","added":"2026-09-12","source":"nav"},
    {"name":"SILICON X · 晶链交易所","url":"https://siliconx.top/","category":"第三方交易所","desc":"SILICON X 一站式服务 TapeOut 生态，覆盖 BEM 交易、晶体管交易、矿机交易、矿机组装、挖矿管理、产出领取等功能。","tier":"listed","badges":[],"scope":"exact","added":"2026-09-12","source":"nav"},
    {"name":"TapeOut Club","url":"https://tapeout.club/","category":"第三方交易所","desc":"TapeOut 的非托管多市场交易所：交易晶体管与电路 NFT，订单聚合官方市场与自有盘口；另附全网算力总览——链上矿工数、已验证与未验证权重、BEM 发行量与每日产出分配。…","tier":"listed","badges":[],"scope":"exact","added":"2026-09-12","source":"nav"},
    {"name":"PancakeSwap · BEM 交易对","url":"https://pancakeswap.finance/swap?outputCurrency=0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a","category":"第三方交易所","desc":"BSC 上体量最大的 AMM，也是 BEM 的主要流动性池所在：链接已预填 BEM 为兑换目标，连上钱包即可按池价兑换（主池 BEM / USDT，另有 BEM / WBNB…","tier":"listed","badges":[],"scope":"exact","added":"2026-09-13","source":"nav"},
    {"name":"BEM OTC","url":"https://bemotc.com/","category":"第三方交易所","desc":"BNB Smart Chain 上的 BEM / USDT 去中心化挂单市场，用于场外挂单与撮合。","tier":"listed","badges":[],"scope":"exact","added":"2026-09-13","source":"nav"},
    {"name":"BEM 行情终端","url":"https://yuequan123.com/bem/","category":"第三方交易所","desc":"BEM 行情与即时兑换一体的链上终端：价格、流动性、24h 成交额、买卖笔数、1m–1d K 线与逐笔成交明细，由本站从 PancakeSwap V3 池合约采集计算；内置兑…","tier":"listed","badges":["NEW"],"scope":"exact","added":"2026-09-23","source":"nav"},
    {"name":"TapeOut Pro","url":"https://tapemkt.com/","category":"第三方交易所","desc":"CPU 资产多品种交易台 + 电路租赁：现货买卖 NAND / LATCH 等晶体管（1% taker，由官方市场合约收取），电路市场聚合成交全网已流片电路挂单（1% 平台费…","tier":"listed","badges":["NEW"],"scope":"exact","added":"2026-10-11","source":"nav"},
    {"name":"TapeUP","url":"https://tapeup.io/zh/trade","category":"第三方交易所","desc":"TAP20 交易市场，同时是基于 TapeOut DeWEB 协议的全链账本客户端。交易页带 PoB 交易引擎：把即时买入、买盘蓄水池与 Builder 协作激励拼成一套买方…","tier":"listed","badges":["NEW"],"scope":"exact","added":"2026-10-16","source":"nav"},
    {"name":"OwlGate","url":"https://owlgate.xyz/","category":"第三方交易所","desc":"BEM 矿机交易市场：实时价格、一键买入与扫地板价，也能对任意矿机发 WBNB 报价（走 Seaport 1.6 结算，成交前 BNB 一直留在自己钱包）。每笔成交在页面标价…","tier":"listed","badges":["NEW"],"scope":"exact","added":"2026-10-28","source":"nav"},
    {"name":"GatePilot","url":"https://tapeout.vibedegens.com/","category":"电路挖矿","desc":"TapeOut PoD 挖矿与租赁的一站式平台：生成官方题目的参考电路、在本站流片、管理主网矿机，还能把矿机挂到租赁市场按小时收租。","tier":"listed","badges":[],"scope":"exact","added":"2026-09-13","source":"nav"},
    {"name":"TapeOut Build","url":"https://tapeout.build/","category":"电路挖矿","desc":"流片前先算一遍：拖拽搭电路、跑仿真，预估能拿多少算力分、用掉多少门，并支持导出 BLIF。","tier":"listed","badges":[],"scope":"exact","added":"2026-09-13","source":"nav"},
    {"name":"Circuit Verifier","url":"https://tapeout.pro/verifier","category":"电路挖矿","desc":"把已流片的电路与它的链上参考实现在全部可能输入上逐一对拍，而不是只抽样协议那 256 组固定向量；一旦不一致，直接给出能复现差异的那个输入。","tier":"listed","badges":[],"scope":"exact","added":"2026-09-13","source":"nav"},
    {"name":"TapeLens","url":"https://tapelens.xyz/","category":"电路挖矿","desc":"配机工作台：从预算反推矿机配置——在 TapeOut 与 Behemoth 处理器之间比较成本、组合与产出，生成预算内可执行的配置，给出基础权重与榜首加成的估算，材料参考含市…","tier":"listed","badges":["NEW"],"scope":"exact","added":"2026-09-22","source":"nav"},
    {"name":"TapeFoundry","url":"https://tapefoundry.xyz/pod","category":"电路挖矿","desc":"TapeFoundry 的 TF 电路矿机：同一钱包装满 3 张原创电路卡才能启动，算力按 sqrt(门数) 计，装机期间按秒累计，随时可退出。首季 15 天共 270,00…","tier":"listed","badges":["NEW"],"scope":"exact","added":"2026-10-28","source":"nav"},
    {"name":"HashPort","url":"https://hashport.ai/","category":"链上应用","desc":"把 dapp 与 DeFi 的前端也搬上 BNB Chain：钱包逐字节校验页面，被替换过的页面拿不到签名；前端与合约处于同一层，站点归属于一个电路容器 NFT，持有该 NF…","tier":"listed","badges":[],"scope":"exact","added":"2026-09-13","source":"nav"},
    {"name":"链上网站浏览器（TapeKit 内核）","url":"https://tapeout.link/tapekit/","category":"链上应用","desc":"本站自带的 DeWeb 浏览器：输入链上地址（4246.0.tape、#4246@0、tape://… 或容器地址），内核就从 BNB Chain 直接读出整个网站并在沙盒里…","tier":"listed","badges":[],"scope":"domain","added":"2026-09-18","source":"nav"},
    {"name":"小孩哥 Fab · 链上电路图","url":"https://tapeout.space/","category":"链上应用","desc":"社区自建的 TapeOut 站点地图，自称非官方服务：把 BNB 链上的每个站点当成焊在原理图上的一个模块，可拖动、可点开，按处理器与分类筛选，索引每几分钟刷新一次。还能画一…","tier":"listed","badges":[],"scope":"exact","added":"2026-09-19","source":"nav"},
    {"name":"容器工厂 One-Click Container","url":"https://id.tapeout.link/","category":"链上应用","desc":"一键生成链上TradOut容器，用最低的成本铸造，流片，开通容器。","tier":"listed","badges":["NEW"],"scope":"exact","added":"2026-09-23","source":"nav"},
    {"name":"Tape DeWEB 浏览器插件","url":"https://ex.tapeout.link/","category":"链上应用","desc":"让浏览器像开普通网页一样打开链上网站：页面文件写在区块链上，名字就是网址，输入 1.8、1.8.tape、1.2.344（X Layer）或 1.3.5（Base）即可；内容…","tier":"listed","badges":["NEW"],"scope":"exact","added":"2026-09-23","source":"nav"},
    {"name":"Halve · PT / YT 流动性层","url":"https://halve.network/","category":"链上应用","desc":"Halve 是 TapeOut 的流动性层：把已验证矿机按到期日拆成 PT（用 BNB 报价，到期销毁换回一台同算力矿机）与 YT（用 $BEM 报价，到期领走这段算力挖出的…","tier":"listed","badges":["NEW"],"scope":"exact","added":"2026-09-26","source":"nav"},
    {"name":"拼矿 BEMine","url":"https://bemine.cc.cd/","category":"链上应用","desc":"矿机共持（拼矿）平台：每台矿机拆成 100 份，单地址可从 1 份起认购甚至全包；产出先归集到池子，个人按份领取，已入账收益永久保留。新矿池等重大事项由共同持有人投票，份额与…","tier":"listed","badges":["NEW"],"scope":"exact","added":"2026-10-04","source":"nav"},
    {"name":"TapeNow","url":"https://tapenow.dev/","category":"链上应用","desc":"把做好的网站发布到链上：上传 ZIP 或构建目录，也能从 GitHub、Vercel 导入，固定文件与目标后写入 BSC、X Layer 或 Base，再逐文件读回核验，并挂…","tier":"listed","badges":["NEW"],"scope":"exact","added":"2026-10-04","source":"nav"},
    {"name":"声刻 SonicMint · 链上音乐","url":"https://music.tapeout.link/","category":"链上应用","desc":"基于 TapeOut 协议、跑在 X Layer 上的链上音乐发行平台，无服务器：音频存进 TapeOut 链上容器，免费曲目人人可听，付费曲目加密上链、用 OKB 一次买断…","tier":"listed","badges":["NEW"],"scope":"exact","added":"2026-10-06","source":"nav"},
    {"name":"tapeXO","url":"https://tapexo.app/","category":"链上应用","desc":"无需钱包的 X 抽奖工具，基于 TapeOut 协议、开奖在 X Layer：报名用 X 登录，截止后名单冻结并把哈希写入合约，再用 commit-reveal 算出随机数与…","tier":"listed","badges":["NEW","HOT"],"scope":"exact","added":"2026-10-17","source":"nav"},
    {"name":"IGNIX","url":"https://ignix.bot/","category":"链上应用","desc":"X Layer 上的公平发射平台：建池、发币与锁仓走同一条流程，页面数据读自链上而非项目自报；另带金库、农场与矿机碎片玩法。","tier":"listed","badges":["NEW"],"scope":"exact","added":"2026-10-28","source":"nav"},
    {"name":"TapeLaunch","url":"https://tapelaunch.ai/","category":"链上应用","desc":"把「网站 + 代币」一起发布的平台：用 AI 生成项目、预览后一次性发布，网站可直接调用项目代币合约（window.TAPELAUNCH_CONTRACTS 读别名地址与 A…","tier":"listed","badges":["NEW"],"scope":"exact","added":"2026-10-28","source":"nav"},
    {"name":"SnapVault","url":"https://snapvault.cc/","category":"链上应用","desc":"X Layer 上的社交相册，主打付费解锁的限时图片：创作者设定解锁价格与查看时长，图片默认不公开预览，付款后 24 小时内可打开、按首次打开计时，阅后即焚（限时展示无法阻止…","tier":"listed","badges":["NEW"],"scope":"exact","added":"2026-10-28","source":"nav"},
    {"name":"TapeAI · 电路检察官","url":"https://tapeai.net/","category":"链上应用","desc":"把 Agent 的授权边界做成电路并流片为资产：每个「检察官」电路承载身份、决策逻辑与授权范围，用于 Agent 之间的请求判定与协作。首批 8,888 个，单价 0.034…","tier":"listed","badges":["NEW"],"scope":"exact","added":"2026-10-28","source":"nav"},
    {"name":"官方Telegram · TapeOut Protocol","url":"https://t.me/TapeOutnet","category":"交流社区","desc":"TapeOut 的 Telegram 社群：公告、进展与日常讨论都聚在这里。","tier":"listed","badges":[],"scope":"exact","added":"2026-09-12","source":"nav"},
    {"name":"Telegram · TapeOut 学习群","url":"https://t.me/tapeoutstudy","category":"交流社区","desc":"偏学习交流的 Telegram 讨论群，适合新手提问、交流流片与挖矿的实操细节。","tier":"listed","badges":[],"scope":"exact","added":"2026-09-12","source":"nav"},
    {"name":"Telegram 社群英语区","url":"https://t.me/tapeouten","category":"交流社区","desc":"TapeOut 的英语区 Telegram 社群，面向英文用户交流协议进展与生态动态。","tier":"listed","badges":[],"scope":"exact","added":"2026-09-17","source":"nav"},
    {"name":"BEM Community","url":"https://www.bem.community/","category":"交流社区","desc":"独立社区门户（Mine. Build. Compute.）：围绕 BEM、Proof of Design 挖矿、电路、矿机与新生的 TapeOut 算力经济，页面自称与项目方…","tier":"listed","badges":[],"scope":"exact","added":"2026-09-13","source":"nav"},
    {"name":"Silicon Bất Tử","url":"https://giang.me/tapeout","category":"交流社区","desc":"越南语社区的交互式科普：用可点、可拖的页面解释 TapeOut Protocol 到底在做什么，可切英语与中文。","tier":"listed","badges":[],"scope":"exact","added":"2026-09-13","source":"nav"},
    {"name":"TapeOut 社区名人榜","url":"https://tapeout.best/","category":"交流社区","desc":"把贡献变成荣誉的社区榜单（自标非官方评选）：提交作品、教程、活动记录或协作交付，评审通过后按「社区贡献 60% + 社区认可 25% + 持续参与 15%」算出社区指数，按近…","tier":"listed","badges":["NEW"],"scope":"exact","added":"2026-09-23","source":"nav"},
    {"name":"炉边论坛 Lubian Forum","url":"https://forum.lubian.site/","category":"交流社区","desc":"TapeOut 流片协议的中文社区论坛（自称社区原型、非官方、测试用途）：按版块发帖，支持精华/推广筛选、全文搜索、图片视频与引用回复；钱包登录后可用 BEM 打赏与红包，另…","tier":"listed","badges":["NEW"],"scope":"exact","added":"2026-10-17","source":"nav"},
    {"name":"TapeChat","url":"https://chat.tapeout.link/","category":"链上通讯","desc":"TapeChat（Beta）：在 TapeOut 电路容器之间传端到端加密消息，每条消息写进发送者自己的链上容器，并对照链上内容校验。需要桌面浏览器加钱包插件。","tier":"listed","badges":[],"scope":"exact","added":"2026-09-21","source":"nav"},
    {"name":"DeQQ","url":"https://deqq.pages.dev/","category":"链上通讯","desc":"DeQQ V0.1.0：独立的 TapeSend 客户端，用容器地址互加好友、收发即时消息——钱包确认身份，容器接收消息。支持 BNB、X Layer 与 Base 三条链，…","tier":"listed","badges":[],"scope":"exact","added":"2026-09-21","source":"nav"},
    {"name":"黑神话巨兽","url":"https://tapeoutscan.io/games/black-myth-tapeout/","category":"电路链游","desc":"动作游戏，Boss 的决策大脑由 7 片 TapeOut 电路组成——电路负责「出什么招」，动画与伤害由浏览器执行，战斗中能实时看到网表求值。游客可直接游玩。","tier":"listed","badges":[],"scope":"exact","added":"2026-09-12","source":"nav"},
    {"name":"弈芯 · 电路五子棋","url":"https://tapeoutscan.io/games/gomoku/","category":"电路链游","desc":"15×15 五子棋，对手是真实的 Behemoth #2121（56 NAND · 6 位比较）。落子后信号会穿过网表，每个节点对应真实引脚或 NAND 门。","tier":"listed","badges":[],"scope":"exact","added":"2026-09-12","source":"nav"},
    {"name":"摸鱼达人：太炮","url":"https://burnbem.ai/","category":"电路链游","desc":"把「摸鱼」做成模拟盘的链上小游戏：选四档底薪（0.1 / 0.4 / 1.6 / 6.4 BEM）挑一间办公室躲起来，黄仁勋会推开一扇有人的门——没被抓的人分奖金，被抓的去矿…","tier":"listed","badges":[],"scope":"exact","added":"2026-09-12","source":"nav"},
    {"name":"芯火夺宝","url":"https://tapeout.cc.cd/","category":"电路链游","desc":"用 $BEM 参与的链上号码竞猜：5 / 10 / 50 BEM 三档场次各 10,000 份，自选或随机挑号，售出 9,500 份即封盘；开奖先验签 drand 随机数，再…","tier":"listed","badges":[],"scope":"exact","added":"2026-09-12","source":"nav"},
    {"name":"余烬世界 EMBERWORLD","url":"https://1-2-300.tapeoutscan.io/","category":"电路链游","desc":"正在构建中的 2.5D 冒险世界：以电路协作为核心玩法，配合 EmberWorld Pass 推进探索进度。","tier":"listed","badges":["NEW"],"scope":"exact","added":"2026-10-28","source":"nav"},
    {"name":"Linux on BNB Chain","url":"https://tapeout.net/linux.html","category":"链上智能","desc":"第一次在 L1 主网上跑 Linux：kernel.org 主线 6.5.12 的每条 RISC-V 指令都由 BNB Chain 交易真实执行，32 个寄存器、全部 CSR…","tier":"listed","badges":[],"scope":"domain","added":"2026-09-12","source":"nav"},
    {"name":"21 NAND Driver","url":"https://jogjohgoeg.github.io/nand-driver/","category":"链上智能","desc":"一辆只靠 21 个 NAND 门开车的车：网络链下训练后降级成 21 个 NAND，流片为链上电路 #279，赛道每辆车都由各自的链上网表驾驶。可单步看门信号，也能花 BEM…","tier":"listed","badges":[],"scope":"exact","added":"2026-09-12","source":"nav"},
    {"name":"Microduck · 逻辑门大脑","url":"https://jogjohgoeg.github.io/nand-driver/duck/brain.html","category":"链上智能","desc":"一只有逻辑门大脑的鸭子：电路 #281 用 39 个 NAND 门负责转向，可组合 #282 记住转向。能把专家策略和电路大脑放在同一场地对比跑，并逐帧查看 39 个门的通断。","tier":"listed","badges":[],"scope":"exact","added":"2026-09-12","source":"nav"},
    {"name":"LoomEscape · 果蝇反射电路","url":"https://brucelanlan.github.io/c3s-reflex-circuits/sim/#handheld","category":"链上智能","desc":"把果蝇的逃逸反射编译成 173 个 NAND 门加 6 个锁存器，逃逸核心的固件编译成 WebAssembly 在浏览器里跑：可像掌机一样按菜单操作、逐门看信号通断，也能切到…","tier":"listed","badges":[],"scope":"exact","added":"2026-09-17","source":"nav"},
    {"name":"Perpetua","url":"https://h805846716.github.io/perpetua/","category":"链上智能","desc":"把康威生命游戏 16×16 环形网格编成电路 #2：14,592 个与非门（合约 0x4a93…e512），每一代演化都在链上网表上求值，页面直接推到浏览器里看。","tier":"listed","badges":[],"scope":"exact","added":"2026-09-13","source":"nav"},
    {"name":"BEM Clock","url":"https://fashen002.github.io/bem-clock/","category":"链上智能","desc":"门级实现的七段数码管数字时钟：2,165 个门、2 路输入、42 路输出、24 个状态位，在浏览器里逐门仿真走时。","tier":"listed","badges":[],"scope":"exact","added":"2026-09-13","source":"nav"},
    {"name":"TapeOutTank","url":"https://tapeouttank.vercel.app/","category":"链上智能","desc":"链上存芯片、链外跑坦克的技术实验：同一辆坦克换上不同的电路大脑——Atlas（1,836 个 NAND 门）、Swift（1,319 个）与保留果蝇连接结构的 Fly · 1…","tier":"listed","badges":[],"scope":"exact","added":"2026-09-16","source":"nav"},
    {"name":"零号 Zero · 链上 AI agent","url":"https://tapezero.xyz/","category":"链上智能","desc":"替你在币圈干活的 AI agent：先查清哪个是正版，拦下仿盘，再把下单卡片交到你手上由你决定，每一步都可在链上复算。接 BSC 与 X Layer。","tier":"listed","badges":["NEW"],"scope":"exact","added":"2026-10-28","source":"nav"},
    {"name":"TapeOut.link 生态导航","url":"https://tapeout.link/","category":"清单来源","desc":"TapeOut 生态导航站本体：官方认定的收录清单即取自本站 data/sites.js。","tier":"listed","badges":[],"scope":"domain","added":"","source":"nav"},
  ];

  // web.tapeout.link 扫描索引到的链上容器（官方网关精确子域）；同属导航认可，标记层级不同。
  var DEWEB_SITES = [
    {"name":"BEMD · 快速容器钱包","url":"https://1-2-210.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.210.tape","chain":"xlayer","source":"deweb"},
    {"name":"1.217.tape","url":"https://1-2-217.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.217.tape","chain":"xlayer","source":"deweb"},
    {"name":"Neon Reliquary · Nandverse","url":"https://1-2-231.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.231.tape","chain":"xlayer","source":"deweb"},
    {"name":"SkillPass Control Room","url":"https://1-2-223.tapekit.org/","category":"链上容器 · XLayer","desc":"SkillPass Agent Skill 许可证与商业路由控制台","tier":"deweb","badges":[],"scope":"exact","tape":"1.223.tape","chain":"xlayer","source":"deweb"},
    {"name":"IMOO","url":"https://3-2-223.tapekit.org/","category":"链上容器 · XLayer","desc":"IMOO community meme site: Ignix hid a cow. Now it","tier":"deweb","badges":[],"scope":"exact","tape":"3.223.tape","chain":"xlayer","source":"deweb"},
    {"name":"TapeID · X Layer","url":"https://1-2-245.tapekit.org/","category":"链上容器 · XLayer","desc":"把你在 X Layer 上流片的 TapeOut 电路，一键在 IGNIX 发成币；交易税 80% 进电路容器、20%…","tier":"deweb","badges":[],"scope":"exact","tape":"1.245.tape","chain":"xlayer","source":"deweb"},
    {"name":"TapeSign · 链上公证处","url":"https://4-2-204.tapekit.org/","category":"链上容器 · XLayer","desc":"TapeSign 链上公证处 · 链上签约与内容公证","tier":"deweb","badges":[],"scope":"exact","tape":"4.204.tape","chain":"xlayer","source":"deweb"},
    {"name":"TapeNow X Layer acceptance","url":"https://12-2-231.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"12.231.tape","chain":"xlayer","source":"deweb"},
    {"name":"Nandout · served from X Layer","url":"https://1-2-230.tapekit.org/","category":"链上容器 · XLayer","desc":"Nandout: a programmable on-chain decision layer on X Layer.…","tier":"deweb","badges":[],"scope":"exact","tape":"1.230.tape","chain":"xlayer","source":"deweb"},
    {"name":"Circuit Commons · TapeOut on X Layer","url":"https://1-2-177.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.177.tape","chain":"xlayer","source":"deweb"},
    {"name":"Circuit Commons · TapeOut on X Layer","url":"https://1-2-248.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.248.tape","chain":"xlayer","source":"deweb"},
    {"name":"TapeFlow X · 1.2.247.tape","url":"https://1-2-247.tapekit.org/","category":"链上容器 · XLayer","desc":"TapeFlow X Layer 链上入口","tier":"deweb","badges":[],"scope":"exact","tape":"1.247.tape","chain":"xlayer","source":"deweb"},
    {"name":"168 · 一路发｜封了，就改不了了。","url":"https://1-2-168.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.168.tape","chain":"xlayer","source":"deweb"},
    {"name":"TapeCode-Test1","url":"https://1-2-282.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.282.tape","chain":"xlayer","source":"deweb"},
    {"name":"Covenant · a token’s tax, routed by a c…","url":"https://1-2-283.tapekit.org/","category":"链上容器 · XLayer","desc":"Your token","tier":"deweb","badges":[],"scope":"exact","tape":"1.283.tape","chain":"xlayer","source":"deweb"},
    {"name":"余烬 · EMBER","url":"https://2-2-300.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"2.300.tape","chain":"xlayer","source":"deweb"},
    {"name":"42.2.287.tape","url":"https://42-2-287.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"42.287.tape","chain":"xlayer","source":"deweb"},
    {"name":"TapeCode NFT Test","url":"https://2-2-0.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"2.0.tape","chain":"xlayer","source":"deweb"},
    {"name":"LAIKA · 纪念与探索","url":"https://1-2-314.tapekit.org/","category":"链上容器 · XLayer","desc":"LAIKA：纪念莱卡，传承勇气与探索精神。历史、理念与项目档案。","tier":"deweb","badges":[],"scope":"exact","tape":"1.314.tape","chain":"xlayer","source":"deweb"},
    {"name":"帮帮 · 互助求助平台","url":"https://275-2-265.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"275.265.tape","chain":"xlayer","source":"deweb"},
    {"name":"捕鱼达人 · BEM 争霸赛","url":"https://1-2-319.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.319.tape","chain":"xlayer","source":"deweb"},
    {"name":"Arcade Chips · 芯片街机","url":"https://1-2-304.tapekit.org/","category":"链上容器 · XLayer","desc":"Arcade Chips: pixel arcade, TapeOut payout circuit and cont…","tier":"deweb","badges":[],"scope":"exact","tape":"1.304.tape","chain":"xlayer","source":"deweb"},
    {"name":"钓鱼达人 V6.0 · 鱼饵选择与虚拟钓场","url":"https://2-2-206.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"2.206.tape","chain":"xlayer","source":"deweb"},
    {"name":"还好吗 · 让关心成为习惯","url":"https://1-2-335.tapekit.org/","category":"链上容器 · XLayer","desc":"还好吗 —— 每日签到、树洞倾诉、时光胶囊，一个温柔的关怀与数字记忆平台。","tier":"deweb","badges":[],"scope":"exact","tape":"1.335.tape","chain":"xlayer","source":"deweb"},
    {"name":"星空守卫 · 太空塔防射击","url":"https://1-2-2.tapekit.org/","category":"链上容器 · XLayer","desc":"星空守卫 · 太空塔防射击：按住屏幕瞄准自动连发，守住只有 5 格血的城市。散射、速射、修复、全屏清除四种道具，每 5…","tier":"deweb","badges":[],"scope":"exact","tape":"1.2.tape","chain":"xlayer","source":"deweb"},
    {"name":"意识永生｜把重要的思想留在链上","url":"https://1-2-336.tapekit.org/","category":"链上容器 · XLayer","desc":"从X公开表达生成你的人格芯片，并持续保存思想、知识、经历与作品。","tier":"deweb","badges":[],"scope":"exact","tape":"1.336.tape","chain":"xlayer","source":"deweb"},
    {"name":"TapeOut DeWeb 外贸企业网站生成器 V1.5.1 STABILIT…","url":"https://111-2-222.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"111.222.tape","chain":"xlayer","source":"deweb"},
    {"name":"瞄一箱 PeekBox","url":"https://1-2-339.tapekit.org/","category":"链上容器 · XLayer","desc":"瞄一箱 PeekBox：开宝箱看广告，看完揭晓，开箱抽 OKB。广告主自己定 CPS 单价，95% 进公开奖金池、5%…","tier":"deweb","badges":[],"scope":"exact","tape":"1.339.tape","chain":"xlayer","source":"deweb"},
    {"name":"余烬世界 | EMBERWORLD","url":"https://1-2-300.tapekit.org/","category":"链上容器 · XLayer","desc":"余烬世界 EMBERWORLD — 正在构建的2.5D冒险世界，探索电路协作与EmberWorld Pass。","tier":"deweb","badges":[],"scope":"exact","tape":"1.300.tape","chain":"xlayer","source":"deweb"},
    {"name":"TapeOut Copilot test","url":"https://1-2-345.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.345.tape","chain":"xlayer","source":"deweb"},
    {"name":"TapeCommerce · 数字授权商店","url":"https://1-2-346.tapekit.org/","category":"链上容器 · XLayer","desc":"TapeCommerce: digital-goods storefronts with verifiable Tap…","tier":"deweb","badges":[],"scope":"exact","tape":"1.346.tape","chain":"xlayer","source":"deweb"},
    {"name":"还好吗 · 每日签到与树洞","url":"https://1-2-355.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.355.tape","chain":"xlayer","source":"deweb"},
    {"name":"TapePack · DeWEB 链上前端压缩","url":"https://1-2-344.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.344.tape","chain":"xlayer","source":"deweb"},
    {"name":"TapeXCafé · 一杯咖啡，一点好邻里","url":"https://1-2-357.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.357.tape","chain":"xlayer","source":"deweb"},
    {"name":"修真联盟 · 道号身份","url":"https://1594-2-323.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1594.323.tape","chain":"xlayer","source":"deweb"},
    {"name":"TapeADS 企业出海-广告联盟","url":"https://5382-2-323.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"5382.323.tape","chain":"xlayer","source":"deweb"},
    {"name":"加加乐 · BEM 池子每日轮盘抽奖","url":"https://1-2-366.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.366.tape","chain":"xlayer","source":"deweb"},
    {"name":"SnapVault · 分享瞬间，靠近彼此","url":"https://10-2-6.tapekit.org/","category":"链上容器 · XLayer","desc":"发现喜欢的创作者，在私聊与群聊里分享日常、发送限时消息，体验独家图片解锁。当前为不扣款的产品预览。","tier":"deweb","badges":[],"scope":"exact","tape":"10.6.tape","chain":"xlayer","source":"deweb"},
    {"name":"便笺","url":"https://1-2-218.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.218.tape","chain":"xlayer","source":"deweb"},
    {"name":"弈 · 五子棋","url":"https://2400-2-323.tapekit.org/","category":"链上容器 · XLayer","desc":"一方棋盘，一场好局。无需登录的五子棋。","tier":"deweb","badges":[],"scope":"exact","tape":"2400.323.tape","chain":"xlayer","source":"deweb"},
    {"name":"交易！然后退休！","url":"https://152-2-265.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"152.265.tape","chain":"xlayer","source":"deweb"},
    {"name":"FabVerse 芯宇宙","url":"https://3121-2-323.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"3121.323.tape","chain":"xlayer","source":"deweb"},
    {"name":"BEM Pay · Web3 万物皆可卖","url":"https://1-2-376.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.376.tape","chain":"xlayer","source":"deweb"},
    {"name":"Tapepunk · 免费铸造","url":"https://1-2-380.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.380.tape","chain":"xlayer","source":"deweb"},
    {"name":"Tapepunk · 0.01 OKB 铸造","url":"https://1-2-381.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.381.tape","chain":"xlayer","source":"deweb"},
    {"name":"领水 · BEM / FAB（X Layer）","url":"https://90-2-323.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"90.323.tape","chain":"xlayer","source":"deweb"},
    {"name":"DegenDNA | Play · Mental Lab · Reset","url":"https://4-2-101.tapekit.org/","category":"链上容器 · XLayer","desc":"DegenDNA Mental Lab is an original, non-diagnostic self-che…","tier":"deweb","badges":[],"scope":"exact","tape":"4.101.tape","chain":"xlayer","source":"deweb"},
    {"name":"Fab X · TapeOut 算力看板","url":"https://745-2-323.tapekit.org/","category":"链上容器 · XLayer","desc":"TapeOut Proof-of-Design 挖矿公开看板：全网算力、算力排行、题目名额、大户成本与市场。","tier":"deweb","badges":[],"scope":"exact","tape":"745.323.tape","chain":"xlayer","source":"deweb"},
    {"name":"Cargo","url":"https://1-2-387.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.387.tape","chain":"xlayer","source":"deweb"},
    {"name":"EmberWorld Pass · Mint Test","url":"https://150-2-323.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"150.323.tape","chain":"xlayer","source":"deweb"},
    {"name":"Lino的奇幻漂流 · Lino的个人直播台","url":"https://1-2-391.tapekit.org/","category":"链上容器 · XLayer","desc":"Lino的奇幻漂流，Lino的个人直播台。在这里看直播、聊想法，体验像素应援与创作实验。","tier":"deweb","badges":[],"scope":"exact","tape":"1.391.tape","chain":"xlayer","source":"deweb"},
    {"name":"How-To-Pi · How-To-Pi","url":"https://10-2-4.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"10.4.tape","chain":"xlayer","source":"deweb"},
    {"name":"BEM-DRAW · 链上抽奖","url":"https://2-2-168.tapekit.org/","category":"链上容器 · XLayer","desc":"0.1 BEM 抽矿机和 iPhone。开奖用 TapeOut 电路判号，结果谁都改不了。","tier":"deweb","badges":[],"scope":"exact","tape":"2.168.tape","chain":"xlayer","source":"deweb"},
    {"name":"Fizzl on X Layer: x402 endpoints, check…","url":"https://1-2-396.tapekit.org/","category":"链上容器 · XLayer","desc":"1,067 x402 endpoints accept payment on X Layer. Fizzl check…","tier":"deweb","badges":[],"scope":"exact","tape":"1.396.tape","chain":"xlayer","source":"deweb"},
    {"name":"TOPEOUT WORLD · 从一座岛，创造一个世界","url":"https://7-2-260.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"7.260.tape","chain":"xlayer","source":"deweb"},
    {"name":"TapeExit · Independent Exit","url":"https://2-2-289.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"2.289.tape","chain":"xlayer","source":"deweb"},
    {"name":"海豚Radar · 双链安全雷达","url":"https://11-2-4.tapekit.org/","category":"链上容器 · XLayer","desc":"TapeOut 生态安全警报系统——图谱是底层结构，广播是产品形态。海豚Radar 运行于 X Layer DeWEB…","tier":"deweb","badges":[],"scope":"exact","tape":"11.4.tape","chain":"xlayer","source":"deweb"},
    {"name":"TapeDeck 配置","url":"https://1-2-333.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.333.tape","chain":"xlayer","source":"deweb"},
    {"name":"Rug Checker · X Layer token safety scan…","url":"https://1-2-398.tapekit.org/","category":"链上容器 · XLayer","desc":"Paste a token contract, get a transparent 0–100 safety scor…","tier":"deweb","badges":[],"scope":"exact","tape":"1.398.tape","chain":"xlayer","source":"deweb"},
    {"name":"数字进化 · 在线对战","url":"https://1-2-401.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.401.tape","chain":"xlayer","source":"deweb"},
    {"name":"IGNIX Test — X Layer 发射预检","url":"https://1-2-402.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.402.tape","chain":"xlayer","source":"deweb"},
    {"name":"A股短线雷达 · 尾盘选股","url":"https://1-2-403.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.403.tape","chain":"xlayer","source":"deweb"},
    {"name":"红包矿场 Hongbao Mine · X Layer","url":"https://1-2-405.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.405.tape","chain":"xlayer","source":"deweb"},
    {"name":"南天门 · 海南热带果园度假村","url":"https://1-2-406.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.406.tape","chain":"xlayer","source":"deweb"},
    {"name":"K线猜涨跌 · 60 根日K盲猜","url":"https://1-2-407.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.407.tape","chain":"xlayer","source":"deweb"},
    {"name":"基于 TapeOut 协议的 DeWeb 安全链上应用","url":"https://2-2-333.tapekit.org/","category":"链上容器 · XLayer","desc":"链上应用：用钱包封存一段话，任何人都能核对是哪个钱包、什么时候写的。","tier":"deweb","badges":[],"scope":"exact","tape":"2.333.tape","chain":"xlayer","source":"deweb"},
    {"name":"TapeReel","url":"https://1-2-410.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.410.tape","chain":"xlayer","source":"deweb"},
    {"name":"$HEIST — 戴墨镜的浣熊劫匪｜X Layer","url":"https://2-2-402.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"2.402.tape","chain":"xlayer","source":"deweb"},
    {"name":"DeWEB 桌面 · TAPE://","url":"https://1-2-399.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.399.tape","chain":"xlayer","source":"deweb"},
    {"name":"SafeRouter Receipt Desk","url":"https://2-2-409.tapekit.org/","category":"链上容器 · XLayer","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"2.409.tape","chain":"xlayer","source":"deweb"},
    {"name":"ProofDrop · Draw #1 · First Silicon","url":"https://1-2-413.tapekit.org/","category":"链上容器 · XLayer","desc":"A self-contained proof of the first ProofDrop draw through …","tier":"deweb","badges":[],"scope":"exact","tape":"1.413.tape","chain":"xlayer","source":"deweb"},
    {"name":"Tapekit — 链上网站的开源浏览器内核","url":"https://4246-0.tapekit.org/","category":"链上容器 · BNB 主网","desc":"Tapekit：TapeOut 协议的开源浏览器内核。网站的每一个字节都存在 BNB 链上，内核直接读链、逐字节校验、…","tier":"deweb","badges":[],"scope":"exact","tape":"4246.0.tape","chain":"bsc","source":"deweb"},
    {"name":"UPay - TapeOut Card","url":"https://1-231.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.231.tape","chain":"bsc","source":"deweb"},
    {"name":"Tapekit — 链上网站的开源浏览器内核","url":"https://157-1.tapekit.org/","category":"链上容器 · BNB 主网","desc":"Tapekit：TapeOut 协议的开源浏览器内核。网站的每一个字节都存在 BNB 链上，内核直接读链、逐字节校验、…","tier":"deweb","badges":[],"scope":"exact","tape":"157.1.tape","chain":"bsc","source":"deweb"},
    {"name":"Circuit 283","url":"https://282-732.tapekit.org/","category":"链上容器 · BNB 主网","desc":"Agents API harness control loop burned as TapeOut circuit #…","tier":"deweb","badges":[],"scope":"exact","tape":"282.732.tape","chain":"bsc","source":"deweb"},
    {"name":"TAPE STRIKE · 清除芯片里的 Bug","url":"https://1-894.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.894.tape","chain":"bsc","source":"deweb"},
    {"name":"BEM · 抵押借贷","url":"https://979-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"979.30.tape","chain":"bsc","source":"deweb"},
    {"name":"TapePilot.ai — TapeHub guide","url":"https://9481-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"Guide and library for TapeHub listings. Size on Pilot. Fact…","tier":"deweb","badges":[],"scope":"exact","tape":"9481.30.tape","chain":"bsc","source":"deweb"},
    {"name":"躺平大师 · TP 流片铸卡","url":"https://1-899.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.899.tape","chain":"bsc","source":"deweb"},
    {"name":"RAIDEN 雷电","url":"https://5182-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"5182.30.tape","chain":"bsc","source":"deweb"},
    {"name":"预测盘 · 2.894.tape","url":"https://2-894.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"2.894.tape","chain":"bsc","source":"deweb"},
    {"name":"BURNBEM · DeWeb 游戏厅（效果稿）","url":"https://1688-0.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1688.0.tape","chain":"bsc","source":"deweb"},
    {"name":"Tapestar — 预算进入算力的最优路径","url":"https://12566-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"Tapestar：基于 TapeOut 的非托管挖矿配置与执行层。","tier":"deweb","badges":[],"scope":"exact","tape":"12566.30.tape","chain":"bsc","source":"deweb"},
    {"name":"TapeOut Fun","url":"https://4451-0.tapekit.org/","category":"链上容器 · BNB 主网","desc":"TapeOut Fun is a BSC-native token launchpad.","tier":"deweb","badges":[],"scope":"exact","tape":"4451.0.tape","chain":"bsc","source":"deweb"},
    {"name":"TapeOut Cards","url":"https://3434-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"连接钱包，把你的 TapeOut 电路变成卡牌，领取上链。卡面完全由链上网表确定性生成。","tier":"deweb","badges":[],"scope":"exact","tape":"3434.30.tape","chain":"bsc","source":"deweb"},
    {"name":"Genesis CPU #433","url":"https://433-0.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"433.0.tape","chain":"bsc","source":"deweb"},
    {"name":"黑神话巨兽 · Black Myth: Behemoth","url":"https://12123-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"挥棍破阵，闪身蓄势。操作悟空挑战牛来与牛妈，包含新手教学和单人训练。","tier":"deweb","badges":[],"scope":"exact","tape":"12123.30.tape","chain":"bsc","source":"deweb"},
    {"name":"无名探索＋","url":"https://1520-0.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1520.0.tape","chain":"bsc","source":"deweb"},
    {"name":"GatePilot · TapeOut PoD 挖矿·租赁一站式平台","url":"https://1-165.tapekit.org/","category":"链上容器 · BNB 主网","desc":"GatePilot — TapeOut PoD 挖矿·租赁一站式平台：生成官方题目参考电路、本站流片、管理主网矿机，还…","tier":"deweb","badges":[],"scope":"exact","tape":"1.165.tape","chain":"bsc","source":"deweb"},
    {"name":"启动雷达 RADX.TOP · 多交易所潜力币扫描器","url":"https://14031-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"启动雷达 RADX.TOP：按币安 / Gate.io / OKX 的月线横盘吸筹、周线结构转好、日线刚启动、量比放大…","tier":"deweb","badges":[],"scope":"exact","tape":"14031.30.tape","chain":"bsc","source":"deweb"},
    {"name":"TapeOut On-Chain Chat","url":"https://4357-0.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"4357.0.tape","chain":"bsc","source":"deweb"},
    {"name":"TAPQQ","url":"https://1-888.tapekit.org/","category":"链上容器 · BNB 主网","desc":"TAPQQ — 经典窗体风格的 TapeSend DeWEB 消息 DApp","tier":"deweb","badges":[],"scope":"exact","tape":"1.888.tape","chain":"bsc","source":"deweb"},
    {"name":"Joshua — mmlink.me","url":"https://4339-0.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"4339.0.tape","chain":"bsc","source":"deweb"},
    {"name":"TapeOut to the Moon","url":"https://1340-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1340.30.tape","chain":"bsc","source":"deweb"},
    {"name":"gradfi · fair-launch mining protocol on…","url":"https://3114-0.tapekit.org/","category":"链上容器 · BNB 主网","desc":"gradfi is a fair-launch mining protocol on bsc. trade grad,…","tier":"deweb","badges":[],"scope":"exact","tape":"3114.0.tape","chain":"bsc","source":"deweb"},
    {"name":"复利收益计算器 · Compound Interest Calculator","url":"https://12-10.tapekit.org/","category":"链上容器 · BNB 主网","desc":"纯前端复利收益计算器：调节本金、年化收益率与投资年限，实时查看复利增长曲线。","tier":"deweb","badges":[],"scope":"exact","tape":"12.10.tape","chain":"bsc","source":"deweb"},
    {"name":"TapeSite｜一句话 AI 建站，永久部署到 DeWEB","url":"https://14599-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"TapeSite 是 AI 静态网站生成工具。描述你的想法，预览并修改网站，再通过钱包部署到 DeWEB。Build …","tier":"deweb","badges":[],"scope":"exact","tape":"14599.30.tape","chain":"bsc","source":"deweb"},
    {"name":"小林 · 独立设计师","url":"https://1108-1.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1108.1.tape","chain":"bsc","source":"deweb"},
    {"name":"TapeSite｜一句话 AI 建站，永久部署到 DeWEB","url":"https://15731-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"不用写代码，不用服务器。AI 生成后，一键部署到 DeWEB。","tier":"deweb","badges":[],"scope":"exact","tape":"15731.30.tape","chain":"bsc","source":"deweb"},
    {"name":"TapeFlow · BEM 支付","url":"https://3057-0.tapekit.org/","category":"链上容器 · BNB 主网","desc":"TapeFlow 让价值在 Tape 生态中流动，支持 BEM 转账、TapeOut 容器收款、红包、加密订单和一次性…","tier":"deweb","badges":[],"scope":"exact","tape":"3057.0.tape","chain":"bsc","source":"deweb"},
    {"name":"wNAND · Wrapped TapeOut NAND","url":"https://15821-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"Minimal interface for wrapping legacy TapeOut NAND into wNA…","tier":"deweb","badges":[],"scope":"exact","tape":"15821.30.tape","chain":"bsc","source":"deweb"},
    {"name":"15016.30.tape","url":"https://15016-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"15016.30.tape","chain":"bsc","source":"deweb"},
    {"name":"NEON CITADEL — The Last Light","url":"https://40-865.tapekit.org/","category":"链上容器 · BNB 主网","desc":"NEON CITADEL: a standalone, offline, native WebGL 2 tactica…","tier":"deweb","badges":[],"scope":"exact","tape":"40.865.tape","chain":"bsc","source":"deweb"},
    {"name":"喵喵德州俱乐部 · 大厅","url":"https://1-1031.tapekit.org/","category":"链上容器 · BNB 主网","desc":"喵喵德州俱乐部：和真人一起打德州扑克，用 BEM 或免费积分，没有庄家，全桌一起洗牌，每手打完公开底牌。Meow Ho…","tier":"deweb","badges":[],"scope":"exact","tape":"1.1031.tape","chain":"bsc","source":"deweb"},
    {"name":"牛油果小镇 · 一起抱抱牛油果","url":"https://1-1032.tapekit.org/","category":"链上容器 · BNB 主网","desc":"牛油果小镇 —— 一颗大大的、温柔的牛油果，和喜欢它的孩子们。","tier":"deweb","badges":[],"scope":"exact","tape":"1.1032.tape","chain":"bsc","source":"deweb"},
    {"name":"这一页存放在链上：BNB Smart Chain 的 #41 容器里","url":"https://41-865.tapekit.org/","category":"链上容器 · BNB 主网","desc":"DeWEB MCP 演练网的链上副本：页面字节按 (容器, 路径) 写在 BNB Smart Chain 的 Site…","tier":"deweb","badges":[],"scope":"exact","tape":"41.865.tape","chain":"bsc","source":"deweb"},
    {"name":"TapeMX","url":"https://3-687.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"3.687.tape","chain":"bsc","source":"deweb"},
    {"name":"链上中国象棋 · 122.6.tape","url":"https://122-6.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"122.6.tape","chain":"bsc","source":"deweb"},
    {"name":"TapeOut One-Click Container","url":"https://1-8.tapekit.org/","category":"链上容器 · BNB 主网","desc":"一键开通 TapeOut 容器：自动烧晶体管、流片成电路板、开通 ERC-6551 账户，三步得到形如 2.32 的容…","tier":"deweb","badges":[],"scope":"exact","tape":"1.8.tape","chain":"bsc","source":"deweb"},
    {"name":"8.888 · 靓号商城","url":"https://8-888.tapekit.org/","category":"链上容器 · BNB 主网","desc":"浏览并购买 TapeOut 电路靓号与 .BEM 域名 ERC721。","tier":"deweb","badges":[],"scope":"exact","tape":"8.888.tape","chain":"bsc","source":"deweb"},
    {"name":"营造 · 在五台山下盖一座唐代大殿","url":"https://3-894.tapekit.org/","category":"链上容器 · BNB 主网","desc":"营造：在五台山下亲手盖一座唐代木构大殿。规矩对了它立住，错了它当场塌掉。Build a Tang‑dynasty ti…","tier":"deweb","badges":[],"scope":"exact","tape":"3.894.tape","chain":"bsc","source":"deweb"},
    {"name":"01协议官网 - 用0和1组建出矿机","url":"https://1-1011.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.1011.tape","chain":"bsc","source":"deweb"},
    {"name":"BEM 销毁看板 · BSC","url":"https://16267-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"BNB Smart Chain 上 BEM 代币黑洞销毁数量，数据直接读取链上合约。","tier":"deweb","badges":[],"scope":"exact","tape":"16267.30.tape","chain":"bsc","source":"deweb"},
    {"name":"喵喵彩票","url":"https://2-1031.tapekit.org/","category":"链上容器 · BNB 主网","desc":"喵喵彩票：用 BEM 买注（每期每人最多 100 注），每 30 分钟、每天、每月 1 号各开一期，每期开出一注，奖池…","tier":"deweb","badges":[],"scope":"exact","tape":"2.1031.tape","chain":"bsc","source":"deweb"},
    {"name":"BITMAP Runtime V0.2.2","url":"https://335-0.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"335.0.tape","chain":"bsc","source":"deweb"},
    {"name":"小孩哥 · 电路远征 99 | V0.0.3","url":"https://16-68.tapekit.org/","category":"链上容器 · BNB 主网","desc":"小孩哥·电路远征：TapeOut生态元素原创横版闯关游戏，9大主题、99关、9位Boss。","tier":"deweb","badges":[],"scope":"exact","tape":"16.68.tape","chain":"bsc","source":"deweb"},
    {"name":"C Kingdom","url":"https://10341-0.tapekit.org/","category":"链上容器 · BNB 主网","desc":"Design a kingdom from pure NAND logic. Trade or raid for 20…","tier":"deweb","badges":[],"scope":"exact","tape":"10341.0.tape","chain":"bsc","source":"deweb"},
    {"name":"Blocivo · 晶体管交易","url":"https://10354-0.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"10354.0.tape","chain":"bsc","source":"deweb"},
    {"name":"BEM 消消乐 · 链上矩阵 | V0.0.5","url":"https://4-446.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"4.446.tape","chain":"bsc","source":"deweb"},
    {"name":"體素三國 — Voxel Three Kingdoms","url":"https://16-165.tapekit.org/","category":"链上容器 · BNB 主网","desc":"浏览器即玩的体素三国割草动作游戏：赵云、关羽、张飞、诸葛亮、吕布，各有招式与无双；长坂坡、虎牢关、赤壁三处战场，一人独…","tier":"deweb","badges":[],"scope":"exact","tape":"16.165.tape","chain":"bsc","source":"deweb"},
    {"name":"TapeOut 社区留言板｜TapeOut Daily","url":"https://3-888.tapekit.org/","category":"链上容器 · BNB 主网","desc":"分享 TapeOut 进展、问题和容器地址。匿名即可留言。","tier":"deweb","badges":[],"scope":"exact","tape":"3.888.tape","chain":"bsc","source":"deweb"},
    {"name":"迷因麻將 | Meme Mahjong","url":"https://188-1.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"188.1.tape","chain":"bsc","source":"deweb"},
    {"name":"TapeNow BSC acceptance","url":"https://42-865.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"42.865.tape","chain":"bsc","source":"deweb"},
    {"name":"五子棋 · Gomoku","url":"https://15324-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"15324.30.tape","chain":"bsc","source":"deweb"},
    {"name":"身份验证器","url":"https://288-732.tapekit.org/","category":"链上容器 · BNB 主网","desc":"两步验证码生成器，兼容 Google Authenticator 的二维码与转移格式。帐号保存在本机，可用通行密钥加密…","tier":"deweb","badges":[],"scope":"exact","tape":"288.732.tape","chain":"bsc","source":"deweb"},
    {"name":"Blonskr Fans | Works","url":"https://4453-0.tapekit.org/","category":"链上容器 · BNB 主网","desc":"Blonskr Fans documents his publicly released protocols, pro…","tier":"deweb","badges":[],"scope":"exact","tape":"4453.0.tape","chain":"bsc","source":"deweb"},
    {"name":"元站车载联锁 · Yuan Station","url":"https://11347-0.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"11347.0.tape","chain":"bsc","source":"deweb"},
    {"name":"跟 AI 对赌美股 · Blonberg","url":"https://16312-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"16312.30.tape","chain":"bsc","source":"deweb"},
    {"name":"红色警戒：大乱斗","url":"https://12-40.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"12.40.tape","chain":"bsc","source":"deweb"},
    {"name":"TapeFix 电路维修工 · v3.6.6","url":"https://1047-6.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1047.6.tape","chain":"bsc","source":"deweb"},
    {"name":"TapeVault · 链上加密保险箱","url":"https://4454-0.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"4454.0.tape","chain":"bsc","source":"deweb"},
    {"name":"Tape Defense","url":"https://3-1031.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"3.1031.tape","chain":"bsc","source":"deweb"},
    {"name":"TAPELIQUID","url":"https://11636-0.tapekit.org/","category":"链上容器 · BNB 主网","desc":"TAPELIQUID. BEM spot and a shared perpetual. Connect a wall…","tier":"deweb","badges":[],"scope":"exact","tape":"11636.0.tape","chain":"bsc","source":"deweb"},
    {"name":"TapeWork · 全链上应用体验众测","url":"https://6086-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"TapeWork：基于链上完成证明的应用体验众测。","tier":"deweb","badges":[],"scope":"exact","tape":"6086.30.tape","chain":"bsc","source":"deweb"},
    {"name":"TapeAcquire · Onchain application marke…","url":"https://190-8.tapekit.org/","category":"链上容器 · BNB 主网","desc":"Evidence-first discovery and acquisition for TapeOut applic…","tier":"deweb","badges":[],"scope":"exact","tape":"190.8.tape","chain":"bsc","source":"deweb"},
    {"name":"bewithyou.vip · AI伴学 —— 1.5 $BEM/年，让孩子爱…","url":"https://10-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"10.30.tape","chain":"bsc","source":"deweb"},
    {"name":"LightCPU","url":"https://2-1178.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"2.1178.tape","chain":"bsc","source":"deweb"},
    {"name":".BEM Domains","url":"https://123-888.tapekit.org/","category":"链上容器 · BNB 主网","desc":"Register .bem names on BNB Chain","tier":"deweb","badges":[],"scope":"exact","tape":"123.888.tape","chain":"bsc","source":"deweb"},
    {"name":"海南水果盲盒 · $BEM 支付","url":"https://1-1200.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.1200.tape","chain":"bsc","source":"deweb"},
    {"name":"FeePerk｜币安注册与使用指南","url":"https://1-500.tapekit.org/","category":"链上容器 · BNB 主网","desc":"a0","tier":"deweb","badges":[],"scope":"exact","tape":"1.500.tape","chain":"bsc","source":"deweb"},
    {"name":"Hyper Mobile · 交易终端","url":"https://466-1.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"466.1.tape","chain":"bsc","source":"deweb"},
    {"name":"WeTape · 吞噬WEB2，从微信开始。","url":"https://787-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"787.30.tape","chain":"bsc","source":"deweb"},
    {"name":"TapeHall 游戏厅 | TapeOut 链上游戏厅 v3","url":"https://13877-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"13877.30.tape","chain":"bsc","source":"deweb"},
    {"name":"比特币采访图片","url":"https://1688-1188.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1688.1188.tape","chain":"bsc","source":"deweb"},
    {"name":"炉边论坛 · Lubian Forum","url":"https://15657-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"炉边论坛 — TapeOut 流片协议中文社区。发帖互动在服务器，本页为链上门面。","tier":"deweb","badges":[],"scope":"exact","tape":"15657.30.tape","chain":"bsc","source":"deweb"},
    {"name":"福猫 FOMO · 一人一枚，免费领，链上开奖","url":"https://1-1205.tapekit.org/","category":"链上容器 · BNB 主网","desc":"福猫 FOMO：免费领取、每个地址只能领 1 枚、领取后由未来区块哈希开奖，总量 10000 枚，领完绝版。","tier":"deweb","badges":[],"scope":"exact","tape":"1.1205.tape","chain":"bsc","source":"deweb"},
    {"name":"BEM 进击吧 - 10人成团链上夺宝","url":"https://99-1.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"99.1.tape","chain":"bsc","source":"deweb"},
    {"name":"TAPE 每日签到","url":"https://1-1207.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.1207.tape","chain":"bsc","source":"deweb"},
    {"name":"BeneAll (BALL) · 免费领取","url":"https://15-2.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"15.2.tape","chain":"bsc","source":"deweb"},
    {"name":"Tapecode (TPC) · 领取","url":"https://1-1208.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.1208.tape","chain":"bsc","source":"deweb"},
    {"name":"人选·天选 · 投资情绪自测","url":"https://892-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"892.30.tape","chain":"bsc","source":"deweb"},
    {"name":"辉光管时钟 · Nixie Clock — 把时间，留在温暖的辉光里","url":"https://1413-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1413.30.tape","chain":"bsc","source":"deweb"},
    {"name":"Ape Genesis · 1000 只链上猿猴","url":"https://1-1215.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.1215.tape","chain":"bsc","source":"deweb"},
    {"name":"征服者对战平台","url":"https://11644-0.tapekit.org/","category":"链上容器 · BNB 主网","desc":"征服者对战平台，为经典即时战略玩家提供便捷稳定的联机对战体验。","tier":"deweb","badges":[],"scope":"exact","tape":"11644.0.tape","chain":"bsc","source":"deweb"},
    {"name":"霓虹弹珠台","url":"https://1-1216.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.1216.tape","chain":"bsc","source":"deweb"},
    {"name":"TapeBrowser 配置","url":"https://1-1196.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.1196.tape","chain":"bsc","source":"deweb"},
    {"name":"BatchPay · EVM 批量转账控制台（原生代币 / ERC-20）","url":"https://1-1217.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.1217.tape","chain":"bsc","source":"deweb"},
    {"name":"51 共建平台","url":"https://11111-0.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"11111.0.tape","chain":"bsc","source":"deweb"},
    {"name":"玄机 XuanJi · 链上占卜推演平台","url":"https://117-3.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"117.3.tape","chain":"bsc","source":"deweb"},
    {"name":"健康第一 Health First · 精准营养与慢病管理","url":"https://1-1218.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.1218.tape","chain":"bsc","source":"deweb"},
    {"name":"BEM 幸运老虎机","url":"https://11168-0.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"11168.0.tape","chain":"bsc","source":"deweb"},
    {"name":"意识永生 MindEver｜让你的思想，在时间之外继续生长","url":"https://189-8.tapekit.org/","category":"链上容器 · BNB 主网","desc":"从一次公开表达开始，建立由你掌控、持续生长、可以传承的数字人格档案。身份、版本与归属由链上永久验证，内容通过 DeWE…","tier":"deweb","badges":[],"scope":"exact","tape":"189.8.tape","chain":"bsc","source":"deweb"},
    {"name":"QQ农场 · 偷菜","url":"https://11647-0.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"11647.0.tape","chain":"bsc","source":"deweb"},
    {"name":"Twitter/X 自动发帖助手 | Tapeout社区开发","url":"https://777-1.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"777.1.tape","chain":"bsc","source":"deweb"},
    {"name":"TAPEOUT 大家庭 · 成员名录","url":"https://180-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"180.30.tape","chain":"bsc","source":"deweb"},
    {"name":"TapeCharity","url":"https://1-1236.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.1236.tape","chain":"bsc","source":"deweb"},
    {"name":"BEM Leverage Meme 发射平台","url":"https://11646-0.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"11646.0.tape","chain":"bsc","source":"deweb"},
    {"name":"BB牛 · 链上三消","url":"https://1-1238.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.1238.tape","chain":"bsc","source":"deweb"},
    {"name":"5772.30 · 公开摘要登记","url":"https://5772-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"5772.30.tape","chain":"bsc","source":"deweb"},
    {"name":"TapeCharity","url":"https://5584-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"5584.30.tape","chain":"bsc","source":"deweb"},
    {"name":"AI订阅雷达 · 订阅比价与费用助手","url":"https://1-1241.tapekit.org/","category":"链上容器 · BNB 主网","desc":"AI订阅雷达 TapeOut 社区入口：查看 ChatGPT、Claude、Google AI Pro、Cursor …","tier":"deweb","badges":[],"scope":"exact","tape":"1.1241.tape","chain":"bsc","source":"deweb"},
    {"name":"TapeFun — Circuit 6/49","url":"https://1-1242.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.1242.tape","chain":"bsc","source":"deweb"},
    {"name":"蜜蜂宠物农场 · 试玩版","url":"https://1017-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1017.30.tape","chain":"bsc","source":"deweb"},
    {"name":"TSD","url":"https://1-1243.tapekit.org/","category":"链上容器 · BNB 主网","desc":"Payback estimates, mining pool and market data for TapeOut …","tier":"deweb","badges":[],"scope":"exact","tape":"1.1243.tape","chain":"bsc","source":"deweb"},
    {"name":"懿德木器工程有限公司 · 防火門 · 訂製傢俬 · 室內裝修","url":"https://1-1244.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.1244.tape","chain":"bsc","source":"deweb"},
    {"name":"TapeMX","url":"https://8081-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"8081.30.tape","chain":"bsc","source":"deweb"},
    {"name":"TapeOne · 1U only","url":"https://1037-0.tapekit.org/","category":"链上容器 · BNB 主网","desc":"TapeOne：任意两个地址之间，一次转出、一次转入，每笔固定 1U，链上封存这段关系。","tier":"deweb","badges":[],"scope":"exact","tape":"1037.0.tape","chain":"bsc","source":"deweb"},
    {"name":"TapeMonkey · 222 张公开 mint","url":"https://10100-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"10100.30.tape","chain":"bsc","source":"deweb"},
    {"name":"存疑录 · 独立思考","url":"https://7777-0.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"7777.0.tape","chain":"bsc","source":"deweb"},
    {"name":"TapeOut Life — Conway's Game of Life MVP","url":"https://1-1247.tapekit.org/","category":"链上容器 · BNB 主网","desc":"TapeOut Life: an experimental browser MVP. Build 8x8 cellul…","tier":"deweb","badges":[],"scope":"exact","tape":"1.1247.tape","chain":"bsc","source":"deweb"},
    {"name":"Salary - BEM 奖励计划","url":"https://12410-0.tapekit.org/","category":"链上容器 · BNB 主网","desc":"Salary - BEM 奖励计划，绑定欧易、币安邀请码即可获得 BEM 代币奖励","tier":"deweb","badges":[],"scope":"exact","tape":"12410.0.tape","chain":"bsc","source":"deweb"},
    {"name":"TAPENFT · 群星闪耀创世 NFT","url":"https://16321-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"TAPENFT 群星闪耀创世 NFT：1000 位科学巨匠，1000 张 1/1。芯片蚀刻工艺，金字黑底，哈希锚定链上。","tier":"deweb","badges":[],"scope":"exact","tape":"16321.30.tape","chain":"bsc","source":"deweb"},
    {"name":"REF 作曲台","url":"https://17321-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"17321.30.tape","chain":"bsc","source":"deweb"},
    {"name":"喂猫日记 · 公益投喂记录","url":"https://1-1249.tapekit.org/","category":"链上容器 · BNB 主网","desc":"个人喂猫公益记录：投喂照片和捐款明细，全部公开可查。","tier":"deweb","badges":[],"scope":"exact","tape":"1.1249.tape","chain":"bsc","source":"deweb"},
    {"name":"氣 · 對決 | Qi Duel","url":"https://1-1250.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.1250.tape","chain":"bsc","source":"deweb"},
    {"name":"币安邀请奖励 | 邀请好友注册币安，成功即得 $BEM 奖励（BSC 链上自动…","url":"https://1-1251.tapekit.org/","category":"链上容器 · BNB 主网","desc":"币安邀请码 XEG195 邀请奖励活动：邀请好友通过专属链接注册币安，确认成功后自动获得 $BEM 奖励，奖励由 BS…","tier":"deweb","badges":[],"scope":"exact","tape":"1.1251.tape","chain":"bsc","source":"deweb"},
    {"name":"菩提传奇｜正版授权复古传奇 · 首区11月11日14:00开区","url":"https://1-1254.tapekit.org/","category":"链上容器 · BNB 主网","desc":"菩提传奇：多流派·小极品·正版授权·长久稳定。首区11月11日中午14:00开区，登录器下载，玩家QQ群2502685…","tier":"deweb","badges":[],"scope":"exact","tape":"1.1254.tape","chain":"bsc","source":"deweb"},
    {"name":"Meme 多链买入提示器 · 巨量买入实时监控","url":"https://4568-0.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"4568.0.tape","chain":"bsc","source":"deweb"},
    {"name":"LABUBU · 币安在美股的化身 BNC","url":"https://122-7.tapekit.org/","category":"链上容器 · BNB 主网","desc":"从前，玩家最怕两件事：崩盘和跑路。LABUBU 联手币安财库 BNC——蝴蝶公平发射、LP 永久锁死黑洞、持币者拿 B…","tier":"deweb","badges":[],"scope":"exact","tape":"122.7.tape","chain":"bsc","source":"deweb"},
    {"name":"Loupe · 奢侈品撮合结算","url":"https://915-1.tapekit.org/","category":"链上容器 · BNB 主网","desc":"Loupe：一句话找货、一句话上架，USDT 在 BNB 链上一笔结算，卖家得 99.5%。不需要服务器，页面在 Ta…","tier":"deweb","badges":[],"scope":"exact","tape":"915.1.tape","chain":"bsc","source":"deweb"},
    {"name":"BEM 水龙头 · 免费领取 BEM","url":"https://25-20.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"25.20.tape","chain":"bsc","source":"deweb"},
    {"name":"Tape 掷地有声","url":"https://3-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"3.30.tape","chain":"bsc","source":"deweb"},
    {"name":"复盘记录","url":"https://16551-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"离线交易日记：记录每笔合约交易、按风险算仓位和爆仓价、统计胜率盈亏比和回撤。数据只存在你自己的设备上。","tier":"deweb","badges":[],"scope":"exact","tape":"16551.30.tape","chain":"bsc","source":"deweb"},
    {"name":"小孩哥 XHG · 一个关于 TapeOut 创始人 @Blonskr 的故事…","url":"https://92-2.tapekit.org/","category":"链上容器 · BNB 主网","desc":"小孩哥 XHG：十亿枚，在 four.meme 上按 four 的合约公平发射——曲线定价、零预留、零白名单，募满自动…","tier":"deweb","badges":[],"scope":"exact","tape":"92.2.tape","chain":"bsc","source":"deweb"},
    {"name":"Tapestry","url":"https://11648-0.tapekit.org/","category":"链上容器 · BNB 主网","desc":"Fully on-chain social: posts, bottles, wishes, time capsule…","tier":"deweb","badges":[],"scope":"exact","tape":"11648.0.tape","chain":"bsc","source":"deweb"},
    {"name":"修真联盟 · 万宗同修","url":"https://9708-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"修真联盟：万宗同修、论道传经。宗门群聊、悟道心得、藏经阁古籍，与同门共参。","tier":"deweb","badges":[],"scope":"exact","tape":"9708.30.tape","chain":"bsc","source":"deweb"},
    {"name":"BEM剁手保护器 2.0","url":"https://1244-888.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1244.888.tape","chain":"bsc","source":"deweb"},
    {"name":"地契 · 水田 · 玻璃房子","url":"https://4452-0.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"4452.0.tape","chain":"bsc","source":"deweb"},
    {"name":"TapeOut · 应用中心","url":"https://151-74.tapekit.org/","category":"链上容器 · BNB 主网","desc":"TapeOut · 芯跳 ChipBeat & TapeGolf 应用入口","tier":"deweb","badges":[],"scope":"exact","tape":"151.74.tape","chain":"bsc","source":"deweb"},
    {"name":"码上发财 · 二维码永久可扫，内容随容器更新","url":"https://200-74.tapekit.org/","category":"链上容器 · BNB 主网","desc":"码上发财：把 TapeOut 容器地址写进二维码，一码永久可扫，内容随时可更新。短链会失效、静态码改不了内容，容器码两…","tier":"deweb","badges":[],"scope":"exact","tape":"200.74.tape","chain":"bsc","source":"deweb"},
    {"name":"TapeEtch：把一段内容刻进电路","url":"https://11327-0.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"11327.0.tape","chain":"bsc","source":"deweb"},
    {"name":"BEM EVOLUTION · 芯兽纪元","url":"https://1-1363.tapekit.org/","category":"链上容器 · BNB 主网","desc":"BEM EVOLUTION 芯兽纪元：领取创世蛋，孵化、陪伴并训练属于你的机械生命。免费养成体验，网络 Gas 另计。","tier":"deweb","badges":[],"scope":"exact","tape":"1.1363.tape","chain":"bsc","source":"deweb"},
    {"name":"ROBOFORGE · Robot Factory / Module Mint","url":"https://1-1383.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.1383.tape","chain":"bsc","source":"deweb"},
    {"name":"TapeMuse · 一个想法，生成你的作品","url":"https://10-66.tapekit.org/","category":"链上容器 · BNB 主网","desc":"TapeMuse - 集成 AI 对话、图像与视频生成的一站式创作空间。","tier":"deweb","badges":[],"scope":"exact","tape":"10.66.tape","chain":"bsc","source":"deweb"},
    {"name":"TapeOutScan · Free Mint","url":"https://33-1.tapekit.org/","category":"链上容器 · BNB 主网","desc":"TapeOutScan 社区纪念 NFT · 999 张 · BNB Smart Chain 免费铸造","tier":"deweb","badges":[],"scope":"exact","tape":"33.1.tape","chain":"bsc","source":"deweb"},
    {"name":"AiMap · BNB Chain Ai Maps","url":"https://1-1416.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.1416.tape","chain":"bsc","source":"deweb"},
    {"name":"流片靓号 — 编号查询 · 流片 · 靓号市场","url":"https://5-20.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"5.20.tape","chain":"bsc","source":"deweb"},
    {"name":"AI LOTTO · AI钱包的链上彩票挖矿MEME","url":"https://1-1423.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.1423.tape","chain":"bsc","source":"deweb"},
    {"name":"香农猜心机 · BEM 灯板","url":"https://4034-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"4034.30.tape","chain":"bsc","source":"deweb"},
    {"name":"潮汐档案 · 512 枚链上生成的潮间带标本","url":"https://1-1438.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.1438.tape","chain":"bsc","source":"deweb"},
    {"name":"昱川能源 · 工商业屋顶光伏的设计、施工与运维","url":"https://2-1438.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"2.1438.tape","chain":"bsc","source":"deweb"},
    {"name":"衡序投顾 · 像素经营室","url":"https://1-1440.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.1440.tape","chain":"bsc","source":"deweb"},
    {"name":"TAPEOUT了没 · 电路三消挑战","url":"https://5040-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"5040.30.tape","chain":"bsc","source":"deweb"},
    {"name":"Coming soon","url":"https://3-1438.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"3.1438.tape","chain":"bsc","source":"deweb"},
    {"name":"聚英游戏 · 公益小游戏","url":"https://13712-30.tapekit.org/","category":"链上容器 · BNB 主网","desc":"聚英游戏：纯公益、无广告的休闲小游戏合集。","tier":"deweb","badges":[],"scope":"exact","tape":"13712.30.tape","chain":"bsc","source":"deweb"},
    {"name":"共振 RESONANCE 2027 · 设计与技术双日大会","url":"https://4-1438.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"4.1438.tape","chain":"bsc","source":"deweb"},
    {"name":"LibertyCats 3D Freedom Run","url":"https://1-1441.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.1441.tape","chain":"bsc","source":"deweb"},
    {"name":"moyu 发射台","url":"https://9277-1345.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"9277.1345.tape","chain":"bsc","source":"deweb"},
    {"name":"投票活动 — 链上投票 BEM Vote","url":"https://1-1446.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.1446.tape","chain":"bsc","source":"deweb"},
    {"name":"TapeBots · 笨蛋芯片擂台","url":"https://1-1447.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.1447.tape","chain":"bsc","source":"deweb"},
    {"name":"一生一世 · 重庆婚纱摄影","url":"https://1-1451.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.1451.tape","chain":"bsc","source":"deweb"},
    {"name":"Lucky Agents · BSC","url":"https://10-995.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"10.995.tape","chain":"bsc","source":"deweb"},
    {"name":"BEM 去中心化德州扑克 · 第一阶段测试原型","url":"https://36-833.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"36.833.tape","chain":"bsc","source":"deweb"},
    {"name":"PepTide Labs — Research Peptides · USDT…","url":"https://1-1452.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.1452.tape","chain":"bsc","source":"deweb"},
    {"name":"@qu0na64111 · MindEver V001","url":"https://2-1405.tapekit.org/","category":"链上容器 · BNB 主网","desc":"由本人确认、来源可追溯、持续生长的个人知识与思想档案。","tier":"deweb","badges":[],"scope":"exact","tape":"2.1405.tape","chain":"bsc","source":"deweb"},
    {"name":"TapeGang（磁带帮）· TGANG — 一盒不肯静音的磁带","url":"https://3-1447.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"3.1447.tape","chain":"bsc","source":"deweb"},
    {"name":"金矿达人","url":"https://5878-0.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"5878.0.tape","chain":"bsc","source":"deweb"},
    {"name":"TapeDeck · Browse and publish decentral…","url":"https://11279-0.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"11279.0.tape","chain":"bsc","source":"deweb"},
    {"name":"启动雷达 RADX.TOP · 多交易所潜力币扫描器","url":"https://8899-1345.tapekit.org/","category":"链上容器 · BNB 主网","desc":"启动雷达 RADX.TOP：按币安 / Gate.io / OKX 的月线横盘吸筹、周线结构转好、日线刚启动、量比放大…","tier":"deweb","badges":[],"scope":"exact","tape":"8899.1345.tape","chain":"bsc","source":"deweb"},
    {"name":"编剧大师 · 剧本改编工作台","url":"https://1-1464.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.1464.tape","chain":"bsc","source":"deweb"},
    {"name":"投资进化 · 老码头面包铺","url":"https://10347-0.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"10347.0.tape","chain":"bsc","source":"deweb"},
    {"name":"Happy Birthday","url":"https://1-913.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.913.tape","chain":"bsc","source":"deweb"},
    {"name":"八字流年机 · 链上排盘","url":"https://1-1478.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.1478.tape","chain":"bsc","source":"deweb"},
    {"name":"YUN·云极 讲解视频","url":"https://1-1481.tapekit.org/","category":"链上容器 · BNB 主网","desc":"","tier":"deweb","badges":[],"scope":"exact","tape":"1.1481.tape","chain":"bsc","source":"deweb"},
  ];

  // 第三方网关：同一链上容器也能通过这些域名打开，命中索引时会提示改用官方网关。
  var DEWEB_GATEWAYS = ['tapeout.site', 'tapeoutscan.io', 'bem.city', 'gw.tapeseek.ai'];

  // 未被导航站收录、但社区里常被问到的地址：明确不给绿标。
  var REFERENCE_SITES = [
    {"name":"TapeOut Daily","url":"https://tapeoutdaily.ai/","kind":"社区媒体","note":"社区整理的生态媒体，TapeOut.link 未收录，不给绿标。"},
  ];
  // END GENERATED TAPEOUT SITES

  var ALL_SITES = OFFICIAL_SITES.concat(DEWEB_SITES);

  // ---------- 2. 可编辑提示词（设置面板可改，{占位符} 必须保留语义） ----------
  var DEFAULT_COMMENT_PROMPT = [
    '你是「昆哥」（TapeOut 社区成员）的 X 回复助手。请根据下面这条推文，写出 3 条可以直接发布的回复候选。',
    '',
    '要求：',
    '1. 三条角度各不相同：一条认同并补充信息，一条提出有价值的问题，一条给出简短独立观点。',
    '2. 中文为主；如果原文是英文，可以用英文回复。语气自然克制、像真人，不要营销腔、不要吹捧、不要喊口号。',
    '3. 每条不超过 180 个字符，不带话题标签、不带链接、不带引号包裹，不编造事实、不给投资建议、不引战。',
    '4. 只输出评论文本，严格返回 JSON 数组：["第一条", "第二条", "第三条"]。不要输出任何解释或 Markdown 代码块。',
    '',
    '推文正文：',
    '"""',
    '{POST}',
    '"""'
  ].join('\n');

  var DEFAULT_VERIFY_PROMPT = [
    '你是 TapeOut 生态的「链接真伪核验」助手。插件已在本地用内置白名单精确比对过这条链接，下面的【本地权威结论】不可被推翻。',
    '',
    '【本地权威结论】',
    '{LOCAL_RESULT}',
    '',
    '【官方 / 收录清单摘要】（完整清单共数百条，这里只列与本次判定相关的部分）',
    '{OFFICIAL_LIST}',
    '',
    '请结合上面的权威结论，判断这条待核验链接是否属于 TapeOut 生态导航认可的平台，并识别仿冒风险。',
    '',
    '判定规则（必须严格遵守）：',
    '- 本地结论为「已命中」时，verdict 必须是 official；本地未命中时，一律不得判 official。',
    '- 清单分三档：official = 项目方官方，listed = 导航站编辑收录，deweb = 链上容器已索引；三档都属于「导航认可」，但只有第一档是项目方官方，理由里要说清楚。',
    '- 域名相似但不相同、多一级子域、路径不同、含跳转参数、Punycode、短链、非 HTTPS，一律不得判 official。',
    '- 不要凭记忆补充任何「官方」网址；清单之外的链接一律不得判为 official。',
    '- 含官方品牌词但不在清单里的域名判 fake，并指出疑似仿冒。',
    '',
    '只输出 JSON 对象，不要 Markdown 代码块：',
    '{"verdict":"official|community|fake|unknown","reason":"中文简短理由","risk":"风险提示，没有则留空","matched":"命中的清单 URL，没有则留空"}',
    '',
    '待核验链接：{URL}'
  ].join('\n');

  var SYSTEM_HINT = '你是严格按格式输出的助手。只返回用户要求的 JSON，不要解释、不要前后缀、不要 Markdown 代码块。';

  // ---------- 2.5 非 API 模式（X 站内 Grok 页面 / 浮窗） ----------
  /*
   * 实测（2026-11-08，x.com/i/grok）：
   *   输入框 div[aria-label="Ask anything"][role="textbox"]（contenteditable）
   *   发送   button[aria-label="Send"]（输入前是 Voice mode，有内容后才变 Send）
   *   对话根 div[aria-label="Grok"]
   *   回答旁 button[aria-label="Copy"] —— 每条回答一个，用它回溯回答块最稳
   * 网页版 Grok 会额外输出「思考过程」和用户提问气泡，所以不能整段丢给 JSON.parse；
   * 这里统一用 extractJsonLoose 从混杂文本里捞最后一个语义合格的 JSON。
   * 全部选择器都可在设置里改，X 改版时不用升版本。
   */
  var PAGE_MODE_DEFAULTS = {
    grokMode: 'auto',                    // auto = 有 Key 走 API、没 Key 走页面；api / page 为强制
    grokPageUrl: 'https://x.com/i/grok',
    grokPageInputSel: 'div[aria-label="Ask anything"][role="textbox"], textarea[placeholder*="Ask"], [data-testid="grok-input"]',
    grokPageSendSel: 'button[aria-label="Send"], [data-testid="grok-send"]',
    grokPageRootSel: 'div[aria-label="Grok"], [data-testid="grok-conversation"]',
    grokPageAnswerSel: 'button[aria-label="Copy"]',
    grokPageQuietMs: 1500,               // 文本静止多久算回答完成
    grokPageTimeoutMs: 60000,            // 单次最长等待
    grokPageAutoSubmit: true,            // 关掉 = 只填词，由用户自己按发送
    grokPageNewChat: true,               // 每次新开对话，避免上一轮上下文污染
    grokPageMaxChars: 8000,              // 回传文本上限，防止把整页 HTML 塞给后台
    pagePromptExtra: ''                  // 追加到页面模式提示词末尾的自定义要求
  };

  var PAGE_OUTPUT_RULE = [
    '',
    '【输出格式（必须严格遵守）】',
    '- 直接给最终答案，不要展示思考过程、不要复述题目、不要写「好的」「以下是」这类开场白。',
    '- 只输出上面要求的那一个 JSON（数组或对象）；可放在 ```json 代码块里，但代码块外不要有任何文字。',
    '- 不要输出多个版本、解释、总结或后续建议。'
  ].join('\n');

  /* service worker 与页面脚本共用的模式判定：auto 时没 Key 自动降级到 x.com 页面模式 */
  function pickGrokMode(cfg) {
    var mode = String((cfg && cfg.grokMode) || PAGE_MODE_DEFAULTS.grokMode).toLowerCase();
    if (['auto', 'api', 'page'].indexOf(mode) === -1) mode = 'auto';
    if (mode !== 'auto') return mode;
    return String((cfg && cfg.grokApiKey) || '').trim() ? 'api' : 'page';
  }

  /*
   * 网页版 Grok 没有 system 通道，必须把 system 指令并进同一条消息；
   * 并追加「只出最终 JSON」约束（实测它会先吐一段思考过程）。
   */
  function buildPagePrompt(messages, extra) {
    var sys = [], user = [];
    (messages || []).forEach(function (m) {
      if (!m || !m.content) return;
      if (m.role === 'system') sys.push(m.content);
      else user.push(m.content);
    });
    var head = sys.length ? '【必须遵守的指令】\n' + sys.join('\n') + '\n\n' : '';
    var tail = String(extra == null ? '' : extra).trim();
    return (head + user.join('\n\n') + '\n' + PAGE_OUTPUT_RULE + (tail ? '\n\n' + tail : '')).trim();
  }

  // ---------- 3. URL 规范化与本地白名单判定 ----------
  var SHORTENER_HOSTS = /(?:^|\.)(?:bit\.ly|t\.cn|tinyurl\.com|s\.id|goo\.gl|is\.gd|ow\.ly|buff\.ly|cutt\.ly|shorturl\.at|rebrand\.ly|tiny\.cc)$/i;

  function stripCodeFence(s) {
    return String(s || '')
      .replace(/^\s*```(?:json|JSON)?\s*/m, '')
      .replace(/```\s*$/m, '')
      .trim();
  }

  /*
   * 把用户输入的任意链接文本规范成可比较的形式。
   * 比较口径：https 协议 + 去 www. 的小写 host + 小写 pathname（去末尾斜杠）。
   * query / hash 不参与判定：官网带 ?ref= 仍然是官网；但会原样保留在 raw 里展示。
   */
  function normalizeUrl(input) {
    var raw = String(input == null ? '' : input).trim().replace(/^["'「」]+|["'「」]+$/g, '');
    if (!raw) return { ok: false, raw: '', error: '请输入链接' };
    // 伪协议不是网址，别让它被当成「缺 scheme 的域名」补成 https://javascript:...
    if (/^(?:javascript|data|vbscript|file|about):/i.test(raw)) {
      return { ok: false, raw: raw, error: '检测到非网页协议，已拦截（可能是伪装的钓鱼链接）' };
    }
    // 用户常直接粘贴 tapeout.net 或 x.com/blonskr，补 https 再解析
    var candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw;
    var u;
    try {
      u = new URL(candidate);
    } catch (e) {
      return { ok: false, raw: raw, error: '链接格式无法识别，请粘贴完整的 http(s) 地址' };
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, raw: raw, error: '只接受 http / https 链接（' + u.protocol + ' 已拦截）' };
    }
    var host = String(u.hostname || '').toLowerCase().replace(/^www\./, '');
    var path = String(u.pathname || '/').toLowerCase().replace(/\/+$/, '') || '/';
    return {
      ok: true,
      raw: raw,
      normalized: u.protocol + '//' + host + path,
      scheme: u.protocol.replace(':', ''),
      host: host,
      path: path,
      key: host + path,
      port: u.port || '',
      punycode: /xn--/i.test(String(u.hostname || '')),
      hasQuery: !!u.search,
      hasHash: !!u.hash
    };
  }

  function siteKey(url) {
    var n = normalizeUrl(url);
    return n.ok ? n.key : '';
  }

  /* 按清单构建查找索引；同一个清单对象只构建一次。 */
  var _lkKey = null, _lk = null;
  function lookupFor(list) {
    if (list === _lkKey && _lk) return _lk;
    var byKey = {}, byHost = {}, domainHosts = [], gatewayPrefix = {}, hosts = [];
    list.forEach(function (s) {
      var n = normalizeUrl(s.url);
      if (!n.ok) return;
      if (!byKey[n.key]) byKey[n.key] = s;
      if (!byHost[n.host]) byHost[n.host] = s;
      if (hosts.indexOf(n.host) === -1) hosts.push(n.host);
      if (s.scope === 'domain') {
        // 同一 host 有多条时，优先用根路径条目（导航站本体内页应命中导航站，而不是站内某个子应用）
        var exist = domainHosts.filter(function (d) { return d.host === n.host; })[0];
        if (!exist) domainHosts.push({ host: n.host, site: s, path: n.path });
        else if (n.path.length < exist.path.length) { exist.site = s; exist.path = n.path; }
      }
      // 链上容器在官方网关上的精确子域，用于识别「同一个容器走第三方网关」的情形
      var m = n.host.match(/^([a-z0-9-]+)\.tapekit\.org$/i);
      if (m && s.tier === 'deweb') gatewayPrefix[m[1].toLowerCase()] = s;
    });
    _lk = { byKey: byKey, byHost: byHost, domainHosts: domainHosts, gatewayPrefix: gatewayPrefix, hosts: hosts };
    _lkKey = list;
    return _lk;
  }

  /*
   * 本地权威判定。返回 status: official | community | unknown | invalid。
   * 命中时带 tier（official / listed / deweb）与可选的 viaGateway。
   * 严格相等（host + path）优先；只有 scope==='domain' 的少数官网才放宽到同域任意路径与子域。
   */
  function matchOfficial(input, officialList, referenceList) {
    var list = officialList || ALL_SITES;
    var reference = referenceList === undefined ? REFERENCE_SITES : referenceList;
    var n = normalizeUrl(input);
    if (!n.ok) return { status: 'invalid', normalized: n, error: n.error, site: null, risks: [] };

    var lk = lookupFor(list);
    var site = lk.byKey[n.key] || null;
    var viaGateway = null;

    // 独立官网：同 host 的其它路径、以及官子域，同样算该官网
    if (!site) {
      for (var i = 0; i < lk.domainHosts.length; i++) {
        var d = lk.domainHosts[i];
        if (n.host === d.host || n.host.slice(-(d.host.length + 1)) === '.' + d.host) {
          site = d.site;
          break;
        }
      }
    }

    // 同一个链上容器用第三方网关打开：仍算已索引，但提示改用官方网关
    if (!site) {
      for (var g = 0; g < DEWEB_GATEWAYS.length; g++) {
        var gw = DEWEB_GATEWAYS[g];
        var suffix = '.' + gw;
        if (n.host.slice(-suffix.length) !== suffix) continue;
        var prefix = n.host.slice(0, -suffix.length);
        var hit = lk.gatewayPrefix[prefix.toLowerCase()];
        if (hit) {
          site = hit;
          viaGateway = hit.url;
          break;
        }
      }
    }

    if (site) {
      var risks = spoofSignals(n, list);
      if (viaGateway) {
        risks.unshift('当前使用的是第三方网关域名；同一个链上容器也可以通过官方网关打开：' + viaGateway + '。建议改用官方网关地址。');
      }
      return {
        status: 'official',
        tier: site.tier || 'listed',
        viaGateway: viaGateway,
        normalized: n,
        site: site,
        risks: risks
      };
    }

    for (var j = 0; j < (reference || []).length; j++) {
      if (siteKey(reference[j].url) === n.key) {
        return { status: 'community', normalized: n, site: reference[j], risks: spoofSignals(n, list) };
      }
    }
    return { status: 'unknown', normalized: n, site: null, risks: spoofSignals(n, list) };
  }

  // 官方/生态品牌词。x.com 等通用平台不纳入。
  var BRAND_WORDS = ['tapeout', 'tapehub', 'tapekit', 'tapecode', 'tapezero', 'tapexo', 'tapeup'];

  function editDistance(a, b) {
    var m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    var prev = new Array(n + 1), cur = new Array(n + 1), i, j;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      for (j = 0; j <= n; j++) prev[j] = cur[j];
    }
    return prev[n];
  }

  function spoofSignals(n, officialList) {
    var risks = [];
    if (!n || !n.ok) return risks;
    var list = officialList || ALL_SITES;
    var lk = lookupFor(list);
    var host = n.host;

    if (n.punycode) risks.push('域名含 Punycode（xn--），常见于用相似字符冒充官方域名');
    if (n.scheme !== 'https') risks.push('不是 HTTPS 连接，可能被中间人篡改');
    if (n.port && n.port !== '443' && n.port !== '80') risks.push('带非标准端口 :' + n.port + '，正规官网通常不会这样');
    if (SHORTENER_HOSTS.test(host)) risks.push('这是短链，真实跳转地址被隐藏，无法核验');
    if (/javascript:|data:/i.test(n.raw)) risks.push('链接含非网页协议');

    var brandHit = BRAND_WORDS.some(function (w) { return host.indexOf(w) !== -1; });
    // 已在白名单里的域名（含合法子域）不该被自己的品牌词误报成仿冒
    var isListed = !!lk.byHost[host] || lk.domainHosts.some(function (d) {
      return host === d.host || host.slice(-(d.host.length + 1)) === '.' + d.host;
    });
    if (brandHit && !isListed) {
      risks.push('域名含 TapeOut 相关品牌词，但不在导航收录清单里 —— 高度疑似仿冒');
    }
    // 去掉连字符/点后与「常规站点主域」比较，抓 tapeout-net.com / tapeoutnet.io 这类。
    // 只比较常规站点（排除 *.tapekit.org 之类的容器子域），避免把合法容器互相误报。
    var flatHost = host.replace(/[-.]/g, '');
    var coreHosts = lk.hosts.filter(function (h) { return !/\.tapekit\.org$/i.test(h) && h !== 'x.com' && h !== 't.me'; });
    for (var i = 0; i < coreHosts.length; i++) {
      var oh = coreHosts[i];
      if (host === oh || isListed) continue;
      var flatOfficial = oh.replace(/[-.]/g, '');
      if (flatHost === flatOfficial || editDistance(host, oh) <= 2) {
        risks.push('与已收录域名 ' + oh + ' 仅差一两个字符，可能是仿冒站');
        break;
      }
    }
    return risks;
  }

  function tierLabel(tier) {
    return ({ official: '项目方官方（OFFICIAL）', listed: '生态导航收录认可', deweb: '链上容器 · 已索引' })[tier] || '生态导航收录认可';
  }

  /* 面板展示顺序：项目方官方 → 导航站收录 → 链上容器。权重从 1 开始，避免 0 被 || 兜底吞掉。 */
  var TIER_ORDER = { official: 1, listed: 2, deweb: 3 };
  function sortByTier(list) {
    return (list || []).slice().sort(function (a, b) {
      var oa = TIER_ORDER[(a && a.tier) || 'listed'] || 9;
      var ob = TIER_ORDER[(b && b.tier) || 'listed'] || 9;
      return oa - ob;
    });
  }

  function officialListText(list) {
    var arr = list || OFFICIAL_SITES;
    var rows = arr.map(function (s, i) {
      return (i + 1) + '. [' + tierLabel(s.tier) + '] ' + s.name + ' — ' + s.url;
    });
    rows.push('');
    rows.push('另有 ' + DEWEB_SITES.length + ' 个链上容器已被 web.tapeout.link 索引，按官方网关精确子域比对。');
    rows.push('参考（导航站未收录，不得判 official）：');
    REFERENCE_SITES.forEach(function (s) { rows.push('- ' + s.name + ' — ' + s.url + '（' + s.kind + '）'); });
    return rows.join('\n');
  }

  /* 给 Grok 的清单摘要：5 条项目方官方 + 命中项 + 同域/相邻条目，避免把数百条塞进提示词。 */
  function officialContextText(input, list) {
    var arr = list || ALL_SITES;
    var n = normalizeUrl(input);
    var local = matchOfficial(input, arr, REFERENCE_SITES);
    var picked = [], seen = {};
    function add(s) {
      if (!s || seen[s.url]) return;
      seen[s.url] = 1;
      picked.push(s);
    }
    arr.filter(function (s) { return s.tier === 'official'; }).forEach(add);
    if (local.site) add(local.site);
    if (n.ok) {
      arr.filter(function (s) {
        var h = normalizeUrl(s.url).host;
        return h === n.host || n.host.indexOf(h) !== -1 || h.indexOf(n.host.split('.')[0]) === 0;
      }).slice(0, 8).forEach(add);
    }
    var rows = [
      '清单总数：' + arr.length + ' 条（项目方官方 ' +
        arr.filter(function (s) { return s.tier === 'official'; }).length + ' / 导航站收录 ' +
        arr.filter(function (s) { return s.tier === 'listed'; }).length + ' / 链上容器已索引 ' +
        arr.filter(function (s) { return s.tier === 'deweb'; }).length + '）。',
      '以下为与本次判定相关的条目：'
    ];
    picked.forEach(function (s) { rows.push('- [' + tierLabel(s.tier) + '] ' + s.name + ' — ' + s.url); });
    return rows.join('\n');
  }

  function localResultText(input, list) {
    var r = matchOfficial(input, list || ALL_SITES, REFERENCE_SITES);
    if (r.status === 'invalid') return '链接无效：' + (r.error || '无法解析');
    if (r.status === 'official') {
      return '已命中本地白名单 → 给绿标；等级：' + tierLabel(r.tier) +
        '；命中条目：' + r.site.name + ' — ' + r.site.url +
        (r.viaGateway ? '；当前为第三方网关，官方网关地址 ' + r.viaGateway : '') +
        (r.risks.length ? '；风险提示：' + r.risks.join(' / ') : '；无额外风险');
    }
    if (r.status === 'community') return '未命中收录清单，但命中「参考链接」→ 不给绿标；' + r.site.name;
    return '未命中本地白名单 → 不给绿标' + (r.risks.length ? '；风险提示：' + r.risks.join(' / ') : '');
  }

  // ---------- 4. 提示词组装 ----------
  function fillTemplate(tpl, vars, tail) {
    var t = String(tpl || '');
    Object.keys(vars || {}).forEach(function (k) {
      t = t.split(k).join(String(vars[k] == null ? '' : vars[k]));
    });
    // 用户自定义提示词可能删掉占位符，兜底把关键内容追加到末尾
    var missing = [];
    Object.keys(vars || {}).forEach(function (k) { if (String(tpl || '').indexOf(k) === -1) missing.push(k); });
    if (missing.length && tail) t = t + '\n\n' + tail;
    return t;
  }

  function buildCommentMessages(postText, promptTpl) {
    var text = String(postText || '').slice(0, 1200);
    var tpl = promptTpl || DEFAULT_COMMENT_PROMPT;
    var prompt = fillTemplate(tpl, { '{POST}': text }, '推文正文：\n"""\n' + text + '\n"""');
    return [
      { role: 'system', content: SYSTEM_HINT },
      { role: 'user', content: prompt }
    ];
  }

  function buildVerifyMessages(input, promptTpl, officialList) {
    var n = normalizeUrl(input);
    var urlText = n.ok ? n.normalized + (n.hasQuery ? '（原输入含查询参数）' : '') : String(input || '');
    var list = officialList || ALL_SITES;
    var vars = {
      '{LOCAL_RESULT}': localResultText(input, list),
      '{OFFICIAL_LIST}': officialContextText(input, list),
      '{URL}': urlText
    };
    var tpl = promptTpl || DEFAULT_VERIFY_PROMPT;
    var tail = '【本地权威结论】\n' + vars['{LOCAL_RESULT}'] +
      '\n\n【清单摘要】\n' + vars['{OFFICIAL_LIST}'] + '\n\n待核验链接：' + urlText;
    var prompt = fillTemplate(tpl, vars, tail);
    return [
      { role: 'system', content: SYSTEM_HINT },
      { role: 'user', content: prompt }
    ];
  }

  // ---------- 5. 结果解析（模型输出经常不守格式，做多重兜底） ----------
  function cleanCommentLine(s) {
    return String(s || '')
      .replace(/^\s*(?:\d+[\.、)）]|[-*•])\s*/, '')
      .replace(/^["'「」『』]+|["'「」『』]+$/g, '')
      .replace(/^\*\*|\*\*$/g, '')
      .replace(/^["']\s*|\s*["'],?$/g, '')
      .trim();
  }

  function parseThreeComments(raw) {
    var s = stripCodeFence(raw);
    var out = [];
    try {
      var parsed = JSON.parse(s);
      var arr = Array.isArray(parsed) ? parsed :
        (parsed && (parsed.comments || parsed.replies || parsed.items || parsed.results || parsed.data));
      if (Array.isArray(arr)) {
        arr.forEach(function (x) {
          if (typeof x === 'string') out.push(cleanCommentLine(x));
          else if (x && typeof x === 'object') out.push(cleanCommentLine(x.text || x.content || x.comment || ''));
        });
      }
    } catch (e) {
      // 模型可能返回 {"1":"...","2":"..."} 或纯编号列表
      try {
        var obj = JSON.parse(s);
        if (obj && typeof obj === 'object') {
          Object.keys(obj).sort().forEach(function (k) { if (typeof obj[k] === 'string') out.push(cleanCommentLine(obj[k])); });
        }
      } catch (e2) { /* 下面按行拆 */ }
    }
    if (!out.length) {
      s.split(/\n+/).forEach(function (line) {
        var c = cleanCommentLine(line);
        if (!c) return;
        if (/^[{}\[\]]|^\s*["']?\s*[,}]?\s*$/.test(c)) return;
        if (/^(?:verdict|reason|risk|matched)\s*[:：]/i.test(c)) return;
        out.push(c);
      });
    }
    out = out.map(function (c) { return String(c).slice(0, 240); })
      .filter(function (c, i, a) { return c && a.indexOf(c) === i; });
    return out.slice(0, 3);
  }

  function parseVerdict(raw) {
    var s = stripCodeFence(raw);
    try {
      var o = JSON.parse(s);
      var v = String((o && o.verdict) || '').toLowerCase();
      if (['official', 'community', 'fake', 'unknown'].indexOf(v) === -1) v = 'unknown';
      return {
        verdict: v,
        reason: String((o && o.reason) || '').slice(0, 300),
        risk: String((o && o.risk) || '').slice(0, 300),
        matched: String((o && o.matched) || '').slice(0, 300),
        parsed: true
      };
    } catch (e) {
      return {
        verdict: 'unknown',
        reason: '模型没有按 JSON 格式返回，下方只展示本地白名单结论与模型原文。',
        risk: '',
        matched: '',
        parsed: false,
        rawText: s.slice(0, 600)
      };
    }
  }

  /*
   * 从「Grok 网页回答 + 思考过程 + 用户提问气泡」的混杂文本里，捞出最后一个
   * 语义合格的 JSON。括号配对扫描会跳过字符串内的括号，避免被正文里的
   * [] {} 干扰；模板样例（["第一条"…] / verdict 枚举串）会被语义校验挡掉。
   */
  function jsonCandidates(s) {
    var out = [];
    var text = String(s || '');
    for (var i = 0; i < text.length && out.length < 24; i++) {
      var c = text[i];
      if (c !== '[' && c !== '{') continue;
      var stack = [], inStr = false, esc = false, end = -1;
      for (var j = i; j < text.length; j++) {
        var d = text[j];
        if (inStr) {
          if (esc) esc = false;
          else if (d === '\\') esc = true;
          else if (d === '"') inStr = false;
          continue;
        }
        if (d === '"') { inStr = true; continue; }
        if (d === '[' || d === '{') stack.push(d === '[' ? ']' : '}');
        else if (d === ']' || d === '}') {
          if (!stack.length || stack.pop() !== d) break;
          if (!stack.length) { end = j; break; }
        }
      }
      if (end <= i) continue;
      var frag = text.slice(i, end + 1);
      try {
        var v = JSON.parse(frag);
        out.push({ value: v, text: frag, start: i, end: end + 1 });
        i = end; // 只有解析成功才跳过内部，避免正文里的 { } 把后面的真数组吃掉
      } catch (e) { /* 不是完整 JSON：不跳过，继续从下一个字符找 */ }
    }
    return out;
  }

  function looksLikeComments(v) {
    if (!Array.isArray(v)) return false;
    var arr = v.filter(function (x) { return typeof x === 'string' && x.trim(); });
    if (!arr.length) return false;
    var joined = arr.join('');
    // 只排除「整组都是占位样例」的情况；真实评论里偶尔出现「第二条」不该被误杀
    var isPlaceholderArray = arr.length === 3 &&
      /第一条/.test(joined) && /第二条/.test(joined) && /第三条/.test(joined) &&
      arr.every(function (x) { return x.length < 12; });
    return !isPlaceholderArray && !/\{POST\}|placeholder|示例评论/i.test(joined);
  }

  function looksLikeVerdict(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    var vd = String(v.verdict || '').toLowerCase();
    return ['official', 'community', 'fake', 'unknown'].indexOf(vd) !== -1;
  }

  function extractJsonLoose(raw, kind) {
    var s = stripCodeFence(raw);
    var list = jsonCandidates(s);
    var want = kind === 'verdict' ? looksLikeVerdict : looksLikeComments;
    // 从后往前取：Grok 常把最终答案放在最后；思考过程里一般没有合格 JSON
    for (var i = list.length - 1; i >= 0; i--) {
      if (want(list[i].value)) return list[i];
    }
    return null;
  }

  /* 页面模式解析入口：先宽松提取，失败再退回原有按行兜底 */
  function parsePageResult(raw, kind) {
    var hit = extractJsonLoose(raw, kind);
    if (hit) {
      if (kind === 'verdict') return parseVerdict(hit.text);
      return parseThreeComments(hit.text);
    }
    return kind === 'verdict' ? parseVerdict(raw) : parseThreeComments(raw);
  }

  return {
    SOURCE: SOURCE,
    OFFICIAL_SITES: OFFICIAL_SITES,
    DEWEB_SITES: DEWEB_SITES,
    DEWEB_GATEWAYS: DEWEB_GATEWAYS,
    REFERENCE_SITES: REFERENCE_SITES,
    ALL_SITES: ALL_SITES,
    DEFAULT_COMMENT_PROMPT: DEFAULT_COMMENT_PROMPT,
    DEFAULT_VERIFY_PROMPT: DEFAULT_VERIFY_PROMPT,
    SYSTEM_HINT: SYSTEM_HINT,
    PAGE_MODE_DEFAULTS: PAGE_MODE_DEFAULTS,
    PAGE_OUTPUT_RULE: PAGE_OUTPUT_RULE,
    pickGrokMode: pickGrokMode,
    buildPagePrompt: buildPagePrompt,
    normalizeUrl: normalizeUrl,
    siteKey: siteKey,
    matchOfficial: matchOfficial,
    spoofSignals: spoofSignals,
    tierLabel: tierLabel,
    TIER_ORDER: TIER_ORDER,
    sortByTier: sortByTier,
    officialListText: officialListText,
    officialContextText: officialContextText,
    localResultText: localResultText,
    buildCommentMessages: buildCommentMessages,
    buildVerifyMessages: buildVerifyMessages,
    parseThreeComments: parseThreeComments,
    parseVerdict: parseVerdict,
    stripCodeFence: stripCodeFence,
    jsonCandidates: jsonCandidates,
    extractJsonLoose: extractJsonLoose,
    parsePageResult: parsePageResult
  };
})();

// Node 回归测试直接 require；浏览器里 module 不存在，忽略即可
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TapeAI;
}
