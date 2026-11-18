#!/usr/bin/env bash
# Installs a Playwright browser and its OS packages, surviving a slow package mirror.
#
# Hosted runners download fonts and system packages from cloud Ubuntu mirrors
# (azure, ec2, clouds), which can throttle to tens of KB/s without erroring, so
# apt never fails over and the job hits its timeout. A stalled attempt is stopped
# and retried against the main Ubuntu archive with explicit retry/timeout bounds.
set -uo pipefail

engine="${1:?usage: install-playwright-browser.sh ENGINE}"
attempt_seconds="${BPB_BROWSER_INSTALL_SECONDS:-150}"
apt_etc="${BPB_APT_ETC:-/etc/apt}"
apt_sources=(
    "$apt_etc/apt-mirrors.txt"
    "$apt_etc/sources.list"
    "$apt_etc/sources.list.d/ubuntu.sources"
)

install_browser() {
    if command -v timeout >/dev/null; then
        timeout --kill-after=10 "$attempt_seconds" npx playwright install --with-deps "$engine"
    else
        npx playwright install --with-deps "$engine"
    fi
}

install_browser && exit 0
status=$?
[ "${RUNNER_OS:-}" = Linux ] || exit "$status"

echo "::warning title=Browser install retried::Installing $engine failed or stalled (exit $status); retrying with archive.ubuntu.com."
# A timed-out install can leave apt running or dpkg half configured.
sudo pkill -x apt-get || true
sudo dpkg --configure -a || true
for source in "${apt_sources[@]}"; do
    if [ -f "$source" ]; then
        sudo perl -pi -e 's#([a-z0-9.-]+\.)?(azure|ec2|clouds)\.archive\.ubuntu\.com#archive.ubuntu.com#g' "$source"
    fi
done
if [ -d "$apt_etc/apt.conf.d" ]; then
    printf '%s\n' 'Acquire::Retries "3";' 'Acquire::http::Timeout "20";' 'Acquire::https::Timeout "20";' \
        | sudo tee "$apt_etc/apt.conf.d/99-bpb-retry" >/dev/null
fi
install_browser
