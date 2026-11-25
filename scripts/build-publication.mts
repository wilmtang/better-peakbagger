// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { distDir } from './build-config.mts';

export const RELOAD_SIGNAL = '.better-peakbagger-reload';

export interface PublishBuildTreeOptions {
    candidateDir: string;
    targetDir?: string;
    renameTree?: typeof rename;
    afterSwap?: () => Promise<void>;
}

export async function publishBuildTree({
    candidateDir,
    targetDir = distDir,
    renameTree = rename,
    afterSwap,
}: PublishBuildTreeOptions): Promise<void> {
    if (!candidateDir || path.resolve(candidateDir) === path.resolve(targetDir)) {
        throw new Error('Build publication requires a distinct candidate tree.');
    }
    const previousDir = `${targetDir}.previous-${randomUUID()}`;
    const hadPrevious = existsSync(targetDir);
    if (hadPrevious) await renameTree(targetDir, previousDir);
    let swapped = false;
    try {
        await renameTree(candidateDir, targetDir);
        swapped = true;
        await afterSwap?.();
    } catch (publishError) {
        const rollbackErrors: unknown[] = [];
        const restore = async (from: string, to: string) => {
            try {
                await renameTree(from, to);
            } catch (error) {
                // A transient Windows handle can delay either rollback move.
                rollbackErrors.push(error);
                await renameTree(from, to);
            }
        };
        try {
            if (swapped) await restore(targetDir, candidateDir);
            if (hadPrevious) await restore(previousDir, targetDir);
        } catch (retryError) {
            throw new AggregateError([publishError, ...rollbackErrors, retryError],
                `Build publication and rollback both failed. Recovery path: ${previousDir}`);
        }
        if (rollbackErrors.length) {
            const message = publishError instanceof Error ? publishError.message : String(publishError);
            throw new AggregateError([publishError, ...rollbackErrors],
                `Build publication failed (${message}); rollback recovered after retry.`);
        }
        throw publishError;
    }
    if (hadPrevious) {
        // A caller can have already notified browsers at this point.
        await rm(previousDir, { recursive: true, force: true }).catch(error =>
            console.warn(`Could not remove the previous build tree at ${previousDir}:`, error));
    }
}
