#!/usr/bin/env node
/* TapePost · X 增长计划内核离线测试（1.5.26 · 1.5.28） */
'use strict';
const assert = require('assert');
const G = require('./growth-core.js');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}
function eq(name, a, b) { ok(name + ' (' + JSON.stringify(a) + ' === ' + JSON.stringify(b) + ')', a === b); }

const T = Date.parse('2026-11-22T12:00:00Z');   // 北京 11-22 20:00
const NEXT = Date.parse('2026-11-22T16:00:00Z'); // 北京 11-23 00:00

console.log('== 1. 北京时间切天 ==');
eq('UTC 12:00 → 北京 11-22', G.dayKey(T), '2026-11-22');
eq('UTC 16:00 → 北京 11-23（跨天）', G.dayKey(NEXT), '2026-11-23');
eq('北京小时 20', G.beijingHour(T), 20);
eq('北京小时 0', G.beijingHour(NEXT), 0);
eq('北京时钟 20:00', G.beijingClock(T), '20:00');
eq('北京时钟 00:00', G.beijingClock(NEXT), '00:00');

console.log('== 2. 默认配置与状态 ==');
eq('发推目标 40', G.DEFAULTS.postGoal, 40);
eq('评论目标 1000', G.DEFAULTS.commentGoal, 1000);
eq('默认提醒小时 21', G.DEFAULTS.reminderHour, 21);
const s0 = G.emptyState();
eq('新状态发推 0', s0.today.post, 0);
eq('新状态评论 0', s0.today.comment, 0);
eq('新状态目标清单空', s0.targets.length, 0);
eq('新状态版本 1', s0.version, 1);

console.log('== 3. 辅助动作自动 +1 与去重 ==');
let r = G.record(s0, 'post', 'status-123', T);
eq('发推计数 +1', r.count, 1);
ok('计数成功标记', r.counted === true);
let s1 = r.state;
r = G.record(s1, 'post', 'status-123', T + 1000);
ok('同一 ref 重复点击不重复计数', r.counted === false && r.reason === 'duplicate');
eq('重复后仍是 1', r.state.today.post, 1);
r = G.record(s1, 'comment', 'a1', T + 2000);
eq('评论独立计数 1', r.state.today.comment, 1);
r = G.record(r.state, 'comment', 'a1', T + 3000);
ok('评论 ref 去重', r.counted === false);
let noRef = G.record(G.emptyState(), 'comment', '', T + 1000);
ok('无 ref 5 秒内重复被拦', G.record(noRef.state, 'comment', '', T + 3000).counted === false);
ok('无 ref 超过 5 秒可再记一条',
  G.record(noRef.state, 'comment', '', T + 7000).counted === true);
r = G.record(s1, 'like', 'x', T);
ok('未知类型不计数', r.counted === false && r.reason === 'unknown-kind');

console.log('== 4. 跨天归零、历史保留 ==');
let multi = G.emptyState();
for (let i = 0; i < 3; i++) multi = G.record(multi, 'post', 'p' + i, T).state;
for (let i = 0; i < 5; i++) multi = G.record(multi, 'comment', 'c' + i, T).state;
let next = G.normalizeState(multi, NEXT);
eq('跨天发推归零', next.today.post, 0);
eq('跨天评论归零', next.today.comment, 0);
eq('跨天日期是 11-23', next.today.day, '2026-11-23');
eq('昨天发推留在历史', next.history['2026-11-22'].post, 3);
eq('昨天评论留在历史', next.history['2026-11-22'].comment, 5);
eq('跨天后去重 id 清空', next.postIds.length, 0);
eq('跨天后明细清空', next.events.length, 0);

console.log('== 5. 从已F注大 V 导入推荐清单 ==');
const follow = {
  following: {
    alice: { handle: 'alice', name: 'Alice', followers: 120000, verified: true, tweets: 3000 },
    bob: { handle: 'bob', name: 'Bob', followers: 500, verified: false, tweets: 200 },
    carol: { handle: 'carol', name: 'Carol', followers: 18000, verified: false, tweets: 100 },
    dave: { handle: 'dave', name: 'Dave', followers: 60000, verified: false, tweets: 100 },
    'bad-handle!': { handle: 'bad-handle!', followers: 999999 }
  }
};
let imp = G.importBigV(G.emptyState(), follow, T);
eq('新增 3 个大 V', imp.added, 3);
eq('总数 3', imp.total, 3);
eq('alice 排第一', imp.state.targets[0].handle, 'alice');
ok('bob 粉丝少未认证被排除', !imp.state.targets.some((t) => t.handle === 'bob'));
ok('非法 handle 被排除', !imp.state.targets.some((t) => t.handle === 'bad-handle!'));
ok('认证账号标注认证大 V', imp.state.targets[0].reason === '认证大 V');
ok('非认证大 V 标注大 V', imp.state.targets.some((t) => t.handle === 'carol' && t.reason === '大 V'));
let imp2 = G.importBigV(imp.state, follow, T + 1000);
eq('重复导入新增 0', imp2.added, 0);
eq('重复导入总数不变', imp2.total, 3);
let more = JSON.parse(JSON.stringify(follow));
more.following.eve = { handle: 'eve', name: 'Eve', followers: 30000, verified: false };
let imp3 = G.importBigV(imp.state, more, T + 2000);
eq('后续导入增量 1', imp3.added, 1);
eq('累计 4 个', imp3.total, 4);
ok('导入时间已记录', imp3.state.config.importedAt === T + 2000);

console.log('== 6. 大 V 评论打卡与清空 ==');
let done = G.markTargetDone(imp.state, 'ALICE', T + 3000);
ok('大小写 handle 也能记一条', done.ok === true && done.done === 1);
ok('不存在的大 V 记不上', G.markTargetDone(imp.state, 'nobody', T).ok === false);
let cleared = G.clearTargets(imp.state, T + 4000);
eq('清空后清单为空', cleared.targets.length, 0);
eq('清空后导入时间归零', cleared.config.importedAt, 0);

console.log('== 7. 统计摘要 ==');
let st = G.emptyState();
for (let i = 0; i < 8; i++) st = G.record(st, 'post', 'p' + i, T).state;
st = G.importBigV(st, follow, T).state;
const sum = G.summary(st, T);
eq('摘要发推 8', sum.post, 8);
eq('摘要目标 40', sum.postGoal, 40);
eq('摘要进度 20%', sum.postPct, 20);
eq('发推未达标', sum.postDone, false);
eq('评论未达标', sum.commentDone, false);
eq('大 V 数 3', sum.targetCount, 3);
ok('明细倒序最近在前', sum.events.length === 8 && sum.events[0].ref === 'p7');
eq('北京时钟展示', sum.clock, '20:00');

console.log('== 8. 监督提醒 ==');
let rs = G.emptyState();
rs.config.reminderHour = 21;
eq('20 点还没到提醒时间', G.reminderReasons(rs, T).length, 0);
let due = T + 3600000; // 北京 21:00
eq('21 点提醒两项', G.reminderReasons(rs, due).join(','), 'post,comment');
let justPost = G.record(rs, 'post', 'x', due).state;
for (let i = 0; i < 39; i++) justPost = G.record(justPost, 'post', 'p' + i, due).state;
eq('发推达标后只提醒评论', G.reminderReasons(justPost, due).join(','), 'comment');
let off = G.emptyState(); off.config.reminderEnabled = false;
eq('关掉提醒不响', G.reminderReasons(off, due).length, 0);
let doneAll = G.emptyState();
for (let i = 0; i < 40; i++) doneAll = G.record(doneAll, 'post', 'p' + i, due).state;
for (let i = 0; i < 1000; i++) doneAll = G.record(doneAll, 'comment', 'c' + i, due).state;
eq('两项都达标不提醒', G.reminderReasons(doneAll, due).length, 0);
let reminded = G.emptyState(); reminded.config.reminderLastDay = '2026-11-22';
eq('当天已提醒过不重复', G.reminderReasons(reminded, due).length, 0);
const txt = G.reminderText(['post', 'comment'], G.summary(rs, due));
ok('通知标题含 TapePost', /TapePost/.test(txt.title));
ok('通知文案含两项进度', /发推 0\/40/.test(txt.message) && /评论 0\/1000/.test(txt.message));

console.log('== 9. 脏数据容错 ==');
let dirty = G.normalizeState({ config: { postGoal: -5, commentGoal: 999999999, reminderHour: 99 },
  today: { day: '2026-11-22', post: 'abc', comment: -2 }, targets: [{ handle: '' }, null,
    { handle: 'Xyz', followers: '1000' }] }, T);
eq('非法目标数回退默认', dirty.config.postGoal, 40);
eq('超大目标数收敛', dirty.config.commentGoal, 100000);
eq('提醒小时收敛 23', dirty.config.reminderHour, 23);
eq('非法计数归零', dirty.today.post, 0);
eq('负数计数归零', dirty.today.comment, 0);
eq('脏清单只留合法 handle', dirty.targets.length, 1);
eq('handle 统一小写', dirty.targets[0].handle, 'xyz');

// ======================================================================
// 1.5.28：真实发送计数 / 大 V 自动归属 / 今日轮换 / 节奏 / 连续达标
// ======================================================================
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const W = require('./growth-watch.js');
const MIN = 60000;
// 北京 11-22 14:00
const NOON = Date.parse('2026-11-22T06:00:00Z');
function withTargets(handles) {
  let st = G.emptyState();
  handles.forEach((h) => { st = G.addTarget(st, h, h.toUpperCase(), NOON - 3600000).state; });
  return st;
}

console.log('== 10. 评论自动归属到大 V ==');
{
  let st = withTargets(['elonmusk', 'vitalik']);
  const r = G.record(st, 'comment', 'c1', NOON, { target: 'ElonMusk', post: '111' });
  ok('评论对象是清单大 V 时 attributed=true', r.counted && r.attributed === true);
  const t = r.state.targets.find((x) => x.handle === 'elonmusk');
  ok('大 V 累计 / 今日各 +1', t.done === 1 && t.todayDone === 1 && t.doneDay === '2026-11-22' && t.lastAt === NOON);
  const r2 = G.record(r.state, 'comment', 'c2', NOON + MIN, { target: 'nobody', post: '222' });
  ok('不在清单的作者不影响清单', r2.counted && !r2.attributed &&
    r2.state.targets.every((x) => x.handle !== 'nobody'));
  ok('旧版 bug 回归：把帖子 id 当 target 不会误记', G.record(st, 'comment', 'c3', NOON, { target: '1789' }).attributed === false);
  const next = G.normalizeState(r.state, NOON + 86400000);
  const t2 = G.recommendTargets(next.targets, next.today.day).find((x) => x.handle === 'elonmusk');
  ok('跨天后今日进度按天归零、累计保留', t2.todayDone === 0 && t2.done === 1);
}

console.log('== 11. 准备 → 发送成功才 +1 ==');
{
  let st = withTargets(['vitalik']);
  st = G.prepare(st, 'comment', 'c-assist', NOON, { target: 'vitalik', post: '900' }).state;
  eq('准备好一条评论 → 今日评论仍是 0', st.today.comment, 0);
  ok('准备阶段不给大 V 记进度，摘要里显示待发送 1 条', st.targets[0].done === 0 &&
    G.summary(st, NOON + MIN).commentPending === 1);
  ok('record() 带 source assist 等同 prepare（兼容旧调用）',
    G.record(G.emptyState(), 'post', 'x', NOON, { source: 'assist' }).state.today.post === 0);
  ok('同一条准备内容重复写入只记一次', G.prepare(st, 'comment', 'c-assist', NOON + 1000, { post: '900' }).reason === 'duplicate');
  const s1 = G.recordSent(st, 'comment', { target: 'vitalik', post: '900' }, NOON + 2 * MIN);
  ok('检测到发送成功 → 确认这条并 +1', s1.confirmed === true && s1.counted === true &&
    s1.state.today.comment === 1 && s1.state.today.commentSent === 1);
  ok('确认时给大 V 记一次进度', s1.state.targets[0].done === 1 && s1.attributed === true);
  ok('确认后不再算待发送', G.summary(s1.state, NOON + 3 * MIN).commentPending === 0);
  const ev = s1.state.events[s1.state.events.length - 1];
  ok('明细里这条标记为已发出', ev.sent === true && ev.sentAt === NOON + 2 * MIN && ev.source === 'assist');
  const s2 = G.recordSent(s1.state, 'comment', { target: 'vitalik', post: '900' }, NOON + 2 * MIN + 1500);
  ok('同一个按钮连点不重复算', s2.counted === false);
  const s3 = G.recordSent(s1.state, 'comment', { target: 'vitalik', post: '900' }, NOON + 5 * MIN);
  ok('同一帖子之后又手写发了一条 → 记为手写 +1', s3.counted === true && s3.reason === 'manual' &&
    s3.state.today.comment === 2 && s3.state.targets[0].done === 2);
}
{
  let st = G.emptyState();
  st = G.prepare(st, 'comment', 'a', NOON, { target: 'x1', post: '1' }).state;
  const r = G.recordSent(st, 'comment', { target: 'x2', post: '2' }, NOON + MIN);
  ok('帖子 id 对不上 → 不确认那条准备记录，算一条手写评论', r.counted === true && r.state.today.comment === 1 &&
    r.state.events[0].sent === false);
  const late = G.recordSent(G.prepare(G.emptyState(), 'post', 'p', NOON).state, 'post', {}, NOON + 31 * MIN);
  ok('发推准备超过 30 分钟才发 → 不再对号，算新的一条', late.counted === true && late.state.today.post === 1 &&
    late.reason === 'manual');
  const quick = G.recordSent(G.prepare(G.emptyState(), 'post', 'p', NOON).state, 'post', {}, NOON + 3 * MIN);
  ok('打开发推预填后 3 分钟点发布 → 确认同一条', quick.confirmed && quick.state.today.post === 1 && quick.state.today.postSent === 1);
  const manual = G.recordSent(withTargets(['naval']), 'comment', { target: 'Naval', post: '77' }, NOON);
  ok('完全手写的评论也计数并自动记到大 V', manual.counted && manual.state.today.comment === 1 &&
    manual.state.today.commentSent === 1 && manual.state.targets[0].todayDone === 1);
  ok('未知类型不计数', G.recordSent(G.emptyState(), 'like', {}, NOON).counted === false);
  const noAuthor = G.prepare(withTargets(['naval']), 'comment', 'n', NOON, { post: '55' }).state;
  const fill = G.recordSent(noAuthor, 'comment', { target: 'naval', post: '55' }, NOON + MIN);
  ok('准备时没拿到作者、发出时拿到 → 补记大 V 进度', fill.confirmed && fill.state.targets[0].done === 1);
}

console.log('== 12. 清单：手动记一条 / 添加 / 移除 / 今日轮换 ==');
{
  let st = withTargets(['aaa', 'bbb', 'ccc']);
  const m1 = G.manualComment(st, '@AAA', NOON);
  ok('手动记一条 = 大 V +1 且今日评论 +1', m1.ok && m1.counted && m1.state.today.comment === 1 && m1.done === 1);
  const auto = G.recordSent(st, 'comment', { target: 'bbb', post: '5' }, NOON);
  const m2 = G.manualComment(auto.state, 'bbb', NOON + MIN);
  ok('2 分钟内已自动计到同一对象 → 手动记一条只合并不重复', m2.ok && m2.counted === false &&
    m2.reason === 'already-counted' && m2.state.today.comment === 1);
  ok('清单外的账号记不上', G.manualComment(st, 'zzz', NOON).ok === false);
  ok('添加：重复 / 非法 handle 被拒', G.addTarget(st, 'AAA', '', NOON).reason === 'exists' &&
    G.addTarget(st, 'bad-name!', '', NOON).reason === 'invalid');
  const added = G.addTarget(st, '@Newbie', 'New', NOON);
  ok('添加：手动对象标记 manual、来源手动添加', added.ok && added.state.targets.some((t) => t.handle === 'newbie' && t.manual && t.reason === '手动添加'));
  const removed = G.removeTarget(added.state, 'newbie', NOON);
  ok('移除单个对象', removed.ok && !removed.state.targets.some((t) => t.handle === 'newbie') && removed.state.targets.length === 3);
  let rt = G.emptyState();
  rt.targets = [
    { handle: 'big', followers: 900000, lastAt: NOON - 3600000, doneDay: '2026-11-22', todayDone: 1 },
    { handle: 'old', followers: 20000, lastAt: NOON - 5 * 86400000 },
    { handle: 'never', followers: 15000, lastAt: 0 },
    { handle: 'never2', followers: 80000, lastAt: 0 }
  ];
  rt = G.normalizeState(rt, NOON);
  eq('今日轮换：没评过的优先 → 最久没评 → 粉丝多，今天已评的排最后',
    G.recommendTargets(rt.targets, '2026-11-22').map((t) => t.handle).join(','), 'never2,never,old,big');
  eq('旧的 todayDone 跨天不算今天', G.recommendTargets(rt.targets, '2026-11-23')[3].todayDone, 0);
  const sum = G.summary(m1.state, NOON);
  ok('摘要含推荐清单 / 今日已覆盖对象 / 确认发出数', Array.isArray(sum.recommended) && sum.targetsTouchedToday === 1 &&
    typeof sum.commentSent === 'number');
}

console.log('== 13. 节奏 / 落后提醒 / 连续达标 ==');
{
  const at = (bjHour, bjMin) => Date.parse('2026-11-22T00:00:00Z') + ((bjHour - 8) * 60 + (bjMin || 0)) * MIN;
  let st = G.emptyState();
  const p0 = G.pace(st, at(7));
  ok('8:00 前节奏为 0', p0.fraction === 0 && p0.expectedComment === 0);
  const p1 = G.pace(st, at(14, 30));   // (14.5-8)/(21-8) = 0.5
  eq('14:30 应完成一半评论', p1.expectedComment, 500);
  eq('14:30 应完成一半发推', p1.expectedPost, 20);
  ok('一条没做 → 两项都落后', p1.postBehind && p1.commentBehind && p1.behindComment === 500);
  ok('剩余每小时需求按剩余时间算', p1.perHourComment === Math.ceil(1000 / 6.5));
  eq('10:00 前不做落后提醒', G.paceReminderReasons(st, at(9, 50)).length, 0);
  eq('14:30 明显落后 → 提醒两项', G.paceReminderReasons(st, at(14, 30)).join(','), 'post,comment');
  let sp = G.normalizeState(st, at(14, 30)); sp.config.paceLastAt = at(13);
  eq('3 小时内提醒过不再提醒', G.paceReminderReasons(sp, at(14, 30)).length, 0);
  let nop = G.normalizeState(st, at(14, 30)); nop.config.paceReminder = false;
  eq('关掉落后提醒不响', G.paceReminderReasons(nop, at(14, 30)).length, 0);
  eq('到了晚间提醒时间交给原来的每日提醒', G.paceReminderReasons(st, at(21, 5)).length, 0);
  let ahead = st;
  for (let i = 0; i < 20; i++) ahead = G.record(ahead, 'post', 'p' + i, at(14)).state;
  for (let i = 0; i < 450; i++) ahead = G.record(ahead, 'comment', 'c' + i, at(14)).state;
  eq('进度 ≥ 应完成的 70% 不算落后', G.paceReminderReasons(ahead, at(14, 30)).length, 0);
  const txt2 = G.paceReminderText(['comment'], G.summary(st, at(14, 30)));
  ok('落后提醒文案含「按节奏此刻应到」', /按节奏此刻应到 500 条/.test(txt2.message) && /TapePost/.test(txt2.title));
  ok('normalizeConfig 保留 paceReminder 开关', G.normalizeConfig({ paceReminder: false }).paceReminder === false &&
    G.normalizeConfig({}).paceReminder === true);

  // 连续达标：历史里记了当天的目标
  let hs = G.emptyState();
  hs.history = {
    '2026-11-21': { post: 40, comment: 1000, postGoal: 40, commentGoal: 1000 },
    '2026-11-20': { post: 10, comment: 100, postGoal: 10, commentGoal: 100 },   // 当时目标更低也算达标
    '2026-11-19': { post: 39, comment: 1000 },                                   // 差一条 → 断
    '2026-11-18': { post: 40, comment: 1000 }
  };
  eq('连续达标从昨天往前数，按当天目标判断', G.streak(hs, NOON).days, 2);
  let td = hs;
  for (let i = 0; i < 40; i++) td = G.record(td, 'post', 'p' + i, NOON).state;
  for (let i = 0; i < 1000; i++) td = G.record(td, 'comment', 'c' + i, NOON).state;
  const sk = G.streak(td, NOON);
  ok('今天也达标 → 连续天数 +1', sk.days === 3 && sk.todayMet === true);
  const roll = G.normalizeState(td, NOON + 86400000);
  ok('跨天写历史时带上当天目标与确认发出数', roll.history['2026-11-22'].postGoal === 40 &&
    roll.history['2026-11-22'].commentGoal === 1000 && roll.history['2026-11-22'].commentSent === 1000);
  ok('一天 1000 条评论的去重 id / 明细不再被 400 / 600 上限截断',
    td.commentIds.length === 1000 && td.events.length === 1040);
}

console.log('== 14. growth-watch：判断这次点击是发推还是评论 ==');
{
  eq('intent 发推页 → 发推', W.classify({ path: '/intent/post', search: '?text=hi' }).kind, 'post');
  const ir = W.classify({ path: '/intent/tweet', search: '?text=a&in_reply_to=12345' });
  ok('intent 带 in_reply_to → 评论该帖', ir.kind === 'comment' && ir.post === '12345');
  const dlg = W.classify({ path: '/compose/post', inDialog: true, dialogHasTweet: true,
    dialogStatusHref: '/VitalikButerin/status/1888' });
  ok('回复弹窗（上方带原帖）→ 评论，作者 / 帖子 id 正确', dlg.kind === 'comment' &&
    dlg.target === 'vitalikbuterin' && dlg.post === '1888');
  eq('普通发推弹窗（没有原帖）→ 发推', W.classify({ path: '/compose/post', inDialog: true, dialogHasTweet: false }).kind, 'post');
  const inl = W.classify({ path: '/naval/status/42', testid: 'tweetButtonInline' });
  ok('详情页内联回复框 → 评论该帖', inl.kind === 'comment' && inl.target === 'naval' && inl.post === '42');
  eq('首页顶部内联发推框 → 发推', W.classify({ path: '/home', testid: 'tweetButtonInline' }).kind, 'post');
  eq('/i/status 这类保留路径不当作者', W.statusFrom('/i/status/9').author, '');
  const src = read('growth-watch.js');
  ok('旁听器只读：不 preventDefault / 不代点 / 不发请求 / 不读输入框的 value',
    !/preventDefault|stopPropagation|\.click\(\)|fetch\(|XMLHttpRequest|\.value\b/.test(
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
  ok('发出的文字截断到 280 字', /TEXT_MAX = 280/.test(src) && /slice\(0, TEXT_MAX\)/.test(src));
  ok('禁用状态的发送按钮不计数', /aria-disabled'\) === 'true'/.test(src));
  ok('捕获阶段监听 click 与 Ctrl/⌘+Enter', /addEventListener\('click'[\s\S]*?, true\)/.test(src) &&
    /e\.metaKey \|\| e\.ctrlKey/.test(src));
}

console.log('== 15. 接线：manifest / 后台路由 / 面板 / 内容脚本 ==');
{
  const manifest = JSON.parse(read('manifest.json'));
  const seg = manifest.content_scripts[2];
  ok('growth-watch.js 注入在 X 专属第三段（ISOLATED），排在浮层之前',
    seg.js.indexOf('growth-watch.js') > seg.js.indexOf('follow-bridge.js') &&
    seg.js.indexOf('growth-watch.js') < seg.js.indexOf('follow-overlay.js') && !seg.world &&
    seg.matches.every((m) => /x\.com|twitter\.com/.test(m)));
  ok('权限不变（9 项 / 34 条）', manifest.permissions.length === 9 && manifest.host_permissions.length === 34);
  const bg = read('background.js');
  ['GROWTH_SENT', 'GROWTH_TARGET_ADD', 'GROWTH_TARGET_REMOVE'].forEach((t) =>
    ok('后台路由 ' + t, new RegExp("t === '" + t + "'").test(bg)));
  ok('后台：GROWTH_RECORD 只记待发送（prepare），透传 post，且不再二次 markTargetDone',
    /GrowthCore\.prepare\(s, kind, msg\.ref, Date\.now\(\), \{ target: msg\.target, post: msg\.post \}\)/.test(bg) &&
    !/r\.counted && kind === 'comment' && msg\.target/.test(bg));
  ok('后台：手动记一条走 manualComment', /GrowthCore\.manualComment\(s, msg\.handle/.test(bg));
  ok('后台：落后提醒接入定时检查', /GrowthCore\.paceReminderReasons\(s, Date\.now\(\)\)/.test(bg) &&
    /tapegrowth-pace-/.test(bg));
  ok('后台：增长计划读改写串行执行', /growthSerial\(async function/.test(bg) && /growthSerial\(growthTick\)/.test(bg) && /await maybeGrowthRemind\(\)/.test(bg));
  const cs = read('content.js');
  ok('内容脚本：评论计数传作者 handle + 帖子 id（不再把帖子 id 当对象）',
    /growthPing\('comment', c, growthAuthorByStatus\[statusId\] \|\| '', statusId\)/.test(cs) &&
    !/growthPing\('comment', c, statusId\)/.test(cs));
  const gj = read('growth.js'), gh = read('growth.html');
  ok('面板：按钮用事件委托，不再每次重绘对整页重复绑定',
    !/document\.querySelectorAll\('\[data-go\]'\)/.test(gj) && /addEventListener\('click', onTargetClick\)/.test(gj));
  ok('面板：节奏 / 连续达标 / 柱状图 / 搜索 / 手动添加 / 落后提醒开关',
    ['paceLine', 'streakBadge', 'histChart', 'targetSearch', 'addHandle', 'addTarget', 'cfgPace'].every((id) =>
      new RegExp('id="' + id + '"').test(gh)));
  ok('面板：隐私说明写明「发送成功才 +1」「不代点、不阻止、不发请求」', /发送成功才 \+1/.test(gh) && /不代点、不阻止、不发请求/.test(gh));
  ok('面板：发送日志区块（日期 / 筛选 / 导出 / 列表）', ['logDay', 'logFilter', 'logExport', 'logList'].every((id) =>
    new RegExp('id="' + id + '"').test(gh)));
}

console.log('== 1.5.28 复查修正 ==');
{
  const blueSmall = { handle: 'tiny', followers: 300, verified: true };
  const blueMid = { handle: 'mid', followers: 2500, verified: true };
  ok('只有蓝标、几百粉不算大 V', G.isBigV(blueSmall) === false);
  ok('认证且粉丝 ≥ 2000 算大 V', G.isBigV(blueMid) === true);
  ok('粉丝 ≥ 1 万不论认证都算', G.isBigV({ followers: 12000 }) === true);
  const T2 = Date.parse('2026-11-22T10:00:00+08:00');
  let s2 = G.importBigV(G.emptyState(), { following: { big1: { handle: 'big1', followers: 50000 }, big2: { handle: 'big2', followers: 40000 } } }, T2).state;
  s2 = G.addTarget(s2, 'manualguy', '', T2).state;
  const r2 = G.importBigV(s2, { following: { big2: { handle: 'big2', followers: 40000 } },
    gone: { following: { big1: T2 + 1, manualguy: T2 + 1 } } }, T2 + 1000);
  ok('重新导入：已取F的大 V 移出清单', !r2.state.targets.some((x) => x.handle === 'big1') && r2.removed === 1);
  ok('重新导入：手动添加的对象即使在墓碑里也保留', r2.state.targets.some((x) => x.handle === 'manualguy'));
  let s3 = G.emptyState();
  s3 = G.record(s3, 'post', 'only-post', T2).state;
  for (let i = 0; i < 300; i++) s3 = G.record(s3, 'comment', 'c' + i, T2 + 1 + i).state;
  const sum3 = G.summary(s3, T2 + 400);
  ok('一天评论很多时，发推明细不会被挤掉', sum3.events.some((e) => e.kind === 'post') &&
    sum3.events.filter((e) => e.kind === 'comment').length === 200 && sum3.events[0].ref === 'c299');
  ok('清空评论对象前二次确认', /window\.confirm\('确定清空全部/.test(read('growth.js')));
}

console.log('== 1.5.28 发送成功才 +1 / 发送日志 ==');
{
  const W2 = require('./growth-watch.js');
  ok('X 提示「已发送」判为成功', W2.toastVerdict('Your post was sent. View') === 'ok' && W2.toastVerdict('你的帖子已发送') === 'ok');
  ok('X 报错判为失败（失败优先）', W2.toastVerdict('Something went wrong. Try reloading.') === 'fail' &&
    W2.toastVerdict('Whoops! You already said that.') === 'fail' && W2.toastVerdict('发送失败') === 'fail');
  ok('无关提示不判', W2.toastVerdict('Bookmarked') === '');

  const now = Date.parse('2026-11-22T21:30:00+08:00');
  const e = G.logEntry({ at: now - 1000, kind: 'comment', status: 'ok', target: '@Naval', post: '42',
    text: 'x'.repeat(400), counted: true, reason: 'toast' }, now);
  ok('日志条目：北京日期 / 时间 / 归一化对象', e.day === '2026-11-22' && e.clock === '21:29' && e.target === 'naval' && e.post === '42');
  ok('日志条目：文字截到 280 字并加省略号', e.text.length === 281 && e.text.endsWith('…'));
  ok('日志条目：页面传来的离谱时间改用当前时间', G.logEntry({ at: 1 }, now).at === now);
  ok('日志条目：未知状态记为未确认', G.logEntry({ status: 'weird' }, now).status === 'unknown');
  let list = [];
  for (let i = 0; i < G.DEFAULTS.logMaxPerDay + 5; i++) list = G.appendLog(list, { i: i });
  ok('每天日志最多 3000 条，保留最新', list.length === 3000 && list[2999].i === 3004);
  const d = G.logDays(['2026-11-10', '2026-11-20', '2026-11-21', 'bad', '2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18'], '2026-11-22', 7);
  ok('只保留最近 7 天，其余删掉', d.keep.length === 7 && d.keep[0] === '2026-11-22' && d.drop.join() === '2026-11-10');
  const st = G.logStats([{ status: 'ok', kind: 'post' }, { status: 'ok', kind: 'comment' }, { status: 'fail', kind: 'comment' }, { status: 'unknown', kind: 'post' }]);
  ok('日志统计：成功 / 失败 / 未确认 / 成功的发推与评论', st.ok === 2 && st.fail === 1 && st.unknown === 1 && st.post === 1 && st.comment === 1);
  eq('日志存储键按天', G.logKey('2026-11-22'), 'tapeGrowthLog:2026-11-22');

  const bg = read('background.js');
  ok('后台：只有 status ok 才 recordSent 计数，失败 / 未确认只进日志',
    /if \(status === 'ok'\) r = GrowthCore\.recordSent/.test(bg) && /appendGrowthLog\(\{ at: msg\.at/.test(bg));
  ok('后台：GROWTH_LOG 路由 + 过期日志清理', /t === 'GROWTH_LOG'/.test(bg) && /gremove\(days\.drop\.map/.test(bg));
  ok('后台：日志写进 IndexedDB，失败时临时落 storage，之后自动搬回数据库',
    /GrowthCore\.createLogDB\(indexedDB, IDBKeyRange\)/.test(bg) && /await LogDB\.add\(\[e\]\)/.test(bg) &&
    /if \(!saved\) await appendLogToStorage\(e\)/.test(bg) && /async function migrateGrowthLog/.test(bg));
  ok('后台：按 90 天清理、可一键清空', /LogDB\.pruneBefore\(Date\.now\(\) - GrowthCore\.DEFAULTS\.logKeepDays/.test(bg) &&
    /t === 'GROWTH_LOG_CLEAR'/.test(bg) && G.DEFAULTS.logKeepDays === 90);
  ok('面板：有新日志时靠 tapeGrowthLogRev 刷新，清空前二次确认', /changes\.tapeGrowthLogRev/.test(read('growth.js')) &&
    /window\.confirm\('确定清空全部 ' \+ state\.logTotal/.test(read('growth.js')));
  ok('后台：手动记一条也进日志', /reason: 'mark', source: 'mark'/.test(bg));
}

console.log('== 1.5.28 旁听器：等 X 的结果再上报（DOM 模拟） ==');
{
  const vm = require('vm');
  const src = read('growth-watch.js');
  function sim() {
    const sent = [], timers = [], listeners = {};
    let toasts = [];
    const editor = { isConnected: true, innerText: '你好世界', getAttribute: () => 'tweetTextarea_0' };
    const scope = { querySelector: (q) => (q.indexOf('tweetTextarea') >= 0 ? editor : null),
      querySelectorAll: (q) => (q.indexOf('tweetTextarea') >= 0 ? [editor] : []) };
    const btn = { disabled: false, getAttribute: (a) => (a === 'data-testid' ? 'tweetButtonInline' : null),
      closest: (q) => (q.indexOf('tweetButton') >= 0 ? btn : null), parentElement: scope };
    scope.parentElement = null;
    const doc = { addEventListener: (t, f) => { listeners[t] = f; },
      querySelectorAll: (q) => (q.indexOf('toast') >= 0 ? toasts : []) };
    let clock = 1000000;
    const ctx = { document: doc, location: { pathname: '/naval/status/42', search: '' },
      Date: { now: () => clock }, setInterval: (f) => { timers.push(f); return timers.length; },
      clearInterval: (id) => { timers[id - 1] = null; },
      chrome: { runtime: { id: 'x', sendMessage: (m) => { sent.push(m); }, lastError: null } },
      addEventListener: (t, f) => { listeners['win:' + t] = f; } };
    ctx.globalThis = ctx;
    vm.runInNewContext(src, ctx);
    const click = () => listeners.click({ target: btn });
    const tick = (ms) => { clock += ms || 300; timers.forEach((f) => f && f()); };
    return { sent, click, tick, editor, setToasts: (t) => { toasts = t; }, listeners, advance: (ms) => { clock += ms; } };
  }
  let a = sim();
  a.click();
  ok('点击后不立即上报', a.sent.length === 0);
  a.editor.innerText = '';
  a.tick(); a.tick();
  ok('输入框清空 → 上报成功，带原文、对象、帖子 id', a.sent.length === 1 && a.sent[0].status === 'ok' &&
    a.sent[0].reason === 'cleared' && a.sent[0].text === '你好世界' && a.sent[0].target === 'naval' && a.sent[0].post === '42');
  a.tick();
  ok('只上报一次', a.sent.length === 1);

  let b = sim();
  b.click();
  b.setToasts([{ innerText: 'Something went wrong, but don\'t fret.' }]);
  b.tick();
  ok('X 报错 → 上报失败，不当成功', b.sent.length === 1 && b.sent[0].status === 'fail');

  let c = sim();
  c.click();
  for (let i = 0; i < 60; i++) c.tick();
  ok('15 秒没结果 → 上报未确认', c.sent.length === 1 && c.sent[0].status === 'unknown' && c.sent[0].reason === 'timeout');

  let d = sim();
  d.click();
  d.editor.isConnected = false;
  d.tick();
  d.setToasts([{ innerText: 'You are over the daily limit for sending posts.' }]);
  d.tick();
  ok('窗口关了但紧接着报错 → 仍判失败', d.sent.length === 1 && d.sent[0].status === 'fail');

  let e = sim();
  e.setToasts([{ innerText: 'Your post was sent.' }]);   // 点击前就在的旧提示
  e.click();
  e.tick();
  ok('点击前已存在的旧提示不算这次的结果', e.sent.length === 0);
}

console.log('== 1.5.28 多个定时提醒 ==');
{
  const at = (h, m) => Date.parse('2026-11-22T' + String(h).padStart(2, '0') + ':' + String(m || 0).padStart(2, '0') + ':00+08:00');
  let st = G.emptyState();
  eq('默认迁移成一条 21:00 / 100%', JSON.stringify(G.normalizeState(st, at(9)).config.reminders), '[{"time":"21:00","pct":100}]');
  const legacy = G.normalizeConfig({ reminderHour: 19 });
  ok('旧版提醒小时 19 → 19:00 / 100%', legacy.reminders.length === 1 && legacy.reminders[0].time === '19:00');
  const norm = G.normalizeReminders([{ time: '18:00', pct: 70 }, { time: '9:5', pct: 10 }, { time: '12:00', pct: 300 },
    { time: '18:00', pct: 50 }, { time: '25:00' }, 'bad', { time: '09:05', pct: 0 }]);
  ok('提醒清洗：排序、去重、非法时间丢弃、百分比收敛到 1~100',
    JSON.stringify(norm) === '[{"time":"09:05","pct":1},{"time":"12:00","pct":100},{"time":"18:00","pct":70}]');
  st.config.reminders = [{ time: '12:00', pct: 30 }, { time: '18:00', pct: 70 }, { time: '21:00', pct: 100 }];
  st = G.normalizeState(st, at(9));
  eq('节奏终点 = 最晚的提醒小时', st.config.reminderHour, 21);
  eq('11:59 不响', G.dueReminder(st, at(11, 59)), null);
  const d12 = G.dueReminder(st, at(12));
  ok('12:00 按 30% 检查：发推应到 12、评论应到 300', d12 && d12.expectedPost === 12 && d12.expectedComment === 300 &&
    d12.reasons.join() === 'post,comment');
  let done = st;
  for (let i = 0; i < 12; i++) done = G.record(done, 'post', 'p' + i, at(11)).state;
  for (let i = 0; i < 300; i++) done = G.record(done, 'comment', 'c' + i, at(11)).state;
  ok('到了 30% 就不提醒（但仍算已检查）', G.dueReminder(done, at(12)).reasons.length === 0);
  const m12 = G.markReminders(st, d12.covers, at(12));
  eq('同一时间点不重复响', G.dueReminder(m12, at(12, 30)), null);
  const d18 = G.dueReminder(m12, at(18, 1));
  ok('18:00 按 70% 检查', d18.time === '18:00' && d18.expectedComment === 700);
  const late = G.dueReminder(st, at(20));
  ok('浏览器关着错过 12:00 和 18:00 → 只补最近的 18:00，两个一起标记',
    late.time === '18:00' && late.covers.join() === '12:00,18:00');
  const allDone = G.markReminders(G.markReminders(m12, ['18:00'], at(18)), ['21:00'], at(21));
  eq('三个都处理完后 21:30 不再响', G.dueReminder(allDone, at(21, 30)), null);
  ok('跨天后重新开始', G.dueReminder(allDone, at(12) + 86400000) !== null);
  eq('下一次提醒：9 点时是 12:00', G.nextReminderAt(st, at(9)), at(12));
  eq('下一次提醒：12 点已处理后是 18:00', G.nextReminderAt(m12, at(12, 5)), at(18));
  eq('下一次提醒：今天都过了 → 明天 12:00', G.nextReminderAt(allDone, at(22)), at(12) + 86400000);
  const skip = G.skipPastReminders(st, at(15));
  ok('改设置后：已过去的 12:00 不补响，18:00 照常', G.dueReminder(skip, at(15, 1)) === null &&
    G.dueReminder(skip, at(18)).time === '18:00');
  let off = G.normalizeState(st, at(9)); off.config.reminderEnabled = false;
  ok('关掉提醒：不响、没有下一次', G.dueReminder(off, at(13)) === null && G.nextReminderAt(off, at(9)) === 0);
  const none = G.normalizeState({ config: { reminders: [] } }, at(9));
  ok('允许不设任何定时提醒', none.config.reminders.length === 0 && G.dueReminder(none, at(22)) === null);
  const txt = G.reminderText(['comment'], G.summary(st, at(18)), d18);
  ok('通知写明时间点、百分比和应到数量', /18:00/.test(txt.message) && /70%/.test(txt.message) && /评论 0\/700 条/.test(txt.message));
  const bg = read('background.js');
  ok('后台：按下一个提醒时间设精确闹钟，并保留 30 分钟兜底', /alarms\.create\(GROWTH_ALARM_AT, \{ when: at/.test(bg) &&
    /periodInMinutes: 30/.test(bg) && /a\.name === GROWTH_ALARM_AT/.test(bg));
  ok('后台：改提醒设置后跳过已过去的时间点并重设闹钟', /skipPastReminders\(s, Date\.now\(\)\)/.test(bg) &&
    /await scheduleGrowthReminder\(s\)/.test(bg));
  const gh = read('growth.html'), gj = read('growth.js');
  ok('面板：提醒列表 / 添加 / 推荐', ['remList', 'remAdd', 'remPreset', 'nextReminder'].every((id) => new RegExp('id="' + id + '"').test(gh)));
  ok('面板：数字不加千分位逗号', !/toLocaleString\('zh-CN'\)/.test(gj.split('var clock')[0]) && /String\(isFinite\(v\)/.test(gj));
}

console.log('== 1.5.28 通知页回复：发送按钮兜底识别 + 诊断输出 ==');
{
  const vm = require('vm');
  const src = read('growth-watch.js');
  function sim2(btnOpts) {
    const sent = [], timers = [], listeners = {}, logs = [];
    const editor = { isConnected: true, innerText: '谢谢关注', getAttribute: () => 'tweetTextarea_0' };
    const scope = { querySelector: (q) => (q.indexOf('tweetTextarea') >= 0 ? editor : null),
      querySelectorAll: (q) => (q.indexOf('tweetTextarea') >= 0 ? [editor] : []), parentElement: null };
    const btn = { disabled: false, innerText: btnOpts.text || '', parentElement: scope,
      getAttribute: (a) => (a === 'data-testid' ? (btnOpts.testid || null) : null),
      closest: (q) => {
        if (q.indexOf('role="dialog"') >= 0) return null;
        if (q.indexOf('data-testid="tweetButton') >= 0) return btnOpts.testid && /^tweetButton(Inline)?$/.test(btnOpts.testid) ? btn : null;
        if (q.indexOf('button') >= 0) return btn;
        return null;
      } };
    const doc = { addEventListener: (t, f) => { listeners[t] = f; }, querySelectorAll: () => [] };
    let clock = 5000000;
    const ctx = { document: doc, location: { pathname: btnOpts.path || '/someone/status/77', search: '' },
      Date: { now: () => clock }, setInterval: (f) => { timers.push(f); return timers.length; },
      clearInterval: (id) => { timers[id - 1] = null; },
      console: { info: (m) => logs.push(m), warn: (m) => logs.push('WARN ' + m) },
      chrome: { runtime: { id: btnOpts.dead ? undefined : 'x', sendMessage: (m) => { sent.push(m); }, lastError: null } },
      addEventListener: () => {} };
    ctx.globalThis = ctx;
    vm.runInNewContext(src, ctx);
    listeners.click({ target: btn });
    editor.innerText = '';
    clock += 300; timers.forEach((f) => f && f()); clock += 300; timers.forEach((f) => f && f());
    return { sent, logs };
  }
  const byText = sim2({ text: '回复' });
  ok('X 改了 testid 时，按「回复」文字 + 输入区兜底识别并计数', byText.sent.length === 1 && byText.sent[0].status === 'ok' &&
    byText.sent[0].kind === 'comment' && byText.sent[0].target === 'someone');
  ok('testid 以 tweetButton 开头的新变体也识别', sim2({ testid: 'tweetButtonInlineV2' }).sent.length === 1);
  ok('与发送无关的按钮（文字不是回复 / 发帖）不误记', sim2({ text: '12' }).sent.length === 0 && sim2({ text: '转帖' }).sent.length === 0);
  ok('控制台输出「检测到点击发送」和结果，便于排查', byText.logs.some((m) => /检测到点击发送：评论 @someone/.test(m)) &&
    byText.logs.some((m) => /结果：发送成功，已计数/.test(m)));
  const dead = sim2({ testid: 'tweetButtonInline', dead: true });
  ok('扩展重载后旧页面没刷新：不计数，但控制台提示刷新页面', dead.sent.length === 0 &&
    dead.logs.some((m) => /WARN/.test(m) && /请刷新这个页面/.test(m)));
}

console.log('== 1.5.28 X 按钮角标「还差 N」+ 发送动画 ==');
{
  const W3 = require('./growth-watch.js');
  const noon = Date.parse('2026-11-22T12:00:00+08:00');
  const pg = W3.progressOf({ today: { day: '2026-11-22', post: 12, comment: 327 }, config: { postGoal: 40, commentGoal: 1000 } }, noon);
  ok('角标：发帖按钮显示发推还差 28，回复按钮显示评论还差 673', W3.hintText('post', pg).text === '还差 28' &&
    W3.hintText('comment', pg).text === '还差 673');
  const stale = W3.progressOf({ today: { day: '2026-11-21', post: 40, comment: 1000 }, config: { postGoal: 40, commentGoal: 1000 } }, noon);
  ok('角标：过了零点状态还没刷新时按 0 算', W3.hintText('comment', stale).text === '还差 1000');
  ok('角标：达标后显示 ✓ 达标', W3.hintText('post', W3.progressOf({ today: { day: '2026-11-22', post: 41 }, config: { postGoal: 40 } }, noon)).done === true);
  ok('角标：设置里关掉后不显示', W3.progressOf({ config: { xHints: false } }, noon).on === false &&
    G.normalizeConfig({ xHints: false }).xHints === false && G.normalizeConfig({}).xHints === true);
  const sm = (c) => ({ counted: true, summary: { post: 3, comment: c, postGoal: 40, commentGoal: 1000 } });
  eq('动画：成功显示进度与还差', W3.popText('comment', 'ok', sm(328)).sub, '评论 328/1000 · 还差 672');
  ok('动画：刚好达标时庆祝', W3.popText('comment', 'ok', sm(1000)).tone === 'goal' && /达成/.test(W3.popText('comment', 'ok', sm(1000)).sub));
  ok('动画：超额不再重复庆祝', W3.popText('comment', 'ok', sm(1001)).tone === 'ok');
  ok('动画：失败 / 未确认给出不计数提示', W3.popText('post', 'fail').tone === 'fail' && /不计数/.test(W3.popText('post', 'fail').sub) &&
    W3.popText('post', 'unknown').tone === 'unknown');
  ok('动画：重复记录说明未重复计数', /不重复计数/.test(W3.popText('comment', 'ok', { counted: false, summary: {} }).sub));
  const src = read('growth-watch.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('角标挂在自己的固定图层里，不往 X 的按钮里插节点', /hintRoot\.appendChild\(b\)/.test(src) && !/btn\.appendChild|btn\.insertBefore/.test(src));
  const css = read('follow-overlay.css');
  ok('图层与角标不挡点击（pointer-events:none），并照顾减少动态效果偏好', /#tpgHints \{[^}]*pointer-events: none/.test(css) &&
    /#tpgHints \* \{ pointer-events: none/.test(css) && /prefers-reduced-motion[\s\S]*tpg-spark \{ display: none/.test(css));
  ok('面板设置里有「按钮角标和动画」开关', /id="cfgXHints"/.test(read('growth.html')) && /xHints: !!\$\('cfgXHints'\)\.checked/.test(read('growth.js')));
  ok('扩展弹窗里的进度也不加千分位逗号', !/toLocaleString\('zh-CN'\) \+ '\/'/.test(read('popup.js')));
}

console.log('== 1.5.28 加载即报错回归 ==');
{
  const vm = require('vm');
  ['growth.js', 'growth-watch.js', 'growth-core.js', 'background.js', 'popup.js'].forEach((f) => {
    let okc = true;
    try { new vm.Script(read(f), { filename: f }); } catch (e) { okc = false; }
    ok(f + ' 语法可编译', okc);
  });
  const bg = read('background.js');
  const mod = bg.slice(bg.indexOf('(function growthModule()'));
  ok('后台：growthChain 在启动时首次调用 ensureGrowthAlarm() 之前就已定义（防 TDZ 让整个增长模块失效）',
    mod.indexOf('let growthChain') >= 0 && mod.indexOf('let growthChain') < mod.indexOf('\n  ensureGrowthAlarm();'));
}

console.log('== 1.5.28 发送日志上限与文案一致性 ==');
{
  const core = read('growth-core.js');
  ok('IndexedDB 主路径也按天限流 3000 条（与降级路径一致）',
    /os\.index\('day'\)\.count\(day\)/.test(core) && /DEFAULTS\.logMaxPerDay/.test(core) &&
    /openCursor\(keyRange\.only\(day\)\)/.test(core));
  const gh = read('growth.html');
  ok('面板已无「辅助动作自动 +1」旧口径', !/辅助动作自动 \+1/.test(gh) && /发送成功才 \+1/.test(gh));
  ok('面板明确日志存 IndexedDB 90 天，统计存 storage.local',
    /chrome\.storage\.local/.test(gh) && /IndexedDB/.test(gh) && /90 天/.test(gh));
  ok('过时注释已清理：后台不再写「只留最近 7 天」、旁听器不再写「默认保留 7 天」',
    !/只留最近 7 天/.test(read('background.js')) && !/默认保留 7 天/.test(read('growth-watch.js')));
  ['docs/privacy.html', 'store/privacy-site/index.html', '../vote-ledger/privacy.html'].forEach((f) => {
    const h = fs.readFileSync(path.join(__dirname, f), 'utf8');
    ok('隐私政策 ' + f + ' 数据落点描述无矛盾',
      /发送日志在扩展自己的本地数据库/.test(h) && !/以上数据全部只存在 <code>chrome\.storage\.local<\/code>/.test(h));
  });
}

console.log('== 1.5.28 发送成功判定：删除 / 关窗 / 关标签不再误判 ==');
{
  // 纯函数：各类证据组合的判定
  eq('失败提示优先 → fail', W.verdictOf({ toast: 'fail', textCleared: true }).status, 'fail');
  eq('成功提示 → ok', W.verdictOf({ toast: 'ok' }).status, 'ok');
  eq('提示里的失败盖过成功（传 fail 时）', W.verdictOf({ toast: 'fail', editorGone: true }).status, 'fail');
  eq('手动删字（userEdited）即使清空也不定论', W.verdictOf({ userEdited: true, textCleared: true,
    hadText: true, elapsed: 2000 }), '');
  eq('冷静期内（<600ms）清空不立即算成功', W.verdictOf({ textCleared: true, hadText: true, elapsed: 300 }), '');
  eq('过了冷静期、文字清空且按钮已禁用 → ok', W.verdictOf({ textCleared: true, hadText: true,
    sendDisabled: true, elapsed: 700 }).status, 'ok');
  eq('仅编辑器消失（弹窗关闭）过冷静期 → ok', W.verdictOf({ editorGone: true, hadText: true, elapsed: 700 }).status, 'ok');
  eq('发送按钮仍可用 → 不定论（可能只是重绘）', W.verdictOf({ textCleared: true, hadText: true,
    sendDisabled: false, elapsed: 700 }), '');
  eq('等待超时 → unknown', W.verdictOf({ elapsed: 16000 }).status, 'unknown');
  eq('页面卸载且无成功迹象 → unknown', W.verdictOf({ unloading: true }).status, 'unknown');
  eq('点击时输入框本来就是空的 → 清空不算成功', W.verdictOf({ textCleared: true, hadText: false,
    sendDisabled: true, elapsed: 2000 }), '');
  const wsrc = read('growth-watch.js');
  ok('卸载一律记未确认，不再有 intent 路径直接判成功的分支',
    /finish\(p, 'unknown', 'unload'\)/.test(wsrc) && !/indexOf\('\/intent\/'\) === 0/.test(wsrc));
  ok('检测用户手动删字：Backspace / Delete / 单字符键 + 输入框焦点',
    /e\.key === 'Backspace' \|\| e\.key === 'Delete'/.test(wsrc) && /p\.userEdited = true/.test(wsrc));
  ok('判定逻辑集中在可单测的 judgement 函数 verdictOf',
    /function verdictOf\(ev\)/.test(wsrc) && typeof W.verdictOf === 'function');
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
