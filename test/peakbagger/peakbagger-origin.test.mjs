// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    isPeakbaggerUrl,
    isPeakbaggerSenderUrl,
    isPeakbaggerPageOrigin,
} from '../../src/peakbagger/peakbagger-origin.js';
import { walkFiles } from '../helpers/walk-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN_MODULE = path.join(root, 'src/peakbagger/peakbagger-origin.js');

test('the fetch boundary accepts only https on the two canonical hosts', () => {
    assert.equal(isPeakbaggerUrl('https://peakbagger.com/climber/ascent.aspx?aid=1'), true);
    assert.equal(isPeakbaggerUrl('https://WWW.PeakBagger.com/Peak.aspx'), true);
    assert.equal(isPeakbaggerUrl('http://www.peakbagger.com/'), false, 'plain http is never fetched');
    assert.equal(isPeakbaggerUrl('https://evil.peakbagger.com/'), false, 'a subdomain is not a fetch target');
    assert.equal(isPeakbaggerUrl('https://peakbagger.com.example.test/'), false);
    assert.equal(isPeakbaggerUrl('not a url'), false);
});

test('the sender check tolerates subdomains, matching the manifest match patterns', () => {
    assert.equal(isPeakbaggerSenderUrl('https://peakbagger.com/Peak.aspx'), true);
    assert.equal(isPeakbaggerSenderUrl('https://www.peakbagger.com/climber/ascentedit.aspx'), true);
    assert.equal(isPeakbaggerSenderUrl('https://maps.peakbagger.com/anything'), true);
    assert.equal(isPeakbaggerSenderUrl('https://peakbagger.com.example.test/'), false,
        'a suffix look-alike host is not Peakbagger');
    assert.equal(isPeakbaggerSenderUrl('https://notpeakbagger.com/'), false);
    assert.equal(isPeakbaggerSenderUrl(undefined), false);
});

test('the postMessage origin check is https-only and rejects anything carrying a path', () => {
    assert.equal(isPeakbaggerPageOrigin('https://www.peakbagger.com'), true);
    assert.equal(isPeakbaggerPageOrigin('https://peakbagger.com'), true);
    // The browser verifiers serve fixtures from an ephemeral port on the real host.
    assert.equal(isPeakbaggerPageOrigin('https://www.peakbagger.com:8443'), true);
    assert.equal(isPeakbaggerPageOrigin('http://www.peakbagger.com'), false,
        'no fixture may use plain http, and the fetch boundary would refuse such a page');
    assert.equal(isPeakbaggerPageOrigin('https://evil.peakbagger.com'), false);
    assert.equal(isPeakbaggerPageOrigin('https://www.peakbagger.com/climber'), false,
        'an origin never carries a path');
    assert.equal(isPeakbaggerPageOrigin('null'), false, 'an opaque origin is not Peakbagger');
    assert.equal(isPeakbaggerPageOrigin(''), false);
});

// The counterpart of the settings-schema guard: a trust boundary written out a
// second time drifts silently. Four hand-written variants of this check, of
// three different strictnesses, is what prompted the shared module.
test('no other src module writes its own Peakbagger host or origin check', async () => {
    const HOST_LITERAL = /peakbagger\\?\.com/i;
    const offenders = [];
    const files = await walkFiles(path.join(root, 'src'), file => file.endsWith('.js'));
    for (const file of files) {
        if (file === ORIGIN_MODULE) continue;
        const source = await readFile(file, 'utf8');
        for (const [index, line] of source.split('\n').entries()) {
            // Only regular expressions and host sets are the concern. Ordinary
            // absolute URLs the extension builds or navigates to are fine.
            const isPattern = /\/[^/\n]*peakbagger\\?\.com[^/\n]*\/[gimsuy]*/i.test(line)
                && !line.includes('https://') && !line.includes('http://');
            const isHostSet = /new Set\(\[[^\]]*peakbagger\.com/i.test(line);
            if ((isPattern || isHostSet) && HOST_LITERAL.test(line)) {
                offenders.push(`${path.relative(root, file)}:${index + 1}`);
            }
        }
    }
    assert.deepEqual(offenders, [],
        'import a predicate from src/peakbagger/peakbagger-origin.js instead of writing a second host check');
});
