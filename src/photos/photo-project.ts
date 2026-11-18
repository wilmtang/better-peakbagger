// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — pure, versioned topo-photo project model.
//
// The editor, IndexedDB loader, GitHub restore path, and renderer all clean
// projects through this one module. It intentionally has no DOM, canvas,
// browser-API, storage, or network dependency.

const SCHEMA_VERSION = 1 as const;
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
const DEFAULT_COLOR = '#e53935' as const;
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
] as const);
const OBJECT_TYPES = Object.freeze([
    'route',
    'drawing',
    'bolt',
    'anchor',
    'piton',
    'rappel',
    'belay',
    'pitch',
    'text',
] as const);
const MARKER_TYPES = Object.freeze(['bolt', 'anchor', 'piton', 'rappel', 'belay'] as const);

export type PhotoProjectColor = (typeof PALETTE)[number];
export type PhotoProjectObjectType = (typeof OBJECT_TYPES)[number];
export type PhotoProjectMarkerType = (typeof MARKER_TYPES)[number];
export type PhotoProjectStroke = 'solid' | 'dashed' | 'dotted';
export type PhotoProjectEnd = 'none' | 'arrow';
export type PhotoProjectAlign = 'left' | 'center' | 'right';
export type PhotoProjectExportMime = 'image/jpeg' | 'image/png';
export type PhotoProjectExportFormat = 'original' | 'png' | 'jpeg';
export type PhotoProjectPoint = [number, number];
export type PhotoProjectReorderDirection = 'front' | 'back' | 'forward' | 'backward';

export interface PhotoProjectImageDimensions {
    width: number;
    height: number;
}

export interface PhotoProjectImage extends PhotoProjectImageDimensions {
    sourceSha256: string;
}

export interface PhotoProjectControlPoint {
    in: PhotoProjectPoint | null;
    out: PhotoProjectPoint | null;
}

export interface PhotoProjectBaseStyle {
    color: PhotoProjectColor;
    scale: number;
    opacity: number;
}

export interface PhotoProjectRouteStyle {
    color: PhotoProjectColor;
    width: number;
    stroke: PhotoProjectStroke;
    end: PhotoProjectEnd;
    opacity: number;
    smooth: boolean;
}

export interface PhotoProjectRouteObject {
    id: string;
    type: 'route' | 'drawing';
    z: number;
    geometry: {
        points: PhotoProjectPoint[];
        controls: (PhotoProjectControlPoint | null)[];
    };
    style: PhotoProjectRouteStyle;
}

export interface PhotoProjectPosition {
    x: number;
    y: number;
    rotation: number;
}

export interface PhotoProjectMarkerObject {
    id: string;
    type: PhotoProjectMarkerType;
    z: number;
    geometry: PhotoProjectPosition;
    style: PhotoProjectBaseStyle;
}

export interface PhotoProjectPitchObject {
    id: string;
    type: 'pitch';
    z: number;
    geometry: PhotoProjectPosition;
    style: PhotoProjectBaseStyle & { background: boolean };
    pitch: number;
}

export interface PhotoProjectTextObject {
    id: string;
    type: 'text';
    z: number;
    geometry: PhotoProjectPosition & { width?: number };
    style: PhotoProjectBaseStyle & { align: PhotoProjectAlign; background: boolean };
    text: string;
}

export type PhotoProjectObject =
    | PhotoProjectRouteObject
    | PhotoProjectMarkerObject
    | PhotoProjectPitchObject
    | PhotoProjectTextObject;

export interface PhotoProjectExportSettings {
    mime: PhotoProjectExportMime;
    quality: number;
}

export interface PhotoProject {
    schemaVersion: 1;
    localId: string;
    image: PhotoProjectImage;
    objects: PhotoProjectObject[];
    export: PhotoProjectExportSettings;
    updatedAt: string;
}

export interface ResolveExportSettingsOptions {
    format?: unknown;
    sourceMime?: unknown;
    jpegQuality?: unknown;
}

export interface CreateProjectOptions {
    localId: string;
    width: number;
    height: number;
    sourceSha256: string;
    updatedAt?: string;
}

interface CoordinateBounds {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
}

const STROKES = new Set<PhotoProjectStroke>(['solid', 'dashed', 'dotted']);
const ENDS = new Set<PhotoProjectEnd>(['none', 'arrow']);
const ALIGNS = new Set<PhotoProjectAlign>(['left', 'center', 'right']);
const EXPORT_MIMES = new Set<PhotoProjectExportMime>(['image/jpeg', 'image/png']);
const EXPORT_FORMATS = new Set<PhotoProjectExportFormat>(['original', 'png', 'jpeg']);
const PALETTE_SET = new Set<string>(PALETTE);
const OBJECT_TYPE_SET = new Set<string>(OBJECT_TYPES);
const MARKER_TYPE_SET = new Set<string>(MARKER_TYPES);
const DEFAULT_JPEG_QUALITY = 0.92;
const MIN_JPEG_QUALITY = 0.1;
const HEX_64 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const ownObject = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const boundedNumber = (value: unknown, min: number, max: number): number | null =>
    finite(value) && value >= min && value <= max ? value : null;
const integer = (value: unknown, min: number, max: number): number | null =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;

const inSet = <T extends string>(set: ReadonlySet<T>, value: unknown): T | null =>
    typeof value === 'string' && set.has(value as T) ? (value as T) : null;

const isMarkerType = (value: PhotoProjectObjectType): value is PhotoProjectMarkerType =>
    MARKER_TYPE_SET.has(value);

const cleanImageDimensions = (value: unknown): PhotoProjectImageDimensions | null => {
    if (!ownObject(value)) return null;
    const width = integer(value.width, 1, MAX_DIMENSION);
    const height = integer(value.height, 1, MAX_DIMENSION);
    if (width == null || height == null || width * height > MAX_PIXELS) return null;
    return { width, height };
};

const matchingImageDimensions = (left: unknown, right: unknown): boolean => {
    const cleanLeft = cleanImageDimensions(left);
    const cleanRight = cleanImageDimensions(right);
    return !!cleanLeft && !!cleanRight
        && cleanLeft.width === cleanRight.width
        && cleanLeft.height === cleanRight.height;
};

const cleanId = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const id = value.trim();
    return id.length > 0 && id.length <= MAX_ID_LENGTH && SAFE_ID.test(id) ? id : null;
};

const cleanIsoTime = (value: unknown): string | null => {
    if (typeof value !== 'string' || !value) return null;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) return null;
    return new Date(time).toISOString();
};

const cleanColor = (value: unknown): PhotoProjectColor | null => {
    const color = typeof value === 'string' ? value.toLowerCase() : '';
    return PALETTE_SET.has(color) ? (color as PhotoProjectColor) : null;
};

const coordinateBounds = (image: PhotoProjectImageDimensions): CoordinateBounds => ({
    minX: -image.width,
    maxX: image.width * 2,
    minY: -image.height,
    maxY: image.height * 2,
});

const cleanPoint = (value: unknown, bounds: CoordinateBounds): PhotoProjectPoint | null => {
    if (!Array.isArray(value) || value.length !== 2) return null;
    const x = boundedNumber(value[0], bounds.minX, bounds.maxX);
    const y = boundedNumber(value[1], bounds.minY, bounds.maxY);
    return x == null || y == null ? null : [x, y];
};

const clampPoint = (point: PhotoProjectPoint, bounds: CoordinateBounds): PhotoProjectPoint => [
    Math.min(bounds.maxX, Math.max(bounds.minX, point[0])),
    Math.min(bounds.maxY, Math.max(bounds.minY, point[1])),
];

// Catmull-Rom style tangents: each control sits a sixth of the way along the
// segment its neighbours span, so the curve passes through every clicked point.
const smoothControls = (points: readonly PhotoProjectPoint[]): PhotoProjectControlPoint[] =>
    points.map((point, index) => {
        const previous = points[Math.max(0, index - 1)] ?? point;
        const next = points[Math.min(points.length - 1, index + 1)] ?? point;
        const dx = (next[0] - previous[0]) / 6;
        const dy = (next[1] - previous[1]) / 6;
        return {
            in: index === 0 ? null : [point[0] - dx, point[1] - dy],
            out: index === points.length - 1 ? null : [point[0] + dx, point[1] + dy],
        };
    });

const cleanImage = (value: unknown): PhotoProjectImage | null => {
    const dimensions = cleanImageDimensions(value);
    if (!dimensions || !ownObject(value)) return null;
    const sourceSha256 = typeof value.sourceSha256 === 'string'
        ? value.sourceSha256.toLowerCase()
        : '';
    if (!HEX_64.test(sourceSha256)) return null;
    return { ...dimensions, sourceSha256 };
};

const cleanOpacity = (value: unknown): number | null => boundedNumber(value ?? 1, MIN_OPACITY, 1);

const cleanBaseStyle = (value: unknown): PhotoProjectBaseStyle | null => {
    if (!ownObject(value)) return null;
    const color = cleanColor(value.color);
    const scale = boundedNumber(value.scale ?? 1, 0.25, MAX_SCALE);
    const opacity = cleanOpacity(value.opacity);
    return color && scale != null && opacity != null ? { color, scale, opacity } : null;
};

const cleanRoute = (
    value: Record<string, unknown>,
    image: PhotoProjectImageDimensions,
): (Omit<PhotoProjectRouteObject, 'id' | 'type' | 'z'> & { pointCount: number }) | null => {
    if (!ownObject(value.geometry) || !ownObject(value.style)) return null;
    if (!Array.isArray(value.geometry.points)
        || value.geometry.points.length < 2
        || value.geometry.points.length > MAX_ROUTE_POINTS) return null;

    const bounds = coordinateBounds(image);
    const points: PhotoProjectPoint[] = [];
    for (const rawPoint of value.geometry.points) {
        const point = cleanPoint(rawPoint, bounds);
        if (!point) return null;
        points.push(point);
    }

    const controlsInput: unknown = value.geometry.controls ?? [];
    if (!Array.isArray(controlsInput) || (controlsInput.length !== 0
        && controlsInput.length !== points.length)) return null;
    const controls: (PhotoProjectControlPoint | null)[] = [];
    if (controlsInput.length) {
        for (const control of controlsInput) {
            if (control == null) {
                controls.push(null);
                continue;
            }
            if (!ownObject(control)) return null;
            const incoming = control.in == null ? null : cleanPoint(control.in, bounds);
            const outgoing = control.out == null ? null : cleanPoint(control.out, bounds);
            if ((control.in != null && !incoming) || (control.out != null && !outgoing)) return null;
            controls.push({ in: incoming, out: outgoing });
        }
    }

    const color = cleanColor(value.style.color);
    const width = boundedNumber(value.style.width, 1, MAX_LINE_WIDTH);
    const stroke = inSet(STROKES, value.style.stroke);
    const end = inSet(ENDS, value.style.end);
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

const cleanPosition = (geometry: unknown, image: PhotoProjectImageDimensions): PhotoProjectPosition | null => {
    if (!ownObject(geometry)) return null;
    const point = cleanPoint([geometry.x, geometry.y], coordinateBounds(image));
    if (!point) return null;
    const rotation = boundedNumber(geometry.rotation ?? 0, -360, 360);
    return rotation == null ? null : { x: point[0], y: point[1], rotation };
};

const cleanMarker = (
    value: Record<string, unknown>,
    image: PhotoProjectImageDimensions,
): (Omit<PhotoProjectMarkerObject, 'id' | 'type' | 'z'> & { pointCount: number }) | null => {
    const geometry = cleanPosition(value.geometry, image);
    const style = cleanBaseStyle(value.style);
    return geometry && style ? { geometry, style, pointCount: 1 } : null;
};

const cleanPitch = (
    value: Record<string, unknown>,
    image: PhotoProjectImageDimensions,
): (Omit<PhotoProjectPitchObject, 'id' | 'type' | 'z'> & { pointCount: number }) | null => {
    const geometry = cleanPosition(value.geometry, image);
    const style = cleanBaseStyle(value.style);
    const pitch = integer(value.pitch, 1, 50);
    const background = ownObject(value.style) && typeof value.style.background === 'boolean'
        ? value.style.background
        : null;
    return geometry && style && pitch != null && background != null ? {
        geometry,
        style: { ...style, background },
        pitch,
        pointCount: 1,
    } : null;
};

const cleanText = (
    value: Record<string, unknown>,
    image: PhotoProjectImageDimensions,
): (Omit<PhotoProjectTextObject, 'id' | 'type' | 'z'> & { pointCount: number }) | null => {
    const geometry = cleanPosition(value.geometry, image);
    if (!geometry || !ownObject(value.geometry)) return null;
    // Missing width is the legacy, automatically sized label. Width is in
    // source-image pixels and is independent of the label's font size.
    const width = value.geometry.width == null ? null
        : boundedNumber(value.geometry.width, 1, MAX_DIMENSION);
    if (value.geometry.width != null && width == null) return null;
    const style = cleanBaseStyle(value.style);
    if (!style || !ownObject(value.style)) return null;
    const text = typeof value.text === 'string' ? value.text.trim().slice(0, MAX_TEXT_LENGTH) : '';
    const align = inSet(ALIGNS, value.style.align);
    const background = typeof value.style.background === 'boolean'
        ? value.style.background
        : null;
    return text && align && background != null ? {
        geometry: width == null ? geometry : { ...geometry, width },
        style: { ...style, align, background },
        text,
        pointCount: 1,
    } : null;
};

const cleanObject = (
    value: unknown,
    image: PhotoProjectImageDimensions,
): { object: PhotoProjectObject; pointCount: number } | null => {
    if (!ownObject(value)) return null;
    const id = cleanId(value.id);
    const type = typeof value.type === 'string' && OBJECT_TYPE_SET.has(value.type)
        ? (value.type as PhotoProjectObjectType)
        : null;
    const z = integer(value.z, 0, MAX_OBJECTS * 4);
    if (!id || !type || z == null) return null;

    if (type === 'route' || type === 'drawing') {
        const specific = cleanRoute(value, image);
        if (!specific) return null;
        const { pointCount, ...fields } = specific;
        return { object: { id, type, z, ...fields }, pointCount };
    }
    if (isMarkerType(type)) {
        const specific = cleanMarker(value, image);
        if (!specific) return null;
        const { pointCount, ...fields } = specific;
        return { object: { id, type, z, ...fields }, pointCount };
    }
    if (type === 'pitch') {
        const specific = cleanPitch(value, image);
        if (!specific) return null;
        const { pointCount, ...fields } = specific;
        return { object: { id, type, z, ...fields }, pointCount };
    }
    const specific = cleanText(value, image);
    if (!specific) return null;
    const { pointCount, ...fields } = specific;
    return { object: { id, type, z, ...fields }, pointCount };
};

const cleanExport = (value: unknown): PhotoProjectExportSettings | null => {
    if (!ownObject(value)) return null;
    const mime = inSet(EXPORT_MIMES, value.mime);
    if (!mime) return null;
    if (mime === 'image/png') return { mime, quality: 1 };
    const quality = boundedNumber(value.quality, MIN_JPEG_QUALITY, 1);
    return quality == null ? null : { mime, quality };
};

// Canvas can reliably flatten the two formats ImgBB's editor contract already
// supports. "Original" means keep one of those formats, not keep the source
// bytes: every upload is freshly encoded so EXIF and other metadata stay
// behind. Other browser-decodable formats therefore have no honest Original
// choice and the page falls back to its explicit JPEG option.
const sourceExportMime = (value: unknown): PhotoProjectExportMime | null => {
    const mime = typeof value === 'string' ? value.toLowerCase() : '';
    return inSet(EXPORT_MIMES, mime);
};

const resolveExportSettings = ({
    format,
    sourceMime,
    jpegQuality = DEFAULT_JPEG_QUALITY,
}: ResolveExportSettingsOptions = {}): PhotoProjectExportSettings | null => {
    const cleanFormat = inSet(EXPORT_FORMATS, format);
    if (!cleanFormat) return null;
    const mime: PhotoProjectExportMime | null = cleanFormat === 'png'
        ? 'image/png'
        : cleanFormat === 'jpeg'
            ? 'image/jpeg'
            : sourceExportMime(sourceMime);
    return mime ? cleanExport({ mime, quality: mime === 'image/png' ? 1 : jpegQuality }) : null;
};

const inferExportFormat = (value: unknown, sourceMime: unknown): PhotoProjectExportFormat | null => {
    const cleaned = cleanExport(value);
    if (!cleaned) return null;
    const original = sourceExportMime(sourceMime);
    if (original && cleaned.mime === original) return 'original';
    return cleaned.mime === 'image/png' ? 'png' : 'jpeg';
};

const cleanProject = (value: unknown): PhotoProject | null => {
    if (!ownObject(value) || value.schemaVersion !== SCHEMA_VERSION) return null;
    const localId = cleanId(value.localId);
    const image = cleanImage(value.image);
    const exportSettings = cleanExport(value.export);
    const updatedAt = cleanIsoTime(value.updatedAt);
    if (!localId || !image || !exportSettings || !updatedAt
        || !Array.isArray(value.objects) || value.objects.length > MAX_OBJECTS) return null;

    const objects: { object: PhotoProjectObject; order: number }[] = [];
    const seen = new Set<string>();
    let totalPoints = 0;
    for (const candidate of value.objects) {
        const cleaned = cleanObject(candidate, image);
        if (!cleaned || seen.has(cleaned.object.id)) return null;
        totalPoints += cleaned.pointCount;
        if (totalPoints > MAX_PROJECT_POINTS) return null;
        seen.add(cleaned.object.id);
        objects.push({ object: cleaned.object, order: objects.length });
    }
    objects.sort((a, b) => a.object.z - b.object.z || a.order - b.order);

    return {
        schemaVersion: SCHEMA_VERSION,
        localId,
        image,
        objects: objects.map(({ object }, z) => ({ ...object, z }) as PhotoProjectObject),
        export: exportSettings,
        updatedAt,
    };
};

const createProject = ({
    localId,
    width,
    height,
    sourceSha256,
    updatedAt = new Date().toISOString(),
}: CreateProjectOptions): PhotoProject | null =>
    cleanProject({
        schemaVersion: SCHEMA_VERSION,
        localId,
        image: { width, height, sourceSha256 },
        objects: [],
        export: { mime: 'image/jpeg', quality: DEFAULT_JPEG_QUALITY },
        updatedAt,
    });

const replaceObjects = (
    project: PhotoProject,
    objects: readonly unknown[],
    updatedAt = new Date().toISOString(),
): PhotoProject | null => cleanProject({
    ...project,
    objects,
    updatedAt,
});

const addObject = (project: unknown, object: unknown, updatedAt?: string): PhotoProject | null => {
    const cleaned = cleanProject(project);
    if (!cleaned || !ownObject(object) || cleaned.objects.length >= MAX_OBJECTS) return null;
    return replaceObjects(cleaned, [
        ...cleaned.objects,
        { ...object, z: cleaned.objects.length },
    ], updatedAt);
};

const updateObject = (
    project: unknown,
    id: unknown,
    update: unknown,
    updatedAt?: string,
): PhotoProject | null => {
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

const removeObjects = (project: unknown, ids: unknown, updatedAt?: string): PhotoProject | null => {
    const cleaned = cleanProject(project);
    if (!cleaned || !Array.isArray(ids)) return null;
    const removing = new Set(ids.map(cleanId).filter((id): id is string => id !== null));
    return replaceObjects(cleaned, cleaned.objects.filter(object => !removing.has(object.id)), updatedAt);
};

const reorderObject = (
    project: unknown,
    id: unknown,
    direction: unknown,
    updatedAt?: string,
): PhotoProject | null => {
    const cleaned = cleanProject(project);
    const cleanTarget = cleanId(id);
    if (!cleaned || !cleanTarget || typeof direction !== 'string'
        || !['front', 'back', 'forward', 'backward'].includes(direction)) {
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
    if (!object) return null;
    objects.splice(target, 0, object);
    return replaceObjects(cleaned, objects.map((item, z) => ({ ...item, z })), updatedAt);
};

export const photoProject = {
    SCHEMA_VERSION,
    MAX_OBJECTS,
    MAX_ROUTE_POINTS,
    MAX_PROJECT_POINTS,
    MAX_DIMENSION,
    MAX_PIXELS,
    DEFAULT_JPEG_QUALITY,
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
