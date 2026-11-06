// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    PEAKBAGGER_ORIGIN,
    isPeakbaggerUrl,
    isPeakbaggerSenderUrl,
    isPeakbaggerPageOrigin,
} from '../../src/peakbagger/peakbagger-origin.js';

import { runtimeSources } from '../helpers/runtime-sources.mts';
import { originFindings } from '../helpers/source-policies.mts';

test('the fetch boundary accepts only https on the two canonical hosts', () => {
    assert.equal(isPeakbaggerUrl('https://peakbagger.com/climber/ascent.aspx?aid=1'), true);
    assert.equal(isPeakbaggerUrl('https://WWW.PeakBagger.com/Peak.aspx'), true);
    assert.equal(isPeakbaggerUrl('http://www.peakbagger.com/'), false, 'plain http is never fetched');
    assert.equal(isPeakbaggerUrl('https://evil.peakbagger.com/'), false, 'a subdomain is not a fetch target');
    assert.equal(isPeakbaggerUrl('https://peakbagger.com.example.test/'), false);
    assert.equal(isPeakbaggerUrl('not a url'), false);
});

test('the sender check matches the manifest-authorized https hosts exactly', () => {
    assert.equal(isPeakbaggerSenderUrl('https://peakbagger.com/Peak.aspx'), true);
    assert.equal(isPeakbaggerSenderUrl('https://www.peakbagger.com/climber/ascentedit.aspx'), true);
    assert.equal(isPeakbaggerSenderUrl('https://maps.peakbagger.com/anything'), false);
    assert.equal(isPeakbaggerSenderUrl('http://www.peakbagger.com/anything'), false);
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
test('host checks and extension-authored absolute URLs stay canonical', async () => {
    assert.equal(PEAKBAGGER_ORIGIN, 'https://www.peakbagger.com');
    const sources = await runtimeSources();
    assert.ok(sources.length >= 15, 'expected the authored runtime module set');
    assert.deepEqual(sources.flatMap(originFindings), []);
});

// The module header claims the fetch and sender predicates currently agree.
// Keep that claim honest: if a future rule makes one stricter, this fails and
// the header has to be rewritten alongside it rather than quietly becoming
// wrong.
test('the fetch and sender predicates agree, as the module states', () => {
    const cases = [
        'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        'https://peakbagger.com/',
        'https://WWW.PeakBagger.com/Peak.aspx',
        'https://www.peakbagger.com:8443/report/report.aspx?r=b',
        'http://www.peakbagger.com/',
        'https://peakbagger.com.evil.example/',
        'https://evil.example/?x=https://www.peakbagger.com/',
        'chrome-extension://abc/options/options.html',
        'not a url',
        '',
    ];
    for (const value of cases) {
        assert.equal(
            isPeakbaggerUrl(value),
            isPeakbaggerSenderUrl(value),
            `fetch and sender policy disagree on ${value || '(empty)'}`
        );
    }
    assert.equal(isPeakbaggerUrl('https://www.peakbagger.com:8443/'), true);
    assert.equal(isPeakbaggerUrl('http://www.peakbagger.com/'), false);
    // The postMessage predicate is the one that differs: an origin carries no
    // path, so anything beyond a bare origin is not one.
    assert.equal(isPeakbaggerPageOrigin('https://www.peakbagger.com/Peak.aspx'), false);
    assert.equal(isPeakbaggerPageOrigin('https://www.peakbagger.com'), true);
});
