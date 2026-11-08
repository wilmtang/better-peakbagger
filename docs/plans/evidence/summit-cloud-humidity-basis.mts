// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Paced, read-only Open-Meteo probe behind the summit cloud `humidityBasis`
// classification and per-model pressure-level lists. Run by hand with
// `node docs/plans/evidence/summit-cloud-humidity-basis.mts`; it rewrites the
// JSON beside it. It is evidence of field structure, not of forecast skill.
import { writeFile } from 'node:fs/promises';

type Point = readonly [number, number];
interface Bucket { samples: number; maxHumidity: number; p99Humidity: number; p95Humidity: number; maxCloud: number }

const north: Point[] = [[47, -122], [49, -123], [52, -125], [55, -130], [58, -135], [61, -148], [44, -110], [40, -106], [37, -119], [45, -75], [48, -90], [42, -85], [35, -100], [46, -65], [50, -115], [53, -105], [41, -73], [39, -120], [33, -112], [60, -130]];
const world: Point[] = [...north.slice(0, 8), [46, 7], [50, 15], [60, 10], [64, -20], [28, 87], [35, 105], [36, 138], [-43, 171], [-33, -70], [-50, -73], [0, 37], [5, -75]];
const conus = north.filter(([latitude, longitude]) => latitude < 50 && longitude > -130);
const canada = north.filter(([latitude]) => latitude < 60 && latitude > 42);
const specifications: [string, Point[], Point][] = [
    ['gfs_global', world, [46, 7]], ['ecmwf_ifs025', world, [46, 7]], ['icon_global', world, [46, 7]],
    ['gem_global', world, [46, 7]], ['ukmo_global_deterministic_10km', world, [46, 7]],
    ['meteofrance_arpege_world', world, [46, 7]], ['ecmwf_aifs025_single', world, [46, 7]], ['jma_gsm', world, [46, 7]],
    ['cma_grapes_global', world, [46, 7]], ['gfs_hrrr', conus, [40.2549, -105.6151]],
    ['gem_hrdps_continental', canada, [51.4, -116.2]], ['gem_regional', north, [51.4, -116.2]],
];
const scaleLevels = [850, 700, 600, 500, 400, 300];
const capabilityLevels = [1000, 925, 850, 800, 750, 700, 675, 650, 625, 600, 500, 400, 300, 250];
const fields = ['temperature', 'relative_humidity', 'geopotential_height', 'cloud_cover', 'wind_speed', 'wind_direction'];
const buckets: [string, number][] = [['T>0', 0], ['0..-10', -10], ['-10..-20', -20], ['-20..-30', -30], ['-30..-40', -40], ['-40..-50', -50], ['T<-50', -Infinity]];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function get(id: string, parameters: Record<string, string>): Promise<Record<string, unknown>[]> {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    Object.entries({ models: id, timeformat: 'unixtime', ...parameters }).forEach(([key, value]) => url.searchParams.set(key, value));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${id}: HTTP ${response.status}`);
    return [await response.json()].flat() as Record<string, unknown>[];
}
const series = (location: Record<string, unknown>, key: string): (number | null)[] =>
    (location.hourly as Record<string, (number | null)[]>)[key] || [];

async function humidityScale(id: string, points: Point[]): Promise<Record<string, Bucket>> {
    const body = await get(id, { latitude: points.map(point => point[0]).join(','), longitude: points.map(point => point[1]).join(','), forecast_days: '2',
        hourly: scaleLevels.flatMap(level => [`temperature_${level}hPa`, `relative_humidity_${level}hPa`, `cloud_cover_${level}hPa`]).join(',') });
    const raw = new Map<string, { humidity: number[]; maxCloud: number }>();
    for (const location of body) for (const level of scaleLevels) {
        const temperature = series(location, `temperature_${level}hPa`), cloud = series(location, `cloud_cover_${level}hPa`);
        series(location, `relative_humidity_${level}hPa`).forEach((humidity, index) => {
            const celsius = temperature[index];
            if (typeof humidity !== 'number' || typeof celsius !== 'number') return;
            const name = (buckets.find(([, floor]) => celsius > floor) as [string, number])[0];
            const entry = raw.get(name) || { humidity: [], maxCloud: 0 };
            entry.humidity.push(humidity); entry.maxCloud = Math.max(entry.maxCloud, cloud[index] ?? 0); raw.set(name, entry);
        });
    }
    const result: Record<string, Bucket> = {};
    for (const [name] of buckets) {
        const entry = raw.get(name);
        if (!entry) continue;
        const sorted = entry.humidity.sort((left, right) => left - right), at = (share: number) => sorted[Math.floor(sorted.length * share)] as number;
        result[name] = { samples: sorted.length, maxHumidity: sorted.at(-1) as number, p99Humidity: at(0.99), p95Humidity: at(0.95), maxCloud: entry.maxCloud };
    }
    return result;
}
async function levelCapability(id: string, [latitude, longitude]: Point): Promise<{ complete: number[]; missing: number[] }> {
    const [location] = await get(id, { latitude: String(latitude), longitude: String(longitude), forecast_hours: '3', elevation: 'nan',
        hourly: capabilityLevels.flatMap(level => fields.map(field => `${field}_${level}hPa`)).join(',') });
    const complete = capabilityLevels.filter(level => fields.every(field => series(location as Record<string, unknown>, `${field}_${level}hPa`).some(Number.isFinite)));
    return { complete, missing: capabilityLevels.filter(level => !complete.includes(level)) };
}

const models: Record<string, unknown> = {};
for (const [id, points, capabilityPoint] of specifications) {
    const humidity = await humidityScale(id, points); await sleep(14000);
    models[id] = { humidityByTemperature: humidity, levels: await levelCapability(id, capabilityPoint) }; await sleep(14000);
    console.log(id, JSON.stringify(models[id]));
}
await writeFile(new URL('./summit-cloud-humidity-basis.json', import.meta.url), `${JSON.stringify({ capturedAt: new Date().toISOString(),
    iceSaturationRatio: { '-20': 0.824, '-30': 0.746, '-40': 0.677, '-50': 0.62 }, models }, null, 2)}\n`);
