// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export const snotelStations = () => [
    { stationTriplet: '679:WA:SNTL', name: 'Paradise', latitude: 46.78266, longitude: -121.74767,
        elevation: 5150, dataTimeZone: -8 },
    { stationTriplet: '375:WA:SNTL', name: 'Bumping Ridge', latitude: 46.81003, longitude: -121.33058,
        elevation: 4600, dataTimeZone: -8 },
];

export function snotelFixture(stationId = '679:WA:SNTL', duration = 'HOURLY', now = Date.now(), hourlyCount = 6) {
    const day = new Date(now - 8 * 3600_000).toISOString().slice(0, 10);
    const count = duration === 'DAILY' ? 8 : hourlyCount;
    return [{ stationTriplet: stationId, data: ['SNWD', 'WTEQ'].map((elementCode, codeIndex) => ({
        stationElement: { elementCode, ordinal: 1, durationName: duration, storedUnitCode: 'in' },
        values: Array.from({ length: count }, (_, index) => {
            const valueIndex = duration === 'DAILY' ? index : Math.max(0, index - (count - 6));
            const ms = duration === 'DAILY' ? Date.parse(day) - (count - 1 - index) * 86400_000
                : Math.floor(now / 3600_000) * 3600_000 - 8 * 3600_000 - (count - 1 - index) * 3600_000;
            return { date: new Date(ms).toISOString().slice(0, duration === 'DAILY' ? 10 : 16).replace('T', ' '),
                value: duration === 'HOURLY' && index > count - 2 - codeIndex ? null : elementCode === 'SNWD' ? 32 + valueIndex : 12 + valueIndex / 10,
                qcFlag: 'V', qaFlag: 'P' };
        }),
    })) }];
}
