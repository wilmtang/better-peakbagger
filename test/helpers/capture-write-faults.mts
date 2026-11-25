// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// One-shot storage failures shared by provider capture and local-GPX harnesses.
export interface CaptureWriteFaults {
    payloadSet?: string;
    draftSet?: string;
    draftSetAt?: number | null;
    draftSetAtMessage?: string;
    openedJobSet?: string;
    payloadMetadataSet?: string;
    [fault: string]: unknown;
}

type Patch = Record<string, unknown> & { bpbDraftTabs?: unknown; bpbCaptureJobs?: Record<string, { phase?: string; payloadKey?: string } | null | undefined> };

export const createCaptureWriteFaults = (faults: CaptureWriteFaults) => {
    let draftSetCalls = 0;
    const fail = (key: string) => {
        const message = faults[key] as string;
        delete faults[key];
        throw new Error(message);
    };
    return (patch: Patch) => {
        if (Object.keys(patch).some(key => key.startsWith('bpbCapturePayload:'))
            && faults.payloadSet) fail('payloadSet');
        if (patch.bpbDraftTabs) {
            draftSetCalls++;
            if (faults.draftSet || faults.draftSetAt === draftSetCalls) {
                const message = faults.draftSet
                    || faults.draftSetAtMessage
                    || `draft write ${draftSetCalls} failed`;
                delete faults.draftSet;
                faults.draftSetAt = null;
                throw new Error(message);
            }
        }
        if (patch.bpbCaptureJobs
            && Object.values(patch.bpbCaptureJobs).some(job => job?.phase === 'opened')
            && faults.openedJobSet) fail('openedJobSet');
        if (patch.bpbCaptureJobs
            && Object.values(patch.bpbCaptureJobs).some(job => job?.payloadKey)
            && faults.payloadMetadataSet) fail('payloadMetadataSet');
    };
};
