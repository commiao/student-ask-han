// 只读体检：库内容与 docs 是否一致、删除有没有在 FTS 索引层留幽灵。
// 用法：node kb-health.mjs                      查线上库（默认路径按平台解析）
//       KB_HEALTH_DB=<path> node kb-health.mjs  查指定库（如 dist/kb.sqlite）
//       KB_HEALTH_DOCS=<dir>                    指定 docs 目录（默认 out/）
// 退出码：0 内容层一致（FTS 可降级）；1 内容有出入或库读不到；2 用法/环境错。
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { defaultDb } from './test-paths.mjs';

const ROOT = new URL('.', import.meta.url).pathname;
const DB = process.env.KB_HEALTH_DB || defaultDb(process.env);
if (!DB || !existsSync(DB)) {
  console.error('找不到知识库文件：' + (DB || '（路径解析为空）')
    + '\n用 KB_HEALTH_DB=<path> 指定，或先跑 station/kbctl.mjs doctor 看宿主根目录。');
  process.exit(2);
}
const DOCS = process.env.KB_HEALTH_DOCS || join(ROOT, 'out');
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
// 只在 FTS 里探针：这些词只出现在"曾经导入又被删掉"的内容里，命中即为幽灵。
const GHOST_PROBES = ['家庭贫困', '精华消息', '明令禁止'];

let db;
try {
  db = new DatabaseSync(DB, { readOnly: true });
} catch (e) {
  console.error('打不开库（readOnly）：' + e.message);
  process.exit(1);
}
const rows = db.prepare('SELECT id, category, name, source, payload FROM kb ORDER BY id').all();
console.log('库：' + DB);
console.log('条目 ' + rows.length + ' 条 / ' +
  rows.reduce((a, r) => a + r.payload.length, 0) + ' 字符 / ' +
  rows.reduce((a, r) => a + (r.payload.match(/^##\s*Q/gm) || []).length, 0) + ' 个 Q 段');
console.log('分类：' + JSON.stringify(db.prepare('SELECT category, COUNT(*) n FROM kb GROUP BY category').all()));
const nonMd = rows.filter((r) => !/\.md$/.test(String(r.source)));
console.log('非 md 来源：' + JSON.stringify(nonMd.map((r) => ({ id: r.id, source: r.source }))));

let bad = 0;
if (!existsSync(DOCS)) {
  console.error('\n✗ docs 目录不存在：' + DOCS);
  process.exit(2);
}
console.log('\n=== 内容对账（库 payload vs ' + DOCS.split('/').pop() + '/*.md） ===');
const docFiles = readdirSync(DOCS).filter((n) => n.endsWith('.md')).sort();
for (const f of docFiles) {
  const want = readFileSync(join(DOCS, f), 'utf8').replace(/\r\n/g, '\n').trim();
  const mine = rows.filter((r) => String(r.source) === f);
  const okOne = mine.length === 1 && sha(mine[0].payload) === sha(want);
  if (!okOne) bad++;
  console.log((okOne ? '= ' : '≠ ') + f.padEnd(18) + ' 库条目 ' + mine.length +
    '  docs ' + want.length + ' 字符 / 库 ' + (mine[0]?.payload.length ?? '-') + ' 字符' +
    (okOne ? '' : '  ← 内容与 docs 不一致（线上答的不是这份文档）'));
}
const extra = rows.filter((r) => !docFiles.includes(String(r.source)));
if (extra.length) {
  bad++;
  console.log('≠ 库里有 docs 之外的来源（重建会静默丢）：' +
    JSON.stringify(extra.map((r) => ({ id: r.id, source: r.source, len: r.payload.length }))));
}

console.log('\n=== FTS 索引层残留（external-content，删除只删了 kb 行时会出现幽灵） ===');
// FTS5 是可选能力：老库/精简构建可能没有 kb_fts*，探针失败只能降级，不能拖垮整份体检。
let ftsDegraded = null;
try {
  const docsize = db.prepare('SELECT name FROM sqlite_master WHERE name=?').get('kb_fts_docsize');
  if (!docsize) throw new Error('没有 kb_fts_docsize 表（这份库没建 FTS5 索引）');
  const orphan = db.prepare('SELECT id FROM kb_fts_docsize WHERE id NOT IN (SELECT id FROM kb) ORDER BY id')
    .all().map((r) => r.id);
  console.log('kb_fts_docsize 幽灵 rowid：' + (orphan.length ? JSON.stringify(orphan) : '无'));
  for (const p of GHOST_PROBES) {
    const hits = db.prepare('SELECT rowid FROM kb_fts WHERE kb_fts MATCH ? LIMIT 8').all('"' + p + '"')
      .map((h) => h.rowid + (rows.some((r) => r.id === h.rowid) ? '' : '(ghost)'));
    console.log('  MATCH ' + p.padEnd(6) + ' -> ' + (hits.length ? hits.join(', ') : '无'));
  }
  console.log('判读：幽灵条目不会进答案（kb-ask 走 join kb 的内连接），但会污染 bm25 语料统计并随删除累积。');
  if (orphan.length) console.log('! 索引层有 ' + orphan.length + ' 个幽灵（见 FIXPLAN 工单 G-3：清理要停应用，别在跑着的时候改库）');
} catch (e) {
  ftsDegraded = e.message;
  console.log('! FTS 检查降级：' + e.message);
  console.log('  本项不计入失败，但"删除有没有留幽灵"这一条没验到，别当成已通过。');
}

console.log('\n' + (bad === 0
  ? (ftsDegraded ? '内容层：与 docs 一致 ✓（FTS 检查降级）' : '内容层：与 docs 一致 ✓')
  : '内容层：' + bad + ' 处不一致 ✗'));
if (nonMd.length) bad++;
db.close();
process.exit(bad === 0 ? 0 : 1);
