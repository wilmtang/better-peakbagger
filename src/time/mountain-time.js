// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import tzlookup from 'tz-lookup';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FORMATTER_CACHE_LIMIT = 64;
const formatterCaches = new WeakMap();

const finiteInstant = value => Number.isFinite(value) && Math.abs(value) <= 8.64e15;
const validCoordinate = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon)
    && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;

function parseCivilDate(value) {
    const match = typeof value === 'string' ? DATE_RE.exec(value) : null;
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const ms = Date.UTC(year, month - 1, day);
    const date = new Date(ms);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1
        || date.getUTCDate() !== day) return null;
    return { year, month, day, ms, date: value };
}

function dateParts(formatter, ms) {
    const values = {};
    for (const part of formatter.formatToParts(ms)) {
        if (part.type !== 'literal') values[part.type] = part.value;
    }
    const year = Number(values.year);
    const month = Number(values.month);
    const day = Number(values.day);
    const hour = Number(values.hour);
    const minute = Number(values.minute);
    if (![year, month, day, hour, minute].every(Number.isFinite)) return null;
    return { year, month, day, hour: hour === 24 ? 0 : hour, minute };
}

function isoDate({ year, month, day }) {
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function fallbackLabel(offsetMs) {
    const hours = Math.round(offsetMs / 3_600_000);
    return `UTC${hours < 0 ? '−' : '+'}${Math.abs(hours)}, estimated from longitude`;
}

function cachedFormatter(DateTimeFormat, locales, options) {
    if (typeof DateTimeFormat !== 'function') throw new TypeError('invalid formatter constructor');
    let cache = formatterCaches.get(DateTimeFormat);
    if (!cache) {
        cache = new Map();
        formatterCaches.set(DateTimeFormat, cache);
    }
    const key = JSON.stringify([locales, options]);
    if (cache.has(key)) {
        const cached = cache.get(key);
        cache.delete(key);
        cache.set(key, cached);
        return cached;
    }
    const created = new DateTimeFormat(locales, options);
    cache.set(key, created);
    if (cache.size > FORMATTER_CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return created;
}

export function longitudeOffsetMs(lon) {
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) return null;
    return Math.round(lon / 15) * 3_600_000;
}

export function resolveMountainTime(lat, lon, {
    lookup = tzlookup,
    DateTimeFormat = Intl.DateTimeFormat,
} = {}) {
    if (!validCoordinate(lat, lon)) return null;
    const offsetMs = longitudeOffsetMs(lon);
    try {
        const timeZone = lookup(lat, lon);
        if (typeof timeZone !== 'string' || !timeZone) throw new RangeError('invalid timezone');
        const resolvedFormatter = cachedFormatter(DateTimeFormat, 'en-CA', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        });
        if (!dateParts(resolvedFormatter, 0)) throw new RangeError('unusable timezone formatter');
        return Object.freeze({ timeZone, offsetMs, estimated: false });
    } catch {
        return Object.freeze({ timeZone: null, offsetMs, estimated: true });
    }
}

function wallFormatter(zone, DateTimeFormat = Intl.DateTimeFormat) {
    return cachedFormatter(DateTimeFormat, 'en-CA', {
        timeZone: zone.timeZone || 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    });
}

export function localFields(zone, ms, { DateTimeFormat = Intl.DateTimeFormat } = {}) {
    if (!zone || !finiteInstant(ms)) return null;
    try {
        if (!zone.timeZone) {
            const date = new Date(ms + zone.offsetMs);
            return {
                year: date.getUTCFullYear(),
                month: date.getUTCMonth() + 1,
                day: date.getUTCDate(),
                hour: date.getUTCHours(),
                minute: date.getUTCMinutes(),
            };
        }
        return dateParts(wallFormatter(zone, DateTimeFormat), ms);
    } catch {
        return null;
    }
}

export function localDate(zone, ms, options) {
    const fields = localFields(zone, ms, options);
    return fields ? isoDate(fields) : null;
}

export function localMinute(zone, ms, options) {
    const fields = localFields(zone, ms, options);
    return fields ? fields.hour * 60 + fields.minute : null;
}

export function zoneLabel(zone, referenceMs, {
    DateTimeFormat = Intl.DateTimeFormat,
} = {}) {
    if (!zone || !finiteInstant(referenceMs)) return null;
    if (!zone.timeZone) return fallbackLabel(zone.offsetMs);
    try {
        const part = cachedFormatter(DateTimeFormat, [], {
            timeZone: zone.timeZone,
            timeZoneName: 'short',
        }).formatToParts(referenceMs).find(candidate => candidate.type === 'timeZoneName');
        return part?.value || zone.timeZone;
    } catch {
        return zone.timeZone;
    }
}

export function zoneDescription(zone, referenceMs, {
    DateTimeFormat = Intl.DateTimeFormat,
} = {}) {
    if (!zone || !finiteInstant(referenceMs)) return null;
    if (!zone.timeZone) return fallbackLabel(zone.offsetMs);
    try {
        const name = style => cachedFormatter(DateTimeFormat, [], {
            timeZone: zone.timeZone,
            timeZoneName: style,
        }).formatToParts(referenceMs).find(part => part.type === 'timeZoneName')?.value;
        const long = name('long');
        const short = name('short');
        return long && short && long !== short ? `${long} (${short})` : long || short || zone.timeZone;
    } catch {
        return zone.timeZone;
    }
}

export function formatClock(zone, ms, {
    locales = [],
    DateTimeFormat = Intl.DateTimeFormat,
} = {}) {
    if (!zone || !finiteInstant(ms)) return null;
    try {
        if (!zone.timeZone) {
            return new Date(ms + zone.offsetMs).toLocaleTimeString(locales, {
                hour: '2-digit',
                minute: '2-digit',
                timeZone: 'UTC',
            });
        }
        return cachedFormatter(DateTimeFormat, locales, {
            hour: '2-digit', minute: '2-digit', timeZone: zone.timeZone,
        }).format(ms);
    } catch {
        return null;
    }
}

export function formatCivilClock(minute, {
    locales = [],
    DateTimeFormat = Intl.DateTimeFormat,
} = {}) {
    if (!Number.isInteger(minute) || minute < 0 || minute > 1439) return null;
    try {
        return cachedFormatter(DateTimeFormat, locales, {
            hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
        }).format(minute * MINUTE_MS);
    } catch {
        return null;
    }
}

export function localDayNumber(zone, ms, options) {
    const date = localDate(zone, ms, options);
    const parsed = parseCivilDate(date);
    return parsed ? parsed.ms / DAY_MS : null;
}

export function relativeLocalDay(zone, ms, startMs, options) {
    const day = localDayNumber(zone, ms, options);
    const startDay = localDayNumber(zone, startMs, options);
    return day === null || startDay === null ? null : day - startDay + 1;
}

function offsetAt(timeZone, ms, DateTimeFormat) {
    const fields = dateParts(cachedFormatter(DateTimeFormat, 'en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }), ms);
    if (!fields) return null;
    return Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute)
        - Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

function wallMsFromFields(fields) {
    return Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute);
}

function firstValidAfterGap(zone, wallMs, DateTimeFormat) {
    if (!zone.timeZone) return null;
    const start = wallMs - 48 * 3_600_000;
    const end = wallMs + 48 * 3_600_000;
    const step = 3_600_000;
    let previousMs = start;
    let previousOffset = offsetAt(zone.timeZone, previousMs, DateTimeFormat);
    let best = null;
    for (let sampleMs = start + step; sampleMs <= end; sampleMs += step) {
        const sampleOffset = offsetAt(zone.timeZone, sampleMs, DateTimeFormat);
        if (Number.isFinite(previousOffset) && Number.isFinite(sampleOffset)
            && previousOffset !== sampleOffset) {
            let low = previousMs;
            let high = sampleMs;
            const lowOffset = previousOffset;
            while (high - low > MINUTE_MS) {
                const middle = Math.floor((low + high) / (2 * MINUTE_MS)) * MINUTE_MS;
                if (offsetAt(zone.timeZone, middle, DateTimeFormat) === lowOffset) low = middle;
                else high = middle;
            }
            const fields = localFields(zone, high, { DateTimeFormat });
            const candidateWallMs = fields ? wallMsFromFields(fields) : Number.NaN;
            const adjustment = (candidateWallMs - wallMs) / MINUTE_MS;
            if (Number.isInteger(adjustment) && adjustment >= 0 && adjustment <= 1440
                && (!best || adjustment < best.adjustment
                    || (adjustment === best.adjustment && high < best.ms))) {
                best = { ms: high, adjustment };
            }
        }
        previousMs = sampleMs;
        previousOffset = sampleOffset;
    }
    return best;
}

function matchingInstants(zone, date, minute, DateTimeFormat) {
    const parsed = parseCivilDate(date);
    if (!parsed || !Number.isInteger(minute) || minute < 0 || minute > 1439) return [];
    const wallMs = parsed.ms + minute * MINUTE_MS;
    if (!zone.timeZone) return [wallMs - zone.offsetMs];

    const offsets = new Set();
    for (let deltaHours = -48; deltaHours <= 48; deltaHours += 6) {
        const offset = offsetAt(zone.timeZone, wallMs + deltaHours * 3_600_000, DateTimeFormat);
        if (Number.isFinite(offset)) offsets.add(offset);
    }
    const matches = [];
    for (const offset of offsets) {
        const candidate = wallMs - offset;
        const fields = localFields(zone, candidate, { DateTimeFormat });
        if (fields && isoDate(fields) === date && fields.hour * 60 + fields.minute === minute) {
            matches.push(candidate);
        }
    }
    return [...new Set(matches)].sort((a, b) => a - b);
}

export function civilToInstant(zone, date, minute, {
    DateTimeFormat = Intl.DateTimeFormat,
    snapForward = true,
} = {}) {
    if (!zone) return null;
    const parsed = parseCivilDate(date);
    if (!parsed || !Number.isInteger(minute) || minute < 0 || minute > 1439) return null;
    const matches = matchingInstants(zone, date, minute, DateTimeFormat);
    if (matches.length) return Object.freeze({
        ms: matches[0], date, minute, adjusted: false, ambiguous: matches.length > 1,
    });
    if (!snapForward) return null;
    const gap = firstValidAfterGap(zone, parsed.ms + minute * MINUTE_MS, DateTimeFormat);
    if (!gap) return null;
    const fields = localFields(zone, gap.ms, { DateTimeFormat });
    if (!fields) return null;
    return Object.freeze({
        ms: gap.ms,
        date: isoDate(fields),
        minute: fields.hour * 60 + fields.minute,
        adjusted: true,
        ambiguous: false,
    });
}

export const mountainTime = Object.freeze({
    resolve: resolveMountainTime,
    longitudeOffsetMs,
    localFields,
    localDate,
    localMinute,
    zoneLabel,
    zoneDescription,
    formatClock,
    formatCivilClock,
    localDayNumber,
    relativeLocalDay,
    civilToInstant,
});
