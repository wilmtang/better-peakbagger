// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { photoProject as Project } from './photo-project.js';

const defaults = type => ['route', 'drawing'].includes(type) ? {
    color: Project.DEFAULT_COLOR, opacity: 1, width: 12,
    stroke: 'solid', end: 'none', smooth: false,
} : {
    color: Project.DEFAULT_COLOR, opacity: 1, scale: 1,
    ...(['pitch', 'text'].includes(type) ? { background: true } : {}),
    ...(type === 'text' ? { align: 'left' } : {}),
};

// Validate stored preferences through the same model that accepts annotations.
// Content, coordinates, and ids never become tool preferences.
const clean = (type, value) => {
    const style = defaults(type);
    if (!Project.OBJECT_TYPES.includes(type)) return null;
    const rotation = typeof value?.rotation === 'number' && Number.isFinite(value.rotation)
        && Math.abs(value.rotation) <= 180 ? value.rotation : 0;
    const base = Project.createProject({
        localId: 'preferences', width: 100, height: 100, sourceSha256: '0'.repeat(64),
    });
    const candidate = patch => Project.addObject(base, {
        id: 'preference', type,
        geometry: ['route', 'drawing'].includes(type) ? { points: [[0, 0], [1, 1]], controls: [] }
            : { x: 0, y: 0, rotation },
        style: { ...style, ...patch }, pitch: 1, text: 'Label',
    });
    // One corrupt field must not throw away the other saved choices.
    for (const key of Object.keys(style)) {
        if (value?.style && Object.hasOwn(value.style, key)) {
            const result = candidate({ [key]: value.style[key] });
            if (result) style[key] = result.objects[0].style[key];
        }
    }
    const width = value?.width;
    return { style, rotation,
        ...(type === 'text' && (width === null || (Number.isFinite(width)
            && width >= 1 && width <= Project.MAX_DIMENSION)) ? { width } : {}),
    };
};

export const photoToolPreferences = { defaults, clean };
