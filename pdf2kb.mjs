#!/usr/bin/env node
// pdf2kb — 把 PDF 转成"每个文件≈一个干净切块"的 markdown 批次，绕开 dsh-knowledge-base
// 的两条切块规则：CHUNK_MAX=2000（无 markdown 标题时按长度硬切）与
// MIN_CHUNK=600（小于它的相邻块会被合并，上限 2*CHUNK_MAX）。
//
// 用法: node pdf2kb.mjs <pdf路径> <输出目录> [每块目标字数=1200]
// 之后对每个产出的 .md 调 kb_import（或 POST /api/kb/import）。
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

const [src, outDir, targetArg] = process.argv.slice(2);
if (!src || !outDir) { console.error('用法: node pdf2kb.mjs <pdf> <outdir> [目标字数]'); process.exit(2); }
const TARGET = Number(targetArg) || 1200;
const MAX = 1800;                       // 留余量，确保合并后仍 < CHUNK_MAX*2 且单块可读

const pt = spawnSync('pdftotext', ['-enc', 'UTF-8', src, '-'], { encoding: 'utf8', maxBuffer: 64 << 20 });
if (pt.status !== 0) { console.error('pdftotext 失败:', pt.stderr?.slice(0, 300)); process.exit(1); }
const raw = pt.stdout;
const nonSpace = raw.replace(/\s+/g, '').length;
if (nonSpace < 40) {
  console.error(`!! 只提取到 ${nonSpace} 个非空白字符 —— 这几乎肯定是扫描版（图片）PDF，pdftotext 与 pdfjs 都拿不到文字，需要先 OCR。`);
  process.exit(3);
}

const stem = basename(src).replace(/\.pdf$/i, '');
const lines = raw.split('\n').map((l) => l.replace(/\ufeff|\f/g, '').trim()).filter(Boolean);

// 识别"条目级"标题：FAQ、章节、编号小节。pdfjs 兜底时也可用同一条正则。
const HEAD = /^(Q\d+[.、．]|[一二三四五六七八九十]+[、.]|第\s*[0-9一二三四五六七八九十]+\s*[章节部分篇]|[0-9]+(?:\.[0-9]+){0,2}[\s、.]|[0-9]+[)）])/;
const items = [];                        // { head, body }
let cur = { head: null, body: [] };
for (const t of lines) {
  if (HEAD.test(t)) {
    if (cur.body.length || cur.head) items.push(cur);
    cur = { head: t, body: [] };
  } else {
    const last = cur.body[cur.body.length - 1];
    if (last !== undefined && /[，、；：（)）]$|[\u4e00-\u9fa5]$/.test(last) && !/[.。!?]$/.test(last)) {
      cur.body[cur.body.length - 1] = last + t;                 // 还原被换行打断的句子
    } else cur.body.push(t);
  }
}
if (cur.body.length || cur.head) items.push(cur);

// 打包成文件：累计到 ~TARGET 就切一刀，绝不超过 MAX。
const packs = [];
let pack = { title: items[0]?.head ?? stem, parts: [], len: 0 };
for (const it of items) {
  const text = (it.head ? `## ${it.head}\n` : '') + it.body.join('\n');
  if (pack.len > 0 && pack.len + text.length > TARGET) { packs.push(pack); pack = { title: it.head ?? stem, parts: [], len: 0 }; }
  pack.parts.push(text); pack.len += text.length + 2;
}
if (pack.parts.length) packs.push(pack);

mkdirSync(outDir, { recursive: true });
const made = [];
packs.forEach((p, i) => {
  const n = String(i + 1).padStart(2, '0');
  const md = `${stem} · ${p.title.replace(/^##\s*/, '').slice(0, 40)}（第 ${i + 1}/${packs.length} 部分）\n\n${p.parts.join('\n\n')}\n`;
  const file = join(outDir, `${stem}.${n}.md`);
  writeFileSync(file, md);
  made.push({ file, chars: md.length });
});
console.log(`源: ${src}\n非空白字符 ${nonSpace}，条目 ${items.length} 个，产出 ${made.length} 个文件（目标每块 ~${TARGET} 字）`);
for (const m of made) console.log(`  ${m.chars}字  ${m.file}`);
console.log('\n下一步：对每个文件调 kb_import（path=该文件, category=你的分类）。');
