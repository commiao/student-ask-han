// 只读：把问句的候选分数分布打出来，供修排序时"先看见分布再动刀"。
// 用法：node probe-scores.mjs [--installed] [--q <问句>] [--file <每行一问句的 txt>]
// 注意：CJK 拼进 shell 参数会打断持久 shell，所以常用问句写在本文件里，临时问句用 --file。
import { readFileSync } from 'node:fs';
import { defaultDb, targetPlugin } from './test-paths.mjs';

process.env.KB_ASK_DEBUG_SCORES = '1';
const which = process.argv.includes('--installed') ? 'installed' : (process.env.KB_ASK_TARGET || 'workspace');
const DB = defaultDb();
const REFUSAL = '该问题超出范围了，请联系管理员';

const QUESTIONS = [
  '宿舍饭菜价格怎么样',   // 第 8 轮错引用回归：正解 Q32，曾被章节主题词门槛整个删出候选
  '食堂饭菜价格怎么样',
  '多大的床',
  '爸妈能送我进宿舍吗',
  '宿舍怎么安排',
];
const fi = process.argv.indexOf('--file');
if (fi > 0 && process.argv[fi + 1]) {
  QUESTIONS.push(...readFileSync(process.argv[fi + 1], 'utf8').split('\n').map((s) => s.trim()).filter(Boolean));
}
const qi = process.argv.indexOf('--q');
if (qi > 0 && process.argv[qi + 1]) QUESTIONS.push(process.argv[qi + 1]);

let tool = null;
const { apply } = await import(`file://${targetPlugin(which)}`);
apply({ logger: { warn() {} }, tools: { register: (d) => { tool = d; } } }, { db: DB, refusal: REFUSAL });
console.log(`>>> 目标 ${which}  DB ${DB}`);

for (const q of QUESTIONS) {
  const t = await tool.execute({ question: q });
  console.log('\n' + q);
  console.log('  ' + t.split('\n')[0] + '  ' + (t.match(/（指南·[^）]+）/g) ?? []).join(' '));
  console.log('  scores: ' + (t.split('\nscores: ')[1] ?? '(无)'));
}
