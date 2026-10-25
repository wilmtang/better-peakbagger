import assert from 'node:assert/strict';
import test from 'node:test';
import { weatherChartRange, weatherChartTicks } from '../../src/weather/weather-chart-scale.js';
import { units } from '../../src/ui/units.js';

for (const system of ['metric', 'imperial']) for (const metric of ['wind', 'gust', 'precipitation', 'temperature']) {
    test(`${system} ${metric} scales retain distinct ticks for zero and constant samples`, () => {
        for (const value of [0, .4, 20]) {
            const range = weatherChartRange([null, value, value], metric);
            const labels = weatherChartTicks(range).map(tick => units.formatWeather(tick, metric === 'gust' ? 'wind' : metric, system));
            assert.equal(new Set(labels).size, 3, labels.join(', '));
            assert.ok(range.low <= value && range.high >= value);
        }
    });
}
test('scale handles missing values, negative temperature, clouds and reference heights explicitly', () => {
    assert.equal(weatherChartRange([null, NaN], 'wind'), null);
    assert.deepEqual(weatherChartRange([-2.2, 3], 'temperature', { roundTemperatureLow: true }), { low: -5, high: 5 });
    assert.deepEqual(weatherChartRange([10, 80], 'cloud'), { low: 0, high: 100 });
    assert.deepEqual(weatherChartRange([2600, 2700], 'freezing', { references: [4391, null] }), { low: 2400, high: 4591 });
});
