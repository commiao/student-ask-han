// 入库前机检（只读）：docs 真源 out/ 与暂存区 intake/ 是否满足闭卷切块契约 + 全量投喂预算。
// 用法：node intake-check.mjs            审计 out/ 与 intake/（若有）
// 退出码：0 通过；1 有硬不合格项（不许搬进 out/）；2 环境/用法错。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('.', import.meta.url).pathname;
const cfgPath = join(ROOT, 'station', 'station.json');
if (!existsSync(cfgPath)) { console.error('找不到 ' + cfgPath); process.exit(2); }
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const MAX = Number(process.env.KB_CHECK_MAX) || cfg.fullDumpMax;
const load = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('.'))
  .sort().map((f) => ({ f, t: readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim() })) : []);

const DOCS = join(ROOT, 'out');
const STAGE = join(ROOT, 'intake');
const docs = load(DOCS);
const stage = load(STAGE);
// 同名即**替换**：intake/00-总体说明.md 是 out/00-总体说明.md 的新版本，预算与编号都只算新版一份。
const replaces = stage.filter((s) => docs.some((d) => d.f === s.f));
const netDocs = docs.filter((d) => !replaces.some((s) => s.f === d.f));
const netStage = stage;
const sum = (a) => a.reduce((n, x) => n + x.t.length, 0);
if (replaces.length) console.log('\n暂存里有同名文件，按替换计：' + replaces.map((r) => r.f).join('、') + '（旧版不再计入预算）');
const qOf = (t) => [...t.matchAll(/^##\s*Q(\d+)\./gm)].map((m) => Number(m[1]));
let hard = 0;
const die = (m) => { hard++; console.log('✗ ' + m); };
const warn = (m) => console.log('! ' + m);

console.log('docs 真源 ' + DOCS + '：' + docs.length + ' 个文件 / ' + sum(docs) + ' 字符');
if (stage.length) console.log('待收暂存 ' + STAGE + '：' + stage.length + ' 个文件 / ' + sum(stage) + ' 字符');

console.log('\n=== 全量投喂预算（第 6 轮事故：PDF 把库顶到 6601 越过 6000，全量投喂翻面，4 条答偏） ===');
const proj = sum(netDocs) + sum(netStage);
console.log((proj <= MAX ? '✓ ' : '✗ ') + '入库后合计 ' + proj + ' 字符 / 阈值 ' + MAX +
  ' → 全量投喂 ' + (proj <= MAX ? '开' : '**关（退回分级检索，全部正例要整批重排）**') + '　余量 ' + (MAX - proj));
if (proj > MAX) die('超预算：要么删内容，要么由人明确决定抬阈值并重跑全套门禁（不许悄悄抬）');

// —— 契约检查：替换后的最终形态（真源未被替换的部分 + 暂存）——
const all = [...netStage.map((s) => ({ ...s, where: 'intake/' })), ...netDocs.map((s) => ({ ...s, where: 'out/' }))];
const seen = new Map();
console.log('\n=== Q 编号：全局唯一 + 首行标题契约 + 有无可标注结构 ===');
for (const p of all) {
  const first = p.t.split('\n')[0];
  if (first.startsWith('#')) die(p.where + p.f + ' 首行是 markdown 标题（现有文档首行是纯文本章节名，插件按标题切块）');
  else if (!first.startsWith(cfg.title + ' ·')) die(p.where + p.f + ' 首行不是「' + cfg.title + ' · 章节名」：' + JSON.stringify(first));
  const qs = qOf(p.t);
  if (qs.length === 0) {
    const msg = p.where + p.f + ' 没有 `## Q数字.` 结构 → no-citable 门禁会把它剔出引用（能被投喂、永不能被标注，第 6 轮就是它引发 ANSWER 引用=[无]）';
    if (p.where === 'intake/') die(msg); else warn(msg);
  }
  for (const q of qs) {
    if (seen.has(q)) die('Q' + q + ' 编号冲突：' + seen.get(q) + ' 与 ' + p.where + p.f);
    else seen.set(q, p.where + p.f);
  }
}
const nums = [...seen.keys()].sort((a, b) => a - b);
if (nums.length) {
  const gaps = [];
  for (let i = 1; i <= nums[nums.length - 1]; i++) if (!seen.has(i)) gaps.push(i);
  console.log('  合计 ' + nums.length + ' 条 Q（' + nums[0] + '–' + nums[nums.length - 1] + '）' +
    (gaps.length ? '　断号 ' + JSON.stringify(gaps) + '（gen-cases 按编号派生用例，断号会让对账误判）' : '　连续无断号 ✓'));
  if (gaps.length) warn('有断号');
}
if (stage.length) {
  // 续号的基准是**真源**里的最大编号（把暂存算进去会永远"差一"）。
  const docMax = Math.max(0, ...docs.flatMap((x) => qOf(x.t)));
  const sQ = stage.flatMap((x) => qOf(x.t));
  if (sQ.length && Math.min(...sQ) !== docMax + 1) {
    warn('暂存从 Q' + Math.min(...sQ) + ' 起，真源最大 Q' + docMax + ' → 应从 Q' + (docMax + 1) + ' 续号（断号会让 gen-cases 对账误判）');
  } else if (sQ.length) {
    console.log('  暂存续号 Q' + Math.min(...sQ) + '–Q' + Math.max(...sQ) + ' 接真源 Q' + docMax + ' ✓');
  }
}

console.log('\n=== 零宽/不可见字符（第 6 轮 rowId 22 标题末尾就是 U+200B） ===');
let invis = 0;
for (const p of all) {
  const n = [...p.t].filter((ch) => [0x200b, 0x200c, 0x200d, 0xfeff, 0x2060].includes(ch.codePointAt(0))).length;
  if (n) { invis += n; die(p.where + p.f + ' 含 ' + n + ' 个零宽字符'); }
}
console.log(invis ? '共 ' + invis + ' 处' : '✓ 无');

console.log('\n=== 时效性/未定稿措辞（闭卷库写进去就是过期答案；真源里是历史遗留，暂存区里必须先改） ===');
const TIMEY = ['明天', '后天', '后续通知', '等学校', '暂定', '抓紧时间', '如果有新的要求', '目前还不清楚', '以通知为准'];
for (const k of TIMEY) {
  const hit = all.filter((p) => p.t.includes(k));
  if (hit.length) console.log('  ! ' + k.padEnd(8) + ' → ' + hit.map((p) => p.where + p.f.replace('.md', '')).join('、'));
}

console.log('\n=== 联系方式（会被机器人在群里逐字复述） ===');
const PII = [['手机号', /1[3-9]\d{9}/g], ['座机', /0\d{2}-?\d{7,8}/g], ['群号/QQ 号', /(?<!\d)\d{8,11}(?!\d)/g], ['微信号', /微信号\s*[a-zA-Z][\w-]{3,}/g]];
for (const [label, re] of PII) {
  const hits = new Set();
  for (const p of all) for (const m of p.t.matchAll(re)) hits.add(m[0] + '@' + p.where + p.f.replace('.md', ''));
  console.log('  ' + label.padEnd(6) + ' ' + hits.size + ' 处' + (hits.size ? '：' + [...hits].join('  ') : ''));
}

console.log('\n' + (hard === 0
  ? '机检通过。要收编：把 intake/ 的文件搬进 out/ → station/kbctl.mjs build --apply → gen-cases → recall。'
  : '机检 ' + hard + ' 项硬不合格：先改文档，别搬进 out/。'));
process.exit(hard === 0 ? 0 : 1);
