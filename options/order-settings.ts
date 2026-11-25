// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { settingsSchema as Schema } from '../src/settings/settings-schema.ts';
import type { Settings, SettingsPatch } from './settings-patch-route.ts';

type OrderKey = 'mapProviderOrder' | 'betaPeakFilterOrder' | 'betaPersonalFilterOrder';
type EnabledKey = 'mapProvidersEnabled';
type OrderPatch = Partial<Record<OrderKey | EnabledKey, string[]>>;

interface OrderDefinition {
    id: string;
    key: OrderKey;
    defaults: readonly string[];
    enabledKey?: EnabledKey;
}

interface DragState {
    item: string;
    row: HTMLLIElement;
    handle: HTMLButtonElement;
    pointerId: number;
    startY: number;
    lastY: number;
    grabOffset: number;
    draft: string[];
    started: boolean;
}

export interface OrderSettingsOptions {
    save: (patch: SettingsPatch) => Promise<Settings>;
}

export interface OrderSettingsOwner {
    populate(settings: Settings): void;
}

// Stable rows preserve label associations and focus while reordering. Only the
// grip starts a drag: using a provider checkbox never changes its position.
export const initOrderSettings = ({ save }: OrderSettingsOptions): OrderSettingsOwner => {
    const labels: Record<string, string> = {
        gaia: 'Gaia GPS',
        onx: 'onX Backcountry',
        alltrails: 'AllTrails',
        caltopo: 'CalTopo',
        fav: 'Climbing buddies / favorites',
        gps: 'GPS track',
        tr: 'Trip report',
        link: 'Link',
        beta: 'Has beta',
    };
    const definitions: readonly OrderDefinition[] = [
        { id: 'map-provider-order', key: 'mapProviderOrder', defaults: Schema.MAP_PROVIDERS, enabledKey: 'mapProvidersEnabled' },
        { id: 'beta-peak-order', key: 'betaPeakFilterOrder', defaults: Schema.PEAK_FILTER_ORDER },
        { id: 'beta-personal-order', key: 'betaPersonalFilterOrder', defaults: Schema.PERSONAL_FILTER_ORDER },
    ];
    const lists = definitions.map(({ id, key, defaults, enabledKey }) => {
        const list = document.getElementById(id) as HTMLElement;
        const instructions = document.createElement('span');
        instructions.id = `${id}-help`;
        instructions.className = 'order-settings-sr';
        instructions.textContent = 'Drag to reorder, or use the Up and Down arrow keys. Escape cancels a drag.';
        const status = document.createElement('span');
        status.className = 'order-settings-sr';
        status.setAttribute('role', 'status');
        list.after(instructions, status);
        const scroller = list.closest('.content');
        const rows = new Map<string, HTMLLIElement>();
        const animations = new Map<HTMLElement, Animation>();
        const reducedMotion = (): boolean => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
        let settings: Settings = Schema.clean({});
        let pending = false;
        let drag: DragState | null = null;
        let scrollFrame: number | null = null;
        // Schema.DEFAULTS types nullable filter orders as `null` rather than `readonly string[] | null`.
        const order = (): readonly string[] => (settings[key] as readonly string[] | null) || defaults;
        const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
            a.length === b.length && a.every((item, index) => item === b[index]);
        const announce = (item: string, items: readonly string[]): void => {
            status.textContent = `${labels[item]} moved to position ${items.indexOf(item) + 1} of ${items.length}.`;
        };
        const animate = (row: HTMLLIElement, from: number): void => {
            animations.get(row)?.cancel();
            if (reducedMotion() || !row.animate || Math.abs(from) < 1) return;
            const animation = row.animate(
                [{ transform: `translateY(${from}px)` }, { transform: 'translateY(0)' }],
                { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' },
            );
            animations.set(row, animation);
            const forget = (): void => { if (animations.get(row) === animation) animations.delete(row); };
            animation.addEventListener?.('finish', forget, { once: true });
            animation.addEventListener?.('cancel', forget, { once: true });
        };
        const render = (motion = false): void => {
            const focused = list.contains(document.activeElement) ? document.activeElement as HTMLElement | null : null;
            const before = motion
                ? new Map([...rows.values()].map(row => [row, row.getBoundingClientRect().top]))
                : null;
            for (const [index, item] of (drag?.draft || order()).entries()) {
                const row = rows.get(item);
                if (!row) continue;
                if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
                row.querySelector('.order-grip')!.setAttribute('aria-disabled', String(pending));
                const check = row.querySelector('input');
                if (check && enabledKey) {
                    check.checked = settings[enabledKey].includes(item);
                    check.setAttribute('aria-disabled', String(pending));
                }
                const previousTop = before?.get(row);
                if (previousTop !== undefined && row !== drag?.row) {
                    animate(row, previousTop - (list.getBoundingClientRect().top + row.offsetTop));
                }
            }
            if (focused && !(focused as { disabled?: boolean }).disabled) focused.focus({ preventScroll: true });
        };
        const change = async (patch: OrderPatch, item?: string): Promise<void> => {
            if (pending) return;
            const focus = list.contains(document.activeElement) ? document.activeElement as HTMLElement | null : null;
            pending = true;
            settings = { ...settings, ...patch } as Settings;
            render(true);
            try { settings = await save(patch as SettingsPatch); }
            catch { /* The parent restores confirmed settings and reports failure. */ }
            finally {
                pending = false;
                render();
                if (focus && (document.activeElement === document.body || document.activeElement === focus)) {
                    focus.focus({ preventScroll: true });
                }
                const nextOrder = patch[key];
                if (item && nextOrder && sameOrder(order(), nextOrder)) announce(item, order());
            }
        };
        const release = (): DragState => {
            const ended = drag!;
            drag = null;
            if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
            scrollFrame = null;
            list.removeAttribute('data-reordering');
            ended.row.removeAttribute('data-dragging');
            ended.row.style.removeProperty('transform');
            try { ended.handle.releasePointerCapture?.(ended.pointerId); } catch { /* Already released. */ }
            return ended;
        };
        const finish = (cancelled: boolean): void => {
            if (!drag) return;
            const from = drag.row.getBoundingClientRect().top;
            const ended = release();
            if (!ended.started) return;
            if (cancelled) {
                render(true);
                status.textContent = 'Reordering canceled.';
            } else if (!sameOrder(ended.draft, order())) {
                void change({ [key]: ended.draft }, ended.item);
            }
            animate(ended.row, from - ended.row.getBoundingClientRect().top);
        };
        const move = (clientY: number): void => {
            if (!drag?.started) return;
            const bounds = list.getBoundingClientRect();
            const top = Math.max(bounds.top, Math.min(bounds.bottom - drag.row.offsetHeight, clientY - drag.grabOffset));
            const center = top + drag.row.offsetHeight / 2;
            const others = drag.draft.filter(item => item !== drag!.item);
            const index = others.filter(item => {
                const row = rows.get(item)!;
                return bounds.top + row.offsetTop + row.offsetHeight / 2 < center;
            }).length;
            others.splice(index, 0, drag.item);
            if (!sameOrder(others, drag.draft)) {
                drag.draft = others;
                render(true);
                if (!drag) return;
                // Moving the grip's ancestor can release capture in a browser.
                try { drag.handle.setPointerCapture?.(drag.pointerId); } catch { /* Window listeners remain active. */ }
            }
            drag.row.style.transform = `translateY(${top - (list.getBoundingClientRect().top + drag.row.offsetTop)}px)`;
        };
        const scroll = (): void => {
            scrollFrame = null;
            if (!drag?.started || !scroller) return;
            const bounds = scroller.getBoundingClientRect();
            const delta = drag.lastY < bounds.top + 40 ? -8 : drag.lastY > bounds.bottom - 40 ? 8 : 0;
            if (delta) { scroller.scrollTop += delta; move(drag.lastY); }
            scrollFrame = requestAnimationFrame(scroll);
        };
        for (const item of defaults) {
            const row = document.createElement('li');
            row.dataset.orderItem = item;
            const handle = document.createElement('button');
            handle.type = 'button';
            handle.className = 'order-grip';
            handle.setAttribute('aria-label', `Reorder ${labels[item]}`);
            handle.setAttribute('aria-describedby', instructions.id);
            handle.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown');
            handle.title = 'Drag to reorder · ↑ / ↓';
            const dots = document.createElement('span');
            dots.className = 'order-grip-dots';
            dots.setAttribute('aria-hidden', 'true');
            handle.append(dots);
            handle.addEventListener('pointerdown', event => {
                if (pending || drag || event.isPrimary === false || event.button !== 0) return;
                handle.focus({ preventScroll: true });
                drag = {
                    item,
                    row,
                    handle,
                    pointerId: event.pointerId,
                    startY: event.clientY,
                    lastY: event.clientY,
                    grabOffset: event.clientY - row.getBoundingClientRect().top,
                    draft: [...order()],
                    started: false,
                };
                try { handle.setPointerCapture?.(event.pointerId); } catch { /* Unsupported in DOM fixtures. */ }
            });
            handle.addEventListener('keydown', event => {
                if (event.key === 'Escape') { event.preventDefault(); finish(true); return; }
                const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
                if (!delta || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
                event.preventDefault();
                if (pending || drag) return;
                const next = [...order()];
                const from = next.indexOf(item);
                const to = from + delta;
                if (to < 0 || to >= next.length) return;
                [next[from], next[to]] = [next[to], next[from]];
                void change({ [key]: next }, item);
            });
            row.append(handle);
            const label = document.createElement(enabledKey ? 'label' : 'span');
            label.className = 'order-setting-label';
            if (enabledKey) {
                const check = document.createElement('input');
                check.type = 'checkbox';
                check.addEventListener('change', () => {
                    if (pending) { render(); return; }
                    const enabled = settings[enabledKey].filter(value => value !== item);
                    if (check.checked) enabled.push(item);
                    void change({ [enabledKey]: enabled });
                });
                label.append(check);
            }
            label.append(document.createTextNode(labels[item]));
            row.append(label);
            rows.set(item, row);
        }
        window.addEventListener('pointermove', event => {
            if (!drag || event.pointerId !== drag.pointerId) return;
            drag.lastY = event.clientY;
            if (!drag.started && Math.abs(event.clientY - drag.startY) < 6) return;
            if (!drag.started) {
                drag.started = true;
                animations.get(drag.row)?.cancel();
                drag.row.setAttribute('data-dragging', '');
                list.setAttribute('data-reordering', '');
                scrollFrame = requestAnimationFrame(scroll);
            }
            event.preventDefault();
            move(event.clientY);
        }, { passive: false });
        window.addEventListener('pointerup', event => { if (event.pointerId === drag?.pointerId) finish(false); });
        window.addEventListener('pointercancel', event => { if (event.pointerId === drag?.pointerId) finish(true); });
        window.addEventListener('keydown', event => { if (drag && event.key === 'Escape') { event.preventDefault(); finish(true); } });
        window.addEventListener('blur', event => {
            // Refocusing a moved grip can blur the document viewport without
            // leaving this window. Only an external focus change cancels.
            if ((event.relatedTarget as { ownerDocument?: Document } | null)?.ownerDocument === document) return;
            finish(true);
        });
        window.addEventListener('pagehide', () => finish(true));
        render();
        return (next: Settings): void => {
            if (drag && !sameOrder((next[key] as readonly string[] | null) || defaults, order())) finish(true);
            settings = next;
            render();
        };
    });
    return { populate: (settings: Settings): void => lists.forEach(populate => populate(settings)) };
};
