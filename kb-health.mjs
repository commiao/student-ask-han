// 只读体检：库内容与 docs 是否一致、删除有没有在 FTS 索引层留幽灵。
// 用法：node kb-health.mjs            （查线上库）
//       KB_HEALTH_DB=<path> node kb-health.mjs   （查指定库，如 dist/kb.sqlite）
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const DB = process.env.KB_HEALTH_DB
  || '/Users/mac/Library/Application Support/dsh-desktop/harness/knowledge-base/kb.sqlite';
const DOCS = join(new URL('.', import.meta.url).pathname, 'out');
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
// 只在 FTS 里探针：这些词只出现在"曾经导入又被删掉"的内容里，命中即为幽灵。
const GHOST_PROBES = ['家庭贫困', '精华消息', '明令禁止'];

const db = new DatabaseSync(DB, { readOnly: true });
const rows = db.prepare('SELECT id, category, name, source, payload FROM kb ORDER BY id').all();
console.log('库：' + DB);
console.log('条目 ' + rows.length + ' 条 / ' +
  rows.reduce((a, r) => a + r.payload.length, 0) + ' 字符 / ' +
  rows.reduce((a, r) => a + (r.payload.match(/^##\s*Q/gm) || []).length, 0) + ' 个 Q 段');
console.log('分类：' + JSON.stringify(db.prepare('SELECT category, COUNT(*) n FROM kb GROUP BY category').all()));
console.log('非 md 来源：' + JSON.stringify(rows.filter((r) => !/\.md$/.test(String(r.source)))
  .map((r) => ({ id: r.id, source: r.source }))));

console.log('\n=== 内容对账（库 payload vs out/*.md） ===');
let bad = 0;
for (const f of readdirSync(DOCS).filter((n) => n.endsWith('.md')).sort()) {
  const want = readFileSync(join(DOCS, f), 'utf8').replace(/\r\n/g, '\n').trim();
  const mine = rows.filter((r) => String(r.source) === f);
  const okOne = mine.length === 1 && sha(mine[0].payload) === sha(want);
  if (!okOne) bad++;
  console.log((okOne ? '= ' : '≠ ') + f.padEnd(18) + ' 库条目 ' + mine.length +
    '  docs ' + want.length + ' 字符 / 库 ' + (mine[0]?.payload.length ?? '-') + ' 字符');
}
const extra = rows.filter((r) => !readdirSync(DOCS).includes(String(r.source)));
if (extra.length) { bad++; console.log('≠ 库里有 docs 之外的来源（重建会静默丢）：' +
  JSON.stringify(extra.map((r) => ({ id: r.id, source: r.source, len: r.payload.length })))); }

console.log('\n=== FTS 索引层残留（external-content，删除只删了 kb 行时会出现幽灵） ===');
const orphan = db.prepare('SELECT id FROM kb_fts_docsize WHERE id NOT IN (SELECT id FROM kb) ORDER BY id')
  .all().map((r) => r.id);
console.log('kb_fts_docsize 幽灵 rowid：' + (orphan.length ? JSON.stringify(orphan) : '无'));
for (const p of GHOST_PROBES) {
  const hits = db.prepare('SELECT rowid FROM kb_fts WHERE kb_fts MATCH ? LIMIT 8').all('"' + p + '"')
    .map((h) => h.rowid + (rows.some((r) => r.id === h.rowid) ? '' : '(ghost)'));
  console.log('  MATCH ' + p.padEnd(6) + ' -> ' + (hits.length ? hits.join(', ') : '无'));
}
console.log('\n判读：幽灵条目不会进答案（kb-ask 走 join kb 的内连接），但会污染 bm25 语料统计并随删除累积。');
console.log(bad === 0 ? '内容层：与 docs 一致 ✓' : '内容层：' + bad + ' 处不一致 ✗');
db.close();
