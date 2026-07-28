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

const renderRoute = object => {
    const dash = dashArray(object.style.stroke, object.style.width);
    const marker = object.style.end === 'arrow' ? ' marker-end="url(#bpb-arrow)"' : '';
    return `<path data-bpb-object="${escapeXml(object.id)}" d="${routePath(object)}"`
        + ` fill="none" stroke="${object.style.color}" stroke-width="${number(object.style.width)}"`
        + ' stroke-linecap="round" stroke-linejoin="round"'
        + (dash ? ` stroke-dasharray="${dash}"` : '')
        + `${marker}/>`;
};

const markerGeometry = type => {
    if (type === 'anchor') {
        return '<circle cx="0" cy="-0.15" r="0.52" fill="none"/>'
            + '<path d="M 0 -0.65 V 0.72 M -0.48 0.3 Q 0 0.9 0.48 0.3" fill="none"/>';
    }
    if (type === 'piton') {
        return '<path d="M -0.58 -0.42 L 0.42 0.58 M -0.18 -0.7 L 0.68 0.18" fill="none"/>'
            + '<circle cx="-0.34" cy="-0.54" r="0.18" fill="none"/>';
    }
    if (type === 'rappel') {
        return '<circle cx="0" cy="-0.34" r="0.28" fill="none"/>'
            + '<path d="M 0 -0.05 V 0.72 M -0.38 0.24 L 0 0.56 L 0.38 0.24" fill="none"/>';
    }
    return '<circle cx="0" cy="0" r="0.54" fill="none"/>'
        + '<path d="M -0.38 -0.38 L 0.38 0.38 M 0.38 -0.38 L -0.38 0.38" fill="none"/>';
};

const renderMarker = (object, image) => {
    const unit = Math.min(image.width, image.height) * 0.027 * object.style.scale;
    const strokeWidth = Math.max(2, unit * 0.13);
    return `<g data-bpb-object="${escapeXml(object.id)}"`
        + ` transform="translate(${number(object.geometry.x)} ${number(object.geometry.y)})`
        + ` rotate(${number(object.geometry.rotation)}) scale(${number(unit)})"`
        + ` stroke="${object.style.color}" stroke-width="${number(strokeWidth / unit)}"`
        + ' stroke-linecap="round" stroke-linejoin="round">'
        + markerGeometry(object.type)
        + '</g>';
};

const textAnchor = align => align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';

const renderLabel = (object, image) => {
    const isPitch = object.type === 'pitch';
    const text = isPitch ? `P${object.pitch}` : object.text;
    const scale = object.style.scale;
    const fontSize = Math.min(image.width, image.height) * 0.035 * scale;
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
    return `<g data-bpb-object="${escapeXml(object.id)}"`
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
    '<marker id="bpb-arrow" viewBox="0 0 10 10" refX="8.5" refY="5"',
    ' markerWidth="5" markerHeight="5" orient="auto-start-reverse">',
    `<path d="M 0 0 L 10 5 L 0 10 z" fill="${color}"/>`,
    '</marker>',
].join('');

const renderOverlaySvg = value => {
    const project = Project.cleanProject(value);
    if (!project) throw new TypeError('photo renderer requires a clean project');
    const arrowColor = project.objects.find(object =>
        object.type === 'route' && object.style.end === 'arrow')?.style.color || Project.DEFAULT_COLOR;
    const children = project.objects.map(object => {
        if (object.type === 'route') return renderRoute(object);
        if (['anchor', 'piton', 'rappel', 'belay'].includes(object.type)) {
            return renderMarker(object, project.image);
        }
        return renderLabel(object, project.image);
    }).join('');
    return `<svg xmlns="${XML_NS}" width="${project.image.width}" height="${project.image.height}"`
        + ` viewBox="0 0 ${project.image.width} ${project.image.height}">`
        + `<defs>${arrowDefinition(arrowColor)}</defs>${children}</svg>`;
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

const exportProject = async ({
    project: value,
    source,
    document: documentImpl = globalThis.document,
    crypto: cryptoImpl = globalThis.crypto,
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
        sha256: await sha256(blob, cryptoImpl),
    };
};

export const photoRenderer = {
    renderOverlaySvg,
    exportProject,
    sha256,
};
