#!/usr/bin/env bash
# Installs a Playwright browser and its OS packages, surviving a slow package mirror.
#
# Hosted runners download fonts from one Azure Ubuntu mirror, which can throttle to
# tens of KB/s without erroring, so apt never fails over and the job hits its timeout.
# A stalled attempt is stopped and retried against the main Ubuntu archive instead.
set -uo pipefail

engine="${1:?usage: install-playwright-browser.sh ENGINE}"
attempt_seconds="${BPB_BROWSER_INSTALL_SECONDS:-150}"
apt_sources=(/etc/apt/apt-mirrors.txt /etc/apt/sources.list)

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
    if [ -f "$source" ]; then sudo sed -i 's#azure\.archive\.ubuntu\.com#archive.ubuntu.com#g' "$source"; fi
done
install_browser
