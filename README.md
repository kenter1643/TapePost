# TapePost · 一键转发到 X

> 在内容页点一下，把正文和配图整理成 X 草稿素材；在 X 上用 Grok 生成 3 条评论候选；用 295 条导航收录清单核验 TapeOut 生态链接。**发送与回复始终由你手动完成，扩展不会替你发帖。**

- 介绍页：<https://kenter1643.github.io/TapePost/>
- 隐私政策：<https://kenter1643.github.io/TapePost/privacy.html>
- 源码：<https://github.com/kenter1643/TapePost>
- 版本：1.4.6（本仓库源码）　｜　Chrome Web Store 审核中：1.4.2　｜　Manifest V3　｜　Chrome 116+

![TapePost 功能示意](docs/assets/screenshots/01_overview_1280x800.png)

## 它做什么

在微博、知乎、微信公众号、B 站动态、豆瓣广播、小红书、X 的内容右上角注入一个橙色「一键转发」按钮。点击后：

1. **只取这一条**：按正文锚点定位，剥掉昵称、时间、认证标签、话题尾巴等元信息；按钮点击时实时重新解析卡片，避免无限滚动的 DOM 复用导致抓错内容。
2. **取全部配图**：九宫格、多个媒体容器、懒加载属性、CSS 背景图、内联 `pic_infos`、X 的 `name=orig` 原图，最多 9 张；自动排除头像等干扰图。
3. **本地去水印**：Canvas 先检测底部白色水印，只在命中时用包围盒插值 / BFS 重建；没检测到的图原样保留，不会强行抹图。
4. **多图托盘**：右下角弹出「干净图 N 张」，可逐张复制、拼长图、下载到临时目录；托盘就绪后再点按钮打开 X，避免 X 抢焦点。
5. **文字预填**：清洗后的正文通过 `x.com/intent/tweet?text=...` 预填到发推框，你在 X 里粘贴图片、确认内容后**手动点发送**。


> **版本状态（2026-11-10）**：本仓库 `main` 是 **1.4.6**（回复框新增多个 T 快捷推广按钮）；Chrome Web Store 首次提交审核的条目仍是 **1.4.2**。两者兼容，但代码不同。要把新版发到商店，需同步更新 `store/listing.json` 与隐私政策后再上传新包。

### 1.4.6：多个「T」快捷推广按钮（AI / 非 AI 通用）

1.4.5 只在 AI 生成的候选里自动附加推广句，自己手写评论时没有入口。1.4.6 补上手动通道：

- **回复填写区右侧新增一排小按钮**（AI 评论按钮左边）：默认 `T1 T2 T3 T4`，外加 `↻`（随机换一句）和 `×`（去掉推广句）。每个 T 按钮固定对应一句，鼠标悬停可看全文；点一下就把这句带到**当前评论末尾**。
- **与 AI 完全解耦**：不用 AI 评论、也不勾「自动附加」照样能用；反过来把「AI 评论」开关关掉，T 按钮仍在。设置页可单独关闭快捷按钮、把数量改成 2 / 3 / 4 / 6。
- **换句不叠加**：再点别的 T 按钮会先剥掉末尾旧推广句（也兼容「先选了 AI 候选已自动带一句」的情况），再写入新句；`×` 只留你自己写的正文。整体替换用「选中输入框内部 + `insertText`」，不用 `selectAll`（1.3.2 曾因它把整页文字带进输入框）。
- **不破坏已贴的附件**：回复框里有图 / 视频时自动退回追加模式，避免整体替换把附件清掉。
- 仍只作用于 X 评论 / 回复框，不改一键转发正文；最后一步始终由你手动点「回复」。**未新增任何 manifest 权限**，回归测试 **311/311 全通过**。

下载：`store/TapePost_1.4.6_store.zip`。

### 1.4.5：可勾选的「评论末尾推广」（TapeOut / $BEM 随机话术）

在设置页「🤖 Grok 设置」里新增 **📣 评论末尾推广**，**默认关闭**，勾上后才生效：

- **3 条 AI 评论候选各随机附一句**推广短句，追加在候选末尾；选「交替随机」时两个主题都会出现，也可只推 TapeOut 或只推 `$BEM`。
- **话术可改**：内置两组各 8 句（共 16 句），只讲生态与技术，不含价格、收益、买入建议，也不塞外链；在「✏️ 自定义话术」里按主题每行填一句即可覆盖内置，设置页可「🎲 随机预览一句」。
- **不重复、不超长**：同一句不会重复追加；按 Unicode 码点计数，附带后超过 260 字符会压缩正文并保住推广句（X 上限 280，留 20 字符余量给链接计权 / emoji）。
- **可换一批**：候选面板点「🎲 换一批」只换推广句、不重新调 Grok，且会避开上一批话术。
- **当时只作用于 AI 评论**（1.4.6 起已扩展到回复框 T 按钮）：一键转发的正文完全不变；插件仍只把文字写回回复框，最后一步由你手动点「回复」。
- **设置即时生效**：`chrome.storage.onChanged` 只同步这 4 个键，保存后已打开的 X 页面不用刷新。
- 新增共享层 `promo.js`（content script 与 popup 同一份话术），**未新增任何 manifest 权限**；回归测试 **300/300 全通过**。

下载：`store/TapePost_1.4.5_store.zip`（GitHub 仓库内直接下载，或 `git clone` 后解压加载）。

### 1.4.4：修复重新加载后 popup 的 `Unchecked runtime.lastError`

**真机报错**（chrome://extensions → 错误）：`Unchecked runtime.lastError: The message port closed before a response was received. Context: popup.html`。
原因是 1.4.3 新增的「临时文件状态 / 立即清理」两个回调没有读取 `chrome.runtime.lastError`：popup 一打开就会发 `TMP_STATUS`，用户很快关掉弹窗时，端口在后台 `sendResponse` 之前关闭，Chrome 把未检查的 `lastError` 记成扩展错误。

- **统一消息通道**：popup 内所有 `chrome.runtime.sendMessage` 改走 `sendBg()`，回调第一行同步读取 `chrome.runtime.lastError`；后台没回包时只显示为「状态不可用 / 清理失败」，不再往错误面板写日志。
- **状态查询零消息**：`refreshTmpStatus()` 直接读 `chrome.storage.local` 的 `tapeTmpDownloads`，popup 打开时不再向后台发消息；只有用户主动点「立即清理」才发 `TMP_CLEAN`。
- **托盘清理同步加固**：图片托盘的「🧹 清理临时文件」回调也读取 `lastError`。
- 未新增任何 manifest 权限；回归测试全量通过（数量以 `node test-harness.js` 输出为准）。

下载：`store/TapePost_1.4.4_store.zip`（GitHub 仓库内直接下载，或 `git clone` 后解压加载）。

### 1.4.3：转发不再自动落盘，临时文件到期自动清理

- **图片默认走剪贴板**：旧版转发时会把「其余图 / 剪贴板没带上的首图」自动下载到下载目录。1.4.3 起该下载兜底默认关闭（`autoDownloadBackup: false`），多图用托盘逐张复制或拼长图，正常转发**零落盘**。
- **必要的落盘统一进 `TapePost_tmp/`**：视频必须用文件拖进 X（剪贴板不支持 mp4），托盘「下载到临时目录」同理；两者都写入下载目录下的 `TapePost_tmp/` 子目录、`xpost_` 前缀，便于识别与整目录清理。
- **到期自动清理**：后台记录 `downloadId` + 时间戳，保留时长（默认 30 分钟，可选 15 / 60 / 120 分钟或「不自动清理」）到期后调用 `chrome.downloads.erase()` 同时删除**磁盘文件与下载历史记录**；老版本 Chrome 回退 `removeFile()`。扩展启动、每次新下载、打开设置、Service Worker 唤醒时都会顺带清一次，不依赖定时器。
- **手动清理**：设置面板「🧹 立即清理临时文件」与图片托盘「🧹 清理临时文件」一键清空，并显示剩余数量。
- **未新增任何 manifest 权限**（仍是 `storage / downloads / clipboardWrite / offscreen / declarativeNetRequest`）。

历史包：`store/TapePost_1.4.3_store.zip`。

> ⚠️ 1.4.2 已提交商店审核，**在线介绍页与隐私政策页仍按 1.4.2 口径保持不变**——它们是该条目的披露依据，提前改成新版行为会造成「Dashboard 披露 / 隐私政策 / 实际包」不一致。等新版正式发布到商店时再同步更新这两页与商店文案。

### 1.4.2 修复：站内直连返回 HTTP 401（认证链路）

**真机报错**：`站内直连失败：X 会话已失效或账号暂无 Grok 权限（HTTP 401）。请重新登录 X 后刷新页面。；已自动降级到页面模式，但页面模式也失败：提示词写入校验失败…`。
这条报错其实是**好消息**：1.4.1 的三层保险已生效，直连真的被走到了，不再是模式路由问题；失败发生在 X 接口的**认证阶段**。

**对照 X Viral Monitor**：它的 `lib/grok-reply.js` 里 `authorization` 优先取 `window.__xvmNet.getBearer()`（自己维护的**最新实时 bearer**），签名优先用 `window.__xvmGrok.__capturedTxId`（从 X-UI 真实请求抓到的）。而 TapePost 1.4.0/1.4.1 的自有 fetch 观察钩子只保存**第一个**看到的 bearer，一旦它与用户当前 X 会话不匹配就返回 401；旧代码还直接 `cancel()` 掉 401 响应体，只留一句笼统的「请重新登录」，既没定位也没自愈。

**修复**：

- **优先复用同页已安装的 X Viral Monitor**：检测到 `window.__xvmGrok.generate()` 时直接调用这条用户实测稳定的通道。TapePost 的完整提示词通过只含 `[推文内容]` 的模板原样透传（XVM 的 `renderPrompt` 会直接返回它），取返回的前 3 条候选。XVM 未安装、未就绪或抛错时安静回落自有直连，不影响其它用户。
- **自有链路对齐 XVM**：`authorization` 改为 `__xvmNet.getBearer()` → 自有捕获 → 公开 bearer；`freshCapturedTx()` 复用 `__xvmGrok.__capturedTxId`；`status()` 与 `checkReady()` 报告 XVM 通道、实时 bearer、捕获签名是否可用，「测试当前模式」会显示诊断。
- **401/403 可读 + 可自愈**：先读出 X 返回的真实错误体（例如 `{"code":32,"message":"Could not authenticate you."}`），再用 X 网页客户端公开 bearer 带原签名自动重试一次；仍失败才抛出含真实原因、已尝试两种 bearer 与诊断的中文错误，不再让用户做「重新登录」这种无用功。
- **降级报错收敛**：页面模式已弃用且必然写入失败，后台不再把它那一长串误导性提示怼给用户，只保留「站内直连失败：真实原因」+「测试当前模式 / 复制提示词手动流程」两条可操作建议。
- 回归测试扩到 **253 个场景**（新增 16 个：XVM 借用与回落、实时 bearer 优先级、强制公开 bearer、401 响应体、公开 bearer 重试成功/失败、XVM 捕获签名复用）。随后「简洁弹窗说明」改动再补 9 个 UI 契约断言，合计 **274 个场景**：设置弹窗与生态面板的长说明收进可点开的说明弹窗 / 折叠块，网页上的超长报错收敛成一句结论 + 可展开「详情」，并清掉重复的 `modeFixNote` 元素。版本仍为 1.4.2，重载扩展即可看到。

**隐私**：借用 XVM 只是在同一 X 页面调用它已暴露的函数，请求接收方仍是 X/Grok（提示词 + 推文正文），签名本机生成、后台只收 3 条文本；不新增第三方、不新增网络请求类型、不上传数据到 TapePost 服务器。

> 升级后请在 `chrome://extensions` 点 TapePost「重新加载」，再**刷新一次 X 页面**；「一键转发」title 应显示 `v1.4.2`。若你已安装 X Viral Monitor，它会在同页直接被复用。

### 1.4.1 修复：旧「页面模式」设置让 1.4.0 的直连从未生效

**真机排查**：用户点「AI 评论」仍报「提示词写入校验失败：Grok 输入框里混入了页面文字或没写进去」。浏览器插件真机确认按钮 title 已是 `v1.4.0`（用户确实重载过），但报错来自 `grok-page.js` 的 `setPrompt()`，且**没有**「此前站内直连也失败」前缀 —— 说明后台从一开始就把模式定成了 `page`，直连分支根本没进。

**根因**：直接读取 Chrome 的扩展同步存储（`~/Library/Application Support/Google/Chrome/Default/Sync Extension Settings/ophhheglggbkkmjdaemogfdekgmiobji/`）发现，用户设置里存的是显式 `grokMode="page"`（1.3.x 时代选的「X 站内 Grok」），另有 `grokPreferNative=true`。而 1.4.0 的 `pickGrokMode()` 是：

```js
if (mode !== 'auto') return mode;   // page 直接返回，后面的直连判断全被跳过
```

所以 1.4.0 新增的站内直连对这位用户**一次都没走过**，所有改进等于没上线。测试全都用 `auto` 场景，因此 224 个回归全过却没抓到。

**对照参考实现**：把本机 X Viral Monitor v1.18.17 的 `lib/grok-reply.js` / `lib/x-client-transaction.js` 逐项核对，端点、`generateTxId('POST', path)`、请求头（`authorization` / `x-csrf-token` / `x-client-transaction-id`）、请求体（`isTemporaryChat` / `MODEL_MODE_FAST`）与 TapePost 的 `grok-native.js` 完全一致，且 XVM 确实在 X 页面暴露 `window.__xvmXct` —— 直连实现本身没问题，问题只在模式路由。

**修复（三层保险，任意一层生效即可）**：

- `grok.js` / `pickGrokMode()`：显式 `page` 只要没关「优先站内直连」、没填 API Key、且消息来自 X 标签，就升级为 `native`；非 X 标签或用户关掉开关时仍是 `page`。
- `background.js` / `getGrokConfig()`：**运行时归一化** —— 每次读配置都把遗留 `page` 视作 `auto` 的免 Key 语义。不依赖 storage 迁移是否成功，**重载扩展后必定生效**。
- `content.js` / `popup.js`：**一次性设置迁移** —— 把 `grokMode:"page"` 写成 `"auto"` 并打标记；用户之后手动改回页面模式会被 `save()` 标记，不再被覆盖。popup 打开时会显示「✅ 已自动修复运行模式」。

另外把降级报错改成「站内直连失败：真实原因…；已降级到页面模式，但页面模式也失败：…」，避免页面模式的 `setPrompt` 报错盖住真正的失败原因；`setPrompt` 的错误文案也改成引导切到「自动 / 站内直连」，不再让用户刷新 Grok 页面做无用功。

- 回归测试扩到 **237 个场景**（新增 13 个：旧 `page` 模式路由、运行时归一化、真机事故回放端到端、设置迁移只写一次、用户主动选回 `page` 不被覆盖）。

> 升级后请在 `chrome://extensions` 点 TapePost「重新加载」，再**刷新一次 X 页面**；之后「一键转发」title 应是 `v1.4.1`。也可以只点开插件设置面板（popup 会自动纠正设置），然后刷新 X 页面。

### 1.4.0 重构：AI 评论改为直连 X 自带 Grok 接口

**背景**：1.3.4 修好按钮重复注入与正文污染后，用户仍反馈「AI 评论没反应 / 没读到 Grok 的回答块」。真机排查确认问题不在按钮，而在整条链路的设计：旧版往 `x.com/i/grok` 输入框填字 → 自动点发送 → 等整页文本静止 → 再从 DOM 里找回答块。X 的 React 重渲染、后台标签节流、扩展重载后的孤儿脚本，每一环都能让它失败。

**参考**：本机已安装的 X Viral Monitor v1.18.17（`lib/grok-reply.js`）之所以稳定，是因为它和 X 网页客户端一样**直接调用 X 内置 Grok 接口**，完全不做 DOM 自动化。TapePost 1.4.0 按同一原理独立实现：

- 新增 `grok-native.js`（MAIN world，`document_start`）与 `grok-native-bridge.js`（ISOLATED world 消息桥），后台把请求路由到**当前这个 X 标签**，不再新开/刷新 Grok 标签。
- 端点 `POST https://grok.x.com/2/grok/add_response.json`，请求体与 X「快速」模式一致（`isTemporaryChat: true`、关闭搜索/引用/服务器历史，不写进你的 Grok 历史）。
- 签名 `x-client-transaction-id` 三条路径：① 借用页面上已有的 X 原生签名器（X Viral Monitor 的 `__xvmXct`）；② 自己从 X 的 webpack `ondemand.s` 模块构建；③ 捕获 X 自己在 `/i/grok` 发出的真实请求头。`authorization` 优先用捕获的实时 bearer，兜底 X 网页客户端公开 bearer；`ct0` 从页面 cookie 读。
- 只解析 NDJSON 流里 `sender=ASSISTANT` + `messageTag=final` 的最终回答块；候选优先取 3 个 Markdown 代码块，其次 JSON 数组 / 编号列表。**思考过程、UI 词、任务标记一律不当候选**，解析不出就明确报错，不拿页面文字凑数。
- 模式路由：`auto` 且消息来自 X 标签时优先直连；`auto` 失败安静降级 `page`；显式 `native` 失败给中文错误；填了 API Key 仍走 `api`。设置里新增「优先站内直连」开关，`GROK_TEST` 会自检直连通道。
- 回归测试扩到 **224 个场景**（新增 54 个：NDJSON / 代码块 / JSON / 噪声解析、请求体与请求头、签名捕获、模式路由、端到端直连 / 降级 / 自检）。

> 升级后必须在 `chrome://extensions` 点 TapePost「重新加载」（manifest 新增了 MAIN world content script），再**刷新 X 页面**；之后点设置里的「测试当前模式」应显示「已确认 X 会话与站内 Grok 签名可用」。

### 1.3.4 修复：AI 评论把「AI 评论」当成推文正文发给 Grok

真机排查（浏览器 MCP 实拍）：用户点「AI 评论」后报「X 站内 Grok 没返回可用结果：没读到 Grok 的回答块」。Grok 页面截图显示提示词里的 `推文正文` 是**几十个「AI 评论」重复**，模型只回了一个 🤖，自然读不到回答块。X 标签 DOM 里回复填写区实际堆了 **33 个「AI 评论」按钮**。

根因：`injectIntoReplyComposers()` 用 `(host.children || []).filter(...)` 判断按钮是否已存在，但真实 DOM 的 `host.children` 是 **HTMLCollection，没有 `.filter`**，判断永远为 `false` → 每轮 MutationObserver 扫描都再注入一个。测试夹具把 `children` 做成数组，所以 1.3.1～1.3.3 的回归一直没抓到。

修复：

- `Array.prototype.filter/some.call(host.children, ...)` 正确判定；扫描时先清掉父节点已被 React 换掉的孤儿按钮，每个回复区只保留 1 个。
- 新增 `stripInjectedUi()` / `sanitizePostText()`：所有取正文路径（`textOfNode` / `contextTextFromScope` / 最终 `text`）都剥掉插件按钮文字与 X 界面文案。
- 新增 `replyTweetText(scope, card)`：评论正文**优先取 X 官方 `[data-testid="tweetText"]`**，避开回复框工具栏；启发式只作兜底。
- 清洗后正文为空时**直接取消并提示**，不再把界面文字发给 Grok、不再报误导性的「没读到回答块」。
- 补充识别：X 详情页内联回复框刷新后没有「Replying to」文案、只剩 `Reply` 发送按钮时，也能注入「AI 评论」，避免「按钮不见了 / 点了没反应」。
- 回归测试扩到 **170 个场景**，含 HTMLCollection 事故回放、按钮收敛、正文清洗、`tweetText` 优先、内联回复框识别。

> 升级后请在 `chrome://extensions` 点 TapePost「重新加载」，再刷新 X 页面；旧标签里的 33 个按钮会被新脚本自动收敛成 1 个。

### 1.3.3 修复：扩展重载后 X 标签连接失败（Receiving end does not exist）

真机复现：在 `chrome://extensions` 点「重新加载」后，之前打开过的 X 标签（尤其是后台自动新建的 `/i/grok?conversation=…` 对话标签）里留的是**旧扩展实例的 content script**，属于孤儿上下文。1.3.2 的 `ensurePageTab()` 在 ping 不通这个旧标签时仍把它返回，`sendToTab()` 随即抛出 Chrome 原生错误 `Could not establish connection. Receiving end does not exist.`。

对应修复：

- `sendToTab()` 识别 `Receiving end does not exist / Extension context invalidated` 等原生错误，转成**中文可操作指引**（刷新 X 页面 / 重建 Grok 标签），不再把英文报错原样弹给用户。
- `ensurePageTab()`：ping 不通的旧 `/i/grok` 标签**主动 `chrome.tabs.reload()` 一次**等新脚本注入；刷新后仍不通就**不再返回坏标签**，改为后台新建干净的 `/i/grok` 标签（新标签必定注入当前实例的 `grok-page.js`）。
- `callGrokPage()`：正式发消息时标签才失效也能自愈 —— 刷新同标签重试，救不回来强制新建标签再试一次。
- 设置面板新增 **「♻️ 重建 Grok 标签」**：刷新所有旧 Grok 对话标签 + 强制新建可用标签；`GROK_TEST` 连接测试同样会自愈。
- 刷新 / 新建标签只是浏览器本地操作，**不新增任何网络请求、不上传数据**。

回归测试扩到 **163 个场景**（新增 12 个：旧标签失效自愈、刷新无效新建标签兜底、新旧标签全失效的中文报错、发送阶段失效重试、一键重建、连接测试自愈）。

### 1.3.2 修复：X 站内 Grok 评论错乱 + 点击等待浮层

1.3.1 真机复现：候选面板显示 `History / Usage / Share` 三条，完全不是评论。真机排查确认 **Grok 确实被触发也回答了**，问题出在三个环节：

1. **提示词被污染**：`grok-page.js` 用 `execCommand('selectAll')` 清空输入框，在 X 的 React 页面里实际选中了整页，把侧栏文字、插件按钮「AI 评论」成片粘进 Grok 输入框，Grok 收到的是一堆乱码。
2. **读回答抓错容器**：`div[aria-label="Grok"]` 的 `innerText` 包含左侧栏和整条用户提示词；宽松 JSON 提取失败后按行兜底，正好把前三行 `History / Usage / Share` 当成 3 条候选返回。
3. **没有等待反馈**：网页版 Grok 会先输出思考过程，十几秒没有 UI 变化，原来只有一个 6 秒 toast。

对应修复：

- `setPrompt()` 改用 `Range.selectNodeContents(el)` **只选中输入框内部**，写入后用唯一任务标记 `【TapePost 任务开始】` 校验内容（标记必须靠前、长度不能超提示词 +160 字）；校验失败直接抛错，**绝不把脏提示词发出去**。
- 提示词首尾加 `PROMPT_TAG / PROMPT_END`，读回页面文本时整段切掉提示词区块，并按行丢弃 `History / Usage / Share / Thought for 7s` 等 UI 噪声。
- `parsePageAnswer()` 只接受清洗后的回答文本：严格 JSON → **裸引号列表**（网页版 Grok 实测会输出 `"…", "…", "…"` 而不带方括号）→ 编号列表 → 3 行独立候选；解析不出就明确报错，**不再把页面文字伪装成候选**。
- 自动发送后校验 `promptSent / hasAnswer / changed`，任一不满足就带诊断信息报错；候选面板顶部显示「✅ 已确认读到 Grok 回答」。
- **点击即弹出等待浮层**：spinner、随耗时推进的阶段文案、「关闭等待提示」按钮；结果回来或报错才自动关闭。手动「复制提示词 / 读取 Grok 回答」同样有等待反馈。

该版本回归测试扩到 **151 个场景**，含 1.3.1 事故回放、提示词污染拒绝发送、裸引号列表解析、真机整页噪声回放、等待浮层 DOM（1.3.3 扩到 163 个、1.3.4 扩到 170 个、1.4.0 扩到 224 个、1.4.1 扩到 237 个、1.4.2 扩到 253 个、文案精简后 262 个）。

### 1.3.1 新增：AI 评论按钮移到 X 回复填写区右侧

- 紫色「AI 评论」不再挂在推文卡片右上角。先点 X 推文的「回复」展开输入框，按钮就出现在**回复填写区右侧**；时间线内联回复框与 `/compose/post` 回复弹窗都支持（此前 `/compose/` 被整页排除，回复弹窗里根本看不到按钮）。
- 选中候选后**直接写回当前回复框**：`execCommand('insertText')` 触发真实 input 事件，X 的 React 受控输入框能识别；框里已有草稿时追加一行，不覆盖。文字同时进剪贴板。
- 找不到回复框或写入被拒时，才退回原来的 `intent/tweet?in_reply_to=...` 预填页 + 剪贴板兜底。
- 回写是页面内 DOM 操作，**不新增任何网络请求**；插件仍不替你点「回复」。
- 设置面板新增可编辑「回复框选择器」（留空用内置 `div[aria-label="Post text"][role="textbox"]` 等候选），X 改版时无需升版本即可自救。
- 选择器来源：2026-11-08 在已登录 x.com 上点「回复」后的实测 DOM（`div[aria-label="Post text"][role="textbox"]`、`Replying to @xxx`、`Post your reply`、Reply 按钮）。主发推框也用 `aria-label="Post text"`，靠上下文线索排除，不会误注入。

> 注：下面 1.1.0 章节描述的「推文卡片右上角按钮 / 打开 intent 预填」是历史行为，1.3.1 起以上述新流程为准。

### 1.1.0 新增：X 一键评论（Grok 生成 3 条候选）

X 推文右上角多一个紫色「AI 评论」按钮。点击后：

- 后台把你设定的提示词 + 该条推文正文（最多 1200 字符）发给 **xAI Grok**，按提示词生成 **3 条角度不同的回复候选**；
- 右下角浮层列出 3 条，每条可「用它回复」或「复制」，也能「重新生成」；
- 选中后打开 `x.com/intent/tweet?in_reply_to=<id>&text=...` 预填回复框，文字同时进剪贴板兜底；
- **最后一步「发送」仍由你手动点**，插件不调用任何发布接口。

提示词、模型（默认 `grok-4.3`）、接口协议（Chat Completions / Responses）、接口地址都可在设置里改。**1.3.0 起没有 API Key 也能用**：自动切到「X 站内 Grok」模式，把提示词填进 x.com 的 Grok 页面并读回结果，详见下一节。

### 1.3.0 新增：非 API 模式（X 站内 Grok）

**不填 xAI API Key 也能用 Grok。** 点插件图标 →「Grok 设置」→ 运行模式：

| 模式 | 行为 | 是否需要 Key / 费用 |
| --- | --- | --- |
| 自动（默认） | 填了 Key 走官方 API，没填就用 X 站内 Grok | 无需 Key / 免费 |
| X 站内 Grok | 把提示词填进你已登录的 `x.com/i/grok`（或 X 上的 Grok 浮窗），等回答稳定后读回解析 | 无需 Key / 免费 |
| xAI API | 后台直连 `api.x.ai`，原有链路 | 需要 Key / 按量计费 |

- 扩展**不调用任何 AI 接口、不产生费用、不接触 X 登录态**；对话完全发生在 X 自己的页面里。后台优先复用「已经有 Grok 输入框」的 X 标签，没有才在后台新开一个 `/i/grok` 标签（不抢焦点）。
- 两套提示词在两种模式下共用；页面模式会把 system 指令合并进同一条消息，并额外追加「只输出最终 JSON、不要展示思考过程」的约束（实测网页版 Grok 会先吐一段思考过程）。还可写「页面模式附加要求」，并用「预览实际发送内容」查看完整文本。
- 实测选择器（2026-11-08）：输入框 `div[aria-label="Ask anything"][role="textbox"]`、发送 `button[aria-label="Send"]`、对话区 `div[aria-label="Grok"]`、回答锚点 `button[aria-label="Copy"]`。全部可在设置里改，X 改版不用升级扩展。
- **手动兜底**：关掉「自动点发送」，或直接用面板 / 评论浮层里的「复制提示词 → 自己粘贴发送 → 读取 Grok 回答」，选择器失效时照样能用。
- 需要 Chrome 已登录 `x.com` 且账号可用 Grok；X 的 Grok 有使用额度与权限限制，插件无法绕过。页面模式生成速度取决于 X，比 API 慢（默认最多等 60 秒）。

### TapeOut 生态面板（1.2.0：生态导航全量收录）

点工具栏图标里的「打开 TapeOut 生态面板」，会打开一个独立的扩展页。绿标清单来自 **TapeOut.link 生态导航收录的全部链接**，共 **295 条**，分三档：

| 档位 | 数量 | 含义 |
| --- | ---: | --- |
| 项目方官方 | 5 | 导航站带 `OFFICIAL` 标记的官方入口 |
| 生态导航收录认可 | 56 | 导航站编辑收录的第三方交易、数据、工具、社区、链游等 |
| 链上容器 · 已索引 | 234 | `web.tapeout.link` 扫描索引到的 DeWeb 容器，按官方网关精确子域比对 |

三档**都算导航认可并给绿标**，但界面明确区分等级 —— 链上容器的内容由容器所有者部署，**不代表项目方背书**。清单核验日期 2026-11-08，内置在 `grok.js` 的 GENERATED 区块里。

- **链接真伪查询**：粘贴任意链接 → 本地清单先精确比对 → Grok 按设定提示词结合本地权威结论给出解释与仿冒风险（形近域名、Punycode、短链、非 HTTPS、第三方网关）；
- **防伪底线**：结论以本地清单为准，Grok 不能把清单外的链接判成认可平台；两者冲突会在界面标红提示。即使 Grok 不可用，本地判定依然有效；
- **安全边界**：只有 4 个独立官网域名允许「同域任意路径 / 子域」，网关域名一律精确比对；未索引的容器子域、其它 X 账号 / Telegram 群、形近域名都拿不到绿标；
- 面板提供搜索、三档筛选、一键核验与「复制 / 打开」；一次最多渲染 120 张卡片，其余用搜索定位，但**全部 295 条都参与核验**。

清单是**本地内置静态数据**，运行时不联网拉取。要刷新清单：`node tools/refresh-sites.mjs`（从 `https://tapeout.link/data/sites.js` 与 `https://web.tapeout.link/api/sites` 重新生成，断网可加 `--offline` 用缓存），然后提升扩展版本号。

> 从 1.1.0 升级且手动改过「核验提示词」的用户，请在设置里点一次「恢复默认核验提示词」，新版提示词会带上 `{LOCAL_RESULT}` 本地权威结论占位符。

## 支持的站点

| 站点 | 正文 | 配图 | 备注 |
| --- | --- | --- | --- |
| 微博 | 支持 | 九宫格 | Referer 注入、底部水印检测、高清视频接口兜底 |
| 知乎 | 支持 | 全部内容图 | zhimg.com 图床 |
| 微信公众号 | 支持 | 全部内容图 | qpic.cn 图床 |
| B 站动态 | 支持 | 全部内容图 | hdslb.com / bfsstatic.com |
| 豆瓣广播 | 支持 | 全部内容图 | doubanio.com |
| 小红书 | 支持 | 全部内容图 | 图片地址带时效签名，失败请刷新重试 |
| X / Twitter | 支持 | 原图参数升级 | `article[data-testid="tweet"]`，发布/登录/注册页不注入；另有「AI 评论」 |

每个站点都有独立的选择器、图床域名、Referer 与水印策略，并可在设置里逐个开关；未配置的网站不会注入任何界面。

## 安装

**Chrome 网上应用店**：1.4.2 已打包完成，首次上架需要开发者本人在 [Developer Dashboard](https://chrome.google.com/webstore/devconsole) 完成注册并创建条目，见 `store/listing.json`。

**本地加载（开发者模式）**

1. 克隆本仓库：`git clone https://github.com/kenter1643/TapePost.git`
2. 打开 `chrome://extensions`，打开右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选择**仓库根目录**（`manifest.json` 所在目录）
4. 打开任一支持的站点，内容右上角出现「一键转发」即可使用
5. 要用 AI 评论 / 链接核验：默认「自动」模式，在 X 页面里直连 X 自带 Grok（免费、免 Key、最稳定），失败才降级旧的页面模式；想走官方 API 才在「Grok 设置 → API 模式专属设置」填 Key 并点「测试当前模式」

商店提交包 `store/TapePost_1.4.2_store.zip` 随仓库分发，也可在[介绍页](https://kenter1643.github.io/TapePost/)直接下载（介绍页附带副本 `docs/assets/TapePost_1.4.2_store.zip`）。解压后在 `chrome://extensions` 以开发者模式加载即可。自行重新打包：

```bash
zip -q store/TapePost_1.4.2_store.zip \
  manifest.json account.js sites.js grok.js grok-page.js grok-native.js grok-native-bridge.js \
  background.js content.js inpaint.js \
  offscreen.html offscreen.js popup.html popup.js panel.html panel.js \
  icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png
```

## 设置

点工具栏图标打开设置面板：

- **转发**：图片去水印（默认开）、视频取原片、正文 `#` 话题的三种处理方式、附原推链接、附个人署名、X 域名、7 个站点开关；
- **Grok**：运行模式（自动 / X 站内 Grok / xAI API）、两套可编辑提示词 + 页面模式附加要求 + 「预览实际发送内容」、页面选择器与自动发送/新建对话开关、打开 Grok 页面；API 模式专属：xAI API Key、接口协议、模型 ID、接口地址、测试连接、允许自定义网关域名；
- **工具**：「🔍 运行环境自检」（Service Worker / DNR 规则 / 离屏文档状态）、「打开 TapeOut 生态面板」。

密钥与接口配置只存 `chrome.storage.local`（本机、不同步、不入库）；模式、页面选择器、偏好与提示词存 `chrome.storage.sync`。提示词留空＝用 `grok.js` 内置默认；删掉 `{POST}` / `{LOCAL_RESULT}` / `{OFFICIAL_LIST}` / `{URL}` 占位符时，插件会自动把对应内容补到提示词末尾。

插件内置的 X 账号与社区身份在 `account.js`；改名或换号只改这一处。

## 目录结构

```
.
├── manifest.json          # MV3 清单（权限 / 主机权限 / content scripts）
├── account.js             # 内置账号与社区身份（单一来源）
├── sites.js               # 7 个站点的配置表与 detectSite()
├── grok.js                # 295 条收录清单、URL 防伪判定、提示词、模式路由与结果解析（共享层）
├── grok-page.js           # 注入 x.com 的页面模式桥接：填提示词 / 点发送 / 读回答
├── content.js             # 按钮注入、正文/配图提取、多图托盘、X 评论候选浮层
├── background.js          # Service Worker：DNR 规则、消息路由、Grok 双模式客户端、下载
├── offscreen.html/js      # 离屏文档：Canvas 去水印、剪贴板写入、视频地址解析
├── inpaint.js             # 纯 JS 水印检测与重建
├── popup.html/js          # 设置面板（转发 / Grok / 面板入口）
├── panel.html/js          # TapeOut 生态面板（绿标清单 + 链接真伪查询）
├── test-harness.js        # Node 端到端回归（无需浏览器）
├── tools/refresh-sites.mjs # 从导航站公开数据重新生成收录清单
├── docs/                  # GitHub Pages：介绍页 + 隐私政策 + 静态资源
└── store/                 # 上架素材：listing.json、截图、宣传图、上传脚本
```

## 开发与测试

```bash
node test-harness.js                  # 163 个场景：转发链路 + 全量清单防伪 + 分级判定 + 回复框按钮注入/候选回写 + 非 API 页面模式端到端
WBX_VERBOSE=1 node test-harness.js   # 打印详细流水
```

改动 `content.js` 后记得在 `chrome://extensions` 点刷新，并刷新来源站页面；扩展有「上下文已失效」提示时按提示刷新即可。

## 上架 Chrome Web Store

`store/listing.json` 里已备好名称、摘要、详细描述、分类、单一用途、逐项权限理由、数据使用披露、审核员验证步骤与提交清单；`store/upload.mjs` 用官方 API v2 做后续版本的上传 / 查状态 / 发布（凭证只从环境变量读取，不落盘）。

注意：Chrome Web Store API v2 **没有新建条目接口**，首个版本必须由开发者本人在 Dashboard 点「Add new item」上传 zip 创建条目，拿到 `ITEM_ID` / `PUBLISHER_ID` 并配置 OAuth 后，脚本才能更新后续版本。当前版本的数据使用披露里 `transmits_data_off_device` 已改为 `true`：站内直连会把用户点选的文字/链接发送给 X/Grok（填了 Key 走 API 时发给 xAI），提交表单时务必如实勾选。

## 隐私

**转发链路纯本地**：无自有服务器、无账号、无遥测、无远程代码。所有提取、去水印、剪贴板写入与下载都发生在本机。

**转发全链路纯本地**。**AI 功能分两种模式**：① `api` 模式：只有你主动点「AI 评论」/「核验链接」并填了自己的 Key，扩展才把推文正文或待核验链接（连同本地结论、清单摘要、提示词）发给 `api.x.ai` 或自填网关；② `page` 模式（免 Key）：扩展**不向任何 AI 服务发请求**，只把提示词填进你已登录的 X 站内 Grok 页面、由 X 完成对话，再读取该页回答文本在本机解析 —— 这段对话受 X 的条款与隐私政策约束。两种模式都不发送浏览历史、Cookie、登录态、图片文件或其它标签页内容；插件也不读取或存储 X 的登录凭据。

完整说明见 [隐私政策](https://kenter1643.github.io/TapePost/privacy.html)（源码 `docs/privacy.html`）。

## 已知边界

- X 视频通常是 HLS / blob 流，暂不能导出干净 mp4；其它站点只能取页面里出现的图片 / 视频直链。
- 各站水印样式不同，检测不到时一律原图保留，不会强行抹图。
- AI 功能默认不需要 Key：走 X 站内 Grok 页面模式（需登录 X 且账号可用 Grok）；若要走官方 API，才需自备 xAI Key 与可用网络，国内直连 `api.x.ai` 可能失败，需代理或兼容网关。API 调用费用由你承担。
- 页面模式依赖 X 网页版 Grok 的 DOM 结构（输入框 / 发送按钮 / 回答复制按钮）。X 改版可能导致自动填词或读取失效：设置里所有选择器都可编辑，另有「复制提示词 → 自己粘贴发送 → 读取 Grok 回答」的手动兜底，不会静默失败。网页版 Grok 会输出思考过程且不一定严守 JSON 格式，插件已做宽松 JSON 提取，解析失败会在界面明确提示。
- 官方清单是 2026-11-08 从 TapeOut.link 抓取的静态快照，官方后续增删条目需手动更新 `grok.js`；Grok 的核验结论仅供参考，访问链上平台前请再次核对地址。
- 需要你已登录 X；商店截图目前是功能示意图，正式上架建议替换为真机截图。

转载他人内容前请确认授权，建议开启「附原推链接」标注来源。TapePost 与 X、xAI、TapeOut 官方及上述任何站点均无官方关联，绿标清单不构成背书或投资建议。

## 许可

[MIT](LICENSE) © 2026 TapeOut Community
