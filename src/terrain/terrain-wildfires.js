// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createWildfireSession } from '../maps/wildfire-session.js';
import { wildfireDetails } from '../maps/wildfire-details.js';
import { wildfireRecords, WILDFIRE_SOURCE } from '../maps/wildfire-core.js';
export function createTerrainWildfires({ map, maplibre, document: doc, onStatus }) {
    const source = 'bpb-wildfires', layers = ['bpb-fire-fill', 'bpb-fire-outline', 'bpb-fire-points'];
    let data = { type: 'FeatureCollection', features: [] }, records = new Map(), popup = null, disposed = false;
    const remove = () => { popup?.remove(); popup = null; for (const id of [...layers].reverse()) if (map.getLayer(id)) map.removeLayer(id); if (map.getSource(source)) map.removeSource(source); };
    const paint = () => {
        if (disposed || !data.features.length) { remove(); return; }
        const before = map.getStyle().layers.find(layer => layer.type === 'symbol' || /^(bpb-route|bpb-peaks|bpb-highlight)/.test(layer.id))?.id;
        if (!map.getSource(source)) map.addSource(source, { type: 'geojson', data, attribution: `<a href="${WILDFIRE_SOURCE}">NIFC/WFIGS</a>` });
        else map.getSource(source).setData(data);
        const definitions = [
            { id: layers[0], type: 'fill', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#e66b39', 'fill-opacity': .18 } },
            { id: layers[1], type: 'line', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'line-color': '#c5412c', 'line-width': 2 } },
            { id: layers[2], type: 'circle', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-color': '#c5412c', 'circle-radius': 6, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2, 'circle-pitch-alignment': 'map' } },
        ];
        for (const definition of definitions) {
            if (!map.getLayer(definition.id)) map.addLayer({ ...definition, source }, before);
            else if (before) map.moveLayer(definition.id, before);
        }
    };
    const click = event => {
        if (!layers.some(id => map.getLayer(id)) || event.originalEvent?.target?.closest?.('.maplibregl-marker, .maplibregl-popup, .maplibregl-ctrl')) return;
        const hits = map.queryRenderedFeatures(event.point);
        if (hits.some(feature => /^(bpb-route|bpb-peaks|bpb-highlight)/.test(feature.layer?.id))) return;
        const feature = hits.find(hit => layers.includes(hit.layer?.id)); if (!feature) return;
        const fire = records.get(feature.properties.id); if (!fire) return;
        const content = doc.createElement('div'), name = doc.createElement('strong'); name.textContent = fire.name; content.append(name, wildfireDetails(doc, fire));
        popup?.remove(); popup = new maplibre.Popup({ maxWidth: '280px' }).setLngLat(event.lngLat).setDOMContent(content).addTo(map);
    };
    const session = createWildfireSession({ document: doc, readView: () => ({ bounds: map.getBounds(), zoom: map.getZoom() + 1 }), onStatus,
        onData(result) { data = { type: 'FeatureCollection', features: [...result.perimeters, ...result.incidents] };
            records = new Map(wildfireRecords(result.incidents, result.perimeters).map(record => [record.id, record]));
            for (const feature of result.perimeters) if (!records.has(feature.id)) records.set(feature.id, { ...feature.properties, hasPerimeter: true });
            paint(); },
    });
    const moving = () => session.moving(); map.on('movestart', moving); map.on('click', click);
    return { update: session.update, retry: session.retry, refresh: session.refresh, paint,
        dispose() { disposed = true; session.dispose(); remove(); map.off('movestart', moving); map.off('click', click); } };
}
