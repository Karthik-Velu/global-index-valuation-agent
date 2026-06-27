#!/usr/bin/env bash
# Weekly refresh: re-fetch data, re-score, record a prediction, grade past
# predictions, and auto-tune the weights. Designed to be driven by cron/launchd.
#
# Each run adds one more graded data point to the market-feedback loop; once there
# are >= 4 graded runs the opportunity weights begin auto-tuning (see engine/tuning.py).
#
# Install (weekly, Mondays 07:00) — use this repo's absolute path:
#   crontab -e   then add (replace /path/to/Agent):
#   0 7 * * 1 /path/to/Agent/scripts/weekly_refresh.sh >> /path/to/Agent/data/cron.log 2>&1
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"
source .venv/bin/activate
echo "=== refresh $(date) ==="
python -m engine.cli refresh --no-cache
python -m engine.cli accuracy
