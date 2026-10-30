import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserRuntime, normalizeBrowserUrl, redactBrowserText } from '../src/main/browser';
import type { BrowserFrame, ElementRef, RecordedStep, ElementAnimation } from '../src/shared/types';

function jpegDimensions(frame: BrowserFrame): { width: number; height: number } {
  const bytes = Buffer.from(frame.data.split(',')[1], 'base64');
  let offset = 2;
  while (offset + 8 < bytes.length) {
    assert.equal(bytes[offset], 0xff);
    const marker = bytes[offset + 1];
    offset += 2;
    if ([0xc0, 0xc1, 0xc2].includes(marker))
      return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    offset += bytes.readUInt16BE(offset);
  }
  throw new Error('JPEG has no size marker');
}

test('browser navigation only accepts safe HTTP(S) addresses', () => {
  assert.equal(normalizeBrowserUrl('localhost:5173/demo'), 'http://localhost:5173/demo');
  assert.equal(normalizeBrowserUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeBrowserUrl('http://127.0.0.1:6789/'), 'http://127.0.0.1:6789/');
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,test',
    'https://user:pass@example.com',
    '',
  ]) {
    assert.throws(() => normalizeBrowserUrl(url), Error, url);
  }
});

test('diagnostic text removes common token and password patterns', () => {
  const text = redactBrowserText(
    'Authorization: Bearer abc123 password=hunter2 api_key=hello sk-secretvalue',
  );
  for (const value of ['abc123', 'hunter2', 'hello', 'sk-secretvalue'])
    assert(!text.includes(value));
});

test('screenshots discard pixels when a masked document changes during capture', async () => {
  const runtime = new BrowserRuntime({
    storageDir: '/unused-in-memory-test',
    onState() {},
    onFrame() {},
    onStep() {},
    onSelected() {},
    onHumanTakeover() {},
  }) as any;
  const frame = { id: 'frame', channel: {}, revision: 1, documentId: 'before' };
  const tab = {
    info: { id: 'tab', url: 'https://example.test/' },
    activation: 1,
    page: {
      call: async () => {
        frame.documentId = 'after';
        frame.revision++;
        return { data: 'must-not-be-returned' };
      },
    },
  };
  runtime.activeTabId = 'tab';
  runtime.collectFrames = async () => [frame];
  runtime.bridge = async () => undefined;
  runtime.prepareFrame = async () => 1;
  await assert.rejects(runtime.screenshotInternal(tab), /丢弃截图/);
});

const binary = process.env.WORKBENCH_BROWSEROS_TEST_BINARY;
test(
  'real BrowserOS neo: resize publishes the new viewport during continuous motion',
  { skip: !binary, timeout: 30_000 },
  async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'workbench-motion-resize-test-'));
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(
        '<!doctype html><style>body{padding:20px}button{padding:14px 28px}</style><button id="moving">Motion resize</button>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    let lastFrame: BrowserFrame | undefined;
    let frameSequence = 0;
    const frameWaiters = new Set<() => void>();
    const runtime = new BrowserRuntime({
      storageDir,
      binaryPath: binary,
      onState() {},
      onFrame: (frame) => {
        lastFrame = frame;
        frameSequence++;
        for (const check of frameWaiters) check();
      },
      onStep() {},
      onSelected() {},
      onHumanTakeover() {},
    });
    try {
      await runtime.resize(620, 200);
      await runtime.start(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
      const tabA = runtime.getState().activeTabId!;
      const page = (runtime as any).tabs.get(runtime.getState().activeTabId).page;
      await page.call('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
      });
      const waitViewport = (height: number, afterSequence = 0): Promise<void> =>
        new Promise((resolve, reject) => {
          const check = () => {
            if (
              frameSequence > afterSequence &&
              lastFrame?.data &&
              lastFrame.tabId === runtime.getState().activeTabId &&
              lastFrame.width === 620 &&
              lastFrame.height === height &&
              jpegDimensions(lastFrame).width === 1240 &&
              jpegDimensions(lastFrame).height === height * 2
            ) {
              clearTimeout(timer);
              frameWaiters.delete(check);
              resolve();
            }
          };
          const timer = setTimeout(async () => {
            frameWaiters.delete(check);
            const currentPage = (runtime as any).tabs.get(runtime.getState().activeTabId).page;
            const metrics = await currentPage.call('Runtime.evaluate', {
              expression:
                '({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,visibility:document.visibilityState})',
              returnByValue: true,
            });
            reject(
              new Error(
                `Viewport ${height} never reached the frame stream: ${JSON.stringify({ lastFrame: lastFrame && { width: lastFrame.width, height: lastFrame.height, hasImage: Boolean(lastFrame.data), tabId: lastFrame.tabId }, activeTabId: runtime.getState().activeTabId, metrics: metrics.result.value })}`,
              ),
            );
          }, 2500);
          frameWaiters.add(check);
          check();
        });
      await waitViewport(200);
      const target = (await runtime.queryElements({ selector: '#moving' })).elements[0];
      await runtime.editElement(target.ref, {
        styles: { background: 'linear-gradient(135deg,#d9363e,#9f1239)' },
        animation: {
          keyframes: [
            { styles: { transform: 'translateY(0px)', opacity: '0.7' } },
            { styles: { transform: 'translateY(-6px)', opacity: '1' } },
          ],
          duration: 1600,
          iterations: 'infinite',
          direction: 'alternate',
        },
      });
      for (const height of [350, 200, 500, 350, 200, 350]) {
        await runtime.resize(620, height);
        await waitViewport(height);
      }
      for (let round = 0; round < 3; round++) {
        await waitViewport(350, frameSequence);
        const tabB = await runtime.newTab(
          `http://127.0.0.1:${(server.address() as { port: number }).port}/b`,
        );
        await waitViewport(350);
        const beforeReturn = frameSequence;
        await runtime.switchTab(tabA);
        await runtime.resize(620, 500);
        await waitViewport(500, beforeReturn);
        await runtime.closeTab(tabB.id);
        await runtime.resize(620, 350);
        await waitViewport(350);
      }
    } finally {
      await runtime.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);
test(
  'real BrowserOS neo: gradients and owned motion are one reversible preview',
  { skip: !binary, timeout: 40_000 },
  async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'workbench-motion-test-'));
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(
        `<!doctype html><title>Motion fixture</title><style>body{padding:60px;font:18px system-ui}</style><button id="demo-button" style="background-color:rgb(20,40,80);color:white;padding:16px 32px;border-radius:6px;box-shadow:none;transform:none">Preview button</button><script>window.siteMotion=document.querySelector('#demo-button').animate([{letterSpacing:'0px'},{letterSpacing:'1px'}],{duration:2000,iterations:Infinity});window.siteMotion.id='fixture-site-motion';</script>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const steps: RecordedStep[] = [];
    const runtime = new BrowserRuntime({
      storageDir,
      binaryPath: binary,
      onState() {},
      onFrame() {},
      onStep: (step) => steps.push(step),
      onSelected() {},
      onHumanTakeover() {},
    });
    const waitFor = async <T>(
      read: () => Promise<T>,
      accept: (value: T) => boolean,
    ): Promise<T> => {
      for (let i = 0; i < 100; i++) {
        const value = await read();
        if (accept(value)) return value;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('Expected animation state did not arrive');
    };
    const animation: ElementAnimation = {
      keyframes: [
        { offset: 0, styles: { transform: 'translateY(0px)', opacity: '0.7' } },
        { offset: 1, styles: { transform: 'translateY(-6px)', opacity: '1' } },
      ],
      duration: 800,
      iterations: 'infinite',
      easing: 'ease-in-out',
      direction: 'alternate',
    };
    try {
      await runtime.start(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
      const page = (runtime as any).tabs.get(runtime.getState().activeTabId).page;
      await page.call('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
      });
      const element = (
        await waitFor(
          () => runtime.queryElements({ selector: '#demo-button' }),
          (result) => result.elements.length === 1,
        )
      ).elements[0];
      const stats = async () => {
        const result = await page.call('Runtime.evaluate', {
          expression: `(()=>{const el=document.querySelector('#demo-button');const animations=el.getAnimations();return{css:el.style.cssText,sitePresent:animations.includes(window.siteMotion),siteState:window.siteMotion.playState,transform:getComputedStyle(el).transform,owned:animations.filter(a=>a.id.startsWith('workbench-preview:')).map(a=>({state:a.playState,time:a.currentTime,keyframes:a.effect.getKeyframes()}))};})()`,
          returnByValue: true,
        });
        return result.result.value as {
          css: string;
          sitePresent: boolean;
          siteState: string;
          transform: string;
          owned: Array<{
            state: string;
            time: number | null;
            keyframes: Array<Record<string, unknown>>;
          }>;
        };
      };
      const before = await stats();
      runtime.startRecording();
      runtime.allowAgentControl();
      const changes = {
        styles: {
          'background-image': 'linear-gradient(135deg, #e34b56 0%, #981b42 100%)',
          'box-shadow': '0 10px 24px rgba(40, 12, 25, 0.3)',
        },
        animation,
      };
      const result = await runtime.callTool('workbench_browser_edit', {
        ref: element.ref,
        ...changes,
      });
      assert(!result.isError, result.text);
      const edit = JSON.parse(result.text);
      assert.match(edit.element.computed['background-image'], /linear-gradient/);
      assert.notEqual(edit.element.computed['box-shadow'], 'none');
      assert.equal(edit.element.animationState, 'running');
      assert.deepEqual(edit.element.animation, animation);
      assert.deepEqual(
        runtime.getState().previewEdits?.find((item) => item.editId === edit.editId)?.changes
          .animation,
        animation,
      );
      const moving = await waitFor(
        stats,
        (value) =>
          value.owned.length === 1 &&
          value.owned[0].state === 'running' &&
          Number(value.owned[0].time) > 0,
      );
      assert(moving.sitePresent && moving.siteState === 'running');
      assert(moving.owned[0].keyframes.some((frame) => String(frame.transform).includes('-6px')));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const later = await stats();
      assert(
        Number(later.owned[0].time) > Number(moving.owned[0].time),
        'Native WAAPI time must actually advance',
      );
      assert.notEqual(later.transform, 'none');
      const recorded = await waitFor(
        async () => steps.find((step) => step.kind === 'edit' && step.editId === edit.editId),
        Boolean,
      );
      assert.deepEqual(JSON.parse(recorded!.value!).animation, animation);
      const undo = await runtime.callTool('workbench_browser_undo', { editId: edit.editId });
      assert(!undo.isError, undo.text);
      const restored = await stats();
      assert.equal(restored.css, before.css);
      assert.equal(restored.owned.length, 0);
      assert(
        restored.sitePresent && restored.siteState === 'running',
        'Undo must preserve the website-owned Animation',
      );

      const motion = await runtime.editElement(element.ref, { animation });
      const stop = await runtime.editElement(element.ref, { animation: null });
      assert.equal((await stats()).owned.length, 0);
      assert.equal(stop.element.animation, null);
      assert((await stats()).sitePresent);
      const resumed = await runtime.undoEdit(stop.editId);
      assert.deepEqual(resumed.element.animation, animation);
      assert.equal((await stats()).owned.length, 1);
      await runtime.undoEdit(motion.editId);

      await page.call('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      const reduced = await runtime.editElement(element.ref, { animation });
      assert.equal(reduced.element.animationState, 'reduced-motion');
      assert.deepEqual(reduced.element.animation, animation);
      assert.equal(
        (await stats()).owned.length,
        0,
        'Reduced-motion must not be reported as playing',
      );
      assert((await stats()).sitePresent);
      await runtime.undoEdit(reduced.editId);

      for (const bad of [
        { ...animation, duration: 0 },
        { ...animation, keyframes: [animation.keyframes[0]] },
        {
          ...animation,
          keyframes: [
            { offset: 0.8, styles: { opacity: '0.2' } },
            { offset: 0.2, styles: { opacity: '1' } },
          ],
        },
        { ...animation, easing: 'steps(1, jump-none)' },
        {
          ...animation,
          keyframes: [{ styles: { opacity: 'var(--private)' } }, { styles: { opacity: '1' } }],
        },
        {
          ...animation,
          keyframes: [
            { styles: { transform: 'translateY(0px) !important' } },
            { styles: { transform: 'translateY(2px)' } },
          ],
        },
      ]) {
        runtime.allowAgentControl();
        const rejected = await runtime.callTool('workbench_browser_edit', {
          ref: element.ref,
          styles: { color: 'red' },
          animation: bad,
        });
        assert(rejected.isError, 'Invalid animation must reject the whole combined patch');
        assert.equal((await stats()).css, before.css);
      }
      const blocked = await runtime.callTool('workbench_browser_edit', {
        ref: element.ref,
        styles: { 'background-image': 'url(https://invalid.test/never-fetch)' },
      });
      assert(blocked.isError);
      assert.equal((await stats()).css, before.css);
      runtime.stopRecording();
      await runtime.reload();
      runtime.allowAgentControl();
      assert(
        (await runtime.callTool('workbench_browser_edit', { ref: element.ref, animation })).isError,
        'A stale ref must not animate a replacement document',
      );
    } finally {
      await runtime.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);
test(
  'real BrowserOS neo: cross-origin frames and open shadows keep exact element scope',
  { skip: !binary, timeout: 50_000 },
  async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'workbench-frames-test-'));
    const child = createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(
        '<!doctype html><title>Child frame</title><style>body{margin:12px;font:18px system-ui}.spacer{height:350px}</style><div class="spacer"></div><h2 id="frame-heading">Frame heading</h2><label>Frame value<input id="frame-input"></label><button id="frame-save">Save frame</button><p id="frame-status">waiting</p><script>document.querySelector("#frame-save").onclick=()=>document.querySelector("#frame-status").textContent="saved "+document.querySelector("#frame-input").value;</script>',
      );
    });
    await new Promise<void>((resolve) => child.listen(0, '127.0.0.1', resolve));
    const childUrl = `http://localhost:${(child.address() as { port: number }).port}/`;
    const parent = createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(
        `<!doctype html><title>Parent frame</title><style>body{margin:20px;font:18px system-ui}iframe{width:600px;height:260px;border:6px solid #aaa}#offscreen{margin-top:900px;pointer-events:none}#cover{position:fixed;inset:0;background:#fff;z-index:1000;display:none}</style><h1 id="parent-heading">Parent heading</h1><button id="show-cover">Show overlay</button><div id="shadow-host"></div><p id="offscreen">Offscreen selectable text</p><iframe id="frame" src="${childUrl}"></iframe><iframe style="display:none" src="${childUrl}?hidden=1"></iframe><div id="cover">Overlay</div><script>document.querySelector('#shadow-host').attachShadow({mode:'open'}).innerHTML='<p id="shadow-note">Shadow text</p>';document.querySelector('#show-cover').onclick=()=>document.querySelector('#cover').style.display='block';</script>`,
      );
    });
    await new Promise<void>((resolve) => parent.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(parent.address() as { port: number }).port}/`;
    let selected: ElementRef | undefined;
    const runtime = new BrowserRuntime({
      storageDir,
      binaryPath: binary,
      onState() {},
      onFrame() {},
      onStep() {},
      onSelected: (element) => {
        selected = element;
      },
      onHumanTakeover() {},
    });
    const find = async (
      selector: string,
      accept: (elements: ElementRef[]) => boolean = (elements) => elements.length > 0,
    ): Promise<ElementRef[]> => {
      let latest: unknown;
      for (let i = 0; i < 70; i++) {
        try {
          const result = await runtime.queryElements({ selector });
          latest = result;
          if (accept(result.elements)) return result.elements;
        } catch (error) {
          latest = String(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      throw new Error(`Missing frame element ${selector}: ${JSON.stringify(latest)}`);
    };
    try {
      await runtime.resize(760, 650);
      await runtime.start(origin);
      const parentHeading = (await find('#parent-heading'))[0];
      const shadow = (await find('#shadow-note'))[0];
      assert.equal(shadow.shadowPath?.length, 1);
      const shadowEdit = await runtime.editElement(shadow.ref, { text: 'Updated shadow' });
      assert.equal(shadowEdit.element.textContent, 'Updated shadow');
      await runtime.undoEdit(shadowEdit.editId);
      const offscreen = (await find('#offscreen'))[0];
      const revealed = await runtime.selectElement(offscreen.ref);
      assert(
        revealed.bounds!.y >= 0 && revealed.bounds!.y < 650,
        'Search selection must reveal noninteractive offscreen elements',
      );
      const frameHeading = (await find('#frame-heading'))[0];
      assert.notEqual(frameHeading.frameId, parentHeading.frameId);
      const frameDetail = await runtime.selectElement(frameHeading.ref);
      assert(
        frameDetail.bounds!.y >= 0 && frameDetail.bounds!.y < 650,
        'Both iframe owner and child element must be scrolled into view',
      );
      const point = {
        x: frameDetail.bounds!.x + frameDetail.bounds!.width / 2,
        y: frameDetail.bounds!.y + frameDetail.bounds!.height / 2,
      };
      await runtime.setInspect(true);
      await runtime.dispatchInput({
        type: 'mouse',
        action: 'down',
        tabId: runtime.getState().activeTabId,
        ...point,
      });
      await runtime.dispatchInput({
        type: 'mouse',
        action: 'up',
        tabId: runtime.getState().activeTabId,
        ...point,
      });
      assert.equal(selected?.frameId, frameHeading.frameId);
      assert.equal(selected?.selector, '#frame-heading');
      const frameInput = (await find('#frame-input'))[0];
      runtime.allowAgentControl();
      const filled = await runtime.callTool('workbench_browser_fill', {
        ref: frameInput.ref,
        value: 'frame value',
      });
      assert(!filled.isError, filled.text);
      const save = (await find('#frame-save'))[0];
      const clicked = await runtime.callTool('workbench_browser_click', { ref: save.ref });
      assert(!clicked.isError, clicked.text);
      await find('#frame-status', (elements) => elements[0]?.text === 'saved frame value');
      const show = (await find('#show-cover'))[0];
      assert(!(await runtime.callTool('workbench_browser_click', { ref: show.ref })).isError);
      const blocked = await runtime.callTool('workbench_browser_click', { ref: save.ref });
      assert(blocked.isError, 'A parent overlay must block clicks into its iframe');
      const snapshot = JSON.parse((await runtime.snapshot()).text);
      assert(
        snapshot.frames.some(
          (frame: any) => frame.frameId === frameHeading.frameId && frame.documentId,
        ),
      );
    } finally {
      await runtime.dispose();
      await Promise.all(
        [parent, child].map(
          (server) => new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      );
      await rm(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);
test(
  'real BrowserOS neo: tabs preserve pages, reject stale input and record cross-tab edits',
  { skip: !binary, timeout: 40_000 },
  async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'workbench-tabs-test-'));
    const fixture = createServer((request, response) => {
      const name = request.url === '/b' ? 'Beta' : request.url === '/popup' ? 'Popup' : 'Alpha';
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(
        `<!doctype html><title>${name}</title><style>body{font:18px system-ui;padding:20px}button{padding:12px}</style><h1 id="heading">${name} heading</h1><button id="outer"><span id="inner">Nested text</span></button><a id="popup" href="/popup" target="_blank">Open popup</a><p id="status">untouched</p><script>document.querySelector('#outer').onclick=()=>document.querySelector('#status').textContent='clicked';</script>`,
      );
    });
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
    const frames: BrowserFrame[] = [];
    const steps: RecordedStep[] = [];
    let takeovers = 0;
    const runtime = new BrowserRuntime({
      storageDir,
      binaryPath: binary,
      onState() {},
      onFrame: (frame) => frames.push(frame),
      onStep: (step) => steps.push(step),
      onSelected() {},
      onHumanTakeover: () => {
        takeovers++;
      },
    });
    const until = async <T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> => {
      for (let i = 0; i < 100; i++) {
        try {
          const value = await read();
          if (accept(value)) return value;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      throw new Error('Expected tab state did not arrive');
    };
    const heading = () => runtime.queryElements({ selector: '#heading' });
    try {
      await runtime.start(`${origin}/a`);
      const tabA = runtime.getState().activeTabId!;
      const initial = await until(heading, (value) => value.elements[0]?.text === 'Alpha heading');
      assert.equal(runtime.listTabs().length, 1);
      runtime.startRecording();
      const detail = await runtime.getElementDetails(initial.elements[0].ref);
      assert.equal(detail.tag, 'h1');
      const edited = await runtime.editElement(detail.ref, {
        text: 'Edited heading',
        styles: { color: 'rgb(255, 0, 0)' },
      });
      assert.equal(edited.element.textContent, 'Edited heading');
      assert.equal(edited.element.computed.color, 'rgb(255, 0, 0)');
      const previews = runtime.getState().previewEdits!;
      assert.deepEqual(previews, [
        {
          editId: edited.editId,
          tabId: tabA,
          frameId: edited.element.frameId,
          documentId: edited.element.documentId,
          nodeId: detail.nodeId,
          changes: { text: 'Edited heading', styles: { color: 'rgb(255, 0, 0)' } },
        },
      ]);
      const previewTab = await runtime.newTab(`${origin}/b`);
      assert.deepEqual(
        runtime.getState().previewEdits,
        [],
        'Another tab must not inherit preview history',
      );
      await runtime.switchTab(tabA);
      assert.deepEqual(
        runtime.getState().previewEdits,
        previews,
        'Preview metadata must survive tab activation changes',
      );
      const sameNode = (await heading()).elements[0];
      assert.equal(sameNode.nodeId, detail.nodeId);
      assert.notEqual(
        sameNode.ref,
        detail.ref,
        'Stable node metadata must not make old action refs reusable',
      );
      await runtime.closeTab(previewTab.id);
      const undone = await runtime.undoEdit(edited.editId);
      assert.equal(undone.element.textContent, 'Alpha heading');
      assert.deepEqual(
        runtime.getState().previewEdits,
        [],
        'Undo must remove the runtime preview metadata',
      );
      const longText = '\"\n\t'.repeat(5000);
      const longEdit = await runtime.editElement(undone.element.ref, { text: longText });
      const longStep = await until(
        async () => steps.find((step) => step.kind === 'edit' && step.editId === longEdit.editId),
        (step) => Boolean(step),
      );
      assert.equal(
        JSON.parse(longStep!.value!).text,
        longText,
        'Long/escaped edit recordings must remain complete, valid JSON',
      );
      await runtime.undoEdit(longEdit.editId);
      const inner = (await runtime.queryElements({ selector: '#inner' })).elements[0];
      await runtime.selectElement(inner.ref);
      assert.equal(runtime.getState().selectedElement?.selector, '#inner');
      assert(JSON.parse((await runtime.snapshot()).text).text.includes('untouched'));
      const staleRef = inner.ref;
      const tabB = await runtime.newTab(`${origin}/b`);
      await until(heading, (value) => value.elements[0]?.text === 'Beta heading');
      assert.equal(runtime.getState().activeTabId, tabB.id);
      assert.equal(runtime.listTabs().length, 2);
      assert(
        frames.some((frame) => frame.tabId === tabB.id && frame.data === ''),
        'Switch must clear the old page frame',
      );
      const takeoverCount = takeovers;
      await assert.rejects(
        runtime.dispatchInput({ type: 'mouse', action: 'down', x: 10, y: 10, tabId: tabA }),
        /旧标签页/,
      );
      assert.equal(takeovers, takeoverCount, 'Stale input must not take control of the new page');
      assert((await runtime.callTool('workbench_browser_inspect', { ref: staleRef })).isError);
      assert((await runtime.callTool('workbench_browser_snapshot', { tabId: tabA })).isError);
      await runtime.switchTab(tabA);
      const restored = await until(heading, (value) => value.elements[0]?.text === 'Alpha heading');
      await Promise.all([runtime.switchTab(tabB.id), runtime.switchTab(tabA)]);
      assert.equal(
        runtime.getState().activeTabId,
        tabA,
        'The last queued manual tab choice must win',
      );
      await until(heading, (value) => value.elements[0]?.text === 'Alpha heading');
      assert.notEqual(restored.elements[0].ref, initial.elements[0].ref);
      assert((await runtime.callTool('workbench_browser_click', { ref: staleRef })).isError);
      runtime.allowAgentControl();
      // Hold the actual bridge at its asynchronous boundary, then exercise public human takeover.
      const internals = runtime as any;
      const originalBridge = internals.bridge.bind(runtime);
      for (const kind of ['edit', 'undo'] as const) {
        const current = (await heading()).elements[0];
        let undoId: string | undefined;
        if (kind === 'undo')
          undoId = (await runtime.editElement(current.ref, { text: 'Retained edit' })).editId;
        const before = (await heading()).elements[0];
        let release!: () => void;
        let arrived!: () => void;
        const atBoundary = new Promise<void>((resolve) => {
          arrived = resolve;
        });
        internals.bridge = async (...args: any[]) => {
          if (String(args[2]).includes(`.__workbenchPage.${kind}(`)) {
            arrived();
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          return originalBridge(...args);
        };
        runtime.allowAgentControl();
        const pending = runtime.callTool(
          `workbench_browser_${kind}`,
          kind === 'edit' ? { ref: before.ref, text: 'Must not apply' } : { editId: undoId },
        );
        await atBoundary;
        const manual = runtime.switchTab(tabA);
        release();
        const result = await pending;
        await manual;
        internals.bridge = originalBridge;
        assert(
          result.isError,
          `${kind} must recheck the lease immediately before applying its change`,
        );
        assert.equal(
          (await runtime.getElementDetails(before.ref)).textContent,
          kind === 'edit' ? 'Alpha heading' : 'Retained edit',
        );
        if (undoId) await runtime.undoEdit(undoId);
      }
      runtime.allowAgentControl();
      const stoppedRef = (await heading()).elements[0].ref;
      let releaseStop!: () => void;
      let reachedStop!: () => void;
      const stoppingBoundary = new Promise<void>((resolve) => {
        reachedStop = resolve;
      });
      internals.bridge = async (...args: any[]) => {
        if (String(args[2]).includes('.__workbenchPage.edit(')) {
          reachedStop();
          await new Promise<void>((resolve) => {
            releaseStop = resolve;
          });
        }
        return originalBridge(...args);
      };
      const stoppedEdit = runtime.callTool('workbench_browser_edit', {
        ref: stoppedRef,
        text: 'Old turn must not resume',
      });
      await stoppingBoundary;
      const beforeRevoke = takeovers;
      runtime.revokeAgentControl();
      runtime.allowAgentControl();
      releaseStop();
      assert(
        (await stoppedEdit).isError,
        'Allowing the next turn must not revive a revoked generation',
      );
      internals.bridge = originalBridge;
      assert.equal(takeovers, beforeRevoke, 'Revocation must not call the human takeover callback');
      assert.equal((await runtime.getElementDetails(stoppedRef)).textContent, 'Alpha heading');
      const beforeAgentSwitch = takeovers;
      assert(!(await runtime.callTool('workbench_browser_switch_tab', { tabId: tabB.id })).isError);
      assert.equal(takeovers, beforeAgentSwitch);
      assert.equal(runtime.getState().activeTabId, tabB.id);
      assert(!(await runtime.callTool('workbench_browser_switch_tab', { tabId: tabA })).isError);
      const popup = (await runtime.queryElements({ selector: '#popup' })).elements[0];
      assert(
        !(await runtime.callTool('workbench_browser_click', { ref: popup.ref, tabId: tabA }))
          .isError,
      );
      const popupTab = await until(
        async () => runtime.listTabs().find((tab) => tab.url === `${origin}/popup`),
        (value) => Boolean(value),
      );
      assert(popupTab);
      assert.equal(
        runtime.getState().activeTabId,
        tabA,
        'Popup must not silently retarget ongoing Agent operations',
      );
      assert.equal(runtime.getState().url, `${origin}/a`);
      const activePage = (runtime as any).tabs.get(tabA).page;
      const visibility = await activePage.call('Runtime.evaluate', {
        expression: 'document.visibilityState',
        returnByValue: true,
      });
      assert.equal(
        visibility.result.value,
        'visible',
        'A background popup must not hide the embedded active page',
      );
      const beforePopupPaint = frames.length;
      const status = (await runtime.queryElements({ selector: '#status' })).elements[0];
      assert(
        !(
          await runtime.callTool('workbench_browser_edit', {
            ref: status.ref,
            text: 'Popup kept the first page visible',
          })
        ).isError,
      );
      await until(
        async () =>
          frames
            .slice(beforePopupPaint)
            .some((frame) => frame.tabId === tabA && Boolean(frame.data)),
        Boolean,
      );
      await runtime.switchTab(popupTab.id);
      await until(heading, (value) => value.elements[0]?.text === 'Popup heading');
      await runtime.closeTab(popupTab.id);
      assert(!runtime.listTabs().some((tab) => tab.id === popupTab.id));
      const recording = runtime.stopRecording();
      assert(recording.steps.some((step) => step.kind === 'edit' && step.tabId === tabA));
      assert(recording.steps.some((step) => step.kind === 'undo' && step.tabId === tabA));
      assert(recording.steps.some((step) => step.kind === 'navigate' && step.tabId === tabB.id));
      assert(recording.steps.every((step) => Boolean(step.tabId)));
    } finally {
      await runtime.dispose();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
      await rm(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);
test(
  'real BrowserOS neo: initial navigation does not take control from an Agent',
  { skip: !binary, timeout: 20_000 },
  async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'workbench-startup-test-'));
    let requestArrived!: () => void;
    let releaseInitial: (() => void) | undefined;
    const requested = new Promise<void>((resolve) => {
      requestArrived = resolve;
    });
    const fixture = createServer((request, response) => {
      const reply = () => {
        if (response.writableEnded) return;
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(`<!doctype html><title>Startup fixture</title><h1>${request.url}</h1>`);
      };
      if (request.url === '/initial') {
        releaseInitial = reply;
        requestArrived();
      } else reply();
    });
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
    let takeovers = 0;
    const runtime = new BrowserRuntime({
      storageDir,
      binaryPath: binary,
      onState() {},
      onFrame() {},
      onStep() {},
      onSelected() {},
      onHumanTakeover: () => {
        takeovers++;
      },
    });
    let started: Promise<void> | undefined;
    try {
      started = runtime.start(`${origin}/initial`);
      await Promise.race([requested, started]);
      assert(releaseInitial, 'Startup must request the initial page');
      const readyBeforeInitialResponse = runtime.getState().status === 'ready';
      runtime.allowAgentControl();
      releaseInitial!();
      await started;
      assert.equal(takeovers, 0, 'Automatic initial navigation must not notify human takeover');
      assert.equal(
        readyBeforeInitialResponse,
        false,
        'The browser must not advertise ready before its initial navigation',
      );
      assert.equal(runtime.getState().url, `${origin}/initial`);
      assert(
        !(await runtime.callTool('workbench_browser_navigate', { url: `${origin}/agent` })).isError,
        'Startup must preserve Agent control',
      );
      assert.equal(takeovers, 0);
      await runtime.navigate(`${origin}/manual`);
      assert.equal(takeovers, 1, 'A genuine address change must still take control');
      await runtime.start(`${origin}/initial`);
      for (let i = 0; i < 100 && runtime.getState().url !== `${origin}/manual`; i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        runtime.getState().url,
        `${origin}/manual`,
        'An already-ready browser must not reload the startup URL',
      );
      assert(
        (await runtime.callTool('workbench_browser_navigate', { url: `${origin}/agent` })).isError,
      );
    } finally {
      releaseInitial?.();
      await started?.catch(() => {});
      await runtime.dispose();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
      await rm(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);
test(
  'real BrowserOS neo: history restoration keeps snapshots, recording and agent input usable',
  { skip: !binary, timeout: 40_000 },
  async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'workbench-history-test-'));
    const serve = (name: string) =>
      createServer((_request, response) => {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.setHeader('Cache-Control', 'max-age=600');
        response.end(
          `<!doctype html><title>History ${name}</title><h1>Page ${name}</h1><label>Draft ${name}<input id="draft-${name}"></label><output id="restored">fresh</output><script>addEventListener('pageshow',event=>document.querySelector('#restored').textContent=event.persisted?'restored-from-bfcache':'fresh');</script>`,
        );
      });
    const a = serve('A');
    const b = serve('B');
    await Promise.all(
      [a, b].map(
        (server) => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)),
      ),
    );
    const urlA = `http://127.0.0.1:${(a.address() as { port: number }).port}/`;
    const urlB = `http://localhost:${(b.address() as { port: number }).port}/`;
    const observedSteps: RecordedStep[] = [];
    const runtime = new BrowserRuntime({
      storageDir,
      binaryPath: binary,
      onState() {},
      onFrame() {},
      onStep: (step) => observedSteps.push(step),
      onSelected() {},
      onHumanTakeover() {},
    });
    const snapshot = async () =>
      JSON.parse((await runtime.snapshot()).text) as { text: string; elements: ElementRef[] };
    const loaded = async (title: string) => {
      for (let i = 0; i < 100; i++) {
        const state = runtime.getState();
        if (state.title === title && !state.loading) return;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      assert.fail(`History navigation did not finish: ${JSON.stringify(runtime.getState())}`);
    };
    try {
      await runtime.start();
      await runtime.navigate(urlA);
      await loaded('History A');
      const first = await snapshot();
      runtime.allowAgentControl();
      assert(
        !(
          await runtime.callTool('workbench_browser_fill', {
            ref: first.elements.find((el) => el.selector === '#draft-A')!.ref,
            value: 'draft before leaving',
          })
        ).isError,
      );
      await runtime.navigate(urlB);
      await loaded('History B');
      const away = await snapshot();
      await runtime.back();
      await loaded('History A');
      const restored = await snapshot();
      assert(
        restored.text.includes('restored-from-bfcache'),
        'The regression must exercise BFCache, not a replacement reload',
      );
      assert.equal(
        restored.elements.find((el) => el.selector === '#draft-A')!.value,
        'draft before leaving',
      );
      runtime.startRecording();
      runtime.allowAgentControl();
      assert(
        (
          await runtime.callTool('workbench_browser_fill', {
            ref: away.elements.find((el) => el.selector === '#draft-B')!.ref,
            value: 'wrong page',
          })
        ).isError,
      );
      assert(
        !(
          await runtime.callTool('workbench_browser_fill', {
            ref: restored.elements.find((el) => el.selector === '#draft-A')!.ref,
            value: 'agent after back',
          })
        ).isError,
      );
      const bounds = restored.elements.find((el) => el.selector === '#draft-A')!.bounds!;
      const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      await runtime.dispatchInput({ type: 'mouse', action: 'down', ...point });
      await runtime.dispatchInput({ type: 'mouse', action: 'up', ...point });
      await runtime.dispatchInput({ type: 'text', text: '-human' });
      // Native input acknowledgement can precede the asynchronous recorder binding event.
      for (
        let i = 0;
        i < 100 &&
        !observedSteps.some(
          (step) =>
            step.source === 'human' && step.kind === 'fill' && step.value?.includes('-human'),
        );
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      const recording = runtime.stopRecording();
      assert(
        recording.steps.some(
          (step) =>
            step.kind === 'fill' && step.source === 'agent' && step.value === 'agent after back',
        ),
      );
      assert(
        recording.steps.some(
          (step) =>
            step.kind === 'fill' && step.source === 'human' && step.value?.includes('-human'),
        ),
      );
      assert.equal(
        recording.steps.filter(
          (step) => step.kind === 'click' && step.target?.selector === '#draft-A',
        ).length,
        1,
        'Restoring the bridge must not duplicate event listeners',
      );
      await runtime.forward();
      await loaded('History B');
      assert((await snapshot()).text.includes('restored-from-bfcache'));
      await runtime.back();
      await loaded('History A');
      assert(
        (await snapshot()).elements
          .find((el) => el.selector === '#draft-A')!
          .value?.includes('-human'),
      );
    } finally {
      await runtime.dispose();
      await Promise.all(
        [a, b].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
      await rm(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);
test(
  'real BrowserOS neo: embedded frames, tools, recording, inspection and stale references',
  { skip: !binary, timeout: 60_000 },
  async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'workbench-neo-test-'));
    const fixture = createServer((_req, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(
        `<!doctype html><title>Browser fixture</title><style>body{font:18px system-ui;padding:24px}input,select,button{padding:8px;margin:8px}</style><h1>客户表单</h1><label>客户<input id="customer"></label><label>密码<input id="password" type="password"></label><button id="save">保存</button><p role="status" id="status">尚未保存</p><script>document.querySelector('#save').onclick=()=>{document.querySelector('#status').textContent='已保存 '+document.querySelector('#customer').value;window.saveCount=(window.saveCount||0)+1;}</script>`,
      );
    });
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    const port = (fixture.address() as { port: number }).port;
    const frames: BrowserFrame[] = [];
    const steps: RecordedStep[] = [];
    let selected: ElementRef | undefined;
    let takeovers = 0;
    const runtime = new BrowserRuntime({
      storageDir,
      binaryPath: binary,
      onState() {},
      onFrame: (frame) => frames.push(frame),
      onStep: (step) => steps.push(step),
      onSelected: (element) => {
        selected = element;
      },
      onHumanTakeover: () => {
        takeovers++;
      },
    });
    async function eventually<T>(fn: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
      let latest: T;
      for (let i = 0; i < 70; i++) {
        try {
          latest = await fn();
          if (accept(latest)) return latest;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('Expected browser state did not arrive');
    }
    const snapshot = async () =>
      JSON.parse((await runtime.snapshot()).text) as {
        documentId: string;
        text: string;
        elements: ElementRef[];
      };
    try {
      await runtime.start();
      assert.equal(runtime.getState().engine, 'browseros');
      assert.equal(runtime.getState().status, 'ready');
      await runtime.resize(760, 650);
      await runtime.navigate(`http://127.0.0.1:${port}/`);
      const initial = await eventually(snapshot, (value) =>
        value.elements.some((el) => el.selector === '#customer'),
      );
      runtime.startRecording();
      runtime.allowAgentControl();
      const customer = initial.elements.find((el) => el.selector === '#customer')!;
      const password = initial.elements.find((el) => el.selector === '#password')!;
      const save = initial.elements.find((el) => el.selector === '#save')!;
      assert(
        !(
          await runtime.callTool('workbench_browser_fill', { ref: customer.ref, value: '本地客户' })
        ).isError,
      );
      assert(
        !(
          await runtime.callTool('workbench_browser_fill', {
            ref: password.ref,
            value: 'never-export-this',
          })
        ).isError,
      );
      assert(!(await runtime.callTool('workbench_browser_click', { ref: save.ref })).isError);
      const after = await eventually(snapshot, (value) => value.text.includes('已保存 本地客户'));
      assert.equal(after.elements.find((el) => el.selector === '#password')!.value, '[hidden]');
      assert(!JSON.stringify(after).includes('never-export-this'));
      const png = await runtime.screenshot();
      assert(png.image && Buffer.from(png.image, 'base64').subarray(1, 4).toString() === 'PNG');
      await eventually(
        async () => frames.length,
        (length) => length > 1,
      );
      assert(frames.at(-1)!.data.startsWith('data:image/jpeg;base64,'));
      const retinaFrame = await eventually(
        async () => frames.at(-1)!,
        (frame) =>
          frame?.width === 760 &&
          frame?.height === 650 &&
          jpegDimensions(frame).width === 1520 &&
          jpegDimensions(frame).height === 1300,
      );
      assert.deepEqual(jpegDimensions(retinaFrame), { width: 1520, height: 1300 });
      assert.equal(Buffer.from(png.image!, 'base64').readUInt32BE(16), 1520);
      await runtime.setInspect(true);
      const point = after.elements.find((el) => el.selector === '#save')!.bounds!;
      await runtime.dispatchInput({
        type: 'mouse',
        action: 'down',
        x: point.x + point.width / 2,
        y: point.y + point.height / 2,
      });
      await runtime.dispatchInput({
        type: 'mouse',
        action: 'up',
        x: point.x + point.width / 2,
        y: point.y + point.height / 2,
      });
      assert.equal(selected?.selector, '#save');
      assert.equal(takeovers, 2); // Address navigation and explicit inspector click.
      assert((await runtime.callTool('workbench_browser_click', { ref: save.ref })).isError);
      const diagnostics = (await runtime.callTool('workbench_browser_diagnostics', {})).text;
      assert(diagnostics.includes('Human takeover: navigate'));
      assert(diagnostics.includes('Human takeover: mouse-down'));
      assert(!diagnostics.includes('never-export-this'));
      const recording = runtime.stopRecording();
      assert(recording.steps.some((step) => step.kind === 'fill' && step.source === 'agent'));
      assert(
        recording.steps.some((step) => step.kind === 'click' && step.target?.selector === '#save'),
      );
      assert(!JSON.stringify(recording).includes('never-export-this'));
      assert.equal(
        recording.steps.filter((step) => step.kind === 'click' && step.target?.selector === '#save')
          .length,
        1,
        'Inspector must not activate the button',
      );
      await runtime.resize(1280, 900);
      const cappedFrame = await eventually(
        async () => frames.at(-1)!,
        (frame) =>
          frame?.width === 1280 &&
          frame?.height === 900 &&
          jpegDimensions(frame).width === 2048 &&
          jpegDimensions(frame).height === 1440,
      );
      const cappedPixels = jpegDimensions(cappedFrame);
      assert(
        cappedPixels.width <= 2048 && cappedPixels.height <= 2048,
        'Preview physical pixels must stay within the maximum edge',
      );
      assert(
        cappedPixels.width > cappedFrame.width,
        'Large viewports should retain extra pixel density',
      );
      runtime.allowAgentControl();
      const largeSnapshot = await snapshot();
      const largeInput = largeSnapshot.elements.find((el) => el.selector === '#customer')!;
      assert(
        !(
          await runtime.callTool('workbench_browser_fill', { ref: largeInput.ref, value: '大视口' })
        ).isError,
      );
      const largeButton = largeSnapshot.elements.find((el) => el.selector === '#save')!.bounds!;
      const largePoint = {
        x: largeButton.x + largeButton.width / 2,
        y: largeButton.y + largeButton.height / 2,
      };
      await runtime.dispatchInput({ type: 'mouse', action: 'down', ...largePoint });
      await runtime.dispatchInput({ type: 'mouse', action: 'up', ...largePoint });
      await eventually(snapshot, (value) => value.text.includes('已保存 大视口'));
      await runtime.reload();
      await eventually(snapshot, (value) => value.documentId !== initial.documentId);
      runtime.allowAgentControl();
      assert(
        (await runtime.callTool('workbench_browser_click', { ref: save.ref })).isError,
        'References must expire on navigation',
      );
      assert(
        (
          await runtime.callTool('workbench_browser_click', {
            ref: selected!.ref,
            selector: '#save',
          })
        ).isError,
        'Extra arguments cannot bypass refs',
      );
    } finally {
      await runtime.dispose();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
      await rm(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);

test(
  'real BrowserOS neo: hover, selection, iframe cleanup and drag input use native targets',
  { skip: !binary, timeout: 30_000 },
  async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'workbench-hover-test-'));
    const fixture = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      const port = (fixture.address() as { port: number }).port;
      response.end(
        request.url?.startsWith('/child')
          ? '<!doctype html><style>body{padding:20px}button{padding:16px}</style><button id="child">Frame target</button>'
          : `<!doctype html><title>Selection preview</title><style>body{font:18px system-ui;margin:40px;min-height:1600px}button{padding:14px 28px}iframe{display:block;margin-top:40px;width:400px;height:160px}#drag{width:max-content;margin-top:26px}</style><button id="target">Preview this button</button><p id="drag">Native drag selection stays available.</p><iframe src="http://localhost:${port}/child"></iframe><article id="below" style="height:240px">Below the fold</article><script>window.clicks=0;window.moves=[];target.onclick=()=>window.clicks++;document.addEventListener('mousemove',event=>window.moves.push({x:event.clientX,buttons:event.buttons}));window.dragOrder=[];for(const type of ['mousedown','mousemove','mouseup'])document.addEventListener(type,event=>window.dragOrder.push(type));</script>`,
      );
    });
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    let takeovers = 0;
    const runtime = new BrowserRuntime({
      storageDir,
      binaryPath: binary,
      onState() {},
      onFrame() {},
      onStep() {},
      onSelected() {},
      onHumanTakeover() {
        takeovers++;
      },
    });
    const until = async (read: () => Promise<any>, valid: (result: any) => boolean) => {
      const end = Date.now() + 4000;
      while (Date.now() < end) {
        const result = await read();
        if (valid(result)) return result;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('Selection condition did not become true');
    };
    try {
      await runtime.start(`http://127.0.0.1:${(fixture.address() as { port: number }).port}/`);
      const tab = (runtime as any).tabs.get(runtime.getState().activeTabId);
      const evaluate = async (expression: string) =>
        (await tab.page.call('Runtime.evaluate', { expression, returnByValue: true })).result.value;
      const target = (await runtime.queryElements({ selector: '#target' })).elements[0];
      const child = await until(
        () => runtime.queryElements({ selector: '#child' }),
        (value) => value.elements.length === 1,
      ).then((result) => result.elements[0]);
      await runtime.setInspect(true);
      const read = async (element: ElementRef, kind: string) => {
        const frame = tab.frames.get(element.frameId);
        return (runtime as any).bridge(
          tab,
          frame,
          `(()=>{const box=globalThis.__testOverlayRoot?.querySelector('[data-kind="${kind}"]');if(!box)return null;const rect=box.getBoundingClientRect();return {visible:getComputedStyle(box).display!=='none',x:rect.x,y:rect.y,width:rect.width,height:rect.height,label:box.querySelector('span')?.textContent,phase:box.className};})()`,
        );
      };
      for (const frame of tab.frames.values())
        await (runtime as any).bridge(
          tab,
          frame,
          `(()=>{const original=Element.prototype.attachShadow;Element.prototype.attachShadow=function(init){const root=original.call(this,init);if(this.hasAttribute('data-workbench-overlay'))globalThis.__testOverlayRoot=root;return root;};})()`,
        );
      const point = (element: ElementRef) => ({
        x: element.bounds!.x + element.bounds!.width / 2,
        y: element.bounds!.y + element.bounds!.height / 2,
      });
      await runtime.dispatchInput({ type: 'mouse', action: 'move', ...point(target), buttons: 0 });
      const hover = await until(
        () => read(target, 'hover'),
        (value) => value?.visible,
      );
      assert(Math.abs(hover.x - target.bounds!.x) < 1);
      assert.equal(takeovers, 0, 'Hover must never take control from Agent');
      assert.equal(await evaluate('clicks'), 0);
      const nativeHover = await evaluate('document.querySelector("#target").matches(":hover")');
      assert.equal(nativeHover, true, 'Forwarded hover must still reach the website');
      await runtime.dispatchInput({ type: 'mouse', action: 'move', ...point(child), buttons: 0 });
      await until(
        () => read(child, 'hover'),
        (value) => value?.visible,
      );
      await until(
        () => read(target, 'hover'),
        (value) => !value?.visible,
      );
      await runtime.dispatchInput({ type: 'mouse', action: 'leave', x: 0, y: 0 });
      await until(
        () => read(child, 'hover'),
        (value) => !value?.visible,
      );
      await runtime.dispatchInput({ type: 'mouse', action: 'move', ...point(target), buttons: 0 });
      await runtime.dispatchInput({
        type: 'mouse',
        action: 'down',
        ...point(target),
        button: 'left',
        buttons: 1,
      });
      await runtime.dispatchInput({
        type: 'mouse',
        action: 'up',
        ...point(target),
        button: 'left',
        buttons: 0,
      });
      assert.equal(runtime.getState().selectedElement?.nodeId, target.nodeId);
      assert.equal(runtime.getState().inspecting, false);
      assert.equal(await evaluate('clicks'), 0, 'Selecting must not activate a website button');
      assert.equal(await evaluate('scrollY'), 0, 'Pointer selection must not recenter the page');
      await until(
        () => read(target, 'selected'),
        (value) => value?.visible,
      );
      await runtime.setElementFeedback(target.ref, 'working');
      await until(
        () => read(target, 'feedback'),
        (value) => value?.visible,
      );
      runtime.allowAgentControl();
      assert(
        !(
          await runtime.callTool('workbench_browser_edit', {
            ref: target.ref,
            styles: { 'border-radius': '18px' },
          })
        ).isError,
      );
      await runtime.setElementFeedback(target.ref, null);
      assert.equal(
        (await read(target, 'feedback')).phase,
        'box feedback applied',
        'Turn completion must not cut off success feedback',
      );
      await until(
        () => read(target, 'feedback'),
        (value) => !value?.visible,
      );
      await runtime.setInspect(true);
      await runtime.dispatchInput({ type: 'mouse', action: 'move', ...point(target), buttons: 0 });
      const below = (await runtime.queryElements({ selector: '#below' })).elements[0];
      await runtime.dispatchInput({
        type: 'wheel',
        ...point(target),
        deltaX: 0,
        deltaY: Math.round(below.bounds!.y - target.bounds!.y),
      });
      await until(
        () => read(target, 'hover'),
        (value) => value?.visible && value.label.startsWith('article'),
      );
      await evaluate('scrollTo(0,0)');
      await runtime.dispatchInput({
        type: 'key',
        action: 'down',
        key: 'Escape',
        code: 'Escape',
        keyCode: 27,
      });
      assert.equal(runtime.getState().inspecting, false);
      const drag = (await runtime.queryElements({ selector: '#drag' })).elements[0].bounds!;
      await evaluate('dragOrder=[]');
      (runtime as any).queue = new Promise((resolve) => setTimeout(resolve, 100));
      const down = runtime.dispatchInput({
        type: 'mouse',
        action: 'down',
        x: drag.x + 2,
        y: drag.y + drag.height / 2,
        button: 'left',
        buttons: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 16));
      const move = runtime.dispatchInput({
        type: 'mouse',
        action: 'move',
        x: drag.x + drag.width - 2,
        y: drag.y + drag.height / 2,
        button: 'left',
        buttons: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 16));
      const up = runtime.dispatchInput({
        type: 'mouse',
        action: 'up',
        x: drag.x + drag.width - 2,
        y: drag.y + drag.height / 2,
        button: 'left',
        buttons: 0,
      });
      await Promise.all([down, move, up]);
      assert.deepEqual(await evaluate('dragOrder'), ['mousedown', 'mousemove', 'mouseup']);
      assert(
        (await evaluate('String(getSelection())')).length > 10,
        'Mouse move coalescing must preserve drag selection',
      );
      const moves = await evaluate('moves');
      assert(moves.some((move: { buttons: number }) => move.buttons === 1));
      await runtime.selectElement(child.ref);
      await runtime.setInspect(true);
      await evaluate('document.querySelector("iframe").src += "?next"');
      await until(
        () => Promise.resolve(runtime.getState()),
        (value) => !value.selectedElement,
      );
      assert.equal(
        runtime.getState().inspecting,
        true,
        'Child navigation must keep UI and local inspection flags consistent',
      );
      await runtime.dispatchInput({ type: 'mouse', action: 'move', ...point(target), buttons: 0 });
      await until(
        () => read(target, 'hover'),
        (value) => value?.visible,
      );
      const previousTab = runtime.getState().activeTabId!;
      const second = await runtime.newTab();
      await runtime.switchTab(previousTab);
      assert.equal(runtime.getState().inspecting, false);
      assert.equal(
        await evaluate('document.querySelectorAll("[data-workbench-overlay]").length'),
        0,
      );
      await runtime.closeTab(second.id);
    } finally {
      await runtime.dispose();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
      await rm(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);

test('hover forwarding keeps only the latest point without waiting for an Agent action', async () => {
  const runtime = new BrowserRuntime({
    storageDir: '/unused-hover-test',
    onState() {},
    onFrame() {},
    onStep() {},
    onSelected() {},
    onHumanTakeover() {
      assert.fail('Hover cannot take over');
    },
  }) as any;
  const calls: number[] = [];
  let release!: () => void;
  runtime.state.status = 'ready';
  runtime.activeTabId = 'tab';
  runtime.tabs.set('tab', {
    info: { id: 'tab' },
    page: {
      call: async (name: string, args: any) => {
        assert.equal(name, 'Input.dispatchMouseEvent');
        calls.push(args.x);
        if (calls.length === 1)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
      },
    },
  });
  runtime.queue = new Promise(() => {});
  const promises = Array.from({ length: 80 }, (_, x) =>
    runtime.dispatchInput({ type: 'mouse', action: 'move', x, y: 20, buttons: 0 }),
  );
  assert.deepEqual(calls, [0]);
  release();
  await Promise.all(promises);
  assert.deepEqual(
    calls,
    [0, 79],
    'A burst must forward the initial and latest point, never a backlog',
  );
});

test('leaving a stalled hover cannot block page actions or clear a newer hover', async () => {
  for (const next of ['reenter', 'switch-tab']) {
    const runtime = new BrowserRuntime({
      storageDir: '/unused-hover-test',
      onState() {},
      onFrame() {},
      onStep() {},
      onSelected() {},
      onHumanTakeover() {},
    }) as any;
    let release!: () => void;
    let moveCount = 0,
      clearCount = 0;
    const page = {
      call: async (name: string) => {
        if (name === 'Input.dispatchMouseEvent' && ++moveCount === 1)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        if (name === 'Runtime.evaluate') clearCount++;
        return {};
      },
    };
    const tab = {
      info: { id: 'tab' },
      activation: 1,
      diagnostics: [],
      frames: new Map([['frame', { id: 'frame', contextId: 1, channel: page }]]),
      page,
    };
    runtime.state.status = 'ready';
    runtime.activeTabId = 'tab';
    runtime.tabs.set('tab', tab);
    runtime.refs.set('selected', { tabId: 'tab' });
    const started: string[] = [];
    runtime.queryInternal = async () => {
      started.push('query');
      return {};
    };
    runtime.selectElementInternal = async () => {
      started.push('select');
      return {};
    };
    const pending = runtime.dispatchInput({
      type: 'mouse',
      action: 'move',
      x: 10,
      y: 10,
      buttons: 0,
    });
    const leave = runtime.dispatchInput({ type: 'mouse', action: 'leave', x: 0, y: 0 });
    const query = runtime.queryElements({}),
      select = runtime.selectElement('selected');
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(
        started,
        ['query', 'select'],
        'An unresolved hover acknowledgement must not hold the action queue',
      );
      await Promise.all([leave, query, select]);
      assert.equal(clearCount, 1);
      if (next === 'reenter')
        void runtime.dispatchInput({ type: 'mouse', action: 'move', x: 30, y: 30, buttons: 0 });
      else tab.activation += 2;
      release();
      await pending;
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(clearCount, 1, `Late hover cleanup must not affect ${next}`);
    } finally {
      release();
      await pending;
    }
  }
});

test('prepared frames reuse their world while checking document identity once per call', async () => {
  const runtime = new BrowserRuntime({
    storageDir: '/unused-context-test',
    onState() {},
    onFrame() {},
    onStep() {},
    onSelected() {},
    onHumanTakeover() {},
  }) as any;
  const calls: string[] = [];
  const frame = {
    id: 'frame',
    contextId: 7,
    documentId: 'document',
    revision: 1,
    channel: {
      call: async (method: string) => {
        calls.push(method);
        assert.equal(method, 'Runtime.evaluate');
        return { result: { value: { ready: true, documentId: 'document' } } };
      },
    },
  };
  const tab = { info: { id: 'tab' }, frames: new Map([['frame', frame]]), edits: [] };
  runtime.tabs.set('tab', tab);
  assert.equal((await runtime.prepareFrame(tab, frame)).contextId, 7);
  assert.equal((await runtime.prepareFrame(tab, frame)).contextId, 7);
  assert.deepEqual(calls, ['Runtime.evaluate', 'Runtime.evaluate']);
});

test('a destroyed cached context is recreated and a changed document invalidates old references', async () => {
  const runtime = new BrowserRuntime({
    storageDir: '/unused-context-test',
    onState() {},
    onFrame() {},
    onStep() {},
    onSelected() {},
    onHumanTakeover() {},
  }) as any;
  const calls: Array<{ method: string; contextId?: number }> = [];
  const frame = {
    id: 'frame',
    contextId: 7 as number | undefined,
    documentId: 'old-document',
    revision: 1,
    channel: {
      call: async (method: string, params: any) => {
        calls.push({ method, contextId: params.contextId });
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 9 };
        if (params.contextId === 7) throw new Error('Cannot find context with specified id');
        if (params.expression.includes('ready:'))
          return { result: { value: { ready: true, documentId: 'new-document' } } };
        return { result: { value: undefined } };
      },
    },
  };
  const tab = {
    info: { id: 'tab' },
    frames: new Map([['frame', frame]]),
    edits: [{ frameId: 'frame' }],
  };
  runtime.tabs.set('tab', tab);
  runtime.refs.set('old-ref', { tabId: 'tab', frameId: 'frame' });
  assert.equal((await runtime.prepareFrame(tab, frame)).contextId, 9);
  assert.equal(frame.documentId, 'new-document');
  assert.equal(frame.revision, 2);
  assert.equal(runtime.refs.has('old-ref'), false);
  assert.equal(tab.edits.length, 0);
  assert.deepEqual(
    calls.map((value) => value.method),
    ['Runtime.evaluate', 'Page.createIsolatedWorld', 'Runtime.evaluate', 'Runtime.evaluate'],
  );
});

test('frame channel migration discards cached IDs and ignores late events from the prior owner', async () => {
  const runtime = new BrowserRuntime({
    storageDir: '/unused-owner-test',
    onState() {},
    onFrame() {},
    onStep() {},
    onSelected() {},
    onHumanTakeover() {},
  }) as any;
  const handlers = new Map<string, (value: any) => void>();
  const oldChannel = {
    on: (name: string, fn: (value: any) => void) => handlers.set(name, fn),
    call: async (name: string) => {
      if (name === 'Page.getFrameTree')
        return { frameTree: { frame: { id: 'frame', url: 'https://example.test' } } };
      return { result: { value: { ready: true, documentId: 'old-document' } } };
    },
  };
  const calls: Array<{ name: string; contextId?: number }> = [];
  const newChannel = {
    on() {},
    call: async (name: string, params: any = {}) => {
      calls.push({ name, contextId: params.contextId });
      if (name === 'Page.createIsolatedWorld') return { executionContextId: 99 };
      return {
        result: {
          value: {
            ready: true,
            documentId: params.contextId === 7 ? 'foreign-document' : 'new-document',
          },
        },
      };
    },
  };
  const frame = {
    id: 'frame',
    url: 'https://example.test',
    channel: oldChannel,
    contextId: 7,
    documentId: 'old-document',
    revision: 1,
    source: 'human',
  };
  const tab = {
    info: { id: 'tab' },
    page: oldChannel,
    frames: new Map([['frame', frame]]),
    channels: new Set(),
    children: new Set(),
    edits: [{ frameId: 'frame' }],
  };
  runtime.tabs.set('tab', tab);
  runtime.refs.set('old-ref', { tabId: 'tab', frameId: 'frame' });
  await runtime.installChannel(tab, oldChannel);
  runtime.registerFrame(tab, { id: 'frame', url: 'https://other.test' }, newChannel);
  assert.equal(frame.contextId, undefined);
  assert.equal(frame.documentId, undefined);
  assert.equal(runtime.refs.has('old-ref'), false);
  assert.equal(tab.edits.length, 0);
  const prepared = await runtime.prepareFrame(tab, frame);
  assert.equal(prepared.channel, newChannel);
  assert.equal(prepared.contextId, 99);
  assert.equal(frame.documentId, 'new-document');
  assert.equal(
    calls.some((value) => value.contextId === 7),
    false,
    'A channel-local ID must never be sent to the new owner',
  );
  handlers.get('Runtime.executionContextCreated')!({
    context: { id: 99, name: 'workbench-browser-observer', auxData: { frameId: 'frame' } },
  });
  assert.equal(frame.contextId, 99);
  handlers.get('Runtime.executionContextDestroyed')!({ executionContextId: 99 });
  assert.equal(
    frame.contextId,
    99,
    'An old channel must not invalidate the new owner’s same numeric ID',
  );
  handlers.get('Runtime.executionContextCreated')!({
    context: { id: 77, name: 'workbench-browser-observer', auxData: { frameId: 'frame' } },
  });
  assert.equal(frame.contextId, 99, 'Late old-world creation cannot replace the cache');
  let recorded = 0;
  runtime.recordEvent = () => {
    recorded++;
  };
  handlers.get('Runtime.bindingCalled')!({
    name: '__workbenchEvent',
    executionContextId: 77,
    payload: JSON.stringify({ kind: 'click', docId: 'new-document' }),
  });
  assert.equal(recorded, 0);
  handlers.get('Runtime.executionContextsCleared')!({});
  assert.equal(frame.contextId, 99);
});

test('an in-flight world validation cannot overwrite a frame that changed channel', async () => {
  const runtime = new BrowserRuntime({
    storageDir: '/unused-owner-test',
    onState() {},
    onFrame() {},
    onStep() {},
    onSelected() {},
    onHumanTakeover() {},
  }) as any;
  let release!: (value: any) => void;
  const oldChannel = {
    call: async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    on() {},
  };
  const newCalls: Array<{ name: string; contextId?: number }> = [];
  const newChannel = {
    call: async (name: string, params: any) => {
      newCalls.push({ name, contextId: params.contextId });
      return { result: { value: { ready: true, documentId: 'new-document' } } };
    },
    on() {},
  };
  const frame = {
    id: 'frame',
    channel: oldChannel,
    contextId: 7 as number | undefined,
    documentId: 'old-document' as string | undefined,
    revision: 1,
  };
  const tab = {
    info: { id: 'tab' },
    page: oldChannel,
    frames: new Map([['frame', frame]]),
    children: new Set(),
    edits: [],
  };
  runtime.tabs.set('tab', tab);
  const pending = runtime.prepareFrame(tab, frame);
  runtime.registerFrame(tab, { id: 'frame' }, newChannel);
  frame.contextId = 99;
  release({ result: { value: { ready: true, documentId: 'old-document' } } });
  const prepared = await pending;
  assert.equal(prepared.channel, newChannel);
  assert.equal(prepared.contextId, 99);
  assert.equal(frame.contextId, 99);
  assert.equal(frame.documentId, 'new-document');
  assert(newCalls.every((value) => value.contextId === 99));
});

test('bridge rejects migration after preparation without sending or replaying an action', async () => {
  const runtime = new BrowserRuntime({
    storageDir: '/unused-owner-test',
    onState() {},
    onFrame() {},
    onStep() {},
    onSelected() {},
    onHumanTakeover() {},
  }) as any;
  let actions = 0;
  const oldChannel = {
      call: async () => {
        actions++;
        return {};
      },
      on() {},
    },
    newChannel = { ...oldChannel };
  const frame = {
    id: 'frame',
    channel: oldChannel,
    contextId: 7,
    documentId: 'old-document',
    revision: 1,
  };
  const tab = {
    info: { id: 'tab' },
    page: oldChannel,
    frames: new Map([['frame', frame]]),
    children: new Set(),
    edits: [],
  };
  runtime.tabs.set('tab', tab);
  runtime.prepareFrame = async () => {
    const prepared = { channel: oldChannel, contextId: 7, revision: 1 };
    runtime.registerFrame(tab, { id: 'frame' }, newChannel);
    return prepared;
  };
  await assert.rejects(
    runtime.bridge(
      tab,
      frame,
      'globalThis.__workbenchPage.edit({ref:"old-ref",text:"must not apply"})',
    ),
    /页面框架已改变/,
  );
  assert.equal(actions, 0);
});

test(
  'real BrowserOS neo: fit width reveals a fixed desktop page and preserves scaled input',
  { skip: !binary, timeout: 30_000 },
  async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'workbench-fit-width-test-'));
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      const wide = request.url !== '/responsive';
      const minimum = request.url === '/oversized' ? 3000 : 1100;
      const gutter = request.url === '/gutter';
      response.end(`<!doctype html><title>${wide ? 'Desktop width' : 'Responsive width'}</title><style>
${gutter ? 'html{overflow-y:scroll}::-webkit-scrollbar{width:20px}' : ''}
body{margin:0;${wide ? `min-width:${minimum}px;` : ''}${gutter ? 'min-height:2000px;' : ''}font:20px system-ui}header{display:flex;align-items:center;gap:24px;padding:28px}strong{width:170px}input{width:${wide ? '680px' : '100%'};min-width:0;box-sizing:border-box}button{flex:none;width:110px}#result{margin:28px}
</style><header>${wide ? '<strong>Search</strong>' : ''}<input value="kept input"/><button id="right" onclick="document.querySelector('#result').textContent='clicked'">Search</button></header><div id="result">not clicked</div>${gutter ? '<div id="edge" style="position:absolute;left:1060px;width:40px;height:40px"></div>' : ''}`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    let latestFrame: BrowserFrame | undefined;
    const runtime = new BrowserRuntime({
      storageDir,
      binaryPath: binary,
      onState() {},
      onFrame(frame) {
        if (frame.data) latestFrame = frame;
      },
      onStep() {},
      onSelected() {},
      onHumanTakeover() {},
    });
    const evaluate = async (expression: string) => {
      const state = runtime.getState();
      const page = (runtime as any).tabs.get(state.activeTabId).page;
      const result = await page.call('Runtime.evaluate', { expression, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    };
    const metrics = () =>
      evaluate(
        `(()=>{const rect=document.querySelector('#right').getBoundingClientRect();return{width:innerWidth,height:innerHeight,clientWidth:document.documentElement.clientWidth,edgeRight:document.querySelector('#edge')?.getBoundingClientRect().right,contentWidth:document.documentElement.scrollWidth,right:rect.right,x:rect.x+rect.width/2,y:rect.y+rect.height/2,value:document.querySelector('input').value,bodyStyle:document.body.getAttribute('style')}})()`,
      );
    const waitFor = async <T>(read: () => Promise<T>, matches: (value: T) => boolean) => {
      const end = Date.now() + 8000;
      while (Date.now() < end) {
        try {
          const value = await read();
          if (matches(value)) return value;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.fail('Expected fitted page state did not arrive');
    };
    try {
      await runtime.start();
      await runtime.resize(620, 490);
      await runtime.navigate(origin);
      await waitFor(metrics, (value) => value.contentWidth === 1100);
      assert.ok(
        (await metrics()).right > 620,
        'The initial 620px viewport must reproduce the clipped button',
      );
      const tabId = runtime.getState().activeTabId!;
      const fit = await runtime.resize(620, 490, { fitToWidth: true, tabId });
      const fitted = await metrics();
      assert.ok(
        fitted.right <= fitted.width,
        'Fit width must reveal the clipped desktop search button',
      );
      assert.deepEqual(fit, { width: 1100, height: 869, tabId, limited: false });
      assert.equal(fitted.width, 1100);
      assert.equal(fitted.height, 869);
      assert.equal(fitted.value, 'kept input');
      assert.equal(fitted.bodyStyle, null, 'Fitting must not inject page zoom or styles');
      const scale = 620 / fit.width;
      const displayed = { x: fitted.x * scale, y: fitted.y * scale };
      await runtime.dispatchInput({
        type: 'mouse',
        action: 'down',
        x: displayed.x / scale,
        y: displayed.y / scale,
      });
      await runtime.dispatchInput({
        type: 'mouse',
        action: 'up',
        x: displayed.x / scale,
        y: displayed.y / scale,
      });
      assert.equal(await evaluate("document.querySelector('#result').textContent"), 'clicked');

      const tall = await runtime.resize(390, 650, { fitToWidth: true, tabId });
      assert.deepEqual(tall, { width: 1100, height: 1833, tabId, limited: false });
      const frame = await waitFor(
        async () => latestFrame,
        (value) => {
          if (value?.width !== 1100 || value.height !== 1833) return false;
          const pixels = jpegDimensions(value);
          return Math.abs(pixels.width / pixels.height - 1100 / 1833) < 0.002;
        },
      );
      assert.ok(frame);
      const pixels = jpegDimensions(frame);
      assert.ok(pixels.width <= 2048 && pixels.height <= 2048);
      assert.ok(Math.abs(pixels.width / pixels.height - 1100 / 1833) < 0.002);
      assert.equal((await metrics()).height, 1833);

      await runtime.navigate(origin + '/responsive');
      await waitFor(
        () => evaluate('document.title'),
        (title) => title === 'Responsive width',
      );
      const responsive = await runtime.resize(390, 650, { fitToWidth: true, tabId });
      assert.deepEqual(responsive, { width: 390, height: 650, tabId, limited: false });
      assert.equal(
        (await metrics()).contentWidth,
        390,
        'Responsive navigation must return to the pane width',
      );
      await runtime.navigate(origin + '/gutter');
      await waitFor(metrics, (value) => value.edgeRight === 1100);
      const gutterFit = await runtime.resize(620, 490, { fitToWidth: true, tabId });
      const gutterPage = await metrics();
      assert.ok(
        gutterPage.edgeRight <= gutterPage.clientWidth,
        'Fit must include the vertical scrollbar gutter',
      );
      assert.deepEqual(gutterFit, { width: 1120, height: 885, tabId, limited: false });
      await runtime.navigate(origin + '/oversized');
      await waitFor(metrics, (value) => value.contentWidth === 3000);
      const limited = await runtime.resize(390, 650, { fitToWidth: true, tabId });
      assert.deepEqual(limited, { width: 1920, height: 3200, tabId, limited: true });
      const second = await runtime.newTab(origin);
      await waitFor(
        () => evaluate('document.title'),
        (title) => title === 'Desktop width',
      );
      const before = await metrics();
      await assert.rejects(runtime.resize(600, 400, { fitToWidth: true, tabId }), /标签页/);
      assert.deepEqual(
        await metrics(),
        before,
        'A stale tab resize must not alter the active page',
      );
      await runtime.switchTab(tabId);
      const switching = runtime.switchTab(second.id);
      const staleQueued = runtime.resize(620, 490, { fitToWidth: true, tabId });
      await switching;
      await assert.rejects(staleQueued, /标签页/);
      assert.equal((await metrics()).width, before.width);
    } finally {
      await runtime.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(storageDir, { recursive: true, force: true });
    }
  },
);
