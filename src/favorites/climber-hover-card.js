// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { dom as D } from '../ui/dom.js';
import { settings as S } from '../settings/settings.js';
import { createPageLifecycle } from '../ui/page-lifecycle.js';
import { trustedAction } from '../ui/trusted-action.js';
import { fetchPeakbaggerDocument } from '../peakbagger/peakbagger-request.js';
import { peakbaggerError } from '../peakbagger/peakbagger-error.js';
import { ownerClimberId } from '../profile/profile-backup-core.js';
import { favoriteClimbers as F } from './favorite-climbers.js';
import { observeClimberMembership } from './climber-membership.js';
import { mutateIgnored } from './ignored-client.js';
import { climberCardTarget, climberCardState } from './climber-card-state.js';
import { changeBuddy, applyBuddyProfileState } from './buddy-client.js';

const OPEN_DELAY = 1000, FOCUS_DELAY = 350, CLOSE_DELAY = 200;
const EXCLUDED = 'nav, header, .mainmenu, .mainbanner, [contenteditable], textarea, [data-bpb-climber-ui], #bpb-report-editor';

const mount = () => {
    if (window !== window.top || document.getElementById('bpb-climber-card')) return;
    const records = new Map();
    let current = null, membership = null, settings = null, settingsError = '';
    let observer = null, unsubscribe = null, settingsGeneration = 0;
    let openTimer = null, closeTimer = null, positionFrame = null, mutationFrame = null;
    let hovered = null, suppressed = null, operation = null, readController = null;
    let error = '', notice = '', active = true, explicitOpen = false;
    let focusedRecord = null;
    const listen = (node, type, handler, options) => {
        node.addEventListener(type, handler, options);
        listeners.push(() => node.removeEventListener(type, handler, options));
    };
    const listeners = [];
    const button = (text, props = {}) => D.element('button', { type: 'button', text, 'data-bpb-climber-ui': '', ...props });
    const title = D.element('div', { id: 'bpb-climber-card-name', class: 'bpb-climber-card-name' });
    const profile = D.element('a', { text: 'View profile ↗', class: 'bpb-climber-card-profile' });
    const closeButton = button('×', { class: 'bpb-climber-card-close', 'aria-label': 'Close climber actions' });
    const buddy = button('Add climbing buddy', { id: 'bpb-climber-card-buddy', class: 'bpb-climber-card-action bpb-climber-card-buddy' });
    const signIn = D.element('a', { class: 'bpb-climber-card-action bpb-climber-card-buddy',
        text: 'Sign in to add a climbing buddy ↗', href: `${location.origin}/Default.aspx`, hidden: '' });
    const favorite = button('Add favorite climber', { id: 'bpb-climber-card-favorite', class: 'bpb-climber-card-action' });
    const sourceText = D.element('span', { text: 'Favorites follow your Buddy List.' });
    const sourceSettings = button('Use custom favorites…', { class: 'bpb-climber-card-settings' });
    const source = D.element('div', { class: 'bpb-climber-card-source' }, [sourceText, sourceSettings]);
    const ignore = button('Ignore climber', { id: 'bpb-climber-card-ignore', class: 'bpb-climber-card-action bpb-climber-card-ignore',
        'aria-describedby': 'bpb-climber-card-ignore-detail' });
    const detail = D.element('div', { id: 'bpb-climber-card-ignore-detail', class: 'bpb-climber-card-detail' });
    const feedback = D.element('div', { class: 'bpb-climber-card-feedback', id: 'bpb-climber-card-feedback' });
    const retry = button('Retry', { class: 'bpb-climber-card-retry', hidden: '' });
    const card = D.element('div', { id: 'bpb-climber-card', role: 'dialog', popover: 'manual', hidden: '',
        'data-bpb-climber-ui': '', 'aria-labelledby': title.id }, [
        D.element('div', { class: 'bpb-climber-card-heading' }, [D.element('div', {}, [title, profile]), closeButton]),
        buddy, signIn, favorite, source,
        D.element('div', { class: 'bpb-climber-card-ignore-section' }, [ignore, detail]), feedback, retry,
    ]);
    const announcement = D.element('div', { id: 'bpb-climber-card-announcement', role: 'status',
        'aria-live': 'polite', 'data-bpb-climber-ui': '' });
    document.body.append(card, announcement);

    const isVisible = node => node?.isConnected && !node.closest('[hidden], [inert], [aria-hidden="true"]')
        && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
    const targetFor = anchor => anchor?.matches?.('a[href]') && !anchor.closest(EXCLUDED)
        ? climberCardTarget(anchor.getAttribute('href'), anchor.textContent, document.baseURI) : null;
    const pageBuddy = cid => {
        const target = climberCardTarget(location.href, 'Viewed climber', document.baseURI);
        if (target?.cid !== cid) return { nativeBuddy: false, buddyPending: false };
        return {
            nativeBuddy: [...document.querySelectorAll(F.BUDDY_CONTROL_SELECTOR)]
                .some(control => !control.closest('[data-bpb-climber-ui]') && F.buddyControlAction(control) === 'remove'),
            buddyPending: !!document.querySelector('[data-bpb-buddy-pending="true"]')
                || document.getElementById('bpb-climber-favorite')?.getAttribute('aria-busy') === 'true',
        };
    };
    const viewState = () => climberCardState({ cid: current?.target.cid, ownerCid: ownerClimberId(document),
        settings: settingsError ? null : settings, membership, busy: !!operation, ...pageBuddy(current?.target.cid) });
    const paint = () => {
        if (!current || !active) return;
        const view = viewState();
        title.textContent = current.target.name;
        profile.href = current.target.url;
        const signedOut = ownerClimberId(document) == null;
        buddy.hidden = view.self || signedOut;
        signIn.hidden = view.self || !signedOut;
        buddy.textContent = operation?.kind === 'buddy' ? operation.checkOnly ? 'Checking…'
            : operation.removing ? 'Removing…' : 'Adding…' : view.buddyIntent && view.buddyIntent.status !== 'confirmed' ? 'Check buddy status'
            : view.buddy ? 'Remove climbing buddy' : 'Add climbing buddy';
        buddy.disabled = !!operation || (!view.buddyIntent && view.buddyBlocked);
        buddy.setAttribute('aria-busy', String(operation?.kind === 'buddy'));
        buddy.setAttribute('aria-pressed', String(view.buddy));
        favorite.hidden = view.self || view.custom !== true;
        favorite.textContent = operation?.kind === 'favorite' ? 'Saving…'
            : view.favorite ? 'Remove favorite climber' : 'Add favorite climber';
        favorite.disabled = view.favoriteDisabled;
        favorite.setAttribute('aria-pressed', String(view.favorite));
        favorite.setAttribute('aria-busy', String(operation?.kind === 'favorite'));
        source.hidden = view.self || view.custom !== false;
        ignore.parentElement.hidden = view.self;
        ignore.textContent = operation?.kind === 'ignore' ? 'Saving…' : view.ignored ? 'Unignore climber' : 'Ignore climber';
        ignore.disabled = view.ignoreDisabled;
        ignore.setAttribute('aria-pressed', String(view.ignored));
        ignore.setAttribute('aria-busy', String(operation?.kind === 'ignore'));
        detail.textContent = view.ignoreDetail;
        feedback.textContent = error || settingsError || view.note || (view.favoriteLimit
            ? 'Favorites can hold up to 1,500 climbers.' : notice);
        feedback.hidden = !feedback.textContent;
        retry.hidden = !(error || settingsError || membership?.error || view.buddyIntent?.status === 'confirmed');
        card.setAttribute('aria-busy', String(!!operation));
        schedulePosition();
    };
    const clearTimers = () => { clearTimeout(openTimer); clearTimeout(closeTimer); openTimer = closeTimer = null; };
    const rememberFocusContext = record => {
        const row = record.host.closest('tr, article, li') || record.host;
        const parent = row.parentElement;
        if (parent) record.focusContext = { row, parent, index: [...parent.children].indexOf(row) };
    };
    const replacementFocus = record => {
        const context = record.focusContext;
        if (!context) return null;
        const { row, parent } = context;
        const siblings = [...parent.children];
        const liveIndex = siblings.indexOf(row);
        const next = liveIndex < 0 ? context.index : liveIndex + 1;
        const controls = 'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex]';
        const eligible = node => node.tabIndex >= 0 && !record.host.contains(node)
            && !card.contains(node) && isVisible(node);
        for (const sibling of [...siblings.slice(next), ...siblings.slice(0, next).reverse()]) {
            const candidates = [...(sibling.matches(controls) ? [sibling] : []), ...sibling.querySelectorAll(controls)];
            const candidate = candidates.find(eligible);
            if (candidate) return candidate;
        }
        const scope = parent.isConnected ? parent : document.querySelector('main');
        const control = [...(scope?.querySelectorAll(controls) || [])].find(eligible);
        if (control) return control;
        if (isVisible(scope)) {
            if (!scope.hasAttribute('tabindex')) scope.tabIndex = -1;
            return scope;
        }
        return null;
    };
    const retireFocus = record => {
        const focused = card.contains(document.activeElement) && current === record
            || document.activeElement === record.trigger
            || (focusedRecord === record && document.activeElement === document.body);
        return focused ? replacementFocus(record) : null;
    };
    const close = ({ restore = false, suppress = false } = {}) => {
        clearTimers();
        if (!current) return;
        const old = current;
        const focused = card.contains(document.activeElement);
        if (suppress) suppressed = old;
        old.trigger.setAttribute('aria-expanded', 'false');
        try { if (card.matches(':popover-open')) card.hidePopover(); } catch { /* portal fallback */ }
        card.hidden = true; current = null; explicitOpen = false;
        document.body.append(card);
        if (focusedRecord === old) focusedRecord = null;
        if (restore && focused && isVisible(old.trigger)) old.trigger.focus({ preventScroll: true });
    };
    const position = () => {
        positionFrame = null;
        if (!current || card.hidden || !active) return;
        if (!isVisible(current.anchor) || !targetFor(current.anchor)) {
            const fallback = retireFocus(current);
            close();
            fallback?.focus({ preventScroll: true });
            return;
        }
        rememberFocusContext(current);
        const rect = current.anchor.getBoundingClientRect();
        const viewport = window.visualViewport;
        const leftEdge = viewport?.offsetLeft || 0, topEdge = viewport?.offsetTop || 0;
        const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
        if (rect.bottom < topEdge || rect.top > topEdge + height) { close({ restore: true }); return; }
        card.style.maxWidth = `${Math.max(0, width - 24)}px`;
        card.style.maxHeight = `${Math.max(0, height - 24)}px`;
        const size = card.getBoundingClientRect();
        const below = topEdge + height - rect.bottom - 8;
        const top = below >= size.height || rect.top - topEdge < size.height + 8
            ? Math.min(rect.bottom + 6, topEdge + height - size.height - 12) : rect.top - size.height - 6;
        card.style.left = `${Math.max(leftEdge + 12, Math.min(rect.left, leftEdge + width - size.width - 12))}px`;
        card.style.top = `${Math.max(topEdge + 12, top)}px`;
    };
    function schedulePosition() {
        if (positionFrame == null) positionFrame = requestAnimationFrame(position);
    }
    const open = (record, explicit = false) => {
        if (!active || !isVisible(record.anchor) || !targetFor(record.anchor)
            || (!explicit && suppressed === record) || (operation && operation.cid !== record.target.cid)) return;
        clearTimers();
        if (current !== record) {
            if (current && card.contains(document.activeElement) && !explicit) return;
            close(); current = record; error = ''; notice = '';
            rememberFocusContext(record);
            record.target = targetFor(record.anchor);
            record.host.append(card); // Natural keyboard order follows the actions trigger.
        }
        record.trigger.setAttribute('aria-expanded', 'true'); card.hidden = false;
        paint();
        try { if (!card.matches(':popover-open')) card.showPopover(); } catch { /* tested fixed-position portal fallback */ }
        position();
        if (explicit) {
            explicitOpen = true;
            suppressed = null;
            const first = [buddy, signIn, favorite, ignore, profile].find(control => !control.hidden
                && !control.disabled && control.getAttribute('aria-disabled') !== 'true');
            first?.focus({ preventScroll: true });
        }
    };
    const requestOpen = (record, delay = OPEN_DELAY) => {
        clearTimeout(openTimer); clearTimeout(closeTimer);
        if (suppressed !== record) openTimer = setTimeout(() => open(record), delay);
    };
    const requestClose = () => {
        clearTimeout(openTimer); clearTimeout(closeTimer);
        closeTimer = setTimeout(() => {
            if (!current || current === hovered || card.matches(':hover')
                || current.host.contains(document.activeElement) || operation) return;
            close();
        }, CLOSE_DELAY);
    };
    const removeRecord = record => {
        const fallback = retireFocus(record);
        if (current === record) close();
        if (hovered === record) hovered = null;
        if (suppressed === record) suppressed = null;
        record.trigger.remove();
        if (record.host.isConnected) {
            if (record.host.contains(record.anchor)) record.host.replaceWith(record.anchor);
            else record.host.remove();
        }
        records.delete(record.anchor);
        if (focusedRecord === record) focusedRecord = null;
        fallback?.focus({ preventScroll: true });
    };
    const decorate = root => {
        const anchors = root.matches?.('a[href]') ? [root] : [];
        anchors.push(...(root.querySelectorAll?.('a[href]') || []));
        for (const anchor of anchors) {
            if (records.has(anchor) || !targetFor(anchor) || !isVisible(anchor)) continue;
            const target = targetFor(anchor);
            const trigger = button('⋯', { class: 'bpb-climber-actions-trigger',
                'aria-label': `Climber actions for ${target.name}`, 'aria-haspopup': 'dialog',
                'aria-expanded': 'false', 'aria-controls': card.id, 'data-bpb-climber-ui': '' });
            const host = D.element('span', { class: 'bpb-climber-link' });
            anchor.replaceWith(host); host.append(anchor, trigger);
            const record = { anchor, target, trigger, host };
            records.set(anchor, record);
            trigger.addEventListener('click', event => {
                if (event.isTrusted !== true) return;
                if (current === record && explicitOpen && !card.hidden) close({ restore: true, suppress: true });
                else open(record, true);
            });
        }
    };
    const recordAt = node => {
        const anchor = node?.closest?.('a[href]');
        if (anchor && !records.has(anchor)) decorate(anchor);
        const trigger = node?.closest?.('.bpb-climber-actions-trigger');
        return records.get(anchor) || records.get(trigger?.previousElementSibling);
    };
    const refreshSettings = async () => {
        const token = ++settingsGeneration;
        try {
            const config = await S.requireCurrent();
            if (active && token === settingsGeneration) { settings = config; settingsError = ''; paint(); }
        } catch {
            if (active && token === settingsGeneration) { settingsError = "Couldn't load your settings. Try again."; paint(); }
        }
    };
    const subscribe = () => {
        observer = observeClimberMembership(chrome, value => { if (active) { membership = value; paint(); } });
        unsubscribe = S.subscribe(value => { settingsGeneration++; settings = value; settingsError = ''; paint(); });
        void refreshSettings();
    };
    const stopReads = () => {
        settingsGeneration++; observer?.stop(); unsubscribe?.(); readController?.abort();
        observer = unsubscribe = null;
    };
    const mutate = async (kind, event) => {
        if (event.isTrusted !== true || !current || operation || !active) return;
        const view = viewState();
        if ((kind === 'favorite' && (view.custom !== true || view.favoriteDisabled))
            || (kind === 'ignore' && view.ignoreDisabled)) return;
        const target = { ...current.target }, owner = ownerClimberId(document);
        const removing = kind === 'favorite' ? view.favorite : view.ignored;
        operation = { kind, cid: target.cid }; error = ''; notice = ''; paint();
        try {
            // A saved absence is not proof of current server absence. Only an
            // explicit Ignore addition reads the signed-in Buddy List.
            if (kind === 'ignore' && !removing && owner != null) {
                readController = new AbortController();
                const result = await fetchPeakbaggerDocument(F.buddyListUrl(owner, location.origin),
                    { kind: 'buddies', signal: readController.signal });
                if (active && result.kind !== 'ok') throw peakbaggerError.exception(result.error);
                if (!active || ownerClimberId(document) !== owner
                    || ownerClimberId(result.document) !== owner) throw new Error("Couldn't verify your Buddy List. Try again.");
                const entries = F.parseBuddyDocument(result.document);
                await chrome.storage.local.set({ [F.BUDDY_CACHE_KEY]: { ownerCid: owner, entries, fetchedAt: Date.now() } });
                if (entries.some(entry => entry.cid === target.cid)) throw new Error('Remove from your Buddy List before ignoring.');
            }
            if (!active || ownerClimberId(document) !== owner) throw new Error('Your account changed. Review the climber and try again.');
            const mutation = removing ? { kind: 'remove', cid: target.cid } : {
                kind: 'add', entry: { cid: target.cid, name: target.name, addedAt: Date.now(),
                    ...(kind === 'favorite' ? { source: 'manual' } : {}) },
            };
            if (kind === 'favorite') {
                const response = await chrome.runtime.sendMessage({ type: F.MUTATION_MESSAGE_TYPE, mutation });
                if (!response?.ok) throw new Error(response?.error?.message || 'Favorites could not be saved. Try again.');
            } else await mutateIgnored(chrome, mutation);
            notice = kind === 'favorite' ? `${target.name} ${removing ? 'removed from' : 'added to'} favorites.`
                : `${target.name}'s reports are ${removing ? 'visible again' : 'now hidden'}.`;
            announcement.textContent = notice;
            await observer?.refresh();
        } catch (failure) {
            const message = failure.message || 'This change could not be saved. Try again.';
            announcement.textContent = message;
            if (current?.target.cid === target.cid) error = message;
        } finally {
            readController = null; operation = null;
            if (current?.target.cid === target.cid) paint();
        }
    };
    listen(favorite, 'click', event => { void mutate('favorite', event); });
    listen(ignore, 'click', event => { void mutate('ignore', event); });
    const mutateBuddy = async (event, checkOnly = false) => {
        if (event.isTrusted !== true || !current || operation || !active || buddy.disabled) return;
        const view = viewState(), target = { ...current.target }, owner = ownerClimberId(document);
        if (owner == null || view.self) return;
        checkOnly ||= !!view.buddyIntent && view.buddyIntent.status !== 'confirmed';
        operation = { kind: 'buddy', cid: target.cid, removing: view.buddy, checkOnly };
        error = notice = ''; paint();
        try {
            const result = await changeBuddy({ api: chrome, target, ownerCid: owner, origin: location.origin,
                currentOwner: () => ownerClimberId(document), action: view.buddy ? 'remove' : 'add', checkOnly });
            // The native profile DOM may still reflect the old relationship.
            if (climberCardTarget(location.href, 'Viewed climber', document.baseURI)?.cid === target.cid) {
                applyBuddyProfileState(document, result.buddy);
            }
            notice = result.warning || `${target.name} ${result.buddy ? 'is now a climbing buddy' : 'is no longer a climbing buddy'}.`;
            announcement.textContent = notice;
            await observer?.refresh();
        } catch (failure) {
            announcement.textContent = failure.message;
            if (current?.target.cid === target.cid) error = failure.message;
            await observer?.refresh();
        } finally {
            operation = null;
            if (current?.target.cid === target.cid) paint();
        }
    };
    listen(buddy, 'click', event => { void mutateBuddy(event); });
    listen(sourceSettings, 'click', async event => {
        if (event.isTrusted !== true || !active) return;
        const generation = `climber-card-${Date.now()}`;
        const activation = await trustedAction.issue(chrome, event, 'beta-settings', generation);
        if (!activation) { error = 'Settings could not be opened. Try again.'; paint(); return; }
        const response = await chrome.runtime.sendMessage({ type: 'OPEN_BETA_SETTINGS', generation,
            activationToken: activation.token, disposition: 'foreground-tab' }).catch(() => null);
        if (!response?.ok) { error = 'Settings could not be opened. Try again.'; paint(); }
    });
    listen(retry, 'click', event => {
        if (event.isTrusted !== true || operation) return;
        if (viewState().buddyIntent) { void mutateBuddy(event, true); return; }
        error = ''; notice = ''; void observer?.refresh(); void refreshSettings(); paint();
    });
    listen(closeButton, 'click', () => close({ restore: true, suppress: true }));
    listen(document, 'pointerover', event => {
        if (!active || event.pointerType === 'touch') return;
        const record = recordAt(event.target);
        if (record && !record.host.contains(event.relatedTarget)) { hovered = record; requestOpen(record); }
        if (card.contains(event.target)) clearTimeout(closeTimer);
    });
    listen(document, 'pointerout', event => {
        const record = recordAt(event.target);
        if (record && !record.host.contains(event.relatedTarget)) {
            hovered = null;
            if (suppressed === record && !record.host.contains(document.activeElement)) suppressed = null;
            requestClose();
        }
        if (card.contains(event.target) && !card.contains(event.relatedTarget)) requestClose();
    });
    listen(document, 'focusin', event => {
        if (!active) return;
        focusedRecord = card.contains(event.target) ? current : recordAt(event.target);
        if (focusedRecord) rememberFocusContext(focusedRecord);
        if (card.contains(event.target)) return;
        const record = recordAt(event.target);
        if (record) requestOpen(record, FOCUS_DELAY);
    });
    listen(document, 'focusout', () => {
        queueMicrotask(() => {
            if (suppressed && !suppressed.host.contains(document.activeElement) && hovered !== suppressed) suppressed = null;
            if (current && !current.host.contains(document.activeElement)) requestClose();
        });
    });
    listen(document, 'keydown', event => {
        if (event.key === 'Escape' && current) { event.preventDefault(); close({ restore: true, suppress: true }); }
    });
    listen(document, 'pointerdown', event => {
        if (current && !current.host.contains(event.target)) close({ suppress: true });
    });
    listen(window, 'scroll', schedulePosition, true);
    listen(window, 'resize', schedulePosition);
    if (window.visualViewport) {
        listen(window.visualViewport, 'resize', schedulePosition);
        listen(window.visualViewport, 'scroll', schedulePosition);
    }
    const mutations = new MutationObserver(changes => {
        if (!active) return;
        const relevant = changes.filter(change => !change.target.closest?.('[data-bpb-climber-ui]'));
        if (!relevant.length) return;
        for (const change of relevant) {
            if (change.type === 'attributes') decorate(change.target);
            for (const node of change.addedNodes) {
                if (node.nodeType === 1 && !node.closest?.('[data-bpb-climber-ui]')) decorate(node);
            }
        }
        if (mutationFrame == null) mutationFrame = requestAnimationFrame(() => {
            mutationFrame = null;
            for (const record of records.values()) {
                if (!record.anchor.isConnected || !record.host.contains(record.anchor) || !targetFor(record.anchor)) {
                    removeRecord(record);
                    if (record.anchor.isConnected) decorate(record.anchor);
                }
                else {
                    const target = targetFor(record.anchor);
                    if (target.cid !== record.target.cid && current === record) close();
                    record.target = target;
                    record.trigger.setAttribute('aria-label', `Climber actions for ${target.name}`);
                    if (!isVisible(record.anchor) && focusedRecord === record) {
                        const fallback = retireFocus(record);
                        if (current === record) close();
                        fallback?.focus({ preventScroll: true });
                    }
                }
            }
            if (current) paint();
        });
    });
    const watch = () => mutations.observe(document.body, { subtree: true, childList: true,
        attributes: true, attributeFilter: ['href', 'hidden', 'style', 'class', 'value', 'data-bpb-buddy-pending', 'aria-busy'] });
    const suspend = () => {
        active = false; close(); clearTimers(); stopReads(); mutations.disconnect();
        cancelAnimationFrame(positionFrame); cancelAnimationFrame(mutationFrame); positionFrame = mutationFrame = null;
    };
    createPageLifecycle({ onSuspend: suspend, onResume: () => {
        active = true; membership = settings = null; suppressed = null; subscribe(); decorate(document.body); watch();
    }, onDispose: () => {
        suspend(); listeners.forEach(remove => remove());
        for (const record of records.values()) removeRecord(record);
        card.remove(); announcement.remove();
    } });
    decorate(document.body); subscribe(); watch();
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
