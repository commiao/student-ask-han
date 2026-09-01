// 精确修复被上一轮 edit 改坏的招呼分支：补回 greet 赋值与 if 包裹。
import { readFileSync, writeFileSync } from 'node:fs';

const p = '/Users/mac/work-deepseek/kb/preset-kb-qa/kb-ask.mjs';
let s = readFileSync(p, 'utf8');

const broken = [
  "      const ghead = asker === '' ? '' : `@${asker} `;",
  "      return ['ANSWER', `via: greeting:${greet}`, `reply:\\n${ghead}${greetingReply(greet)}`].join('\\n');",
  '      }',
].join('\n');

const fixed = [
  '      const greet = greetingOf(question);',
  '      if (greet !== null) {',
  "        const ghead = asker === '' ? '' : `@${asker} `;",
  "        return ['ANSWER', `via: greeting:${greet}`, `reply:\\n${ghead}${greetingReply(greet)}`].join('\\n');",
  '      }',
].join('\n');

if (!s.includes(broken)) { console.log('NOT FOUND：断言的破损片段不在文件里，未做任何修改'); process.exit(1); }
s = s.replace(broken, fixed);
writeFileSync(p, s);
console.log('fixed');
