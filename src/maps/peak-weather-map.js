// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Runs in MAIN world: map-owned projection stays here; the weather card and
// all fetching stay isolated. Bind the frame document, rather than polling for
// Leaflet or installing a map handler that suppresses menus when weather is off.
export function createPeakWeatherMap({ getFrame, getMap }) {
    let doc = null;
    const post = detail => window.postMessage({ __bpbPeakWeather: true, ...detail }, location.origin);
    const dismiss = () => post({ type: 'dismiss' });
    const context = event => {
        const card = document.getElementById('bpb-peak-weather');
        if (!card || card.hidden || event.target.closest?.('.leaflet-control, a, button, input, select')) return;
        try {
            const map = getMap();
            if (typeof map?.mouseEventToLatLng !== 'function') return;
            const point = map.mouseEventToLatLng(event), frame = getFrame(), rect = frame.getBoundingClientRect();
            if (!Number.isFinite(point?.lat) || Math.abs(point.lat) > 90 || !Number.isFinite(point.lng)) return;
            const longitude = ((point.lng + 180) % 360 + 360) % 360 - 180;
            event.preventDefault();
            post({ type: 'context', map: 'native', latitude: point.lat, longitude,
                x: rect.left + frame.clientLeft + event.clientX, y: rect.top + frame.clientTop + event.clientY });
        } catch { /* An unavailable/replaced frame retains its native menu. */ }
    };
    const suspend = () => {
        doc?.removeEventListener('contextmenu', context, true);
        doc?.removeEventListener('pointerdown', dismiss, true);
        doc?.removeEventListener('wheel', dismiss, true);
        doc?.removeEventListener('scroll', dismiss, true);
        doc = null; dismiss();
    };
    const attach = () => {
        suspend();
        try { doc = getFrame().contentDocument; } catch { return; }
        doc?.addEventListener('contextmenu', context, true);
        doc?.addEventListener('pointerdown', dismiss, true);
        doc?.addEventListener('wheel', dismiss, { capture: true, passive: true });
        doc?.addEventListener('scroll', dismiss, true);
    };
    attach();
    return { attach, suspend };
}
