// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createMapFrameLifecycle } from '../gpx/map-frame-lifecycle.js';

// Shared by top-level Leaflet maps and the native MasterMap iframe. Repaint
// controls and popups only; the full site theme would repaint the map itself.
export const nativeMapDarkCss = `
html[data-bpb-theme="dark"] #selmap,
html[data-bpb-theme="dark"] #selmap option {
    color-scheme: dark;
    background: #26362c !important;
    color: #eeeade !important;
}
html[data-bpb-theme="dark"] #selboxdiv {
    color-scheme: dark;
    background: #1e2b23 !important;
    color: #eeeade !important;
    border-color: #384a3e !important;
}
html[data-bpb-theme="dark"] #selmap {
    border-color: #526752 !important;
}
html[data-bpb-theme="dark"] #selmap:focus-visible {
    outline: 2px solid #79b8ff;
    outline-offset: -2px;
}
html[data-bpb-theme="dark"] .leaflet-popup { color-scheme: dark; }
html[data-bpb-theme="dark"] .leaflet-popup-content-wrapper,
html[data-bpb-theme="dark"] .leaflet-popup-tip {
    background: #272c29 !important;
    color: #e2ded5 !important;
}
html[data-bpb-theme="dark"] .leaflet-popup a:not(.leaflet-popup-close-button) {
    color: #aad0ff !important;
}
html[data-bpb-theme="dark"] .leaflet-popup a.leaflet-popup-close-button {
    color: #e2ded5 !important;
}
html[data-bpb-theme="dark"] .leaflet-popup button {
    background: #343b37 !important;
    color: #e2ded5 !important;
    border-color: #637582 !important;
}
html[data-bpb-theme="dark"] .leaflet-popup a:focus-visible,
html[data-bpb-theme="dark"] .leaflet-popup button:focus-visible {
    outline: 2px solid #aad0ff;
    outline-offset: 2px;
}
`;

export const createNativeMapTheme = ({ document: ownerDocument }) => {
    let theme = 'light';
    const lifecycle = createMapFrameLifecycle({
        selector: 'iframe[src*="mastermap.aspx" i]',
        document: ownerDocument,
        MutationObserver: ownerDocument.defaultView.MutationObserver,
    });
    const apply = frame => {
        if (!frame) return;
        try {
            const url = new URL(frame.src, ownerDocument.baseURI);
            if (url.protocol !== 'https:' || url.origin !== ownerDocument.location.origin
                || !/\/mastermap\.aspx$/i.test(url.pathname)) return;
            const doc = frame.contentDocument;
            if (!doc?.documentElement) return;
            // Install the sheet before its theme attribute, including after a
            // native map reload. Never inject the broad site/early fallback.
            if (!doc.getElementById('bpb-native-map-popup-theme')) {
                const style = doc.createElement('style');
                style.id = 'bpb-native-map-popup-theme';
                style.textContent = nativeMapDarkCss;
                (doc.head || doc.documentElement).append(style);
            }
            doc.documentElement.setAttribute('data-bpb-theme', theme);
        } catch { /* A map navigating away from this origin is not ours. */ }
    };
    lifecycle.subscribe(({ frame }) => apply(frame));
    lifecycle.start();
    return {
        setTheme(value) { theme = value === 'dark' ? 'dark' : 'light'; apply(lifecycle.current()); },
        dispose: () => lifecycle.dispose(),
    };
};
