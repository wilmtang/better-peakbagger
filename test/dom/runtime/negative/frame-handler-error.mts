// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Runner self-check: an error thrown in a fixture frame's handler must fail the run.
import test from 'node:test';
import { FixtureDom } from '../../../helpers/fixture-dom.mts';

test('throws in a fixture handler', async () => {
    const dom = new FixtureDom('<button>Go</button>');
    const button = dom.window.document.querySelector('button')!;
    button.addEventListener('click', () => { throw new Error('handler failure'); });
    button.click();
    await new Promise(resolve => setTimeout(resolve, 0));
});
