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

const renderRoute = object => {
    const dash = dashArray(object.style.stroke, object.style.width);
    const marker = object.style.end === 'arrow'
        ? ` marker-end="url(#${arrowId(object.style.color)})"`
        : '';
    return `<g data-bpb-object="${escapeXml(object.id)}"${opacityAttribute(object.style.opacity)}>`
        + `<path d="${routePath(object)}"`
        + ` fill="none" stroke="${object.style.color}" stroke-width="${number(object.style.width)}"`
        + ' stroke-linecap="round" stroke-linejoin="round"'
        + (dash ? ` stroke-dasharray="${dash}"` : '')
        + `${marker}/></g>`;
};

// Climbing-guidebook symbols, drawn in a unit box the marker transform scales.
// There is no single universal legend — the UIAA publishes a recommended set
// and publishers extend it — so these follow the conventions climbers read
// without a key: a circle is a bolt, a bolted anchor is two of them slung to a
// master point, a piton is a bladed peg with an eye, a rappel station is a ring
// with the rope running down out of it, and a belay is the stance bar the
// leader stops on. `photos/guide.html` shows the same glyphs with their names.
const markerGeometry = (type, color) => {
    if (type === 'bolt') {
        return '<circle cx="0" cy="0" r="0.5" fill="none"/>'
            + `<circle cx="0" cy="0" r="0.17" fill="${color}" stroke="none"/>`;
    }
    if (type === 'anchor') {
        return '<circle cx="-0.56" cy="-0.5" r="0.24" fill="none"/>'
            + '<circle cx="0.56" cy="-0.5" r="0.24" fill="none"/>'
            + '<circle cx="0" cy="0.6" r="0.24" fill="none"/>'
            + '<path d="M -0.56 -0.26 L 0 0.36 L 0.56 -0.26" fill="none"/>';
    }
    if (type === 'piton') {
        return '<circle cx="-0.6" cy="-0.6" r="0.22" fill="none"/>'
            + '<path d="M -0.62 -0.2 L -0.2 -0.62 L 0.84 0.7 L 0.7 0.84 Z" fill="none"/>';
    }
    if (type === 'rappel') {
        return '<circle cx="0" cy="-0.62" r="0.24" fill="none"/>'
            + '<path d="M -0.16 -0.4 V 0.5 M 0.16 -0.4 V 0.5" fill="none"/>'
            + '<path d="M -0.42 0.36 L 0 0.82 L 0.42 0.36" fill="none"/>';
    }
    return '<path d="M -0.85 0.5 H 0.85 M -0.5 0.5 V 0.78 M 0.5 0.5 V 0.78" fill="none"/>'
        + `<circle cx="0" cy="0.04" r="0.3" fill="${color}" stroke="none"/>`
        + '<path d="M 0 0.34 V 0.5" fill="none"/>';
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

const renderMarker = (object, image) => {
    const unit = objectSizePixels(object.type, image, object.style.scale);
    const strokeWidth = Math.max(2, unit * 0.13);
    return `<g data-bpb-object="${escapeXml(object.id)}"${opacityAttribute(object.style.opacity)}`
        + ` transform="translate(${number(object.geometry.x)} ${number(object.geometry.y)})`
        + ` rotate(${number(object.geometry.rotation)}) scale(${number(unit)})"`
        + ` stroke="${object.style.color}" stroke-width="${number(strokeWidth / unit)}"`
        + ' stroke-linecap="round" stroke-linejoin="round">'
        + markerGeometry(object.type, object.style.color)
        + '</g>';
};

const textAnchor = align => align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';

const renderLabel = (object, image) => {
    const isPitch = object.type === 'pitch';
    const text = isPitch ? `P${object.pitch}` : object.text;
    const fontSize = objectSizePixels(object.type, image, object.style.scale);
    const align = isPitch ? 'center' : object.style.align;
    const anchor = textAnchor(align);
    const estimatedWidth = Math.max(fontSize * 1.15, text.length * fontSize * 0.61);
    const xOffset = align === 'center' ? -estimatedWidth / 2
        : align === 'right' ? -estimatedWidth : 0;
    const background = object.style.background
        ? `<rect x="${number(xOffset - fontSize * 0.22)}" y="${number(-fontSize * 0.88)}"`
            + ` width="${number(estimatedWidth + fontSize * 0.44)}"`
            + ` height="${number(fontSize * 1.15)}" rx="${number(fontSize * 0.16)}"`
            + ' fill="#000000" fill-opacity="0.72"/>'
        : '';
    return `<g data-bpb-object="${escapeXml(object.id)}"${opacityAttribute(object.style.opacity)}`
        + ` transform="translate(${number(object.geometry.x)} ${number(object.geometry.y)})`
        + ` rotate(${number(object.geometry.rotation)})">`
        + background
        + `<text x="0" y="0" fill="${object.style.color}"`
        + ` font-family="${escapeXml(FONT_FAMILY)}" font-size="${number(fontSize)}"`
        + ` font-weight="${isPitch ? '700' : '600'}" text-anchor="${anchor}"`
        + ' dominant-baseline="alphabetic">'
        + escapeXml(text)
        + '</text></g>';
};

const arrowDefinition = color => [
    `<marker id="${arrowId(color)}" viewBox="0 0 10 10" refX="8.5" refY="5"`,
    ' markerWidth="5" markerHeight="5" orient="auto-start-reverse">',
    `<path d="M 0 0 L 10 5 L 0 10 z" fill="${color}"/>`,
    '</marker>',
].join('');

const renderOverlaySvg = value => {
    const project = Project.cleanProject(value);
    if (!project) throw new TypeError('photo renderer requires a clean project');
    const arrowColors = [...new Set(project.objects
        .filter(object => object.type === 'route' && object.style.end === 'arrow')
        .map(object => object.style.color))];
    const children = project.objects.map(object => {
        if (object.type === 'route') return renderRoute(object);
        if (Project.MARKER_TYPES.includes(object.type)) return renderMarker(object, project.image);
        return renderLabel(object, project.image);
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
    const canvas = documentImpl.createElement('canvas');
    canvas.width = project.image.width;
    canvas.height = project.image.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas rendering is unavailable in this browser.');
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const overlay = await loadSvgImage(renderOverlaySvg(project), imageDependencies);
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
    markerSymbolSvg,
    objectSizePixels,
    estimateProject,
    exportProject,
    sha256,
};
