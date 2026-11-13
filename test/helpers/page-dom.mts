// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Typed jsdom pages for tests that drive this repository's own fixture markup.
// jsdom's declarations type a window as a real browser window with a loose
// index signature; these tests read known markup, so lookups are typed as the
// present page elements from page-types.mts, and a missing node fails the test
// at the lookup. This narrows only the document and the stubbed `chrome`;
// everything else is jsdom's.

import { JSDOM, type ConstructorOptions, type DOMWindow } from 'jsdom';
import type { PageDocument, TestWindow } from './page-types.mts';

// `chrome` is whatever stub the test installs, not the real extension API.
export type FixtureWindow = Omit<TestWindow, 'document' | 'chrome'> & { document: PageDocument; [stub: string]: unknown };

export interface FixtureDom extends Omit<JSDOM, 'window'> {
    readonly window: FixtureWindow;
}

export const fixtureDom = (html?: string, options?: ConstructorOptions): FixtureDom =>
    new JSDOM(html, options) as unknown as FixtureDom;

// jsdom declares its window apart from the browser's global object, but it is
// the global these tests evaluate bundles and pass to production owners
// against. This is the one place that asserts the stand-in.
export const browserWindow = <W extends TestWindow = TestWindow>(window: DOMWindow) => window as unknown as W;
