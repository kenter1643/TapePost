# TapePost v1.4.2 宣传稿（未上架商店 · GitHub 安装版）

> 用途：Chrome 网上应用店尚未上架，对外统一引导「先从 GitHub / 介绍页装」。
> 适用版本：TapePost 1.4.2（Manifest V3 / Chrome 116+）
> 仓库：https://github.com/kenter1643/TapePost
> 介绍页：https://kenter1643.github.io/TapePost/
> 直链下载：https://kenter1643.github.io/TapePost/assets/TapePost_1.4.2_store.zip
> 署名：TapeOut 社区成员：昆哥 · X @YikunChen1983

---

## 一、一句话版（群公告 / 签名 / 置顶简介）

TapePost v1.4.2 已开源，商店还没上架，先从 GitHub 装：7 站一键转发到 X、本地去水印、免 Key 的 AI 评论候选、295 条 TapeOut 链接核验，全程手动发送、无后端。https://kenter1643.github.io/TapePost/

---

## 二、X / 微博短帖（可直接发，中文）

```
TapePost v1.4.2。商店还没上架，先走 GitHub 开源安装。

7 站一键转发到 X：正文清洗、最多 9 图、本地去水印；X 回复框右侧「AI 评论」免 Key 出 3 条候选；295 条 TapeOut 收录清单核验链接。手动发送，无后端无遥测。

装法 ↓
https://kenter1643.github.io/TapePost/
```

（约 250 / 280 字符单位，X 单条可直接发；发微博可把最后链接换成 GitHub 仓库地址。）

## 三、X 短帖（英文，面向国际F注者）

```
TapePost v1.4.2 is live on GitHub (Chrome Web Store listing still pending).

One-click crosspost from 7 sites to X: clean text, up to 9 images, local watermark removal, 3 Grok-generated reply drafts with no API key, plus a 295-link TapeOut allowlist. Nothing is posted for you. Open source, no backend.

Install: https://kenter1643.github.io/TapePost/
```

## 四、X 串帖（3 条，适合置顶）

**1/3**
TapePost v1.4.2 发布了，商店还在走开发者流程，暂时搜不到 —— 源码和提交包都在 GitHub，装完和商店版完全一样。
介绍页：https://kenter1643.github.io/TapePost/ ｜ 源码：https://github.com/kenter1643/TapePost

**2/3**
它做三件事：
· 微博 / 知乎 / 公众号 / B 站动态 / 豆瓣 / 小红书 / X 的内容右上角加「一键转发」，只取这一条正文、收齐最多 9 张图、本机去水印，文字预填到 X 发推框；
· X 回复框右侧「AI 评论」，免 API Key 走站内 Grok 直连，出 3 条候选写回回复框（1.4.2 已修好 401 认证）；
· TapeOut 生态面板内置 295 条导航收录清单，绿标分级 + 链接真伪核验。

**3/3**
不代发：转发只预填 + 给干净图，评论只给候选，最后一步永远是你自己点。
去水印、文字清洗、剪贴板全在本机，无后端、无遥测、MIT 开源可审代码。
安装 4 步：下载 zip → 解压 → chrome://extensions 开「开发者模式」→「加载已解压的扩展程序」选解压目录。详情见介绍页。

---

## 五、完整版（社群长帖 / 公众号 / 朋友圈 / 项目介绍）

# TapePost v1.4.2：商店还没上架，先从 GitHub 装

做内容搬运最烦的不是写，是「复制正文 → 一张张存图 → 去掉水印 → 再贴到 X」这一串。TapePost 就是把这一串压成一次点击。

**先说清楚一件事**：Chrome 网上应用店的开发者注册流程还没走完，所以现在在商店里搜不到 TapePost。代码、说明、以及准备提交的完整扩展包都已经放在 GitHub，用「开发者模式」加载即可，功能和商店版没有区别。等上架了会再通知，届时可以直接切过去。

### 它能做什么

**1. 七个站点，一键转发到 X**
微博、知乎、微信公众号、B 站动态、豆瓣、小红书、X。内容右上角会出现一个很小的橙色「一键转发」按钮，点一下：

- 只取这一条：按正文锚点定位，剥掉昵称、时间、认证标签、话题尾巴，滚动后也不会抓错卡片；
- 收齐配图：九宫格、多个媒体容器、懒加载、内联图数据都认，最多 9 张，自动排除头像；
- 本地去水印：Canvas 先检测到底部水印才处理，没命中就原样保留，不强行抹图；
- 多图托盘：右下角「干净图 N 张」，逐张复制、拼长图或全部下载；
- 文字预填到 X 发推框，图片粘贴、点发送，都由你手动完成。

**2. X 回复框右侧的「AI 评论」**
点开任意推文的「回复」，输入框右边会多一个按钮。点击后有等待提示，用你设定的提示词生成 3 条回复候选，选中哪条就写回哪个回复框。默认「自动 / 站内直连」，走 X 自带 Grok，**不需要 xAI API Key、不产生费用**；1.4.2 把之前真实遇到的 401 认证失败修好了（实时 bearer、复用捕获签名、读取真实错误并自动重试），如果你也装了 X Viral Monitor，会优先借用它的稳定通道。想用官方 API 才需要在设置里填自己的 Key。

**3. TapeOut 生态面板与链接核验**
内置 295 条 TapeOut.link 导航收录清单，绿标分级，配合链路核验判断一个链接是不是官方认可、有没有仿冒。清单是静态内置数据，不联网拉取、不整份上传。

### 为什么先走 GitHub

商店条目要等开发者注册完成才能创建，但工具本身已经迭代到 1.4.2、回归测试 262 个场景全通过，没必要让大家干等。GitHub 上的 zip 就是准备提交商店的那 20 个文件，源码 MIT 开源，能自己看、自己改、自己打包。

### 安装：两种方式，都不用命令行也行

**方式 A：下载 zip（推荐）**

1. 打开介绍页 https://kenter1643.github.io/TapePost/ ，点「下载扩展包 v1.4.2」；或直接用直链 https://kenter1643.github.io/TapePost/assets/TapePost_1.4.2_store.zip
2. 解压到一个**固定文件夹**（别删，Chrome 会一直引用这个目录）
3. 地址栏输入 `chrome://extensions`，打开右上角「开发者模式」
4. 点「加载已解压的扩展程序」，选择刚才解压出来、里面能看到 `manifest.json` 的那一层目录
5. 打开微博 / 知乎 / X 任一站点，内容右上角出现橙色「一键转发」即装好

**方式 B：克隆仓库（方便以后升级）**

```
git clone https://github.com/kenter1643/TapePost.git
```

在 `chrome://extensions` 里「加载已解压的扩展程序」选仓库根目录即可；以后 `git pull` 再点扩展卡片上的刷新图标就是升级。

**升级到 1.4.2 的注意点**：在 `chrome://extensions` 点 TapePost 的「重新加载」，然后**刷新一次 X 页面**；把鼠标悬停在「一键转发」上，title 显示 `v1.4.2` 就是新版。设置里「测试当前模式」可以自检站内 Grok 通道。

### 几个常被问到的问题

- **会替我发推或评论吗？** 不会。转发只预填文字、把干净图写进剪贴板 / 下载到本机；AI 评论只生成 3 条候选并写回回复框。扩展不调用任何发布接口，最后一步永远是你手动点。
- **要花钱 / 要 API Key 吗？** 默认不用，走 X 站内 Grok；只有你主动填 Key 走 xAI 官方 API 时才产生费用，由你自己承担。
- **数据安全吗？** 文字清洗、去水印、剪贴板、下载全在本机；不收集浏览历史、Cookie、X 登录态、其它标签页内容，不上传图片视频，没有后端也不做遥测。源码 MIT 开源可审，隐私政策：https://kenter1643.github.io/TapePost/privacy.html
- **Chrome 版本？** Chrome 116+（Manifest V3）。小红书图片地址带时效签名，偶尔下载失败时刷新来源页再点一次即可。
- **商店什么时候上架？** 开发者注册流程走完再说，届时会在仓库和介绍页同步。现在请用 GitHub 方式安装。

有问题或想加站点，直接开 issue：https://github.com/kenter1643/TapePost/issues

—— TapeOut 社区成员：昆哥 · X @YikunChen1983

---

## 六、安装卡片（可单独截图发群）

```
TapePost v1.4.2 · 商店未上架，GitHub 安装

1. 下载  https://kenter1643.github.io/TapePost/assets/TapePost_1.4.2_store.zip
2. 解压  放到一个不会删的固定文件夹
3. 打开  chrome://extensions → 右上角开「开发者模式」
4. 加载  「加载已解压的扩展程序」→ 选含 manifest.json 的目录
5. 验证  刷新页面，内容右上角出现橙色「一键转发」

升级：扩展页点「重新加载」+ 刷新一次 X 页面，悬停按钮显示 v1.4.2
源码：https://github.com/kenter1643/TapePost
```

---

## 七、发布前自检（内部用，不对外发）

- 版本号统一写 **1.4.2**，不要写「已上架」或「商店可搜到」。
- 商店状态的口径：开发者注册流程未完成，暂未上架；不要提注册费点击无反应的细节。
- 下载链接优先给介绍页（有图文说明），直链 zip 作为备用；仓库地址给 GitHub。
- 功能表述边界：不代发、默认免 API Key、去水印在本机、清单为内置静态数据。
- 「AI 评论」不要写成「自动评论」，是生成候选 + 手动回复。
- 已核实：仓库 main 已同步最新提交，README / 介绍页 / 两份 zip 均为 1.4.2，回归 262/262 通过。
