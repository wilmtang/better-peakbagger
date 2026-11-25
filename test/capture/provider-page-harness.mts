// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs/promises';
import { FixtureDom, builtBundle } from '../helpers/fixture-dom.mts';

export interface ProviderActivity {
    provider: 'garmin' | 'strava';
    activityId: string;
}

export interface ProviderOwnershipDecision {
    ok: boolean;
    code?: string;
    provider?: string;
    activityId?: string;
    viewerId?: string | null;
    authorId?: string | null;
}

export interface ProviderTrackPoint {
    lat: number;
    lon: number;
    ele: number | null;
    time: number | null;
    invalidTime: boolean;
}

export interface ProviderCaptureResult {
    ok: boolean;
    code?: string;
    message?: string;
    retryAt?: number;
    provider?: string;
    activityId?: string;
    segments: ProviderTrackPoint[][];
    waypoints: { lat: number; lon: number; name?: string }[];
    metadata: { title?: string; displayedLocalStart?: string };
    diagnostics?: {
        durationsMs: Record<string, number>;
        counts: Record<string, number>;
    };
}

export interface ProviderPageApi {
    providerFromUrl(url: string): ProviderActivity | null;
    inspectOwnership(url?: string): ProviderOwnershipDecision;
    publicOwnership(decision: unknown): ProviderOwnershipDecision;
    waitForOwnership(expected: ProviderActivity, generation: string, timeoutMs: number): Promise<ProviderOwnershipDecision>;
    cancelCapture(generation: string): boolean;
    capture(
        options?: Record<string, unknown>,
        generation?: string | null,
        timeoutMs?: number,
        expected?: ProviderActivity | null,
        diagnostics?: boolean,
    ): Promise<ProviderCaptureResult>;
}

export type ProviderDom = FixtureDom & {
    readonly window: FixtureDom['window'] & {
        BPBProviderPage: ProviderPageApi;
        USE_DI_SESSION?: boolean;
        URL_BUST_VALUE?: string;
    };
};

// The built bundle (IIFE) evaluated in each page's fixture realm, so the module
// reads that page's document/location — exactly as the injected script does.
const source = await builtBundle('provider-page.js');

export const fixture = (name: string) => fs.readFile(new URL(`fixtures/${name}`, import.meta.url), 'utf8');

export const load = (html: string, url: string): ProviderDom => {
    const dom = new FixtureDom(html, { url, runScripts: 'outside-only' });
    dom.window.eval(source);
    return dom as ProviderDom;
};

export const until = async (predicate: () => unknown) => {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('condition not reached');
        await new Promise(resolve => setTimeout(resolve, 1));
    }
};

export const stravaPage = ({ viewer = '42', author = '42', edit = true } = {}) => `
<!doctype html><body>
  <header id="global-header"><a href="/athletes/${viewer}">Viewer</a></header>
  <main><section id="heading" data-testid="activity-header"><a href="/athletes/${author}">Author</a>
    <span>4:13 PM on Saturday, July 11, 2026</span></section>
    ${edit ? '<a href="/activities/123/edit">Edit</a>' : ''}<h1>Morning hike</h1>
    <time datetime="2026-07-01T08:00:00-07:00"></time>
  </main>
</body>`;

export const garminPage = ({ csrfToken = 'csrf-123' } = {}) => `
<!doctype html><html><head><meta name="csrf-token" content="${csrfToken}"></head><body>
  <header class="header"><a href="/app/profile/ABC-123">Viewer</a></header>
  <div class="ActivityHeaderContainer_headerContainer__hash"><a href="/app/profile/abc-123">Author</a>
    <button aria-label="Edit an Activity"></button><h1>Mountain hike</h1>
  </div>
</body></html>`;
