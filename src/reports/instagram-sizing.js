// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Provider measurements cross two frame boundaries. Only a bounded positive
// number may affect layout, and only the first completed load adopts it.
export function instagramEmbedHeight(value) {
    return typeof value==='number'&&Number.isFinite(value)&&value>0
        ? Math.max(320,Math.min(1600,Math.ceil(value))) : null;
}
