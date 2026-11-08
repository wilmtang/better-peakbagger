// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PEAK_WEATHER_MODELS } from './peak-weather-models.js';

export interface SummitCloudSubject { latitude: number; longitude: number; elevation?: number | null }
export interface SummitCloudModel {
    readonly id: string;
    readonly label: string;
    readonly gridKm: number;
    readonly metadata: string;
    readonly domain: (subject: SummitCloudSubject) => boolean;
    readonly days: number;
    readonly levels: readonly number[];
    readonly requireFreshness: boolean;
}

// Pressure profiles are a separate capability from the surface-weather menu.
// Live field checks and sources: docs/weather.md#cloud-models-and-horizons and
// docs/plans/evidence/summit-cloud-humidity-basis.json. List only levels a model
// serves: each one costs six variables at five points.
// Do not substitute IFS 9 km or the 13 km GFS surface grid for these products.
const dense = [1000, 925, 850, 800, 750, 700, 650, 600, 500, 400, 300, 250];
const sparse = [1000, 925, 850, 700, 600, 500, 400, 300, 250];
// HRRR's terrain puts 650 hPa underground on Colorado's high peaks, and 600 hPa
// is often above those summits. Its 25 hPa levels keep them bracketed.
const hrrr = [1000, 925, 850, 800, 750, 700, 675, 650, 625, 600, 500, 400, 300, 250];
const icon = dense.filter(level => level !== 750 && level !== 650);
const jma = sparse.filter(level => level !== 250);
const specifications: [id: string, gridKm: number, metadata: string, levels?: number[]][] = [
    ['gfs_hrrr', 3, 'ncep_hrrr_conus', hrrr],
    ['gem_hrdps_continental', 2.5, 'cmc_gem_hrdps'],
    ['gem_regional', 10, 'cmc_gem_rdps_10km'],
    ['gfs_global', 25, 'ncep_gfs025'],
    ['ecmwf_ifs025', 25, 'ecmwf_ifs025', sparse],
    ['icon_global', 11, 'dwd_icon', icon],
    ['gem_global', 15, 'cmc_gem_gdps_15km'],
    ['ukmo_global_deterministic_10km', 10, 'ukmo_global_deterministic_10km'],
    ['meteofrance_arpege_world', 25, 'meteofrance_arpege_world025'],
    ['ecmwf_aifs025_single', 25, 'ecmwf_aifs025_single', sparse],
    ['jma_gsm', 55, 'jma_gsm', jma],
    ['cma_grapes_global', 15, 'cma_grapes_global'],
];
export const SUMMIT_CLOUD_MODELS: readonly SummitCloudModel[] = Object.freeze(specifications.map(([id, gridKm, metadata, levels = dense]) => {
    const weather = PEAK_WEATHER_MODELS.find((model: { id: string }) => model.id === id)!;
    return Object.freeze({ id, label: weather.label, gridKm, metadata, domain: weather.domain,
        days: weather.forecastDays, levels: Object.freeze([...levels]), requireFreshness: id === 'cma_grapes_global' });
}));
export const summitCloudModel = (id: string) => SUMMIT_CLOUD_MODELS.find(model => model.id === id);
export const eligibleSummitCloudModels = (subject?: SummitCloudSubject | null): SummitCloudModel[] => subject && Number.isFinite(subject.latitude) && Math.abs(subject.latitude) <= 90
    && Number.isFinite(subject.longitude) && Math.abs(subject.longitude) <= 180
    ? SUMMIT_CLOUD_MODELS.filter(model => model.domain(subject)) : [];

// Automatic is our explicit comparison, never the API's opaque best_match.
// Only two named models are requested. Manual choices never fall back.
export function resolveSummitCloudModels(subject: SummitCloudSubject, selected: string, leadDays = 0): SummitCloudModel[] {
    const eligible = eligibleSummitCloudModels(subject);
    if (selected !== 'auto') {
        const model = eligible.find(candidate => candidate.id === selected);
        if (!model) throw new Error('This model does not cover this summit. Choose another model or Automatic.');
        return [model];
    }
    const ids = leadDays < 2 ? ['gfs_hrrr', 'gem_hrdps_continental', 'gfs_global', 'ecmwf_ifs025']
        : ['gfs_global', 'ecmwf_ifs025'];
    return ids.map(id => eligible.find(model => model.id === id)).filter((model): model is SummitCloudModel => Boolean(model)).slice(0, 2);
}
