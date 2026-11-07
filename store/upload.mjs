#!/usr/bin/env node
/**
 * TapePost · Chrome Web Store API 上传 / 发布脚本（零第三方依赖，Node 18+）
 *
 * 前置条件（必须由开发者本人完成，脚本无法代做）：
 *   1. Google 账号登录 https://chrome.google.com/webstore/devconsole 并完成一次性开发者注册（US$5）
 *   2. 账号开启两步验证（发布/更新扩展的硬性要求）
 *   3. 在 Dashboard 手动「Add new item」创建条目并上传一次 zip，拿到 ITEM_ID
 *      —— Chrome Web Store API v2 不提供「新建条目」接口，只能更新已有条目
 *   4. 在 Google Cloud Console 建 OAuth 客户端，用 scope
 *      https://www.googleapis.com/auth/chromewebstore 换到 refresh token
 *   5. Publisher ID 在 Dashboard → Publisher → Settings 里查看
 *
 * 环境变量：
 *   CWS_CLIENT_ID / CWS_CLIENT_SECRET / CWS_REFRESH_TOKEN   必填
 *   CWS_ITEM_ID                                              upload/publish/status 必填
 *   CWS_PUBLISHER_ID                                         v2 模式必填
 *   CWS_API=v2|v1.1                                          默认 v2（官方现行 API）
 *   CWS_ZIP                                                  默认 store/TapePost_1.0.0_store.zip
 *
 * 用法：
 *   node store/upload.mjs --mode upload     # 上传新版本（不发布，留在草稿）
 *   node store/upload.mjs --mode status     # 查询上传/审核状态
 *   node store/upload.mjs --mode publish    # 提交审核并发布
 *
 * 安全：本脚本不保存任何密钥；所有凭证只从环境变量读取。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, cur, i, arr) => {
  if (cur.startsWith('--')) {
    const key = cur.slice(2);
    const next = arr[i + 1];
    acc.push([key, next && !next.startsWith('--') ? next : 'true']);
  }
  return acc;
}, []));

const mode = args.mode || 'upload';
const api = (process.env.CWS_API || args.api || 'v2').toLowerCase();
const zipPath = path.resolve(process.env.CWS_ZIP || args.zip || path.join(HERE, 'TapePost_1.0.0_store.zip'));
const itemId = process.env.CWS_ITEM_ID || args.item;
const publisherId = process.env.CWS_PUBLISHER_ID || args.publisher;

function need(name, value) {
  if (!value) throw new Error(`缺少 ${name}，请通过环境变量或参数提供`);
  return value;
}

async function accessToken() {
  const body = new URLSearchParams({
    client_id: need('CWS_CLIENT_ID', process.env.CWS_CLIENT_ID),
    client_secret: need('CWS_CLIENT_SECRET', process.env.CWS_CLIENT_SECRET),
    refresh_token: need('CWS_REFRESH_TOKEN', process.env.CWS_REFRESH_TOKEN),
    grant_type: 'refresh_token'
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const j = await r.json();
  if (!r.ok) throw new Error('换取 access token 失败：' + JSON.stringify(j));
  return j.access_token;
}

function endpoints(item, publisher) {
  if (api === 'v1.1') {
    const base = 'https://www.googleapis.com/chromewebstore/v1.1/items';
    const up = 'https://www.googleapis.com/upload/chromewebstore/v1.1/items';
    return {
      upload: `${up}/${item}`, methodUpload: 'PUT',
      publish: `${base}/${item}/publish`,
      status: `${base}/${item}?projection=DRAFT`,
      insert: up
    };
  }
  const base = `https://chromewebstore.googleapis.com/v2/publishers/${publisher}/items/${item}`;
  return {
    upload: `https://chromewebstore.googleapis.com/upload/v2/publishers/${publisher}/items/${item}:upload`,
    methodUpload: 'POST',
    publish: `${base}:publish`,
    status: `${base}:fetchStatus`,
    insert: null
  };
}

async function call(url, token, opts = {}) {
  const r = await fetch(url, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(api === 'v1.1' ? { 'x-goog-api-version': '2' } : {}),
      ...(opts.body ? { 'Content-Type': 'application/zip' } : {}),
      ...(opts.headers || {})
    },
    body: opts.body
  });
  const txt = await r.text();
  let j;
  try { j = JSON.parse(txt); } catch { j = { raw: txt.slice(0, 500) }; }
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}: ${JSON.stringify(j)}`);
  return j;
}

async function main() {
  const token = await accessToken();
  const ep = endpoints(need('CWS_ITEM_ID', itemId), api === 'v2' ? need('CWS_PUBLISHER_ID', publisherId) : '');

  if (mode === 'upload') {
    if (!fs.existsSync(zipPath)) throw new Error('找不到 zip：' + zipPath);
    const buf = fs.readFileSync(zipPath);
    console.log(`上传 ${path.relative(ROOT, zipPath)} (${(buf.length / 1024).toFixed(1)} KB) → ${api} API …`);
    const out = await call(ep.upload, token, { method: ep.methodUpload, body: buf });
    console.log('上传结果：', JSON.stringify(out, null, 2));
    console.log('\n下一步：在 Dashboard 填好 Store listing / Privacy 并确认无误后，运行');
    console.log('  node store/upload.mjs --mode publish');
    return;
  }
  if (mode === 'status') {
    console.log('状态：', JSON.stringify(await call(ep.status, token), null, 2));
    return;
  }
  if (mode === 'publish') {
    console.log('提交审核并发布 …');
    console.log('结果：', JSON.stringify(await call(ep.publish, token, { method: 'POST' }), null, 2));
    return;
  }
  if (mode === 'insert') {
    if (api !== 'v1.1' || !ep.insert) throw new Error('新建条目只能在 Dashboard 手动创建（v2 API 不支持）；或显式用 --api v1.1 试旧接口');
    const buf = fs.readFileSync(zipPath);
    console.log('用旧版接口新建条目 …');
    console.log('结果：', JSON.stringify(await call(ep.insert, token, { method: 'POST', body: buf }), null, 2));
    return;
  }
  throw new Error('未知 --mode：' + mode);
}

main().catch((e) => { console.error('❌', e.message); process.exitCode = 1; });
