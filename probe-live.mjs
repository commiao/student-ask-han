// 看 kb_ask 对真实群问题的返回值：给了哪几条依据、Q3 在不在里面。
const TARGET = process.env.KB_ASK_TARGET === 'workspace'
  ? '/Users/mac/work-deepseek/kb/preset-kb-qa/kb-ask.mjs'
  : '/Users/mac/Library/Application Support/dsh-desktop/harness/.agent-presets/kb-qa/kb-ask.mjs';
console.log(`目标: ${TARGET}`);
const { apply } = await import(`file://${TARGET}`);
let tool = null;
apply({ logger: { warn: () => {} }, tools: { register: (d) => { tool = d; } } }, {
  db: '/Users/mac/Library/Application Support/dsh-desktop/harness/knowledge-base/kb.sqlite',
  refusal: '该问题超出范围了，请联系管理员',
  excerptMax: 1800,
});

for (const q of ['开学需要准备什么', '新生报到要带什么材料']) {
  const text = await tool.execute({ question: q });
  const ids = [...text.matchAll(/id=(\d+)/g)].map((m) => m[1]);
  console.log(`\n### ${q}\nverdict=${text.split('\n')[0]}  ids=${JSON.stringify(ids)}  terms=${text.match(/terms: (.*)/)?.[1]}`);
  console.log(`证据总字符数=${text.length}`);
  for (const probe of ['Q3. 需要带哪些材料', '录取通知书', '掌上迎新', 'Q24. 宿舍需要自带被褥', '复印件']) {
    console.log(`  ${text.includes(probe) ? '在' : '缺'}  ${probe}`);
  }
}
