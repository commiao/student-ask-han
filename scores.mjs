// 分数分布探针：把每个问题在打分式里跑出 top 分数，用来定"条目级分数地板"。
// 地板必须落在"真在范围内的题的最低分"和"假阳性题的最高分"之间——没有这张表就不能拍值。
import { defaultDb, workspacePlugin } from './test-paths.mjs';

const target = workspacePlugin();
process.env.KB_ASK_DEBUG_SCORES = '1';
const { apply } = await import(`file://${target}`);
const DB = defaultDb();
if (!DB) throw new Error('定位不到 kb.sqlite；请设置 DSH_HOME 或 KB_ASK_DB');
let tool = null;
apply({ logger: { warn: () => {} }, tools: { register: (d) => { tool = d; } } },
  { db: DB, refusal: '该问题超出范围了，请联系管理员', docTitle: '电子信息工程学院新生必备指南', category: '新生指南' });

const IN = [
  ['宿舍晚上断电吗', 'Q20'], ['缴费用什么卡', 'Q37'], ['什么时候开学', 'Q1'], ['床多大', 'Q27'],
  ['门禁几点', 'Q21'], ['军训时间是什么时候', 'Q28'], ['宿舍有空调吗', 'Q14'], ['报到需要带什么材料', 'Q3'],
  ['学校有几个食堂', 'Q31'], ['奖助学金申请要求是什么', 'Q37'], ['不参加军训可以吗', 'Q30'],
  ['快递地址怎么填', 'Q12'], ['宿舍 插座', 'Q26'], ['住宿费用多少', 'Q36'],
  ['是用中国银行的卡吗', 'Q37'], ['什么时候交住宿费', 'Q36'], ['报到时间是几点', 'Q1'],
];
const OUT = [
  ['学校就业率多少', null], ['挂科了怎么办', null], ['今天北京天气怎么样', null], ['爱因斯坦哪年生的', null],
  ['学校历史有多久', null], ['重庆洪崖洞怎么走', null], ['宿舍wifi密码是多少', null],
  ['食堂饭卡余额怎么查', null], ['学校距离市区多远', null], ['附近哪里好玩', null],
  ['学校奖学金评定标准是什么', null], ['军训要多少钱', null], ['宿舍能不能养宠物', null],
  ['期末考试难不难', null], ['学校有健身房吗', null], ['食堂饭菜好吃吗', null],
];

const run = async (q) => {
  const text = await tool.execute({ question: q, asker: '探针' });
  const head = text.split('\n')[0];
  const m = /scores: (.*)/.exec(text);
  const parts = (m?.[1] ?? '').split(' | ').map((s) => {
    const mm = /(.+)=([\d.\-]+)/.exec(s);
    return mm ? { label: mm[1], score: Number(mm[2]) } : null;
  }).filter(Boolean);
  return { head, top: parts[0] ?? null, parts };
};

const fmt = async (arr, kind) => {
  console.log(`\n=== ${kind}（top 分数从高到低）===`);
  const rows = [];
  for (const [q, want] of arr) {
    const r = await run(q);
    rows.push({ q, want, verdict: r.head, top: r.top, second: r.parts[1] ?? null });
  }
  rows.sort((a, b) => (b.top?.score ?? -99) - (a.top?.score ?? -99));
  for (const r of rows) {
    const label = r.top ? r.top.label : '(无)';
    const hit = r.want ? (label.includes(r.want) ? '命中' : '错项') : '';
    console.log(`${(r.top?.score ?? NaN).toFixed(2).padStart(6)}  ${kind === 'IN' ? hit.padEnd(4) : ''.padEnd(4)} ${label.padEnd(10)} ${String(r.top?.score === undefined ? '' : '').padEnd(0)}${r.q}`);
    if (r.second) console.log(`          ↳ 次条 ${r.second.label}=${r.second.score.toFixed(2)}  verdict=${r.verdict}`);
  }
  return rows;
};

const inRows = await fmt(IN, 'IN');
const outRows = await fmt(OUT, 'OUT');
const inMin = Math.min(...inRows.filter((r) => r.verdict === 'ANSWER').map((r) => r.top.score));
const outMax = Math.max(...outRows.filter((r) => r.verdict === 'ANSWER').map((r) => r.top.score ?? -99));
console.log(`\nANSWER 的 in 组最低 top = ${inMin.toFixed(2)}`);
console.log(`漏网的 out 组（被判 ANSWER）最高 top = ${outMax.toFixed(2)}`);
console.log(`可用地板区间：(${outMax.toFixed(2)}, ${inMin.toFixed(2)}]  ${outMax < inMin ? '← 存在干净间隔' : '← 无干净间隔，打分式不可分'}`);
console.log(`误放条数：${outRows.filter((r) => r.verdict === 'ANSWER').length} / ${OUT.length}`);
console.log(`错项条数：${inRows.filter((r) => r.want && !r.top?.label.includes(r.want)).length} / ${IN.length}`);
