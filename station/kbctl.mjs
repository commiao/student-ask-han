#!/usr/bin/env node
// kbctl — 闭卷知识库问答的交付面。把"装预设 + 导文档 + 体检 + 回归"收成一条命令一条。
//
//   node kbctl.mjs init   --title "XX手册" --category 员工手册   # 生成本站配置
//   node kbctl.mjs import docs/*.pdf                            # 走宿主 /api/kb/import 正规管线
//   node kbctl.mjs status                                       # 库里有什么、会不会走全量投喂
//   node kbctl.mjs install [--root <路径>] [--dry-run]          # 渲染并安装预设
//   node kbctl.mjs verify                                       # 47 例回归 + 挂载自检 + 库健康
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

/** 宿主端口每次启动都会变，只能探：lsof/命令行候选逐个 GET /api/kb/list 认 JSON。 */
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
  writeFileSync(join(dst, 'preset.yml'), `name: 闭卷问答（${cfg.title}）\ndescription: 只回答知识库「${cfg.category}」已导入内容；工具面仅 kb_ask；越界一律固定话术。\norder: 5\n`);
  copyFileSync(PLUGIN_SRC, join(dst, 'kb-ask.mjs'));
  ok(`安装到 ${dst}`);
  // 这两项缺一样就只会看到一句没有原因的 PRESET_UNAVAILABLE，装完立刻自检。
  const shipped = readFileSync(join(dst, 'kb-ask.mjs'), 'utf8');
  if (!shipped.includes("export const inject = ['tools']")) fail('装好的 kb-ask.mjs 缺 inject 声明');
  execFileSync(process.execPath, ['--check', join(dst, 'kb-ask.mjs')]);
  ok('挂载自检：inject 声明在位、语法可解析');
  console.log('\n必须完全退出并重启 DSH（同进程会复用缓存的旧模块），然后群里 /presetlist → /preset kb-qa → /new → 提问。');
}

async function cmdVerify() {
  const cfg = load();
  const db = dbPath(cfg);
  const env = { ...process.env, KB_ASK_DB: db || '', KB_ASK_TITLE: cfg.title, KB_ASK_CATEGORY: cfg.category };
  execFileSync(process.execPath, [join(ROOT, 'test-kb-ask.mjs')], { env, stdio: 'inherit' });
  const host = await probeHost();
  if (host) {
    const res = await fetch(`http://127.0.0.1:${host.port}/api/kb/search?q=${encodeURIComponent('宿舍')}`);
    const body = JSON.parse(await res.text());
    ok(`宿主检索连通：q=宿舍 matched=${body.matched}`);
  } else console.log('! 未探到宿主端口，跳过线上连通检查');
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
else console.log(`用法：node kbctl.mjs <doctor|init|import|status|install|verify> [参数]

  doctor              环境体检：harness 根、知识库、宿主端口、预设是否已装
  init  --title --category   写本站配置（换文档就改这里）
  import <路径...>     走宿主 /api/kb/import 导入 PDF/MD，按配置归到本站分类
  status              条目清单与全量投喂判断
  prune --source <f>  删除该来源文件的条目（同名重导会追加，需先清后导）
  build [--apply]     以 docs/ 为真源重建库；不带 --apply 只做漂移体检，不动数据
  ship  [--apply]     build → verify → install 一条龙；不带 --apply 全程演练
  install [--root] [--dry-run]  渲染并安装预设（kb-ask.mjs 单一来源，不复制第二份）
  verify              47 例回归 + 挂载自检 + 宿主连通`);
