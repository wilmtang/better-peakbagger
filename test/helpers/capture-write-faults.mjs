// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// One-shot storage failures shared by provider capture and local-GPX harnesses.
export const createCaptureWriteFaults = faults => {
    let draftSetCalls = 0;
    const fail = key => {
        const message = faults[key];
        delete faults[key];
        throw new Error(message);
    };
    return patch => {
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
