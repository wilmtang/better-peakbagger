// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Values and reference heights must use the caller's plotting unit system.
// Formatting, time ticks, interval representation and cursor overlays stay local.
export interface WeatherChartRange {
    low: number;
    high: number;
}

export interface WeatherChartRangeOptions {
    references?: readonly unknown[];
    roundTemperatureLow?: boolean;
}

const finiteNumbers = (values: readonly unknown[]): number[] =>
    values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

export function weatherChartRange(
    values: readonly unknown[],
    metric: string,
    { references = [], roundTemperatureLow = false }: WeatherChartRangeOptions = {},
): WeatherChartRange | null {
    const finite = finiteNumbers(values);
    if (!finite.length) return null;
    const extent = [...finite, ...finiteNumbers(references)];
    if (metric === 'cloud') return { low: 0, high: 100 };
    const padding = metric === 'freezing' ? 200 : metric === 'temperature' ? 2 : 0;
    let low = padding ? Math.min(...extent) - padding : 0;
    if (metric === 'temperature' && roundTemperatureLow) low = Math.floor(low);
    const maximum = Math.max(...extent), minimumSpan = metric === 'precipitation' ? 1 : 4;
    return { low, high: Math.max(low + minimumSpan, maximum + (padding || maximum * .15)) };
}

export const weatherChartTicks = ({ low, high }: WeatherChartRange): number[] => [low, (low + high) / 2, high];
