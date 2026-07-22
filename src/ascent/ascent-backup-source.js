// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared Peakbagger source reader for every GitHub ascent-backup surface.
//
// This module owns the correctness-critical boundary between Peakbagger's
// authenticated HTML/GPX responses and a complete backup snapshot. Callers own
// orchestration and UI policy, but they must not invent a second form parser or
// accept a response based on HTTP status alone.

import { ascentSnapshot as Snapshot } from './ascent-snapshot.js';
import { reportMarkup as Markup } from '../reports/report-markup.js';
import {
    fetchPeakbaggerDocument,
    fetchPeakbaggerResource,
} from '../peakbagger/peakbagger-request.js';

const trim = value => (typeof value === 'string' ? value : value == null ? '' : String(value)).trim();

export { fetchPeakbaggerDocument, fetchPeakbaggerResource };

// Parse the owner-only edit form into the single raw-field schema. Missing
// required controls and mismatched identity are different failures, but neither
// may cross the background-message boundary as a "complete" snapshot.
export const snapshotFromEditDocument = ({
    doc,
    editUrl,
    baseUrl = 'https://www.peakbagger.com/',
    ascentId,
    peakId = null,
    climberId = null,
    fallbackDate = '',
    fallbackPeakName = '',
    extensionVersion = '',
} = {}) => {
    const form = doc && (doc.getElementById('Form1') || doc.querySelector('form[name="Form1"]'));
    if (!form || !form.elements.JournalText || !form.elements.DateText || !form.elements.PeakListBox) {
        return { ok: false, code: 'incomplete', reason: 'The ascent edit form was incomplete.' };
    }

    let params;
    try { params = new URL(editUrl, baseUrl).searchParams; }
    catch { return { ok: false, code: 'identity', reason: 'The ascent edit URL was invalid.' }; }

    if (Number.isInteger(ascentId) && ascentId > 0) params.set('aid', String(ascentId));
    if (Number.isInteger(peakId) && peakId > 0) params.set('pid', String(peakId));
    if (Number.isInteger(climberId) && climberId > 0) params.set('cid', String(climberId));

    const built = Snapshot.build({
        form,
        params,
        report: { markdown: Markup.bracketToMarkdown(form.elements.JournalText.value || '') },
        extensionVersion,
    });
    if (built.snapshot.ascent.id !== ascentId
        || (peakId != null && built.snapshot.peak.id !== peakId)) {
        return { ok: false, code: 'identity', reason: 'The ascent identity did not match the requested ascent.' };
    }

    if (!built.snapshot.ascent.date && fallbackDate) built.snapshot.ascent.date = trim(fallbackDate);
    if (!built.snapshot.peak.name && fallbackPeakName) built.snapshot.peak.name = trim(fallbackPeakName);
    return { ok: true, snapshot: built.snapshot, identity: built.identity };
};

// Full-profile backup deliberately avoids fetching every display page. The
// owner list authoritatively says whether a track exists, and this is the
// current endpoint used by Peakbagger's own download link. Individual backup
// still follows the exact link found on the display page instead.
export const storedGpxUrl = ({ origin, ascentId } = {}) => {
    if (!Number.isInteger(ascentId) || ascentId <= 0) return null;
    const url = new URL('/climber/GPXFile.aspx', origin);
    url.searchParams.set('aid', String(ascentId));
    url.searchParams.set('sep', '1');
    return url.toString();
};

export const ascentBackupSource = {
    fetchPeakbaggerDocument,
    fetchPeakbaggerResource,
    snapshotFromEditDocument,
    storedGpxUrl,
};
