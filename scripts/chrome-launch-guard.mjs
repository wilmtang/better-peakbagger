// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Headless Chrome still registers with macOS. Codex's Seatbelt sandbox can
// abort that registration and provoke a visible system crash dialog.
export function assertChromeLaunchAllowed({
    platform = process.platform,
    environment = process.env,
} = {}) {
    if (platform !== 'darwin' || environment.CODEX_SANDBOX !== 'seatbelt') return;
    throw Object.assign(new Error(
        'Chrome verification cannot launch inside the macOS Codex Seatbelt sandbox. '
        + 'Run this check through the approved execution path outside that sandbox; '
        + 'keep Chrome headless and its test profile isolated. No browser was launched.',
    ), { code: 'BPB_CHROME_SANDBOX' });
}
