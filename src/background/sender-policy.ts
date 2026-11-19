// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface PackagedPageExtension {
    runtime?: {
        id?: string;
        getURL?: (path: string) => string;
    } | null;
}

export interface PackagedPageSender {
    id?: string;
    url?: string;
    frameId?: number | null;
    tab?: { id?: number | null } | null;
}

export type PackagedPageMatcher = (sender: PackagedPageSender | null | undefined) => boolean;

// Web-accessible extension frames are not privileged UI surfaces. Compare
// explicit packaged paths and browser-owned identity, rather than an origin
// prefix. Popup/embedded-options contexts can omit tab and frame metadata;
// messages associated with a tab must identify its top frame.
export const createPackagedPageMatcher = (
    ext: PackagedPageExtension | null | undefined,
    pages: readonly string[],
): PackagedPageMatcher => {
    const expected = typeof ext?.runtime?.getURL === 'function'
        ? pages.map(page => new URL(ext.runtime!.getURL!(page))) : [];
    return sender => {
        if (!ext?.runtime?.id || !sender || sender.id !== ext.runtime.id) return false;
        if (sender.tab ? !Number.isInteger(sender.tab.id) || sender.frameId !== 0
            : sender.frameId != null && sender.frameId !== 0) return false;
        try {
            const actual = new URL(sender.url ?? '');
            return !actual.username && !actual.password && expected.some(page =>
                actual.protocol === page.protocol && actual.host === page.host
                && actual.pathname === page.pathname);
        } catch { return false; }
    };
};
