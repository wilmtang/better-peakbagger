// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export const CLOUD_STATES = Object.freeze({
    inside: { title: 'Summit likely inside cloud', short: 'In cloud' },
    blocked: { title: 'Nearby views likely blocked', short: 'Blocked' },
    partial: { title: 'Cloud may partly block views', short: 'Partly blocked' },
    clear: { title: 'Summit likely clear of cloud', short: 'Clear of cloud' },
    uncertain: { title: 'Summit cloud is uncertain', short: 'Uncertain' },
    unavailable: { title: 'Cloud prediction unavailable', short: 'Unavailable' },
});

const finite = Number.isFinite;
const rad = value => value * Math.PI / 180;
const angle = (left, right) => Math.abs(((left - right + 540) % 360) - 180);
export const cloudDistanceKm = (a, b) => {
    const dlat = rad(b.latitude - a.latitude), dlon = rad(b.longitude - a.longitude);
    const h = Math.sin(dlat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dlon / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
};

export function cloudSamplePoints(subject, gridKm) {
    const distance = Math.max(10, gridKm * 1.5), arc = distance / 6371;
    const lat = rad(subject.latitude), lon = rad(subject.longitude);
    return [{ latitude: subject.latitude, longitude: subject.longitude, bearing: null }, ...[0, 90, 180, 270].map(bearing => {
        const b = rad(bearing), y = Math.asin(Math.sin(lat) * Math.cos(arc) + Math.cos(lat) * Math.sin(arc) * Math.cos(b));
        const x = lon + Math.atan2(Math.sin(b) * Math.sin(arc) * Math.cos(lat), Math.cos(arc) - Math.sin(lat) * Math.sin(y));
        return { latitude: y / Math.PI * 180, longitude: ((x / Math.PI * 180 + 540) % 360) - 180, bearing };
    })];
}

// Require two valid atmospheric levels around the real elevation. Never use
// below-grid-ground values, a lone nearest level, or extrapolation as clear sky.
export function cloudAtElevation(sample, elevation, ground = 0) {
    if (!finite(elevation) || !finite(ground) || !Array.isArray(sample?.levels)) return null;
    const levels = sample.levels.filter(level => finite(level.height) && level.height >= ground
        && finite(level.humidity) && finite(level.cloud) && finite(level.temperature));
    const ordered = [...levels].sort((a, b) => a.height - b.height);
    const below = ordered.findLast(level => level.height <= elevation);
    const above = ordered.find(level => level.height >= elevation && level !== below);
    if (!below || !above || above.height - below.height <= 0 || above.height - below.height > 2200) return null;
    const ratio = (elevation - below.height) / (above.height - below.height);
    const mix = key => finite(below[key]) && finite(above[key]) ? below[key] + ratio * (above[key] - below[key]) : null;
    const u = level => finite(level.wind) && finite(level.direction) ? -level.wind * Math.sin(rad(level.direction)) : null;
    const v = level => finite(level.wind) && finite(level.direction) ? -level.wind * Math.cos(rad(level.direction)) : null;
    const blend = fn => finite(fn(below)) && finite(fn(above)) ? fn(below) + ratio * (fn(above) - fn(below)) : null;
    const windU = blend(u), windV = blend(v);
    return { cloud: mix('cloud'), humidity: mix('humidity'), temperature: mix('temperature'),
        gap: above.height - below.height, lower: below.height, upper: above.height,
        wind: finite(windU) && finite(windV) ? Math.hypot(windU, windV) : null,
        direction: finite(windU) && finite(windV) ? (Math.atan2(-windU, -windV) / Math.PI * 180 + 360) % 360 : null };
}

const cloudy = value => value && value.cloud >= 60 && value.humidity >= 85;
const dry = value => value && value.cloud <= 20 && value.humidity < 80;
const result = (key, extra = {}) => ({ key, ...CLOUD_STATES[key], ...extra });

export function predictModelCloud(data, subject, time, now = Date.now()) {
    const central = data.points[0], sample = central.samples.find(row => row.time === time);
    const summit = cloudAtElevation(sample, subject.elevation, central.grid.elevation);
    if (!summit) return result('unavailable', { reason: 'The model has no complete atmospheric layers bracketing this summit.', model: data.model, summit: null, neighbors: 0 });
    const metadata = data.metadata;
    const stale = metadata && now - metadata.lastUpdate > Math.max(18 * 3600_000, metadata.updateIntervalSeconds * 3000);
    const neighboring = data.points.slice(1).map(point => ({ point,
        value: cloudAtElevation(point.samples.find(row => row.time === time), subject.elevation, point.grid.elevation) }));
    const distinct = new Set([`${central.grid.latitude}/${central.grid.longitude}`]);
    const neighbors = neighboring.filter(({ point, value }) => {
        const key = `${point.grid.latitude}/${point.grid.longitude}`;
        if (!value || distinct.has(key)) return false;
        distinct.add(key); return true;
    });
    const cloudyNeighbors = neighbors.filter(({ value }) => cloudy(value)).length;
    // A conservative tendency, not a simulated parcel or an invented cap-cloud
    // probability. Wind comes FROM this bearing. Missing airflow cannot imply dry.
    const upwind = finite(summit.direction) && summit.wind >= 3
        ? neighboring.find(({ point }) => angle(point.bearing, summit.direction) <= 45) : null;
    const lowerHeight = Math.max(central.grid.elevation + 30, subject.elevation - 500);
    const incoming = upwind && lowerHeight < subject.elevation - 100
        ? cloudAtElevation(upwind.point.samples.find(row => row.time === time), lowerHeight, upwind.point.grid.elevation) : null;
    const lift = incoming && incoming.humidity >= 85 && upwind.point.grid.elevation < subject.elevation - 200;
    const evidence = { model: data.model, summit, neighbors: neighbors.length, cloudyNeighbors, lift: Boolean(lift), metadata,
        limited: data.model.gridKm > 10 || summit.gap > 1200 || time - now > 48 * 3600_000 || !metadata };
    if (stale || data.model.requireFreshness && !metadata) return result('uncertain', { ...evidence,
        reason: stale ? 'The provider update is old; a current summit-cloud estimate cannot be confirmed.' : 'This feed needs a verified recent update before its cloud estimate can be used.' });
    if (cloudy(summit)) return result('inside', { ...evidence, reason: 'The layers around summit height are moist and cloud-filled.' });
    if (neighbors.length < 3) return result('uncertain', { ...evidence, reason: 'Summit data is available, but too few distinct neighboring profiles resolve nearby cloud.' });
    if (cloudyNeighbors >= 3) return result('blocked', { ...evidence, reason: 'Most sampled directions have cloud near summit height, which may obscure nearby peaks.' });
    if (cloudyNeighbors || lift || !dry(summit) || neighbors.some(({ value }) => !dry(value))) return result('partial', { ...evidence, reason: lift
        ? 'Moist air approaching higher terrain could form cloud on the ridge.' : 'Some cloud is indicated near summit height or in the surrounding profiles.' });
    if (!finite(summit.wind) || !finite(summit.direction) || summit.wind >= 3 && !incoming) return result('uncertain', { ...evidence,
        reason: 'The cloud layers look dry, but incoming airflow cannot be checked for terrain cloud.' });
    // Reject a clear result when an endpoint is cloudy even if interpolation
    // dilutes a thin layer. Vertical sampling cannot resolve that boundary.
    const near = sample.levels.filter(level => Math.abs(level.height - subject.elevation) <= 500 && level.height >= central.grid.elevation);
    if (near.some(cloudy)) return result('uncertain', { ...evidence, reason: 'A cloud layer is close to summit height; a small height shift could cover the summit.' });
    return result('clear', { ...evidence, reason: 'The summit and sampled surroundings are relatively dry at summit height. Lower valleys may still contain cloud.' });
}

export function predictSummitCloud(datasets, subject, time, now = Date.now(), expectedModels = datasets.length) {
    const estimates = datasets.map(data => predictModelCloud(data, subject, time, now));
    const available = estimates.filter(item => item.key !== 'unavailable');
    if (!available.length) return result('unavailable', { reason: 'No complete cloud profile is available for this hour.', estimates, confidence: 'Unavailable' });
    if (available.length < expectedModels || new Set(available.map(item => item.key)).size > 1) return result('uncertain', {
        reason: available.length < expectedModels ? 'One of the selected forecasts is unavailable for this hour.' : 'The models disagree about cloud at or around summit height.',
        estimates, confidence: 'Low confidence' });
    const estimate = available[0];
    return { ...estimate, estimates, confidence: estimate.key === 'uncertain' || available.some(item => item.limited) ? 'Low confidence' : 'Experimental estimate' };
}
