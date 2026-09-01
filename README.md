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
| `recall.mjs` / `cases.gen.json` / `cases.neg.md` | 召回回归：37 个条目 × 5 种口语变体（简称 / 错别字 / 倒装 / 否定式 / 近义换词），断言 `kb_ask` 的 top1 命中 |
| `scores.mjs` / `validate.mjs` / `probe-*.mjs` | 打分与探针脚本，用于对比预设改动前后的行为 |
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

```sh
node test-kb-ask.mjs     # 端到端自测
node recall.mjs          # 召回回归（含否定式越界用例）
```

## 未纳入版本控制的内容

`.gitignore` 排除了构建产物与本地状态：`dist/`、`*.sqlite`、`.bak/`、`.dsh/`、`node_modules/`，以及原始输入 `src.pdf`。

`dist/kb.sqlite` 由 `node mkdist.mjs` 从本地知识库重新导出即可，无需入库；换文档时的正确流程是改 `out/` 下的条目再重新导出。
