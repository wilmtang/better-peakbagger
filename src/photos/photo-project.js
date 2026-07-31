// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — pure, versioned topo-photo project model.
//
// The editor, IndexedDB loader, GitHub restore path, and renderer all clean
// projects through this one module. It intentionally has no DOM, canvas,
// browser-API, storage, or network dependency.

const SCHEMA_VERSION = 1;
const MAX_OBJECTS = 500;
const MAX_ROUTE_POINTS = 2000;
const MAX_PROJECT_POINTS = 5000;
const MAX_TEXT_LENGTH = 500;
const MAX_ID_LENGTH = 100;
// A decoded image is at least four bytes per pixel before the browser adds the
// source bitmap, canvas backing store, overlay, and encoded output. Sixty-four
// megapixels admits current 48 MP cameras and a 16,000 × 4,000 panorama while
// bounding the primary RGBA allocation at about 244 MiB. The axis cap also
// rejects pathological thin images that fit the area budget but exceed
// cross-browser canvas limits.
const MAX_DIMENSION = 16_384;
const MAX_PIXELS = 64_000_000;
const MAX_LINE_WIDTH = 100;
const MAX_SCALE = 10;
// Fully opaque marks hide the beta underneath them, so every object carries an
// opacity. The floor keeps a mark visible: below it the object looks lost
// rather than translucent, and the user cannot find it again to fix it.
const MIN_OPACITY = 0.1;
const DEFAULT_COLOR = '#e53935';
const PALETTE = Object.freeze([
    '#e53935',
    '#fb8c00',
    '#fdd835',
    '#43a047',
    '#00acc1',
    '#1e88e5',
    '#8e24aa',
    '#ffffff',
    '#000000',
]);
const OBJECT_TYPES = Object.freeze([
    'route',
    'bolt',
    'anchor',
    'piton',
    'rappel',
    'belay',
    'pitch',
    'text',
]);
const MARKER_TYPES = Object.freeze(['bolt', 'anchor', 'piton', 'rappel', 'belay']);
const STROKES = new Set(['solid', 'dashed', 'dotted']);
const ENDS = new Set(['none', 'arrow']);
const ALIGNS = new Set(['left', 'center', 'right']);
const EXPORT_MIMES = new Set(['image/jpeg', 'image/png']);
const EXPORT_FORMATS = new Set(['original', 'png', 'jpeg']);
const DEFAULT_JPEG_QUALITY = 0.92;
const MIN_JPEG_QUALITY = 0.1;
const HEX_64 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const ownObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const boundedNumber = (value, min, max) => finite(value) && value >= min && value <= max
    ? value
    : null;
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;

const cleanImageDimensions = value => {
    if (!ownObject(value)) return null;
    const width = integer(value.width, 1, MAX_DIMENSION);
    const height = integer(value.height, 1, MAX_DIMENSION);
    if (width == null || height == null || width * height > MAX_PIXELS) return null;
    return { width, height };
};

const matchingImageDimensions = (left, right) => {
    const cleanLeft = cleanImageDimensions(left);
    const cleanRight = cleanImageDimensions(right);
    return !!cleanLeft && !!cleanRight
        && cleanLeft.width === cleanRight.width
        && cleanLeft.height === cleanRight.height;
};

const cleanId = value => {
    if (typeof value !== 'string') return null;
    const id = value.trim();
    return id.length > 0 && id.length <= MAX_ID_LENGTH && SAFE_ID.test(id) ? id : null;
};

const cleanIsoTime = value => {
    if (typeof value !== 'string' || !value) return null;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) return null;
    return new Date(time).toISOString();
};

const cleanColor = value => {
    const color = typeof value === 'string' ? value.toLowerCase() : '';
    return PALETTE.includes(color) ? color : null;
};

const coordinateBounds = image => ({
    minX: -image.width,
    maxX: image.width * 2,
    minY: -image.height,
    maxY: image.height * 2,
});

const cleanPoint = (value, bounds) => {
    if (!Array.isArray(value) || value.length !== 2) return null;
    const x = boundedNumber(value[0], bounds.minX, bounds.maxX);
    const y = boundedNumber(value[1], bounds.minY, bounds.maxY);
    return x == null || y == null ? null : [x, y];
};

const clampPoint = (point, bounds) => [
    Math.min(bounds.maxX, Math.max(bounds.minX, point[0])),
    Math.min(bounds.maxY, Math.max(bounds.minY, point[1])),
];

// Catmull-Rom style tangents: each control sits a sixth of the way along the
// segment its neighbours span, so the curve passes through every clicked point.
const smoothControls = points => points.map((point, index) => {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const dx = (next[0] - previous[0]) / 6;
    const dy = (next[1] - previous[1]) / 6;
    return {
        in: index === 0 ? null : [point[0] - dx, point[1] - dy],
        out: index === points.length - 1 ? null : [point[0] + dx, point[1] + dy],
    };
});

const cleanImage = value => {
    const dimensions = cleanImageDimensions(value);
    const sourceSha256 = typeof value.sourceSha256 === 'string'
        ? value.sourceSha256.toLowerCase()
        : '';
    if (!dimensions || !HEX_64.test(sourceSha256)) return null;
    return { ...dimensions, sourceSha256 };
};

const cleanOpacity = value => boundedNumber(value ?? 1, MIN_OPACITY, 1);

const cleanBaseStyle = value => {
    if (!ownObject(value)) return null;
    const color = cleanColor(value.color);
    const scale = boundedNumber(value.scale ?? 1, 0.25, MAX_SCALE);
    const opacity = cleanOpacity(value.opacity);
    return color && scale != null && opacity != null ? { color, scale, opacity } : null;
};

const cleanRoute = (value, image) => {
    if (!ownObject(value.geometry) || !ownObject(value.style)) return null;
    if (!Array.isArray(value.geometry.points)
        || value.geometry.points.length < 2
        || value.geometry.points.length > MAX_ROUTE_POINTS) return null;

    const bounds = coordinateBounds(image);
    const points = value.geometry.points.map(point => cleanPoint(point, bounds));
    if (points.some(point => !point)) return null;

    const controlsInput = value.geometry.controls ?? [];
    if (!Array.isArray(controlsInput) || (controlsInput.length !== 0
        && controlsInput.length !== points.length)) return null;
    const controls = controlsInput.length ? controlsInput.map(control => {
        if (control == null) return null;
        if (!ownObject(control)) return false;
        const incoming = control.in == null ? null : cleanPoint(control.in, bounds);
        const outgoing = control.out == null ? null : cleanPoint(control.out, bounds);
        if ((control.in != null && !incoming) || (control.out != null && !outgoing)) return false;
        return { in: incoming, out: outgoing };
    }) : [];
    if (controls.some(control => control === false)) return null;

    const color = cleanColor(value.style.color);
    const width = boundedNumber(value.style.width, 1, MAX_LINE_WIDTH);
    const stroke = STROKES.has(value.style.stroke) ? value.style.stroke : null;
    const end = ENDS.has(value.style.end) ? value.style.end : null;
    const opacity = cleanOpacity(value.style.opacity);
    if (!color || width == null || !stroke || !end || opacity == null) return null;

    // A smooth route records the intent, not hand-placed handles: the editor
    // exposes no control-point UI, so every point the user adds would otherwise
    // drop the curve it just drew. Controls are derived from the points here,
    // which keeps the curve through any edit. A project written before this
    // field existed infers its intent from the controls it already stored, and
    // a project that carries real handles keeps them.
    const stored = controls;
    const smooth = typeof value.style.smooth === 'boolean'
        ? value.style.smooth
        : stored.some(control => control?.in || control?.out);
    const derived = smoothControls(points).map(control => ({
        in: control.in ? clampPoint(control.in, bounds) : null,
        out: control.out ? clampPoint(control.out, bounds) : null,
    }));

    return {
        geometry: {
            points,
            controls: !smooth ? [] : stored.length ? stored : derived,
        },
        style: { color, width, stroke, end, opacity, smooth },
        pointCount: points.length,
    };
};

const cleanPosition = (geometry, image) => {
    if (!ownObject(geometry)) return null;
    const point = cleanPoint([geometry.x, geometry.y], coordinateBounds(image));
    if (!point) return null;
    const rotation = boundedNumber(geometry.rotation ?? 0, -360, 360);
    return rotation == null ? null : { x: point[0], y: point[1], rotation };
};

const cleanMarker = (value, image) => {
    const geometry = cleanPosition(value.geometry, image);
    const style = cleanBaseStyle(value.style);
    return geometry && style ? { geometry, style, pointCount: 1 } : null;
};

const cleanPitch = (value, image) => {
    const geometry = cleanPosition(value.geometry, image);
    const style = cleanBaseStyle(value.style);
    const pitch = integer(value.pitch, 1, 50);
    const background = typeof value.style?.background === 'boolean'
        ? value.style.background
        : null;
    return geometry && style && pitch != null && background != null ? {
        geometry,
        style: { ...style, background },
        pitch,
        pointCount: 1,
    } : null;
};

const cleanText = (value, image) => {
    const geometry = cleanPosition(value.geometry, image);
    const style = cleanBaseStyle(value.style);
    const text = typeof value.text === 'string' ? value.text.trim().slice(0, MAX_TEXT_LENGTH) : '';
    const align = ALIGNS.has(value.style?.align) ? value.style.align : null;
    const background = typeof value.style?.background === 'boolean'
        ? value.style.background
        : null;
    return geometry && style && text && align && background != null ? {
        geometry,
        style: { ...style, align, background },
        text,
        pointCount: 1,
    } : null;
};

const cleanObject = (value, image) => {
    if (!ownObject(value)) return null;
    const id = cleanId(value.id);
    const type = OBJECT_TYPES.includes(value.type) ? value.type : null;
    const z = integer(value.z, 0, MAX_OBJECTS * 4);
    if (!id || !type || z == null) return null;

    let specific;
    if (type === 'route') specific = cleanRoute(value, image);
    else if (MARKER_TYPES.includes(type)) specific = cleanMarker(value, image);
    else if (type === 'pitch') specific = cleanPitch(value, image);
    else specific = cleanText(value, image);
    if (!specific) return null;

    const { pointCount, ...fields } = specific;
    return { object: { id, type, z, ...fields }, pointCount };
};

const cleanExport = value => {
    if (!ownObject(value) || !EXPORT_MIMES.has(value.mime)) return null;
    if (value.mime === 'image/png') return { mime: value.mime, quality: 1 };
    const quality = boundedNumber(value.quality, MIN_JPEG_QUALITY, 1);
    return quality == null ? null : { mime: value.mime, quality };
};

// Canvas can reliably flatten the two formats ImgBB's editor contract already
// supports. "Original" means keep one of those formats, not keep the source
// bytes: every upload is freshly encoded so EXIF and other metadata stay
// behind. Other browser-decodable formats therefore have no honest Original
// choice and the page falls back to its explicit JPEG option.
const sourceExportMime = value => {
    const mime = typeof value === 'string' ? value.toLowerCase() : '';
    return EXPORT_MIMES.has(mime) ? mime : null;
};

const resolveExportSettings = ({
    format,
    sourceMime,
    jpegQuality = DEFAULT_JPEG_QUALITY,
} = {}) => {
    if (!EXPORT_FORMATS.has(format)) return null;
    const mime = format === 'png'
        ? 'image/png'
        : format === 'jpeg'
            ? 'image/jpeg'
            : sourceExportMime(sourceMime);
    return mime ? cleanExport({ mime, quality: mime === 'image/png' ? 1 : jpegQuality }) : null;
};

const inferExportFormat = (value, sourceMime) => {
    const cleaned = cleanExport(value);
    if (!cleaned) return null;
    const original = sourceExportMime(sourceMime);
    if (original && cleaned.mime === original) return 'original';
    return cleaned.mime === 'image/png' ? 'png' : 'jpeg';
};

const cleanProject = value => {
    if (!ownObject(value) || value.schemaVersion !== SCHEMA_VERSION) return null;
    const localId = cleanId(value.localId);
    const image = cleanImage(value.image);
    const exportSettings = cleanExport(value.export);
    const updatedAt = cleanIsoTime(value.updatedAt);
    if (!localId || !image || !exportSettings || !updatedAt
        || !Array.isArray(value.objects) || value.objects.length > MAX_OBJECTS) return null;

    const objects = [];
    const seen = new Set();
    let totalPoints = 0;
    for (const candidate of value.objects) {
        const cleaned = cleanObject(candidate, image);
        if (!cleaned || seen.has(cleaned.object.id)) return null;
        totalPoints += cleaned.pointCount;
        if (totalPoints > MAX_PROJECT_POINTS) return null;
        seen.add(cleaned.object.id);
        objects.push({ ...cleaned.object, _order: objects.length });
    }
    objects.sort((a, b) => a.z - b.z || a._order - b._order);

    return {
        schemaVersion: SCHEMA_VERSION,
        localId,
        image,
        objects: objects.map(({ _order: _discard, ...object }, z) => ({ ...object, z })),
        export: exportSettings,
        updatedAt,
    };
};

const createProject = ({ localId, width, height, sourceSha256, updatedAt = new Date().toISOString() }) =>
    cleanProject({
        schemaVersion: SCHEMA_VERSION,
        localId,
        image: { width, height, sourceSha256 },
        objects: [],
        export: { mime: 'image/jpeg', quality: DEFAULT_JPEG_QUALITY },
        updatedAt,
    });

const replaceObjects = (project, objects, updatedAt = new Date().toISOString()) => cleanProject({
    ...project,
    objects,
    updatedAt,
});

const addObject = (project, object, updatedAt) => {
    const cleaned = cleanProject(project);
    if (!cleaned || cleaned.objects.length >= MAX_OBJECTS) return null;
    return replaceObjects(cleaned, [
        ...cleaned.objects,
        { ...object, z: cleaned.objects.length },
    ], updatedAt);
};

const updateObject = (project, id, update, updatedAt) => {
    const cleaned = cleanProject(project);
    const cleanTarget = cleanId(id);
    if (!cleaned || !cleanTarget || !ownObject(update)) return null;
    let found = false;
    const objects = cleaned.objects.map(object => {
        if (object.id !== cleanTarget) return object;
        found = true;
        return { ...object, ...update, id: object.id, type: object.type, z: object.z };
    });
    return found ? replaceObjects(cleaned, objects, updatedAt) : null;
};

const removeObjects = (project, ids, updatedAt) => {
    const cleaned = cleanProject(project);
    if (!cleaned || !Array.isArray(ids)) return null;
    const removing = new Set(ids.map(cleanId).filter(Boolean));
    return replaceObjects(cleaned, cleaned.objects.filter(object => !removing.has(object.id)), updatedAt);
};

const reorderObject = (project, id, direction, updatedAt) => {
    const cleaned = cleanProject(project);
    const cleanTarget = cleanId(id);
    if (!cleaned || !cleanTarget || !['front', 'back', 'forward', 'backward'].includes(direction)) {
        return null;
    }
    const objects = [...cleaned.objects];
    const index = objects.findIndex(object => object.id === cleanTarget);
    if (index < 0) return null;
    let target = index;
    if (direction === 'front') target = objects.length - 1;
    if (direction === 'back') target = 0;
    if (direction === 'forward') target = Math.min(objects.length - 1, index + 1);
    if (direction === 'backward') target = Math.max(0, index - 1);
    const [object] = objects.splice(index, 1);
    objects.splice(target, 0, object);
    return replaceObjects(cleaned, objects.map((item, z) => ({ ...item, z })), updatedAt);
};

export const photoProject = {
    SCHEMA_VERSION,
    MAX_OBJECTS,
    MAX_ROUTE_POINTS,
    MAX_PROJECT_POINTS,
    MAX_TEXT_LENGTH,
    MAX_DIMENSION,
    MAX_PIXELS,
    MAX_LINE_WIDTH,
    MAX_SCALE,
    MIN_OPACITY,
    DEFAULT_JPEG_QUALITY,
    MIN_JPEG_QUALITY,
    DEFAULT_COLOR,
    PALETTE,
    OBJECT_TYPES,
    MARKER_TYPES,
    cleanImageDimensions,
    matchingImageDimensions,
    smoothControls,
    sourceExportMime,
    resolveExportSettings,
    inferExportFormat,
    cleanProject,
    createProject,
    addObject,
    updateObject,
    removeObjects,
    reorderObject,
};
