// 别名表 ↔ 文档词表 对账（第 4 轮 ①）
//
// 为什么需要它：ALIASES 是子串匹配 + 二元组覆盖率的组合，一条展开词只要**不在当前文档里**
// 就永远不产生命中（死别名，白占维护成本），而一条**太泛**的展开词（半数以上条目里都有）
// 会把越界问句抬进范围内。第 3 轮两次都是靠肉眼看负例才发现的：
//   `门口→北门/西门/小吃铺` 无条件展开 → `校门口打车好打吗` 零原话词命中却判 ANSWER
//   `被褥→床上/生活用品/自带/学生` 无条件展开 → `被褥不好用能退吗` 被判 ANSWER
// 换一份手册时，这两类失效会**成批**出现而所有测试照样绿——所以把它做成门禁。
//
// 口径必须与引擎一致：引擎 idsForTerm() 是在 kb 表的 name/summary/payload/tags 四列上做子串匹配，
// 所以语料 = 这四列拼起来、转小写、去空白；df 按条目（行）数算。
import { readFileSync } from 'node:fs';

/** 从引擎源码里取 ALIASES 字面量。改形状（换变量名/换成对象）会直接炸，不会静默跳过。 */
export function extractAliases(file) {
  const src = readFileSync(file, 'utf8');
  const i = src.indexOf('const ALIASES = [');
  if (i < 0) throw new Error(`${file} 里找不到 const ALIASES = [ —— 别名表改形状了？对账脚本要跟着改。`);
  const j = src.indexOf('\n];', i);
  if (j < 0) throw new Error(`${file} 的 ALIASES 数组没有正常结尾（\\n];）`);
  const lit = src.slice(i + 'const ALIASES = '.length, j + 2);
  const table = eval(lit);   // 只跑本仓自己那份字面量；形状变了上面两步就会炸
  if (!Array.isArray(table)) throw new Error('ALIASES 求值结果不是数组');
  return table;
}

export function normalize(s) {
  return String(s).toLowerCase().replace(/\s+/g, '');
}

/**
 * @param entries ALIASES 数组
 * @param rows    库内条目：[{ text }]，text 已 normalize
 * @returns {{report:string[], fails:string[], warns:string[], notes:string[]}}
 *   fails 进退出码；warns 值得看一眼；notes 只是给维护者的说明（key 本身已是文档原词），不单独刷屏。
 */
export function auditAliases(entries, rows) {
  const corpus = rows.map((r) => r.text).join('\u0000');
  const half = Math.ceil(rows.length / 2);
  // 分档口径：df=0 是**确定的**维护债（永远不产生命中）→ 致命；
  // 出现在 ≥2/3 条目又无条件 = 真正的放行面（第 3 轮 `门口`/`被褥` 就是这个形状）→ 致命；
  // 只到 ≥1/2 的算"要盯着"→ 告警，因为它可能只是这份小库里的正常主题词。
  const broad = Math.ceil((rows.length * 2) / 3);
  const report = [];
  const fails = [];
  const warns = [];
  const notes = [];
  for (const [key, subs, cond] of entries) {
    if (typeof key !== 'string' || !Array.isArray(subs)) {
      fails.push(`形状不合：${JSON.stringify(key)} 不是 [key, [subs], 可选条件]`);
      continue;
    }
    const condTxt = cond ? ` 条件 ${String(cond)}` : ' 无条件';
    for (const sub of subs) {
      const n = normalize(sub);
      const df = rows.filter((r) => r.text.includes(n)).length;
      if (df === 0) {
        fails.push(`死别名 ALIASES['${key}'] → '${sub}' 在库里一个字都没有${condTxt}`);
      } else if (df >= broad && !cond) {
        fails.push(`泛词无条件展开 ALIASES['${key}'] → '${sub}' 出现在 ${df}/${rows.length} 个条目里${condTxt}`
          + ' —— 必须给它加第三元素条件正则，或换成只在目标条目出现的词');
      } else if (df >= half) {
        warns.push(`高覆盖词 '${key}'→'${sub}'（${df}/${rows.length}）${condTxt}`);
      }
    }
    if (normalize(key) && rows.some((r) => r.text.includes(normalize(key)))) {
      notes.push(`'${key}'`);
    }
    report.push(`'${key}' → [${subs.join(', ')}]${condTxt}`);
  }
  return { report, fails, warns, notes };
}
