#!/usr/bin/env bash
# Installs the local decision models behind `decide`, where the mod looks for them:
#   <dir>/kev        Kev's checkout, with its venv in kev/.venv
#   <dir>/laya-env   a venv with laya[serve] (the laya-serve command)
# <dir> is the localModelsDir option, ~/local-models by default. Needs git and uv
# (https://docs.astral.sh/uv/). Weights download on each model's first start, not here.
#
#   scripts/setup-local.sh [--dir DIR] [--only kev|laya] [--dry-run]
set -euo pipefail

dir="${HOME}/local-models"
only=""
dry=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) dir="$2"; shift 2 ;;
    --only) only="$2"; shift 2 ;;
    --dry-run) dry=1; shift ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
case "$only" in ""|kev|laya) ;; *) echo "--only takes kev or laya" >&2; exit 2 ;; esac

run() {
  echo "+ $*"
  [ -n "$dry" ] || "$@"
}

need() {
  command -v "$1" >/dev/null || { echo "$1 is not installed. $2" >&2; exit 1; }
}

if [ -z "$dry" ]; then
  need git "Install git first."
  need uv "Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh"
fi
run mkdir -p "$dir"

if [ -z "$only" ] || [ "$only" = kev ]; then
  echo "== Kev"
  if [ -d "$dir/kev/.git" ]; then
    run git -C "$dir/kev" pull --ff-only
  else
    run git clone https://github.com/jaredpalmer/kev "$dir/kev"
  fi
  [ -x "$dir/kev/.venv/bin/python" ] || run uv venv --python 3.13 "$dir/kev/.venv"
  # accelerate lets kevGpuGb split Kev between the GPU and system RAM.
  run uv pip install --python "$dir/kev/.venv/bin/python" -e "$dir/kev[serve]" accelerate
  run "$dir/kev/.venv/bin/python" -I -c "import kev.serve; print('kev ready')"
fi

if [ -z "$only" ] || [ "$only" = laya ]; then
  echo "== Laya"
  [ -x "$dir/laya-env/bin/python" ] || run uv venv --python 3.12 "$dir/laya-env"
  run uv pip install --python "$dir/laya-env/bin/python" "laya[serve]"
  run "$dir/laya-env/bin/python" -I -c "import laya; print('laya', laya.__version__)"
fi

echo "Done. Start them from the LOCAL section of the OpenCode panel, or with /opencode local start."
