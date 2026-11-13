// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — typed page side of the SETTINGS_PATCH route.
//
// Extension pages never write settings storage themselves: `set` in
// src/settings/settings.js sends a SETTINGS_PATCH runtime message and the
// background worker applies it in its single mutation queue. That store is
// still JavaScript and is a source in many bundles, so this module types the
// route around it instead of converting it (see the modern stack adoption
// plan, M4). It adds no second implementation: the request envelope, the
// reply handling and every error message remain settings.js's own, and
// test/options/settings-patch-route.test.mts pins that these declarations
// describe what it actually sends and accepts.

import type { settingsSchema } from '../src/settings/settings-schema.ts';
import { createSettingsStore } from '../src/settings/settings.js';

export type Settings = ReturnType<typeof settingsSchema.clean>;
export type SettingsKey = keyof Settings;
export type SettingsPatch = { readonly [Key in SettingsKey]?: Settings[Key] };

export const SETTINGS_PATCH = 'SETTINGS_PATCH';

// The wire envelope. `onlyIfUnset` is present only when it is true.
export interface SettingsPatchRequest<Patch extends SettingsPatch = SettingsPatch> {
    readonly type: typeof SETTINGS_PATCH;
    readonly patch: Patch;
    readonly onlyIfUnset?: true;
}

export interface SettingsRouteError {
    readonly code?: string;
    readonly message?: string;
    readonly retryAt?: number;
}

// What the worker sends back. A reply is only ever handled as `unknown` and
// validated by the store; these are the shapes it is known to accept or reject.
export type SettingsPatchReply =
    // The patch was applied; `settings` is the complete stored result.
    | { readonly ok: true; readonly settings: Settings }
    // The sender gate refused the write.
    | { readonly ok: false; readonly error: SettingsRouteError }
    // The worker's listener failed while applying it.
    | { readonly phase: 'error'; readonly error: SettingsRouteError };

// Runtime messaging: replies cross a process boundary and stay unvalidated.
export type SettingsPatchTransport = (request: SettingsPatchRequest) => Promise<unknown>;

export interface SettingsPatchRoute<Patch extends SettingsPatch = SettingsPatch> {
    // Resolves with the cleaned stored settings; rejects with an Error whose
    // message is the worker's public message or the store's generic fallback.
    set(patch: Patch): Promise<Settings>;
}

// A route over an explicit transport. Storage areas are withheld so this view
// can only send patches, never read or write storage directly.
export const settingsPatchRoute = (transport: SettingsPatchTransport): SettingsPatchRoute => {
    const store = createSettingsStore({
        area: null, localArea: null, onChanged: null,
        sendMessage: (message: SettingsPatchRequest) => transport(message),
    });
    return { set: patch => store.set(patch) };
};
