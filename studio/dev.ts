import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

// `pnpm studio`: the studio server and the Next.js UI together. Ctrl-C stops both.
const ROOT = resolve(import.meta.dirname, '..');
const API_PORT = process.env.STUDIO_API_PORT ?? '4310';
const WEB_PORT = process.env.STUDIO_WEB_PORT ?? '4300';

const children: ChildProcess[] = [
  spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'studio/server/main.ts'], {
    cwd: ROOT, stdio: 'inherit', env: { ...process.env, STUDIO_API_PORT: API_PORT },
  }),
  spawn('pnpm', ['exec', 'next', 'dev', 'studio/web', '--port', WEB_PORT, '--hostname', '127.0.0.1'], {
    cwd: ROOT, stdio: 'inherit', env: { ...process.env, STUDIO_API_PORT: API_PORT },
  }),
];

const stop = (): void => {
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
};
for (const child of children) child.on('exit', (code) => { stop(); process.exitCode = code ?? 0; });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

console.log(`Story Studio: http://127.0.0.1:${WEB_PORT}`);
