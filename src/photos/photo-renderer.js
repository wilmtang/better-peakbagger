// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — deterministic topo SVG rendering and raster export.
//
// SVG is the editable overlay representation. Canvas is used only to flatten a
// cleaned project over a locally decoded source image, which also ensures the
// uploaded result contains no source EXIF or other file metadata.

import { photoProject as Project } from './photo-project.js';

const XML_NS = 'http://www.w3.org/2000/svg';
const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const MARKER_SIZE_RATIO = 0.027;
const LABEL_SIZE_RATIO = 0.035;

const escapeXml = value => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const number = value => {
    const rounded = Math.round(value * 1000) / 1000;
    return Object.is(rounded, -0) ? '0' : String(rounded);
};

const routePath = object => {
    const { points, controls } = object.geometry;
    let path = `M ${number(points[0][0])} ${number(points[0][1])}`;
    for (let index = 1; index < points.length; index += 1) {
        const previous = points[index - 1];
        const point = points[index];
        const outgoing = controls[index - 1]?.out;
        const incoming = controls[index]?.in;
        if (outgoing || incoming) {
            const first = outgoing || previous;
            const second = incoming || point;
            path += ` C ${number(first[0])} ${number(first[1])}`
                + ` ${number(second[0])} ${number(second[1])}`
                + ` ${number(point[0])} ${number(point[1])}`;
        } else {
            path += ` L ${number(point[0])} ${number(point[1])}`;
        }
    }
    return path;
};

const dashArray = (stroke, width) => {
    if (stroke === 'dashed') return `${number(width * 3)} ${number(width * 2)}`;
    if (stroke === 'dotted') return `${number(width * 0.1)} ${number(width * 2)}`;
    return null;
};

// One marker per arrow color. A single shared marker would paint every
// arrowhead in whichever color happened to be defined first, so a blue route
// drawn after a red one exported a red tip.
const arrowId = color => `bpb-arrow-${color.slice(1)}`;

// Opacity rides on the object's own group so one attribute dims the mark, its
// arrowhead, and a label's contrast plate together. Setting stroke-opacity
// instead would leave a referenced arrow marker and a filled plate at full
// strength, which is exactly the beta-hiding case the control exists for.
const opacityAttribute = opacity => opacity < 1 ? ` opacity="${number(opacity)}"` : '';

const renderRoute = (object, image, interactive) => {
    const path = routePath(object);
    const dash = dashArray(object.style.stroke, object.style.width);
    const marker = object.style.end === 'arrow'
        ? ` marker-end="url(#${arrowId(object.style.color)})"`
        : '';
    const hitTarget = interactive
        ? `<path data-bpb-hit-target="true" d="${path}" fill="none" stroke="transparent"`
            + ` stroke-width="${number(Math.max(object.style.width,
                Math.min(image.width, image.height) * 0.05))}"`
            + ' stroke-linecap="round" stroke-linejoin="round" pointer-events="stroke"/>'
        : '';
    return `<g data-bpb-object="${escapeXml(object.id)}"${opacityAttribute(object.style.opacity)}>`
        + `<path d="${path}"`
        + ` fill="none" stroke="${object.style.color}" stroke-width="${number(object.style.width)}"`
        + ' stroke-linecap="round" stroke-linejoin="round"'
        + (dash ? ` stroke-dasharray="${dash}"` : '')
        + `${marker}/>${hitTarget}</g>`;
};

// Climbing-guidebook symbols, drawn in a unit box the marker transform scales.
// The X-shaped bolt, plus piton, rappel, and belay, adapt geometry from the
// four stamps in Mountain Project's Apache-licensed BetaCreator editor. Their
// canvas coordinates were normalized and translated to SVG paths here; see
// ACKNOWLEDGEMENTS.md and vendor/betacreator-LICENSE.txt. Copyright 2012 Alma
// Madsen.
//
// Anchor is Better Peakbagger's additional bullseye marker. `photos/guide.html`
// shows the same glyphs with their names.
const markerGeometry = (type, color) => {
    if (type === 'bolt') {
        return '<path d="M -0.72 -0.72 L 0.72 0.72 M 0.72 -0.72 L -0.72 0.72" fill="none"/>';
    }
    if (type === 'anchor') {
        return '<circle cx="0" cy="0" r="0.5" fill="none"/>'
            + `<circle cx="0" cy="0" r="0.17" fill="${color}" stroke="none"/>`;
    }
    if (type === 'piton') {
        return '<path d="M -0.15 0.72 V -0.72 H 0.29'
            + ' A 0.43 0.43 0 0 1 0.29 0.14 H -0.15" fill="none"/>';
    }
    if (type === 'rappel') {
        return '<circle cx="0" cy="0" r="0.72" fill="none"/>'
            + '<path d="M 0 -0.36 V 0.36 M -0.36 0 L 0 0.36 L 0.36 0" fill="none"/>';
    }
    if (type === 'belay') {
        return '<circle cx="0" cy="0" r="0.72" fill="none"/>';
    }
    return '';
};

// One standalone glyph, for the tool rail and the guide's legend. Sharing the
// geometry is the point: a symbol the user is taught cannot drift from the
// symbol the export paints.
const markerSymbolSvg = (type, { color = 'currentColor', size = 20 } = {}) =>
    `<svg xmlns="${XML_NS}" width="${size}" height="${size}" viewBox="-1.05 -1.05 2.1 2.1"`
    + ` fill="none" stroke="${color}" stroke-width="0.13"`
    + ' stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true">'
    + markerGeometry(type, color)
    + '</svg>';

// The editor reports the nominal rendered size in source-image pixels. Marker
// geometry is normalized around this unit; labels use it as their font size.
// Keeping the calculation beside the renderer prevents the inspector from
// promising a pixel value that the flattened export does not use.
const objectSizePixels = (type, image, scale) => {
    const ratio = Project.MARKER_TYPES.includes(type) ? MARKER_SIZE_RATIO : LABEL_SIZE_RATIO;
    return Math.min(image.width, image.height) * ratio * scale;
};

const renderMarker = (object, image, interactive) => {
    const unit = objectSizePixels(object.type, image, object.style.scale);
    const strokeWidth = Math.max(2, unit * 0.13);
    const hitTarget = interactive
        ? '<circle data-bpb-hit-target="true" cx="0" cy="0" r="1.1"'
            + ' fill="transparent" stroke="none" pointer-events="all"/>'
        : '';
    return `<g data-bpb-object="${escapeXml(object.id)}"${opacityAttribute(object.style.opacity)}`
        + ` transform="translate(${number(object.geometry.x)} ${number(object.geometry.y)})`
        + ` rotate(${number(object.geometry.rotation)}) scale(${number(unit)})"`
        + ` stroke="${object.style.color}" stroke-width="${number(strokeWidth / unit)}"`
        + ' stroke-linecap="round" stroke-linejoin="round">'
        + markerGeometry(object.type, object.style.color)
        + `${hitTarget}</g>`;
};

const textAnchor = align => align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';

// Layout is shared by the editor, its interaction bounds, and flattened exports.
// Soft wraps are derived only; explicit newlines remain in the stored text.
const wrapText = (text, width, measure) => text.replace(/\r\n?/g, '\n').split('\n').flatMap(paragraph => {
    if (width == null) return [paragraph];
    const lines = [];
    let line = '';
    let gap = '';
    for (const token of paragraph.match(/\s+|\S+/gu) || []) {
        if (/^\s+$/u.test(token)) { gap += token; continue; }
        if (measure(line + gap + token) <= width) {
            line += gap + token;
        } else {
            if (line) lines.push(line);
            line = '';
            // Break an overlong word without splitting emoji or combining marks.
            const graphemes = typeof Intl.Segmenter === 'function'
                ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(token),
                    entry => entry.segment)
                : Array.from(token);
            for (const glyph of graphemes) {
                if (line && measure(line + glyph) > width) { lines.push(line); line = ''; }
                line += glyph;
            }
        }
        gap = '';
    }
    lines.push(line);
    return lines;
});

const labelLayout = (object, image, measureText) => {
    const isPitch = object.type === 'pitch';
    const fontSize = objectSizePixels(object.type, image, object.style.scale);
    const weight = isPitch ? 700 : 600;
    const measure = text => {
        const width = measureText?.(text, fontSize, weight);
        return Number.isFinite(width) && width >= 0 ? width : Array.from(text).length * fontSize * 0.61;
    };
    const lines = isPitch ? [`P${object.pitch}`]
        : wrapText(object.text.trim(), object.geometry.width, measure);
    const width = (!isPitch && object.geometry.width) || Math.max(fontSize * 0.2, ...lines.map(measure));
    const align = isPitch ? 'center' : object.style.align;
    const x = align === 'center' ? -width / 2 : align === 'right' ? -width : 0;
    const lineHeight = fontSize * 1.25;
    return { lines, width, x, y: -fontSize * 0.88,
        height: fontSize * 1.15 + (lines.length - 1) * lineHeight,
        lineHeight, fontSize, weight, anchor: textAnchor(align) };
};

const renderLabel = (object, image, interactive, measureText) => {
    const { lines, width, x, y, height, lineHeight, fontSize, weight, anchor }
        = labelLayout(object, image, measureText);
    const background = object.style.background
        ? `<rect x="${number(x - fontSize * 0.22)}" y="${number(y)}"`
            + ` width="${number(width + fontSize * 0.44)}"`
            + ` height="${number(height)}" rx="${number(fontSize * 0.16)}"`
            + ' fill="#000000" fill-opacity="0.72"/>'
        : '';
    const hitTarget = interactive
        ? `<rect data-bpb-hit-target="true" x="${number(x - fontSize * 0.3)}"`
            + ` y="${number(-fontSize * 1.1)}" width="${number(width + fontSize * 0.6)}"`
            + ` height="${number(height + fontSize * 0.45)}" rx="${number(fontSize * 0.16)}"`
            + ' fill="transparent" stroke="none" pointer-events="all"/>'
        : '';
    const box = interactive && object.type === 'text'
        ? `<rect data-bpb-text-box="true" x="${number(x)}" y="${number(y)}"`
            + ` width="${number(width)}" height="${number(height)}" fill="none" pointer-events="none"/>`
        : '';
    const content = lines.length === 1 ? escapeXml(lines[0]) : lines.map((line, index) =>
        `<tspan x="0" y="${number(index * lineHeight)}">${escapeXml(line)}</tspan>`).join('');
    return `<g data-bpb-object="${escapeXml(object.id)}"${opacityAttribute(object.style.opacity)}`
        + ` transform="translate(${number(object.geometry.x)} ${number(object.geometry.y)})`
        + ` rotate(${number(object.geometry.rotation)})">`
        + background
        + `<text x="0" y="0" fill="${object.style.color}"`
        + ` font-family="${escapeXml(FONT_FAMILY)}" font-size="${number(fontSize)}"`
        + ` font-weight="${weight}" text-anchor="${anchor}"`
        + ' dominant-baseline="alphabetic" xml:space="preserve">'
        + content
        + `</text>${hitTarget}${box}</g>`;
};

const arrowDefinition = color => [
    `<marker id="${arrowId(color)}" viewBox="0 0 10 10" refX="8.5" refY="5"`,
    ' markerWidth="5" markerHeight="5" orient="auto-start-reverse">',
    `<path d="M 0 0 L 10 5 L 0 10 z" fill="${color}"/>`,
    '</marker>',
].join('');

const renderOverlaySvg = (value, { interactive = false, document: documentImpl = globalThis.document } = {}) => {
    const project = Project.cleanProject(value);
    if (!project) throw new TypeError('photo renderer requires a clean project');
    let measureContext;
    if (project.objects.some(object => object.type === 'text' || object.type === 'pitch')) {
        try { measureContext = documentImpl?.createElement?.('canvas')?.getContext?.('2d'); }
        catch { /* The deterministic estimate remains available without canvas text metrics. */ }
    }
    const measureText = typeof measureContext?.measureText === 'function'
        ? (text, size, weight) => {
            measureContext.font = `${weight} ${number(size)}px ${FONT_FAMILY}`;
            return measureContext.measureText(text).width;
        }
        : null;
    const arrowColors = [...new Set(project.objects
        .filter(object => ['route', 'drawing'].includes(object.type) && object.style.end === 'arrow')
        .map(object => object.style.color))];
    const children = project.objects.map(object => {
        if (['route', 'drawing'].includes(object.type)) return renderRoute(object, project.image, interactive);
        if (Project.MARKER_TYPES.includes(object.type)) {
            return renderMarker(object, project.image, interactive);
        }
        return renderLabel(object, project.image, interactive, measureText);
    }).join('');
    const defs = arrowColors.length
        ? `<defs>${arrowColors.map(arrowDefinition).join('')}</defs>`
        : '';
    return `<svg xmlns="${XML_NS}" width="${project.image.width}" height="${project.image.height}"`
        + ` viewBox="0 0 ${project.image.width} ${project.image.height}">`
        + `${defs}${children}</svg>`;
};

const canvasBlob = (canvas, mime, quality) => new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error('The browser could not encode the edited photo.'));
    }, mime, quality);
});

const loadSvgImage = (svg, {
    ImageCtor = globalThis.Image,
    URLImpl = globalThis.URL,
    BlobCtor = globalThis.Blob,
} = {}) => new Promise((resolve, reject) => {
    const blob = new BlobCtor([svg], { type: 'image/svg+xml' });
    const url = URLImpl.createObjectURL(blob);
    const image = new ImageCtor();
    const done = callback => {
        URLImpl.revokeObjectURL(url);
        callback();
    };
    image.onload = () => done(() => resolve(image));
    image.onerror = () => done(() => reject(new Error('The browser could not render the topo overlay.')));
    image.src = url;
});

const sha256 = async (blob, cryptoImpl = globalThis.crypto) => {
    if (!cryptoImpl?.subtle) throw new Error('Secure hashing is unavailable in this browser.');
    const digest = await cryptoImpl.subtle.digest('SHA-256', await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

const estimateProject = async ({
    project: value,
    source,
    document: documentImpl = globalThis.document,
    imageDependencies,
} = {}) => {
    const project = Project.cleanProject(value);
    if (!project || !source || !documentImpl?.createElement) {
        throw new TypeError('photo renderer requires a clean project, source image, and document');
    }
    if (!Project.matchingImageDimensions(project.image, source)) {
        throw new RangeError('Photo project dimensions do not match its source image.');
    }
    const canvas = documentImpl.createElement('canvas');
    canvas.width = project.image.width;
    canvas.height = project.image.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas rendering is unavailable in this browser.');
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const overlay = await loadSvgImage(renderOverlaySvg(project, { document: documentImpl }), imageDependencies);
    context.drawImage(overlay, 0, 0, canvas.width, canvas.height);
    const blob = await canvasBlob(canvas, project.export.mime, project.export.quality);
    return {
        blob,
        mime: blob.type || project.export.mime,
        bytes: blob.size,
        width: canvas.width,
        height: canvas.height,
    };
};

const exportProject = async ({
    crypto: cryptoImpl = globalThis.crypto,
    ...options
} = {}) => {
    const encoded = await estimateProject(options);
    return {
        ...encoded,
        sha256: await sha256(encoded.blob, cryptoImpl),
    };
};

export const photoRenderer = {
    renderOverlaySvg,
    labelLayout,
    markerSymbolSvg,
    objectSizePixels,
    estimateProject,
    exportProject,
    sha256,
};
