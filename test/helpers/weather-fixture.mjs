export const weatherFixture = ({ latitude = 46.851731, longitude = -121.760395, elevation = 4391, startDate = '2024-07-11', hours = 72, fields = ['weather_code', 'temperature_2m', 'precipitation', 'wind_speed_10m', 'wind_gusts_10m'] } = {}) => {
    const units = { time: 'unixtime', temperature_2m: '°C', precipitation: 'mm', wind_speed_10m: 'km/h', wind_gusts_10m: 'km/h', weather_code: 'wmo code' };
    const hourly = { time: Array.from({ length: hours }, (_, index) => Date.parse(`${startDate}T00:00:00Z`) / 1000 + index * 3600) };
    for (const field of fields) hourly[field] = hourly.time.map((_, index) => field === 'weather_code' ? (index % 24 >= 15 && index % 24 <= 18 ? 71 : 3)
        : field === 'precipitation' ? (index % 24 >= 15 && index % 24 <= 18 ? 0.3 : 0)
            : field === 'temperature_2m' ? Math.round(-4 + 5 * Math.sin((index % 24 - 11) / 24 * 2 * Math.PI))
                : field === 'wind_gusts_10m' ? 35 : 20);
    return { latitude, longitude, elevation, utc_offset_seconds: 0, hourly_units: units, hourly };
};

// Forecast API uses model-suffixed columns only when more than one named model
// is requested. Keep fixture transport faithful to its published response.
export function weatherModelFixture(body, modelIds, forecastEnd = {}) {
    if (modelIds.length < 2 || Object.keys(body.hourly).some(key => key.endsWith(`_${modelIds[0]}`))) {
        for (const id of modelIds) for (const [key, values] of Object.entries(body.hourly)) {
            if (key !== 'time' && (modelIds.length === 1 || key.endsWith(`_${id}`))) body.hourly[key] = values.map((value, index) =>
                body.hourly.time[index] > forecastEnd[id] ? null : value);
        }
        return body;
    }
    const hourly = { time: body.hourly.time }, hourly_units = { time: body.hourly_units.time };
    for (const id of modelIds) for (const [field, values] of Object.entries(body.hourly)) {
        if (field === 'time') continue;
        hourly[`${field}_${id}`] = values.map((value, index) => body.hourly.time[index] > forecastEnd[id] ? null : value);
        hourly_units[`${field}_${id}`] = body.hourly_units[field];
    }
    return { ...body, hourly, hourly_units };
}
