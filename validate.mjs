// 交付物三件套自检。装完 / 改完 yml 后跑一条命令就能确认"线上那份还满足闭卷前提"。
//
// 为什么单独有这一个脚本：它自己曾经是坏的（第 22 行把已经绝对的目录再拼一遍，
// 一跑必 ENOENT），也就是说这三轮里 yml 与 inject 声明从来没被自动核过，
// 全靠 kbctl install 里那两行。现在补齐，并且**任何一项不过就非 0 退出**。
//
// 用法：node validate.mjs                      # 检工作区 preset-kb-qa/
//       node validate.mjs installed            # 检已装进 .agent-presets 的那份
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { installedPlugin } from './test-paths.mjs';

const WORKSPACE = new URL('./preset-kb-qa/', import.meta.url).pathname;
const installed = installedPlugin();
const INSTALLED = installed ? `${dirname(installed)}/` : null;
const DIR = process.argv[2] === 'installed' ? INSTALLED : WORKSPACE;
if (!DIR) throw new Error('定位不到已安装的 kb-qa；请设置 DSH_HOME 或 KB_ASK_INSTALLED');
const REFUSAL = '该问题超出范围了，请联系管理员';

const fails = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : '!!!!'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) fails.push(label);
};

for (const f of ['preset.yml', 'agent.cordis.yml', 'kb-ask.mjs']) {
  if (!existsSync(DIR + f)) check(`文件存在 ${f}`, false, DIR);
}
const yml = existsSync(DIR + 'agent.cordis.yml') ? readFileSync(DIR + 'agent.cordis.yml', 'utf8') : '';
const presetYml = existsSync(DIR + 'preset.yml') ? readFileSync(DIR + 'preset.yml', 'utf8') : '';
const plugin = existsSync(DIR + 'kb-ask.mjs') ? readFileSync(DIR + 'kb-ask.mjs', 'utf8') : '';

// YAML 能不能 parse（python 的 yaml 只是可选校验，缺了不判失败）
const py = 'import sys,yaml\n'
  + 'for f in sys.argv[1:]:\n'
  + '    yaml.safe_load(open(f,encoding="utf-8"))\n'
  + 'print("parsed")\n';
const r = spawnSync('python3', ['-c', py, DIR + 'preset.yml', DIR + 'agent.cordis.yml'], { encoding: 'utf8' });
if (/No module named/.test(r.stderr)) console.log('~~~  本机 python3 无 yaml 模块，跳过语法解析（下面各项仍校验）');
else check('两个 yml 可被 YAML 解析', r.status === 0, (r.stderr || '').split('\n').pop() ?? '');

// 三条硬不变量：缺任何一条，线上表现只会是一句没有原因的 PRESET_UNAVAILABLE 或越界放行
check("kb-ask.mjs 有 inject 声明", /export const inject = \['tools'\];/.test(plugin),
  "缺了 apply() 在挂载期就抛 cannot get property \"tools\" without inject");
check('roster 里有 kb-ask 行且指向本地插件', /- id: kb-ask/.test(yml) && /name: \.\/kb-ask\.mjs/.test(yml));
check('固定话术逐字未被改动', new RegExp(`refusal: '${REFUSAL}'`).test(yml), '改了话术 = test-kb-ask 的形状断言与线上口径分叉');
check('persona 仍要求逐字照抄 reply', /逐字等于/.test(yml));
check('persona 未挂载外部知识工具', !/web_search|dsh-knowledge-base/.test(yml.replace(/^[^:]*#.*$/gm, '')),
  '一旦挂上联网/写库工具，闭卷性质就不成立了');
check('preset.yml 有 order 与 name', /order:/.test(presetYml) && /name:/.test(presetYml));

// roster 唯一真源。tpl 渲染出来是什么样，仓库快照 preset-kb-qa/agent.cordis.yml 与已安装那份
// 就必须一字不差是那样。这条是 2026-09-02 查出"两条安装路径装出两份不同 persona"之后补的：
// 当时线上缺 `不列出你查了什么词` 这条防泄漏约束，而它只写在仓库那份里，改多少次都不会上线。
// 渲染的 4 个占位符必须与 kbctl.mjs cmdInstall 里那段保持一致。
const STATION = new URL('./station/', import.meta.url).pathname;
const TPL = STATION + 'agent.cordis.yml.tpl';
if (existsSync(TPL)) {
  const DEF = {
    title: '电子信息工程学院新生必备指南', category: '新生指南',
    refusal: REFUSAL, fullDumpMax: 6000,
  };
  let cfg = DEF;
  if (existsSync(STATION + 'station.json')) {
    try { cfg = { ...DEF, ...JSON.parse(readFileSync(STATION + 'station.json', 'utf8')) }; }
    catch { check('station.json 可解析', false); }
  }
  const rendered = readFileSync(TPL, 'utf8')
    .replaceAll('{{title}}', cfg.title)
    .replaceAll('{{category}}', cfg.category)
    .replaceAll('{{refusal}}', cfg.refusal)
    .replaceAll('{{fullDumpMax}}', String(cfg.fullDumpMax));
  check('roster 唯一真源：目标那份逐字等于 tpl 渲染结果', yml === rendered,
    yml === rendered ? ''
      : '改了 station/agent.cordis.yml.tpl 必须重跑 kbctl install（它同时刷新仓库快照与已装那份）');
} else {
  console.log('~~~  没有 station/agent.cordis.yml.tpl（瘦身交付包里会缺），跳过真源比对');
}

console.log(`\n目标: ${DIR}`);
if (fails.length > 0) {
  console.log(`不通过 ${fails.length} 项：${fails.join(' / ')}`);
  process.exit(1);
}
console.log('三件套自检全过。');
process.exit(0);
