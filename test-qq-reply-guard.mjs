import assert from 'node:assert/strict';
import {
  DSH_IM_GUARD_MARK,
  DUPLICATED_QUESTION_ECHO,
  patchDshImQqDelivery,
  sanitizeQqReply,
  stripModelMetaPreamble,
} from './station/qq-reply-guard.mjs';

assert.equal(
  stripModelMetaPreamble("I'm being asked to copy the reply verbatim as instructed.@白开水 你问的「新生圆梦」："),
  '@白开水 你问的「新生圆梦」：',
);
assert.equal(
  stripModelMetaPreamble("I'm copying the reply verbatim as requested.\n@白开水 你问的「群备注怎么改」："),
  '@白开水 你问的「群备注怎么改」：',
);
assert.equal(
  stripModelMetaPreamble("I need to copy the reply verbatim as instructed, so I'll reproduce it exactly as provided.@白开水 你问的「新生圆梦」："),
  '@白开水 你问的「新生圆梦」：',
);
assert.equal(stripModelMetaPreamble('① 正常答案不应修改'), '① 正常答案不应修改');

assert.equal(
  sanitizeQqReply("I need to copy the reply verbatim as instructed, so I'll reproduce it exactly as provided.@白开水 你问的「新生圆梦\n新生圆梦」：\n① 答案"),
  '@白开水 你问的「新生圆梦」：\n① 答案',
);
assert.equal(
  sanitizeQqReply('@白开水 你问的「新生圆梦\n圆梦新生」：\n① 答案'),
  '@白开水 你问的「新生圆梦\n圆梦新生」：\n① 答案',
  '不相同的多行问题不得被改写',
);

const fixture = 'function delivery(){let H=[],j,F;let q=MRe(j,F),J=H.length>0?`${q}---${H.join("\\n")}`:q,x=null,P=null;try{send(J)}catch{}}';
const patched = patchDshImQqDelivery(fixture);
assert.equal(patched.changed, true);
assert.ok(patched.source.includes(DSH_IM_GUARD_MARK));
assert.ok(patched.source.includes('J=(H.length>0?`${q}---${H.join("\\n")}`:q).replace('));
assert.ok(patched.source.includes(`.replace(${DUPLICATED_QUESTION_ECHO},"$1$2$3")`));
assert.doesNotThrow(() => new Function(patched.source), '写入 bundle 的片段必须能被 Node 解析');
assert.equal(patchDshImQqDelivery(patched.source).changed, false, '重复执行不得二次改写');
assert.throws(
  () => patchDshImQqDelivery('let q=MRe(j,F),J=answer:q,x=null,P=null;try{ one let q=MRe(j,F),J=answer:q,x=null,P=null;try{'),
  /anchor changed/,
);

console.log('QQ final-delivery guard: PASS');
