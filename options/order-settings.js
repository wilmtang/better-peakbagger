// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { settingsSchema as Schema } from '../src/settings/settings-schema.js';

// Keep the same row nodes across updates so labels and keyboard focus survive.
export const initOrderSettings = ({ save }) => {
    const labels = { gaia: 'Gaia GPS', onx: 'onX Backcountry', alltrails: 'AllTrails', caltopo: 'CalTopo',
        fav: 'Climbing buddies / favorites', gps: 'GPS track', tr: 'Trip report', link: 'Link', beta: 'Has beta' };
    const definitions = [
        ['map-provider-order', 'mapProviderOrder', Schema.MAP_PROVIDERS, 'mapProvidersEnabled'],
        ['beta-peak-order', 'betaPeakFilterOrder', Schema.PEAK_FILTER_ORDER],
        ['beta-personal-order', 'betaPersonalFilterOrder', Schema.PERSONAL_FILTER_ORDER],
    ];
    const lists = definitions.map(([id, key, defaults, enabledKey]) => {
        const list = document.getElementById(id);
        let settings = Schema.clean();
        let pending = false;
        const rows = new Map();
        const render = () => {
            const focused = list.contains(document.activeElement) ? document.activeElement : null;
            const order = settings[key] || defaults;
            for (const [index, item] of order.entries()) {
                const row = rows.get(item);
                if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
                row.querySelector('[data-move="up"]').disabled = pending || index === 0;
                row.querySelector('[data-move="down"]').disabled = pending || index === order.length - 1;
                const check = row.querySelector('input');
                if (check) { check.checked = settings[enabledKey].includes(item); check.disabled = pending; }
            }
            if (focused && !focused.disabled) focused.focus({ preventScroll: true });
        };
        const change = async (patch, focusItem, direction) => {
            if (pending) return;
            pending = true;
            settings = { ...settings, ...patch };
            render();
            try { settings = await save(patch); }
            catch { /* The parent restores confirmed settings and reports the failure. */ }
            finally {
                pending = false;
                render();
                if (focusItem && (document.activeElement === document.body || list.contains(document.activeElement))) {
                    const row = rows.get(focusItem);
                    const preferred = row.querySelector(`[data-move="${direction}"]`);
                    (preferred.disabled ? row.querySelector('button:not(:disabled)') : preferred)?.focus({ preventScroll: true });
                }
            }
        };
        for (const item of defaults) {
            const row = document.createElement('li');
            row.dataset.orderItem = item;
            const label = document.createElement(enabledKey ? 'label' : 'span');
            label.className = 'order-setting-label';
            if (enabledKey) {
                const check = document.createElement('input');
                check.type = 'checkbox';
                check.addEventListener('change', () => {
                    const enabled = settings[enabledKey].filter(value => value !== item);
                    if (check.checked) enabled.push(item);
                    void change({ [enabledKey]: enabled });
                });
                label.append(check);
            }
            label.append(document.createTextNode(labels[item]));
            row.append(label);
            for (const [direction, offset, glyph] of [['up', -1, '↑'], ['down', 1, '↓']]) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'secondary';
                button.dataset.move = direction;
                button.textContent = glyph;
                button.setAttribute('aria-label', `Move ${labels[item]} ${direction}`);
                button.addEventListener('click', () => {
                    const order = [...(settings[key] || defaults)];
                    const from = order.indexOf(item);
                    const to = from + offset;
                    if (to < 0 || to >= order.length) return;
                    [order[from], order[to]] = [order[to], order[from]];
                    void change({ [key]: order }, item, direction);
                });
                row.append(button);
            }
            rows.set(item, row);
        }
        render();
        return next => { settings = next; render(); };
    });
    return { populate: settings => lists.forEach(populate => populate(settings)) };
};
