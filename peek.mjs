// 打印 kb_ask 组装好的最终 reply，核对引用标号背后的内容是否真的对得上。
const TARGET = process.env.KB_ASK_TARGET === 'installed'
  ? '/Users/mac/Library/Application Support/dsh-desktop/harness/.agent-presets/kb-qa/kb-ask.mjs'
  : '/Users/mac/work-deepseek/kb/preset-kb-qa/kb-ask.mjs';
const { apply } = await import(`file://${TARGET}`);
let tool = null;
apply({ logger: { warn: () => {} }, tools: { register: (d) => { tool = d; } } }, {
  db: '/Users/mac/Library/Application Support/dsh-desktop/harness/knowledge-base/kb.sqlite',
});

const QS = process.argv.length > 2
  ? process.argv.slice(2)
    : ['你好', '谢谢', '你是谁'];

for (const q of QS) {
  const r = await tool.execute({ question: q, asker: '白开水' });
  console.log(`\n>>> ${q}`);
  console.log(r.startsWith('REFUSE') ? r : r.slice(r.indexOf('reply:') + 6));
}
