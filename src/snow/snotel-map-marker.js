// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { snotelReportUrl } from './snotel-data.js';
import { units } from '../ui/units.js';

// Inline SVG keeps the same unique symbol inside the native Leaflet document
// and the isolated MapLibre frame, without fetching icons or changing native CSS.
export function snotelSymbol(doc) {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '24'); svg.setAttribute('height', '24');
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    svg.style.cssText = 'display:block;filter:drop-shadow(0 1px 2px #0005)';
    const shape = doc.createElementNS(svg.namespaceURI, 'path');
    shape.setAttribute('d', 'M12 1 22 6.5v11L12 23 2 17.5v-11Z');
    shape.setAttribute('fill', '#176a9c'); shape.setAttribute('stroke', '#fff'); shape.setAttribute('stroke-width', '1.5');
    const snow = doc.createElementNS(svg.namespaceURI, 'path');
    snow.setAttribute('d', 'M12 5v14M6 8.5l12 7M6 15.5l12-7M9.5 6.5 12 9l2.5-2.5M9.5 17.5 12 15l2.5 2.5');
    snow.setAttribute('fill', 'none'); snow.setAttribute('stroke', '#fff'); snow.setAttribute('stroke-width', '1.5'); snow.setAttribute('stroke-linecap', 'round');
    svg.append(shape, snow); return svg;
}

export function snotelPopup(doc, station) {
    const content = doc.createElement('div'); content.className = 'bpb-snotel-popup';
    content.style.cssText = 'font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:220px;overflow-wrap:anywhere';
    const title = doc.createElement('strong'); title.textContent = station.name;
    const info = doc.createElement('div');
    info.textContent = `SNOTEL · ${Math.round(station.elevation).toLocaleString()} m / ${Math.round(station.elevation * units.FEET_PER_METER).toLocaleString()} ft`;
    const link = doc.createElement('a'); link.textContent = 'View NRCS snow data'; link.href = snotelReportUrl(station);
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    content.append(title, info, link); return content;
}

export function createTerrainSnotelMarkers({ maplibre, document: doc }) {
    let markers = [], openPopup = null;
    const closePopup = () => { if (!openPopup) return false; openPopup.remove(); openPopup = null; return true; };
    const clear = () => { closePopup(); for (const marker of markers) marker.remove(); markers = []; };
    return {
        clear, closePopup,
        replace(map, stations) {
            clear();
            if (!stations.length) return true;
            if (!map || typeof maplibre.Marker !== 'function' || typeof maplibre.Popup !== 'function') return false;
            try {
                for (const station of stations) {
                    const button = doc.createElement('button'); button.type = 'button'; button.className = 'bpb-snotel-marker';
                    button.style.cssText = 'padding:0;border:0;background:transparent;width:24px;height:24px;cursor:pointer';
                    button.title = `${station.name} · SNOTEL`; button.setAttribute('aria-label', button.title); button.append(snotelSymbol(doc));
                    const popup = new maplibre.Popup({ className: 'bpb-snotel-map-popup', focusAfterOpen: false,
                        maxWidth: 'min(260px, calc(100vw - var(--bpb-snow-popup-right) - 24px))' })
                        .setDOMContent(snotelPopup(doc, station));
                    popup.on('close', () => { if (openPopup === popup) openPopup = null; });
                    // Own activation as the summit buttons do. Native buttons
                    // provide one keyboard click; MapLibre's marker popup path
                    // also installs legacy keypress and map-click handlers.
                    button.addEventListener('click', event => {
                        event.stopPropagation();
                        if (openPopup === popup) { closePopup(); return; }
                        closePopup(); openPopup = popup;
                        popup.setLngLat([station.longitude, station.latitude]).addTo(map);
                    });
                    const marker = new maplibre.Marker({ element: button, anchor: 'center', opacityWhenCovered: 1 })
                        .setLngLat([station.longitude, station.latitude]).addTo(map);
                    markers.push(marker);
                }
                return true;
            } catch { clear(); return false; }
        },
    };
}
