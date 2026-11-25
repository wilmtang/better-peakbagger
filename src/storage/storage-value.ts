// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Semantic equality for the JSON-shaped values accepted by extension storage.
// Object key order is deliberately irrelevant: callers use this to decide
// whether a queued compare-and-swap may still restore a prior value.

const same = (left: unknown, right: unknown): boolean => {
    if (Object.is(left, right)) return true;
    if (left == null || right == null || typeof left !== 'object' || typeof right !== 'object') {
        return false;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right)) return false;
        const leftItems = left as unknown[];
        const rightItems = right as unknown[];
        return leftItems.length === rightItems.length
            && leftItems.every((value, index) => same(value, rightItems[index]));
    }
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return leftKeys.length === rightKeys.length
        && leftKeys.every((key, index) => key === rightKeys[index] && same(leftRecord[key], rightRecord[key]));
};

export const storageValue = { same };
