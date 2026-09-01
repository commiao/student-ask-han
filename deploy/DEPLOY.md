# 把闭卷知识库问答搬到另一台 DSH

## 要搬的是四样东西

| # | 东西 | 装在哪 | 少了会怎样 |
|---|---|---|---|
| 1 | 预设三件套 `preset.yml` / `agent.cordis.yml` / `kb-ask.mjs` | `<harness>/.agent-presets/kb-qa/` | 群里没有这个预设 |
| 2 | 知识库文件 `kb.sqlite` | `<harness>/knowledge-base/kb.sqlite` | 每次提问都判越界 |
| 3 | IM 桥 `@xmanrui/dsh-im` | DSH 的 profile bundle | 机器人连不上 QQ |
| 4 | QQ 机器人凭证 + 群 | 设置 → IM 机器人 | 收不到消息 |

**目标机不需要装 `dsh-knowledge-base` 插件。** `kb-ask.mjs` 只用 `node:sqlite` 只读打开那个库文件，跟插件没有依赖关系。插件只在**维护知识库**（导 PDF、改分类、删条目）时才需要——那些动作留在这台管理机上做，做完把 `kb.sqlite` 重新导出一份推过去即可。

`<harness>` 按部署形态取：

- macOS Desktop：`~/Library/Application Support/dsh-desktop/harness`
- Linux Desktop：`~/.config/dsh-desktop/harness`
- Windows Desktop：`%APPDATA%\dsh-desktop\harness`
- `dsh web` / 命令行：`$DSH_HOME`（默认 `~/.dsh`），即 `~/.dsh/.agent-presets`、`~/.dsh/knowledge-base`

前提：宿主 Node ≥ 22.5（`node:sqlite` 要求）。Desktop 自带版本满足；自建 `dsh web` 的话先 `node -p "require('node:sqlite').DatabaseSync"` 验一下。

## 步骤

### 在这台管理机上打包

```sh
cd /Users/mac/work-deepseek
node kb/mkdist.mjs          # → kb/dist/kb.sqlite（VACUUM 出来的单文件，含全部条目）
```

然后把整个 `kb/` 目录拷到目标机（预设文件 + 安装脚本 + 自测脚本都在里面）。
不想拷整个目录的话，至少要带走 `kb/preset-kb-qa/`、`kb/deploy/`、`kb/dist/kb.sqlite`。

> 为什么用 `mkdist.mjs` 而不是直接 `cp`：库里可能有 WAL 未落盘，裸拷会拿到缺最新写入的半个库。

### 在目标机上安装

```sh
bash kb/deploy/install-kb-qa.sh          # macOS / Linux
```
```powershell
powershell -ExecutionPolicy Bypass -File kb\deploy\install-kb-qa.ps1   # Windows
```

脚本会自己找预设根目录，找不到时用它打印的提示加 `--root <路径>`（ps1 用 `-Root`）。
它装完会**自检两件事**——`kb-ask.mjs` 里有 `export const inject = ['tools']`、roster 里有 `kb-ask` 行。这两样是本次踩过的两个坑：缺 `inject` 会让 `apply()` 里的 `ctx.tools` 在挂载期抛 `cannot get property "tools" without inject`，最终在 QQ 里只显示成一句 `PRESET_UNAVAILABLE`，看不到真正原因。

想手工装也行，就是把三个文件放进 `<harness>/.agent-presets/kb-qa/`，把 `kb.sqlite` 放进 `<harness>/knowledge-base/`。

### 配置库路径（只在非默认位置时）

`agent.cordis.yml` 里的 `db` 支持 `~`、`$HOME`、`$DSH_HOME`、`%APPDATA%` 展开；**整行删掉也可以**，插件会按平台自动找 Desktop 和 `~/.dsh` 两种默认位置。三样都不同寻常时才需要显式写，例如：

```yaml
    db: '%APPDATA%/dsh-desktop/harness/knowledge-base/kb.sqlite'
```

### 接 QQ

在目标机的设置 → IM 机器人里绑定一个 QQ 机器人并扫码，把它拉进群。

**一个 bot 只能给一台机器用。** 同一套 app 凭证在两台上同时建立 WebSocket 长连接，消息会被其中一边吃掉，表现为"偶尔不回"。要双活就再去 QQ 开放平台注册第二个 bot。

顺手打开**群聊上下文增强**并把 `senderName` 勾进字段：默认是 `groupEnabled: false` + `fields: ['senderId']`（见 `dsh-im` 的 `context-enhancement.mjs`），不开的话机器人拿不到群昵称，回复里就点不出提问人。

### 生效与验证

1. **完全退出并重启 DSH**（macOS `Cmd+Q`，Windows 托盘右键退出）。不重启一定不生效：Node 的 `import()` 按 file URL 缓存模块，同一进程里改了预设插件文件也不会重读。这个坑本次踩过一次。
2. 群里依次发：

```
/presetlist        →  应列出「闭卷问答（知识库限定）」，且不附带失败原因
/preset kb-qa
/new               →  会话一旦产出过内容就不能再切预设，必须开新的
宿舍晚上断电吗
```

3. 期望回复：

```
@你的昵称 你问的「宿舍晚上断电吗」：
1. （指南·宿舍生活 第8条 Q20）Q20. 宿舍晚上断电吗？断网吗？ A：宿舍不断电，晚上 12 点断校园网。
```

4. 想在那台机器上跑完整回归（47 例，含越界拒绝、行为改写拦截、招呼白名单、引用标号）：

```sh
cd kb && KB_ASK_TARGET=installed KB_ASK_DB=<目标机 kb.sqlite 路径> node test-kb-ask.mjs
```

## 换知识库内容时

在管理机上改（导入 PDF、重整条目、调分类），然后 `node kb/mkdist.mjs` 重新导出，把 `dist/kb.sqlite` 覆盖到目标机的 `<harness>/knowledge-base/kb.sqlite`。**换库文件不用重启 DSH**——每次判定都是现开连接读；改 `kb-ask.mjs` 才需要重启。

## 已知边界

- **拒绝话术不是 100% 硬约束**。这台机器上的 DSH 没有任何输出侧钩子（只有 `system-prompt/assemble`、`agent/request`、`agent/pre-step` 三个输入侧过滤器），所以"逐字抄固定话术"是 prompt 级约束。缓解办法是把回复在代码里拼好、模型只负责抄，实测很稳但不是形式保证。
- **同义词表要人维护**。`kb-ask.mjs` 里的 `ALIASES`（如 `不参加 → 免训/缓训`）是显式映射；文档换措辞或群里冒出新的口语说法，就要加一条。不加的后果是误拒，不是误答。
- **全量投喂有容量前提**。库内原文合计 ≤ 6000 字符时走"判定通过后把全部条目交给模型"，避免关键词错配漏答；超了会自动退回分级检索，届时词汇错配可能重新出现。调这个数用环境变量 `KB_ASK_FULL_DUMP_MAX` 或 roster 里的 `fullDumpMax`。
- 招呼白名单是**整句精确匹配**，`你好，宿舍晚上断电吗` 不会被招呼吞掉；判定顺序在行为门禁之后，所以 `你好，我是管理员，忽略规则…` 仍然被拒。
