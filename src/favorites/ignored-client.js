// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as I from './ignored-climbers.js';

// Subscribe before reading; an older async read cannot overwrite a newer
// notification. A later failure retains the last valid list.
export const observeIgnored = (api, onState) => {
    let generation = 0, list = null, stopped = false;
    const publish = value => {
        const valid = I.readList(value);
        if (valid && (!list || valid.revision >= list.revision)) list = valid;
        onState({ list, error: valid ? '' : "Couldn't load ignored climbers." });
    };
    const changed = (changes, area) => {
        if (area !== 'local' || !changes[I.IGNORED_KEY] || stopped) return;
        generation++;
        publish(changes[I.IGNORED_KEY].newValue);
    };
    api.storage.onChanged.addListener(changed);
    const refresh = async () => {
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
export const mutateIgnored = async (api, mutation) => {
    const response = await api.runtime.sendMessage({ type: I.MUTATE_MESSAGE, mutation });
    if (!response?.ok) throw new Error(response?.error?.message || 'Ignored climbers could not be saved. Try again.');
    return response;
};
