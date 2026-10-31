import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserRuntime } from '../src/main/browser';
import { validateElementControls } from '../src/shared/element-controls';

test('element catalog rejects unsupported code, oversized input and ambiguous controls before renderer parsing', () => {
  assert.deepEqual(
    validateElementControls([
      { id: 'round', component: 'Slider', property: 'border-radius', max: 64 },
    ]),
    [{ id: 'round', component: 'Slider', property: 'border-radius', min: 0, max: 64, step: 1 }],
  );
  for (const components of [
    Array(25).fill({}),
    [{ id: 'x', component: 'Iframe', property: 'color' }],
    [{ id: 'x', component: 'Slider', property: 'width', min: -1 }],
    [{ id: 'x', component: 'ColorPicker', property: 'color', action: { eval: 'x' } }],
    [{ id: 'x', component: 'ColorPicker', property: '__proto__' }],
    [
      { id: 'x', component: 'ColorPicker', property: 'color' },
      { id: 'x', component: 'ColorPicker', property: 'border-color' },
    ],
  ])
    assert.throws(() => validateElementControls(components));
});
const binary = process.env.WORKBENCH_BROWSEROS_TEST_BINARY;
test(
  'precise semantics and continuous style preview preserve identity, one gesture undo and external changes',
  { skip: !binary, timeout: 40000 },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'athena-elements-'));
    const site = createServer((req, res) => {
      res.setHeader('content-type', 'text/html;charset=utf-8');
      if (req.url === '/child') {
        res.end('<!doctype html><div role=button id=inside style="padding:20px">Frame</div>');
        return;
      }
      res.end(
        '<!doctype html><title>精确编辑</title><style>body{padding:40px}div{padding:16px;margin:10px;background:#336699;border-radius:8px}#custom{cursor:pointer}</style><div role="button" tabindex="0" id="target">开始</div><div id="custom">开始</div><div id="plain">说明</div><script>document.querySelector("#custom").addEventListener("click",()=>{});</script>',
      );
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(site.address() as any).port}`;
    const runtime = new BrowserRuntime({
      storageDir: dir,
      binaryPath: binary,
      onState() {},
      onFrame() {},
      onStep() {},
      onSelected() {},
      onHumanTakeover() {},
    });
    try {
      await runtime.start(url);
      const query = async (selector: string) =>
        (await runtime.queryElements({ selector })).elements[0];
      const target = await query('#target');
      const detail = await runtime.selectElement(target.ref);
      assert.equal(detail.semantics?.kind, 'button');
      assert.equal(detail.semantics?.source, 'accessibility');
      assert(detail.backendNodeId);
      const custom = await runtime.getElementDetails((await query('#custom')).ref);
      assert.equal(custom.semantics?.kind, 'button');
      assert.equal(custom.semantics?.source, 'inferred');
      assert.notEqual(
        (await runtime.getElementDetails((await query('#plain')).ref)).semantics?.kind,
        'button',
      );
      let id: string | undefined;
      const times: number[] = [];
      for (let value = 1; value <= 80; value++) {
        const start = performance.now();
        id = (await runtime.previewStyles(target.ref, { 'border-radius': value + 'px' }, id))
          .editId;
        times.push(performance.now() - start);
      }
      const result = await runtime.commitStyles(target.ref, id!);
      assert.equal(result.element.computed['border-radius'], '80px');
      assert.equal(runtime.getState().previewEdits?.length, 1);
      assert.equal(
        (await runtime.getElementDetails((await query('#custom')).ref)).computed['border-radius'],
        '8px',
      );
      await runtime.undoEdit(id);
      assert.equal((await runtime.getElementDetails(target.ref)).computed['border-radius'], '8px');
      const edit = await runtime.previewStyles(target.ref, { 'border-radius': '22px' });
      const tab = (runtime as any).activeTab();
      await tab.page.call('Runtime.evaluate', {
        expression: 'document.querySelector("#target").style.color="red"',
      });
      await assert.rejects(
        runtime.previewStyles(target.ref, { 'border-radius': '24px' }, edit.editId),
        /changed/,
      );
      await assert.rejects(runtime.undoEdit(edit.editId), /changed/);
      runtime.allowAgentControl();
      const published = await runtime.callTool('workbench_browser_controls', {
        ref: target.ref,
        components: [{ id: 'color', component: 'ColorPicker', property: 'color' }],
      });
      assert(!published.isError, published.text);
      assert.equal(runtime.getState().elementControls?.controls.length, 1);
      await tab.page.call('Runtime.evaluate', {
        expression:
          'document.querySelector("#target").outerHTML="<div id=target role=button>开始</div>"',
      });
      await assert.rejects(
        runtime.previewStyles(target.ref, { color: 'blue' }),
        /stale|removed|失效/,
      );
      await runtime.navigate(url);
      await assert.rejects(runtime.previewStyles(target.ref, { color: 'blue' }), /选区|失效/);
      await tab.page.call('Runtime.evaluate', {
        expression: `document.body.innerHTML='<div id="shadow"></div><iframe src="${url}/child"></iframe><iframe src="${url.replace('127.0.0.1', 'localhost')}/child"></iframe>';document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<div id="shadow-button" role="button">Shadow</div>';`,
      });
      let children: any[] = [];
      for (let attempt = 0; attempt < 100; attempt++) {
        children = (await runtime.queryElements({ selector: '#inside' })).elements;
        if (children.length === 2) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(children.length, 2);
      for (const target of [...children, await query('#shadow-button')]) {
        const detail = await runtime.selectElement(target.ref);
        assert.equal(detail.semantics?.kind, 'button');
        const preview = await runtime.previewStyles(target.ref, { 'border-radius': '13px' });
        assert.equal(
          (await runtime.commitStyles(target.ref, preview.editId)).element.computed[
            'border-radius'
          ],
          '13px',
        );
        await runtime.undoEdit(preview.editId);
      }
      times.sort((a, b) => a - b);
      console.log(
        JSON.stringify({
          metric: 'style_ack_ms',
          count: times.length,
          p50: times[40],
          p95: times[76],
          max: times.at(-1),
        }),
      );
    } finally {
      await runtime.dispose();
      await new Promise<void>((r) => site.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test('live queue merges pending input and discards writes after selection disposal', async () => {
  const { LiveStyleQueue } = await import('../src/renderer/LiveStyleQueue');
  const oldFrame = globalThis.requestAnimationFrame,
    oldCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0) as unknown as number;
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  const calls: Array<{ name: string; payload: any }> = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let commits = 0;
  const queue = new LiveStyleQueue(
    'target',
    async (name, payload) => {
      calls.push({ name, payload });
      if (calls.length === 1) await gate;
      return { editId: 'gesture', element: {} } as any;
    },
    () => commits++,
    (message) => {
      throw Error(message);
    },
  );
  try {
    queue.enqueue('opacity', '0.1');
    const finished = queue.finish();
    for (let i = 2; i <= 100; i++) queue.enqueue('opacity', String(i / 100));
    assert.equal(calls.length, 1);
    release();
    await finished;
    assert.equal(calls.filter((x) => x.name === 'browser:preview-styles').length, 2);
    assert.equal(calls[1].payload.styles.opacity, '1');
    assert.equal(commits, 1);
    queue.enqueue('opacity', '0.5');
    queue.dispose();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls.length, 3);
  } finally {
    queue.dispose();
    globalThis.requestAnimationFrame = oldFrame;
    globalThis.cancelAnimationFrame = oldCancel;
  }
});
