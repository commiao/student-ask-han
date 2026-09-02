#!/usr/bin/env node
// kbctl — 闭卷知识库问答的交付面。把"装预设 + 导文档 + 体检 + 回归"收成一条命令一条。
//
//   node kbctl.mjs init   --title "XX手册" --category 员工手册   # 生成本站配置
//   node kbctl.mjs import docs/*.pdf                            # 走宿主 /api/kb/import 正规管线
//   node kbctl.mjs status                                       # 库里有什么、会不会走全量投喂
//   node kbctl.mjs install [--root <路径>] [--dry-run]          # 渲染并安装预设
//   node kbctl.mjs verify                                       # 端到端自测 + 正例/负例召回回归（打已安装预设）+ 库健康
//   node kbctl.mjs doctor                                       # 环境体检（形态/端口/node:sqlite）
//
// 设计前提（与你的判断一致）：DSH、dsh-knowledge-base、dsh-im 各环境都一样，
// 模型也无关；环境差异只剩"绑哪个 QQ bot"（在 DSH 设置里，不在这些文件中）。
// 所以 test→prod 不是两套产物，是同一份 station.json 装两次。
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);                       // 交付包里的 kb/ 根
const STATION = join(HERE, 'station.json');
const TPL = join(HERE, 'agent.cordis.yml.tpl');
const PLUGIN_SRC = join(ROOT, 'preset-kb-qa', 'kb-ask.mjs');
const LOCK = join(HERE, 'station.lock.json');
const DEFAULTS = {
  title: '电子信息工程学院新生必备指南',
  category: '新生指南',
  refusal: '该问题超出范围了，请联系管理员',
  fullDumpMax: 6000,
  docs: 'out',
};

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);
const load = () => ({ ...DEFAULTS, ...(existsSync(STATION) ? JSON.parse(readFileSync(STATION, 'utf8')) : {}) });
const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const ok = (msg) => console.log(`✓ ${msg}`);

/** 各部署形态的 harness 根：Desktop 三家 + dsh web 的 $DSH_HOME。 */
function harnessRoots() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const out = [
    process.env.DSH_HOME,
    process.env.APPDATA && join(process.env.APPDATA, 'dsh-desktop', 'harness'),
    home && join(home, 'Library', 'Application Support', 'dsh-desktop', 'harness'),
    home && join(home, '.config', 'dsh-desktop', 'harness'),
    home && join(home, '.dsh'),
  ].filter(Boolean);
  const hit = out.find((p) => existsSync(join(p, 'knowledge-base'))) || out.find((p) => existsSync(p));
  return { list: out, picked: hit || null };
}

function dbPath(cfg) {
  if (cfg.db) return resolve(cfg.db.replace(/^~/, process.env.HOME || process.env.USERPROFILE || ''));
  const r = harnessRoots();
  return r.picked ? join(r.picked, 'knowledge-base', 'kb.sqlite') : null;
}

/** 宿主端口每次启动都会变，只能探：lsof、DSH 进程参数、命令行候选逐个 GET /api/kb/list 认 JSON。 */
function findHost(stub) {
  const ports = new Set();
  if (arg('port')) ports.add(Number(arg('port')));
  if (process.env.DSH_PORT) ports.add(Number(process.env.DSH_PORT));
  try {
    const out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      if (!/[Dd]s[Sh][Hh]*|Electron|node/.test(line.split(/\s+/)[0] || '')) continue;
      const m = /:(\d+)\s*$/.exec(line.trim());
      if (m) ports.add(Number(m[1]));
    }
  } catch { /* 没 lsof 就只试显式端口 */ }
  // 官方 dsh 容器镜像未必带 lsof；其主进程会以
  // `dsh --profile web ... --port <n>` 启动，ps 是更轻量的可移植回退。
  try {
    const out = execFileSync('ps', ['-eo', 'args='], { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      if (!/\bdsh\b/.test(line)) continue;
      const m = /--port\s+(\d+)/.exec(line);
      if (m) ports.add(Number(m[1]));
    }
  } catch { /* BusyBox/受限环境仍退回显式端口与候选 */ }
  const seeded = [...ports, 64685, 63158, 43127];
  return stub || seeded;
}

async function probeHost() {
  for (const port of findHost()) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/kb/list`, { signal: AbortSignal.timeout(1500) });
      const text = await res.text();
      if (text.startsWith('{') && text.includes('"matched"')) return { port, body: JSON.parse(text) };
    } catch { /* 换下一个 */ }
  }
  return null;
}

async function cmdDoctor() {
  const cfg = load();
  console.log(`站点：${cfg.title}  分类：${cfg.category}`);
  const r = harnessRoots();
  console.log(r.picked ? `✓ harness 根：${r.picked}` : '✗ 找不到 harness 根，用 --root 指定');
  try { ok(`node:sqlite 可用（Node ${process.versions.node}）`); } catch { /* 下面 import 已经炸了 */ }
  const db = dbPath(cfg);
  if (!db || !existsSync(db)) fail(`知识库不存在：${db || '未定位到'} —— 先 import 或放置 kb.sqlite`);
  const conn = new DatabaseSync(db, { readOnly: true });
  const n = conn.prepare('select count(*) c from kb').get().c;
  const chars = conn.prepare('select coalesce(sum(length(payload)),0) n from kb').get().n;
  conn.close();
  ok(`知识库：${db}  条目 ${n}  原文 ${chars} 字符`);
  const host = await probeHost();
  if (host) ok(`宿主 API：127.0.0.1:${host.port}（/api/kb/list 返回 matched=${host.body.matched}，分类 ${JSON.stringify(host.body.categories)}）`);
  else console.log('! 没探到宿主端口：import 需要 DSH 正在运行且装了 dsh-knowledge-base；install/verify 不需要');
  const presetRoot = r.picked ? join(r.picked, '.agent-presets', 'kb-qa') : null;
  if (presetRoot && existsSync(join(presetRoot, 'kb-ask.mjs'))) ok(`预设已安装：${presetRoot}`);
  else console.log(`! 预设未安装${presetRoot ? `（目标位置 ${presetRoot}）` : ''}：跑 install`);
  console.log(`全量投喂：${chars <= cfg.fullDumpMax ? '开' : '关'}（阈值 ${cfg.fullDumpMax}）`);
}

async function cmdImport(files) {
  if (files.length === 0) fail('用法：import <文件或目录> ...');
  const host = await probeHost();
  if (!host) fail('没探到宿主 API。请确认 DSH 正在运行、且该 profile 装了 dsh-knowledge-base；或加 --port <端口>');
  const cfg = load();
  const list = expandTargets(files);
  if (list.length === 0) fail('没有可导入的文件');
  for (const f of list) {
    const body = { name: f.split(/[\\/]/).pop(), contentBase64: readFileSync(f).toString('base64') };
    const res = await fetch(`http://127.0.0.1:${host.port}/api/kb/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) fail(`${f} 导入失败 HTTP ${res.status}：${text.slice(0, 300)}`);
    let data = {};
    try { data = JSON.parse(text); } catch { /* 允许非 JSON 回执 */ }
    ok(`${f} → ${JSON.stringify(data).slice(0, 160)}`);
    if (cfg.category && data.source) {
      await fetch(`http://127.0.0.1:${host.port}/api/kb/move-file`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: data.source, category: cfg.category }),
      }).then((r) => r.text()).catch(() => {});
    }
  }
  console.log('\n注意：同名文件重新导入会追加条目而非覆盖（0.1.5 实测如此）。');
  console.log('导入后跑 `status` 看条目总数，重复了就 `node kbctl.mjs prune --source <文件名>` 清掉旧的。');
}

/** 展开导入目标：目录取其一层的普通文件。 */
function expandTargets(list) {
  const out = [];
  for (const f of list) {
    if (!existsSync(f)) fail(`找不到 ${f}`);
    if (statSync(f).isDirectory()) {
      for (const n of readdirSync(f).filter((s) => !s.startsWith('.'))) {
        const p = join(f, n);
        if (statSync(p).isFile()) out.push(p);
      }
    } else out.push(f);
  }
  return out;
}

/** 清掉某个来源文件产生的条目：0.1.5 同名重导是追加而非覆盖，不清就会双份命中。 */
async function cmdPrune() {
  const source = arg('source');
  if (!source) fail('用法：prune --source <文件名，如 报到须知.md>');
  const host = await probeHost();
  if (!host) fail('没探到宿主端口，无法调用 /api/kb/delete-file');
  const res = await fetch(`http://127.0.0.1:${host.port}/api/kb/delete-file`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }),
  });
  const text = await res.text();
  if (!res.ok) fail(`删除失败 HTTP ${res.status}：${text.slice(0, 300)}`);
  ok(`已删除来源 ${source} 的全部条目：${text.slice(0, 160)}`);
  console.log('删条目不需要重启：预设连接是只读现查。只有整库文件被替换（inode 变了）才要重启 DSH。');
}

/**
 * docs 指纹。切块只按 markdown 标题切，所以"文件名 + 内容"的散列就等于库的内容版本；
 * 把它锁进 station.lock.json，就能回答"线上这台跑的是哪一版文档"。
 */
function docsDigest(cfg) {
  const dir = resolve(ROOT, cfg.docs || 'out');
  if (!existsSync(dir)) fail(`找不到文档源目录：${dir}`);
  const files = readdirSync(dir).filter((n) => /\.md$/i.test(n) && !n.startsWith('.')).sort();
  if (files.length === 0) fail(`${dir} 里没有 .md 文档源`);
  const h = createHash('sha256');
  for (const n of files) { h.update(n); h.update('\0'); h.update(readFileSync(join(dir, n))); h.update('\0'); }
  return { dir, files, hash: h.digest('hex').slice(0, 16) };
}

function liveRows(cfg) {
  const db = dbPath(cfg);
  if (!db || !existsSync(db)) return [];
  const conn = new DatabaseSync(db, { readOnly: true });
  try { return conn.prepare('select id, category, name, payload from kb order by id').all(); } catch { return []; } finally { conn.close(); }
}

/**
 * build —— 以 docs/ 为唯一真源重建库。不带 --apply 时只做漂移体检，不动任何数据。
 * 为什么生产该重建而不是收 kb.sqlite：库是派生物，插件版本/切块实现一变，
 * 拷贝过来的就是"上一版编译器产出的二进制"，没人能证明它与当前 docs 对得上。
 */
async function cmdBuild() {
  const cfg = load();
  const docs = docsDigest(cfg);
  const locked = existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, 'utf8')) : null;
  const rows = liveRows(cfg);
  const chars = rows.reduce((n, r) => n + String(r.payload ?? '').length, 0);
  console.log(`docs 指纹 ${docs.hash}（${docs.files.length} 个文件）`);
  console.log(locked ? `库基线   ${locked.docsHash}${locked.docsHash === docs.hash ? '  ✓ 同版本' : '  ✗ docs 已变更，需要重建'}`
    : '库基线   无 station.lock.json（当前库不是 kbctl build 建的）');
  console.log(`线上     ${rows.length} 条 / ${chars} 字符`);

  let drift = 0;
  for (const n of docs.files) {
    const want = readFileSync(join(docs.dir, n), 'utf8').replace(/\r\n/g, '\n').trim();
    const mine = rows.filter((r) => String(r.name).startsWith(n));
    const got = mine.map((r) => String(r.payload ?? '')).join('\n').trim();
    // 插件会把小块合并、并在 name 上拼 "文件名 · 标题"，所以比对只看内容是否覆盖到。
    const hit = mine.length > 0 && got.includes(want.slice(0, 60));
    if (!hit) drift += 1;
    console.log(`  ${hit ? '=' : '≠'} ${n.padEnd(20)} 库内 ${mine.length} 段 ${got.length} 字符${hit ? '' : '  ← 内容与 docs 不一致'}`);
  }

  if (!flag('apply')) {
    console.log(`\n演练模式，未改动库。要重建：node kbctl.mjs build --apply${drift ? '' : '（当前已与 docs 一致，重建只为换插件版本）'}`);
    console.log('重建动作：按来源 prune 这 ' + docs.files.length + ' 个文件 → 走 /api/kb/import 正规管线 → 归入「' + cfg.category + '」→ 写 lock。');
    return;
  }
  if (drift > 0 && !flag('force')) {
    fail(`${drift} 个文件与 docs 不一致——库里可能有手工整理过的条目。确认这些改动可以丢，再加 --force`);
  }
  const host = await probeHost();
  if (!host) fail('build --apply 需要宿主 API（正规导入管线）。确认 DSH 在跑且装了 dsh-knowledge-base，或加 --port <端口>');
  const api = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${host.port}/api/kb/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) fail(`${path} 失败 HTTP ${res.status}：${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return {}; }
  };
  for (const n of docs.files) await api('delete-file', { source: n });
  ok(`已按来源清除 ${docs.files.length} 个文件的旧条目`);
  for (const n of docs.files) {
    const r = await api('import', { name: n, contentBase64: readFileSync(join(docs.dir, n)).toString('base64') });
    const src = r.source || n;
    if (cfg.category) await api('move-file', { source: src, category: cfg.category });
    ok(`${src} → ids ${JSON.stringify(r.ids || [])}`);
  }
  const after = liveRows(cfg);
  writeFileSync(LOCK, JSON.stringify({ docsHash: docs.hash, files: docs.files, entries: after.length, builtAt: new Date().toISOString(), host: 'api' }, null, 2) + '\n');
  ok(`重建完成：${after.length} 条 / ${after.reduce((n, r) => n + String(r.payload ?? '').length, 0)} 字符，基线写入 station.lock.json`);
  console.log('条目 id 会变（自增），但引用标号「第N条 Qn」由内容决定，不受影响。跑 verify 复核。');
}

/**
 * ship —— 把"重建库 → 回归 → 装预设"收成一条。不带 --apply 时全程演练：
 * cmdBuild 自己会在演练模式下 return，所以这条链天然停在"还没动数据"的地方。
 * 目的是让 skill（和人）只需要记一个词，同时保住那道人工确认闸门。
 */
async function cmdShip() {
  console.log('=== 1/3 知识库重建 ===');
  await cmdBuild();
  if (!flag('apply')) {
    console.log('\n演练到此为止（未改动任何数据）。确认后跑：node kbctl.mjs ship --apply');
    return;
  }
  console.log('\n=== 2/3 回归验收 ===');
  await cmdVerify();
  console.log('\n=== 3/3 安装预设 ===');
  cmdInstall();
  console.log('\n三条跑完。提醒：本轮若改过 kb-ask.mjs / roster，仍需换进程才生效——');
  console.log('Desktop 是 Cmd+Q 重开，docker 场景 docker restart <容器> 即可（见 DEPLOY 说明里的 volume 前提）。');
}

async function cmdStatus() {
  const cfg = load();
  const db = dbPath(cfg);
  if (!db || !existsSync(db)) fail(`知识库不存在：${db || '未定位到'}`);
  const conn = new DatabaseSync(db, { readOnly: true });
  const rows = conn.prepare('select id, category, name, length(payload) len from kb order by id').all();
  conn.close();
  const total = rows.reduce((n, r) => n + r.len, 0);
  for (const r of rows) console.log(`  ${String(r.id).padStart(3)}  ${String(r.category)}  ${String(r.name).split('·').pop().trim().padEnd(18)} ${r.len} 字符`);
  console.log(`合计 ${rows.length} 条 / ${total} 字符；全量投喂阈值 ${cfg.fullDumpMax} → ${total <= cfg.fullDumpMax ? '开' : '关'}`);
  if (total > cfg.fullDumpMax) console.log('! 超出阈值会退回分级检索，词汇错配（如"开学"vs"报到"）可能重新漏答');
}

function cmdInit() {
  const title = arg('title'); const category = arg('category');
  const next = { ...load(), ...(title ? { title } : {}), ...(category ? { category } : {}) };
  writeFileSync(STATION, JSON.stringify(next, null, 2) + '\n');
  ok(`写入 ${STATION}`);
  console.log(JSON.stringify(next, null, 2));
  console.log('\n下一步：把文档放进 docs/ 后跑 import；再跑 install 与 verify。');
}

function cmdInstall() {
  const cfg = load();
  const r = harnessRoots();
  const root = arg('root') || (r.picked ? join(r.picked, '.agent-presets') : null);
  if (!root) fail('定位不到预设根目录，用 --root <.../.agent-presets> 指定');
  const dst = join(root, 'kb-qa');
  const roster = readFileSync(TPL, 'utf8')
    .replaceAll('{{title}}', cfg.title)
    .replaceAll('{{category}}', cfg.category)
    .replaceAll('{{refusal}}', cfg.refusal)
    .replaceAll('{{fullDumpMax}}', String(cfg.fullDumpMax));
  if (flag('dry-run')) { console.log(`目标：${dst}\n`); console.log(roster); return; }
  mkdirSync(dst, { recursive: true });
  writeFileSync(join(dst, 'agent.cordis.yml'), roster);
  // roster 的唯一真源是 station/agent.cordis.yml.tpl。仓库里 preset-kb-qa/agent.cordis.yml
  // 只是**渲染快照**（给人读、给"手工 cp 三个文件"那条路用），每次 install 一并刷新。
  // 以前它是第二条真源：改了它不会上线（install 从 tpl 渲染），换机器用 deploy 脚本又会装出
  // 另一份 persona。现在由 validate.mjs 断言"快照 == 渲染结果"，漂移直接判失败。
  const snap = join(ROOT, 'preset-kb-qa', 'agent.cordis.yml');
  try {
    writeFileSync(snap, roster);
    ok(`渲染快照已同步：${snap}`);
  } catch (e) {
    console.log(`! 渲染快照没写成（${e.code}）：手工 cp 装预设时，那份 yml 可能还是旧的`);
  }
  writeFileSync(join(dst, 'preset.yml'), `name: 闭卷问答（${cfg.title}）\ndescription: 只回答知识库「${cfg.category}」已导入内容；工具面仅 kb_ask；越界一律固定话术。\norder: 5\n`);
  copyFileSync(PLUGIN_SRC, join(dst, 'kb-ask.mjs'));
  // 版本戳：kb-ask.mjs 的 `版本号` 探针读的就是这个文件，缺了它线上只能回"未知"。
  writeFileSync(join(dst, 'VERSION.txt'), `${versionStampText()}\n`);
  ok(`安装到 ${dst}`);
  // 这两项缺一样就只会看到一句没有原因的 PRESET_UNAVAILABLE，装完立刻自检。
  const shipped = readFileSync(join(dst, 'kb-ask.mjs'), 'utf8');
  if (!shipped.includes("export const inject = ['tools']")) fail('装好的 kb-ask.mjs 缺 inject 声明');
  execFileSync(process.execPath, ['--check', join(dst, 'kb-ask.mjs')]);
  ok('挂载自检：inject 声明在位、语法可解析');
  console.log('\n必须完全退出并重启 DSH（同进程会复用缓存的旧模块）。');
  console.log('预设绑定是**按 bot** 存的（integrations/<渠道>/workspaces.json 的 agentPresets），'
    + '新群第一条消息自动用 kb-qa，不需要在群里发 /preset。');
  console.log('已有旧会话要换新绑定时才需要 /new；本机可用 `node kbctl.mjs reset-session --apply` 替代（先退出 DSH）。');
}

async function cmdVerify() {
  const cfg = load();
  const db = dbPath(cfg);
  const env = { ...process.env, KB_ASK_DB: db || '', KB_ASK_TITLE: cfg.title, KB_ASK_CATEGORY: cfg.category };
  execFileSync(process.execPath, [join(ROOT, 'test-kb-ask.mjs')], { env, stdio: 'inherit' });
  // 装完必须连**负例**一起验：只看正例（test-kb-ask 那 55 例）会掩盖"放宽召回把越界问题放进来"
  // 这一类退化——第 3 轮就是靠 recall 里新接的负例门禁才发现三条一直存在的假阳性。
  // 这里刻意用 KB_ASK_TARGET=installed：验的是刚装进 .agent-presets 的那份，不是工作区那份。
  console.log('\n--- 召回与越界回归（对已安装预设跑：正例合并集 + cases.neg.md 硬负例）---');
  execFileSync(process.execPath, [join(ROOT, 'recall.mjs')],
    { env: { ...env, KB_ASK_TARGET: 'installed' }, stdio: 'inherit' });
  const host = await probeHost();
  if (host) {
    const res = await fetch(`http://127.0.0.1:${host.port}/api/kb/search?q=${encodeURIComponent('宿舍')}`);
    const body = JSON.parse(await res.text());
    ok(`宿主检索连通：q=宿舍 matched=${body.matched}`);
  } else console.log('! 未探到宿主端口，跳过线上连通检查');
}

// ───────────────────────── im-defaults ─────────────────────────
// dsh-im 在发现一个新 bot 时，会把频道配置中的 `agentPreset` 交给
// BotWorkspaceStore.ensure()。这正是“新绑的 QQ bot 不用再到群里 /preset”
// 的原生入口；不碰 credentials，也不改已经绑好的 bot。
//
// 注意：群昵称上下文目前在 dsh-im 4.7 是 per-bot 的 workspaces.json 状态，
// 没有同等的配置级 default。这里不能伪造一个看起来全自动、实则会被
// 运行期状态覆盖的写入；新 bot 的默认预设则由宿主可靠地在创建时落盘。
function cmdImDefaults() {
  const r = harnessRoots();
  const root = arg('root') || r.picked;
  const profile = arg('profile', 'web');
  if (!root) fail('定位不到 DSH 根，用 --root <DSH_HOME> 指定');
  const file = join(root, 'profiles', profile, 'cordis.patch.yml');
  if (!existsSync(file)) fail(`找不到 DSH profile 配置：${file}`);
  const source = readFileSync(file, 'utf8');
  const start = source.search(/^- id: xmanrui-dsh-im\s*$/m);
  if (start < 0) fail(`${file} 中没有 xmanrui-dsh-im 插件块；为避免误改，未写入`);
  const headEnd = source.indexOf('\n', start) + 1;
  const nextStart = source.indexOf('\n- id:', headEnd);
  const end = nextStart < 0 ? source.length : nextStart + 1;
  const whole = source.slice(start, end);
  const head = source.slice(start, headEnd);
  const body = source.slice(headEnd, end);
  const config = /^(\s*)config:\s*$/m.exec(body);
  if (!config) fail('dsh-im 插件块没有 config；为避免误改，未写入');
  const propertyIndent = `${config[1]}  `;
  const qqHeader = new RegExp(`^${propertyIndent}qq:\\s*$`, 'm');
  const preset = new RegExp(`^${propertyIndent}  agentPreset:\\s*(\\S.*?)\\s*$`, 'm');
  let nextBody = body;
  const current = preset.exec(body)?.[1] ?? null;
  if (current && current !== 'kb-qa') {
    fail(`QQ 默认预设已是 ${current}，不覆盖为 kb-qa；如需改动请先在 DSH 配置中确认`);
  }
  if (!current) {
    if (qqHeader.test(body)) {
      // qq 块存在但还没有 preset：把键放进该块的第一行，保持 YAML 缩进。
      nextBody = body.replace(qqHeader, (line) => `${line}\n${propertyIndent}  agentPreset: kb-qa`);
    } else {
      // 当前官方 profile 通常有 rpcAuthority；没有时直接放在 config 开头。
      const anchor = new RegExp(`^${propertyIndent}rpcAuthority:.*(?:\\n|$)`, 'm');
      if (anchor.test(body)) {
        nextBody = body.replace(anchor, (line) => `${line}${propertyIndent}qq:\n${propertyIndent}  agentPreset: kb-qa\n`);
      } else {
        const configLine = new RegExp(`^${config[1]}config:\\s*(?:\\n|$)`, 'm');
        nextBody = body.replace(configLine, (line) => `${line}${propertyIndent}qq:\n${propertyIndent}  agentPreset: kb-qa\n`);
      }
    }
  }
  const next = source.replace(whole, `${head}${nextBody}`);
  if (next === source) {
    ok('dsh-im 的 QQ 默认预设已是 kb-qa（新绑定 bot 会自动使用它）');
    return;
  }
  if (!flag('apply')) {
    console.log(`演练：将在 ${file} 的 dsh-im.qq 配置写入 agentPreset: kb-qa。`);
    console.log('确认后执行：node station/kbctl.mjs im-defaults --apply，然后重启 DSH。');
    return;
  }
  const backup = `${file}.bak-${Date.now()}`;
  copyFileSync(file, backup);
  writeFileSync(file, next, 'utf8');
  ok(`已写入 QQ 新 bot 默认预设 kb-qa（备份：${backup}）`);
  console.log('重启 DSH 后生效：以后新绑定 QQ bot 的新会话自动为 kb-qa，无需 /preset 或 /new。');
  console.log('群昵称上下文仍须按 bot 在 IM 设置中启用；当前 dsh-im 没有全局默认配置。');
}

// ─────────────────────────── reset-session ───────────────────────────
// 把"在群里发 /new"换成一条本机命令。为什么需要：
//   1) 预设绑定只在**建会话那一刻**读一次（bot-workspace-store.mjs:1037 `agentPresetFor(botId)`
//      传进 createSession），插件自己的话术也是这么写的：「已有会话不变……请先发送 /new」；
//   2) dsh-im 里**没有**任何"空闲自动新建会话"的机制——全仓只有二维码 TTL 和 /presetlist 的
//      15 分钟快照 TTL。所以老会话会无限期保持它创建时的状态，升级只能靠人手动 /new；
//   3) 会话 ↔ 群的映射落在 <harness>/integrations/<channel>/bots/<botId>/state.json 的 `sessions`
//      （ConversationStateStore：启动 load、每次 setSession/clearSession 立刻落盘）。
// 删掉 sessions 里的条目 = 下一条群消息找不到绑定 → 新建会话 → 自动带上 workspaces.json 里当前的
// agentPreset。效果和群里发 /new 一样，但不出现在群聊天记录里。
// ⚠ 只能在 DSH 完全退出后做：运行期那个 store 持有内存态并会把手改的那份写回去。
async function cmdResetSession() {
  const r = harnessRoots();
  const root = arg('root') || r.picked;
  if (!root) fail('定位不到 harness 根，用 --root <.../harness> 指定');
  const integ = join(root, 'integrations');
  if (!existsSync(integ)) fail(`没有 ${integ}`);
  const files = [];
  for (const ch of readdirSync(integ)) {
    const bots = join(integ, ch, 'bots');
    if (!existsSync(bots)) continue;
    for (const b of readdirSync(bots)) {
      const p = join(bots, b, 'state.json');
      if (existsSync(p)) files.push({ channel: ch, bot: b, file: p });
    }
  }
  if (files.length === 0) fail(`${integ} 下没找到任何 bots/*/state.json`);
  // 顺带把"新会话会绑哪个预设"打出来：这个键就是 /preset 写的东西，不在 state.json 里。
  console.log('\n各 bot 当前用于**新会话**的预设（/preset 写的是这里）：');
  for (const { channel, file } of files) {
    const wj = join(dirname(dirname(dirname(file))), 'workspaces.json');
    if (!existsSync(wj)) continue;
    try {
      const doc = JSON.parse(readFileSync(wj, 'utf8'));
      for (const [botId, preset] of Object.entries(doc.agentPresets || {})) {
        console.log(`  ${channel} ${botId} → ${preset}`);
      }
    } catch { /* 读不动就不报，不影响主流程 */ }
  }
  let touched = 0;
  for (const { channel, bot, file } of files) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      console.log(`! ${channel}/${bot}：state.json 读不了（${e.message}），跳过`);
      continue;
    }
    const keys = Object.keys(doc.sessions || {});
    console.log(`\n${file}\n  会话绑定 ${keys.length} 条：${keys.join('  ') || '（空）'}`);
    if (keys.length === 0) continue;
    touched += keys.length;
    if (!flag('apply')) continue;
    const age = Date.now() - statSync(file).mtimeMs;
    if (age < 90_000) {
      fail(`state.json ${Math.round(age / 1000)} 秒前刚被写过 —— DSH 还在运行，现在改会被它写回去。先 Cmd+Q。`);
    }
    const bak = `${file}.bak-${Date.now()}`;
    copyFileSync(file, bak);
    doc.sessions = {};
    writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    ok(`已清空 ${keys.length} 条绑定（原文件备份在 ${bak}）`);
  }
  if (!flag('apply')) {
    console.log(`\n演练模式：将清空 ${touched} 条会话绑定。确认后加 --apply。`);
    console.log('前置条件：DSH 必须已完全退出（Cmd+Q），否则运行期那份内存状态会把改动覆盖掉。');
    return;
  }
  console.log('\n下一步：启动 DSH。群里下一条普通消息就会新建会话，并自动使用上面列出的预设——不需要任何群内命令。');
}

// 版本戳：让群里一句 `@机器人 版本号` 就能对上"线上跑的到底是哪份代码"。
// 内容 = 仓库短哈希（脏树加 +dirty）+ 用例集形状 + 装机时刻。用例数直接读文件自己数，
// 不在 install 里跑回归（那是 verify 的活）；文件缺（瘦身交付包）就只报哈希。
function versionStampText() {
  const git = (args) => {
    try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return ''; }
  };
  const hash = git(['rev-parse', '--short', 'HEAD']) || 'nogit';
  const dirty = git(['status', '--porcelain']) ? '+dirty' : '';
  let shape = '';
  try {
    const n = (f) => JSON.parse(readFileSync(join(ROOT, f), 'utf8')).items
      .reduce((s, i) => s + (i.variants?.length ?? 0), 0);
    const neg = readFileSync(join(ROOT, 'cases.neg.md'), 'utf8')
      .split('\n').filter((l) => /^- \S/.test(l) && !/^- \?/.test(l)).length;
    shape = ` 正例${n('cases.gen.json') + n('cases.human.json')}/负例${neg}`;
  } catch { /* 用例文件不在，跳过 */ }
  const when = new Date().toLocaleString('zh-CN', { hour12: false });
  return `${hash}${dirty}${shape} · 装于 ${when}`;
}

// 比对仓库与线上两份版本戳：升级前跑一条就知道"到底装没装上"，不必靠记忆或比 shasum。
function cmdVersion() {
  const mine = versionStampText();
  console.log(`仓库现在：${mine}`);
  const r = harnessRoots();
  const root = arg('root') || (r.picked ? join(r.picked, '.agent-presets') : null);
  const f = root ? join(root, 'kb-qa', 'VERSION.txt') : null;
  if (!f || !existsSync(f)) {
    console.log('线上：没有 VERSION.txt —— 那份不是 kbctl install 装的（或装机时还没有版本戳），跑一次 install');
    return;
  }
  const live = readFileSync(f, 'utf8').trim();
  console.log(`线上那份：${live}`);
  console.log(live.split(' ')[0] === mine.split(' ')[0]
    ? '哈希一致 ✓（时间戳不同是正常的）'
    : '! 不一致：要 install + 完全退出重启 DSH 才会生效');
}

// 只刷新仓库里的渲染快照（preset-kb-qa/agent.cordis.yml），不碰 .agent-presets。
// 用途：改了 tpl 想让仓库那份先自洽（`node validate.mjs` 才不报漂移），或者打算走
// "手工 cp 三个文件"那条路装机时，用它把快照刷新到最新。
function cmdRender() {
  const cfg = load();
  const roster = readFileSync(TPL, 'utf8')
    .replaceAll('{{title}}', cfg.title)
    .replaceAll('{{category}}', cfg.category)
    .replaceAll('{{refusal}}', cfg.refusal)
    .replaceAll('{{fullDumpMax}}', String(cfg.fullDumpMax));
  const snap = join(ROOT, 'preset-kb-qa', 'agent.cordis.yml');
  const same = existsSync(snap) && readFileSync(snap, 'utf8') === roster;
  if (!flag('apply')) {
    console.log(`演练：快照 ${snap} ${same ? '已与 tpl 渲染结果一致' : '与 tpl 渲染结果不一致，需刷新'}`);
    console.log('确认后加 --apply（只写仓库这一个文件，不碰已安装预设）。');
    return;
  }
  writeFileSync(snap, roster);
  ok(`渲染快照已刷新：${snap}`);
  console.log('注意：这只同步仓库快照。线上那份要生效仍需 install + 完全退出重启 DSH。');
}

const cmd = process.argv[2];
const rest = process.argv.slice(3).filter((a) => !a.startsWith('--'));
if (cmd === 'doctor') await cmdDoctor();
else if (cmd === 'init') cmdInit();
else if (cmd === 'import') await cmdImport(rest);
else if (cmd === 'status') await cmdStatus();
else if (cmd === 'prune') await cmdPrune();
else if (cmd === 'build') await cmdBuild();
else if (cmd === 'ship') await cmdShip();
else if (cmd === 'install') cmdInstall();
else if (cmd === 'verify') await cmdVerify();
else if (cmd === 'im-defaults') cmdImDefaults();
else if (cmd === 'reset-session') await cmdResetSession();
else if (cmd === 'render') cmdRender();
else if (cmd === 'version') cmdVersion();
else console.log(`用法：node kbctl.mjs <doctor|init|import|status|install|verify> [参数]

  doctor              环境体检：harness 根、知识库、宿主端口、预设是否已装
  init  --title --category   写本站配置（换文档就改这里）
  import <路径...>     走宿主 /api/kb/import 导入 PDF/MD，按配置归到本站分类
  status              条目清单与全量投喂判断
  prune --source <f>  删除该来源文件的条目（同名重导会追加，需先清后导）
  build [--apply]     以 docs/ 为真源重建库；不带 --apply 只做漂移体检，不动数据
  ship  [--apply]     build → verify → install 一条龙；不带 --apply 全程演练
  install [--root] [--dry-run]  渲染并安装预设（kb-ask.mjs 单一来源，不复制第二份）
  verify              端到端 + 正/负例召回回归（打已安装预设）+ 挂载自检 + 宿主连通
  im-defaults [--apply]  将 DSH 的“新绑定 QQ bot”默认预设设为 kb-qa（重启后生效）
  reset-session [--apply]    清掉群里已有的会话绑定，替代在群里发 /new（须先退出 DSH）
  render  [--apply]          只刷新仓库渲染快照 preset-kb-qa/agent.cordis.yml（不碰线上）`);
