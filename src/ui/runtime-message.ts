// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Promise-form runtime messaging is supported by both target browsers: Chrome
// MV3 and Firefox's browser namespace. Normalize teardown and worker failures
// to null so every UI surface fails closed through the same contract.
export interface RuntimeMessageExtension {
    runtime: {
        sendMessage(message: unknown): Promise<unknown>;
    };
}

export interface RuntimeMessageError {
    code?: string;
    message?: string;
    [key: string]: unknown;
}

export interface RuntimeMessageResponse {
    ok?: boolean;
    error?: RuntimeMessageError;
    [key: string]: unknown;
}

export type RuntimeMessageResult<Response = RuntimeMessageResponse> =
    | { kind: 'unavailable' }
    | { kind: 'response'; value: Response };

const send = async <Response = RuntimeMessageResponse>(
    extensionApi: RuntimeMessageExtension | null | undefined,
    message: unknown
): Promise<Response | null> => {
    try {
        if (!extensionApi?.runtime) return null;
        return ((await extensionApi.runtime.sendMessage(message)) as Response | null | undefined) || null;
    } catch {
        return null;
    }
};

const sendResult = async <Response = RuntimeMessageResponse>(
    extensionApi: RuntimeMessageExtension | null | undefined,
    message: unknown
): Promise<RuntimeMessageResult<Response>> => {
    try {
        if (!extensionApi?.runtime) return { kind: 'unavailable' };
        const response = await extensionApi.runtime.sendMessage(message);
        return response == null
            ? { kind: 'unavailable' }
            : { kind: 'response', value: response as Response };
    } catch {
        return { kind: 'unavailable' };
    }
};

const bind = <DefaultResponse = RuntimeMessageResponse>(
    extensionApi: RuntimeMessageExtension | null | undefined
) => <Response = DefaultResponse>(message: unknown): Promise<Response | null> =>
        send<Response>(extensionApi, message);

const bindResult = <DefaultResponse = RuntimeMessageResponse>(
    extensionApi: RuntimeMessageExtension | null | undefined
) => <Response = DefaultResponse>(message: unknown): Promise<RuntimeMessageResult<Response>> =>
        sendResult<Response>(extensionApi, message);

export const runtimeMessage = { send, sendResult, bind, bindResult };
