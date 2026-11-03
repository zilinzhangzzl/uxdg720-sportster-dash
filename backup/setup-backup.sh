#!/usr/bin/env bash
# 初次配置自动备份（macOS / Linux）。
#
# 用法：
#   bash backup/setup-backup.sh <GitHub 仓库地址>    配置仓库、首次上传、安装每 10 分钟的定时任务
#   bash backup/setup-backup.sh --uninstall          移除定时任务
#
# 仓库地址示例：git@github.com:用户名/仓库名.git 或 https://github.com/用户名/仓库名.git
# 本脚本不会询问、保存或上传任何密码或令牌。上传用的是你电脑上已有的 git 登录方式。
set -eu

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$REPO_DIR/backup/auto-backup.sh"
MARK="# sportster-dash-auto-backup"

remove_cron() {
  ( crontab -l 2>/dev/null | grep -v "$MARK" ) | crontab - || true
}

if [ "${1:-}" = "--uninstall" ]; then
  remove_cron
  echo "已移除自动备份定时任务。"
  exit 0
fi

URL="${1:-}"
if [ -z "$URL" ]; then
  echo "缺少 GitHub 仓库地址。用法：bash backup/setup-backup.sh <仓库地址>"
  exit 1
fi

cd "$REPO_DIR"
chmod +x "$SCRIPT"

if [ ! -d .git ]; then
  git init -q -b main
  echo "已创建本地 git 仓库（分支 main）"
fi
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$URL"
else
  git remote add origin "$URL"
fi
echo "远程仓库：$URL"

# 首次提交
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -q -m "初始版本 $(date '+%Y-%m-%d %H:%M')：仪表盘原型、说明书和备份配置"
  echo "已创建首次提交"
fi

BRANCH="$(git symbolic-ref --short HEAD)"
if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  echo "远程已有分支 $BRANCH。为避免覆盖远程内容，本脚本不会自动推送。"
  echo "请先手动合并（例如 git pull --no-rebase origin $BRANCH），确认无误后再重新运行本脚本。"
  exit 2
fi
if ! git push -u origin "$BRANCH"; then
  echo
  echo "首次上传失败：通常是还没有登录 GitHub，或仓库地址不对。"
  echo "可以先运行 'gh auth login'（GitHub CLI）或配置 SSH 密钥，然后重新运行本脚本。"
  echo "定时任务没有安装，自动备份尚未启用。"
  exit 3
fi
echo "首次上传成功。"

# 安装定时任务：每 10 分钟一次
if ! command -v crontab >/dev/null 2>&1; then
  echo "这台电脑没有 crontab，无法安装定时任务。自动备份尚未启用。"
  echo "可以手动定期运行：bash backup/auto-backup.sh（Windows 方法见 README.md）。"
  exit 3
fi
remove_cron
( crontab -l 2>/dev/null; echo "*/10 * * * * /bin/bash \"$SCRIPT\" $MARK" ) | crontab -
echo "已安装定时任务（每 10 分钟）："
crontab -l | grep "$MARK"
echo
echo "下一步验证：修改任意文件，等待最多 10 分钟，然后在 GitHub 仓库页面查看是否出现“自动备份 …”提交。"
echo "运行记录在 backup/backup.log。验证成功之前，不要认为自动备份已启用。"
