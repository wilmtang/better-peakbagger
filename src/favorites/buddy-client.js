// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ownerClimberId } from '../profile/profile-backup-core.js';
import { fetchPeakbaggerDocument, fetchPeakbaggerResource } from '../peakbagger/peakbagger-request.js';
import { BUDDY_MESSAGE } from './buddy-state.js';

const unsupported = () => { throw new Error('This buddy form is unavailable. Open the profile and try again.'); };
const hiddenNames = new Set(['__EVENTTARGET', '__EVENTARGUMENT', '__VIEWSTATE', '__VIEWSTATEGENERATOR',
    '__SCROLLPOSITIONX', '__SCROLLPOSITIONY', '__EVENTVALIDATION']);
export const readBuddyProfile = (result, { ownerCid, cid, origin }) => {
    if (result.kind !== 'ok') throw new Error(result.reason || "Couldn't check buddy status. Try again.");
    const url = new URL(result.url);
    const base = result.document.createElement('base'); base.href = result.url;
    result.document.querySelectorAll('base').forEach(node => node.remove());
    result.document.head.prepend(base);
    if (url.origin !== origin || !/^\/climber\/climber\.aspx$/i.test(url.pathname)
        || url.searchParams.getAll('cid').length !== 1 || Number(url.searchParams.get('cid')) !== cid
        || ownerClimberId(result.document) !== ownerCid) throw new Error('Your account changed. Sign in and check buddy status.');
    const doc = result.document, form = doc.getElementById('Form1');
    if (!form || form.tagName !== 'FORM' || form.getAttribute('method')?.toLowerCase() !== 'post'
        || !['', 'application/x-www-form-urlencoded'].includes(form.getAttribute('enctype') || '')) unsupported();
    const destination = new URL(form.getAttribute('action'), result.url);
    if (destination.href !== url.href) unsupported();
    const adds = doc.querySelectorAll('#AddBuddy'), removes = doc.querySelectorAll('#RemoveBuddy');
    if (adds.length + removes.length !== 1) unsupported();
    const buddy = removes.length === 1, control = buddy ? removes[0] : adds[0];
    const id = buddy ? 'RemoveBuddy' : 'AddBuddy';
    const value = buddy ? 'Remove from your Buddy List' : 'Add to your Buddy List';
    const label = buddy ? 'This Climber is one of your buddies.' : 'Add this Climber as a Buddy';
    if (control.form !== form || control.tagName !== 'INPUT' || control.type !== 'submit'
        || control.name !== id || control.value !== value || control.disabled
        || control.hasAttribute('formaction') || control.hasAttribute('formmethod')
        || doc.getElementById('BuddyLabel')?.textContent.trim() !== label) unsupported();
    const body = new URLSearchParams();
    for (const field of form.querySelectorAll('input[type="hidden"]')) {
        if (!hiddenNames.has(field.name) || body.has(field.name) || field.disabled) unsupported();
        body.append(field.name, field.value);
    }
    if (!body.get('__VIEWSTATE') || !body.get('__EVENTVALIDATION')) unsupported();
    body.set('__EVENTTARGET', ''); body.set('__EVENTARGUMENT', '');
    body.append(id, value);
    return { buddy, body, url: destination.href };
};

// Only a trusted, explicit action calls this adapter. A status check never
// sends another POST, including after a timeout, tab closure or worker restart.
export const changeBuddy = async ({ api, target, ownerCid, action, origin,
    currentOwner, checkOnly = false, fetchDocument = fetchPeakbaggerDocument,
    fetchResource = fetchPeakbaggerResource }) => {
    const send = async data => {
        const result = await api.runtime.sendMessage({ type: BUDDY_MESSAGE, ...data });
        if (!result?.ok) throw new Error(result?.error?.message || 'Buddy change could not be saved. Try again.');
        return result;
    };
    const lease = await send({ phase: 'begin', cid: target.cid, name: target.name, ownerCid, action, checkOnly });
    const identity = { ownerCid, cid: target.cid, origin };
    const url = new URL(`/climber/climber.aspx?cid=${target.cid}`, origin).href;
    let dispatched = lease.checkOnly;
    let uncertainPost = false;
    const check = async () => {
        const result = await fetchDocument(url, { kind: 'html' });
        if (currentOwner() !== ownerCid) throw new Error('Your account changed. Sign in and check buddy status.');
        return readBuddyProfile(result, identity);
    };
    try {
        const before = await check();
        if (!lease.checkOnly && before.buddy !== (action === 'add')) {
            await send({ phase: 'dispatch', token: lease.token });
            dispatched = true;
            if (currentOwner() !== ownerCid) throw new Error('Your account changed. Sign in and check buddy status.');
            // Full postback, not an ASP.NET partial update. Its body is bounded
            // and classified but never executed or used as proof of success.
            const post = await fetchResource(before.url, { kind: 'html', init: {
                redirect: 'error',
                method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: before.body.toString(),
            } });
            uncertainPost = post.kind !== 'ok';
        }
        const after = dispatched && !lease.checkOnly ? await check() : before;
        if (uncertainPost && after.buddy !== (action === 'add')) {
            throw new Error('Peakbagger has not confirmed the requested change.');
        }
        const saved = await send({ phase: 'complete', token: lease.token, buddy: after.buddy });
        return { buddy: after.buddy, warning: saved.warning || (after.buddy !== (action === 'add') && !lease.checkOnly
            ? 'Peakbagger did not save the buddy change. Try again.' : '') };
    } catch (error) {
        await send({ phase: 'failed', token: lease.token, dispatched }).catch(() => {});
        if (dispatched) throw new Error(`Buddy change not confirmed. Check status. ${error.message}`);
        throw error;
    }
};

export const applyBuddyProfileState = (doc, buddy) => {
    const control = doc.querySelector('#AddBuddy, #RemoveBuddy');
    if (!control) return;
    control.id = control.name = buddy ? 'RemoveBuddy' : 'AddBuddy';
    control.value = buddy ? 'Remove from your Buddy List' : 'Add to your Buddy List';
    const label = doc.getElementById('BuddyLabel');
    if (label) label.textContent = buddy ? 'This Climber is one of your buddies.' : 'Add this Climber as a Buddy';
};
