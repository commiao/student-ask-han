import assert from 'node:assert/strict';
import {
  DSH_IM_GUARD_MARK,
  DUPLICATED_QUESTION_ECHO,
  ENGLISH_META_BEFORE_KB_HEADER,
  META_PREAMBLE,
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
assert.equal(
  sanitizeQqReply("I should follow the instruction to output the reply content exactly as it appears in the tool output.\n@白开水 你问的「什么时候放暑假」：\n该问题超出范围了，请联系管理员"),
  '@白开水 你问的「什么时候放暑假」：\n该问题超出范围了，请联系管理员',
  '模型更换后出现的新英文元说明也必须在发送前删除',
);
assert.equal(
  sanitizeQqReply('The requested answer follows below.\n@白开水 你问的「新生圆梦」：\n① 答案'),
  '@白开水 你问的「新生圆梦」：\n① 答案',
  '不能依赖枚举每一种模型英文措辞',
);
assert.equal(
  sanitizeQqReply(', meaning I should reproduce it exactly as provided without any modifications.@白开水 你问的「党关系」：\n① 答案'),
  '@白开水 你问的「党关系」：\n① 答案',
  '英文元说明即使以标点开头也必须删除',
);
assert.equal(stripModelMetaPreamble('① 正常答案不应修改'), '① 正常答案不应修改');
assert.equal(
  sanitizeQqReply('@Alice 你问的「党关系」：\n① 答案'),
  '@Alice 你问的「党关系」：\n① 答案',
  'ASCII 昵称开头的正常固定标题不得被删除',
);
assert.equal(
  sanitizeQqReply('说明：@白开水 你问的「党关系」：\n① 答案'),
  '说明：@白开水 你问的「党关系」：\n① 答案',
  '包含中文的业务前缀不得被当作模型元说明删除',
);

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

const v3EnglishMetaBeforeKbHeader = /^\s*[A-Za-z][^\u3400-\u9fff]{0,399}(?=@[^\r\n]{1,64} 你问的「)/u;
const v3GuardMark = '/* student-ask-han-qq-reply-guard:v3 */';
const v3FixtureV47 = 'async function delivery(){let q=[],z,H=[];let G=sFe(z,H),V=(q.length>0?`${G}---${q.join("\\n")}`:G).replace('
  + `${META_PREAMBLE},"").replace(${v3EnglishMetaBeforeKbHeader},"").replace(${DUPLICATED_QUESTION_ECHO},"$1$2$3")${v3GuardMark},U=null,N=null;try{let ie=await CZ(bot,target,V,{logger})}catch{}}`;
const upgradedV3 = patchDshImQqDelivery(v3FixtureV47);
assert.equal(upgradedV3.changed, true, '已部署的 v3 guard 必须升级以清理标点开头的元说明');
assert.ok(upgradedV3.source.includes(DSH_IM_GUARD_MARK));
assert.ok(upgradedV3.source.includes(`.replace(${ENGLISH_META_BEFORE_KB_HEADER},"")`));
assert.ok(!upgradedV3.source.includes(v3GuardMark));
assert.doesNotThrow(() => new Function(upgradedV3.source), '升级 v3 bundle 后仍须可解析');

const v2GuardMark = '/* student-ask-han-qq-reply-guard:v2 */';
const v2FixtureV47 = 'async function delivery(){let q=[],z,H=[];let G=sFe(z,H),V=(q.length>0?`${G}---${q.join("\\n")}`:G).replace('
  + `${META_PREAMBLE},"").replace(${DUPLICATED_QUESTION_ECHO},"$1$2$3")${v2GuardMark},U=null,N=null;try{let ie=await CZ(bot,target,V,{logger})}catch{}}`;
const upgradedV2 = patchDshImQqDelivery(v2FixtureV47);
assert.equal(upgradedV2.changed, true, '已部署的 v2 guard 必须升级到结构化英文前缀清理');
assert.ok(upgradedV2.source.includes(DSH_IM_GUARD_MARK));
assert.ok(upgradedV2.source.includes(`.replace(${ENGLISH_META_BEFORE_KB_HEADER},"")`));
assert.ok(!upgradedV2.source.includes(v2GuardMark));
assert.doesNotThrow(() => new Function(upgradedV2.source), '升级 v2 bundle 后仍须可解析');

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
