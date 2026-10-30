/** Real-component regression. Add --before to run the saved pre-fix component (expected red). */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, expect, type Browser } from '@playwright/test';
import react from '@vitejs/plugin-react';
import { createServer, type Plugin, type ViteDevServer } from 'vite';

const root = process.cwd();
const before = process.argv.includes('--before');
const component = before
  ? '/.runtime/inspector-draft/ElementInspector.before.tsx'
  : '/src/renderer/ElementInspector.tsx';
assert.ok(existsSync(path.join(root, component)), `Component does not exist: ${component}`);
const temporary = await mkdtemp(path.join(tmpdir(), 'workbench-inspector-draft-'));
const executable = [
  chromium.executablePath(),
  process.env.WORKBENCH_BROWSEROS_TEST_BINARY,
  path.resolve('../browseros-runtime/BrowserOS neo.app/Contents/MacOS/BrowserOS neo'),
  '/Applications/BrowserOS neo.app/Contents/MacOS/BrowserOS neo',
].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
assert.ok(executable, 'An installed Chromium or BrowserOS test binary is required');

const details = {
  ref: 'fixture-ref',
  tabId: 'fixture-tab',
  frameId: 'fixture-frame',
  documentId: 'fixture-doc',
  nodeId: 'fixture-node',
  tag: 'button',
  role: 'button',
  name: 'Fixture button',
  selector: '#fixture-button',
  textContent: 'Fixture button',
  editableText: true,
  attributes: { id: 'fixture-button' },
  computed: {},
  ancestors: [],
  shadowPath: [],
  animation: {
    keyframes: [
      { offset: 0, styles: { transform: 'scale(1)' } },
      { offset: 1, styles: { transform: 'scale(1.04)' } },
    ],
    duration: 1800,
    iterations: 'infinite',
    easing: 'ease-in-out',
    direction: 'alternate',
  },
  animationState: 'running',
};
const virtualId = '\0workbench-inspector-draft-fixture';
const entry = `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ElementInspector } from ${JSON.stringify(component)};
const details = ${JSON.stringify(details)};
const pending = [];
const fixture = window.__inspectorDraftFixture = {
  initialReads: 0, refreshRequests: 0, refreshResolved: 0,
  release() { const resolvers = pending.splice(0); for (const resolve of resolvers) resolve(structuredClone(details)); return resolvers.length; }
};
window.workbench = {
  invoke(action) {
    if (action !== 'browser:element-details') throw new Error('Unexpected fixture action');
    fixture.refreshRequests++;
    return new Promise(resolve => pending.push(resolve)).then(value => { fixture.refreshResolved++; return value; });
  },
  onEvent() { return () => {}; }
};
const onAction = async action => {
  if (action !== 'browser:element-details') throw new Error('Unexpected fixture action');
  fixture.initialReads++;
  return structuredClone(details);
};
createRoot(document.getElementById('root')).render(createElement(ElementInspector, {
  selected: details, tabId: details.tabId, previews: [], onAction,
  onClose() {}, onSourceRequest() {}
}));
`;
const fixturePlugin: Plugin = {
  name: 'workbench-inspector-draft-fixture',
  resolveId(id) {
    return id === '/__inspector-draft-entry.js' ? virtualId : undefined;
  },
  load(id) {
    return id === virtualId ? entry : undefined;
  },
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      if (request.url?.split('?')[0] !== '/') return next();
      const html = await server.transformIndexHtml(
        '/index.html',
        '<!doctype html><html><meta charset="utf-8"><title>Inspector draft fixture</title><div id="root"></div><script type="module" src="/__inspector-draft-entry.js"></script></html>',
      );
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(html);
    });
  },
};
let server: ViteDevServer | undefined;
let browser: Browser | undefined;
let actualDuration: string | undefined;
try {
  server = await createServer({
    configFile: false,
    root,
    appType: 'custom',
    logLevel: 'error',
    cacheDir: path.join(temporary, 'vite-cache'),
    plugins: [react(), fixturePlugin],
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root, temporary] } },
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({
    executablePath: executable,
    headless: true,
    env: {
      PATH: process.env.PATH ?? '',
      TMPDIR: temporary,
      LANG: 'en_US.UTF-8',
      BROWSERCLAW_DIR: path.join(temporary, 'claw-state'),
    },
    args: [
      '--disable-browseros-server',
      '--disable-browseros-server-updater',
      '--disable-browseros-extensions',
      '--browseros-disable-url-overrides',
      '--disable-background-networking',
      '--disable-component-update',
      '--use-mock-keychain',
      '--disable-sync',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 700, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  await page.goto(origin);
  await expect
    .poll(() => page.evaluate(() => (window as any).__inspectorDraftFixture?.refreshRequests ?? 0))
    .toBe(1);
  await page.getByRole('tab', { name: '动效', exact: true }).click();
  const duration = page.getByRole('spinbutton', { name: '动效周期', exact: true });
  await expect(duration).toHaveValue('1.8');
  await duration.fill('');
  await expect(duration).toHaveValue('');
  const released = await page.evaluate(() => (window as any).__inspectorDraftFixture.release());
  assert.equal(released, 1);
  await expect
    .poll(() => page.evaluate(() => (window as any).__inspectorDraftFixture.refreshResolved))
    .toBe(1);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  actualDuration = await duration.inputValue();
  assert.deepEqual(errors, []);
  assert.equal(
    actualDuration,
    '',
    'An in-flight property refresh must not erase an unfinished duration draft',
  );
  console.log(
    JSON.stringify({
      passed: true,
      component: before ? 'before-snapshot' : 'current',
      releasedRefreshes: released,
      duration: actualDuration,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      passed: false,
      component: before ? 'before-snapshot' : 'current',
      duration: actualDuration,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server?.close();
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
