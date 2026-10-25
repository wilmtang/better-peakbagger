#!/bin/sh
set -eu

[ "$(uname -s)" = Linux ] || { echo 'This launcher requires the Linux VPS.' >&2; exit 1; }
[ "$#" -eq 0 ] || { echo 'Unknown launcher arguments.' >&2; exit 1; }
task_root=${FCC_TILE_ROOT:-/mnt/fcc-tiles}
task_python=${FCC_PYTHON:-"$HOME/Dev/fcc-tiles/.venv/bin/python"}
task_tools=${FCC_TIPPECANOE_DIR:-"$HOME/Dev/fcc-tiles/tools/felt-tippecanoe-68ab8dc"}
task_code=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mountpoint -q "$task_root"
test -f "$task_root/metadata/import-plan.json"
test -f "$task_root/.secrets/fcc.json"

sudo -n systemd-run --unit=fcc-tiles-conversion --uid="$(id -un)" --gid="$(id -gn)" \
  --property=CPUQuota=200% --property=MemoryHigh=1800M --property=MemoryMax=2400M \
  --property=OOMPolicy=stop --property=KillMode=control-group --property=Restart=no \
  --property="RequiresMountsFor=$task_root" \
  --property="StandardOutput=append:$task_root/logs/vps-run.log" \
  --property="StandardError=append:$task_root/logs/vps-run.log" \
  --setenv="FCC_TILE_ROOT=$task_root" --setenv="FCC_TIPPECANOE_DIR=$task_tools" \
  --setenv=FCC_ENCODER_THREADS=2 --setenv=OPENBLAS_NUM_THREADS=1 --setenv=OMP_NUM_THREADS=1 \
  "$task_python" "$task_code/fcc_run_vps.py"
