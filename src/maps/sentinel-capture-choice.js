// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mountainTime } from '../time/mountain-time.js';

const captureDate = (time, zone, includeZone = true) => {
    const date = mountainTime.localDate(zone, time);
    const minute = mountainTime.localMinute(zone, time);
    if (!date || minute === null) {
        if (zone?.timeZone) return captureDate(time, { timeZone: null, offsetMs: zone.offsetMs }, includeZone);
        return new Date(time).toISOString().slice(0, 16).replace('T', ' ') + (includeZone ? ' UTC' : '');
    }
    const pad = value => String(value).padStart(2, '0');
    return `${date} ${pad(Math.floor(minute / 60))}:${pad(minute % 60)}${includeZone ? ` ${mountainTime.zoneLabel(zone, time)}` : ''}`;
};

const cloudCover = cloud => Number.isFinite(cloud) ? Math.round(cloud) + '%' : 'unknown';

// Shared capture labels for the native and terrain overlay sessions.
export const sentinelCaptureChoice = (capture, zone, id, latest = false) => {
    const date = captureDate(capture.time, zone, false), cloud = cloudCover(capture.cloud);
    return { id, label: `${latest ? `Latest · ${date.slice(5)}` : date} · ☁ ${cloud === 'unknown' ? '?' : cloud}`,
        title: `${latest ? 'Latest · ' : ''}${captureDate(capture.time, zone)} · Clouds ${cloud}` };
};
