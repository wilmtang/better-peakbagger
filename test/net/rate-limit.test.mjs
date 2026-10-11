import test from 'node:test';
import assert from 'node:assert/strict';
import { retryAfterAt, rateLimitError, rateLimitMessage } from '../../src/net/rate-limit.js';

const now = Date.parse('2026-10-11T12:00:00Z');
test('retry timing accepts bounded seconds and HTTP dates, never invents a reset from malformed headers', () => {
    const read = value => retryAfterAt(new Headers(value === null ? {} : { 'retry-after': value }), now);
    assert.equal(read('120'), now + 120000);
    assert.equal(read('Sun, 11 Oct 2026 12:02:00 GMT'), now + 120000);
    for (const invalid of [null, '', '0', '-1', '1.5', 'Infinity', 'tomorrow', '86401', 'Sun, 11 Oct 2026 11:59:00 GMT']) assert.equal(read(invalid), null);
});
test('the warning names the service and preserves a known retry time without reading its body', async () => {
    let cancelled = false;
    const error = rateLimitError('Open-Meteo', { headers: new Headers({ 'retry-after': '60' }), body: { cancel: async () => { cancelled = true; } } }, now);
    assert.equal(error.code, 'rate-limit'); assert.equal(error.status, 429); assert.equal(error.retryAt, now + 60000);
    assert.match(error.message, /Open-Meteo request limit reached\. Try again after/); assert.equal(cancelled, true);
    assert.equal(rateLimitMessage('ImgBB', null, now), 'ImgBB request limit reached. Wait a few minutes, then try again.');
});
