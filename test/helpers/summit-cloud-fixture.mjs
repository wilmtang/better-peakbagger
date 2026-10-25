import { cloudSamplePoints } from '../../src/weather/summit-cloud-core.js';
import { summitCloudModel } from '../../src/weather/summit-cloud-models.js';

export const cloudSubject = { latitude: 47.475, longitude: -120.902, elevation: 2870 };
export const cloudTime = Date.UTC(2026, 9, 24, 12);
export function cloudDataset({ model = summitCloudModel('gfs_global'), time = cloudTime, hours = 24, cloud = 5, humidity = 55 } = {}) {
    return { model, metadata: { lastUpdate: time, updateIntervalSeconds: 21600 }, loadedAt: time,
        points: cloudSamplePoints(cloudSubject, model.gridKm).map(point => ({ ...point, grid: { ...point, elevation: 700 },
            samples: Array.from({ length: hours }, (_, i) => ({ time: time + i * 3600000,
                levels: model.levels.map((pressure, j) => ({ pressure, height: j * 650, cloud, humidity, temperature: 12 - j * 4, wind: 6, direction: 270 })) })) })) };
}
export function cloudResponse(request, { cloud = 5, humidity = 55 } = {}) {
    const data = cloudDataset({ model: request.model, time: request.start, hours: (request.end - request.start) / 3600000, cloud, humidity });
    const variables = { temperature: ['temperature', '°C'], relative_humidity: ['humidity', '%'], geopotential_height: ['height', 'm'],
        cloud_cover: ['cloud', '%'], wind_speed: ['wind', 'm/s'], wind_direction: ['direction', '°'] };
    return data.points.map((point, index) => {
        const hourly = { time: point.samples.map(row => row.time / 1000) }, hourly_units = { time: 'unixtime' };
        for (const [variable, [key, unit]] of Object.entries(variables)) for (const pressure of request.model.levels) {
            const name = `${variable}_${pressure}hPa`; hourly_units[name] = unit;
            hourly[name] = point.samples.map(row => row.levels.find(level => level.pressure === pressure)[key]);
        }
        return { ...request.points[index], elevation: 700, utc_offset_seconds: 0, hourly, hourly_units };
    });
}
