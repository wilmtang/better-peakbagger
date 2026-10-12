// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PEAK_WEATHER_MODELS } from './peak-weather-models.js';
import { requestDeadline } from '../net/request-deadline.js';
import { readBoundedResponseText } from '../net/bounded-text.js';
import { rateLimitError } from '../net/rate-limit.js';

// Provider metadata domains differ from Forecast API selection IDs.
// https://open-meteo.com/en/docs/model-updates and its published page source.
// GFS mixes its 13 km and 25 km products; expose both clocks instead of
// pretending one metadata record identifies the entire seamless forecast.
const domains = {
    gfs_global: ['ncep_gfs013', 'ncep_gfs025'], gfs_hrrr: ['ncep_hrrr_conus'],
    ncep_nam_conus: ['ncep_nam_conus'], ncep_nbm_conus: ['ncep_nbm_conus'],
    ecmwf_ifs: ['ecmwf_ifs'], ecmwf_ifs025: ['ecmwf_ifs025'], ecmwf_aifs025_single: ['ecmwf_aifs025_single'],
    icon_global: ['dwd_icon'], icon_eu: ['dwd_icon_eu'], icon_d2: ['dwd_icon_d2'],
    gem_global: ['cmc_gem_gdps_15km'], gem_regional: ['cmc_gem_rdps_10km'], gem_hrdps_continental: ['cmc_gem_hrdps'],
    meteofrance_arpege_world: ['meteofrance_arpege_world025'], meteofrance_arpege_europe: ['meteofrance_arpege_europe'],
    meteofrance_arome_france: ['meteofrance_arome_france0025'], meteofrance_arome_france_hd: ['meteofrance_arome_france_hd'],
    ukmo_global_deterministic_10km: ['ukmo_global_deterministic_10km'], ukmo_uk_deterministic_2km: ['ukmo_uk_deterministic_2km'],
    jma_gsm: ['jma_gsm'], jma_msm: ['jma_msm'], metno_nordic: ['metno_nordic_pp'],
    cma_grapes_global: ['cma_grapes_global'], italia_meteo_arpae_icon_2i: ['italia_meteo_arpae_icon_2i'],
    dmi_harmonie_arome_europe: ['dmi_harmonie_arome_europe'],
    knmi_harmonie_arome_netherlands: ['knmi_harmonie_arome_netherlands'], knmi_harmonie_arome_europe: ['knmi_harmonie_arome_europe'],
    meteoswiss_icon_ch1: ['meteoswiss_icon_ch1'], meteoswiss_icon_ch2: ['meteoswiss_icon_ch2'],
};
const allowed = new Set(Object.values(domains).flat());
const cancelled = () => Object.assign(new Error('Cancelled.'), { name: 'AbortError' });
export function peakModelUpdateDomains(model) {
    if (!PEAK_WEATHER_MODELS.includes(model)) throw new Error('Invalid weather model.');
    return [...(domains[model.id] || [])];
}
export function validatePeakModelUpdate(body, now = Date.now()) {
    const last = body?.last_run_availability_time, run = body?.last_run_initialisation_time, interval = body?.update_interval_seconds;
    const timestamp = value => Number.isSafeInteger(value) && value > 0 && value * 1000 <= now + 5 * 60_000;
    if (!body || Array.isArray(body) || !timestamp(last) || !timestamp(run) || run > last
        || !Number.isInteger(interval) || interval < 900 || interval > 7 * 86400) throw new Error('Invalid model update metadata.');
    return { lastUpdate: last * 1000, run: run * 1000, updateIntervalSeconds: interval, nextExpected: (last + interval) * 1000 };
}

// Optional, per-page metadata. Cache failures as well as successes to avoid
// retry loops on disclosure toggles. Cancellation never populates the cache.
export function createPeakModelUpdateClient({ fetchFn = globalThis.fetch, now = Date.now, timeoutMs = 5000 } = {}) {
    const cache = new Map();
    let limitedUntil = 0;
    return {
        clear: () => cache.clear(),
        async request(domain, { signal } = {}) {
            if (!allowed.has(domain)) throw new Error('Invalid metadata domain.');
            if (signal?.aborted) throw cancelled();
            const cached = cache.get(domain);
            if (cached && cached.expires > now()) return cached.result;
            if (limitedUntil > now()) return { data: null };
            const deadline = requestDeadline.createRequestDeadline(timeoutMs);
            let rejectCancel;
            const cancellation = new Promise((_, reject) => { rejectCancel = reject; });
            cancellation.catch(() => {});
            const cancel = () => { deadline.abort(); rejectCancel(cancelled()); };
            signal?.addEventListener('abort', cancel, { once: true });
            const run = promise => deadline.run(Promise.race([promise, cancellation]));
            let result;
            try {
                const response = await run(fetchFn(`https://api.open-meteo.com/data/${domain}/static/meta.json`, {
                    credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store', signal: deadline.signal,
                }));
                if (response.status === 429) limitedUntil = rateLimitError('Open-Meteo', response, now()).retryAt;
                if (!response.ok || !/application\/json/i.test(response.headers?.get('content-type') || '')) throw new Error('Update times unavailable.');
                const text = await run(readBoundedResponseText(response, { maxBytes: 16 * 1024, signal: deadline.signal, label: 'Model metadata' }));
                result = { data: validatePeakModelUpdate(JSON.parse(text), now()) };
            } catch (error) {
                if (signal?.aborted || error.name === 'AbortError') throw cancelled();
                result = { data: null };
            } finally {
                deadline.clear(); signal?.removeEventListener('abort', cancel);
            }
            if (signal?.aborted) throw cancelled();
            cache.set(domain, { result, expires: now() + 5 * 60_000 });
            return result;
        },
    };
}
