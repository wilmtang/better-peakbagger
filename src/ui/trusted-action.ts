// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Isolated-world half of the trusted-action boundary. Callers must pass the
// actual DOM activation event; synthetic host-page events fail before runtime
// messaging can mint any authority.

export interface TrustedActionExtension {
    runtime: {
        sendMessage(message: unknown): Promise<unknown>;
    };
}

export interface TrustedActionEvent {
    readonly isTrusted?: boolean;
}

export interface TrustedActionActivation {
    ok: true;
    token: string;
    [key: string]: unknown;
}

export interface TrustedActionWorkflow {
    ok: true;
    grantToken: string;
    [key: string]: unknown;
}

export interface TrustedActionEndResponse {
    ok: boolean;
    [key: string]: unknown;
}

const issue = async (
    ext: TrustedActionExtension | null | undefined,
    event: TrustedActionEvent | null | undefined,
    action: string,
    generation: string | number
): Promise<TrustedActionActivation | null> => {
    if (event?.isTrusted !== true) return null;
    try {
        if (!ext?.runtime) return null;
        const response = await ext.runtime.sendMessage({
            type: 'TRUSTED_ACTION_ISSUE',
            action,
            generation: String(generation),
        }) as Record<string, unknown> | null | undefined;
        return response?.ok ? response as TrustedActionActivation : null;
    } catch {
        return null;
    }
};

const begin = async (
    ext: TrustedActionExtension | null | undefined,
    event: TrustedActionEvent | null | undefined,
    action: string,
    generation: string | number
): Promise<TrustedActionWorkflow | null> => {
    const activation = await issue(ext, event, action, generation);
    if (!activation) return null;
    try {
        if (!ext?.runtime) return null;
        const response = await ext.runtime.sendMessage({
            type: 'TRUSTED_ACTION_BEGIN',
            action,
            generation: String(generation),
            activationToken: activation.token,
        }) as Record<string, unknown> | null | undefined;
        return response?.ok ? response as TrustedActionWorkflow : null;
    } catch {
        return null;
    }
};

const end = (
    ext: TrustedActionExtension | null | undefined,
    workflow: { grantToken?: string | null } | null | undefined,
    generation: string | number
): Promise<TrustedActionEndResponse> => {
    if (!ext?.runtime || !workflow?.grantToken) return Promise.resolve({ ok: false });
    return (ext.runtime.sendMessage({
        type: 'TRUSTED_ACTION_END',
        generation: String(generation),
        grantToken: workflow.grantToken,
    }) as Promise<TrustedActionEndResponse>).catch(() => ({ ok: false }));
};

export const trustedAction = { issue, begin, end };
