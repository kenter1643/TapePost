#!/usr/bin/env node
/* TapePost · X 增长计划内核离线测试（1.5.26） */
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
eq('F掉提醒不响', G.reminderReasons(off, due).length, 0);
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

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
