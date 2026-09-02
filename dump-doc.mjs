// 交接工单用：打印每个条目的完整原文（标题+答案），别名展开词逐字对这里抄。
import { defaultDb } from '/Users/mac/work-deepseek/kb/test-paths.mjs';
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(defaultDb(), { readOnly: true });
const rows = db.prepare('select name, payload from kb').all();
db.close();
for (const r of rows) {
  console.log(`\n===== 章节 ${String(r.name).split('·').pop().trim()} =====`);
  for (const line of String(r.payload).split('\n')) {
    const t = line.trim();
    if (/^#{2,}\s*Q\d/.test(t)) console.log('\n' + t);
    else if (/^A[：:]/.test(t)) console.log('   ' + t.slice(0, 150));
  }
}
