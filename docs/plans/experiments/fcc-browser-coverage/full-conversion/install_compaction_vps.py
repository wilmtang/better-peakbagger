"""Render and install the resource-limited service without committing host identity."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import tempfile


def render_unit(template, user, group, home):
    assert all(re.fullmatch(r'[a-z_][a-z0-9_-]*[$]?', value) for value in (user, group))
    assert Path(home).is_absolute() and not any(c in home for c in '\n\r\t @%"\\')
    result = template.replace('@FCC_USER@', user).replace('@FCC_GROUP@', group).replace('@FCC_HOME@', home)
    assert '@FCC_' not in result
    return result


def main():
    assert len(sys.argv) == 1, 'Unknown installer arguments'
    assert platform.system() == 'Linux' and os.getuid() != 0, 'Run as the regular Linux VPS user'
    import grp
    import pwd
    owner = pwd.getpwuid(os.getuid())
    group = grp.getgrgid(os.getgid()).gr_name
    code = Path(__file__).resolve().parent
    assert code == Path(owner.pw_dir)/'Dev/fcc-tiles/code'
    root = Path('/mnt/fcc-tiles')
    assert root.is_mount(), 'Dedicated data disk is not mounted'
    report = json.loads((root/'verification/compact-v2-verified-benchmark.json').read_text())
    assert report['status'] == 'complete' and report['allFeatureFieldsAndOrderVerified']
    assert report['profile'] == 'overview-subpixel-holes-v2'
    assert report['codeSha256'] == hashlib.sha256((code/'fcc_compact.py').read_bytes()).hexdigest()
    template = (code/'fcc-tiles-compaction.service.in').read_text()
    rendered = render_unit(template, owner.pw_name, group, owner.pw_dir)
    with tempfile.TemporaryDirectory(prefix='fcc-compaction-unit-') as name:
        path = Path(name)/'fcc-tiles-compaction.service'
        path.write_text(rendered)
        subprocess.run(['sudo', '-n', 'systemd-analyze', 'verify', str(path)], check=True)
        subprocess.run(['sudo', '-n', 'install', '-m', '0644', str(path), '/etc/systemd/system/'+path.name], check=True)
    subprocess.run(['sudo', '-n', 'systemctl', 'daemon-reload'], check=True)
    subprocess.run(['sudo', '-n', 'systemctl', 'enable', '--now', 'fcc-tiles-compaction.service'], check=True)


if __name__ == '__main__':
    main()
