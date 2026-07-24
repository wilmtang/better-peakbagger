// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — coalescing GitHub write queue (pure).
//
// Every backup surface commits to the same mutable branch, so the worker
// serializes its writes. Serializing alone still spends a full
// resolve/read-tree/commit/update-ref round trip per writer, and the settings
// and favorites automatic backups share one delay, so they always arrive
// together and always produce two commits where one would do.
//
// A root file is last-write-wins content at a fixed path, so those writes can
// merge: writers that arrive close together commit as one tree, and repeated
// writes to one path within a batch keep only the newest content. A caller
// whose content was superseded still learns that its path reached the
// repository, and is told it was superseded so it does not record a signature
// the commit did not actually contain.
//
// Opaque operations — ascent pushes and deletions — stay exclusive. They carry
// their own pre-commit gates and per-ascent results, and they close whatever
// batch is still collecting, so submission order is never rearranged.
//
// This module holds no storage, network, or extension API: the caller injects
// the commit and the queue owns only ordering and merging.

// Writers that overlap in time only merge if the batch is still open when the
// second one arrives. Callers reach the queue after several storage reads, so
// the batch waits briefly before committing. This is invisible next to the
// network round trips of the commit itself, and automatic backups are already
// debounced by a much longer alarm.
const DEFAULT_COALESCE_WINDOW_MS = 250;

// Distinct messages, in submission order. One writer keeps its own message.
const batchMessage = entries => {
    const messages = [];
    for (const entry of entries) {
        if (entry.message && !messages.includes(entry.message)) messages.push(entry.message);
    }
    return messages.join('; ');
};

// Newest content per path wins; a path keeps the position of its first write so
// the committed tree does not depend on how writers interleaved.
const squash = entries => {
    const byPath = new Map();
    for (const entry of entries) byPath.set(entry.path, entry);
    return [...byPath.values()];
};

const createGithubWriteQueue = ({
    commitFiles,
    coalesceWindowMs = DEFAULT_COALESCE_WINDOW_MS,
    delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) => {
    if (typeof commitFiles !== 'function') {
        throw new TypeError('github write queue requires a commitFiles function');
    }

    let tail = Promise.resolve();
    // The batch still accepting entries, or null when none is collecting.
    let collecting = null;

    const chain = work => {
        const operation = tail.then(work, work);
        tail = operation.catch(() => {});
        return operation;
    };

    // One exclusive branch mutation. It also closes any collecting batch, so a
    // file write submitted after this call cannot commit before it.
    const run = write => {
        collecting = null;
        return chain(write);
    };

    const putFile = ({ path, content, message }) => {
        if (!collecting) {
            const batch = { entries: [], lastIndex: new Map(), promise: null };
            collecting = batch;
            batch.promise = chain(async () => {
                await delay(coalesceWindowMs);
                if (collecting === batch) collecting = null;
                const files = squash(batch.entries);
                return commitFiles(files.map(({ path: filePath, content: fileContent }) =>
                    ({ path: filePath, content: fileContent })), batchMessage(files));
            });
        }
        const batch = collecting;
        const index = batch.entries.length;
        batch.entries.push({ path, content, message });
        batch.lastIndex.set(path, index);
        return batch.promise.then(commit => ({
            sha: commit && commit.sha,
            commitUrl: commit && commit.commitUrl,
            message: commit && commit.message,
            path,
            // Another write replaced this content before the batch committed.
            // The path is current; this caller's own content is not what landed.
            superseded: batch.lastIndex.get(path) !== index,
        }));
    };

    return { run, putFile };
};

export const githubWriteQueue = { createGithubWriteQueue, DEFAULT_COALESCE_WINDOW_MS };
