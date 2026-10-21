// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readLayerSnapshot } from '../maps/map-layer-protocol.js';

const KEY = 'bpbMapLayerHandoffsV1';
const destination = value => {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || !['peakbagger.com', 'www.peakbagger.com'].includes(url.hostname)
            || !/\/map\/bigmap\.aspx$/i.test(url.pathname) || url.href.length > 2048 || url.username || url.password) return null;
        url.hash = ''; url.searchParams.sort(); return url.href;
    } catch { return null; }
};
export function createMapLayerHandoff({ storage, isPeakbaggerSender, now = Date.now }) {
    let queue = Promise.resolve();
    const transact = operation => {
        const next = queue.then(async () => {
            const records = (await storage.get(KEY))[KEY] || [];
            const live = Array.isArray(records) ? records.filter(record => record?.expires > now()).slice(-31) : [];
            const result = operation(live);
            await storage.set({ [KEY]: live }); return result;
        });
        queue = next.catch(() => {}); return next;
    };
    return {
        prepare(message, sender) {
            const target = destination(message.destination), snapshot = readLayerSnapshot(message.snapshot);
            if (!isPeakbaggerSender(sender) || !Number.isInteger(sender.tab?.id) || !target || !snapshot) return { ok: false };
            return transact(records => {
                for (let i = records.length - 1; i >= 0; i--) if (records[i].source === sender.tab.id) records.splice(i, 1);
                records.push({ source: sender.tab.id, window: sender.tab.windowId, target, expires: now() + 30000,
                    snapshot: { ...snapshot, menuOpen: false } });
                return { ok: true };
            });
        },
        consume(_message, sender) {
            const target = destination(sender?.url);
            if (!isPeakbaggerSender(sender) || !target || !Number.isInteger(sender.tab?.id)) return { ok: false };
            return transact(records => {
                const index = records.findIndex(record => record.target === target && record.window === sender.tab.windowId
                    && (record.source === sender.tab.id || record.source === sender.tab.openerTabId));
                if (index < 0) return { ok: false };
                const [record] = records.splice(index, 1); return { ok: true, snapshot: readLayerSnapshot(record.snapshot) };
            });
        },
    };
}
