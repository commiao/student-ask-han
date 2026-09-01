# student-ask-han

面向 QQ 群新生答疑的**闭卷知识库问答机器人**：只回答知识库中已导入的内容，越界问题一律回固定话术，不做闲聊、不用外部知识、不做归类推断。

判定逻辑与提示词都以「可审计、可复现」为目标——召回失败要能被脚本量化，而不是靠肉眼聊天发现。

## 目录结构

| 路径 | 作用 |
|---|---|
| `preset-kb-qa/` | 交付物三件套：`preset.yml` + `agent.cordis.yml` + `kb-ask.mjs`，装进 `<harness>/.agent-presets/kb-qa/` |
| `station/` | 知识库站点维护工具：`kbctl.mjs`（import / prune / doctor / search）与 `station.json`、`agent.cordis.yml.tpl` |
| `out/` | 知识库正文（新生手册拆分出的 6 个 markdown 条目），是 `dist/kb.sqlite` 的上游 |
| `deploy/` | 跨机部署说明与安装脚本（`DEPLOY.md`、`install-kb-qa.sh`、`install-kb-qa.ps1`） |
| `recall.mjs` | 召回回归 + 负例门禁：合并读下面两份正例集，断言 `kb_ask` 的 top1 命中；再逐条跑负例集 |
| `cases.gen.json` | 正例·基线：`node gen-cases.mjs` 从库内 37 条 Q 标题**规则机械派生**（157 例），可复现、可 diff、换文档自动跟随 |
| `cases.human.json` | 正例·补充：模型手写的 5 轴口语变体（简称 / 错别字 / 倒装 / 否定式 / 近义换词，185 例），不可复现，只能人工维护 |
| `cases.neg.md` | 负例：行首不带 `?` 的每一条必须 REFUSE（出现 ANSWER 即假阳性、退出码非 0）；`? ` 开头的是诊断项，交人判读 |
| `scores.mjs` / `validate.mjs` / `probe-*.mjs` | 打分与探针脚本，用于对比预设改动前后的行为（`probe3.mjs` 拿多个引擎版本跑同一批越界问句，做误放归因） |
| `test-kb-ask.mjs` | 端到端自测 |
| `pdf2kb.mjs` / `mkdist.mjs` | 源文档 → 知识库条目 → 单文件分发件（`VACUUM INTO`） |
| `FIXPLAN.md` | 待修缺陷清单（含实测记录） |

## 前置条件

- Node ≥ 22.5（`kb-ask.mjs` 直接用 `node:sqlite` 只读打开库文件，不依赖额外插件）
- 一个已接入 QQ 群的 DSH 实例（IM 桥为 `@xmanrui/dsh-im`）

## 快速上手

打包知识库：

```sh
node mkdist.mjs          # → dist/kb.sqlite
```

在目标机安装预设：

```sh
bash deploy/install-kb-qa.sh                          # macOS / Linux
powershell -ExecutionPolicy Bypass -File deploy\install-kb-qa.ps1   # Windows
```

安装脚本会自检两件事：`kb-ask.mjs` 里有 `export const inject = ['tools']`、roster 里有 `kb-ask` 行。缺 `inject` 会让 `apply()` 在挂载期抛 `cannot get property "tools" without inject`，最终在 QQ 里只表现为一句 `PRESET_UNAVAILABLE`，看不到真正原因。

完整部署流程（含 IM 配置、群聊上下文增强开关）见 [`deploy/DEPLOY.md`](deploy/DEPLOY.md)。

## 验证

改判定逻辑（门禁、打分、别名）前后都要跑这四条，缺一条码不准"没退化"：

```sh
node --check preset-kb-qa/kb-ask.mjs            # 语法
KB_ASK_TARGET=workspace node test-kb-ask.mjs    # 端到端 55 例 + 引用形状/固定话术断言
node recall.mjs                                 # 正例 337 例（两份用例集合并去重）+ 硬负例 66 条
node scores.mjs                                 # in/out 两组 topScore 分布：误放 0、错项 0
```

全绿的形状是：`55/55` → `miss: 0` + `硬负例 66 条：误放 0` → `误放条数：0 / 16　错项条数：0 / 17`。
`recall.mjs` 退出码非 0 就是没通过（1 = 有 miss 或负例误放；2 = 用例集缺文件、不合契约或与库条目对不上）。

两条维护纪律，都是踩过坑写下来的：

- **正例集是两个文件，不许合并成一个名字。** 规则派生那份（`cases.gen.json`）由 `node gen-cases.mjs`
  重生成、覆盖写它自己；模型手写那份（`cases.human.json`）只有人工能改。同写一个名字会互相覆盖——
  已经因此整轮丢过一次工作。`recall.mjs` 少任一份直接 exit 2，不降级跑。
- **每加一行 `ALIASES` / `DOMAIN_GATES` / `INTENT_PATTERNS`，先在 `cases.neg.md` 补一条打在它身上的负例。**
  别名是子串匹配、覆盖率只看二元组，无条件展开的泛词会把越界问句抬进范围内（实测
  `校门口打车好打吗` 靠 `门口→北门/西门/小吃铺` 零原话词命中被判 ANSWER）。
  阈值方向只允许朝"误拒"校准：`KB_ASK_GRAM_MIN`（现 0.5）不许为了少几条 miss 往下调。

## 未纳入版本控制的内容

`.gitignore` 排除了构建产物与本地状态：`dist/`、`*.sqlite`、`.bak/`、`.dsh/`、`node_modules/`，以及原始输入 `src.pdf`。

`dist/kb.sqlite` 由 `node mkdist.mjs` 从本地知识库重新导出即可，无需入库；换文档时的正确流程是改 `out/` 下的条目再重新导出。
