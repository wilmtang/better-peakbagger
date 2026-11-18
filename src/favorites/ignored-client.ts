// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as I from './ignored-climbers.ts';
import type { IgnoredClimbersList } from './ignored-climbers.ts';

export interface ObservedIgnoredState {
    list: IgnoredClimbersList | null;
    error: string;
}

export interface IgnoredStorageChange {
    newValue?: unknown;
    oldValue?: unknown;
}

export interface IgnoredStorageApi {
    storage: {
        local: {
            get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
        };
        onChanged: {
            addListener(listener: (changes: Record<string, IgnoredStorageChange>, areaName: string) => void): void;
            removeListener(listener: (changes: Record<string, IgnoredStorageChange>, areaName: string) => void): void;
        };
    };
}

export interface IgnoredObserver {
    refresh(): Promise<void>;
    stop(): void;
}

export interface IgnoredRuntimeApi {
    runtime: {
        sendMessage(message: unknown): Promise<unknown>;
    };
}

export interface MutateIgnoredResponse {
    ok: boolean;
    error?: { message?: string };
    [key: string]: unknown;
}

// Subscribe before reading; an older async read cannot overwrite a newer
// notification. A later failure retains the last valid list.
export const observeIgnored = (
    api: IgnoredStorageApi,
    onState: (state: ObservedIgnoredState) => void,
): IgnoredObserver => {
    let generation = 0;
    let list: IgnoredClimbersList | null = null;
    let stopped = false;
    const publish = (value: unknown): void => {
        const valid = I.readList(value);
        if (valid && (!list || valid.revision >= list.revision)) list = valid;
        onState({ list, error: valid ? '' : "Couldn't load ignored climbers." });
    };
    const changed = (changes: Record<string, IgnoredStorageChange>, area: string): void => {
        if (area !== 'local' || !changes[I.IGNORED_KEY] || stopped) return;
        generation++;
        publish(changes[I.IGNORED_KEY].newValue);
    };
    api.storage.onChanged.addListener(changed);
    const refresh = async (): Promise<void> => {
        const token = ++generation;
        try {
            const values = await api.storage.local.get(I.IGNORED_KEY);
            if (!stopped && generation === token) publish(values[I.IGNORED_KEY]);
        } catch {
            if (!stopped && generation === token) onState({ list, error: "Couldn't load ignored climbers." });
        }
    };
    void refresh();
    return { refresh, stop: () => { stopped = true; generation++; api.storage.onChanged.removeListener(changed); } };
};
export const mutateIgnored = async (
    api: IgnoredRuntimeApi,
    mutation: unknown,
): Promise<MutateIgnoredResponse> => {
    const raw = await api.runtime.sendMessage({ type: I.MUTATE_MESSAGE, mutation });
    const response = raw && typeof raw === 'object' ? raw as Partial<MutateIgnoredResponse> : null;
    if (!response?.ok) throw new Error(response?.error?.message || 'Ignored climbers could not be saved. Try again.');
    return response as MutateIgnoredResponse;
};
