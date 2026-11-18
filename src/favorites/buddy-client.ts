// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ownerClimberId } from '../profile/profile-backup-core.ts';
import {
    fetchPeakbaggerDocument,
    fetchPeakbaggerResource,
    type FetchPeakbaggerDocumentOptions,
    type FetchPeakbaggerResourceOptions,
} from '../peakbagger/peakbagger-request.ts';
import { peakbaggerError, type PeakbaggerErrorLike } from '../peakbagger/peakbagger-error.ts';
import { BUDDY_MESSAGE, type BuddyAction } from './buddy-state.ts';
import { climberProfileLists, type ClimberProfileLists } from './climber-card-state.ts';

export type BuddyProfileResult =
    | { kind: 'ok'; url: string; document: Document }
    | { kind: string; reason?: string; url?: string; document?: Document };

export type BuddyResourceResult =
    | { kind: 'ok'; error?: PeakbaggerErrorLike | null }
    | { kind: string; error?: PeakbaggerErrorLike | null };

export interface BuddyProfileIdentity {
    ownerCid: number;
    cid: number;
    origin: string;
}

export interface BuddyProfileReadResult {
    buddy: boolean;
    body: URLSearchParams;
    url: string;
    lists: ClimberProfileLists;
}

export type BuddyClientMessagePayload =
    | { phase: 'begin'; cid: number; name: string; ownerCid: number; action: BuddyAction; checkOnly: boolean }
    | { phase: 'dispatch'; token?: string }
    | { phase: 'complete'; token?: string; buddy: boolean }
    | { phase: 'failed'; token?: string; dispatched: boolean };

export type BuddyClientMessage = { type: typeof BUDDY_MESSAGE } & BuddyClientMessagePayload;

export interface BuddyClientRuntimeApi {
    runtime: {
        sendMessage(message: BuddyClientMessage): Promise<unknown>;
    };
}

export interface ChangeBuddyOptions {
    api: BuddyClientRuntimeApi;
    target: { cid: number; name: string };
    ownerCid: number;
    action: BuddyAction;
    origin: string;
    currentOwner: () => number | null;
    checkOnly?: boolean;
    fetchDocument?: (url: string, options?: FetchPeakbaggerDocumentOptions) => Promise<BuddyProfileResult>;
    fetchResource?: (url: string, options?: FetchPeakbaggerResourceOptions) => Promise<BuddyResourceResult>;
}

export interface ChangeBuddyResult {
    buddy: boolean;
    lists: ClimberProfileLists;
    warning: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

function unsupported(): never { throw new Error('This buddy form is unavailable. Open the profile and try again.'); }
const hiddenNames = new Set(['__EVENTTARGET', '__EVENTARGUMENT', '__VIEWSTATE', '__VIEWSTATEGENERATOR',
    '__SCROLLPOSITIONX', '__SCROLLPOSITIONY', '__EVENTVALIDATION']);

export const readBuddyProfile = (
    result: BuddyProfileResult,
    { ownerCid, cid, origin }: BuddyProfileIdentity,
): BuddyProfileReadResult => {
    if (result.kind !== 'ok' || !result.document || !result.url) {
        throw new Error(('reason' in result ? result.reason : undefined) || "Couldn't check buddy status. Try again.");
    }
    const resultUrl = result.url;
    const doc = result.document;
    const url = new URL(resultUrl);
    const base = doc.createElement('base'); base.href = resultUrl;
    doc.querySelectorAll('base').forEach(node => node.remove());
    doc.head.prepend(base);
    if (url.origin !== origin || !/^\/climber\/climber\.aspx$/i.test(url.pathname)
        || url.searchParams.getAll('cid').length !== 1 || Number(url.searchParams.get('cid')) !== cid
        || ownerClimberId(doc) !== ownerCid) throw new Error('Your account changed. Sign in and check buddy status.');
    const form = doc.getElementById('Form1');
    if (!form || form.tagName !== 'FORM' || form.getAttribute('method')?.toLowerCase() !== 'post'
        || !['', 'application/x-www-form-urlencoded'].includes(form.getAttribute('enctype') || '')) unsupported();
    const formAction = form.getAttribute('action');
    if (formAction === null) unsupported();
    const destination = new URL(formAction, resultUrl);
    if (destination.href !== url.href) unsupported();
    const adds = doc.querySelectorAll('#AddBuddy');
    const removes = doc.querySelectorAll('#RemoveBuddy');
    if (adds.length + removes.length !== 1) unsupported();
    const buddy = removes.length === 1;
    const control = (buddy ? removes[0] : adds[0]) as HTMLInputElement | undefined;
    const id = buddy ? 'RemoveBuddy' : 'AddBuddy';
    const value = buddy ? 'Remove from your Buddy List' : 'Add to your Buddy List';
    const label = buddy ? 'This Climber is one of your buddies.' : 'Add this Climber as a Buddy';
    if (!control || control.form !== form || control.tagName !== 'INPUT' || control.type !== 'submit'
        || control.name !== id || control.value !== value || control.disabled
        || control.hasAttribute('formaction') || control.hasAttribute('formmethod')
        || doc.getElementById('BuddyLabel')?.textContent?.trim() !== label) unsupported();
    const body = new URLSearchParams();
    for (const field of form.querySelectorAll<HTMLInputElement>('input[type="hidden"]')) {
        if (!hiddenNames.has(field.name) || body.has(field.name) || field.disabled) unsupported();
        body.append(field.name, field.value);
    }
    if (!body.get('__VIEWSTATE') || !body.get('__EVENTVALIDATION')) unsupported();
    body.set('__EVENTTARGET', ''); body.set('__EVENTARGUMENT', '');
    body.append(id, value);
    return { buddy, body, url: destination.href, lists: climberProfileLists(doc, url.href, cid) };
};

// Only a trusted, explicit action calls this adapter. A status check never
// sends another POST, including after a timeout, tab closure or worker restart.
export const changeBuddy = async ({
    api,
    target,
    ownerCid,
    action,
    origin,
    currentOwner,
    checkOnly = false,
    fetchDocument = fetchPeakbaggerDocument,
    fetchResource = fetchPeakbaggerResource,
}: ChangeBuddyOptions): Promise<ChangeBuddyResult> => {
    const send = async (data: BuddyClientMessagePayload): Promise<Record<string, unknown>> => {
        const result = await api.runtime.sendMessage({ type: BUDDY_MESSAGE, ...data });
        if (!isRecord(result) || !result.ok) {
            const errorObj = isRecord(result) && isRecord(result.error) ? result.error : null;
            const message = typeof errorObj?.message === 'string' ? errorObj.message : '';
            throw new Error(message || 'Buddy change could not be saved. Try again.');
        }
        return result;
    };
    const lease = await send({ phase: 'begin', cid: target.cid, name: target.name, ownerCid, action, checkOnly });
    const leaseCheckOnly = Boolean(lease.checkOnly);
    const leaseToken = typeof lease.token === 'string' ? lease.token : undefined;
    const identity: BuddyProfileIdentity = { ownerCid, cid: target.cid, origin };
    const url = new URL(`/climber/climber.aspx?cid=${target.cid}`, origin).href;
    let dispatched = leaseCheckOnly;
    let uncertainPost = false;
    const check = async (): Promise<BuddyProfileReadResult> => {
        const result = await fetchDocument(url, { kind: 'html' });
        if (currentOwner() !== ownerCid) throw new Error('Your account changed. Sign in and check buddy status.');
        return readBuddyProfile(result, identity);
    };
    try {
        const before = await check();
        if (!leaseCheckOnly && before.buddy !== (action === 'add')) {
            await send({ phase: 'dispatch', token: leaseToken });
            dispatched = true;
            if (currentOwner() !== ownerCid) throw new Error('Your account changed. Sign in and check buddy status.');
            // Full postback, not an ASP.NET partial update. Its body is bounded
            // and classified but never executed or used as proof of success.
            const post = await fetchResource(before.url, { kind: 'html', init: {
                redirect: 'error',
                method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: before.body.toString(),
            } });
            uncertainPost = post.kind !== 'ok';
            const postError = 'error' in post ? post.error : undefined;
            if (postError?.code === 'rate-limit') throw peakbaggerError.exception(postError);
        }
        const after = dispatched && !leaseCheckOnly ? await check() : before;
        if (uncertainPost && after.buddy !== (action === 'add')) {
            throw new Error('Peakbagger has not confirmed the requested change.');
        }
        const saved = await send({ phase: 'complete', token: leaseToken, buddy: after.buddy });
        const savedWarning = typeof saved.warning === 'string' ? saved.warning : '';
        return {
            buddy: after.buddy,
            lists: after.lists,
            warning: savedWarning || (after.buddy !== (action === 'add') && !leaseCheckOnly
                ? 'Peakbagger did not save the buddy change. Try again.' : ''),
        };
    } catch (error) {
        await send({ phase: 'failed', token: leaseToken, dispatched }).catch(() => {});
        const message = error instanceof Error
            ? error.message
            : isRecord(error) && typeof error.message === 'string'
                ? error.message
                : String(error ?? '');
        if (dispatched) throw new Error(`Buddy change not confirmed. Check status. ${message}`);
        throw error;
    }
};

export const applyBuddyProfileState = (doc: Document, buddy: boolean): void => {
    const control = doc.querySelector<HTMLInputElement>('#AddBuddy, #RemoveBuddy');
    if (!control) return;
    control.id = control.name = buddy ? 'RemoveBuddy' : 'AddBuddy';
    control.value = buddy ? 'Remove from your Buddy List' : 'Add to your Buddy List';
    const label = doc.getElementById('BuddyLabel');
    if (label) label.textContent = buddy ? 'This Climber is one of your buddies.' : 'Add this Climber as a Buddy';
};
