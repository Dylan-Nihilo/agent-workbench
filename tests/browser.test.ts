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

const binary = process.env.WORKBENCH_BROWSEROS_TEST_BINARY;
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
          await runtime.callTool('workbench_browser_fill', { ref: customer.ref, value: '诺瓦客户' })
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
      const after = await eventually(snapshot, (value) => value.text.includes('已保存 诺瓦客户'));
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
