// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { waitForCondition } from './browser-verification-fixtures.mjs';

export type WeatherEvaluate = <R, A = undefined>(fn: (argument: A) => R | Promise<R>, argument?: A) => Promise<Awaited<R>>;
export interface WeatherControls {
    evaluate: WeatherEvaluate; click: (selector: string) => Promise<unknown>; press: (key: string) => Promise<unknown>;
    resize: (width: number, height: number) => Promise<unknown>; setSettings: (values: Record<string, string | boolean | number>) => Promise<unknown>;
    screenshotPage: (file: string) => Promise<unknown>; firefoxMode: boolean;
}
// The fixture's HTML guarantees these selected control shapes. This type is
// local to browser assertions and never describes provider/page input.
export type WeatherFixtureElement = HTMLElement & Pick<HTMLDetailsElement, 'open'>;
export const waitWeatherCondition = waitForCondition as <T>(read: () => Promise<T>, options: {
    description: string; timeoutMs?: number; isReady: (state: T) => boolean;
}) => Promise<T>;
