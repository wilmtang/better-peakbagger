import * as maplibregl from 'maplibre-gl';

maplibregl.setWorkerUrl('/maplibre-gl-worker.mjs');
const worker = new Worker('/worker.js', { type: 'module' }), pending = new Map();
let request = 0, generation = 0, currentEngine = 'leaflet';
const results = [], errors = [];
window.addEventListener('error', event => errors.push(event.message));
const rpc = (type, detail = {}) => new Promise((resolve, reject) => {
    const id = ++request, timeout = setTimeout(() => { pending.delete(id); reject(new Error('Worker deadline')); }, 15000);
    pending.set(id, { resolve, reject, timeout }); worker.postMessage({ id, type, ...detail });
});
worker.onmessage = ({ data }) => {
    const entry = pending.get(data.id); if (!entry) return;
    clearTimeout(entry.timeout); pending.delete(data.id);
    if (data.ok) entry.resolve(data); else entry.reject(new Error(data.error));
};
const leaflet = window.L.map('leaflet', { zoomControl: false, attributionControl: false }).setView([34.87, -111.76], 13);
leaflet.createPane('coverage'); leaflet.getPane('coverage').style.zIndex = '350';
const overlay = window.L.geoJSON(null, { pane: 'coverage', interactive: false, style: { fillColor: '#286e4a', fillOpacity: 0.4, color: '#286e4a', weight: 0.7 } }).addTo(leaflet);
const nativeRoute = window.L.polyline([[34.85, -111.80], [34.88, -111.74]], { color: '#d13b34', weight: 4 }).addTo(leaflet);
const map = new maplibregl.Map({ container: 'maplibre', center: [-111.76, 34.87], zoom: 12,
    attributionControl: false, interactive: true, fadeDuration: 0, style: { version: 8, sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e5e7e3' } }] } });
const mapReady = new Promise(resolve => map.on('load', () => {
    map.addSource('coverage', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'coverage', type: 'fill', source: 'coverage', paint: { 'fill-color': '#286e4a', 'fill-opacity': 0.4 } });
    map.addSource('route', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString',
        coordinates: [[-111.80, 34.85], [-111.74, 34.88]] } } });
    map.addLayer({ id: 'route', type: 'line', source: 'route', paint: { 'line-color': '#d13b34', 'line-width': 4 } });
    resolve();
}));
let active = false;
const viewBounds = () => {
    const bounds = currentEngine === 'leaflet' ? leaflet.getBounds() : map.getBounds();
    return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
};
async function refresh() {
    if (!active) return;
    const revision = ++generation, engine = currentEngine, bounds = viewBounds(), start = performance.now();
    const answer = await rpc('view', { bounds });
    if (revision !== generation || engine !== currentEngine) return;
    const renderStart = performance.now();
    if (engine === 'leaflet') {
        overlay.clearLayers(); overlay.addData(answer.collection);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    } else {
        await new Promise(resolve => {
            map.once('idle', resolve); map.getSource('coverage').setData(answer.collection);
        });
    }
    if (revision !== generation || engine !== currentEngine) return;
    const result = { engine, bounds, ids: answer.collection.features.map(feature => feature.id),
        queryMs: answer.queryMs, renderMs: performance.now() - renderStart, totalMs: performance.now() - start,
        nativeRoutePresent: engine === 'leaflet' ? leaflet.hasLayer(nativeRoute) : Boolean(map.getLayer('route')) };
    results.push(result);
    document.getElementById('status').textContent = `${result.ids.length.toLocaleString()} coverage records in view`;
}
leaflet.on('moveend', () => void refresh().catch(error => errors.push(error.message)));
map.on('moveend', () => void refresh().catch(error => errors.push(error.message)));
window.experiment = {
    results, errors, rpc, mapReady, map, leaflet,
    async load() {
        await mapReady;
        const result = await rpc('load', { url: '/sample.zip' }); active = true;
        await refresh(); return result;
    },
    async engine(value) {
        if (!['leaflet', 'maplibre'].includes(value)) throw new Error('Unknown renderer');
        currentEngine = value; generation++;
        document.getElementById('leaflet').hidden = value !== 'leaflet';
        document.getElementById('maplibre').hidden = value !== 'maplibre';
        if (value === 'leaflet') leaflet.invalidateSize(); else map.resize();
        await refresh();
    },
    async move(x, y, zoom) {
        if (currentEngine === 'leaflet') leaflet.setView([y, x], zoom, { animate: false });
        else map.jumpTo({ center: [x, y], zoom: zoom - 1 });
    },
    dispose() { active = false; generation++; worker.terminate(); leaflet.remove(); map.remove(); },
};
