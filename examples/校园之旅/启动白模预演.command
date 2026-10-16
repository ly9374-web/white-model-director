#!/bin/zsh
cd "$(dirname "$0")" || exit 1
if [[ -x .venv/bin/python ]]; then
  WM_PYTHON="$PWD/.venv/bin/python"
else
  WM_PYTHON="$(command -v python3)"
fi
if [[ -z "$WM_PYTHON" ]]; then
  print "需要 Python 3 才能启动此工程。"
  exit 1
fi
exec "$WM_PYTHON" scripts/launch_preview.py --page index.html "$@"
