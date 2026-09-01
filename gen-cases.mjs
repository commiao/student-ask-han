// 生成 cases.gen.json —— 从知识库现存的 37 条 Q 标题，用**固定规则**机械派生口语变体。
// 为什么要机械：规则可复现、可 diff、换文档自动跟随；模型改写的不可复现，所以那份另存
// cases.llm.md 只做一次性体检，不进 CI 门禁。
//
// 判定口径（与 recall.mjs 约定）：派生自 Qn 的变体，正解就是 Qn 本身。
// 但有一条公平性前提——**变体必须在标题层唯一可辨**。若同一串残余关键词还落在别的条目标题里
// （比如"宿舍""几点"这种满篇都是的词），那 top1 争不过去不算缺陷，标记 ambiguous 排除在门禁分母外。
//
// 用法：node gen-cases.mjs        # 写 cases.gen.json
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';

const DB = process.env.KB_ASK_DB
  || '/Users/mac/Library/Application Support/dsh-desktop/harness/knowledge-base/kb.sqlite';
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
  if (marks.length >= 2) {
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

const WH_SWAP = [['几点', '什么时候'], ['多少钱', '费用'], ['在哪', '在哪儿'], ['怎么', '如何'],
  ['吗', '不'], ['几人', '几个人'], ['什么时候', '几点']];
// 注意顺序敏感：先 几点→什么时候，末尾那条 什么时候→几点 只对不含"几点"的句子生效。
const swap = (s) => {
  let t = s;
  if (!/几点/.test(t)) t = t.replace(/什么时候/g, '几点');
  for (const [a, b] of WH_SWAP) if (a !== '什么时候') t = t.split(a).join(b);
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
      id: `Q${it.q}-${rule}`, q, expect: `Q${it.q}`, section: it.section, rule,
      residual, ambiguous: colliders.length > 0, colliders,
    });
  }
}

const byRule = {};
for (const c of cases) {
  const b = (byRule[c.rule] ??= { n: 0, amb: 0 });
  b.n += 1;
  if (c.ambiguous) b.amb += 1;
}

const doc = {
  generated_by: 'gen-cases.mjs',
  db: DB.split('/').pop(),        // 只留文件名：这是要进公开仓的产物，不写本机绝对路径
  items: ITEMS.length,
  cases: cases.length,
  ambiguous: cases.filter((c) => c.ambiguous).length,
  dropped,
  per_rule: byRule,
  list: cases,
};
writeFileSync(OUT, JSON.stringify(doc, null, 1));
console.log(`items=${ITEMS.length} cases=${cases.length} ambiguous=${doc.ambiguous} dropped=${dropped}`);
for (const [r, v] of Object.entries(byRule)) console.log(`  ${r.padEnd(7)} ${String(v.n).padStart(3)}  (歧义 ${v.amb})`);
console.log('-> ' + OUT);
