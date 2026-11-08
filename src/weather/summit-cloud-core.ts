// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { HumidityBasis } from './summit-cloud-models.ts';

export const CLOUD_STATES = Object.freeze({
    inside: { title: 'Summit likely inside cloud', short: 'In cloud' },
    blocked: { title: 'Nearby views likely blocked', short: 'Blocked' },
    partial: { title: 'Cloud may partly block views', short: 'Partly blocked' },
    clear: { title: 'Summit likely clear of cloud', short: 'Clear of cloud' },
    uncertain: { title: 'Summit cloud is uncertain', short: 'Uncertain' },
    unavailable: { title: 'Cloud prediction unavailable', short: 'Unavailable' },
});

export interface CloudLevelInput { pressure?: number | null; height?: number | null; humidity?: number | null; cloud?: number | null; temperature?: number | null; wind?: number | null; direction?: number | null }
export interface CloudSample { time?: number; levels: CloudLevelInput[] }
interface CloudLevel extends CloudLevelInput { height: number; humidity: number; cloud: number; temperature: number; saturation: number }
export interface CloudReading { cloud: number; humidity: number; saturation: number; temperature: number; gap: number; lower: number; upper: number; wind: number | null; direction: number | null }
interface Place { latitude: number; longitude: number }
export interface CloudSubject extends Place { elevation: number }
interface CloudPoint { bearing: number | null; grid: Place & { elevation: number }; samples: CloudSample[] }
interface CloudModelInfo { label: string; gridKm: number; requireFreshness: boolean; humidityBasis?: HumidityBasis; [key: string]: unknown }
export interface CloudDataset { model: CloudModelInfo; metadata?: { lastUpdate: number; updateIntervalSeconds: number } | null; points: CloudPoint[]; [key: string]: unknown }
type CloudStateKey = keyof typeof CLOUD_STATES;

const finite = Number.isFinite;
const rad = (value: number) => value * Math.PI / 180;
const angle = (left: number, right: number) => Math.abs(((left - right + 540) % 360) - 180);
export const cloudDistanceKm = (a: Place, b: Place) => {
    const dlat = rad(b.latitude - a.latitude), dlon = rad(b.longitude - a.longitude);
    const h = Math.sin(dlat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dlon / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
};

export function cloudSamplePoints(subject: Place, gridKm: number) {
    const distance = Math.max(10, gridKm * 1.5), arc = distance / 6371;
    const lat = rad(subject.latitude), lon = rad(subject.longitude);
    return [{ latitude: subject.latitude, longitude: subject.longitude, bearing: null as number | null }, ...[0, 90, 180, 270].map(bearing => {
        const b = rad(bearing), y = Math.asin(Math.sin(lat) * Math.cos(arc) + Math.cos(lat) * Math.sin(arc) * Math.cos(b));
        const x = lon + Math.atan2(Math.sin(b) * Math.sin(arc) * Math.cos(lat), Math.cos(arc) - Math.sin(lat) * Math.sin(y));
        return { latitude: y / Math.PI * 180, longitude: ((x / Math.PI * 180 + 540) % 360) - 180, bearing };
    })];
}

// Mixed-phase saturation over liquid water: ice below -23 C, water at 0 C, using
// the IFS blend and its Tetens constants. Below 1 means ice-bearing air is
// saturated at that fraction of the humidity a water-referenced model reports.
function mixedPhaseSaturationRatio(temperature: number): number {
    if (temperature >= 0) return 1;
    const ice = Math.exp(22.587 * temperature / (temperature + 273.86) - 17.502 * temperature / (temperature + 240.97));
    const water = temperature <= -23 ? 0 : ((temperature + 23) / 23) ** 2;
    return water + (1 - water) * ice;
}
// Open-Meteo's own pressure-level cloud derivation (Sundqvist 1989). Reapplying it
// to saturation keeps adjusted cloud on the scale the provider reports.
function derivedCloud(saturation: number, pressure: number): number {
    const critical = 0.7 + 0.2 * Math.exp(1 - (1013.25 / pressure) ** 4);
    return Math.max(1 - Math.sqrt(Math.max(1 - saturation / 100, 0) / (1 - critical)), 0) * 100;
}
// Returns new objects: profiles are cached and repainted, so adjusting in place
// would compound on every paint.
function completeLevels(sample: CloudSample | undefined, ground: number, basis: HumidityBasis): CloudLevel[] {
    if (!Array.isArray(sample?.levels)) return [];
    return sample.levels.flatMap(level => {
        const { height, humidity, cloud, temperature, pressure } = level;
        if (!finite(height) || (height as number) < ground || !finite(humidity) || !finite(cloud) || !finite(temperature)) return [];
        const valid = level as CloudLevel;
        if (basis !== 'water' || valid.temperature >= 0) return [{ ...valid, saturation: valid.humidity }];
        const saturation = Math.min(100, valid.humidity / mixedPhaseSaturationRatio(valid.temperature));
        return [{ ...valid, saturation, cloud: finite(pressure) ? Math.max(valid.cloud, derivedCloud(saturation, pressure as number)) : valid.cloud }];
    }).sort((a, b) => a.height - b.height);
}

// Require two valid atmospheric levels around the real elevation. Never use
// below-grid-ground values, a lone nearest level, or extrapolation as clear sky.
export function cloudAtElevation(sample: CloudSample | undefined, elevation: unknown, ground: unknown = 0, basis: HumidityBasis = 'saturation'): CloudReading | null {
    if (!finite(elevation) || !finite(ground) || !Array.isArray(sample?.levels)) return null;
    const ordered = completeLevels(sample, ground as number, basis), height = elevation as number;
    const below = ordered.findLast(level => level.height <= height);
    const above = ordered.find(level => level.height >= height && level !== below);
    if (!below || !above || above.height - below.height <= 0 || above.height - below.height > 2200) return null;
    const ratio = (height - below.height) / (above.height - below.height);
    const mix = (key: 'cloud' | 'humidity' | 'saturation' | 'temperature') => below[key] + ratio * (above[key] - below[key]);
    const u = (level: CloudLevel) => finite(level.wind) && finite(level.direction) ? -(level.wind as number) * Math.sin(rad(level.direction as number)) : null;
    const v = (level: CloudLevel) => finite(level.wind) && finite(level.direction) ? -(level.wind as number) * Math.cos(rad(level.direction as number)) : null;
    const blend = (fn: typeof u) => { const low = fn(below), high = fn(above); return low !== null && high !== null ? low + ratio * (high - low) : null; };
    const windU = blend(u), windV = blend(v);
    const airflow = windU !== null && windV !== null;
    return { cloud: mix('cloud'), humidity: mix('humidity'), saturation: mix('saturation'), temperature: mix('temperature'),
        gap: above.height - below.height, lower: below.height, upper: above.height,
        wind: airflow ? Math.hypot(windU, windV) : null,
        direction: airflow ? (Math.atan2(-windU, -windV) / Math.PI * 180 + 360) % 360 : null };
}

type Moisture = { cloud: number; saturation: number };
const cloudy = (value: Moisture) => value.cloud >= 60 && value.saturation >= 85;
const dry = (value: Moisture) => value.cloud <= 20 && value.saturation < 80;
const result = <Extra extends object>(key: CloudStateKey, extra: Extra) => ({ key, ...CLOUD_STATES[key], ...extra });

export function predictModelCloud(data: CloudDataset, subject: CloudSubject, time: number, now = Date.now()) {
    const basis = data.model.humidityBasis || 'saturation';
    const central = data.points[0]!, sample = central.samples.find(row => row.time === time);
    const summit = cloudAtElevation(sample, subject.elevation, central.grid.elevation, basis);
    if (!summit) return result('unavailable', { reason: 'The model has no complete atmospheric layers bracketing this summit.', model: data.model, summit: null, neighbors: 0, cloudyNeighbors: 0, lift: false, metadata: data.metadata, limited: true });
    const metadata = data.metadata;
    const stale = Boolean(metadata) && now - metadata!.lastUpdate > Math.max(18 * 3600_000, metadata!.updateIntervalSeconds * 3000);
    const neighboring = data.points.slice(1).map(point => ({ point,
        value: cloudAtElevation(point.samples.find(row => row.time === time), subject.elevation, point.grid.elevation, basis) }));
    const distinct = new Set([`${central.grid.latitude}/${central.grid.longitude}`]);
    const neighbors = neighboring.flatMap(({ point, value }) => {
        const key = `${point.grid.latitude}/${point.grid.longitude}`;
        if (!value || distinct.has(key)) return [];
        distinct.add(key); return [{ point, value }];
    });
    const cloudyNeighbors = neighbors.filter(({ value }) => cloudy(value)).length;
    // A conservative tendency, not a simulated parcel or an invented cap-cloud
    // probability. Wind comes FROM this bearing. Missing airflow cannot imply dry.
    const { wind, direction } = summit;
    const upwind = wind !== null && direction !== null && wind >= 3
        ? neighboring.find(({ point }) => angle(point.bearing as number, direction) <= 45) : null;
    // Upwind ground near summit height leaves no lower air to lift, which is not
    // missing data. Otherwise take the moistest complete air in the lower band;
    // native levels can be underground or miss a single interpolated height.
    const upwindGround = upwind?.point.grid.elevation;
    const liftPossible = upwindGround !== undefined && upwindGround < subject.elevation - 200;
    const incoming: number[] = [];
    if (upwind && liftPossible) {
        const upwindSample = upwind.point.samples.find(row => row.time === time);
        const floor = Math.max(upwindGround, subject.elevation - 500);
        const atFloor = cloudAtElevation(upwindSample, floor, upwindGround, basis);
        if (atFloor) incoming.push(atFloor.saturation);
        for (const level of completeLevels(upwindSample, upwindGround, basis)) {
            if (level.height >= floor && level.height <= subject.elevation - 100) incoming.push(level.saturation);
        }
    }
    const lift = incoming.some(saturation => saturation >= 85);
    const evidence = { model: data.model, summit, neighbors: neighbors.length, cloudyNeighbors, lift, metadata,
        limited: data.model.gridKm > 10 || summit.gap > 1200 || time - now > 48 * 3600_000 || !metadata };
    if (stale || data.model.requireFreshness && !metadata) return result('uncertain', { ...evidence,
        reason: stale ? 'The provider update is old; a current summit-cloud estimate cannot be confirmed.' : 'This feed needs a verified recent update before its cloud estimate can be used.' });
    if (cloudy(summit)) return result('inside', { ...evidence, reason: 'The layers around summit height are moist and cloud-filled.' });
    if (neighbors.length < 3) return result('uncertain', { ...evidence, reason: 'Summit data is available, but too few distinct neighboring profiles resolve nearby cloud.' });
    if (cloudyNeighbors >= 3) return result('blocked', { ...evidence, reason: 'Most sampled directions have cloud near summit height, which may obscure nearby peaks.' });
    if (cloudyNeighbors || lift || !dry(summit) || neighbors.some(({ value }) => !dry(value))) return result('partial', { ...evidence, reason: lift
        ? 'Moist air approaching higher terrain could form cloud on the ridge.' : 'Some cloud is indicated near summit height or in the surrounding profiles.' });
    if (wind === null || direction === null || wind >= 3 && (!upwind || liftPossible && !incoming.length)) return result('uncertain', { ...evidence,
        reason: 'The cloud layers look dry, but incoming airflow cannot be checked for terrain cloud.' });
    // Reject a clear result when an endpoint is cloudy even if interpolation
    // dilutes a thin layer. Vertical sampling cannot resolve that boundary.
    const near = completeLevels(sample, central.grid.elevation, basis).filter(level => Math.abs(level.height - subject.elevation) <= 500);
    if (near.some(cloudy)) return result('uncertain', { ...evidence, reason: 'A cloud layer is close to summit height; a small height shift could cover the summit.' });
    return result('clear', { ...evidence, reason: 'The summit and sampled surroundings are relatively dry at summit height. Lower valleys may still contain cloud.' });
}

const SEVERITY = { clear: 0, partial: 1, blocked: 2, inside: 3 };
type RankedKey = keyof typeof SEVERITY;
const ranked = (key: CloudStateKey): key is RankedKey => key in SEVERITY;

export function predictSummitCloud(datasets: CloudDataset[], subject: CloudSubject, time: number, now = Date.now(), expectedModels = datasets.length) {
    const estimates = datasets.map(data => predictModelCloud(data, subject, time, now));
    const available = estimates.filter(item => item.key !== 'unavailable');
    if (!available.length) return result('unavailable', { reason: 'No complete cloud profile is available for this hour.', estimates, confidence: 'Unavailable' });
    const [first] = available as [typeof available[number]];
    // A missing comparison is not disagreement, and one model is enough for a
    // manual choice. The basis is named and the estimate stays low confidence.
    if (available.length === 1 && expectedModels > 1) return { ...first, estimates, confidence: 'Low confidence',
        reason: `Only ${first.model.label} could be evaluated for this hour. ${first.reason}` };
    const keys = available.map(item => item.key);
    if (keys.every(key => key === first.key)) return { ...first, estimates,
        confidence: first.key === 'uncertain' || available.some(item => item.limited) ? 'Low confidence' : 'Experimental estimate' };
    const order = keys.every(ranked) ? [...available].sort((a, b) => SEVERITY[a.key as RankedKey] - SEVERITY[b.key as RankedKey]) : [];
    const least = order[0], most = order.at(-1);
    // A clear model against one placing cloud at or all around the summit is a
    // real conflict. Otherwise report only the obstruction both can support,
    // never clear, and name what each model said.
    if (!least || !most || least.key === 'clear' && SEVERITY[most.key as RankedKey] > SEVERITY.partial) return result('uncertain', {
        reason: 'The models disagree about cloud at or around summit height.', estimates, confidence: 'Low confidence' });
    return result(least.key === 'clear' ? 'partial' : least.key, { estimates, confidence: 'Low confidence',
        reason: `Models differ: ${most.model.label} says “${most.title}”; ${least.model.label} says “${least.title}”.` });
}
