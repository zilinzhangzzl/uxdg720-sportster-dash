#!/usr/bin/env bash
# 自动备份：由定时任务每 10 分钟调用一次（见 backup/setup-backup.sh）。
#
# 做什么：
#   1. 项目文件有变化 → 创建一个提交（说明含时间和变更文件）；没有变化 → 不提交。
#   2. 有尚未上传的提交 → 上传到 origin；失败时保留本地提交，下一次自动重试。
#   3. 远程有本地没有的版本（冲突风险）→ 停止自动上传并写下暂停标记，绝不强制覆盖。
#   4. 里程碑命名：如果存在 backup/next-tag.txt，就给当前版本打上标签并上传。
#      第 1 行是标签名（英文、数字、点、短横线，如 v1.1），第 2 行起是中文说明。
#
# 不保存任何登录凭据：上传使用你电脑上已经配置好的 git 登录方式（SSH 密钥或凭据管理器）。
set -u

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$REPO_DIR/backup/backup.log"
PAUSE="$REPO_DIR/backup/.backup-paused"
LOCK="$REPO_DIR/backup/.backup-lock"
TAG_REQ="$REPO_DIR/backup/next-tag.txt"
DID_SOMETHING=0

stamp() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "$(stamp) $*" >> "$LOG"; }
# 日志超过 1000 行时只保留最近 500 行
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 1000 ]; then
  tail -n 500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
notify() {
  # 尽量弹出桌面提示；没有对应工具时只写日志
  if command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"$1\" with title \"仪表盘原型自动备份\"" >/dev/null 2>&1 || true
  elif command -v cygpath >/dev/null 2>&1 && command -v notepad.exe >/dev/null 2>&1; then
    # Windows（Git Bash）：用记事本打开暂停说明，提醒手动处理
    notepad.exe "$(cygpath -w "$PAUSE")" >/dev/null 2>&1 &
  elif command -v notify-send >/dev/null 2>&1; then
    notify-send "仪表盘原型自动备份" "$1" >/dev/null 2>&1 || true
  fi
}

cd "$REPO_DIR" || exit 1

# 防止两次运行重叠
if ! mkdir "$LOCK" 2>/dev/null; then
  log "上一次备份仍在运行，跳过本次"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

if [ -f "$PAUSE" ]; then
  log "自动上传已暂停：$(head -1 "$PAUSE")"
  exit 4
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  log "错误：$REPO_DIR 不是 git 仓库，请先运行 backup/setup-backup.sh"
  exit 1
fi
if ! git remote get-url origin >/dev/null 2>&1; then
  log "错误：没有配置远程仓库 origin"
  exit 1
fi
if [ -e .git/MERGE_HEAD ] || [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
  log "仓库正在合并或变基，跳过自动备份"
  exit 4
fi

BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null)"
if [ -z "$BRANCH" ]; then
  log "错误：当前不在任何分支上（detached HEAD），跳过"
  exit 1
fi

# 1. 有变化才提交
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  COUNT="$(git diff --cached --name-only | wc -l | tr -d ' ')"
  FILES="$(git diff --cached --name-only | head -4 | paste -sd ',' - | sed 's/,/, /g')"
  [ "$COUNT" -gt 4 ] && FILES="$FILES 等"
  MSG="自动备份 $(date '+%Y-%m-%d %H:%M')：更新 ${COUNT} 个文件（${FILES}）"
  if git commit -q -m "$MSG"; then
    log "已提交：$MSG"
    DID_SOMETHING=1
  else
    log "提交失败，下次重试"
    exit 3
  fi
fi

# 1b. 里程碑命名请求（请求文件本身在 .gitignore 中，不会被提交）
if [ -f "$TAG_REQ" ]; then
  TAG="$(head -n 1 "$TAG_REQ" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  NOTE="$(tail -n +2 "$TAG_REQ" | tr -d '\r' | sed '/^[[:space:]]*$/d')"
  [ -z "$NOTE" ] && NOTE="$TAG"
  if ! printf '%s' "$TAG" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*$' || ! git check-ref-format "refs/tags/$TAG"; then
    log "命名请求无效：标签名“$TAG”只能用英文、数字、点和短横线；已改名为 next-tag.invalid.txt"
    mv -f "$TAG_REQ" "$REPO_DIR/backup/next-tag.invalid.txt"
  elif git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    log "标签 $TAG 已存在，不重复创建；已删除命名请求"
    rm -f "$TAG_REQ"
  elif git tag -a "$TAG" -m "$NOTE"; then
    log "已命名版本：$TAG（$(git rev-parse --short HEAD)）$(printf '%s' "$NOTE" | head -n 1)"
    rm -f "$TAG_REQ"
    DID_SOMETHING=1
  else
    log "创建标签 $TAG 失败，下次重试"
  fi
fi

# 2. 与远程比较
if ! git fetch -q origin 2>>"$LOG"; then
  log "连接远程失败（网络或登录问题），本地提交已保留，下次重试"
  exit 3
fi

if git rev-parse --verify -q "refs/remotes/origin/$BRANCH" >/dev/null; then
  BEHIND="$(git rev-list --count "HEAD..origin/$BRANCH")"
  AHEAD="$(git rev-list --count "origin/$BRANCH..HEAD")"
else
  BEHIND=0
  AHEAD="$(git rev-list --count HEAD)"
fi

if [ "$BEHIND" -gt 0 ]; then
  echo "远程分支 $BRANCH 有 $BEHIND 个本地没有的版本（$(stamp) 发现）。请手动合并后删除本文件以恢复自动上传。" > "$PAUSE"
  log "检测到远程有新版本（可能冲突），已停止自动上传，没有覆盖远程内容"
  notify "检测到远程有新版本，自动上传已暂停，请手动处理。"
  exit 4
fi

# 3. 上传版本（不使用 --force）
if [ "$AHEAD" -gt 0 ]; then
  if git push -q origin "$BRANCH" 2>>"$LOG"; then
    log "已上传 $AHEAD 个版本到 origin/$BRANCH"
    DID_SOMETHING=1
  else
    log "上传失败，本地提交已保留，下次重试"
    exit 3
  fi
fi

# 4. 上传还没上传的标签（失败时下次重试；已存在的远程标签绝不覆盖）
REMOTE_TAGS="$(git ls-remote --tags origin 2>>"$LOG")" || { log "读取远程标签失败，下次重试"; exit 3; }
for t in $(git tag); do
  if ! printf '%s\n' "$REMOTE_TAGS" | grep -q "refs/tags/$t\$"; then
    if git push -q origin "refs/tags/$t" 2>>"$LOG"; then
      log "已上传版本名称 $t"
      DID_SOMETHING=1
    else
      log "上传版本名称 $t 失败，下次重试"
    fi
  fi
done

[ "$DID_SOMETHING" -eq 0 ] && log "检查完成：没有变化"
exit 0
