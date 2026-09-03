// 生成 cases.gen.json —— 从知识库现存的 37 条 Q 标题，用**固定规则**机械派生口语变体。
// 规则可复现、可 diff、换文档自动跟随，所以这份**就是基线**，占着 cases.gen.json 这个名字。
// 模型手写的那 5 轴口语变体（简称/错别字/倒装/否定式/近义换词）不可复现，另存 `cases.human.json`：
// 两份各占一个文件名、永不互写，由 recall.mjs 合并读。（同目录同名互覆盖真丢过一次工作，别再犯。）
//
// 判定口径（与 recall.mjs 约定）：派生自 Qn 的变体，正解就是 Qn 本身。
// 但有一条公平性前提——**变体必须在标题层唯一可辨**。若同一串残余关键词还落在别的条目标题里
// （比如"宿舍""几点"这种满篇都是的词），那 top1 争不过去不算缺陷，标记 ambiguous 排除在门禁分母外。
//
// 用法：node gen-cases.mjs        # 重写 cases.gen.json（产物入库，换文档时 diff 得出用例漂移）
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';

const DB = process.env.KB_ASK_DB
  || '/Users/mac/Library/Application Support/dsh-desktop/harness/knowledge-base/kb.sqlite';
// 输出文件名固定 `cases.gen.json`（规则派生基线）。刻意**不**写 cases.human.json：
// 那份是模型手写的，只能人工维护，脚本一旦同写就会把不可复现的那套覆盖掉。
// 结构服从 recall.mjs 声明的契约（items[].{q,section,title,variants[].{axis,question}}），
// 每个 variant 多带 id/expect/residual/ambiguous/colliders 五个诊断字段，供 recall 摘出歧义分母。
const OUT = new URL('./cases.gen.json', import.meta.url).pathname;

// —— 与 kb-ask.mjs 的 itemsOf()/titleOf() 同语义的解析（那两处未导出，这里刻意保持一致）——
const MARK_RE = /^[ \t#>*-]{0,6}Q[ \t]*(\d+)[ \t]*[.、．]?/gim;
function titleOf(body) {
  const m = /\bA[：:]/.exec(body);
  if (m && m.index > 0) return body.slice(0, m.index);
  return (body.split(/(?<=[。！？?])/)[0] ?? body);
}
function itemsOf(payload) {
  const text = String(payload ?? '').replace(/\r/g, '');
  const marks = [];
  for (let m = (MARK_RE.lastIndex = 0, MARK_RE.exec(text)); m !== null; m = MARK_RE.exec(text)) {
    marks.push({ n: Number(m[1]), at: m.index });
  }
  const out = [];
  const clean = (s) => s.trim().replace(/^#+[ \t]*/, '').replace(/[ \t]+/g, ' ');
  // 与插件 itemsOf() 保持一致：单 Q 文件也必须成为可引用、可生成回归用例的条目。
  if (marks.length >= 1) {
    for (let i = 0; i < marks.length; i++) {
      const end = i + 1 < marks.length ? marks[i + 1].at : text.length;
      const body = clean(text.slice(marks[i].at, end));
      if (body !== '') out.push({ label: `第${i + 1}条 Q${marks[i].n}`, q: marks[i].n, body, title: titleOf(body) });
    }
    return out;
  }
  return [];                     // 无 Q 号的整体说明段不参与生成
}

const db = new DatabaseSync(DB, { readOnly: true });
const rows = db.prepare('select id, name, payload from kb order by id').all();
const ITEMS = [];
for (const r of rows) {
  const section = String(r.name ?? '').split('·').pop().trim().replace(/\.(md|txt)$/i, '')
    || String(r.name ?? '');
  for (const it of itemsOf(r.payload)) ITEMS.push({ ...it, section });
}

// —— 规则用的小词表：剥掉它们才剩下"这条到底在问什么"的残余关键词 ——
const PHRASES = ['请问', '请问下', '老师', '想问', '问一下', '是不是', '有没有', '多少', '什么', '哪里', '几点', '怎么', '如何'];
const CHARS = '？?！!。，,、；;：:（）()「」“”·/ \\的了吗呢啊呀吧么是有在就都还也很和小我你他它这那上下个些只台'.split('');
const norm = (s) => {
  let t = String(s);
  for (const p of PHRASES) t = t.split(p).join('');
  for (const c of CHARS) t = t.split(c).join('');
  return t;
};
const TITLE_NORM = ITEMS.map((it) => norm(it.title));

// 标题去掉编号前缀，再按问号切成子问句
function subQuestions(title) {
  const core = title.replace(/^\s*Q\d+\s*[.、．]?\s*/, '');
  return core.split(/[？?]/).map((s) => s.trim()).filter((s) => s.length >= 2);
}

const WH_SWAP = [['几点', '什么时候'], ['多少钱', '费用'], ['怎么', '如何'], ['吗', '不']];
// 两条必须带否向前瞻，否则规则会生成**没人会打出来的错字串**，白扣门禁分（实测我自己那 3 个 miss）：
//   在哪里 → 在哪儿里（Q2）  ·  几人间 → 几个人间（Q13）
const GUARDED = [[/在哪(?!儿)(?![里处])/g, '在哪儿'], [/几人(?!个)(?!间)/g, '几个人']];
// 注意顺序敏感：先 几点→什么时候，`什么时候→几点` 只对不含"几点"的句子生效。
const swap = (s) => {
  let t = s;
  if (!/几点/.test(t)) t = t.replace(/什么时候/g, '几点');
  for (const [a, b] of WH_SWAP) t = t.split(a).join(b);
  for (const [re, b] of GUARDED) t = t.replace(re, b);
  return t;
};

function rulesFor(title) {
  const subs = subQuestions(title);
  if (subs.length === 0) return [];
  const s1 = subs[0];
  const out = [['sub1', s1 + '？'], ['prefix', '请问' + s1 + '？'], ['bare', s1.replace(/[吗呢啊呀吧]+$/, '')]];
  if (subs.length > 1) out.push(['tail', subs[subs.length - 1] + '？']);
  const w = swap(s1);
  if (w !== s1) out.push(['whswap', w + '？']);
  // topic 只在"X有Y吗"这种 2 字主语上成立：限死 m1 长度，否则会把"报到当天|有人接站"
  // 从中间劈开，生成"报到当天人接站"这种没人会打的垃圾串，白扣门禁分。
  const m = /^(.{2})有(.{2,6}?)(?:吗|呢)?$/.exec(s1);
  if (m && !/(几|多少|哪|怎么|什么|几点|没)/.test(m[2])) out.push(['topic', m[1] + m[2]]);
  return out;
}

const cases = [];
let dropped = 0;
for (const [i, it] of ITEMS.entries()) {
  for (const [rule, q] of rulesFor(it.title)) {
    const residual = norm(q);
    if (residual.length < 2) { dropped++; continue; }
    const colliders = ITEMS.filter((o, j) => j !== i && TITLE_NORM[j].includes(residual)).map((o) => `Q${o.q}`);
    cases.push({
      // axis/question 是给 recall.mjs 读的契约字段；rule 与 axis 同值，留着只为老诊断脚本认得。
      id: `Q${it.q}-${rule}`, axis: rule, rule, question: q, expect: `Q${it.q}`,
      section: it.section, residual, ambiguous: colliders.length > 0, colliders,
    });
  }
}

// 按条目归组，服从 recall.mjs 的契约：items[].{q,section,title,variants[].{axis,question}}
const byQ = new Map();
for (const it of ITEMS) {
  byQ.set(`Q${it.q}`, { q: `Q${it.q}`, section: it.section, title: it.title, variants: [] });
}
for (const c of cases) byQ.get(c.expect).variants.push(c);
const items = [...byQ.values()].filter((it) => it.variants.length > 0);

const byRule = {};
for (const c of cases) {
  const b = (byRule[c.rule] ??= { n: 0, amb: 0 });
  b.n += 1;
  if (c.ambiguous) b.amb += 1;
}

const doc = {
  generatedBy: 'gen-cases.mjs（规则机械派生，可复现、可 diff、换文档自动跟随）',
  db: DB.split('/').pop(),        // 只留文件名：这是要进公开仓的产物，不写本机绝对路径
  category: '新生指南',
  axes: Object.keys(byRule),
  note: '与 cases.human.json（模型手写 5 轴）互补：这份量的是"改述后还认不认得"，那份量的是"口语化后漏不漏"。两份由 recall.mjs 合并读，永不互写。',
  itemCount: items.length,
  total: cases.length,
  ambiguous: cases.filter((c) => c.ambiguous).length,
  dropped,
  perRule: byRule,
  items,
};
writeFileSync(OUT, JSON.stringify(doc, null, 1));
console.log(`items=${items.length} cases=${cases.length} ambiguous=${doc.ambiguous} dropped=${dropped}`);
for (const [r, v] of Object.entries(byRule)) console.log(`  ${r.padEnd(7)} ${String(v.n).padStart(3)}  (歧义 ${v.amb})`);
console.log('-> ' + OUT);
