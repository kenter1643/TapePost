# TapePost · 一键转发到 X

> 在内容页点一下，把正文和配图整理成 X 草稿素材。**发送始终由你手动完成，扩展不会替你发帖。**

- 介绍页：<https://kenter1643.github.io/TapePost/>
- 隐私政策：<https://kenter1643.github.io/TapePost/privacy.html>
- 源码：<https://github.com/kenter1643/TapePost>
- 版本：1.0.0　｜　Manifest V3　｜　Chrome 116+

![TapePost 功能示意](docs/assets/screenshots/01_overview_1280x800.png)

## 它做什么

在微博、知乎、微信公众号、B 站动态、豆瓣广播、小红书、X 的内容右上角注入一个橙色「一键转发」按钮。点击后：

1. **只取这一条**：按正文锚点定位，剥掉昵称、时间、认证标签、话题尾巴等元信息；按钮点击时实时重新解析卡片，避免无限滚动的 DOM 复用导致抓错内容。
2. **取全部配图**：九宫格、多个媒体容器、懒加载属性、CSS 背景图、内联 `pic_infos`、X 的 `name=orig` 原图，最多 9 张；自动排除头像等干扰图。
3. **本地去水印**：Canvas 先检测底部白色水印，只在命中时用包围盒插值 / BFS 重建；没检测到的图原样保留，不会强行抹图。
4. **多图托盘**：右下角弹出「干净图 N 张」，可逐张复制、拼长图、全部下载；托盘就绪后再点按钮打开 X，避免 X 抢焦点。
5. **文字预填**：清洗后的正文通过 `x.com/intent/tweet?text=...` 预填到发推框，你在 X 里粘贴图片、确认内容后**手动点发送**。

## 支持的站点

| 站点 | 正文 | 配图 | 备注 |
| --- | --- | --- | --- |
| 微博 | 支持 | 九宫格 | Referer 注入、底部水印检测、高清视频接口兜底 |
| 知乎 | 支持 | 全部内容图 | zhimg.com 图床 |
| 微信公众号 | 支持 | 全部内容图 | qpic.cn 图床 |
| B 站动态 | 支持 | 全部内容图 | hdslb.com / bfsstatic.com |
| 豆瓣广播 | 支持 | 全部内容图 | doubanio.com |
| 小红书 | 支持 | 全部内容图 | 图片地址带时效签名，失败请刷新重试 |
| X / Twitter | 支持 | 原图参数升级 | `article[data-testid="tweet"]`，发布/登录/注册页不注入 |

每个站点都有独立的选择器、图床域名、Referer 与水印策略，并可在设置里逐个开关；未配置的网站不会注入任何界面。

## 安装

**Chrome 网上应用店**：1.0.0 已打包完成，首次上架需要开发者本人在 [Developer Dashboard](https://chrome.google.com/webstore/devconsole) 完成注册并创建条目，见 `store/listing.json`。

**本地加载（开发者模式）**

1. 克隆本仓库：`git clone https://github.com/kenter1643/TapePost.git`
2. 打开 `chrome://extensions`，打开右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选择**仓库根目录**（`manifest.json` 所在目录）
4. 打开任一支持的站点，内容右上角出现「一键转发」即可使用

商店提交包 `store/TapePost_1.0.0_store.zip` 随仓库分发，也可在[介绍页](https://kenter1643.github.io/TapePost/)直接下载（介绍页附带副本 `docs/assets/TapePost_1.0.0_store.zip`）。解压后在 `chrome://extensions` 以开发者模式加载即可。自行重新打包：

```bash
zip -q store/TapePost_1.0.0_store.zip \
  manifest.json account.js background.js content.js inpaint.js sites.js \
  offscreen.html offscreen.js popup.html popup.js \
  icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png
```

## 设置

点工具栏图标打开设置面板：图片去水印（默认开）、视频取原片、正文 `#` 话题的三种处理方式、附原推链接、附个人署名、X 域名、7 个站点开关，以及「🔍 运行环境自检」（查看 Service Worker / DNR 规则 / 离屏文档状态）。

插件内置的 X 账号与社区身份在 `account.js`；改名或换号只改这一处。

## 目录结构

```
.
├── manifest.json          # MV3 清单（权限 / 主机权限 / content scripts）
├── account.js             # 内置账号与社区身份（单一来源）
├── sites.js               # 7 个站点的配置表与 detectSite()
├── content.js             # 内容识别、按钮注入、正文/配图提取、多图托盘
├── background.js          # Service Worker：消息路由、DNR Referer 规则、下载
├── offscreen.html/js      # 离屏文档：Canvas 去水印、剪贴板写入、视频地址解析
├── inpaint.js             # 纯 JS 水印检测与重建
├── popup.html/js          # 设置面板
├── test-harness.js        # Node 端到端回归（无需浏览器）
├── docs/                  # GitHub Pages：介绍页 + 隐私政策 + 静态资源
└── store/                 # 上架素材：listing.json、截图、宣传图、上传脚本
```

## 开发与测试

```bash
node test-harness.js                  # 43 个场景，模拟 MV3 消息链路端到端跑一次
WBX_VERBOSE=1 node test-harness.js   # 打印详细流水
```

改动 `content.js` 后记得在 `chrome://extensions` 点刷新，并刷新来源站页面；扩展有「上下文已失效」提示时按提示刷新即可。

## 上架 Chrome Web Store

`store/listing.json` 里已备好名称、摘要、详细描述、分类、单一用途、逐项权限理由、审核员验证步骤与提交清单；`store/upload.mjs` 用官方 API v2 做后续版本的上传 / 查状态 / 发布（凭证只从环境变量读取，不落盘）。

注意：Chrome Web Store API v2 **没有新建条目接口**，首个版本必须由开发者本人在 Dashboard 点「Add new item」上传 zip 创建条目，拿到 `ITEM_ID` / `PUBLISHER_ID` 并配置 OAuth 后，脚本才能更新后续版本。脚本用法与所需环境变量见 `store/upload.mjs` 文件头。

## 隐私

无服务器、无账号、无遥测、无远程代码。所有提取、去水印、剪贴板写入与下载都发生在本机；设置仅保存在 `chrome.storage.local`。完整说明见 [隐私政策](https://kenter1643.github.io/TapePost/privacy.html)（源码 `docs/privacy.html`）。

## 已知边界

- X 视频通常是 HLS / blob 流，暂不能导出干净 mp4；其它站点只能取页面里出现的图片 / 视频直链。
- 各站水印样式不同，检测不到时一律原图保留，不会强行抹图。
- 需要你已登录 X；部分地区的网络可达性由你自行解决。
- 商店截图目前是功能示意图，正式上架建议替换为真机截图。

转载他人内容前请确认授权，建议开启「附原推链接」标注来源。TapePost 与 X 及上述任何站点均无官方关联。

## 许可

[MIT](LICENSE) © 2026 TapeOut Community
