# student-ask-han

面向 QQ 群新生答疑的**闭卷知识库问答机器人**：只回答知识库中已导入的内容，越界问题一律回固定话术，不做闲聊、不用外部知识、不做归类推断。

判定逻辑与提示词都以「可审计、可复现」为目标——召回失败要能被脚本量化，而不是靠肉眼聊天发现。

## 目录结构

| 路径 | 作用 |
|---|---|
| `preset-kb-qa/` | 交付物三件套：`preset.yml` + `agent.cordis.yml` + `kb-ask.mjs`，装进 `<harness>/.agent-presets/kb-qa/` |
| `station/` | 知识库站点维护工具 `kbctl.mjs`：`doctor` / `ship`（一条龙，先出计划）/ `build --apply`（按 docs/ 重建库）/ `install` / `verify` / `status`，配置在 `station.json` + `agent.cordis.yml.tpl` |
| `out/` | **知识库正文的唯一真源**（新生手册拆分出的 6 个 markdown 条目）；`kbctl.mjs build` 的 docs 目录默认就是它（`station.json` 未设 `docs` 时取 `out/`，`station/docs/` 里只有一个冒烟条目）。同时是 `dist/kb.sqlite` 的上游 |
| `deploy/` | 跨机部署说明与安装脚本（`DEPLOY.md`、`install-kb-qa.sh`、`install-kb-qa.ps1`） |
| `recall.mjs` | 三道门禁合一：正例（合并读下面两份正例集，断言 top1 命中）+ 负例（逐条跑 `cases.neg.md`）+ 别名对账 |
| `cases.gen.json` | 正例·基线：`node gen-cases.mjs` 从库内 37 条 Q 标题**规则机械派生**（157 例），可复现、可 diff、换文档自动跟随 |
| `cases.human.json` | 正例·补充：模型手写的 5 轴口语变体（简称 / 错别字 / 倒装 / 否定式 / 近义换词，185 例）+ 少量"防误伤"用例，不可复现，只能人工维护 |
| `cases.neg.md` | 负例 96 条硬门禁 + 诊断项 5 条（现出 ANSWER 的 2 条只报 `???`、不判失败）：行首不带 `?` 的每一条必须 REFUSE（出现 ANSWER 即假阳性、退出码非 0）；小节标题点了 `xxx-gate` 的还核对拦截层 |
| `alias-audit.mjs` | 别名表 ↔ 文档词表对账（被 `recall.mjs` 调用）：展开词在库里一个字都没有 = 死别名；出现在 ≥2/3 条目又无条件 = 放行面。两者都判失败 |
| `scores.mjs` / `validate.mjs` / `probe-*.mjs` | 打分与探针脚本，用于对比预设改动前后的行为（`probe3.mjs` 拿多个引擎版本跑同一批越界问句，做误放归因；`validate.mjs` 查三件套硬不变量） |
| `kb-health.mjs` | **只读**体检（不碰判定逻辑）：库 payload ↔ `out/*.md` 逐文件 sha 对账、`docs` 之外的来源报警（界面直导的漏网条目）、FTS 索引层幽灵条目探针。`KB_HEALTH_DB=<path>` 可指定库。**删过条目、或怀疑有人绕过 docs 导入，先跑它** |
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
node recall.mjs                                 # 正例 340 例（两份用例集合并去重）+ 硬负例 96 条 + 别名对账
node scores.mjs                                 # in/out 两组 topScore 分布：误放 0、错项 0
```

装完之后把 `KB_ASK_TARGET=workspace` 换成 `installed`（或直接 `node station/kbctl.mjs verify`，它两条都跑），
验的就是 `.agent-presets` 里那份而不是工作区那份。再加一条三件套自检：

```sh
node validate.mjs            # 工作区；node validate.mjs installed 查已装的那份
```

全绿的形状是：`55/55` → `miss: 0` + `硬负例 96 条：误放 0` + `别名 113 条：致命 0` → `误放条数：0 / 16　错项条数：0 / 17`。
`recall.mjs` 退出码非 0 就是没通过（1 = miss / 负例误放 / 固定话术变形 / 别名失效；2 = 用例集缺文件、不合契约或与库条目对不上）。

### 按场景选命令

| 场景 | 跑什么 | 只看哪一行 |
|---|---|---|
| 改完门禁/打分/别名，确认没改坏 | 上面四条（`--check` → `test-kb-ask` → `recall` → `scores`） | `recall` 最后一行中文 |
| 只想知道越界问句会不会拿高分 | `node scores.mjs` | `误放条数：0 / 16`、`in 组最低 top`（现 2.63） |
| 装到线上，验**已安装那份** | `node validate.mjs installed` + `KB_ASK_TARGET=installed node recall.mjs`，或一把 `cd station && node kbctl.mjs verify` | 同上；两份哈希还得一致（`shasum` 比 `preset-kb-qa/kb-ask.mjs` 与 `.agent-presets/kb-qa/kb-ask.mjs`） |
| 换手册 / 重新导入文档 | `cd station && node kbctl.mjs build --apply` → `node gen-cases.mjs` → `node recall.mjs` | 别名对账**会成批报警**，那是预期，逐条按新文档重写 `ALIASES`。**前置：宿主 API 得通**（`doctor` 要打出 `✓ 宿主 API`；401/探不到端口时这条链整体不可用，见 FIXPLAN G-4） |
| 删过条目、或怀疑有人绕过 docs 从界面直接导入 | `node kb-health.mjs`（只读） | `内容层：与 docs 一致 ✓` + `幽灵 rowid：无`。有非 `.md` 来源或 `docs` 之外的条目 = 有人从界面导了东西，重建会静默丢 |
| 群里"该答的没答 / 不该答的答了"，要定位哪一层拦的 | `KB_PEEK_RAW=1 node peek.mjs '<问题>'` | `via:` = 哪个门禁拦的；`tried:` = 试过哪些检索词；检索门禁那条没有 `via:` 行 |
| 想看打分怎么算的（调阈值前的取证） | `KB_ASK_DEBUG_SCORES=1 KB_PEEK_RAW=1 node peek.mjs '<问题>'` | 末尾 `scores: 第N条 Qn=分值` |
| 两个版本引擎逐条比行为差异 | `node probe-compare.mjs` | `verdict 翻转 N，拦截层变更 N，引用条目变化 N` |
| 只想快速扫一遍负例有没有误放 | `node probe-neg.mjs` | `异常 0 条` |
| 三件套自身坏没坏（roster / inject / 话术逐字 / persona） | `node validate.mjs`（`installed` 参数查线上那份） | `三件套自检全过。` |

`peek.mjs` 默认只印 `reply:` 正文（核对引用标号背后的原文）；加 `KB_PEEK_RAW=1` 才印模型收到的
整串原文。用它传中文问题是安全的——那是你自己终端里的事；**但别在自动化脚本里把 CJK 拼进 shell
命令串**：本仓库的持久 shell 实测会把中文参数打断（已踩过三次，见 FIXPLAN）。

三份用例怎么配合读：`cases.gen.json` 154 问句（37 条目 × 6 轴，**派生物，别手改**）＋
`cases.human.json` 186 问句（简称/错别字/倒装/否定式/近义换词 + 防误伤，**唯一不可再生的资产**）
= 340 → `recall.mjs` 合并去重成 339 条用例 → 其中 1 条标"歧义"只登记不入门禁 → 打印 `门禁内 338`。
`cases.neg.md` 里 `- ` 开头必须拦住，`- ? ` 开头是诊断项（答了只报 `???` 不判失败）。

三条维护纪律，都是踩过坑写下来的：

- **正例集是两个文件，不许合并成一个名字。** 规则派生那份（`cases.gen.json`）由 `node gen-cases.mjs`
  重生成、覆盖写它自己；模型手写那份（`cases.human.json`）只有人工能改。同写一个名字会互相覆盖——
  已经因此整轮丢过一次工作。`recall.mjs` 少任一份直接 exit 2，不降级跑。
- **每加一行 `ALIASES` / `DOMAIN_GATES` / `INTENT_PATTERNS`，先在 `cases.neg.md` 补一条打在它身上的负例。**
  别名是子串匹配、覆盖率只看二元组，无条件展开的泛词会把越界问句抬进范围内（实测
  `校门口打车好打吗` 靠 `门口→北门/西门/小吃铺` 零原话词命中被判 ANSWER）。
  这条纪律现在有机检：`alias-audit.mjs` 会把"展开词不在库里"和"≥2/3 条目的泛词无条件展开"直接判失败。
  阈值方向只允许朝"误拒"校准：`KB_ASK_GRAM_MIN`（现 0.5）不许为了少几条 miss 往下调。
- **换文档 = 换 `station/docs/` + `station.json` 再 `node kbctl.mjs build --apply`，不是改代码。**
  但换完必须预期"别名对账"成批报错：`ALIASES` 的展开词全是照着**这一份**文档挑的，换手册后它们
  多数会变成死别名或泛词——那正是它该拦下来的时刻，逐条按新文档重写，别顺手放宽判据。

## 未纳入版本控制的内容

`.gitignore` 排除了构建产物与本地状态：`dist/`、`*.sqlite`、`.bak/`、`.dsh/`、`node_modules/`，以及原始输入 `src.pdf`。

`dist/kb.sqlite` 由 `node mkdist.mjs` 从本地知识库重新导出即可，无需入库；换文档时的正确流程是改 `out/` 下的条目再重新导出。
