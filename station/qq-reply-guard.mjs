import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'kb-qa-qq-reply-guard';

// 模型偶发把“转发工具回复”的内部说明也输出。只删这个明确的英文元说明，
// 不做宽泛的自然语言清洗，避免误改知识库的正常答案。
const META_PREAMBLE = /^\s*i(?:'|’)m(?:(?: being asked)? to copy| copying) (?:the )?reply verbatim(?: as (?:requested|instructed))?\.?\s*/i;
const PATCH_MARK = Symbol.for('student-ask-han.kb-qa-qq-reply-guard');

export function stripModelMetaPreamble(text) {
  return typeof text === 'string' ? text.replace(META_PREAMBLE, '') : text;
}

function botUsesPreset(bot, agentPreset, workspaceFile, readFile) {
  const botId = typeof bot?.accountId === 'string' ? bot.accountId.trim() : '';
  if (!botId) return false;
  try {
    const state = JSON.parse(readFile(workspaceFile, 'utf8'));
    return state?.agentPresets?.[botId] === agentPreset;
  } catch {
    // 读取运行期状态失败时宁可不处理，绝不把清洗扩大到其他机器人。
    return false;
  }
}

function sanitizedPayload(payload) {
  if (payload === null || typeof payload !== 'object') return payload;
  if (payload.msgType === 2 && typeof payload.markdown?.content === 'string') {
    const content = stripModelMetaPreamble(payload.markdown.content);
    return content === payload.markdown.content
      ? payload
      : { ...payload, markdown: { ...payload.markdown, content } };
  }
  if (payload.msgType === 0 && typeof payload.content === 'string') {
    const content = stripModelMetaPreamble(payload.content);
    return content === payload.content ? payload : { ...payload, content };
  }
  return payload;
}

/**
 * 给 QQ SDK 的最终发送方法加一个窄门。dsh-im 在模型响应落地为 QQ Markdown/纯文本前
 * 必经该方法，因此这里是比 persona 更可靠的输出侧边界。
 */
export function installQqReplyGuard(QQBot, {
  agentPreset = 'kb-qa',
  workspaceFile,
  readFile = readFileSync,
  logger = console,
} = {}) {
  if (typeof QQBot?.prototype?.send !== 'function') {
    throw new TypeError('QQBot.prototype.send is unavailable');
  }
  if (QQBot.prototype.send[PATCH_MARK]) return () => undefined;

  const originalSend = QQBot.prototype.send;
  async function guardedSend(payload, ...rest) {
    const next = botUsesPreset(this, agentPreset, workspaceFile, readFile)
      ? sanitizedPayload(payload)
      : payload;
    if (next !== payload) logger?.info?.('[kb-qa] removed model meta preamble from QQ reply');
    return originalSend.call(this, next, ...rest);
  }
  Object.defineProperty(guardedSend, PATCH_MARK, { value: true });
  QQBot.prototype.send = guardedSend;

  return () => {
    if (QQBot.prototype.send === guardedSend) QQBot.prototype.send = originalSend;
  };
}

/** DSH Cordis 宿主插件入口。SDK 绝对路径来自已核验的 dsh-im 3.1.1 运行时布局。 */
export async function apply(ctx, config = {}) {
  const dshHome = config.dshHome ?? process.env.DSH_HOME ?? '/data/dsh';
  const workspaceFile = config.workspaceFile
    ?? join(dshHome, 'integrations', 'dsh-qq', 'workspaces.json');
  const sdkModule = config.sdkModule
    ?? 'file:///opt/dsh-seed/profiles/web/node_modules/@tencent-connect/qqbot-nodejs/dist/index.js';
  const { QQBot } = await import(sdkModule);
  const logger = typeof ctx?.logger === 'function' ? ctx.logger(name) : (ctx?.logger ?? console);
  const dispose = installQqReplyGuard(QQBot, {
    agentPreset: config.agentPreset ?? 'kb-qa',
    workspaceFile,
    logger,
  });
  logger?.info?.('[kb-qa] QQ reply guard active for kb-qa');
  return dispose;
}
