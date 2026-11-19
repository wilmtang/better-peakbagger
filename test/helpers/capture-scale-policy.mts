// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export const CAPTURE_CPU_SAMPLE_COUNT = 3;
export const CAPTURE_CPU_MEDIAN_LIMIT_MS = 15_000;
export const CAPTURE_CPU_MAX_LIMIT_MS = 30_000;

export function evaluateCaptureCpuSamples(samples: unknown) {
    if (!Array.isArray(samples) || samples.length !== CAPTURE_CPU_SAMPLE_COUNT
        || !samples.every((value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0)) {
        throw new Error('Capture benchmark requires three finite positive CPU samples');
    }
    const [minimum, median, maximum] = [...samples].sort((a, b) => a - b);
    if (median >= CAPTURE_CPU_MEDIAN_LIMIT_MS || maximum >= CAPTURE_CPU_MAX_LIMIT_MS) {
        throw new Error(`Capture CPU regression: median ${median.toFixed(1)} ms, maximum ${maximum.toFixed(1)} ms; samples ${samples.map(value => value.toFixed(1)).join(', ')}`);
    }
    return { median, maximum, minimum };
}
