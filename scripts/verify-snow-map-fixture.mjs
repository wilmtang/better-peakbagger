// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export async function snowMapDocument() {
    const [js, css] = await Promise.all([
        ['js', '20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo='],
        ['css', 'p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY='],
    ].map(async ([extension, hash]) => {
        const response = await fetch(`https://unpkg.com/leaflet@1.9.4/dist/leaflet.${extension}`, { signal: AbortSignal.timeout(30_000) });
        assert.equal(response.ok, true, `Leaflet ${extension}`);
        const body = Buffer.from(await response.arrayBuffer());
        assert.equal(createHash('sha256').update(body).digest('base64'), hash, `pinned Leaflet ${extension}`);
        return body.toString();
    }));
    return `<!doctype html><html><head><style>${css}
        html,body,#map{height:100%;margin:0} #map{background:#dce6d7}
        #selmap{position:absolute;top:10px;left:10px;z-index:1000}
        </style></head><body><div id="map"></div>
        <select id="selmap"><option value="L_FIX">Fixture topographic map</option></select>
        <script>${js.replace(/<\/script/gi, '<\\/script')}</script><script>
        window.mapsPlaceholder=L.map('map',{zoomControl:false}).setView([46.851731,-121.760395],10);
        L.control.zoom({position:'bottomright'}).addTo(mapsPlaceholder);
        L.circleMarker([46.851731,-121.760395],{radius:6,color:'#be2649',fillOpacity:1}).addTo(mapsPlaceholder);
        L.polyline([[46.83,-121.77],[46.85,-121.76]],{color:'#be2649'}).addTo(mapsPlaceholder);
        window.nativeLayers=[];mapsPlaceholder.eachLayer(layer=>nativeLayers.push(layer));
        </script></body></html>`;
}

// Same deterministic, non-flat Terrarium fixture as verify-terrain-visual.
export const snowMapDem = Buffer.from('UklGRoIAAABXRUJQVlA4THYAAAAv/8F/AD8gFkzyR94dhICgyHPTY/6zQwZFtW1TKqigggoqqKCC/rM/wx3R/wkI/M//A+P38h+YpefnP1DLz8t/4Fauz38gV4/Pf2DXtuc/0OvT+Y//+I/41uc/wDsv/wHdffkP4N6T/4DtvfkP0P6T/4CM/8Ef', 'base64');
