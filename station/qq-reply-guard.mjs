export const name = 'kb-qa-qq-reply-guard';

// 模型偶发把“转发工具回复”的内部说明也输出。只删这个明确的英文元说明，
// 不做宽泛的自然语言清洗，避免误改知识库的正常答案。
export const META_PREAMBLE = /^\s*i(?:'|’)m(?:(?: being asked)? to copy| copying) (?:the )?reply verbatim(?: as (?:requested|instructed))?\.?\s*/i;
export const DSH_IM_GUARD_MARK = '/* student-ask-han-qq-reply-guard */';

export function stripModelMetaPreamble(text) {
  return typeof text === 'string' ? text.replace(META_PREAMBLE, '') : text;
}

/**
 * dsh-im 3.1.1 将 QQ SDK 内联进自己的 bundle；外部 import 同名 SDK 再改 prototype
 * 不能触及它实际调用的类。这里按已核验的最终投递语句，给发送前的 J 加一个窄清洗。
 *
 * 只能命中一次才写入，升级后 bundle 结构变化会安全失败，而不是猜测性改写。
 */
export function patchDshImQqDelivery(source) {
  if (typeof source !== 'string') throw new TypeError('dsh-im bundle must be a string');
  if (source.includes(DSH_IM_GUARD_MARK)) return { source, changed: false };

  const head = 'let q=MRe(j,F),J=';
  const tail = ':q,x=null,P=null;try{';
  const count = (needle) => source.split(needle).length - 1;
  if (count(head) !== 1 || count(tail) !== 1) {
    throw new Error('dsh-im QQ final-delivery anchor changed; refusing to patch');
  }
  const headAt = source.indexOf(head);
  const tailAt = source.indexOf(tail, headAt + head.length);
  if (tailAt < 0) throw new Error('dsh-im QQ final-delivery anchor is out of order; refusing to patch');

  const before = source.slice(0, headAt + head.length);
  const expression = source.slice(headAt + head.length, tailAt);
  const after = source.slice(tailAt + tail.length);
  const patched = `${before}(${expression}:q).replace(${META_PREAMBLE},"")${DSH_IM_GUARD_MARK},x=null,P=null;try{${after}`;
  return { source: patched, changed: true };
}

// 已部署过的 Cordis 插件入口保留为无副作用兼容层，避免旧配置在重启时加载失败。
// 真正的补丁由 `kbctl im-reply-guard --apply` 写到 dsh-im 的实际 bundle，并会同步移除旧配置。
export async function apply(ctx) {
  const logger = typeof ctx?.logger === 'function' ? ctx.logger(name) : (ctx?.logger ?? console);
  logger?.warn?.('[kb-qa] legacy QQ reply guard is inert; run kbctl im-reply-guard --apply to patch dsh-im delivery');
  return () => undefined;
}
