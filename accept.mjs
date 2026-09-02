// 验收单：一条命令跑完"能不能交付"的全部硬判据，每项给判据行 + 退出码。
// 用法：node accept.mjs [--port <宿主端口>] [--skip-live]
// 全程只读：不 build --apply、不 import、不清 FTS、不写 .agent-presets。
// 退出码：0 硬项全过；1 有硬项红（红项自己会说是"我们没修好"还是"没装上"）。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { targetPlugin, defaultDb } from './test-paths.mjs';

const ROOT = new URL('.', import.meta.url).pathname;
process.chdir(ROOT);
const SKIP_LIVE = process.argv.includes('--skip-live');
const argPort = (() => { const i = process.argv.indexOf('--port'); return i > 0 ? process.argv[i + 1] : null; })();

const rows = [];
const add = (id, name, pass, evidence, hard = true) => {
  rows.push({ id, name, pass, evidence, hard });
  console.log(`${pass ? 'PASS' : hard ? 'FAIL' : 'NOTE'}  ${id.padEnd(3)} ${name}\n        ${evidence}`);
};
const run = (file, args = [], env = {}) => {
  let out = '', code = 0;
  try { out = execFileSync(process.execPath, [file, ...args], { encoding: 'utf8', env: { ...process.env, ...env } }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); code = e.status ?? -1; }
  return { out, code };
};
const pick = (out, re) => (out.split('\n').map((l) => l.trim()).find((l) => re.test(l)) || '(没抓到判据行)').slice(0, 160);
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12);

// —— A 静态：所有被门禁链依赖的脚本必须能解析 ——
const SRC = ['preset-kb-qa/kb-ask.mjs', 'test-kb-ask.mjs', 'recall.mjs', 'scores.mjs', 'validate.mjs',
  'kb-health.mjs', 'intake-check.mjs', 'probe-scores.mjs', 'probe-spoken.mjs', 'alias-audit.mjs',
  'gen-cases.mjs', 'test-paths.mjs', 'accept.mjs', 'station/kbctl.mjs'];
const bad = SRC.filter((f) => { try { execFileSync(process.execPath, ['--check', f], { encoding: 'utf8' }); return false; } catch { return true; } });
add('A1', `语法 node --check ${SRC.length} 个文件`, bad.length === 0, bad.length ? '失败：' + bad.join(' ') : '全部通过');

// —— B 判定行为：workspace = 仓库这份，installed = 线上真正加载的那份 ——
// 两栏都必须跑：只看 workspace 会把"改了没装上"当成"改了有效"。
let r = run('test-kb-ask.mjs', [], { KB_ASK_TARGET: 'workspace' });
add('B1', '端到端用例 · workspace', r.code === 0, pick(r.out, /符合预期/) + `　exit=${r.code}`);
r = run('test-kb-ask.mjs');
add('B2', '端到端用例 · installed', r.code === 0, pick(r.out, /符合预期/) + `　exit=${r.code}`
  + (r.code ? '　' + pick(r.out, /top1 应为|失败明细/) : ''));
r = run('recall.mjs', [], { KB_ASK_TARGET: 'workspace' });
add('B3', '正例召回 · workspace', r.code === 0 && /miss: 0/.test(r.out), pick(r.out, /条目数/) + `　exit=${r.code}`);
add('B4', '硬负例 + 固定话术 · workspace', /误放 0　固定话术变形 0/.test(r.out), pick(r.out, /硬负例/));
add('B5', '别名对账 · workspace', /致命 0/.test(r.out), pick(r.out, /^别名/));
r = run('recall.mjs');
add('B6', '正例召回 · installed', r.code === 0 && /miss: 0/.test(r.out), pick(r.out, /条目数/) + `　exit=${r.code}`);
add('B7', '硬负例 + 固定话术 · installed', /误放 0　固定话术变形 0/.test(r.out), pick(r.out, /硬负例/));
r = run('scores.mjs', [], { KB_ASK_TARGET: 'workspace' });
add('B8', '分数地板（误放/错项）· workspace', /误放条数：0 \//.test(r.out) && /错项条数：0 \//.test(r.out),
  pick(r.out, /误放条数/) + '　' + pick(r.out, /错项条数/) + '　' + pick(r.out, /地板区间/));
r = run('scores.mjs');
add('B9', '分数地板 · installed', /误放条数：0 \//.test(r.out), pick(r.out, /误放条数/) + '　' + pick(r.out, /错项条数/));
r = run('probe-spoken.mjs', [], { KB_ASK_TARGET: 'workspace' });
add('B10', '口语覆盖率（度量计，不判失败）', true, pick(r.out, /通过率/), false);

// —— C 装配：三件套 + 仓库那份与线上那份是否同一字节 ——
r = run('validate.mjs', ['workspace']);
add('C1', '三件套自检 · workspace', r.code === 0, pick(r.out, /三件套/) + `　exit=${r.code}`);
r = run('validate.mjs', ['installed']);
add('C2', '三件套自检 · installed', r.code === 0, pick(r.out, /三件套/) + `　exit=${r.code}`);
let wsSha = '?', inSha = '?';
try { wsSha = sha(join(ROOT, 'preset-kb-qa', 'kb-ask.mjs')); } catch (e) { wsSha = '读不到'; }
try { inSha = sha(targetPlugin('installed')); } catch (e) { inSha = '读不到：' + (e.code || e.message).slice(0, 30); }
add('C3', '线上加载的就是仓库这份引擎', wsSha === inSha, `workspace ${wsSha} vs installed ${inSha}`
  + (wsSha === inSha ? '' : '　→ 代码修好但**没生效**，需 `cd station && node kbctl.mjs install` 后 Cmd+Q 重启'));

// —— D 数据：库内容 = docs 真源，新底稿过机检 ——
r = run('kb-health.mjs');
add('D1', '库 payload ↔ out/*.md 逐文件 sha 全等', r.code === 0, pick(r.out, /内容层/) + `　exit=${r.code}`);
add('D2', '库字符量与条目数（对账基准）', true, pick(r.out, /^条目 /) + '　' + pick(r.out, /kb_fts_docsize 幽灵/), false);
r = run('intake-check.mjs');
add('D3', '入库前机检（预算 / Q 编号 / 契约 / 零宽 / 时效 / 联系方式）', r.code === 0,
  pick(r.out, /入库后合计/) + '　' + pick(r.out, /合计 \d+ 条/) + `　exit=${r.code}`);

// —— E 宿主：只读连通（端口从 doctor 解析，绝不硬编码）——
if (SKIP_LIVE) {
  add('E1', '宿主只读连通', true, '--skip-live 跳过（离线/无宿主环境）', false);
} else {
  r = run(join('station', 'kbctl.mjs'), ['doctor'].concat(argPort ? ['--port', argPort] : []));
  const m = /127\.0\.0\.1:(\d+)/.exec(r.out);
  add('E2', 'kbctl doctor 探到宿主 API' + (argPort ? `（--port ${argPort}）` : '（不带 --port，走自动枚举）'), r.code === 0 && !!m,
    pick(r.out, /宿主 API|没探到/) + `　exit=${r.code}`);
  if (m) {
    try {
      const port = m[1];
      const list = await (await fetch(`http://127.0.0.1:${port}/api/kb/list`)).json();
      const search = await (await fetch(`http://127.0.0.1:${port}/api/kb/search?q=${encodeURIComponent('宿舍')}`)).json();
      const dump = JSON.stringify(list);
      const residue = /probe|__auth|nope|test-file/i.test(dump);
      const dbChars = list.rows.reduce((a, x) => a + (x.payload ? x.payload.length : 0), 0);
      add('E1', '宿主 KB API 只读连通且无探针残留', !residue && list.matched > 0 && search.matched > 0,
        `matched=${list.matched} 分类=${JSON.stringify(list.categories)} /api/kb/search?q=宿舍 matched=${search.matched}　残留=${residue}　DB ${defaultDb()}`.slice(0, 160)
        + (dbChars ? '' : '　（list 不回 payload，字符量以 D1 为准）'));
    } catch (e) { add('E1', '宿主 KB API 只读连通', false, '探测失败：' + e.message.slice(0, 80)); }
  } else add('E1', '宿主 KB API 只读连通', false, 'doctor 没给出端口，跳过（离线不算失败时加 --skip-live）');
}
r = run(join('station', 'kbctl.mjs'), ['build']);
add('E3', 'build 演练（不带 --apply，不改库）', r.code === 0 && /演练模式/.test(r.out), pick(r.out, /演练模式|不一致/) + `　exit=${r.code}`);

// —— F 版本 ——
const git = (a) => { try { return execFileSync('git', a, { encoding: 'utf8' }).trim(); } catch (e) { return 'ERR'; } };
const ahead = git(['rev-list', '--count', 'origin/main..HEAD']);
const dirty = git(['status', '--porcelain']);
add('F1', '本地无未推送提交、工作树干净', ahead === '0' && !dirty,
  `ahead=${ahead || '?'}　${dirty ? '未提交：' + dirty.split('\n').length + ' 项' : '工作树干净'}`);

const hard = rows.filter((x) => x.hard);
const failed = hard.filter((x) => !x.pass);
console.log('\n=== 验收结论 ===');
console.log(`硬项 ${hard.length}：PASS ${hard.length - failed.length}　FAIL ${failed.length}　（软读数另 ${rows.length - hard.length} 条）`);
for (const f of failed) console.log('  ✗ ' + f.id + ' ' + f.name + '\n     ' + f.evidence.slice(0, 150));
const onlyDeploy = failed.length > 0 && failed.every((f) => ['B2', 'C3'].includes(f.id));
if (onlyDeploy) console.log('判读：红的全是"线上那份没装上"这一类——代码侧无缺陷，装上+重启后需重跑本单确认。');
console.log('本单全程只读：未 build --apply、未 import、未清 FTS、未写已安装预设。');
process.exit(failed.length === 0 ? 0 : 1);
