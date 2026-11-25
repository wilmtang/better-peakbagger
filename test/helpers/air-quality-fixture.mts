export function airQualityFixture({ now = Date.now(), latitude = 46.9, longitude = -121.8 } = {}) {
    const start = Math.floor(now / 86400000) * 86400;
    return { latitude, longitude, utc_offset_seconds: 0, hourly_units: { time: 'unixtime', us_aqi: 'USAQI', pm2_5: 'μg/m³' },
        hourly: { time: Array.from({ length: 120 }, (_, index) => start + index * 3600),
            us_aqi: Array.from({ length: 120 }, (_, index) => [35, 72, 125, 175, 250, 350][Math.floor(index / 20)]),
            pm2_5: Array.from({ length: 120 }, (_, index) => 5 + index / 2) } };
}
