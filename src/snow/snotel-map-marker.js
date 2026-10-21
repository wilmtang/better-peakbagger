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

export function snotelPopup(doc, station, onSelect) {
    const content = doc.createElement('div'); content.className = 'bpb-snotel-popup';
    content.style.cssText = 'font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:220px;overflow-wrap:anywhere';
    const title = doc.createElement('strong'); title.textContent = station.name;
    const info = doc.createElement('div');
    info.textContent = `SNOTEL · ${Math.round(station.elevation).toLocaleString()} m / ${Math.round(station.elevation * units.FEET_PER_METER).toLocaleString()} ft`;
    const link = doc.createElement('a'); link.textContent = 'View NRCS snow data'; link.href = snotelReportUrl(station);
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    content.append(title, info);
    if (onSelect) {
        const action = doc.createElement('button'); action.type = 'button'; action.className = 'bpb-snotel-show-conditions';
        action.textContent = 'Show conditions'; action.setAttribute('aria-label', `Show conditions at ${station.name}`);
        action.style.cssText = 'display:block;margin:6px 0;font:inherit;padding:4px 8px;cursor:pointer';
        action.addEventListener('click', event => { event.stopPropagation(); onSelect(station.id); });
        content.append(action);
    }
    content.append(link); return content;
}

export function createTerrainSnotelMarkers({ maplibre, document: doc, onSelect, canSelect = () => true }) {
    let markers = [], openPopup = null, currentKey = '';
    const closePopup = () => { if (!openPopup) return false; openPopup.remove(); openPopup = null; return true; };
    const clear = () => { closePopup(); for (const marker of markers) marker.remove(); markers = []; currentKey = ''; };
    return {
        clear, closePopup,
        replace(map, stations) {
            const key = JSON.stringify(stations.map(station => [station, canSelect(station.id)]));
            if (key === currentKey) return true;
            clear();
            if (!stations.length) return true;
            if (!map || typeof maplibre.Marker !== 'function' || typeof maplibre.Popup !== 'function') return false;
            try {
                for (const station of stations) {
                    const button = doc.createElement('button'); button.type = 'button'; button.className = 'bpb-snotel-marker';
                    button.style.cssText = 'padding:0;border:0;background:transparent;width:24px;height:24px;cursor:pointer';
                    button.title = `${station.name} · SNOTEL`; button.setAttribute('aria-label', button.title); button.append(snotelSymbol(doc));
                    const popup = new maplibre.Popup({ className: 'bpb-snotel-map-popup', focusAfterOpen: false,
                        anchor: 'bottom', offset: 16, maxWidth: 'min(260px, calc(100vw - var(--bpb-snotel-popup-margin, 80px)))' })
                        .setDOMContent(snotelPopup(doc, station, canSelect(station.id) ? onSelect : undefined));
                    popup.on('close', () => { if (openPopup === popup) openPopup = null; });
                    // Own activation as the summit buttons do. Native buttons
                    // provide one keyboard click; MapLibre's marker popup path
                    // also installs legacy keypress and map-click handlers.
                    button.addEventListener('click', event => {
                        event.stopPropagation();
                        if (openPopup === popup) { closePopup(); return; }
                        closePopup(); openPopup = popup;
                        popup.setLngLat([station.longitude, station.latitude]).addTo(map);
                        // Preserve the geographic arrow. Pan only enough to
                        // expose an edge popup below the top controls and to
                        // the left of the navigation stack.
                        const element = popup.getElement?.(), container = map.getContainer?.();
                        if (element && container && typeof map.panTo === 'function') {
                            const r = element.getBoundingClientRect(), bounds = container.getBoundingClientRect();
                            const rightInset = bounds.height < 300 ? 106 : 58;
                            const dx = Math.min(0, r.left - bounds.left - 12) || Math.max(0, r.right - bounds.right + rightInset);
                            const dy = Math.min(0, r.top - bounds.top - 88) || Math.max(0, r.bottom - bounds.bottom + 32);
                            if (dx || dy) {
                                const pin = button.getBoundingClientRect();
                                map.panTo([station.longitude, station.latitude], { duration: 0,
                                    offset: [pin.left + pin.width / 2 - bounds.left - bounds.width / 2 - dx,
                                        pin.top + pin.height / 2 - bounds.top - bounds.height / 2 - dy] });
                            }
                        }
                    });
                    const marker = new maplibre.Marker({ element: button, anchor: 'center', opacityWhenCovered: 1 })
                        .setLngLat([station.longitude, station.latitude]).addTo(map);
                    markers.push(marker);
                }
                currentKey = key; return true;
            } catch { clear(); return false; }
        },
    };
}
