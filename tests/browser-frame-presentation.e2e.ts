/** Real BrowserPane regression for incoming metadata arriving before displayed pixels.
 * --before uses the saved pre-decode-gate component in .runtime/viewport-before-decode.
 */
import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import react from '@vitejs/plugin-react';
import { createServer, type Plugin } from 'vite';

const root = process.cwd();
const before = process.argv.includes('--before');
const component = before
  ? '/.runtime/viewport-before-decode/BrowserPane.before.tsx'
  : '/src/renderer/BrowserPane.tsx';
await access(path.join(root, component));
await mkdir(path.join(root, 'test-results'), { recursive: true });
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserPane} from ${JSON.stringify(component)};
const svg=(w,h,color)=>'data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'"><rect width="100%" height="100%" fill="'+color+'"/></svg>');
const small=svg(620,400,'#bdd1f5'),large=svg(1100,710,'#a3ddbb'),delayed=svg(1100,710,'#e4cbb4'),latest=svg(1100,710,'#cebbef'),wrongAspect=svg(1100,400,'#f1b6be');
const listeners=[];
const f=window.__frameFixture={inputs:[],held:null,holdSource:null,deferSource:null,decodes:[],fitImage:small,small,large,delayed,latest,wrongAspect};
const descriptor=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
const decode=HTMLImageElement.prototype.decode;
Object.defineProperty(HTMLImageElement.prototype,'src',{...descriptor,set(value){if(value===f.holdSource){f.held={node:this,value};return;}descriptor.set.call(this,value);}});
HTMLImageElement.prototype.decode=function(){const source=this.src;const loaded=decode.call(this);return source===f.deferSource?loaded.then(()=>new Promise(resolve=>f.decodes.push({source,resolve}))):loaded;};
f.releaseImage=()=>{f.holdSource=null;const held=f.held;f.held=null;if(held)descriptor.set.call(held.node,held.value);};
f.emit=(data)=>{for(const listener of listeners)listener({type:'browser:frame',frame:{width:1100,height:710,tabId:'a',data}});};
f.releaseOldDecode=()=>{const pending=f.decodes.splice(0);for(const item of pending)item.resolve();};
window.workbench={onEvent(fn){listeners.push(fn);return()=>{}},async invoke(name,payload){
if(name==='browser:input'){f.inputs.push(payload);return true;}
if(name==='browser:resize'){
const data=payload.fitToWidth?f.fitImage:small;
const view={width:data===small?620:1100,height:data===small?400:710,tabId:'a'};
for(const listener of listeners)listener({type:'browser:frame',frame:{...view,data}});
return view;
}return true;}};
createRoot(document.getElementById('root')).render(React.createElement(BrowserPane,{
state:{status:'ready',engine:'browseros',tabs:[{id:'a',title:'A',url:'https://example.com',loading:false,canGoBack:false,canGoForward:false}],activeTabId:'a',url:'https://example.com',title:'A',loading:false,canGoBack:false,canGoForward:false,recording:false,inspecting:false},
recordings:[],liveSteps:[],initialFrame:{data:small,width:620,height:400,tabId:'a'},onAction:window.workbench.invoke,onOpenSettings(){},onAnalyze(){},onClose(){},onSourceRequest(){}}));
`;
const fixture: Plugin = {
  name: 'frame-presentation-regression',
  resolveId(id) {
    if (id === '/frame-entry.js') return '\0frame-entry';
  },
  load(id) {
    if (id === '\0frame-entry') return entry;
  },
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      if (request.url !== '/') return next();
      response.setHeader('content-type', 'text/html');
      response.end(
        await server.transformIndexHtml(
          '/index.html',
          '<!doctype html><meta charset="utf-8"><style>body{margin:0}.browser-pane{width:620px}.browser-canvas-wrap{width:620px;height:424px;position:relative}.browser-surface{position:relative;width:620px;height:400px}.browser-frame{position:absolute;width:100%;height:auto}.browser-keyboard{position:absolute;opacity:0;width:1px;height:1px}.frame-loading{position:absolute;inset:0;background:#fff8}</style><div id="root"></div><script type="module" src="/frame-entry.js"></script>',
        ),
      );
    });
  },
};
const server = await createServer({
  configFile: false,
  root,
  appType: 'custom',
  logLevel: 'error',
  plugins: [react(), fixture],
  server: { host: '127.0.0.1', port: 0 },
});
await server.listen();
const address = server.httpServer!.address() as { port: number };
const browser = await chromium.launch({
  executablePath: path.resolve(
    '../browseros-runtime/BrowserOS neo.app/Contents/MacOS/BrowserOS neo',
  ),
  headless: true,
  args: [
    '--disable-browseros-server',
    '--disable-browseros-server-updater',
    '--disable-browseros-extensions',
    '--browseros-disable-url-overrides',
    '--use-mock-keychain',
    '--disable-sync',
  ],
});
const checks: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}`);
  const mode = page.getByRole('combobox', { name: '页面缩放' });
  const settled = () => expect(page.locator('.frame-loading')).toHaveCount(0);
  const inputs = () =>
    page.evaluate(() =>
      (window as any).__frameFixture.inputs.filter((input: any) => input.action === 'down'),
    );
  const click = async () => {
    const bounds = await page.locator('.browser-surface').boundingBox();
    assert(bounds);
    await page.mouse.click(bounds.x + 550, bounds.y + 120);
  };
  await settled();
  await mode.selectOption('actual');
  await settled();
  await page.evaluate(() => {
    const f = (window as any).__frameFixture;
    f.fitImage = f.large;
    f.holdSource = f.large;
    f.inputs = [];
  });
  await mode.selectOption('fit');
  await expect
    .poll(() => page.evaluate(() => Boolean((window as any).__frameFixture.held)))
    .toBe(true);
  await click();
  assert.equal(
    (await inputs()).length,
    0,
    'New geometry must not accept clicks while the previous image is still presented',
  );
  await page.evaluate(() => (window as any).__frameFixture.releaseImage());
  await settled();
  await click();
  assert.equal((await inputs()).length, 1);
  assert.ok(Math.abs((await inputs())[0].x - (550 * 1100) / 620) < 0.01);
  checks.push('New viewport input waits for image presentation, then uses the new uniform scale');

  await mode.selectOption('actual');
  await settled();
  await page.evaluate(() => {
    const f = (window as any).__frameFixture;
    f.fitImage = f.delayed;
    f.deferSource = f.delayed;
    f.inputs = [];
  });
  await mode.selectOption('fit');
  await expect
    .poll(() => page.evaluate(() => (window as any).__frameFixture.decodes.length))
    .toBeGreaterThan(0);
  await mode.selectOption('actual');
  await settled();
  await page.evaluate(() => {
    const f = (window as any).__frameFixture;
    f.fitImage = f.latest;
    f.holdSource = f.latest;
    f.inputs = [];
  });
  await mode.selectOption('fit');
  await expect
    .poll(() => page.evaluate(() => Boolean((window as any).__frameFixture.held)))
    .toBe(true);
  await page.evaluate(() => (window as any).__frameFixture.releaseOldDecode());
  await click();
  assert.equal(
    (await inputs()).length,
    0,
    'An old decode with identical dimensions must not unlock a newer pending frame',
  );
  await page.evaluate(() => (window as any).__frameFixture.releaseImage());
  await settled();
  await click();
  assert.equal((await inputs()).length, 1);
  checks.push(
    'A stale decode cannot unlock a later same-size frame; the latest decoded frame restores input',
  );
  await page.evaluate(() => {
    const f = (window as any).__frameFixture;
    f.inputs = [];
    f.emit(f.wrongAspect);
  });
  await expect
    .poll(() =>
      page.locator('.browser-frame').evaluate((node: HTMLImageElement) => node.naturalHeight),
    )
    .toBe(400);
  await click();
  assert.equal(
    (await inputs()).length,
    0,
    'A decoded bitmap with stale proportions must not use new viewport coordinates',
  );
  await page.evaluate(() => {
    const f = (window as any).__frameFixture;
    f.emit(f.latest);
  });
  await settled();
  await click();
  assert.equal((await inputs()).length, 1);
  checks.push(
    'Transitional frames with mismatched bitmap proportions remain blocked until a matching frame arrives',
  );
  assert.deepEqual(errors, []);
  await writeFile(
    `test-results/frame-presentation${before ? '-before' : ''}.json`,
    JSON.stringify({ passed: true, checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, checks }));
} catch (error) {
  await writeFile(
    `test-results/frame-presentation${before ? '-before' : ''}.json`,
    JSON.stringify({ passed: false, checks, error: String(error) }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
  await server.close();
}
