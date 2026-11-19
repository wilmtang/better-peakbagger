import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { distDir, root } from './build-config.mts';
import { RELOAD_SIGNAL, watchAll, type WatchHandle } from './build.mts';
import {
    createFirefoxSource,
    syncFirefoxSource,
    type FirefoxSource,
} from './run-firefox.mts';

export function webExtArguments(
    browser: string | undefined,
    sourceDir: string,
    passthrough: readonly string[] = [],
): string[] {
    if (browser !== 'chromium' && browser !== 'firefox') {
        throw new Error('Usage: node scripts/run-development.mts <chromium|firefox> [web-ext options]');
    }
    return [
        'run',
        '--source-dir',
        sourceDir,
        ...(browser === 'chromium' ? ['--target', 'chromium'] : []),
        '--watch-file',
        path.join(sourceDir, RELOAD_SIGNAL),
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
    let firefoxSource: FirefoxSource | null = null;
    let watcher: WatchHandle | null = null;
    let child: ChildProcess | null = null;
    let forwardedSignal: NodeJS.Signals | null = null;

    try {
        if (browser === 'firefox') {
            firefoxSource = await createFirefoxSource();
        } else if (browser !== 'chromium') {
            webExtArguments(browser, distDir);
        }

        const activeFirefox = firefoxSource;
        watcher = await watchAll({
            afterBuild: activeFirefox
                ? ({ sequence }) => syncFirefoxSource({
                    distDir,
                    sourceDir: activeFirefox.sourceDir,
                    reloadToken: sequence,
                })
                : undefined,
        });

        const sourceDir = firefoxSource?.sourceDir ?? distDir;
        const executable = process.platform === 'win32' ? 'web-ext.cmd' : 'web-ext';
        const spawned = spawn(executable, webExtArguments(browser, sourceDir, passthrough), {
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
        await watcher?.close();
        await firefoxSource?.cleanup();
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
