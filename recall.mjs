// 任务 1：文档自召回测试。
//
// cases.gen.json 里每个 Qn 条目配 5 个口语变体（由模型手写），这里逐条调 kb_ask，
// 断言**返回引用里的 top1 必须是该条目**（比对（指南·章节 第N条 Qn）里的 Qn）。
// 只看 ANSWER/REFUSE 不够——小库全量投喂下几乎什么都"能答"，正解没排第一就是答非所问。
//
// 用法：node recall.mjs          # 汇总 + 全部 miss 清单
//       node recall.mjs --json   # 另外输出机器可读 JSON（逐条结果，给诊断脚本用）
// 退出码：有 miss → 1；全绿 → 0；用例集与库条目对不上 → 2。
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const TARGET = process.env.KB_ASK_TARGET === 'installed'
  ? '/Users/mac/Library/Application Support/dsh-desktop/harness/.agent-presets/kb-qa/kb-ask.mjs'
  : '/Users/mac/work-deepseek/kb/preset-kb-qa/kb-ask.mjs';
const DB = process.env.KB_ASK_DB
  || '/Users/mac/Library/Application Support/dsh-desktop/harness/knowledge-base/kb.sqlite';
const CASES = new URL('./cases.gen.json', import.meta.url).pathname;

const cfg = JSON.parse(readFileSync(CASES, 'utf8'));
// 契约检查：cases.gen.json 必须是 {items:[{q,section,title,variants:[{axis,question}]}]}。
// 这文件有两个来源（模型手写 5 型 / 规则机械派生）在同目录里互相覆盖过，schema 一对不上就当场炸，
// 不要拿一份错格式的喂出假的 100%。
if (!Array.isArray(cfg.items) || cfg.items.length === 0
  || !Array.isArray(cfg.items[0]?.variants) || typeof cfg.items[0]?.q !== 'string'
  || typeof cfg.items[0]?.section !== 'string') {
  console.error(`cases.gen.json 结构不符合契约（要 items[].{q,section,variants[].{axis,question}}），`
    + `实际顶层键=${Object.keys(cfg).join(',')}。多半是被别的生成器覆盖了，先确认再跑。`);
  process.exit(2);
}
const { apply } = await import(`file://${TARGET}`);
let tool = null;
const dispose = apply({ logger: { warn: () => {} }, tools: { register: (d) => { tool = d; } } }, {
  db: DB,
  refusal: '该问题超出范围了，请联系管理员',
  docTitle: '电子信息工程学院新生必备指南',
  category: cfg.category || '新生指南',
});
if (!tool) { console.error('工具没注册上'); process.exit(2); }

// 用例集必须和库里的 Qn 一一对应：文档换了（增删条目）时先在这里炸，别默默漏测。
const db = new DatabaseSync(DB, { readOnly: true });
const inDb = new Set();
for (const r of db.prepare('select payload from kb').all()) {
  const re = /^[ \t#>*-]{0,6}Q[ \t]*(\d+)/gim;
  for (let m = re.exec(String(r.payload ?? '')); m !== null; m = re.exec(String(r.payload ?? ''))) inDb.add(Number(m[1]));
}
db.close();
const caseQs = cfg.items.map((it) => Number(String(it.q).replace(/^Q/i, '')));
const orphans = caseQs.filter((n) => !inDb.has(n));
const uncovered = [...inDb].filter((n) => !caseQs.includes(n));
if (orphans.length > 0 || uncovered.length > 0) {
  console.error(`用例集与库不一致：库里没有 Q${orphans.join('/Q')}；用例漏了 Q${uncovered.join('/Q')}`);
  process.exit(2);
}

/** 从 kb_ask 输出里取引用序列：只认 reply 之后的部分，提示行里也带「（指南·…）」字样。 */
function citesOf(text) {
  const i = text.indexOf('reply:\n');
  if (i < 0) return [];
  return (text.slice(i).match(/（指南·[^）]+）/g) ?? [])
    .map((c) => /Q(\d+)/.exec(c)?.[1])
    .filter(Boolean)
    .map((n) => `Q${n}`);
}

const rows = [];
for (const it of cfg.items) {
  for (const v of it.variants) {
    const text = await tool.execute({ question: v.question });
    const verdict = text.split('\n')[0].trim();
    const cites = citesOf(text);
    rows.push({
      q: it.q,
      section: it.section,
      axis: v.axis,
      question: v.question,
      verdict,
      via: verdict === 'REFUSE' ? (/via: (\S+)/.exec(text)?.[1] ?? '检索门禁') : '检索',
      top1: cites[0] ?? null,
      cites: cites.join(','),
    });
  }
}
dispose?.();

const hit = (r) => r.verdict === 'ANSWER' && r.top1 === r.q;
const ok = rows.filter(hit);
const miss = rows.filter((r) => !hit(r));
const per = new Map();
for (const r of rows) {
  const s = per.get(r.q) ?? { section: r.section, total: 0, pass: 0 };
  s.total += 1;
  if (hit(r)) s.pass += 1;
  per.set(r.q, s);
}

console.log(`测试目标: ${TARGET}`);
console.log(`条目数: ${cfg.items.length}　用例数: ${rows.length}　通过: ${ok.length}　miss: ${miss.length}`
  + `　自召回率: ${((ok.length / rows.length) * 100).toFixed(1)}%`);
console.log(`5 型全中的条目: ${[...per.values()].filter((s) => s.pass === s.total).length} / ${per.size}`);
const byAxis = {};
for (const r of rows) {
  byAxis[r.axis] = byAxis[r.axis] ?? { total: 0, pass: 0 };
  byAxis[r.axis].total += 1;
  if (hit(r)) byAxis[r.axis].pass += 1;
}
console.log('分轴通过率: ' + Object.entries(byAxis).map(([k, v]) => `${k} ${v.pass}/${v.total}`).join('　'));

if (miss.length > 0) {
  console.log(`\n=== miss 清单（${miss.length} 条）===`);
  for (const r of miss) {
    console.log(`${r.q.padEnd(4)} ${r.axis.padEnd(5)} ${(r.verdict + ':' + r.via).padEnd(18)} ${r.question}`
      + ` → top1=${r.top1 ?? '—'}  引用=[${r.cites || '无'}]`);
  }
  console.log('\n按条目聚合：');
  for (const q of new Set(miss.map((m) => m.q))) {
    const list = miss.filter((m) => m.q === q);
    console.log(`  ${q}（${list[0].section}）: ` + list.map((m) => `${m.axis}→${m.top1 ?? m.verdict}`).join(' '));
  }
}
if (process.argv.includes('--json')) console.log('\n' + JSON.stringify({ ok: ok.length, miss: miss.length, rows }));
process.exit(miss.length > 0 ? 1 : 0);
