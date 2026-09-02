// 一个脚本回答三个问题：
//   正例——「该答的答得上来吗」；负例——「不该答的一个都没答吗」；别名对账——「ALIASES 还和文档词表对得上吗」。
//   只测第一个等于没测：小库全量投喂下几乎什么都"能答"，而放宽召回的代价全在后两项上。
//
// 正例集**合并读两份**（刻意各占一个文件名、永不互写；同名互覆盖真丢过一次工作）：
//   cases.gen.json    规则机械派生（`node gen-cases.mjs` 产物，可复现、可 diff、换文档自动跟随）→ 基线
//   cases.human.json  模型手写 5 轴口语变体（简称/错别字/倒装/否定式/近义换词），不可复现 → 补充
// 负例集：cases.neg.md（不带 ? 的每一条都是硬门禁，返回 ANSWER 即假阳性）。
//
// 断言口径：**返回引用里的 top1 必须是该条目**（比对（指南·章节 第N条 Qn）里的 Qn）。
// 规则派生变体带 `ambiguous`（残余关键词还落在别条条目标题里）：那种 top1 争不过去不算缺陷，
// 只报不判、排除在门禁分母外——否则分母被噪声污染，绿也就没意义了。
//
// 用法：node recall.mjs          # 汇总 + miss 清单 + 负例结果 + 别名对账
//       node recall.mjs --json   # 另外输出机器可读 JSON（逐条结果，给诊断脚本用）
// 退出码：miss / 负例误放 / 固定话术变形 / 别名失效 → 1；全绿 → 0；用例集与库或契约对不上 → 2。
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { auditAliases, extractAliases, normalize } from './alias-audit.mjs';
import { defaultDb, targetPlugin } from './test-paths.mjs';

const TARGET = targetPlugin(process.env.KB_ASK_TARGET || 'workspace');
if (!TARGET) throw new Error('定位不到 kb-ask.mjs；请设置 DSH_HOME 或 KB_ASK_INSTALLED');
const DB = defaultDb();
if (!DB) throw new Error('定位不到 kb.sqlite；请设置 DSH_HOME 或 KB_ASK_DB');
const HERE = import.meta.url;
const SOURCES = [
  { file: new URL('./cases.gen.json', HERE).pathname, source: 'gen', why: '规则派生基线' },
  { file: new URL('./cases.human.json', HERE).pathname, source: 'human', why: '模型手写口语变体' },
];
const NEG_FILE = new URL('./cases.neg.md', HERE).pathname;
const REFUSAL = '该问题超出范围了，请联系管理员';

const num = (q) => Number(String(q).replace(/^Q/i, ''));

/** 契约：{items:[{q,section,title,variants:[{axis,question}]}]}。缺文件或结构不对都当场炸。 */
function loadCases(file, source) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    // 少一份用例集 = 静默缩水覆盖率，正是丢工作那种失败模式，不许降级运行。
    console.error(`${source} 用例集读不了（${file}）：${e.message}`);
    console.error('两份正例集都必须存在：cases.gen.json 由 `node gen-cases.mjs` 重生成，'
      + 'cases.human.json 只能人工维护。');
    process.exit(2);
  }
  if (!Array.isArray(raw.items) || raw.items.length === 0
    || !Array.isArray(raw.items[0]?.variants) || typeof raw.items[0]?.q !== 'string'
    || typeof raw.items[0]?.section !== 'string') {
    console.error(`${file} 结构不符合契约（要 items[].{q,section,variants[].{axis,question}}），`
      + `实际顶层键=${Object.keys(raw).join(',')}。多半是被别的生成器覆盖了，先确认再跑。`);
    process.exit(2);
  }
  for (const it of raw.items) {
    for (const v of it.variants) {
      if (typeof v?.question !== 'string' || v.question.trim() === ''
        || typeof v?.axis !== 'string' || v.axis.trim() === '') {
        console.error(`${file} 条目 ${it.q} 有 variant 缺 axis/question：${JSON.stringify(v)}`
          + `（规则派生那份应由 gen-cases.mjs 重生成，别手改产物）`);
        process.exit(2);
      }
    }
  }
  return raw;
}

// —— 合并：按 Qn 归组，变体按 (期望条目, 问句原文) 去重，重复的把来源并进 sources ——
const merged = new Map();
let category = null;
for (const { file, source } of SOURCES) {
  const raw = loadCases(file, source);
  category ??= raw.category || '新生指南';
  for (const it of raw.items) {
    const key = String(it.q).toUpperCase();
    if (!merged.has(key)) merged.set(key, { q: key, section: it.section, title: it.title, variants: [], seen: new Map() });
    const box = merged.get(key);
    for (const v of it.variants) {
      const dk = v.question.replace(/\s+/g, '');
      const dup = box.seen.get(dk);
      if (dup) {
        if (!dup.sources.includes(source)) dup.sources.push(source);
        dup.ambiguous ||= v.ambiguous === true;   // 任一份标了歧义就按歧义处理：宁可少判，不可误判
        continue;
      }
      const row = {
        axis: v.axis, question: v.question, sources: [source],
        ambiguous: v.ambiguous === true, colliders: v.colliders ?? [],
      };
      box.seen.set(dk, row);
      box.variants.push(row);
    }
  }
}
const items = [...merged.values()].sort((a, b) => num(a.q) - num(b.q));

const { apply } = await import(`file://${TARGET}`);
let tool = null;
const dispose = apply({ logger: { warn: () => {} }, tools: { register: (d) => { tool = d; } } }, {
  db: DB,
  refusal: REFUSAL,
  docTitle: '电子信息工程学院新生必备指南',
  category,
});
if (!tool) { console.error('工具没注册上'); process.exit(2); }

// 用例集必须和库里的 Qn 一一对应：文档换了（增删条目）时先在这里炸，别默默漏测。
const db = new DatabaseSync(DB, { readOnly: true });
const inDb = new Set();
const kbRows = [];
for (const r of db.prepare('select name, summary, payload, tags from kb').all()) {
  const re = /^[ \t#>*-]{0,6}Q[ \t]*(\d+)/gim;
  for (let m = re.exec(String(r.payload ?? '')); m !== null; m = re.exec(String(r.payload ?? ''))) inDb.add(Number(m[1]));
  // 语料口径与引擎 idsForTerm() 一致：四列拼起来做子串匹配（转小写、去空白）。
  kbRows.push({ text: normalize([r.name, r.summary, r.payload, r.tags].join(' ')) });
}

// 别名表 ↔ 文档词表对账（第 4 轮 ①）。为什么在这里而不是等人看负例：换一份手册时
// ALIASES 会**成批**失效（展开词不再是文档原词 → 死别名；或太泛 → 放行面），
// 而所有正负例照样全绿。第 3 轮那两条（门口、被褥）是靠负例集偶然抓到的，不能指望运气。
let aliasFails = [];
let aliasWarns = [];
let aliasNotes = [];
let aliasCount = 0;
try {
  const entries = extractAliases(TARGET);
  aliasCount = entries.length;
  const a = auditAliases(entries, kbRows);
  aliasFails = a.fails;
  aliasWarns = a.warns;
  aliasNotes = a.notes;
} catch (e) {
  console.error(`别名对账跑不起来：${e.message}`);
  process.exit(2);
}
db.close();
const caseQs = items.map((it) => num(it.q));
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

/** reply 段（reply: 之后的全部行）。 asker 为空时 REFUSE 的 reply 应逐字只有固定话术。 */
function replyOf(text) {
  const i = text.indexOf('reply:\n');
  return i < 0 ? null : text.slice(i + 'reply:\n'.length);
}

async function ask(question) {
  const text = String(await tool.execute({ question }));
  const verdict = text.split('\n')[0].trim();
  return {
    text,
    verdict,
    via: verdict === 'REFUSE' ? (/via: (\S+)/.exec(text)?.[1] ?? '检索门禁') : '检索',
    cites: citesOf(text),
    reply: replyOf(text),
  };
}

// ───────────────────────────── 正例 ─────────────────────────────
const rows = [];
for (const it of items) {
  for (const v of it.variants) {
    const r = await ask(v.question);
    rows.push({
      q: it.q, section: it.section, axis: v.axis, sources: v.sources.join('+'),
      question: v.question, ambiguous: v.ambiguous, colliders: v.colliders,
      verdict: r.verdict, via: r.verdict === 'REFUSE' ? r.via : '检索',
      top1: r.cites[0] ?? null, cites: r.cites.join(','),
    });
  }
}

const isHit = (r) => r.verdict === 'ANSWER' && r.top1 === r.q;
const gated = rows.filter((r) => !r.ambiguous);           // 门禁分母
const exempt = rows.filter((r) => r.ambiguous);           // 只报不判
const ok = gated.filter(isHit);
const miss = gated.filter((r) => !isHit(r));

const per = new Map();
for (const r of gated) {
  const s = per.get(r.q) ?? { section: r.section, total: 0, pass: 0 };
  s.total += 1;
  if (isHit(r)) s.pass += 1;
  per.set(r.q, s);
}
const tallyBy = (key) => {
  const m = {};
  for (const r of gated) {
    const k = r[key];
    (m[k] ??= { total: 0, pass: 0 });
    m[k].total += 1;
    if (isHit(r)) m[k].pass += 1;
  }
  return m;
};

console.log(`测试目标: ${TARGET}`);
console.log(`正例集: ${SOURCES.map((s) => `${s.source}=${s.file.split('/').pop()}（${s.why}）`).join(' + ')}`);
console.log(`条目数: ${items.length}　用例数: ${rows.length}（歧义豁免 ${exempt.length}）　门禁内: ${gated.length}`
  + `　通过: ${ok.length}　miss: ${miss.length}　自召回率: ${((ok.length / gated.length) * 100).toFixed(1)}%`);
console.log(`全中的条目: ${[...per.values()].filter((s) => s.pass === s.total).length} / ${per.size}`);
for (const [key, label] of [['sources', '按来源'], ['axis', '按轴']]) {
  console.log(`${label}通过率: ` + Object.entries(tallyBy(key))
    .map(([k, v]) => `${k} ${v.pass}/${v.total}${v.pass === v.total ? '' : ' ✗'}`).join('　'));
}

if (miss.length > 0) {
  console.log(`\n=== miss 清单（${miss.length} 条）===`);
  for (const r of miss) {
    console.log(`${r.q.padEnd(4)} ${r.sources.padEnd(11)} ${r.axis.padEnd(7)} ${(r.verdict + ':' + r.via).padEnd(18)} ${r.question}`
      + ` → top1=${r.top1 ?? '—'}  引用=[${r.cites || '无'}]`);
  }
  console.log('\n按条目聚合：');
  for (const q of new Set(miss.map((m) => m.q))) {
    const list = miss.filter((m) => m.q === q);
    console.log(`  ${q}（${list[0].section}）: ` + list.map((m) => `${m.axis}→${m.top1 ?? m.verdict}`).join(' '));
  }
}
if (exempt.length > 0) {
  console.log(`\n=== 歧义豁免（不计门禁，${exempt.length} 条）===`);
  for (const r of exempt) {
    console.log(`${r.q.padEnd(4)} ${r.axis.padEnd(7)} ${isHit(r) ? '命中' : '未命中'}　${r.question}`
      + `　撞标题: ${r.colliders.join('/') || '—'}`);
  }
}

// ───────────────────────────── 负例 ─────────────────────────────
// cases.neg.md 的口径（写在它自己文件头）：不带 `?` 的每一条必须 REFUSE；带 `?` 的是诊断项，
// 文档确实可能沾边，出 ANSWER 由人判读、不计门禁。小节标题点了名门禁的（behavior-gate /
// intent-gate），额外核对拦截层——层不符只是可观测性退化，不是放行，所以只告警不判失败。
function loadNegs(file) {
  const out = [];
  let section = '（无小节）';
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const h = /^##+\s+(.*)$/.exec(line.trim());
    if (h) { section = h[1].trim(); continue; }
    const b = /^[-*]\s+(.+)$/.exec(line.trim());
    if (!b) continue;
    const raw = b[1].trim();
    if (raw === '') continue;
    // 实际约定（看第 6 小节）：诊断项写作 `- ? 问句`，`?` 是**行首标记**而不是句子里的问号。
    // 小节标题点了"诊断"二字的同样算诊断项，两处任中其一即豁免门禁。
    const marked = /^\?\s*/.test(raw);
    const question = marked ? raw.replace(/^\?\s*/, '').trim() : raw;
    const diagnostic = marked || /诊断/.test(section) || question === '';
    out.push({
      section,
      question,
      hard: !diagnostic,
      expectVia: (/([a-z][a-z-]*-gate)/.exec(section) || [])[1] ?? null,
    });
  }
  return out;
}

const negRows = [];
for (const n of loadNegs(NEG_FILE)) {
  const r = await ask(n.question);
  negRows.push({ ...n, verdict: r.verdict, via: r.via, cites: r.cites.join(','), reply: r.reply });
}
const hard = negRows.filter((r) => r.hard);
const falsePositives = hard.filter((r) => r.verdict !== 'REFUSE');
const wrongLayer = hard.filter((r) => r.verdict === 'REFUSE' && r.expectVia && r.via !== r.expectVia);
const diagAnswer = negRows.filter((r) => !r.hard && r.verdict !== 'REFUSE');
// REFUSE 出口的形状一并复查：asker 为空时 reply 段必须逐字只有固定话术，不得多一行。
const replyBroken = hard.filter((r) => r.verdict === 'REFUSE' && r.reply !== REFUSAL);

console.log(`\n=== 负例门禁（${NEG_FILE.split('/').pop()}）===`);
console.log(`硬负例 ${hard.length} 条：误放 ${falsePositives.length}　固定话术变形 ${replyBroken.length}　`
  + `拦截层退化（仅告警）${wrongLayer.length}　诊断项出 ANSWER ${diagAnswer.length} 条`);
for (const r of falsePositives) {
  console.log(`  !!! 误放 [${r.section}] ${r.question} → ANSWER 引用=[${r.cites || '无'}]`);
}
for (const r of replyBroken) {
  console.log(`  !!! 话术变形 [${r.section}] ${r.question} → reply=${JSON.stringify(r.reply)}`);
}
for (const r of wrongLayer) {
  console.log(`  ~~~ 层不符 [${r.section}] ${r.question} 期望 ${r.expectVia}，实际 ${r.via}`);
}
for (const r of diagAnswer) {
  console.log(`  ??? 诊断项 [${r.section}] ${r.question} → ANSWER 引用=[${r.cites || '无'}]（由人判读）`);
}

dispose?.();

console.log(`\n=== 别名对账（${TARGET.split('/').pop()} 的 ALIASES ↔ 库内原词）===`);
console.log(`别名 ${aliasCount} 条：致命 ${aliasFails.length}　告警 ${aliasWarns.length}`);
for (const f of aliasFails) console.log(`  !!! ${f}`);
for (const w of aliasWarns) console.log(`  ~~~ ${w}`);
if (aliasNotes.length > 0) {
  console.log(`  · 说明：${aliasNotes.length} 条别名的 key 本身就是文档原词（${aliasNotes.slice(0, 8).join(' ')}${aliasNotes.length > 8 ? ' …' : ''}）`
    + '——这类行只补展开词，救不了"key 匹配不上"的 miss');
}

const bad = miss.length + falsePositives.length + replyBroken.length + aliasFails.length;
if (process.argv.includes('--json')) {
  console.log('\n' + JSON.stringify({
    ok: ok.length, miss: miss.length, exempt: exempt.length,
    hardNegs: hard.length, falsePositives: falsePositives.length, wrongLayer: wrongLayer.length,
    aliasFails, aliasWarns,
    rows, negs: negRows,
  }));
}
console.log(bad === 0
  ? '\n正例全绿、负例零误放、固定话术未变形、别名表与文档词表对得上。'
  : `\n不通过：miss ${miss.length}　负例误放 ${falsePositives.length}　固定话术变形 ${replyBroken.length}　`
    + `别名失效 ${aliasFails.length}`);
process.exit(bad > 0 ? 1 : 0);
