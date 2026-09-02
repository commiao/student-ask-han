#!/usr/bin/env bash
# 把 kb-qa 闭卷问答预设装到目标 DSH 上：预设三件套 + 知识库文件。
# 自动定位该机的预设根目录；不确定就用 --root 显式指定。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/../preset-kb-qa"
DBSRC="$HERE/../dist/kb.sqlite"
ROOT=""
WANT_DB=1

while [ $# -gt 0 ]; do
  case "$1" in
    --root)   ROOT="${2:?--root 需要一个路径}"; shift 2 ;;
    --no-db)  WANT_DB=0; shift ;;
    -h|--help) sed -n '1,6p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

[ -d "$SRC" ] || { echo "找不到预设源目录：$SRC" >&2; exit 1; }

if [ -z "$ROOT" ]; then
  # 先挑已经存在的预设根；都没有就挑"父目录已存在"的那个，最后退回 Desktop 默认位。
  for c in \
    "$HOME/Library/Application Support/dsh-desktop/harness/.agent-presets" \
    "$HOME/.config/dsh-desktop/harness/.agent-presets" \
    "${APPDATA:-}/dsh-desktop/harness/.agent-presets" \
    "${DSH_HOME:-$HOME/.dsh}/.agent-presets"; do
    [ -n "$c" ] && [ -d "$c" ] && { ROOT="$c"; break; }
  done
  if [ -z "$ROOT" ]; then
    for c in \
      "$HOME/Library/Application Support/dsh-desktop/harness/.agent-presets" \
      "$HOME/.config/dsh-desktop/harness/.agent-presets" \
      "${DSH_HOME:-$HOME/.dsh}/.agent-presets"; do
      [ -d "$(dirname "$c")" ] && { ROOT="$c"; break; }
    done
  fi
fi
[ -n "$ROOT" ] || { echo "定位不到预设根目录，请用 --root <DSH 的 harness/.agent-presets> 指定" >&2; exit 1; }

DST="$ROOT/kb-qa"
mkdir -p "$DST"
cp "$SRC/preset.yml" "$SRC/agent.cordis.yml" "$SRC/kb-ask.mjs" "$DST/"

# 这两项缺一样就会 PRESET_UNAVAILABLE，且 QQ 侧看不到原因，所以装完立即自检。
grep -q "export const inject = \['tools'\]" "$DST/kb-ask.mjs" \
  || { echo "装好的 kb-ask.mjs 缺 inject 声明，源文件不对" >&2; exit 1; }
node --check "$DST/kb-ask.mjs" 2>/dev/null || echo "提示：本机 node 不可用，跳过语法自检"
grep -q "kb-ask.mjs" "$DST/agent.cordis.yml" || { echo "roster 里找不到 kb-ask 行" >&2; exit 1; }

if [ "$WANT_DB" -eq 1 ]; then
  if [ -f "$DBSRC" ]; then
    KBDIR="$(dirname "$ROOT")/knowledge-base"
    mkdir -p "$KBDIR"
    [ -f "$KBDIR/kb.sqlite" ] && echo "已存在 $KBDIR/kb.sqlite —— 不覆盖；要换掉请先手工备份删除"
    [ -f "$KBDIR/kb.sqlite" ] || cp "$DBSRC" "$KBDIR/kb.sqlite"
  else
    echo "提示：没有 $DBSRC，跳过知识库拷贝（可稍后手工放置或用 kb_import 重新导入）"
  fi
fi

echo
echo "已安装到：$DST"
ls -l "$DST"
cat <<'TXT'

下一步：
  1) 完全退出并重启 DSH（Cmd+Q / 托盘退出）。不重启不生效——同一进程会
     复用已缓存的旧模块，改完文件必须换进程。
  2) 设置 → IM 机器人 → 你的 bot → 打开「群聊上下文增强」，字段勾 senderName，
     否则回复里点不出提问人。
  3) 在该 bot 的设置中选择 kb-qa，并从新会话发送「宿舍晚上断电吗」。
     不要把 /preset 或 /new 当作群内运维命令：当前 dsh-im 未按发送者限制这些命令。
  4) 期望首行是 @你的昵称 你问的「宿舍晚上断电吗」：，并带（指南·宿舍生活 第8条 Q20）。
TXT
