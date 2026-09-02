import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));

export function harnessRoots(env = process.env) {
  const home = env.HOME || env.USERPROFILE || '';
  const appdata = env.APPDATA || '';
  return [
    env.DSH_HOME,
    appdata && join(appdata, 'dsh-desktop', 'harness'),
    home && join(home, 'Library', 'Application Support', 'dsh-desktop', 'harness'),
    home && join(home, '.config', 'dsh-desktop', 'harness'),
    home && join(home, '.dsh'),
  ].filter(Boolean);
}

export function workspacePlugin() {
  return join(PACKAGE_ROOT, 'preset-kb-qa', 'kb-ask.mjs');
}

export function installedPlugin(env = process.env) {
  if (env.KB_ASK_INSTALLED) return env.KB_ASK_INSTALLED;
  if (env.DSH_HOME) return join(env.DSH_HOME, '.agent-presets', 'kb-qa', 'kb-ask.mjs');
  const candidates = harnessRoots(env).map((root) =>
    join(root, '.agent-presets', 'kb-qa', 'kb-ask.mjs'));
  return candidates.find(existsSync) || candidates[0] || null;
}

export function defaultDb(env = process.env) {
  if (env.KB_ASK_DB) return env.KB_ASK_DB;
  if (env.DSH_HOME) return join(env.DSH_HOME, 'knowledge-base', 'kb.sqlite');
  const candidates = harnessRoots(env).map((root) => join(root, 'knowledge-base', 'kb.sqlite'));
  return candidates.find(existsSync) || candidates[0] || null;
}

export function targetPlugin(which, env = process.env) {
  if (which === 'workspace') return workspacePlugin();
  if (which === 'installed') return installedPlugin(env);
  throw new Error(`未知 KB_ASK_TARGET: ${which}（应为 workspace 或 installed）`);
}
