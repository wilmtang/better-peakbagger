// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Values and reference heights must use the caller's plotting unit system.
// Formatting, time ticks, interval representation and cursor overlays stay local.
export function weatherChartRange(values, metric, { references = [], roundTemperatureLow = false } = {}) {
    const finite = values.filter(Number.isFinite);
    if (!finite.length) return null;
    const extent = [...finite, ...references.filter(Number.isFinite)];
    if (metric === 'cloud') return { low: 0, high: 100 };
    const padding = metric === 'freezing' ? 200 : metric === 'temperature' ? 2 : 0;
    let low = padding ? Math.min(...extent) - padding : 0;
    if (metric === 'temperature' && roundTemperatureLow) low = Math.floor(low);
    const maximum = Math.max(...extent), minimumSpan = metric === 'precipitation' ? 1 : 4;
    return { low, high: Math.max(low + minimumSpan, maximum + (padding || maximum * .15)) };
}

export const weatherChartTicks = ({ low, high }) => [low, (low + high) / 2, high];
