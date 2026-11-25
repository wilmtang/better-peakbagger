// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
export const INSTAGRAM_DISPLAY_ORIGINS = ['https://www.instagram.com/*'];
export const INSTAGRAM_DISPLAY_ID = 'bpb-instagram-display-v1';

export interface InstagramDisplayRegistrationScript {
    id: string;
    matches?: string[];
    allFrames?: boolean;
    runAt?: 'document_start' | 'document_end' | 'document_idle';
    persistAcrossSessions?: boolean;
    js?: string[];
    css?: string[];
}

export interface InstagramDisplayRegistrationApi {
    permissions?: {
        contains?(permissions: { origins: string[] }): Promise<boolean>;
        onAdded?: { addListener(listener: () => void): void };
        onRemoved?: { addListener(listener: () => void): void };
    };
    scripting?: {
        getRegisteredContentScripts?(filter: { ids: string[] }): Promise<readonly unknown[]>;
        registerContentScripts?(scripts: InstagramDisplayRegistrationScript[]): Promise<void>;
        unregisterContentScripts?(filter: { ids: string[] }): Promise<void>;
    };
}

export interface CreateInstagramDisplayRegistrationOptions {
    onChanged?: (allowed: boolean) => void;
}

export interface InstagramDisplayRegistration {
    sync(): Promise<boolean>;
}

// The worker owns registration. Permission is the source of truth; there is no
// synced preference that could silently grant access on another device.
export function createInstagramDisplayRegistration(
    api: InstagramDisplayRegistrationApi,
    { onChanged = () => {} }: CreateInstagramDisplayRegistrationOptions = {},
): InstagramDisplayRegistration {
    let queue: Promise<unknown> = Promise.resolve();
    const sync = (): Promise<boolean> => {
        const work = queue.then(async () => {
            if (!api.permissions?.contains || !api.scripting?.getRegisteredContentScripts) return false;
            const allowed = await api.permissions.contains({ origins: INSTAGRAM_DISPLAY_ORIGINS });
            const registered = await api.scripting.getRegisteredContentScripts({ ids: [INSTAGRAM_DISPLAY_ID] });
            if (allowed && !registered.length) await api.scripting.registerContentScripts?.([{
                id: INSTAGRAM_DISPLAY_ID, matches: [
                    'https://www.instagram.com/p/*/embed/captioned/*',
                    'https://www.instagram.com/reel/*/embed/captioned/*',
                ], allFrames: true, runAt: 'document_start', persistAcrossSessions: true,
                js: ['content/instagram-provider.js'], css: ['css/instagram-provider.css'],
            }]);
            if (!allowed && registered.length) await api.scripting.unregisterContentScripts?.({ ids: [INSTAGRAM_DISPLAY_ID] });
            return allowed;
        });
        queue = work.catch(() => {});
        return work;
    };
    const changed = (): void => { void sync().then(onChanged).catch(() => {}); };
    api.permissions?.onAdded?.addListener(changed);
    api.permissions?.onRemoved?.addListener(changed);
    changed();
    return { sync };
}
