// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PEAK_WEATHER_MODELS } from './peak-weather-models.js';

// Pressure profiles are a separate capability from the surface-weather menu.
// Live field checks and sources: docs/weather.md#cloud-models-and-horizons.
// Do not substitute IFS 9 km or the 13 km GFS surface grid for these products.
const dense = [1000, 925, 850, 800, 750, 700, 650, 600, 500, 400, 300, 250];
const sparse = [1000, 925, 850, 700, 600, 500, 400, 300, 250];
const specifications = [
    ['gfs_hrrr', 3, 'ncep_hrrr_conus'],
    ['gem_hrdps_continental', 2.5, 'cmc_gem_hrdps'],
    ['gem_regional', 10, 'cmc_gem_rdps_10km'],
    ['gfs_global', 25, 'ncep_gfs025'],
    ['ecmwf_ifs025', 25, 'ecmwf_ifs025', sparse],
    ['icon_global', 11, 'dwd_icon'],
    ['gem_global', 15, 'cmc_gem_gdps_15km'],
    ['ukmo_global_deterministic_10km', 10, 'ukmo_global_deterministic_10km'],
    ['meteofrance_arpege_world', 25, 'meteofrance_arpege_world025'],
    ['ecmwf_aifs025_single', 25, 'ecmwf_aifs025_single', sparse],
    ['jma_gsm', 55, 'jma_gsm', sparse],
    ['cma_grapes_global', 15, 'cma_grapes_global'],
];
export const SUMMIT_CLOUD_MODELS = Object.freeze(specifications.map(([id, gridKm, metadata, levels = dense]) => {
    const weather = PEAK_WEATHER_MODELS.find(model => model.id === id);
    return Object.freeze({ id, label: weather.label, gridKm, metadata, domain: weather.domain,
        days: weather.forecastDays, levels: Object.freeze([...levels]),
        nativeCloud: ['gfs_global', 'cma_grapes_global'].includes(id),
        sparse: levels === sparse, requireFreshness: id === 'cma_grapes_global' });
}));
export const summitCloudModel = id => SUMMIT_CLOUD_MODELS.find(model => model.id === id);
export const eligibleSummitCloudModels = subject => Number.isFinite(subject?.latitude) && Math.abs(subject.latitude) <= 90
    && Number.isFinite(subject.longitude) && Math.abs(subject.longitude) <= 180
    ? SUMMIT_CLOUD_MODELS.filter(model => model.domain(subject)) : [];

// Automatic is our explicit comparison, never the API's opaque best_match.
// Only two named models are requested. Manual choices never fall back.
export function resolveSummitCloudModels(subject, selected, leadDays = 0) {
    const eligible = eligibleSummitCloudModels(subject);
    if (selected !== 'auto') {
        const model = eligible.find(candidate => candidate.id === selected);
        if (!model) throw new Error('This model does not cover this summit. Choose another model or Automatic.');
        return [model];
    }
    const ids = leadDays < 2 ? ['gfs_hrrr', 'gem_hrdps_continental', 'gfs_global', 'ecmwf_ifs025']
        : ['gfs_global', 'ecmwf_ifs025'];
    return ids.map(id => eligible.find(model => model.id === id)).filter(Boolean).slice(0, 2);
}
