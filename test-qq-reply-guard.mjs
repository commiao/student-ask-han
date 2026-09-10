import assert from 'node:assert/strict';
import {
  DSH_IM_GUARD_MARK,
  DUPLICATED_QUESTION_ECHO,
  patchDshImQqDelivery,
  sanitizeQqReply,
  selectDshImBundle,
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

assert.equal(
  selectDshImBundle({ explicitFile: null, activeFile: '/data/dsh/active.js', seedFile: '/opt/seed.js', exists: (file) => file.startsWith('/data/') }),
  '/data/dsh/active.js',
  '必须优先补丁 DSH 实际加载的持久化 profile bundle',
);
assert.equal(
  selectDshImBundle({ explicitFile: null, activeFile: '/data/dsh/missing.js', seedFile: '/opt/seed.js', exists: () => false }),
  '/opt/seed.js',
  '仅在持久化 bundle 不存在时回退到镜像种子',
);
assert.equal(
  selectDshImBundle({ explicitFile: '/custom/index.js', activeFile: '/data/dsh/active.js', seedFile: '/opt/seed.js', exists: () => true }),
  '/custom/index.js',
  '显式路径必须拥有最高优先级',
);

const fixture = 'function delivery(){let H=[],j,F;let q=MRe(j,F),J=H.length>0?`${q}---${H.join("\\n")}`:q,x=null,P=null;try{send(J)}catch{}}';
const patched = patchDshImQqDelivery(fixture);
assert.equal(patched.changed, true);
assert.ok(patched.source.includes(DSH_IM_GUARD_MARK));
assert.ok(patched.source.includes('J=(H.length>0?`${q}---${H.join("\\n")}`:q).replace('));
assert.ok(patched.source.includes(`.replace(${DUPLICATED_QUESTION_ECHO},"$1$2$3")`));
assert.doesNotThrow(() => new Function(patched.source), '写入 bundle 的片段必须能被 Node 解析');
assert.equal(patchDshImQqDelivery(patched.source).changed, false, '重复执行不得二次改写');

// dsh-im 4.7.0 将最终答案保存在 V，随后交给 CZ 做 QQ 分片投递。
// 这是 NAS 当前实际加载的持久化 profile bundle 的最小结构。
const fixtureV47 = 'async function delivery(){let q=[],z,H=[];let G=sFe(z,H),V=q.length>0?`${G}---${q.join("\\n")}`:G,U=null,N=null;try{let ie=await CZ(bot,target,V,{logger})}catch{}}';
const patchedV47 = patchDshImQqDelivery(fixtureV47);
assert.equal(patchedV47.changed, true);
assert.ok(patchedV47.source.includes(DSH_IM_GUARD_MARK));
assert.ok(patchedV47.source.includes('V=(q.length>0?`${G}---${q.join("\\n")}`:G).replace('));
assert.doesNotThrow(() => new Function(patchedV47.source), '写入 4.7.0 bundle 的片段必须能被 Node 解析');
assert.equal(patchDshImQqDelivery(patchedV47.source).changed, false, '4.7.0 重复执行不得二次改写');

const legacyGuardMark = '/* student-ask-han-qq-reply-guard */';
const legacyPreamble = /^\s*i(?:'|’)m(?:(?: being asked)? to copy| copying) (?:the )?reply verbatim(?: as (?:requested|instructed))?\.?\s*/i;
const legacyFixture = 'function delivery(){let H=[],j,F;let q=MRe(j,F),J=(H.length>0?`${q}---${H.join("\\n")}`:q).replace('
  + `${legacyPreamble},"")${legacyGuardMark},x=null,P=null;try{send(J)}catch{}}`;
const upgraded = patchDshImQqDelivery(legacyFixture);
assert.equal(upgraded.changed, true, '已部署的 v1 guard 必须能升级到当前规则');
assert.ok(upgraded.source.includes(DSH_IM_GUARD_MARK));
assert.ok(!upgraded.source.includes(legacyGuardMark));
assert.doesNotThrow(() => new Function(upgraded.source), '升级已部署 bundle 后仍须可解析');

assert.throws(
  () => patchDshImQqDelivery('let q=MRe(j,F),J=answer:q,x=null,P=null;try{ one let q=MRe(j,F),J=answer:q,x=null,P=null;try{'),
  /anchor changed/,
);

console.log('QQ final-delivery guard: PASS');
