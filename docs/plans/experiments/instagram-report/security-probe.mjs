// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// The original comparison is preserved in Git history at 815effdd. Delegate to
// the maintained security boundary instead of expecting the fixed build to run
// report-supplied scripts. --baseline must fail on observed execution.
import assert from 'node:assert/strict';
import { verifyReportSecurity } from '../../../../scripts/verify-report-security.mjs';
const args=process.argv.slice(2);
assert(args.length<=1&&(!args.length||args[0]==='--baseline'),'Usage: security-probe.mjs [--baseline]');
await verifyReportSecurity('chrome',{baseline:args.includes('--baseline')});
