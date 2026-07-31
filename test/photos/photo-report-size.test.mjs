// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { photoReportSize as ReportSize } from '../../src/photos/photo-report-size.js';

test('the report size choices have one readable default and an unsized Original', () => {
    assert.deepEqual(ReportSize.CHOICES, [
        { token: '320', label: 'Small · 320 px', width: 320 },
        { token: '480', label: 'Medium · 480 px', width: 480 },
        { token: '640', label: 'Large · 640 px', width: 640 },
        { token: 'original', label: 'Original', width: null },
    ]);
    assert.equal(ReportSize.tokenFromWidth(640), '640');
    assert.equal(ReportSize.tokenFromWidth(null), 'original');
    assert.equal(ReportSize.tokenFromWidth('unknown'), '640');
    assert.equal(ReportSize.choiceFromToken('480')?.width, 480);
    assert.equal(ReportSize.choiceFromToken('800'), null);
});

test('a display width never changes or upscales the source dimensions', () => {
    assert.equal(ReportSize.displayWidth(4032, 640), 640);
    assert.equal(ReportSize.displayWidth(400, 640), 400);
    assert.equal(ReportSize.displayWidth(4032, null), null);
    assert.equal(ReportSize.displayWidth(0, 640), null);
    assert.equal(ReportSize.displayWidth(4032.5, 640), null);
});
