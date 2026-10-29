import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';
import { buildMain } from './build-main.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 5173 } });
await server.listen();
const address = server.httpServer.address();
const url = `http://127.0.0.1:${address.port}`;
await buildMain();
const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, WORKBENCH_DEV_SERVER_URL: url },
});
console.log(`Workbench renderer: ${url}`);
child.once('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
