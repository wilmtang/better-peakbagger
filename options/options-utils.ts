// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { listFocusRestorer } from '../src/ui/list-focus.ts';

export interface RepoStatus {
    repo?: {
        fullName?: string | null;
        owner?: string | null;
        name?: string | null;
    } | null;
}

export interface BusyState {
    isBusy: () => boolean;
    setBusy: (busy: boolean) => void;
}

export interface StatusFlashElements {
    statusEl: HTMLElement;
    statusErrorEl: HTMLElement;
    statusErrorTextEl: HTMLElement;
    statusErrorDismissEl: HTMLElement;
}

export interface FlashOptions {
    error?: boolean;
}

export type FlashFn = (msg?: string, options?: FlashOptions) => number;

export interface StatusFlash {
    flash: FlashFn;
    dismissStatus: (expectedToken?: number) => boolean;
}

const githubRepoName = (status: RepoStatus | null | undefined): string => status?.repo?.fullName
    || (status?.repo?.owner && status?.repo?.name
        ? `${status.repo.owner}/${status.repo.name}`
        : 'the connected repository');

// Temporary unavailability keeps keyboard focus. Callers must guard activation
// with their operation state; aria-disabled alone does not suppress events.
const setButtonBusy = (button: Element, busy: boolean): void => {
    button.setAttribute('aria-disabled', String(busy));
    button.setAttribute('aria-busy', String(busy));
};

const withBusy = async ({ isBusy, setBusy }: BusyState, operation: () => unknown): Promise<void> => {
    if (isBusy()) return;
    setBusy(true);
    try {
        await operation();
    } finally {
        setBusy(false);
    }
};

const logMissingElements = (surface: string, elements: Record<string, unknown>): boolean => {
    const missing = Object.entries(elements)
        .filter(([, value]) => Array.isArray(value)
            ? value.length === 0 || value.some(element => !element)
            : !value)
        .map(([name]) => name);
    if (!missing.length) return false;
    console.error(`Better Peakbagger ${surface} unavailable; missing: ${missing.join(', ')}`);
    return true;
};

const actionButton = (className: string, text: string, ariaLabel: string): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `panel-button ${className}`;
    button.textContent = text;
    button.setAttribute('aria-label', ariaLabel);
    return button;
};

// The panel surfaces' only transient channel, and most of its traffic reports a
// failure or blocks the action. Successes confirm and fade; failures go to the
// alert region, keep the danger colour, and stay until the user dismisses them
// or the next report replaces them. Two sibling live regions rather than one
// whose role/aria-live is rewritten per message: assistive technology does not
// reliably pick up a role change on a live element. Shared so a second page
// cannot ship a third variant of that contract.
const createStatusFlash = ({
    statusEl,
    statusErrorEl,
    statusErrorTextEl,
    statusErrorDismissEl,
}: StatusFlashElements): StatusFlash => {
    let statusTimer: ReturnType<typeof setTimeout> | null = null;
    let statusToken = 0;
    const dismissStatus = (expectedToken?: number): boolean => {
        if (expectedToken !== undefined && expectedToken !== statusToken) return false;
        if (statusTimer !== null) clearTimeout(statusTimer);
        statusTimer = null;
        statusEl.classList.remove('show');
        statusErrorEl.classList.remove('show');
        statusErrorEl.hidden = true;
        return true;
    };
    const flash = (msg = 'Saved', { error = false }: FlashOptions = {}): number => {
        dismissStatus();
        const token = ++statusToken;
        if (error) {
            statusErrorTextEl.textContent = msg;
            statusErrorEl.hidden = false;
            statusErrorEl.classList.add('show');
            return token;
        }
        statusEl.textContent = msg;
        statusEl.classList.add('show');
        statusTimer = setTimeout(() => statusEl.classList.remove('show'), 1200);
        return token;
    };
    statusErrorDismissEl.addEventListener('click', () => dismissStatus());
    return { flash, dismissStatus };
};

export const optionsUtils = {
    githubRepoName,
    withBusy,
    setButtonBusy,
    logMissingElements,
    actionButton,
    listFocusRestorer,
    createStatusFlash,
};
