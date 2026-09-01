// 探针：把 21:50 新增的否定式别名（不想参加/不愿参加/不想去/参不了）当攻击面打一遍。
// 目的只有一个——确认"召回放宽"没有把越界问题放进答案（FIXPLAN 硬约束：阈值只能朝误拒校准）。
// 用法：node probe-neg.mjs   （KB_ASK_TARGET=installed 可对照线上版）
const TARGET = process.env.KB_ASK_TARGET === 'installed'
  ? '/Users/mac/Library/Application Support/dsh-desktop/harness/.agent-presets/kb-qa/kb-ask.mjs'
  : '/Users/mac/work-deepseek/kb/preset-kb-qa/kb-ask.mjs';
const DB = process.env.KB_ASK_DB
  || '/Users/mac/Library/Application Support/dsh-desktop/harness/knowledge-base/kb.sqlite';
const REFUSAL = '该问题超出范围了，请联系管理员';

const { apply } = await import(`file://${TARGET}`);
let tool = null;
apply({ logger: { warn: (m) => console.log('[warn]', m) }, tools: { register: (d) => { tool = d; } } },
  { db: DB, refusal: REFUSAL });

// 库里没有对应条目，出现 ANSWER 即为误放
const MUST_REFUSE = [
  '我不想参加班会',
  '不想去社团活动',
  '我不想去上课',
  '不想吃饭行不行',
  '不想去学校了',
  '参不了加怎么办',
  '我不想参加你的婚礼',
  '不想去办公室',
  '我不想要这个答案',
];
// 文档真有 Q30（免训/缓训），这些应命中
const SHOULD_ANSWER = [
  '不想参加军训可以吗',
  '不想去军训了',
  '军训参不了怎么办',
  '不愿参加军训行吗',
];
// 灰区：只打印不断言。`不想参加队列训练` 原在这里断言 ANSWER，但全文（含军训安排）没有
// "队列训练"这个说法，闭卷下答它等于替文档编内容；cases.neg.md 第 6 小节早已把它降为
// 诊断项（出现 ANSWER 交人判读）。两边口径以那份文件为准，这里不再自行断言。
const GRAY = ['不想参加队列训练'];

const run = async (q) => {
  const text = String(await tool.execute({ question: q }));
  const verdict = text.split('\n')[0].trim();
  const via = (text.match(/\nvia: (\S+)/) || [])[1] || '';
  const cites = [...text.matchAll(/（指南·[^）]*?(Q\d+)/g)].map((m) => m[1]);
  return { verdict, via, refs: [...new Set(cites)].join(',') };
};

let bad = 0;
for (const [label, qs, want] of [['必须拒绝', MUST_REFUSE, 'out'], ['应当作答', SHOULD_ANSWER, 'in']]) {
  console.log(`\n=== ${label} ===`);
  for (const q of qs) {
    const r = await run(q);
    const got = r.verdict === 'REFUSE' ? 'out' : 'in';
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : '!!!!'} ${q.padEnd(12, ' ')} ${r.verdict.padEnd(7)} via=${(r.via || '-').padEnd(13)} ${r.refs}`);
  }
}
console.log('\n=== 灰区（只打印，不断言）===');
for (const q of GRAY) {
  const r = await run(q);
  console.log(`     ${q.padEnd(12, ' ')} ${r.verdict.padEnd(7)} via=${(r.via || '-').padEnd(13)} ${r.refs}`);
}
console.log(`\n异常 ${bad} 条`);
