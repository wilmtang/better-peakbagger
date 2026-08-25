// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';

import { mountainTime as MountainTime } from '../../src/time/mountain-time.js';

test('mountain time resolves ordinary and unusual political offsets offline', () => {
    const denver = MountainTime.resolve(39.7392, -104.9903);
    const kathmandu = MountainTime.resolve(27.7172, 85.3240);
    const chatham = MountainTime.resolve(-43.95, -176.55);

    assert.equal(denver.timeZone, 'America/Denver');
    assert.equal(MountainTime.localMinute(denver, Date.parse('2026-07-10T18:30:00Z')), 12 * 60 + 30);
    assert.equal(MountainTime.localMinute(kathmandu, Date.parse('2026-07-10T00:00:00Z')), 5 * 60 + 45);
    assert.equal(MountainTime.localMinute(chatham, Date.parse('2026-07-10T00:00:00Z')), 12 * 60 + 45);
});

test('civil conversion observes DST gaps and chooses the earlier repeated hour', () => {
    const denver = MountainTime.resolve(39.7392, -104.9903);
    const gap = MountainTime.civilToInstant(denver, '2026-03-08', 2 * 60 + 30);
    assert.deepEqual({ date: gap.date, minute: gap.minute, adjusted: gap.adjusted }, {
        date: '2026-03-08', minute: 3 * 60, adjusted: true,
    });
    assert.equal(gap.ms, Date.parse('2026-03-08T09:00:00Z'));

    const overlap = MountainTime.civilToInstant(denver, '2026-11-01', 1 * 60 + 30);
    assert.equal(overlap.ambiguous, true);
    assert.equal(overlap.ms, Date.parse('2026-11-01T07:30:00Z'));
});

test('civil dates and local-day comparisons survive the international date line', () => {
    const kiritimati = MountainTime.resolve(1.8721, -157.4278);
    const instant = MountainTime.civilToInstant(kiritimati, '2026-01-02', 15);
    assert.equal(instant.ms, Date.parse('2026-01-01T10:15:00Z'));
    assert.equal(MountainTime.localDate(kiritimati, instant.ms), '2026-01-02');
    assert.equal(MountainTime.relativeLocalDay(
        kiritimati,
        Date.parse('2026-01-01T10:00:00Z'),
        Date.parse('2026-01-01T09:59:00Z'),
    ), 2);
});

test('unknown ICU zones and lookup failures use the labelled longitude fallback', () => {
    class RejectingDateTimeFormat extends Intl.DateTimeFormat {
        constructor(locales, options) {
            if (options?.timeZone === 'Etc/Unknown') throw new RangeError('unknown');
            super(locales, options);
        }
    }
    const unknown = MountainTime.resolve(40, -121.8, {
        lookup: () => 'Etc/Unknown',
        DateTimeFormat: RejectingDateTimeFormat,
    });
    const failed = MountainTime.resolve(40, -121.8, { lookup: () => { throw new Error('bad raster'); } });
    for (const zone of [unknown, failed]) {
        assert.equal(zone.timeZone, null);
        assert.equal(zone.offsetMs, -8 * 3_600_000);
        assert.equal(MountainTime.zoneLabel(zone, 0), 'UTC−8, estimated from longitude');
        assert.equal(MountainTime.localDate(zone, Date.parse('2026-01-01T07:30:00Z')), '2025-12-31');
    }
});

test('mountain time fails closed on malformed coordinates, dates, minutes, and instants', () => {
    assert.equal(MountainTime.resolve(91, 0), null);
    const zone = MountainTime.resolve(0, 0);
    assert.equal(MountainTime.civilToInstant(zone, '2026-02-30', 0), null);
    assert.equal(MountainTime.civilToInstant(zone, '2026-02-01', 1440), null);
    assert.equal(MountainTime.localDate(zone, Number.NaN), null);
});
