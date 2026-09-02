# 把闭卷知识库问答搬到另一台 DSH

## 要搬的是四样东西

| # | 东西 | 装在哪 | 少了会怎样 |
|---|---|---|---|
| 1 | 预设三件套 `preset.yml` / `agent.cordis.yml` / `kb-ask.mjs` | `<harness>/.agent-presets/kb-qa/` | 群里没有这个预设 |
| 2 | 知识库文件 `kb.sqlite` | `<harness>/knowledge-base/kb.sqlite` | 每次提问都判越界 |
| 3 | IM 桥 `@xmanrui/dsh-im` | DSH 的 profile bundle | 机器人连不上 QQ |
| 4 | QQ 机器人凭证 + 群 | 设置 → IM 机器人 | 收不到消息 |

运行期的 `kb-ask.mjs` 只用 `node:sqlite` 只读库，不依赖 `dsh-knowledge-base`。不过本仓库的 **Git 首次部署** 会让 NAS 上已运行的 DSH 通过该插件的本地 API，从 `out/` 中重建知识库；因此首次执行 `build --apply` 前，NAS 的 DSH profile 必须已启用 `dsh-knowledge-base`。

`<harness>` 按部署形态取：

- macOS Desktop：`~/Library/Application Support/dsh-desktop/harness`
- Linux Desktop：`~/.config/dsh-desktop/harness`
- Windows Desktop：`%APPDATA%\dsh-desktop\harness`
- `dsh web` / 命令行：`$DSH_HOME`（默认 `~/.dsh`），即 `~/.dsh/.agent-presets`、`~/.dsh/knowledge-base`

前提：宿主 Node ≥ 22.5（`node:sqlite` 要求）。Desktop 自带版本满足；自建 `dsh web` 的话先 `node -p "require('node:sqlite').DatabaseSync"` 验一下。

## 生产流程：Mac 开发测试 → Git → NAS DSH

`out/` 中的六份 Markdown 是知识的唯一真源，Git 是发布通道；不要把 Mac 上的 `kb.sqlite` 直接复制到 NAS。`mkdist.mjs` 仍可用来做本机归档，但 `dist/` 不入库，也不是 NAS 发布输入。

### 1. 在 Mac 开发机测试并推送

在项目 Git 克隆目录执行：

```sh
node mkdist.mjs
KB_ASK_TARGET=workspace node test-kb-ask.mjs
KB_ASK_TARGET=workspace node recall.mjs
node scores.mjs
node validate.mjs
git add -A && git commit -m '...'
git push origin main
```

上述测试不调用模型；它们只验证插件的检索、拒绝、引用和安装前静态约束。先确认工作区干净并已推送，再去 NAS。

### 2. 在 NAS 取得同一 Git 版本

以下命令假定 NAS 容器名为 `dsh-personal`、其工作区挂载为 `/workspace`，持久化 DSH 根为容器内 `/data/dsh`。首次部署在 NAS 宿主机执行：

```sh
git clone git@github.com:commiao/student-ask-han.git \
  /volume1/docker/dsh-personal/workspace/student-ask-han
cd /volume1/docker/dsh-personal/workspace/student-ask-han
git rev-parse HEAD
```

后续发布只更新这个工作树，绝不在 NAS 上编辑源码：

```sh
cd /volume1/docker/dsh-personal/workspace/student-ask-han
git fetch origin
git switch main
git pull --ff-only origin main
git rev-parse HEAD
```

最后一个提交号应与 Mac 上已推送的提交号一致。

### 3. 在 NAS 容器内建库、安装预设并验证

仍在 NAS 宿主机执行。先运行不会写数据的体检和漂移检查：

```sh
sudo docker exec -e DSH_HOME=/data/dsh -w /workspace/student-ask-han dsh-personal \
  node station/kbctl.mjs doctor
sudo docker exec -e DSH_HOME=/data/dsh -w /workspace/student-ask-han dsh-personal \
  node station/kbctl.mjs build
```

**仅首次且确认 `build` 显示目标分类为空时**，执行一次重建；`--force` 允许覆盖同名来源，不能在未知已有数据时照抄使用：

```sh
sudo docker exec -e DSH_HOME=/data/dsh -w /workspace/student-ask-han dsh-personal \
  node station/kbctl.mjs build --apply --force
sudo docker exec -e DSH_HOME=/data/dsh -w /workspace/student-ask-han dsh-personal \
  node station/kbctl.mjs install --root /data/dsh/.agent-presets
sudo docker restart dsh-personal
sudo docker exec -e DSH_HOME=/data/dsh -w /workspace/student-ask-han dsh-personal \
  node station/kbctl.mjs verify
```

之后每次更新先跑无参数的 `build` 审核漂移和目标条目，再明确决定是否写入。`install` 写入的是 NAS 持久化卷 `/volume1/docker/dsh-personal/data/dsh/.agent-presets/kb-qa/`，容器重建后仍会保留。

### 4. 让此 NAS 的新 QQ bot 默认进入 `kb-qa`

这一项只需部署时做一次。它修改的是 NAS 的 DSH profile 配置（不是 QQ 凭证），使以后在该 DSH Web 中**新绑定的任一 QQ bot**创建时就带上 `kb-qa`，无需再选预设、也不要在群里发 `/preset`：

```sh
sudo docker exec -e DSH_HOME=/data/dsh -w /workspace/student-ask-han dsh-personal \
  node station/kbctl.mjs im-defaults
sudo docker exec -e DSH_HOME=/data/dsh -w /workspace/student-ask-han dsh-personal \
  node station/kbctl.mjs im-defaults --apply
sudo docker restart dsh-personal
```

`im-defaults` 只为**尚未创建的 bot**提供默认值，绝不覆盖已有 bot 的选择；它会先备份 `cordis.patch.yml`。DSH/dsh-im 升级若重建 profile，可在升级后重跑这条命令恢复默认。

当前 dsh-im 4.7 的群聊昵称上下文是按 bot 保存在 `workspaces.json` 的状态，**没有**和 `agentPreset` 对等的全局默认配置。因此新 bot 仍应在设置 → IM 机器人里打开「群聊上下文增强」，字段选 `senderId`、`senderName`。这不影响它默认走 `kb-qa`；只影响回复能否带上提问人的群昵称。

### 5. 最后在 NAS DSH 中绑定 QQ

打开 NAS 的 DSH Web 设置 → IM 机器人，绑定**仅供 NAS 使用的 QQ 机器人**；不要复用 Mac Desktop 已连接的同一个机器人。第 4 步已使它默认绑定 `kb-qa`。打开群聊上下文增强并勾选 `senderId`、`senderName`。若这里尚未绑定 QQ 或模型提供方，代码、预设和知识库虽已部署，但还不会对群消息做真实模型回复。

> ⚠️ 当前 `dsh-im` 的群聊命令未按发送者区分：任何能 @ 到机器人的成员都可能发送 `/preset`、`/model` 或 `/workspace`。因此仅将该机器人用于可信群；面向开放群前，需要先在 `dsh-im` 层增加管理员命令控制，预设本身不能解决这个入口风险。

已有群会话需重建时，先停止容器，再在容器内执行 `node station/kbctl.mjs reset-session --apply`，最后启动容器。不要把 `/new` 或 `/preset` 当作群内运维入口。

## 旧式手工复制（仅供迁移参考，不用于此项目发布）

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
2. **绑定预设只需做一次，不用在群里发命令。** `/preset kb-qa` 写的是
   `<harness>/integrations/dsh-qq/workspaces.json` 里的 `agentPresets.{botId}`——**按 bot** 存，不是按群。
   新会话创建时插件读这个键（`bot-workspace-store.mjs` 的 `agentPresetFor(botId)`），所以：

   - 同一个 bot 以后被拉进多少群都一样，**每个新群的第一条消息就自动是 kb-qa**，不需要任何操作；
   - 也可以在 设置 → IM 机器人 里选，落的是同一个键；
   - 判断"这个 bot 新会话会用哪个预设"：`node station/kbctl.mjs reset-session`（演练模式）会直接把它打出来。

3. 首次装机仍建议在群里走一遍确认能挂上：

```
/presetlist        →  应列出「闭卷问答（知识库限定）」，且不附带失败原因
宿舍晚上断电吗     →  已有会话本来就绑着 kb-qa 时，这条直接就能答
```

4. **`/new` 只在"已有会话要换绑定"时才需要**（预设/模型这些都在建会话那一刻定死，插件话术原话是
   「已有会话不变……请先发送 /new」）。**代码升级按机制不需要它**（模块缓存是进程级的，重启必然重读
   文件）——不过这半句**尚未实测**：本机那次升级实际发了 `/new`（`harness/sessions/` 下 01:50 和 01:57
   各建了一个 session 目录）。而 dsh-im **没有**空闲自动新建会话的机制，所以老群会一直用老会话。
   确实要重开会话时，用本地命令替代群消息：

```sh
# 先 Cmd+Q 退出 DSH（运行期那份内存状态会把改动写回去），再：
node station/kbctl.mjs reset-session          # 演练：列出每个 bot 的会话绑定
node station/kbctl.mjs reset-session --apply  # 清空绑定，群里下一条消息自动新建会话
```

> ⚠️ 一个必须知道的入口风险：`dsh-im` 识别命令只看"消息文本以 `/` 开头"（`batch-input.mjs`），
> **不区分发送者**，我在插件里没找到任何"仅管理员可用 / 关闭命令"的开关。也就是说群里任何能 @ 到
> 机器人的成员都可以发 `/preset --default`（切回带 bash/联网的宿主默认预设）或 `/model`、`/workspace`。
> 对"只做回答问题"这个目标，这是比检索误发放行更根本的越界面——控制手段目前只能在 QQ 平台侧
> （谁能在群里 @ 机器人）和"别把这个 bot 拉进不特定的大群"，不要指望预设本身挡住群内命令。

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
