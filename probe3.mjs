// 对照探针：同三条硬负例，分别打在"已提交的旧引擎"与"当前工作区引擎"上，
// 用来判定误放是本轮别名放宽引入的回归，还是既有缺陷。只读，不改任何判定代码。
// 用法：node probe3.mjs <kb-ask.mjs 路径> [更多路径...]
// 相对路径要先转绝对，否则 `file://` + 相对路径会变成 file://.head-ask.mjs/ 直接抛错。
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const REFUSAL = '该问题超出范围了，请联系管理员';
const DB = process.env.KB_ASK_DB
  || '/Users/mac/Library/Application Support/dsh-desktop/harness/knowledge-base/kb.sqlite';
const QS = ['宿舍晚上可以做饭吗', '报到当天家长能住哪', '校园网怎么计费',
  '宿舍有衣贵吗', '食堂阿姨态度好吗', '学校有健身房吗', '能转专业吗'];

for (const p of process.argv.slice(2)) {
  const { apply } = await import(pathToFileURL(resolve(p)).href);
  let tool = null;
  apply({ logger: { warn: () => {} }, tools: { register: (d) => { tool = d; } } }, { db: DB, refusal: REFUSAL });
  console.log(`\n### ${p}`);
  for (const q of QS) {
    const t = String(await tool.execute({ question: q }));
    const v = t.split('\n')[0].trim();
    const via = (t.match(/\nvia: (\S+)/) || [])[1] || '';
    const refs = [...new Set([...t.matchAll(/Q(\d+)/g)].map((m) => 'Q' + m[1]))].join(',');
    console.log(`  ${v.padEnd(7)} ${(via || '-').padEnd(12)} ${refs.padEnd(14)} ${q}`);
  }
}
