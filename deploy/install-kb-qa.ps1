# Windows 版：把 kb-qa 闭卷问答预设装到目标 DSH 上。
# 用法： powershell -ExecutionPolicy Bypass -File install-kb-qa.ps1 [-Root <预设根目录>]
param([string]$Root = '')

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src  = Join-Path (Split-Path -Parent $here) 'preset-kb-qa'
$dbsrc = Join-Path (Split-Path -Parent $here) 'dist\kb.sqlite'
if (-not (Test-Path $src)) { throw "找不到预设源目录：$src" }

if (-not $Root) {
  $cands = @(
    (Join-Path $env:APPDATA 'dsh-desktop\harness\.agent-presets'),
    (Join-Path "$env:USERPROFILE\.dsh" '.agent-presets')
  )
  foreach ($c in $cands) { if (Test-Path $c) { $Root = $c; break } }
  if (-not $Root) { foreach ($c in $cands) { if (Test-Path (Split-Path -Parent $c)) { $Root = $c; break } } }
}
if (-not $Root) { throw '定位不到预设根目录，请用 -Root 指定（一般是 %APPDATA%\dsh-desktop\harness\.agent-presets）' }

$dst = Join-Path $Root 'kb-qa'
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item (Join-Path $src 'preset.yml'), (Join-Path $src 'agent.cordis.yml'), (Join-Path $src 'kb-ask.mjs') $dst -Force

# 这两项缺一样就会 PRESET_UNAVAILABLE，而且 QQ 侧看不到原因，装完立刻自检。
if (-not (Select-String -Path (Join-Path $dst 'kb-ask.mjs') -Pattern "export const inject = \['tools'\]" -Quiet)) {
  throw "装好的 kb-ask.mjs 缺 inject 声明，源文件不对"
}
if (-not (Select-String -Path (Join-Path $dst 'agent.cordis.yml') -Pattern 'kb-ask\.mjs' -Quiet)) {
  throw 'roster 里找不到 kb-ask 行'
}

if (Test-Path $dbsrc) {
  $kbdir = Join-Path (Split-Path -Parent $Root) 'knowledge-base'
  New-Item -ItemType Directory -Force -Path $kbdir | Out-Null
  $kb = Join-Path $kbdir 'kb.sqlite'
  if (Test-Path $kb) { Write-Host "已存在 $kb —— 不覆盖；要换掉请先手工备份删除" }
  else { Copy-Item $dbsrc $kb }
} else {
  Write-Host "提示：没有 $dbsrc，跳过知识库拷贝"
}

Write-Host "`n已安装到：$dst"
Get-ChildItem $dst | Format-Table Name, Length -AutoSize
@'

下一步：
  1) 完全退出并重启 DSH（托盘右键退出）。不重启不生效——同一进程会复用缓存的旧模块。
  2) 设置 → IM 机器人 → 你的 bot → 打开「群聊上下文增强」，字段勾 senderName。
  3) 群里发：/presetlist  →  /preset kb-qa  →  /new  →  宿舍晚上断电吗
  4) 期望首行 @你的昵称 你问的「宿舍晚上断电吗」：，并带（指南·宿舍生活 第8条 Q20）。
'@
