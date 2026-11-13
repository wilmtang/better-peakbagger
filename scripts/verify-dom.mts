// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `npm run verify -- dom [chrome] [firefox] [--case TEXT] [--dist DIR]`: runs
// the real-browser DOM tier in test/dom/ (see scripts/dom-tier.mts).
import { runDomTier } from './dom-tier.mts';

await runDomTier(process.argv.slice(2));
