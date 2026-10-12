// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ARCHIVE_BEST_MATCH, WEATHER_MODELS } from './weather-models.js';

// Named forecasts with published horizons. Recent history uses the same model
// IDs on the Forecast API; delayed reanalyses cannot cover yesterday.
// https://open-meteo.com/en/docs (and each provider's Data Sources table)
const horizons = {
    gfs_global: 16, gfs_hrrr: 2, ncep_nam_conus: 2.5, ncep_nbm_conus: 11,
    ecmwf_ifs: 15, ecmwf_ifs025: 15, ecmwf_aifs025_single: 15,
    icon_global: 7.5, icon_eu: 5, icon_d2: 2,
    gem_global: 10, gem_regional: 3.5, gem_hrdps_continental: 2,
    meteofrance_arpege_world: 4, meteofrance_arpege_europe: 4,
    meteofrance_arome_france: 2, meteofrance_arome_france_hd: 2,
    ukmo_global_deterministic_10km: 7, ukmo_uk_deterministic_2km: 2,
    jma_gsm: 11, jma_msm: 4, metno_nordic: 2.5,
    cma_grapes_global: 10, bom_access_global: 10,
    italia_meteo_arpae_icon_2i: 3, dmi_harmonie_arome_europe: 2.5,
    knmi_harmonie_arome_netherlands: 2.5, knmi_harmonie_arome_europe: 2.5,
    meteoswiss_icon_ch1: 1.375, meteoswiss_icon_ch2: 5,
};
const forecastModel = (item, forecastDays, options = {}) => Object.freeze({
    ...item, endpoint: 'https://api.open-meteo.com/v1/forecast',
    fields: Object.freeze([...item.fields, 'apparent_temperature', 'wind_direction_10m', 'is_day']),
    gustTiming: 'preceding-hour', type: 'Forecast model', forecastDays, ...options,
});
// The automatic forecast blend has rolling history, not the archive blend's
// fixed first date, resolution or instantaneous-gust contract.
export const PEAK_BEST_MATCH = forecastModel(ARCHIVE_BEST_MATCH, 16, {
    since: null, resolution: 'Automatic', type: 'Automatic forecast blend',
});
export const PEAK_WEATHER_MODELS = Object.freeze([PEAK_BEST_MATCH,
    ...WEATHER_MODELS.filter(item => horizons[item.id]).map(item => forecastModel(item, horizons[item.id])),
]);
export const peakModelHorizon = model => model.forecastDays < 2 && !Number.isInteger(model.forecastDays)
    ? `${model.forecastDays * 24} hours` : `${model.forecastDays} days`;

export function eligiblePeakWeatherModels(summit, window, period) {
    if (!['past', 'forecast'].includes(period) || !Number.isFinite(summit.latitude) || Math.abs(summit.latitude) > 90
        || !Number.isFinite(summit.longitude) || Math.abs(summit.longitude) > 180) return [];
    const first = window[period].days[0].date;
    return PEAK_WEATHER_MODELS.filter(item => (!item.since || first >= item.since) && item.domain(summit));
}

export function resolvePeakWeatherModels(summit, window, choices) {
    return Object.fromEntries(['past', 'forecast'].map(period => {
        const model = eligiblePeakWeatherModels(summit, window, period).find(item => item.id === choices[period]);
        if (!model) throw new Error('This weather model does not cover the summit and date range. Choose another model.');
        return [period, model];
    }));
}
