/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface PointerEventInit extends MouseEventInit {
    pointerId?: number;
    pointerType?: string;
}

// A pointer-shaped mouse event: the pointer id and type a handler reads, on
// an event every DOM implementation can construct.
export const pointerEvent = (dom: { window: { MouseEvent: typeof MouseEvent } }, type: string, {
    pointerId = 1,
    pointerType = 'mouse',
    ...init
}: PointerEventInit = {}): MouseEvent & { pointerId: number; pointerType: string } => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
    Object.defineProperties(event, {
        pointerId: { value: pointerId },
        pointerType: { value: pointerType },
    });
    return event as MouseEvent & { pointerId: number; pointerType: string };
};
