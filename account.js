/*
 * account.js — 插件内置的「我的 X 账号」信息（单一来源）
 *
 * 内容脚本、设置弹窗共用这一份配置；以后改名/换号只改这里。
 * 注意：这是全局 const，需要在 content.js / popup.js 之前加载。
 */
'use strict';

const X_ACCOUNT = {
  name: '昆哥',
  handle: 'YikunChen1983',
  url: 'https://x.com/YikunChen1983',
  // 设置面板里的社区身份标注（只做展示，不写进转发正文）
  community: 'TapeOut社区成员：昆哥'
};

// 便于 node 侧测试引用；浏览器里 module 不存在，忽略即可
if (typeof module !== 'undefined' && module.exports) {
  module.exports = X_ACCOUNT;
}
