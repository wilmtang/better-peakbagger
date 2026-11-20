// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `npm run verify -- dom [chrome] [firefox] [--suite TEXT] [--case TEXT] [--dist DIR]`: runs
// the real-browser DOM tier: the orchestrated suites in test/dom/ (see
// scripts/dom-tier.mts), then the in-page `test/**/*.browser.mts` files (see
// scripts/browser-tests.mts). --suite matches a suite name or file path and
// --case a case or test name. A selection that executes nothing fails.
import assert from 'node:assert/strict';
import { runBrowserTests, runNegativeChecks } from './browser-tests.mts';
import { domSelection, runDomTier } from './dom-tier.mts';

const args = process.argv.slice(2);
const report = (record: Record<string, unknown>) => console.log(JSON.stringify(record));
const orchestrated = await runDomTier(args, undefined, report, { allowEmpty: true });
const inPage = await runBrowserTests(domSelection(args), report);
assert.ok(orchestrated + inPage > 0, `No DOM tier case or browser test matches ${JSON.stringify(args)}.`);
// A complete run also proves the in-page runner fails on broken files.
const selection = domSelection(args);
if (selection.suite === null && selection.filter === null) await runNegativeChecks(selection, report);
report({ verification: 'dom-tier', orchestratedCases: orchestrated, browserTests: inPage });
