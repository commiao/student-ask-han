// 把知识库导出成单文件分发件：VACUUM INTO 顺带把 WAL 折叠进去，
// 避免直接 cp 出一个缺了最新写入的半个库。用法：node kb/mkdist.mjs [目标路径]
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = process.env.KB_ASK_DB
  || '/Users/mac/Library/Application Support/dsh-desktop/harness/knowledge-base/kb.sqlite';
const DEST = resolve(process.argv[2] || fileURLToPath(new URL('./dist/kb.sqlite', import.meta.url)));

mkdirSync(dirname(DEST), { recursive: true });
rmSync(DEST, { force: true });          // VACUUM INTO 不覆盖已有文件，先清掉

const db = new DatabaseSync(SRC);
try {
  db.prepare('vacuum into ?').run(DEST);
} finally {
  db.close();
}

const check = new DatabaseSync(DEST, { readOnly: true });
const rows = check.prepare('select id, name from kb order by id').all();
const bytes = check.prepare('select coalesce(sum(length(payload)),0) as n from kb').get().n;
check.close();
console.log(`导出: ${DEST}  ${statSync(DEST).size} 字节  原文合计 ${bytes} 字符`);
console.log(`条目: ${rows.map((r) => `${r.id}=${String(r.name).split('·').pop().trim()}`).join(', ')}`);
