// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mountainTime, type MountainZone } from '../time/mountain-time.ts';

export interface SentinelCaptureChoiceInput {
    time: number;
    cloud?: number | null;
}

export interface SentinelCaptureChoice {
    id: string;
    label: string;
    title: string;
}

const captureDate = (time: number, zone: MountainZone | null | undefined, includeZone = true): string => {
    const date = mountainTime.localDate(zone, time);
    const minute = mountainTime.localMinute(zone, time);
    if (!date || minute === null) {
        if (zone?.timeZone) return captureDate(time, { timeZone: null, offsetMs: zone.offsetMs, estimated: true }, includeZone);
        return new Date(time).toISOString().slice(0, 16).replace('T', ' ') + (includeZone ? ' UTC' : '');
    }
    const pad = (value: number): string => String(value).padStart(2, '0');
    return `${date} ${pad(Math.floor(minute / 60))}:${pad(minute % 60)}${includeZone ? ` ${mountainTime.zoneLabel(zone, time)}` : ''}`;
};

const cloudCover = (cloud: number | null | undefined): string =>
    typeof cloud === 'number' && Number.isFinite(cloud) ? `${Math.round(cloud)}%` : 'unknown';

// Shared capture labels for the native and terrain overlay sessions.
export const sentinelCaptureChoice = (
    capture: SentinelCaptureChoiceInput,
    zone: MountainZone | null | undefined,
    id: string,
    latest = false,
): SentinelCaptureChoice => {
    const date = captureDate(capture.time, zone, false), cloud = cloudCover(capture.cloud);
    return {
        id,
        label: `${latest ? `Latest · ${date.slice(5)}` : date} · ☁ ${cloud === 'unknown' ? '?' : cloud}`,
        title: `${latest ? 'Latest · ' : ''}${captureDate(capture.time, zone)} · Clouds ${cloud}`,
    };
};
