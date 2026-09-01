// 导出某分类条目里所有 Q 条目的标题，用来核对"文档到底答不答这个问题"。
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/Users/mac/Library/Application Support/dsh-desktop/harness/knowledge-base/kb.sqlite', { readOnly: true });
const rows = db.prepare('select id, name, payload from kb order by id').all();
for (const r of rows) {
  const text = String(r.payload ?? '').replace(/\r/g, '');
  const marks = [];
  const re = /^[ \t#>*-]{0,6}Q[ \t]*(\d+)[ \t]*[.、．]?/gim;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) marks.push({ n: Number(m[1]), at: m.index });
  console.log(`\n===== id=${r.id} ${String(r.name).split('·').pop().trim()}  条目${marks.length}个`);
  marks.forEach((mk, i) => {
    const body = text.slice(mk.at, i + 1 < marks.length ? marks[i + 1].at : text.length).replace(/\s+/g, ' ');
    console.log(`  Q${mk.n}: ${body.slice(0, 100)}`);
  });
  if (marks.length === 0) console.log(`  (无Q号) ${text.slice(0, 120)}`);
}
