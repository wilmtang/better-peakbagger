// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Archive dates: https://open-meteo.com/en/docs/historical-forecast-api
// Reanalysis fields/delay: https://open-meteo.com/en/docs/historical-weather-api
// Regional candidates outside the two projected grids use conservative interior
// footprints. Eligibility is a candidate, not a promise of an archive slice.
import { mountainTime } from '../time/mountain-time.js';

const rad = degrees => degrees * Math.PI / 180;
function lambert(lat, lon) {
    const n = Math.sin(rad(38.5));
    const f = Math.cos(rad(38.5)) * Math.tan(Math.PI / 4 + rad(38.5) / 2) ** n / n;
    const p = f / Math.tan(Math.PI / 4 + rad(lat) / 2) ** n;
    return [p * Math.sin(n * rad(lon + 97.5)), f - p * Math.cos(n * rad(lon + 97.5))];
}
function rotated(lat, lon) {
    const theta = rad(90 - 36.0885), phi = rad(245.305);
    const x = Math.cos(rad(lon)) * Math.cos(rad(lat)), y = Math.sin(rad(lon)) * Math.cos(rad(lat)), z = Math.sin(rad(lat));
    return [
        -Math.atan2(-Math.sin(phi) * x + Math.cos(phi) * y,
            Math.cos(theta) * Math.cos(phi) * x + Math.cos(theta) * Math.sin(phi) * y + Math.sin(theta) * z),
        -Math.asin(-Math.sin(theta) * Math.cos(phi) * x - Math.sin(theta) * Math.sin(phi) * y + Math.cos(theta) * z),
    ];
}
// Derived from Open-Meteo GfsDomain.swift, GemDomain.swift and ProjectionGrid,
// LambertConformalConic and RotatedLatLon in Sources/App/Domains. These are
// mathematical grid admission tests; provider refusal remains authoritative.
const projectedGrid = (project, sw, ne) => {
    const origin = project(...sw), corner = project(...ne);
    return ({ latitude, longitude }) => {
        const point = project(latitude, longitude);
        return point.every((value, index) => Number.isFinite(value)
            && (value - origin[index]) / (corner[index] - origin[index]) >= 0
            && (value - origin[index]) / (corner[index] - origin[index]) <= 1);
    };
};
const conus = projectedGrid(lambert, [21.138, -122.72], [47.8424, -60.918]);
const hrdps = projectedGrid(rotated, [39.626034, -133.62952], [47.876457, -40.708557]);
const box = (south, north, west, east) => ({ latitude, longitude }) => latitude >= south && latitude <= north && longitude >= west && longitude <= east;
const global = () => true;
const europe = box(36, 70, -12, 35);
const fields = ['weather_code', 'temperature_2m', 'precipitation', 'wind_speed_10m', 'wind_gusts_10m'];
const archive = 'https://archive-api.open-meteo.com/v1/archive';
const forecast = 'https://historical-forecast-api.open-meteo.com/v1/forecast';
const model = (id, label, resolution, since, domain = global, options = {}) => Object.freeze({
    id, label, resolution, since, until: null, domain, endpoint: forecast,
    intervalHours: 1, delayDays: 0, fields, type: 'Archived forecast model', ...options,
});
export const WEATHER_MODELS = Object.freeze([
    model('gfs_hrrr', 'HRRR', '3 km', '2018-01-01', conus),
    model('gem_hrdps_continental', 'HRDPS Continental', '2.5 km', '2023-03-03', hrdps),
    model('ecmwf_ifs', 'ECMWF IFS', '9 km', '2017-01-01', global, { endpoint: archive }),
    model('era5_seamless', 'ERA5 + ERA5-Land', '11–25 km', '1950-01-01', global, { endpoint: archive, type: 'Combined reanalysis', delayDays: 5 }),
    model('era5', 'ERA5', '25 km', '1940-01-01', global, { endpoint: archive, type: 'Reanalysis', delayDays: 5 }),
    model('cerra', 'CERRA', '5 km', '1985-01-01', europe, { endpoint: archive, until: '2021-06-30', type: 'Regional reanalysis' }),
    model('era5_land', 'ERA5-Land (surface only)', '11 km', '1950-01-01', global, { endpoint: archive, type: 'Reanalysis', delayDays: 5, fields: ['temperature_2m'] }),
    model('era5_ensemble', 'ERA5 Ensemble', '55 km', '1940-01-01', global, { endpoint: archive, type: 'Ensemble reanalysis', delayDays: 5, intervalHours: 3, fields: fields.filter(field => field !== 'wind_gusts_10m') }),
    model('ecmwf_ifs_analysis_long_window', 'IFS Assimilation (no precipitation)', '9 km', '2024-01-01', global, { endpoint: archive, type: 'Analysis', delayDays: 2, intervalHours: 6, fields: ['temperature_2m', 'wind_speed_10m'] }),
    model('gfs_global', 'GFS', '13 km', '2021-03-23'),
    model('ncep_nam_conus', 'NAM', '3 km', '2025-09-01', conus),
    model('ncep_nbm_conus', 'NBM', '3 km', '2024-10-08', conus),
    model('icon_global', 'ICON Global', '11 km', '2022-11-24'),
    model('icon_eu', 'ICON EU', '7 km', '2022-11-24', europe),
    model('icon_d2', 'ICON D2', '2 km', '2022-11-24', box(46, 54.5, 5, 17)),
    model('gem_global', 'GEM Global', '15 km', '2022-11-23', global, { intervalHours: 3 }),
    model('gem_regional', 'GEM Regional', '10 km', '2022-11-23', box(42, 65, -130, -60)),
    model('meteofrance_arpege_world', 'ARPEGE World', '25 km', '2024-01-02'),
    model('meteofrance_arpege_europe', 'ARPEGE Europe', '11 km', '2022-11-13', europe),
    model('meteofrance_arome_france', 'AROME France', '2.5 km', '2024-01-02', box(42, 51, -5, 9)),
    model('meteofrance_arome_france_hd', 'AROME France HD', '1.5 km', '2022-11-13', box(42, 51, -5, 9)),
    model('ecmwf_ifs04', 'IFS 0.4°', '44 km', '2022-11-07', global, { intervalHours: 3 }),
    model('ecmwf_ifs025', 'IFS 0.25°', '25 km', '2024-02-03', global, { intervalHours: 3 }),
    model('ecmwf_aifs025_single', 'AIFS Single', '25 km', '2025-02-20', global, { intervalHours: 6 }),
    model('ukmo_global_deterministic_10km', 'UKMO Global', '10 km', '2022-03-01'),
    model('ukmo_uk_deterministic_2km', 'UKMO UKV', '2 km', '2022-03-01', box(50, 59, -8, 2)),
    model('jma_gsm', 'JMA GSM', '55 km', '2016-01-01', global, { intervalHours: 6 }),
    model('jma_msm', 'JMA MSM', '5 km', '2016-01-01', box(24, 46, 123, 145)),
    model('metno_nordic', 'MET Nordic', '1 km', '2022-11-15', box(55, 70, 5, 30)),
    model('cma_grapes_global', 'CMA GRAPES', '15 km', '2023-12-31', global, { intervalHours: 3 }),
    model('bom_access_global', 'BOM ACCESS-G', '15 km', '2024-01-18'),
    model('italia_meteo_arpae_icon_2i', 'ICON 2I', '2 km', '2025-04-13', box(37, 47, 6, 19)),
    model('dmi_harmonie_arome_europe', 'DMI HARMONIE', '2 km', '2024-07-01', box(50, 65, -5, 20)),
    model('knmi_harmonie_arome_netherlands', 'KNMI Netherlands', '2 km', '2024-07-01', box(50.5, 54, 3, 7.5)),
    model('knmi_harmonie_arome_europe', 'KNMI Europe', '5.5 km', '2024-07-01', box(48, 65, -10, 25)),
    model('meteoswiss_icon_ch1', 'MeteoSwiss ICON CH1', '1 km', '2025-07-29', box(45, 49, 5, 12)),
    model('meteoswiss_icon_ch2', 'MeteoSwiss ICON CH2', '2 km', '2025-07-29', box(45, 49, 5, 12)),
]);

export function eligibleWeatherModels(summit, date, now = Date.now()) {
    if (!Number.isFinite(summit.latitude) || Math.abs(summit.latitude) > 90
        || !Number.isFinite(summit.longitude) || Math.abs(summit.longitude) > 180) return [];
    const zone = mountainTime.resolve(summit.latitude, summit.longitude);
    // A summit east of the date line can already be on tomorrow's UTC date.
    // The subject's future-date guard and this cutoff both use its civil day.
    const cutoff = delay => mountainTime.localDate(zone, now - delay * 86400_000);
    return WEATHER_MODELS.filter(item => date >= item.since && date <= cutoff(item.delayDays)
        && (!item.until || date <= item.until) && item.domain(summit));
}

export function recommendedWeatherModels(summit, date, now) {
    const eligible = eligibleWeatherModels(summit, date, now);
    const ids = [
        ...(summit.nation === 'united states' ? ['gfs_hrrr'] : []),
        ...(summit.nation === 'canada' ? ['gem_hrdps_continental'] : []),
        'ecmwf_ifs', 'era5_seamless', 'era5',
    ];
    return ids.map(id => eligible.find(item => item.id === id)).filter(Boolean);
}
