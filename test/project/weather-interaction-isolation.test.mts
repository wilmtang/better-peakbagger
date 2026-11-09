// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyPeakWeatherInteractions, waitForWeatherRefresh, type WeatherInteractionDependencies } from '../../scripts/verify-peak-weather-interactions.mts';
import { resolveSummitCloudModels } from '../../src/weather/summit-cloud-models.ts';
import { summitCloudRequest } from '../../src/weather/summit-cloud-client.js';

const subject = { latitude: 46.851731, longitude: -121.760395, elevation: 4391 };
const day = { start: Date.UTC(2026, 10, 9), end: Date.UTC(2026, 10, 10) };
const pressureRequests = resolveSummitCloudModels(subject, 'auto').map(model => summitCloudRequest(subject, day, model).url);

test('interaction startup excludes legitimate sibling pressure requests from its refresh counter', async () => {
    const stop = new Error('navigation boundary reached');
    for (const ignoreCloudOptOut of [false, true]) {
        let preferences: Record<string, unknown> = {};
        const evidence: string[] = [];
        const unused = async () => { throw new Error('unexpected browser operation before navigation'); };
        const dependencies: WeatherInteractionDependencies = {
            origin: 'https://www.peakbagger.com', evidence, networkErrors: [], firefoxMode: false,
            verificationLocale: 'en-US', evaluate: unused, wait: unused, click: unused, clickPoint: unused,
            movePointer: unused, press: unused, resize: async () => {}, setZoom: unused,
            writeLocal: async () => {}, setMode: () => {}, heldCount: () => 0, release: () => {}, releaseOne: () => {}, screenshotPage: unused,
            setSettings: async value => { preferences = { ...value }; if (ignoreCloudOptOut) delete preferences.showSummitCloud; },
            navigate: async () => {
                // Model the lazy sibling entering the viewport alongside the
                // first surface request. These are real cloud-client URLs.
                evidence.push('surface-weather');
                if (preferences.showSummitCloud !== false) evidence.push(...pressureRequests);
                throw stop;
            },
        };
        await assert.rejects(verifyPeakWeatherInteractions(dependencies), error => error === stop);
        assert.equal(preferences.showWeather, true);
        assert.equal(preferences.showSnotel, true, 'the following snow card remains part of geometry verification');
        assert.equal(pressureRequests.length, 2);
        assert.equal(evidence.length, ignoreCloudOptOut ? 3 : 1,
            'two legitimate pressure-profile requests must not masquerade as duplicate weather refreshes');
    }
});

test('an unrelated held provider cannot establish the pending weather refresh condition', async () => {
    const evidence: unknown[] = ['earlier-provider-request'];
    let reads = 0;
    await waitForWeatherRefresh({ evidence, heldCount: () => 1, pending: async () => {
        reads++;
        if (reads === 1) return false; // A held request alone does not prove the weather UI is busy.
        if (reads === 2) { evidence.length = 0; return true; } // Busy weather alone does not prove its request reached the fixture.
        evidence.push('surface-weather');
        return true;
    } }, 0);
    assert.equal(reads, 3, 'both the weather UI and its outgoing request are required before repeated inputs');
});

test('the strengthened pending gate still rejects excess requests rather than relaxing the duplicate invariant', async () => {
    await assert.rejects(waitForWeatherRefresh({ pending: async () => true, heldCount: () => 3,
        evidence: ['surface-weather', ...pressureRequests] }, 0), /starts exactly one weather request/);
});
