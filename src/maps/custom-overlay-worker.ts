// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import {
    parseCustomData,
    type CustomGeoJsonCollection,
    type CustomMvtResult,
    type CustomParseRequest,
} from './custom-overlay-data.ts';

type CustomWorkerReply =
    | { ok: true; value: CustomGeoJsonCollection | CustomMvtResult }
    | { ok: false; error: string };

interface WorkerScope {
    onmessage: ((event: MessageEvent<CustomParseRequest>) => void) | null;
    postMessage(message: CustomWorkerReply): void;
}

const workerScope = self as unknown as WorkerScope;

workerScope.onmessage = event => {
    try { workerScope.postMessage({ ok: true, value: parseCustomData(event.data) }); }
    catch { workerScope.postMessage({ ok: false, error: 'Invalid or oversized vector data.' }); }
};
