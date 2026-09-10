export const name = 'kb-qa-qq-reply-guard';

// 模型偶发把“转发工具回复”的内部说明也输出。保留已观测句式用于兼容
// 无标题回复；带 kb-qa 固定标题的回复另由结构规则清理，避免依赖模型措辞。
export const META_PREAMBLE = /^\s*(?:i(?:'|’)m(?:(?: being asked)? to copy| copying) (?:the )?reply verbatim(?: as (?:requested|instructed))?|i need to copy (?:the )?reply verbatim(?: as (?:requested|instructed))?(?:,\s*so i(?:'|’)ll reproduce it exactly as provided)?)\.?\s*/i;
// 不再枚举每个模型的英文措辞：当短英文段落后紧跟 kb-qa 固定标题时，
// 该段只能是模型泄露的操作说明。中文前缀不匹配，且最多清理 400 字符。
export const ENGLISH_META_BEFORE_KB_HEADER = /^\s*[A-Za-z][^\u3400-\u9fff]{0,399}(?=@[^\r\n]{1,64} 你问的「)/u;
// 某些模型会在照抄工具 reply 时，把标题里的原问题连续复制两次。只归一化
// 完全相同、紧邻、且位于固定 QQ 标题结构中的两行，正常多行问题保持原样。
export const DUPLICATED_QUESTION_ECHO = /^(@[^\r\n]{1,64} 你问的「)([^\r\n]+)\r?\n\2(」：)/;
const LEGACY_META_PREAMBLE = /^\s*i(?:'|’)m(?:(?: being asked)? to copy| copying) (?:the )?reply verbatim(?: as (?:requested|instructed))?\.?\s*/i;
const LEGACY_DSH_IM_GUARD_MARK = '/* student-ask-han-qq-reply-guard */';
const V2_DSH_IM_GUARD_MARK = '/* student-ask-han-qq-reply-guard:v2 */';
export const DSH_IM_GUARD_MARK = '/* student-ask-han-qq-reply-guard:v3 */';

export function stripModelMetaPreamble(text) {
  return typeof text === 'string' ? text.replace(META_PREAMBLE, '') : text;
}

export function sanitizeQqReply(text) {
  return typeof text === 'string'
    ? stripModelMetaPreamble(text)
      .replace(ENGLISH_META_BEFORE_KB_HEADER, '')
      .replace(DUPLICATED_QUESTION_ECHO, '$1$2$3')
    : text;
}

export function selectDshImBundle({ explicitFile, activeFile, seedFile, exists }) {
  if (explicitFile) return explicitFile;
  return exists(activeFile) ? activeFile : seedFile;
}

/**
 * dsh-im 将 QQ SDK 内联进自己的 bundle；外部 import 同名 SDK 再改 prototype
 * 不能触及它实际调用的类。这里按已核验的最终投递语句，在发送前做窄清洗。
 *
 * 只能命中一个已知版本的一处锚点才写入，升级后 bundle 结构变化会安全失败，
 * 而不是猜测性改写。
 */
export function patchDshImQqDelivery(source) {
  if (typeof source !== 'string') throw new TypeError('dsh-im bundle must be a string');
  if (source.includes(DSH_IM_GUARD_MARK)) return { source, changed: false };

  const count = (needle) => source.split(needle).length - 1;
  const cleanup = `.replace(${META_PREAMBLE},"").replace(${ENGLISH_META_BEFORE_KB_HEADER},"").replace(${DUPLICATED_QUESTION_ECHO},"$1$2$3")${DSH_IM_GUARD_MARK}`;
  const guard = (expression) => `${expression}${cleanup}`;

  // v2 只枚举了当时见过的三种固定句式。精确替换本项目生成的清洗尾缀，
  // 使已经部署的 3.1.1 / 4.7.0 bundle 都能原位升级，不触碰第三方逻辑。
  const v2Cleanup = `.replace(${META_PREAMBLE},"").replace(${DUPLICATED_QUESTION_ECHO},"$1$2$3")${V2_DSH_IM_GUARD_MARK}`;
  if (source.includes(V2_DSH_IM_GUARD_MARK)) {
    if (count(v2Cleanup) !== 1) {
      throw new Error('dsh-im QQ v2 guard shape changed; refusing to upgrade');
    }
    return { source: source.replace(v2Cleanup, cleanup), changed: true };
  }

  // v1 的标记会让旧逻辑提前返回，导致已部署的 bundle 永远收不到后续规则。
  // 仅接受 v1 自己生成的精确片段；不匹配就安全失败，绝不猜测性改写第三方 bundle。
  const legacyCleanup = `.replace(${LEGACY_META_PREAMBLE},"")${LEGACY_DSH_IM_GUARD_MARK}`;
  if (source.includes(LEGACY_DSH_IM_GUARD_MARK)) {
    const head = 'let q=MRe(j,F),J=';
    if (count(head) !== 1 || count(legacyCleanup) !== 1) {
      throw new Error('dsh-im QQ legacy guard shape changed; refusing to upgrade');
    }
    const headAt = source.indexOf(head);
    const cleanupAt = source.indexOf(legacyCleanup, headAt + head.length);
    const afterAt = cleanupAt + legacyCleanup.length;
    if (cleanupAt < 0 || !source.startsWith(',x=null,P=null;try{', afterAt)) {
      throw new Error('dsh-im QQ legacy guard is out of order; refusing to upgrade');
    }
    const before = source.slice(0, headAt + head.length);
    const expression = source.slice(headAt + head.length, cleanupAt);
    return { source: `${before}${guard(expression)}${source.slice(afterAt)}`, changed: true };
  }

  const anchors = [
    // dsh-im 4.7.0：V 是文本与工具告警合并后的最终 QQ 文本，随后交给 CZ 分片发送。
    { head: 'let G=sFe(z,H),V=', tail: ',U=null,N=null;try{', outputTail: ',U=null,N=null;try{', completeExpression: true },
    // dsh-im 3.1.1：tail 从三元表达式的 else 分支开始。
    { head: 'let q=MRe(j,F),J=', tail: ':q,x=null,P=null;try{', outputTail: ',x=null,P=null;try{', completeExpression: false },
  ];
  const matches = anchors.filter(({ head, tail }) => count(head) === 1 && count(tail) === 1);
  if (matches.length !== 1) {
    throw new Error('dsh-im QQ final-delivery anchor changed; refusing to patch');
  }
  const { head, tail, outputTail, completeExpression } = matches[0];
  const headAt = source.indexOf(head);
  const tailAt = source.indexOf(tail, headAt + head.length);
  if (tailAt < 0) throw new Error('dsh-im QQ final-delivery anchor is out of order; refusing to patch');

  const before = source.slice(0, headAt + head.length);
  const expression = source.slice(headAt + head.length, tailAt);
  const after = source.slice(tailAt + tail.length);
  const guardedExpression = completeExpression ? `(${expression})` : `(${expression}:q)`;
  const patched = `${before}${guard(guardedExpression)}${outputTail}${after}`;
  return { source: patched, changed: true };
}

// 已部署过的 Cordis 插件入口保留为无副作用兼容层，避免旧配置在重启时加载失败。
// 真正的补丁由 `kbctl im-reply-guard --apply` 写到 dsh-im 的实际 bundle，并会同步移除旧配置。
export async function apply(ctx) {
  const logger = typeof ctx?.logger === 'function' ? ctx.logger(name) : (ctx?.logger ?? console);
  logger?.warn?.('[kb-qa] legacy QQ reply guard is inert; run kbctl im-reply-guard --apply to patch dsh-im delivery');
  return () => undefined;
}
