import { cloudSamplePoints } from '../../src/weather/summit-cloud-core.ts';
import { summitCloudModel, type SummitCloudModel } from '../../src/weather/summit-cloud-models.ts';
import type {
    SummitCloudLevel,
    SummitCloudMetadata,
    SummitCloudProfile,
    SummitCloudRequest,
    SummitCloudSamplePoint,
} from '../../src/weather/summit-cloud-client.ts';

type CloudValues = Partial<Pick<SummitCloudLevel, 'cloud' | 'humidity'>>;

interface DatasetOptions extends CloudValues {
    model?: SummitCloudModel;
    time?: number;
    hours?: number;
}

type Dataset = SummitCloudProfile & { metadata: SummitCloudMetadata; loadedAt: number };
type Point = Pick<SummitCloudSamplePoint, 'latitude' | 'longitude'> & Partial<Pick<SummitCloudSamplePoint, 'bearing'>>;
type FixtureRequest = Pick<SummitCloudRequest, 'model' | 'start' | 'end'> & { points: readonly Point[] };

const fixtureModel = (id: string): SummitCloudModel => {
    const model = summitCloudModel(id);
    if (!model) throw new Error(`Unknown summit cloud fixture model: ${id}`);
    return model;
};

export const cloudSubject = { latitude: 47.475, longitude: -120.902, elevation: 2870 };
export const cloudTime = Date.UTC(2026, 9, 24, 12);
export function cloudDataset({
    model = fixtureModel('gfs_global'), time = cloudTime, hours = 24, cloud = 5, humidity = 55,
}: DatasetOptions = {}): Dataset {
    return { model, metadata: { lastUpdate: time, updateIntervalSeconds: 21600 }, loadedAt: time,
        points: cloudSamplePoints(cloudSubject, model.gridKm).map(point => ({ ...point, grid: { ...point, elevation: 700 },
            samples: Array.from({ length: hours }, (_, i) => ({ time: time + i * 3600000,
                levels: model.levels.map((pressure, j) => ({ pressure, height: j * 650, cloud, humidity, temperature: 12 - j * 4, wind: 6, direction: 270 })) })) })) };
}
export function cloudResponse(request: FixtureRequest, { cloud = 5, humidity = 55 }: CloudValues = {}) {
    const data = cloudDataset({ model: request.model, time: request.start, hours: (request.end - request.start) / 3600000, cloud, humidity });
    const variables: Record<string, [keyof SummitCloudLevel, string]> = { temperature: ['temperature', '°C'], relative_humidity: ['humidity', '%'], geopotential_height: ['height', 'm'],
        cloud_cover: ['cloud', '%'], wind_speed: ['wind', 'm/s'], wind_direction: ['direction', '°'] };
    return data.points.map((point, index) => {
        const hourly: Record<string, (number | null)[]> & { time: number[] } = { time: point.samples.map(row => row.time / 1000) };
        const hourly_units: Record<string, string> = { time: 'unixtime' };
        for (const [variable, [key, unit]] of Object.entries(variables)) for (const pressure of request.model.levels) {
            const name = `${variable}_${pressure}hPa`; hourly_units[name] = unit;
            hourly[name] = point.samples.map(row => {
                const level = row.levels.find(candidate => candidate.pressure === pressure);
                if (!level) throw new Error(`Missing summit cloud fixture pressure: ${pressure}`);
                return level[key];
            });
        }
        return { ...request.points[index], elevation: 700, utc_offset_seconds: 0, hourly, hourly_units };
    });
}

export function cloudResponseForUrl(url: string | URL, options?: CloudValues) {
    const query = new URL(url).searchParams;
    const latitude = query.get('latitude'), longitude = query.get('longitude'), modelId = query.get('models');
    if (latitude === null || longitude === null || modelId === null) {
        throw new Error('Missing summit cloud fixture coordinates or model.');
    }
    const latitudes = latitude.split(',').map(Number), longitudes = longitude.split(',').map(Number);
    return cloudResponse({ model: fixtureModel(modelId),
        start: Date.parse(`${query.get('start_hour')}Z`), end: Date.parse(`${query.get('end_hour')}Z`) + 3600000,
        points: latitudes.map((lat, index) => ({ latitude: lat, longitude: longitudes[index] })) }, options);
}
