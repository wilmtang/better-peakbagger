// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { photoProject as Project } from './photo-project.ts';

export interface PhotoToolRouteStyle {
    color: string;
    opacity: number;
    width: number;
    stroke: string;
    end: string;
    smooth: boolean;
}

export interface PhotoToolAnnotationStyle {
    color: string;
    opacity: number;
    scale: number;
    background?: boolean;
    align?: string;
}

export type PhotoToolStyle = PhotoToolRouteStyle | PhotoToolAnnotationStyle;

export interface PhotoToolPreference {
    style: PhotoToolStyle;
    rotation: number;
    width?: number | null;
}

type ProjectObjectType = (typeof Project.OBJECT_TYPES)[number];

const isProjectObjectType = (value: unknown): value is ProjectObjectType =>
    typeof value === 'string' && (Project.OBJECT_TYPES as readonly string[]).includes(value);

const defaults = (type: unknown): PhotoToolStyle => (type === 'route' || type === 'drawing') ? {
    color: Project.DEFAULT_COLOR, opacity: 1, width: 12,
    stroke: 'solid', end: 'none', smooth: false,
} : {
    color: Project.DEFAULT_COLOR, opacity: 1, scale: 1,
    ...(type === 'pitch' || type === 'text' ? { background: true } : {}),
    ...(type === 'text' ? { align: 'left' } : {}),
};

// Validate stored preferences through the same model that accepts annotations.
// Content, coordinates, and ids never become tool preferences.
const clean = (type: unknown, value?: unknown): PhotoToolPreference | null => {
    const style = defaults(type);
    if (!isProjectObjectType(type)) return null;
    const input = value && typeof value === 'object' ? value as Record<string, unknown> : null;
    const rawStyle = input?.style && typeof input.style === 'object' ? input.style as Record<string, unknown> : null;
    const rotation = typeof input?.rotation === 'number' && Number.isFinite(input.rotation)
        && Math.abs(input.rotation) <= 180 ? input.rotation : 0;
    const base = Project.createProject({
        localId: 'preferences', width: 100, height: 100, sourceSha256: '0'.repeat(64),
    });
    const candidate = (patch: Record<string, unknown>) => Project.addObject(base,
        type === 'route' || type === 'drawing'
            ? {
                id: 'preference',
                type,
                geometry: { points: [[0, 0], [1, 1]], controls: [] },
                style: { ...style, ...patch },
            }
            : type === 'pitch'
                ? {
                    id: 'preference',
                    type,
                    geometry: { x: 0, y: 0, rotation },
                    style: { ...style, ...patch },
                    pitch: 1,
                }
                : type === 'text'
                    ? {
                        id: 'preference',
                        type,
                        geometry: { x: 0, y: 0, rotation },
                        style: { ...style, ...patch },
                        text: 'Label',
                    }
                    : {
                        id: 'preference',
                        type,
                        geometry: { x: 0, y: 0, rotation },
                        style: { ...style, ...patch },
                    });
    // One corrupt field must not throw away the other saved choices.
    for (const key of Object.keys(style)) {
        if (rawStyle && Object.hasOwn(rawStyle, key)) {
            const result = candidate({ [key]: rawStyle[key] });
            const first = result?.objects[0];
            if (first) {
                (style as unknown as Record<string, unknown>)[key]
                    = (first.style as unknown as Record<string, unknown>)[key];
            }
        }
    }
    const width = input?.width;
    return { style, rotation,
        ...(type === 'text' && (width === null || (typeof width === 'number' && Number.isFinite(width)
            && width >= 1 && width <= Project.MAX_DIMENSION)) ? { width } : {}),
    };
};

export const photoToolPreferences = { defaults, clean, TYPES: Project.OBJECT_TYPES };
