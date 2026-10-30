import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserRuntime, normalizeBrowserUrl, redactBrowserText } from '../src/main/browser';
import type { BrowserFrame, ElementRef, RecordedStep } from '../src/shared/types';

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
