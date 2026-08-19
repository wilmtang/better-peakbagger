// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Isolated-world half of the trusted-action boundary. Callers must pass the
// actual DOM activation event; synthetic host-page events fail before runtime
// messaging can mint any authority.

const issue = async (ext, event, action, generation) => {
    if (event?.isTrusted !== true) return null;
    const response = await ext.runtime.sendMessage({
        type: 'TRUSTED_ACTION_ISSUE',
        action,
        generation: String(generation),
    });
    return response?.ok ? response : null;
};

const begin = async (ext, event, action, generation) => {
    const activation = await issue(ext, event, action, generation);
    if (!activation) return null;
    const response = await ext.runtime.sendMessage({
        type: 'TRUSTED_ACTION_BEGIN',
        action,
        generation: String(generation),
        activationToken: activation.token,
    });
    return response?.ok ? response : null;
};

const end = (ext, workflow, generation) => {
    if (!workflow?.grantToken) return Promise.resolve({ ok: false });
    return ext.runtime.sendMessage({
        type: 'TRUSTED_ACTION_END',
        generation: String(generation),
        grantToken: workflow.grantToken,
    }).catch(() => ({ ok: false }));
};

export const trustedAction = { issue, begin, end };
