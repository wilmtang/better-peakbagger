// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// @ts-expect-error tz-lookup ships no type declarations.
import tzlookup from 'tz-lookup';

export interface MountainZone {
    readonly timeZone: string | null;
    readonly offsetMs: number;
    readonly estimated: boolean;
}

export interface LocalFields {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
}

export interface CivilInstant {
    readonly ms: number;
    readonly date: string;
    readonly minute: number;
    readonly adjusted: boolean;
    readonly ambiguous: boolean;
}

export type DateTimeFormatConstructor = new (
    locales?: Intl.LocalesArgument,
    options?: Intl.DateTimeFormatOptions,
) => Intl.DateTimeFormat;

export interface FormatterOptions {
    DateTimeFormat?: DateTimeFormatConstructor;
}

export interface ClockFormatOptions extends FormatterOptions {
    locales?: Intl.LocalesArgument;
}

export interface ResolveMountainTimeOptions extends FormatterOptions {
    lookup?: (lat: number, lon: number) => unknown;
}

export interface CivilToInstantOptions extends FormatterOptions {
    snapForward?: boolean;
}

const defaultLookup = tzlookup as (lat: number, lon: number) => string;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FORMATTER_CACHE_LIMIT = 64;
const formatterCaches = new WeakMap<DateTimeFormatConstructor, Map<string, Intl.DateTimeFormat>>();

const isFiniteNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);
const finiteInstant = (value: unknown): value is number =>
    isFiniteNumber(value) && Math.abs(value) <= 8.64e15;
const isValidMinute = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1439;
const validCoordinate = (lat: unknown, lon: unknown): boolean =>
    isFiniteNumber(lat) && isFiniteNumber(lon)
    && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;

function parseCivilDate(value: unknown): {
    year: number;
    month: number;
    day: number;
    ms: number;
    date: string;
} | null {
    if (typeof value !== 'string') return null;
    const match = DATE_RE.exec(value);
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

function dateParts(formatter: Intl.DateTimeFormat, ms: number): LocalFields | null {
    const values: Record<string, string> = {};
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

function isoDate({ year, month, day }: Pick<LocalFields, 'year' | 'month' | 'day'>): string {
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function fallbackLabel(offsetMs: number): string {
    const hours = Math.round(offsetMs / 3_600_000);
    return `UTC${hours < 0 ? '−' : '+'}${Math.abs(hours)}, estimated from longitude`;
}

function cachedFormatter(
    DateTimeFormat: DateTimeFormatConstructor,
    locales: Intl.LocalesArgument,
    options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
    if (typeof DateTimeFormat !== 'function') throw new TypeError('invalid formatter constructor');
    let cache = formatterCaches.get(DateTimeFormat);
    if (!cache) {
        cache = new Map<string, Intl.DateTimeFormat>();
        formatterCaches.set(DateTimeFormat, cache);
    }
    const key = JSON.stringify([locales, options]);
    if (cache.has(key)) {
        const cached = cache.get(key)!;
        cache.delete(key);
        cache.set(key, cached);
        return cached;
    }
    const created = new DateTimeFormat(locales, options);
    cache.set(key, created);
    if (cache.size > FORMATTER_CACHE_LIMIT) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey !== undefined) cache.delete(oldestKey);
    }
    return created;
}

export function longitudeOffsetMs(lon: number): number | null {
    if (!isFiniteNumber(lon) || lon < -180 || lon > 180) return null;
    return Math.round(lon / 15) * 3_600_000;
}

export function resolveMountainTime(
    lat: number,
    lon: number,
    {
        lookup = defaultLookup,
        DateTimeFormat = Intl.DateTimeFormat,
    }: ResolveMountainTimeOptions = {},
): MountainZone | null {
    if (!validCoordinate(lat, lon)) return null;
    const offsetMs = longitudeOffsetMs(lon);
    if (offsetMs === null) return null;
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

function wallFormatter(
    zone: MountainZone,
    DateTimeFormat: DateTimeFormatConstructor = Intl.DateTimeFormat,
): Intl.DateTimeFormat {
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

export function localFields(
    zone: MountainZone | null | undefined,
    ms: number | null | undefined,
    { DateTimeFormat = Intl.DateTimeFormat }: FormatterOptions = {},
): LocalFields | null {
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

export function localDate(
    zone: MountainZone | null | undefined,
    ms: number | null | undefined,
    options?: FormatterOptions,
): string | null {
    const fields = localFields(zone, ms, options);
    return fields ? isoDate(fields) : null;
}

export function localMinute(
    zone: MountainZone | null | undefined,
    ms: number | null | undefined,
    options?: FormatterOptions,
): number | null {
    const fields = localFields(zone, ms, options);
    return fields ? fields.hour * 60 + fields.minute : null;
}

export function zoneLabel(
    zone: MountainZone | null | undefined,
    referenceMs: number | null | undefined,
    {
        DateTimeFormat = Intl.DateTimeFormat,
    }: FormatterOptions = {},
): string | null {
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

export function zoneDescription(
    zone: MountainZone | null | undefined,
    referenceMs: number | null | undefined,
    {
        DateTimeFormat = Intl.DateTimeFormat,
    }: FormatterOptions = {},
): string | null {
    if (!zone || !finiteInstant(referenceMs)) return null;
    if (!zone.timeZone) return fallbackLabel(zone.offsetMs);
    try {
        const name = (style: 'long' | 'short') => cachedFormatter(DateTimeFormat, [], {
            timeZone: zone.timeZone!,
            timeZoneName: style,
        }).formatToParts(referenceMs).find(part => part.type === 'timeZoneName')?.value;
        const long = name('long');
        const short = name('short');
        return long && short && long !== short ? `${long} (${short})` : long || short || zone.timeZone;
    } catch {
        return zone.timeZone;
    }
}

export function formatClock(
    zone: MountainZone | null | undefined,
    ms: number | null | undefined,
    {
        locales = [],
        DateTimeFormat = Intl.DateTimeFormat,
    }: ClockFormatOptions = {},
): string | null {
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

export function formatCivilClock(
    minute: number | null | undefined,
    {
        locales = [],
        DateTimeFormat = Intl.DateTimeFormat,
    }: ClockFormatOptions = {},
): string | null {
    if (!isValidMinute(minute)) return null;
    try {
        return cachedFormatter(DateTimeFormat, locales, {
            hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
        }).format(minute * MINUTE_MS);
    } catch {
        return null;
    }
}

export function localDayNumber(
    zone: MountainZone | null | undefined,
    ms: number | null | undefined,
    options?: FormatterOptions,
): number | null {
    const date = localDate(zone, ms, options);
    const parsed = parseCivilDate(date);
    return parsed ? parsed.ms / DAY_MS : null;
}

function offsetAt(
    timeZone: string,
    ms: number,
    DateTimeFormat: DateTimeFormatConstructor,
): number | null {
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

function wallMsFromFields(fields: LocalFields): number {
    return Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute);
}

function firstValidAfterGap(
    zone: MountainZone,
    wallMs: number,
    DateTimeFormat: DateTimeFormatConstructor,
): { ms: number; adjustment: number } | null {
    if (!zone.timeZone) return null;
    const start = wallMs - 48 * 3_600_000;
    const end = wallMs + 48 * 3_600_000;
    const step = 3_600_000;
    let previousMs = start;
    let previousOffset = offsetAt(zone.timeZone, previousMs, DateTimeFormat);
    let best: { ms: number; adjustment: number } | null = null;
    for (let sampleMs = start + step; sampleMs <= end; sampleMs += step) {
        const sampleOffset = offsetAt(zone.timeZone, sampleMs, DateTimeFormat);
        if (isFiniteNumber(previousOffset) && isFiniteNumber(sampleOffset)
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

function matchingInstants(
    zone: MountainZone,
    date: string,
    minute: number,
    DateTimeFormat: DateTimeFormatConstructor,
): number[] {
    const parsed = parseCivilDate(date);
    if (!parsed || !isValidMinute(minute)) return [];
    const wallMs = parsed.ms + minute * MINUTE_MS;
    if (!zone.timeZone) return [wallMs - zone.offsetMs];

    const offsets = new Set<number>();
    for (let deltaHours = -48; deltaHours <= 48; deltaHours += 6) {
        const offset = offsetAt(zone.timeZone, wallMs + deltaHours * 3_600_000, DateTimeFormat);
        if (isFiniteNumber(offset)) offsets.add(offset);
    }
    const matches: number[] = [];
    for (const offset of offsets) {
        const candidate = wallMs - offset;
        const fields = localFields(zone, candidate, { DateTimeFormat });
        if (fields && isoDate(fields) === date && fields.hour * 60 + fields.minute === minute) {
            matches.push(candidate);
        }
    }
    return [...new Set(matches)].sort((a, b) => a - b);
}

export function civilToInstant(
    zone: MountainZone | null | undefined,
    date: string | null | undefined,
    minute: number | null | undefined,
    {
        DateTimeFormat = Intl.DateTimeFormat,
        snapForward = true,
    }: CivilToInstantOptions = {},
): CivilInstant | null {
    if (!zone) return null;
    const parsed = parseCivilDate(date);
    if (!parsed || !isValidMinute(minute)) return null;
    const matches = matchingInstants(zone, parsed.date, minute, DateTimeFormat);
    if (matches.length) return Object.freeze({
        ms: matches[0], date: parsed.date, minute, adjusted: false, ambiguous: matches.length > 1,
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
    localDate,
    localMinute,
    zoneLabel,
    zoneDescription,
    formatClock,
    formatCivilClock,
    localDayNumber,
    civilToInstant,
});
