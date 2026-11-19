import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { distDir, root } from './build-config.mts';
import { watchAll, type WatchHandle } from './build.mts';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mts';

export function webExtArguments(
    browser: string | undefined,
    sourceDir: string,
    reloadFile: string,
    passthrough: readonly string[] = [],
): string[] {
    if (browser !== 'chromium' && browser !== 'firefox') {
        throw new Error('Usage: node scripts/run-development.mts <chromium|firefox> [web-ext options]');
    }
    const managed = passthrough.find(arg =>
        /^--(?:source-dir|sourceDir|target|watch-files?|watchFiles?|s|t)(?:=|$)|^-[a-z]*[st]/.test(arg));
    if (managed) throw new Error(`The development runner manages ${managed.split('=')[0]}.`);
    return [
        'run',
        '--source-dir',
        sourceDir,
        '--target',
        browser === 'chromium' ? 'chromium' : 'firefox-desktop',
        '--watch-file',
        reloadFile,
        ...passthrough,
    ];
}

function waitForChild(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
    });
}

export async function runDevelopment(
    browser: string | undefined,
    passthrough: readonly string[] = [],
): Promise<number> {
    const controlDir = await mkdtemp(path.join(tmpdir(), 'better-peakbagger-development-'));
    let watcher: WatchHandle | null = null;
    let child: ChildProcess | null = null;
    let forwardedSignal: NodeJS.Signals | null = null;

    try {
        const firefoxSourceDir = browser === 'firefox' ? path.join(controlDir, 'firefox-source') : undefined;
        const reloadFile = path.join(controlDir, 'generation');
        const args = webExtArguments(browser, firefoxSourceDir ?? distDir, reloadFile, passthrough);
        if (browser === 'chromium') assertChromeLaunchAllowed();
        watcher = await watchAll({ reloadFile, firefoxSourceDir });

        const executable = process.platform === 'win32' ? 'web-ext.cmd' : 'web-ext';
        const spawned = spawn(executable, args, {
            cwd: root,
            stdio: 'inherit',
        });
        child = spawned;

        const forwardSignal = (signal: NodeJS.Signals) => {
            forwardedSignal = signal;
            if (!spawned.killed) spawned.kill(signal);
        };
        const forwardInterrupt = () => forwardSignal('SIGINT');
        const forwardTerminate = () => forwardSignal('SIGTERM');
        process.on('SIGINT', forwardInterrupt);
        process.on('SIGTERM', forwardTerminate);

        try {
            const result = await waitForChild(spawned);
            if (forwardedSignal) return 0;
            if (result.signal) return 1;
            return result.code ?? 1;
        } finally {
            process.off('SIGINT', forwardInterrupt);
            process.off('SIGTERM', forwardTerminate);
        }
    } finally {
        if (child && child.exitCode === null && !child.killed) child.kill('SIGTERM');
        try {
            await watcher?.close();
        } finally {
            await rm(controlDir, { recursive: true, force: true });
        }
    }
}

const isCli = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
    runDevelopment(process.argv[2], process.argv.slice(3))
        .then(code => {
            process.exitCode = code;
        })
        .catch((error: unknown) => {
            console.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        });
}
