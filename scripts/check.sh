#!/usr/bin/env bash
# Every check a release must pass: validate, the mod's tests, the scripts' tests and the type-check.
# CI runs all but the type-check, whose engine types exist only where Claude Code has run (see typecheck.sh).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

claude plugin validate .
claude plugin test .
python3 -m unittest discover -s scripts -p 'test_*.py'
scripts/typecheck.sh
echo "All checks passed."
