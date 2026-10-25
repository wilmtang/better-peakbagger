// Experiment only. Fixed-schema fixture reader, not a production GeoPackage importer.
import initSQLite from '@sqlite.org/sqlite-wasm';
import JSZip from 'jszip';

let SQL, db, dataPointer = 0;
const MAX_ZIP = 8 * 1024 * 1024, MAX_DECODED = 32 * 1024 * 1024;
function polygon(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 53 || bytes[0] !== 71 || bytes[1] !== 80 || bytes[2] !== 0
        || bytes[3] !== 3 || view.getInt32(4, true) !== 4326) throw new Error('Unsupported GeoPackage geometry');
    const bounds = [view.getFloat64(8, true), view.getFloat64(24, true), view.getFloat64(16, true), view.getFloat64(32, true)];
    let offset = 40;
    if (view.getUint8(offset++) !== 1 || view.getUint32(offset, true) !== 3) throw new Error('Unsupported WKB');
    offset += 4;
    const rings = view.getUint32(offset, true); offset += 4;
    if (!rings || rings > 100) throw new Error('Invalid ring count');
    const coordinates = [];
    for (let ring = 0; ring < rings; ring++) {
        const count = view.getUint32(offset, true); offset += 4;
        if (count < 4 || count > 10000 || offset + count * 16 > bytes.length) throw new Error('Invalid vertex count');
        const points = [];
        for (let index = 0; index < count; index++) {
            const x = view.getFloat64(offset, true), y = view.getFloat64(offset + 8, true); offset += 16;
            if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 180 || Math.abs(y) > 90) throw new Error('Invalid coordinate');
            points.push([x, y]);
        }
        if (points[0][0] !== points.at(-1)[0] || points[0][1] !== points.at(-1)[1]) throw new Error('Open ring');
        coordinates.push(points);
    }
    if (offset !== bytes.length) throw new Error('Unexpected trailing geometry');
    return { bounds, geometry: { type: 'Polygon', coordinates } };
}
function query(bounds) {
    if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)
        || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) throw new Error('Invalid view');
    const started = performance.now(), features = [];
    const statement = db.prepare(`SELECT m.id,m.h3_res9_id,m.geom FROM sample_bounds b JOIN mobile m ON m.id=b.id
        WHERE b.min_x<=? AND b.max_x>=? AND b.min_y<=? AND b.max_y>=? ORDER BY m.id`);
    try {
        statement.bind([bounds[2], bounds[0], bounds[3], bounds[1]]);
        while (statement.step()) {
            const [id, h3, bytes] = statement.get([]), decoded = polygon(bytes), b = decoded.bounds;
            // SQLite R-tree rounds outward to float32. Filter its candidates exactly.
            if (b[0] > bounds[2] || b[2] < bounds[0] || b[1] > bounds[3] || b[3] < bounds[1]) continue;
            features.push({ type: 'Feature', id, properties: { h3 }, geometry: decoded.geometry });
        }
    } finally { statement.finalize(); }
    return { collection: { type: 'FeatureCollection', features }, queryMs: performance.now() - started };
}
self.onmessage = async ({ data }) => {
    const { id, type } = data;
    try {
        if (type === 'load') {
            const started = performance.now();
            SQL ||= await initSQLite({ locateFile: () => '/sqlite3.wasm' });
            const response = await fetch(data.url);
            if (!response.ok) throw new Error(`Archive HTTP ${response.status}`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.length > MAX_ZIP) throw new Error('Archive too large');
            const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
            const files = Object.values(zip.files).filter(file => !file.dir);
            if (files.length !== 1 || files[0].name !== 'sample.gpkg') throw new Error('Unexpected archive layout');
            // This experiment trusts its generated fixture; this metadata ceiling
            // is not a substitute for a production streaming decompression limit.
            if (files[0]._data.uncompressedSize > MAX_DECODED) throw new Error('Decoded fixture too large');
            const unpacked = await files[0].async('uint8array');
            if (unpacked.length > MAX_DECODED) throw new Error('Decoded fixture too large');
            const next = new SQL.oo1.DB();
            const pointer = SQL.wasm.allocFromTypedArray(unpacked);
            try {
                // Keep the allocation caller-owned and read-only. Do not ask
                // SQLite's allocator to free a JS/WASM allocator's buffer.
                const code = SQL.capi.sqlite3_deserialize(next.pointer, 'main', pointer,
                    unpacked.length, unpacked.length, SQL.capi.SQLITE_DESERIALIZE_READONLY);
                if (code !== SQL.capi.SQLITE_OK) throw new Error(`Deserialize failed: ${code}`);
                const rows = next.exec({ sql: 'SELECT count(*) FROM mobile', returnValue: 'resultRows' })[0][0];
                if (!Number.isSafeInteger(rows) || rows < 1 || rows > 100000) throw new Error('Invalid fixture count');
                db?.close(); if (dataPointer) SQL.wasm.dealloc(dataPointer);
                db = next; dataPointer = pointer;
                self.postMessage({ id, ok: true, rows, archiveBytes: bytes.length, decodedBytes: unpacked.length,
                    wasmHeapBytes: SQL.wasm.heap8u().byteLength, loadMs: performance.now() - started });
            } catch (error) { next.close(); SQL.wasm.dealloc(pointer); throw error; }
        } else if (type === 'view') self.postMessage({ id, ok: true, ...query(data.bounds) });
        else if (type === 'dispose') {
            db?.close(); db = null;
            if (dataPointer) SQL.wasm.dealloc(dataPointer); dataPointer = 0;
            self.postMessage({ id, ok: true });
        }
        else throw new Error('Unknown experiment operation');
    } catch (error) { self.postMessage({ id, ok: false, error: String(error.message).slice(0, 200) }); }
};
