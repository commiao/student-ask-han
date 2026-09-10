import assert from 'node:assert/strict';
import { installQqReplyGuard, stripModelMetaPreamble } from './station/qq-reply-guard.mjs';

class FakeQqBot {
  constructor(accountId) { this.accountId = accountId; }
  async send(payload) { this.sent = payload; return payload; }
}

const state = JSON.stringify({ agentPresets: { 'kb-bot': 'kb-qa', 'other-bot': 'default' } });
const remove = installQqReplyGuard(FakeQqBot, {
  workspaceFile: '/state/workspaces.json',
  readFile: (file) => {
    assert.equal(file, '/state/workspaces.json');
    return state;
  },
  logger: { info() {} },
});

assert.equal(
  stripModelMetaPreamble("I'm being asked to copy the reply verbatim as instructed.@白开水："),
  '@白开水：',
);
const kbBot = new FakeQqBot('kb-bot');
await kbBot.send({
  msgType: 2,
  markdown: { content: "I'm being asked to copy the reply verbatim as instructed.@白开水：\n① 答案" },
});
assert.equal(kbBot.sent.markdown.content, '@白开水：\n① 答案');

const fallback = new FakeQqBot('kb-bot');
await fallback.send({
  msgType: 0,
  content: "I'm copying the reply verbatim as requested.\n@白开水：\n① 答案",
});
assert.equal(fallback.sent.content, '@白开水：\n① 答案');

const other = new FakeQqBot('other-bot');
await other.send({
  msgType: 2,
  markdown: { content: "I'm being asked to copy the reply verbatim as instructed.@其他人：" },
});
assert.match(other.sent.markdown.content, /^I'm being asked/);

remove();
console.log('QQ reply guard checks passed');
