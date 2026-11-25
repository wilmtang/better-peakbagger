// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Fills a prepared Peakbagger ascent editor and submits each acknowledged
// Preview once. A failed Preview can be retried explicitly; Save stays manual.

import { matchLabel, matchTone } from '../capture/match-confidence.ts';
import { MAX_UPLOAD_POINTS, MAX_TRACK_SEGMENTS } from '../capture/upload-limits.ts';
import { units as Units } from '../ui/units.ts';
import { pageLifecycle as PageLifecycle } from '../ui/page-lifecycle.ts';

interface DraftBroadcastMessage {
    type?: string;
}

interface DraftExtensionApi {
    runtime: {
        sendMessage(message: unknown): Promise<unknown>;
        onMessage?: {
            addListener(listener: (message: DraftBroadcastMessage | null | undefined) => void): void;
        };
    };
}

type SaveControl = HTMLInputElement | HTMLButtonElement;

interface SavedControlState {
    disabled: boolean;
    title: string | null;
}

type FormControlElement = Element & { value?: string };

type ControlState =
    | { kind: 'files'; files: File[] }
    | { kind: 'checked'; checked: boolean }
    | { kind: 'value'; value: string | undefined };

interface ApplyTransaction {
    token: string | undefined;
    connectionGeneration: number;
    originals: Map<FormControlElement, ControlState>;
    owned: Map<FormControlElement, ControlState>;
    cancelled: boolean;
    rolledBack: boolean;
}

interface PageIds {
    pid: string | null;
    cid: string | null;
}

interface ShowBannerOptions {
    actionLabel?: string;
    onAction?: (() => unknown) | null;
    persistent?: boolean;
}

interface DurationFields {
    days: number | null;
    hours: number | null;
    minutes: number | null;
}

interface DayStatRow {
    date: string | null;
    gainM: number | null;
    lossM: number | null;
    distanceM: number | null;
    maxElevationM: number | null;
    campElevationM: number | null;
}

interface TripInfoFields {
    id?: string | number | null;
    sequence: string | number;
    name: string;
    nightsOut: number | null;
}

interface DraftFormFields {
    date?: string | null;
    suffix?: string | null;
    externalUrl?: string | null;
    fillAscentDetails?: boolean;
    startElevationM: number | null;
    endElevationM: number | null;
    upDistanceM: number | null;
    downDistanceM: number | null;
    upDuration: DurationFields | null;
    downDuration: DurationFields | null;
    upGainM: number | null;
    downGainM: number | null;
    dayStats?: DayStatRow[] | null;
    tripInfo?: TripInfoFields | null;
    wildernessNightsOut?: string | number | null;
}

interface DraftBaseMetadata {
    jobId?: string;
    pid?: string;
    cid?: string;
    peakName?: unknown;
    classification?: unknown;
    confidence?: number;
    applyLeaseToken?: string;
}

interface DraftApplyResponse extends DraftBaseMetadata {
    action: 'apply';
    fields: DraftFormFields;
    preserveExistingFields?: boolean;
    gpx: unknown;
    allowWaypoints: boolean;
}

interface DraftBannerResponse extends DraftBaseMetadata {
    action: 'banner';
    dayStatsPending?: boolean;
    dayStats?: DayStatRow[] | null;
}

interface DraftWaitResponse {
    action: 'wait';
    message?: string;
    retryAt?: number;
}

interface DraftPreviewErrorResponse {
    action: 'preview-error';
    message?: string;
}

interface DraftErrorResponse {
    action: 'error';
    message?: string;
}

interface DraftIgnoreResponse {
    action: 'ignore';
}

type DraftReadyResponse =
    | DraftApplyResponse
    | DraftBannerResponse
    | DraftWaitResponse
    | DraftPreviewErrorResponse
    | DraftErrorResponse
    | DraftIgnoreResponse;

(() => {
    'use strict';

    const ext = (globalThis as { browser?: DraftExtensionApi; chrome?: DraftExtensionApi }).browser
        || (globalThis as { chrome?: DraftExtensionApi }).chrome;
    if (!ext) return;

    const { FEET_PER_METER, METERS_PER_MILE } = Units;
    const BANNER_ID = 'bpb-draft-banner';
    const BANNER_DISMISS_MS = 4000;
    const documentToken = crypto.randomUUID();
    let leaseRetryTimer: ReturnType<typeof setTimeout> | null = null;
    const clearLeaseRetry = () => {
        if (leaseRetryTimer !== null) clearTimeout(leaseRetryTimer);
        leaseRetryTimer = null;
    };
    const SAVE_BUTTON_IDS = new Set(['SaveButton', 'SaveButton2']);
    const DRAFT_FAILURES = Object.freeze({
        'form-unavailable': 'Peakbagger’s ascent form has changed or did not load completely.',
        'privacy-check': 'The prepared upload failed its privacy check.',
        'preview-conflict': 'Preview was already started or the draft identity changed.',
        'trip-unavailable': 'The shared trip is missing from this form. Reload this summit tab before continuing.',
        'trip-form-unavailable': 'Peakbagger’s Trip Info did not load completely. Reload this ascent form before continuing.',
    });
    type DraftFailureCode = keyof typeof DRAFT_FAILURES;
    interface DraftError extends Error {
        code: DraftFailureCode;
    }
    const draftError = (code: DraftFailureCode): DraftError => Object.assign(new Error(DRAFT_FAILURES[code]), { code });
    let draftConnectionGeneration = 0;
    let activeApply: ApplyTransaction | null = null;
    let blockedSaveMessage = '';
    let saveControlObserver: MutationObserver | null = null;
    const blockedSaveControls = new Map<SaveControl, SavedControlState>();

    const blockSaveControls = () => {
        for (const id of SAVE_BUTTON_IDS) {
            const control = document.getElementById(id) as SaveControl | null;
            if (!control) continue;
            if (!blockedSaveControls.has(control)) {
                blockedSaveControls.set(control, { disabled: control.disabled, title: control.getAttribute('title') });
            }
            control.disabled = true;
            control.title = blockedSaveMessage;
            control.classList.add('bpb-draft-save-blocked');
        }
    };

    const setSaveBlocked = (message: string) => {
        const previousMessage = blockedSaveMessage;
        blockedSaveMessage = message || '';
        if (blockedSaveMessage) {
            blockSaveControls();
            if (!saveControlObserver && document.body) {
                saveControlObserver = new MutationObserver(blockSaveControls);
                saveControlObserver.observe(document.body, { childList: true, subtree: true });
            }
        } else {
            saveControlObserver?.disconnect();
            saveControlObserver = null;
            for (const [control, original] of blockedSaveControls) {
                control.disabled = original.disabled;
                control.classList.remove('bpb-draft-save-blocked');
                if (control.title !== previousMessage) continue;
                if (original.title === null) control.removeAttribute('title');
                else control.title = original.title;
            }
            blockedSaveControls.clear();
        }
    };

    // A queued form has neither its suffix nor its shared trip yet. Guard
    // implicit Enter submits and native postback clicks as well as disabling
    // both Save buttons; Preview and Cancel remain available.
    const guardUnpreparedSave = (event: Event) => {
        if (!blockedSaveMessage) return;
        const target = event.target as Element | null;
        const submitter = (event as SubmitEvent).submitter;
        const buttonId = target?.closest?.('input, button')?.id;
        const saveClick = event.type === 'click' && !!buttonId && SAVE_BUTTON_IDS.has(buttonId);
        const saveSubmit = event.type === 'submit'
            && !!(event.target as Node | null)?.contains?.(document.getElementById('DateText'))
            && (!submitter || SAVE_BUTTON_IDS.has(submitter.id));
        if (!saveClick && !saveSubmit) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        showBanner('waiting', blockedSaveMessage, { persistent: true });
    };
    document.addEventListener('click', guardUnpreparedSave, true);
    document.addEventListener('submit', guardUnpreparedSave, true);

    const controlState = (element: FormControlElement): ControlState => {
        if (element instanceof HTMLInputElement && element.type === 'file') {
            return { kind: 'files', files: [...(element.files || [])] };
        }
        if (element instanceof HTMLInputElement
            && (element.type === 'checkbox' || element.type === 'radio')) {
            return { kind: 'checked', checked: element.checked };
        }
        return { kind: 'value', value: element.value };
    };

    const sameControlState = (left: ControlState | undefined, right: ControlState | undefined): boolean => {
        if (!left || !right || left.kind !== right.kind) return false;
        if (left.kind === 'files' && right.kind === 'files') {
            return left.files.length === right.files.length
                && left.files.every((file, index) => file === right.files[index]);
        }
        if (left.kind === 'checked' && right.kind === 'checked') return left.checked === right.checked;
        if (left.kind === 'value' && right.kind === 'value') return left.value === right.value;
        return false;
    };

    const restoreControl = (element: FormControlElement, state: ControlState) => {
        if (state.kind === 'files') {
            const transfer = new DataTransfer();
            state.files.forEach(file => transfer.items.add(file));
            (element as HTMLInputElement).files = transfer.files;
        } else if (state.kind === 'checked') {
            (element as HTMLInputElement).checked = state.checked;
        } else {
            element.value = state.value;
        }
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const beginApply = (payload: { applyLeaseToken?: string }): ApplyTransaction => {
        const form = (document.getElementById('Form1') || document.querySelector('form')) as HTMLFormElement | null;
        if (!form) throw draftError('form-unavailable');
        const transaction: ApplyTransaction = {
            token: payload.applyLeaseToken,
            connectionGeneration: draftConnectionGeneration,
            originals: new Map([...form.elements].map(element => [element as FormControlElement, controlState(element as FormControlElement)])),
            owned: new Map(),
            cancelled: false,
            rolledBack: false,
        };
        activeApply = transaction;
        return transaction;
    };

    const assertApplyActive = (transaction: ApplyTransaction | null | undefined) => {
        if (!transaction) return;
        if (activeApply !== transaction || transaction.cancelled
            || transaction.connectionGeneration !== draftConnectionGeneration) {
            throw draftError('preview-conflict');
        }
    };

    const recordApplyWrite = (transaction: ApplyTransaction | null | undefined, element: FormControlElement) => {
        if (!transaction) return;
        assertApplyActive(transaction);
        transaction.owned.set(element, controlState(element));
    };

    const rollbackApply = (transaction: ApplyTransaction | null | undefined) => {
        if (!transaction || transaction.rolledBack) return;
        transaction.rolledBack = true;
        for (const [element, owned] of transaction.owned) {
            const original = transaction.originals.get(element);
            if (original && sameControlState(controlState(element), owned)) {
                restoreControl(element, original);
            }
        }
        if (activeApply === transaction) activeApply = null;
    };

    const pageIds = (): PageIds => {
        const params = new URLSearchParams(location.search);
        return { pid: params.get('pid'), cid: params.get('cid') };
    };

    // Peakbagger's peak picker is often empty on a pid-bound new-ascent page.
    // Keep the already-validated match name beside the form as display-only
    // metadata so report autosave can label the ID-keyed local draft. Dataset
    // fields are not successful controls and therefore are never submitted.
    const rememberPeakName = (response: { peakName?: unknown } | null | undefined, ids: PageIds) => {
        const name = typeof response?.peakName === 'string'
            ? response.peakName.replace(/\s+/g, ' ').trim().slice(0, 200)
            : '';
        const form = (document.getElementById('Form1') || document.querySelector('form')) as HTMLElement | null;
        if (!name || !form || !ids.pid) return;
        form.dataset.bpbDraftPeakId = ids.pid;
        form.dataset.bpbDraftPeakName = name;
    };

    const showBanner = (kind: string, message: string, options: ShowBannerOptions = {}) => {
        const { actionLabel = '', onAction = null, persistent = false } = options;
        const existing = document.getElementById(BANNER_ID);
        if (kind === 'error' && actionLabel && existing?.classList.contains('bpb-draft-banner-error')
            && existing.querySelector('.bpb-draft-banner-action')?.textContent === actionLabel) {
            // Repeated failure notifications must not replace a focused
            // recovery action. Error banners persist and have no dismiss timer.
            existing.querySelector('.bpb-draft-banner-text')!.textContent = message;
            return;
        }
        if (existing) existing.remove();
        const banner = document.createElement('div');
        banner.id = BANNER_ID;
        banner.className = `bpb-draft-banner bpb-draft-banner-${kind}`;
        banner.setAttribute('role', kind === 'error' ? 'alert' : 'status');
        banner.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');

        const text = document.createElement('span');
        text.className = 'bpb-draft-banner-text';
        text.textContent = message;

        const dismissButton = document.createElement('button');
        dismissButton.type = 'button';
        dismissButton.setAttribute('aria-label', 'Dismiss notification');
        dismissButton.title = 'Dismiss';
        dismissButton.textContent = '\u00d7';
        dismissButton.className = 'bpb-draft-banner-dismiss';

        let dismissTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
        const dismiss = (immediate: boolean) => {
            if (dismissTimer !== null) globalThis.clearTimeout(dismissTimer);
            if (immediate) {
                banner.remove();
                return;
            }
            banner.classList.add('bpb-draft-banner-leaving');
            globalThis.setTimeout(() => banner.remove(), 160);
        };
        dismissButton.addEventListener('click', () => dismiss(true));
        banner.append(text);
        if (actionLabel && typeof onAction === 'function') {
            const actionButton = document.createElement('button');
            actionButton.type = 'button';
            actionButton.className = 'bpb-draft-banner-action';
            actionButton.textContent = actionLabel;
            actionButton.addEventListener('click', () => {
                actionButton.disabled = true;
                dismiss(true);
                void Promise.resolve().then(onAction);
            });
            banner.append(actionButton);
        }
        banner.append(dismissButton);
        (document.body || document.documentElement).prepend(banner);
        if (kind !== 'error' && !persistent) {
            banner.dataset.autoDismissMs = String(BANNER_DISMISS_MS);
            dismissTimer = globalThis.setTimeout(() => dismiss(false), BANNER_DISMISS_MS);
        }
    };

    const setField = async (
        id: string,
        value: number | null | undefined,
        digits = 0,
        transaction: ApplyTransaction | null = null,
    ): Promise<boolean> => {
        const element = document.getElementById(id) as HTMLInputElement | null;
        if (!element || value === null || value === undefined || !Number.isFinite(Number(value))) return false;
        assertApplyActive(transaction);
        const numeric = Number(value);
        element.value = digits ? numeric.toFixed(digits) : String(Math.round(numeric));
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        recordApplyWrite(transaction, element);
        await new Promise(resolve => setTimeout(resolve, 0));
        assertApplyActive(transaction);
        return true;
    };

    const setTextField = (
        id: string,
        value: string | null | undefined,
        transaction: ApplyTransaction | null = null,
    ): boolean => {
        const element = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
        if (!element) return false;
        assertApplyActive(transaction);
        element.value = value || '';
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        recordApplyWrite(transaction, element);
        return true;
    };

    const setFieldIfEmpty = async (
        id: string,
        value: number | null | undefined,
        digits = 0,
        transaction: ApplyTransaction | null = null,
    ): Promise<boolean> => {
        const element = document.getElementById(id) as HTMLInputElement | null;
        if (!element || String(element.value || '').trim()) return false;
        return setField(id, value, digits, transaction);
    };

    const setTextFieldIfEmpty = (
        id: string,
        value: string | null | undefined,
        { replaceAutofilled = false, transaction = null }: { replaceAutofilled?: boolean; transaction?: ApplyTransaction | null } = {},
    ): boolean => {
        const element = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
        if (!element) return false;
        const hasValue = !!String(element.value || '').trim();
        const mayReplaceGenerated = replaceAutofilled && element.dataset.bpbAutofilled === 'date';
        if (hasValue && !mayReplaceGenerated) return false;
        return setTextField(id, value, transaction);
    };

    const setSelectValue = (
        id: string,
        value: string | number,
        dispatchChange = true,
        transaction: ApplyTransaction | null = null,
    ): boolean => {
        const element = document.getElementById(id);
        if (!element || element.tagName !== 'SELECT') return false;
        const select = element as HTMLSelectElement;
        const stringValue = String(value);
        if (![...select.options].some(option => option.value === stringValue)) return false;
        assertApplyActive(transaction);
        select.value = stringValue;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        if (dispatchChange) select.dispatchEvent(new Event('change', { bubbles: true }));
        recordApplyWrite(transaction, select);
        return true;
    };

    const selectNewTrip = (transaction: ApplyTransaction | null): boolean => {
        const element = document.getElementById('TripDD');
        if (!element || element.tagName !== 'SELECT') return false;
        const select = element as HTMLSelectElement;
        const options = [...select.options].filter(candidate => /^\s*\*\*\s*Add New Trip\s*$/i.test(candidate.textContent || ''));
        const option = options.length === 1 ? options[0] : null;
        return option && !option.disabled && !(option.parentElement as HTMLOptGroupElement | null)?.disabled
            && [...select.options].filter(candidate => candidate.value === option.value).length === 1
            ? setSelectValue('TripDD', option.value, true, transaction)
                && select.selectedOptions.length === 1 && select.selectedOptions[0] === option : false;
    };

    const requireTripForm = (tripInfo: TripInfoFields) => {
        const trip = document.getElementById('TripDD') as HTMLSelectElement | null;
        const dateField = document.getElementById('DateText') as HTMLInputElement | null;
        const ids = tripInfo.id ? ['TripSeqText'] : ['TripSeqText', 'TripNameText', 'TripNightsText'];
        if (trip?.tagName !== 'SELECT' || trip.multiple || trip.matches(':disabled')
            || !trip.form || trip.form !== dateField?.form
            || ids.some(id => {
                const field = document.getElementById(id) as HTMLInputElement | null;
                return field?.tagName !== 'INPUT' || field.type !== 'text'
                    || field.readOnly || field.matches(':disabled') || field.form !== trip.form;
            })) throw draftError('trip-form-unavailable');
    };

    const setDuration = async (
        prefix: string,
        duration: DurationFields | null | undefined,
        preserveExistingFields = false,
        transaction: ApplyTransaction | null = null,
    ): Promise<void> => {
        if (!duration) return;
        const write = preserveExistingFields ? setFieldIfEmpty : setField;
        await write(`${prefix}Day`, duration.days, 0, transaction);
        await write(`${prefix}Hr`, duration.hours, 0, transaction);
        await write(`${prefix}Min`, duration.minutes, 0, transaction);
    };

    const tripInfoIsEmpty = (): boolean => {
        const trip = document.getElementById('TripDD') as HTMLSelectElement | null;
        const defaultTrip = !trip || !String(trip.value || '').trim() || String(trip.value) === '0';
        return defaultTrip && ['TripSeqText', 'TripNameText', 'TripNightsText']
            .every(id => !String((document.getElementById(id) as HTMLInputElement | null)?.value || '').trim());
    };

    const fillDayStats = async (
        dayStats: DayStatRow[] | null | undefined,
        transaction: ApplyTransaction | null = null,
    ): Promise<void> => {
        if (!Array.isArray(dayStats)) return;
        for (let index = 0; index < dayStats.length; index++) {
            const row = dayStats[index];
            const sequence = index + 1;
            setTextFieldIfEmpty(`Date${sequence}`, row.date, { transaction });
            await setFieldIfEmpty(`GainFt${sequence}`, row.gainM === null ? null : row.gainM * FEET_PER_METER, 0, transaction);
            await setFieldIfEmpty(`GainM${sequence}`, row.gainM, 0, transaction);
            await setFieldIfEmpty(`LossFt${sequence}`, row.lossM === null ? null : row.lossM * FEET_PER_METER, 0, transaction);
            await setFieldIfEmpty(`LossM${sequence}`, row.lossM, 0, transaction);
            await setFieldIfEmpty(`DistMi${sequence}`, row.distanceM === null
                ? null : row.distanceM / METERS_PER_MILE, 3, transaction);
            await setFieldIfEmpty(`DistKm${sequence}`, row.distanceM === null
                ? null : row.distanceM / 1000, 2, transaction);
            await setFieldIfEmpty(`MaxFt${sequence}`, row.maxElevationM === null
                ? null : row.maxElevationM * FEET_PER_METER, 0, transaction);
            await setFieldIfEmpty(`MaxM${sequence}`, row.maxElevationM, 0, transaction);
            await setFieldIfEmpty(`CampFt${sequence}`, row.campElevationM === null
                ? null : row.campElevationM * FEET_PER_METER, 0, transaction);
            await setFieldIfEmpty(`CampM${sequence}`, row.campElevationM, 0, transaction);
        }
    };

    const formIsReady = (): boolean => !!(
        document.getElementById('DateText')
        && document.getElementById('GPXUpload')
        && document.getElementById('GPXPreview')
    );

    const readPreviewResult = (): { state: 'unknown' | 'error' | 'success'; message: string } => {
        const message = (document.getElementById('GPXStatusLabel')?.textContent || '')
            .replace(/\s+/g, ' ').trim().slice(0, 200);
        if (!message) return { state: 'unknown', message: '' };
        if (/\b(?:no gps data|invalid|error|failed|failure|rejected|could not|unable|too many|only gpx)\b/i.test(message)) {
            return { state: 'error', message };
        }
        if (/\b(?:success|successful|successfully|accepted|uploaded|preview is ready)\b/i.test(message)) {
            return { state: 'success', message };
        }
        return { state: 'unknown', message };
    };

    // Capture opens fresh draft tabs and keeps its full-fill behavior. Local
    // GPX processing can reuse a form the user has already started, so that
    // path writes only blank controls (apart from our own generated date).
    const fillForm = async (
        fields: DraftFormFields,
        preserveExistingFields = false,
        transaction: ApplyTransaction | null = null,
    ): Promise<void> => {
        if (!formIsReady()) throw draftError('form-unavailable');
        assertApplyActive(transaction);
        const fillTripInfo = fields.tripInfo && (!preserveExistingFields || tripInfoIsEmpty());
        if (fillTripInfo) requireTripForm(fields.tripInfo!);
        // A timeless GPX derives no date; keep whatever the field already
        // holds (typically the fresh-form today autofill) instead of clearing.
        if (fields.date) {
            if (preserveExistingFields) {
                setTextFieldIfEmpty('DateText', fields.date, {
                    replaceAutofilled: true,
                    transaction,
                });
            } else {
                setTextField('DateText', fields.date, transaction);
            }
        }
        const writeText = (id: string, value: string | null | undefined) => preserveExistingFields
            ? setTextFieldIfEmpty(id, value, { transaction })
            : setTextField(id, value, transaction);
        const writeNumber = preserveExistingFields ? setFieldIfEmpty : setField;
        writeText('SuffixText', fields.suffix || '');
        // The captured activity link goes into the external-trip-report field
        // only when empty — a URL the user typed is never clobbered.
        if (typeof fields.externalUrl === 'string' && fields.externalUrl) {
            setTextFieldIfEmpty('URLTB', fields.externalUrl, { transaction });
        }

        if (fields.fillAscentDetails !== false) {
            await writeNumber('StartFt', fields.startElevationM === null ? null : fields.startElevationM * FEET_PER_METER, 0, transaction);
            await writeNumber('StartM', fields.startElevationM, 0, transaction);
            await writeNumber('EndFt', fields.endElevationM === null ? null : fields.endElevationM * FEET_PER_METER, 0, transaction);
            await writeNumber('EndM', fields.endElevationM, 0, transaction);

            await writeNumber('UpMi', fields.upDistanceM === null
                ? null : fields.upDistanceM / METERS_PER_MILE, 2, transaction);
            await writeNumber('UpKm', fields.upDistanceM === null
                ? null : fields.upDistanceM / 1000, 2, transaction);
            await writeNumber('DnMi', fields.downDistanceM === null
                ? null : fields.downDistanceM / METERS_PER_MILE, 2, transaction);
            await writeNumber('DnKm', fields.downDistanceM === null
                ? null : fields.downDistanceM / 1000, 2, transaction);
            await setDuration('Up', fields.upDuration, preserveExistingFields, transaction);
            await setDuration('Dn', fields.downDuration, preserveExistingFields, transaction);

            const gainFt = Number.parseFloat((document.getElementById('GainFt') as HTMLInputElement | null)?.value ?? '');
            const gainM = Number.parseFloat((document.getElementById('GainM') as HTMLInputElement | null)?.value ?? '');
            if (Number.isFinite(gainFt) && typeof fields.upGainM === 'number' && Number.isFinite(fields.upGainM)) {
                await writeNumber('ExUpFt', Math.max(0, fields.upGainM * FEET_PER_METER - gainFt), 0, transaction);
            }
            if (Number.isFinite(gainM) && typeof fields.upGainM === 'number' && Number.isFinite(fields.upGainM)) {
                await writeNumber('ExUpM', Math.max(0, fields.upGainM - gainM), 0, transaction);
            }
            await writeNumber('ExDnFt', fields.downGainM === null
                ? null : fields.downGainM * FEET_PER_METER, 0, transaction);
            await writeNumber('ExDnM', fields.downGainM, 0, transaction);
            await fillDayStats(fields.dayStats, transaction);
        }

        if (fillTripInfo) {
            const tripInfo = fields.tripInfo!;
            if (tripInfo.id) {
                const trip = document.getElementById('TripDD') as HTMLSelectElement;
                const options = [...trip.options].filter(option => option.value === String(tripInfo.id));
                if (options.length !== 1 || options[0].disabled || (options[0].parentElement as HTMLOptGroupElement | null)?.disabled) {
                    throw draftError('trip-unavailable');
                }
                if (!setSelectValue('TripDD', tripInfo.id, false, transaction)
                    || trip.value !== String(tripInfo.id)) throw draftError('trip-unavailable');
            } else if (!selectNewTrip(transaction)) {
                throw draftError('trip-form-unavailable');
            }
            if (!setTextField('TripSeqText', String(tripInfo.sequence), transaction)) {
                throw draftError('trip-form-unavailable');
            }
            if (!tripInfo.id) {
                if (!setTextField('TripNameText', tripInfo.name, transaction)
                    || !setTextField('TripNightsText', tripInfo.nightsOut === null ? '' : String(tripInfo.nightsOut), transaction)) {
                    throw draftError('trip-form-unavailable');
                }
            }
            requireTripForm(tripInfo);
        }

        if (fields.wildernessNightsOut !== null && fields.wildernessNightsOut !== undefined) {
            const existingNights = (document.getElementById('AscentNightsDD') as HTMLSelectElement | null)?.value;
            // AscentNightsDD has an inline AutoPostBack handler. Sending a
            // synthetic change here would reload before GPX Preview; its
            // selected value is still included in the Preview form post.
            if (!preserveExistingFields || !existingNights || String(existingNights) === '0') {
                setSelectValue('AscentNightsDD', fields.wildernessNightsOut, false, transaction);
            }
        }
        assertApplyActive(transaction);
    };

    const validatePrivateGpx = (gpx: unknown, allowWaypoints = false): gpx is string => {
        if (typeof gpx !== 'string' || !gpx) return false;
        const xml = new DOMParser().parseFromString(gpx, 'application/xml');
        if (xml.getElementsByTagName('parsererror').length) return false;
        const elements = [...xml.getElementsByTagName('*')];
        const allowed = new Set(['gpx', 'wpt', 'name', 'trk', 'trkseg', 'trkpt', 'ele', 'time']);
        if (elements.some(element => !allowed.has(element.localName))) return false;
        const points = elements.filter(element => element.localName === 'trkpt');
        const waypoints = elements.filter(element => element.localName === 'wpt');
        const names = elements.filter(element => element.localName === 'name');
        const elevations = elements.filter(element => element.localName === 'ele');
        const times = elements.filter(element => element.localName === 'time');
        const segments = elements.filter(element => element.localName === 'trkseg');
        if (!points.length || (!allowWaypoints && waypoints.length)
            || points.length + waypoints.length > MAX_UPLOAD_POINTS
            || segments.length > MAX_TRACK_SEGMENTS) return false;
        const validCoordinate = (point: Element): boolean => {
            if (!point.hasAttribute('lat') || !point.hasAttribute('lon')) return false;
            const attributes = [...point.attributes];
            if (attributes.some(attribute => attribute.name !== 'lat' && attribute.name !== 'lon')) return false;
            const latText = point.getAttribute('lat');
            const lonText = point.getAttribute('lon');
            if (!latText?.trim() || !lonText?.trim()) return false;
            const lat = Number(latText);
            const lon = Number(lonText);
            return Number.isFinite(lat) && lat >= -90 && lat <= 90
                && Number.isFinite(lon) && lon >= -180 && lon <= 180;
        };
        const validLeaf = (element: Element): boolean => element.attributes.length === 0
            && element.children.length === 0
            && !!(element.textContent || '').trim();
        const validTime = (element: Element): boolean => {
            if (!validLeaf(element)) return false;
            const value = (element.textContent || '').trim();
            const parsed = Date.parse(value);
            if (!Number.isFinite(parsed)) return false;
            const canonical = new Date(parsed).toISOString();
            return value === canonical || value === canonical.replace('.000Z', 'Z');
        };
        return points.every(point => validCoordinate(point)
                && [...point.children].every(child => child.localName === 'ele' || child.localName === 'time')
                && [...point.children].filter(child => child.localName === 'ele').length <= 1
                && [...point.children].filter(child => child.localName === 'time').length <= 1
                && [...point.childNodes].every(node => node.nodeType === 1 || !(node.textContent || '').trim()))
            && elevations.every(elevation => elevation.parentElement?.localName === 'trkpt'
                && validLeaf(elevation) && Number.isFinite(Number((elevation.textContent || '').trim())))
            && times.every(time => time.parentElement?.localName === 'trkpt' && validTime(time))
            && waypoints.every(waypoint => waypoint.parentElement?.localName === 'gpx'
                && validCoordinate(waypoint)
                && [...waypoint.children].every(child => child.localName === 'name')
                && [...waypoint.children].filter(child => child.localName === 'name').length <= 1
                && [...waypoint.childNodes].every(node => node.nodeType === 1 || !(node.textContent || '').trim()))
            && names.every(name => name.parentElement?.localName === 'wpt'
                && name.attributes.length === 0
                && name.children.length === 0
                && (name.textContent || '').length <= 200);
    };

    const attachGpx = (gpx: unknown, allowWaypoints: boolean, transaction: ApplyTransaction | null = null) => {
        if (!validatePrivateGpx(gpx, allowWaypoints)) throw draftError('privacy-check');
        assertApplyActive(transaction);
        const input = document.getElementById('GPXUpload') as HTMLInputElement;
        const transfer = new DataTransfer();
        transfer.items.add(new File([gpx], 'track.gpx', { type: 'application/gpx+xml' }));
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        recordApplyWrite(transaction, input);
    };

    const applyAndPreview = async (payload: DraftApplyResponse): Promise<void> => {
        if (typeof payload.applyLeaseToken !== 'string' || !payload.applyLeaseToken) {
            throw draftError('preview-conflict');
        }
        const transaction = beginApply(payload);
        try {
            await fillForm(payload.fields, payload.preserveExistingFields === true, transaction);
            attachGpx(payload.gpx, payload.allowWaypoints, transaction);
            assertApplyActive(transaction);
            const acknowledgment = await ext.runtime.sendMessage({
                type: 'DRAFT_PREVIEW_STARTED',
                jobId: payload.jobId,
                pid: payload.pid,
                cid: payload.cid,
                applyLeaseToken: transaction.token,
                documentToken,
            }) as { ok?: boolean } | null | undefined;
            assertApplyActive(transaction);
            if (!acknowledgment?.ok) throw draftError('preview-conflict');
            activeApply = null;
            rememberPeakName(payload, pageIds());
            const preview = document.getElementById('GPXPreview') as HTMLElement;
            showBanner(matchTone(payload.classification),
                `${matchLabel(payload.classification)} match · ${payload.confidence}% confidence. Preparing GPS Preview…`);
            preview.click();
        } catch (error) {
            rollbackApply(transaction);
            throw error;
        }
    };

    const runInitialize = async (connectionGeneration: number): Promise<void> => {
        clearLeaseRetry();
        const ids = pageIds();
        if (!ids.pid || !ids.cid) return;
        try {
            const response = await ext.runtime.sendMessage({
                type: 'DRAFT_READY',
                ...ids,
                documentToken,
                previewResult: readPreviewResult()
            }) as DraftReadyResponse | null | undefined;
            if (connectionGeneration !== draftConnectionGeneration) return;
            if (response?.action === 'ignore') {
                setSaveBlocked('');
                document.getElementById(BANNER_ID)?.remove();
                return;
            }
            if (!response || response.action === 'error') {
                setSaveBlocked(response?.message || 'This captured ascent could not be prepared. Reload this ascent form before saving.');
                showBanner('error', response?.message || 'This ascent draft could not be prepared.');
                return;
            }
            if (response.action === 'banner') {
                rememberPeakName(response, ids);
                if (response.dayStatsPending) {
                    const transaction = beginApply(response);
                    try {
                        await fillDayStats(response.dayStats, transaction);
                        assertApplyActive(transaction);
                        activeApply = null;
                    } catch (error) {
                        rollbackApply(transaction);
                        throw error;
                    }
                    try {
                        await ext.runtime.sendMessage({
                            type: 'DRAFT_DAY_STATS_APPLIED',
                            jobId: response.jobId,
                            pid: response.pid,
                            cid: response.cid
                        });
                    } catch {
                        // Day statistics are optional. A later page load can
                        // retry while the short-lived draft is still present.
                    }
                }
                if (connectionGeneration !== draftConnectionGeneration) return;
                setSaveBlocked('');
                showBanner(matchTone(response.classification),
                    `${matchLabel(response.classification)} match · ${response.confidence}% confidence. Preview is ready—review Peakbagger’s result before saving.`);
                return;
            }
            if (response.action === 'wait') {
                setSaveBlocked(response.message || 'Save the previous ascent before saving this summit.');
                showBanner('waiting', response.message || 'Waiting for the previous GPS Preview to finish.', {
                    persistent: true
                });
                if (typeof response.retryAt === 'number' && Number.isFinite(response.retryAt)) {
                    const retryAt = response.retryAt;
                    leaseRetryTimer = setTimeout(() => {
                        leaseRetryTimer = null;
                        if (connectionGeneration === draftConnectionGeneration) void initialize();
                    }, Math.max(0, retryAt - Date.now()));
                }
                return;
            }
            if (response.action === 'preview-error') {
                setSaveBlocked('GPS Preview must succeed before saving this captured ascent.');
                showBanner('error', response.message || 'Peakbagger did not accept GPS Preview. The draft was kept.', {
                    actionLabel: 'Retry GPS Preview',
                    onAction: () => initialize()
                });
                return;
            }
            if (response.action === 'apply') {
                setSaveBlocked('Preparing GPS Preview. Review the result before saving.');
                await applyAndPreview(response);
                return;
            }
            throw new Error('Unrecognized draft readiness response');
        } catch (error) {
            if (connectionGeneration !== draftConnectionGeneration) return;
            console.error('Better Peakbagger: draft preparation failed', error);
            setSaveBlocked('GPS Preview could not be prepared. Reload this ascent form before saving.');
            const failureCode = error && typeof error === 'object' && 'code' in error
                ? (error as { code?: unknown }).code
                : undefined;
            const failureMessage = typeof failureCode === 'string' && Object.hasOwn(DRAFT_FAILURES, failureCode)
                ? DRAFT_FAILURES[failureCode as DraftFailureCode]
                : undefined;
            showBanner('error', failureMessage
                || 'Draft preparation stopped unexpectedly. Reload the ascent form and try again.', {
                persistent: true,
                actionLabel: 'Reload ascent form',
                onAction: () => location.reload(),
            });
        }
    };

    let initializationQueue: Promise<void> = Promise.resolve();
    const initialize = (): Promise<void> => {
        if (lifecycle.state !== 'active') return Promise.resolve();
        // Queueing the worker lookup must not leave native Save available,
        // even before the first promise callback runs. Only an explicit
        // ordinary-form or Preview-ready reply can release this gate.
        const ids = pageIds();
        if (ids.pid && ids.cid) setSaveBlocked(blockedSaveMessage || 'Checking this ascent draft before saving.');
        const connectionGeneration = draftConnectionGeneration;
        const run = () => connectionGeneration === draftConnectionGeneration && lifecycle.state === 'active'
            ? runInitialize(connectionGeneration) : undefined;
        initializationQueue = initializationQueue.then(run, run);
        return initializationQueue;
    };

    const invalidateDraftWork = () => {
        clearLeaseRetry();
        draftConnectionGeneration++;
        // An extension reply can be lost while this document is frozen. A
        // resumed lookup must not wait behind that abandoned promise.
        initializationQueue = Promise.resolve();
        if (activeApply) {
            activeApply.cancelled = true;
            rollbackApply(activeApply);
        }
    };
    const lifecycle = PageLifecycle.create({
        onSuspend: invalidateDraftWork,
        onResume: () => { void initialize(); },
        onDispose: invalidateDraftWork,
    });

    ext.runtime.onMessage?.addListener(message => {
        if (message?.type === 'DRAFT_PROCEED') void initialize();
        if (message?.type === 'DRAFT_CLEARED') {
            invalidateDraftWork();
            setSaveBlocked('');
            showBanner('error', 'The cached capture was discarded. This draft is no longer connected; return to the activity to capture again.');
        }
    });

    void initialize();
})();
