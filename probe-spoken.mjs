// 口语换词探针：量「换个词说，还答得上来吗」。
//
//   与 recall.mjs 的分工：recall 测的是 cases.gen/cases.human——两者都由条目标题**派生**，
//   所以它天然测不到"词表错配"（实测：派生集自召回 100%，而本探针首跑只有 42% 命中）。
//   本探针**不是门禁**：误拒/错项只报数，不让 CI 变红；唯一硬失败的是 `__OUT__` 被答了
//   （那是闭卷承诺破了），以及用例文件缺失/结构不对。
//
//   误拒会拆成两类，因为这个区分决定"要不要上语义层"：
//     A 类｜问句的二元组**确实出现在**期望条目原文里 → 词表是对的，短问句过不了覆盖率，
//          属于阈值/粒度问题，补别名或改口径就能救，**不该交给模型**。
//     B 类｜问句与期望条目**零二元组重合** → 真词表错配，才是别名表或语义层该吃的那口。
//
// 用法：node probe-spoken.mjs                       # 仓库那份引擎
//       KB_ASK_TARGET=installed node probe-spoken.mjs   # 已安装那份
// 退出码：__OUT__ 被答 → 1；文件缺失/结构不对 → 2；其余（含误拒再多）→ 0。
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { defaultDb, targetPlugin } from './test-paths.mjs';

const TARGET = targetPlugin(process.env.KB_ASK_TARGET || 'workspace');
if (!TARGET) { console.error('定位不到 kb-ask.mjs；设置 DSH_HOME 或 KB_ASK_INSTALLED'); process.exit(2); }
const DB = defaultDb();
if (!DB) { console.error('定位不到 kb.sqlite；设置 DSH_HOME 或 KB_ASK_DB'); process.exit(2); }
const CASES = new URL('./cases.spoken.json', import.meta.url).pathname;

let parsed;
try {
  parsed = JSON.parse(readFileSync(CASES, 'utf8'));
} catch (e) {
  console.error(`读不到 ${CASES}：${e.message}`);
  process.exit(2);
}
const cases = Array.isArray(parsed?.cases) ? parsed.cases : null;
if (!cases) { console.error('cases.spoken.json 结构不对：要 {cases:[{q,expect:[..]}]}'); process.exit(2); }
for (const c of cases) {
  if (typeof c.q !== 'string' || !Array.isArray(c.expect) || !c.expect.length) {
    console.error(`用例结构不对：${JSON.stringify(c)}`);
    process.exit(2);
  }
}

// 条目原文：用来判"问句的词到底在不在文档里"（A/B 分类的依据）。
const items = new Map();
{
  const db = new DatabaseSync(DB, { readOnly: true });
  const rows = db.prepare('select payload from kb').all();
  db.close();
  for (const r of rows) {
    for (const line of String(r.payload).split('\n')) {
      const m = /^#+\s*(Q\d+)[\.、\s]\s*(.*)$/.exec(line.trim());
      if (m) items.set(m[1], (items.get(m[1]) ?? '') + '\n' + line.trim());
    }
  }
}
const strip = (s) => s.replace(/[?？!！。，、,.\s吗呢吧啊呀的了我你他她它]/g, '');
/** 问句二元组里有多少个真的出现在期望条目原文里（>0 即"A 类：词表对，口径亏"）。 */
function overlap(q, expect) {
  const clean = strip(q);
  const grams = [];
  for (let i = 0; i + 2 <= clean.length; i++) {
    const g = clean.slice(i, i + 2);
    if (!grams.includes(g)) grams.push(g);
  }
  const hit = [];
  for (const id of expect) {
    const body = items.get(id) ?? '';
    for (const g of grams) if (body.includes(g)) hit.push(`${id}:${g}`);
  }
  return { grams: grams.length, hit };
}

const { apply } = await import(`file://${TARGET}`);
let tool = null;
apply({ logger: { warn: () => {} }, tools: { register: (d) => { tool = d; } } }, { db: DB });

const hit = [], rankOnly = [], refuseA = [], refuseB = [], wrong = [], leaked = [];
for (const c of cases) {
  const out = await tool.execute({ question: c.q, asker: '探针' });
  const cited = [...out.matchAll(/第\d+条 (Q\d+)/g)].map((m) => m[1]);
  const wantOut = c.expect[0] === '__OUT__';
  if (!/^ANSWER/.test(out)) {
    if (wantOut) continue;                       // 正确拒答，不计
    const o = overlap(c.q, c.expect);
    (o.hit.length ? refuseA : refuseB).push(`${c.q}　期望 ${c.expect.join('/')}　${o.hit.length ? `原词命中 ${o.hit.join(' ')}` : `零重合（问句 ${o.grams} 个二元组）`}`);
    continue;
  }
  if (wantOut) { leaked.push(`${c.q}　→引用 ${cited.join(',') || '(无条目号)'}`); continue; }
  const pos = c.expect.map((e) => [e, cited.indexOf(e)]).filter((p) => p[1] >= 0);
  if (!pos.length) { wrong.push(`${c.q}　期望 ${c.expect.join('/')}　实际引用 ${cited.join(',') || '(无)'}`); continue; }
  const best = pos.reduce((a, b) => (b[1] < a[1] ? b : a));
  (best[1] === 0 ? hit : rankOnly).push({ q: c.q, id: best[0], rank: best[1] + 1, cited });
}
const good = hit.length + rankOnly.length;
const inSet = cases.filter((c) => c.expect[0] !== '__OUT__').length;
const negSet = cases.length - inSet;

console.log(`目标引擎：${TARGET}`);
console.log(`条目原文：${items.size} 条　探针问句：${cases.length}（范围内 ${inSet}　越界对照 ${negSet}）\n`);
console.log(`口语通过率　${good} / ${inSet} = ${(good * 100 / inSet).toFixed(1)}%`);
console.log(`  其中排 top1 ${hit.length}　被别的条目压在前面 ${rankOnly.length}`);
console.log(`误拒　${refuseA.length + refuseB.length}（A 类 词表对/口径亏 ${refuseA.length}　B 类 真词表错配 ${refuseB.length}）`);
console.log(`错项　${wrong.length}　越界被答 ${leaked.length}（这一项非 0 就是闭卷破了）`);
const show = (t, a) => { if (a.length) { console.log(`\n── ${t} ──`); for (const x of a) console.log('  ', typeof x === 'string' ? x : `${x.q}（期望 ${x.id} 排在第 ${x.rank} 位）`); } };
show('A 类误拒｜该修口径/别名，不该上模型', refuseA);
show('B 类误拒｜真词表错配', refuseB);
show('错项｜答了别的条目', wrong);
show('排不进 top1', rankOnly);
show('越界被答（硬失败）', leaked);
if (leaked.length) { console.log('\n结论：有越界问句被回答，闭卷承诺已破 → 退出 1'); process.exit(1); }
console.log('\n越界侧无回退。误拒/错项是**读数**，不改退出码——它们决定下一步修哪一层。');
