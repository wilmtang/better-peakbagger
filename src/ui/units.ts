// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — one owner for unit constants, unit resolution, and the
// strings the user reads.
//
// FEET_PER_METER and METERS_PER_MILE used to be redeclared in four modules, and
// `units: 'auto'` was resolved by two unrelated page heuristics. Those two run
// on different pages, so they could not visibly disagree — which is exactly why
// a divergence would have shipped unnoticed. AGENTS.md already requires shared
// math to live in one place so drafted and displayed values cannot diverge.
//
// Pure by construction: no DOM or extension APIs. That is what
// lets the background worker, both content-script worlds, and the popup all
// bundle it. Page detection stays with the surface that owns the page — each
// passes its own probe to resolveUnits() against this one contract.

import { settingsSchema as Schema } from '../settings/settings-schema.ts';

export type UnitSystem = 'metric' | 'imperial';
export type UnitMeasurementKey = keyof typeof Schema.UNIT_KEYS;
export type UnitSettingsInput = {
    readonly units?: unknown;
    readonly distanceUnits?: unknown;
    readonly elevationUnits?: unknown;
    readonly temperatureUnits?: unknown;
    readonly precipitationUnits?: unknown;
    readonly windUnits?: unknown;
} | null | undefined;

const FEET_PER_METER = 3.28084;
const METERS_PER_MILE = 1609.344;

const METRIC: UnitSystem = 'metric';
const IMPERIAL: UnitSystem = 'imperial';

const feetFromMeters = (meters: number): number => meters * FEET_PER_METER;
const milesFromMeters = (meters: number): number => meters / METERS_PER_MILE;

// `probe` answers "what is this page already showing?" and is optional: a
// surface with no page to sniff (the popup) passes nothing. Anything other than
// a definite 'metric'/'imperial' falls back to imperial, matching Peakbagger's
// own default for a signed-out or unconfigured reader.
const resolveUnits = (
    settings?: UnitSettingsInput,
    probe?: (() => string | null | undefined) | null,
    measurement?: string
): UnitSystem => {
    const record = settings as Record<string, unknown> | null | undefined;
    const overrideKey = measurement && Object.hasOwn(Schema.UNIT_KEYS, measurement)
        ? Schema.UNIT_KEYS[measurement as UnitMeasurementKey]
        : undefined;
    const override = overrideKey ? record?.[overrideKey] : undefined;
    if (override === METRIC || override === IMPERIAL) return override;
    const preference = record?.units;
    if (preference === METRIC || preference === IMPERIAL) return preference;
    const probed = typeof probe === 'function' ? probe() : null;
    return probed === METRIC ? METRIC : IMPERIAL;
};

// Long ground distances: track length, distance walked.
const formatDistance = (meters: number, system: string): string => system === METRIC
    ? `${(meters / 1000).toFixed(1)} km`
    : `${milesFromMeters(meters).toFixed(1)} mi`;

// Vertical distances: elevations and elevation differences. `digits` exists for
// the few values where sub-unit precision is the point — the capture's max
// track deviation is a fidelity figure, and rounding 2.4 m to 2 m discards
// what it is there to say.
const formatElevation = (meters: number, system: string, digits = 0): string => {
    const value = system === METRIC ? meters : feetFromMeters(meters);
    return `${digits > 0 ? value.toFixed(digits) : Math.round(value)} ${system === METRIC ? 'm' : 'ft'}`;
};

// Short ground distances — how far a point sits from a summit. Same units as an
// elevation, but a distinct name so call sites stay readable.
const formatApproach = formatElevation;

const SYMBOLS = {
    distance: { metric: 'km', imperial: 'mi' },
    elevation: { metric: 'm', imperial: 'ft' },
    temperature: { metric: '°C', imperial: '°F' },
    precipitation: { metric: 'mm', imperial: 'in' },
    wind: { metric: 'km/h', imperial: 'mph' },
    cloud: { metric: '%', imperial: '%' },
    freezing: { metric: 'm', imperial: 'ft' }
} as const;
type WeatherMeasurement = keyof typeof SYMBOLS;

const symbol = (measurement: string, system: string): string =>
    Object.hasOwn(SYMBOLS, measurement) && (system === METRIC || system === IMPERIAL)
        ? SYMBOLS[measurement as WeatherMeasurement][system]
        : '';
const convertWeather = (value: number, measurement: string, system: string): number =>
    system !== IMPERIAL || measurement === 'cloud' ? value
        : measurement === 'temperature' ? value * 9 / 5 + 32
            : measurement === 'precipitation' ? value / 25.4
                : measurement === 'freezing' ? feetFromMeters(value) : value / (METERS_PER_MILE / 1000);
const weatherDigits = (measurement: string, system: string): number =>
    measurement === 'precipitation' ? system === IMPERIAL ? 2 : 1 : 0;
const formatWeather = (value: number | null | undefined, measurement: string, system: string): string =>
    typeof value === 'number' && Number.isFinite(value)
        ? `${convertWeather(value, measurement, system).toFixed(weatherDigits(measurement, system))}${measurement === 'temperature' || measurement === 'cloud' ? '' : ' '}${symbol(measurement, system)}`.replaceAll('-', '−')
        : '—';

export const units = {
    FEET_PER_METER,
    METERS_PER_MILE,
    METRIC,
    IMPERIAL,
    feetFromMeters,
    milesFromMeters,
    resolveUnits,
    symbol,
    convertWeather,
    weatherDigits,
    formatWeather,
    formatDistance,
    formatElevation,
    formatApproach
};
