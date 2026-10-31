import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
const dir = await mkdtemp(path.join(root, '.runtime/element-ui-'));
const site = createServer((req, res) => {
  res.setHeader('content-type', 'text/html;charset=utf-8');
  res.end(
    '<!doctype html><meta charset="utf-8"><title>工作计划</title><style>body{font:16px system-ui;margin:40px;color:#202735;background:#f8fafc}h1{font-size:30px}p{color:#6b7483;line-height:1.8}.action{display:inline-block;padding:18px 32px;color:white;background:#336699;border-radius:8px;cursor:pointer;margin:16px 12px 0 0}</style><h1>下一步，从这里开始</h1><p>整理今天的计划，专注最重要的一件事。</p><div role="button" tabindex="0" id="target" class="action" onclick="this.textContent=\'已点击\'">开始整理</div><div role="button" tabindex="0" id="decoy" class="action">开始整理</div>',
  );
});
await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${(site.address() as any).port}`;
const packaged = process.env.ATHENA_TEST_APP;
const app = await electron.launch({
  ...(packaged ? { executablePath: packaged } : {}),
  args: packaged ? [] : ['.'],
  cwd: packaged ? dir : root,
  env: { ...process.env, WORKBENCH_USER_DATA_DIR: path.join(dir, 'data') },
});
const errors: string[] = [];
try {
  const page = await app.firstWindow();
  await page.evaluate('window.__name = (fn) => fn');
  page.on('pageerror', (e) => errors.push(e.message));
  if (packaged) {
    page.on('console', (message) => {
      if (message.text().startsWith('NEO_STATE ')) console.log(message.text());
    });
    await page.evaluate(() =>
      window.workbench.onEvent((event) => {
        if (event.type === 'neo:state') console.log('NEO_STATE ' + JSON.stringify(event.state));
      }),
    );
  }
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.webContents.setBackgroundThrottling(false);
    w.hide();
  });
  const state = () => page.evaluate(() => window.workbench.invoke<any>('app:snapshot'));
  await expect.poll(async () => (await state()).browser.status, { timeout: 30000 }).toBe('ready');
  if (packaged) {
    const deadline = Date.now() + 150000;
    let native;
    do {
      native = (await state()).neo;
      if (native?.status === 'ready' || native?.status === 'error') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.equal(native.status, 'ready', native.error);
  }
  await page.getByRole('button', { name: '展开浏览器', exact: true }).click();
  await page.evaluate((url) => window.workbench.invoke('browser:navigate', { url }), url);
  const selected = await page.evaluate(async () => {
    const q = await window.workbench.invoke<any>('browser:query', { selector: '#target' });
    return window.workbench.invoke<any>('browser:element', { ref: q.elements[0].ref });
  });
  assert.equal(selected.semantics.kind, 'button');
  await expect(page.getByRole('slider', { name: '圆角滑块' })).toBeVisible();
  await expect(page.locator('.inspector-context')).toContainText('按钮');
  const slider = page.getByRole('slider', { name: '圆角滑块' });
  const track = page.locator('.cell-slider').filter({ has: slider }).locator('.cell-slider__track');
  const box = await track.boundingBox();
  assert(box);
  const min = Number(await slider.getAttribute('min'));
  const max = Number(await slider.getAttribute('max'));
  const position = (value: number) => box.x + ((value - min) / (max - min)) * box.width;
  await page.mouse.move(position(8), box.y + box.height / 2);
  await page.mouse.down();
  for (let value = 9; value <= 68; value++)
    await page.mouse.move(position(value), box.y + box.height / 2);
  await page.mouse.up();
  await expect
    .poll(async () => (await state()).browser.selectedElement?.computed?.['border-radius'])
    .toBe('68px');
  assert.equal((await state()).browser.previewEdits.length, 1);
  await page.getByRole('button', { name: '撤销页面修改', exact: true }).click();
  await expect
    .poll(async () => (await state()).browser.selectedElement?.computed?.['border-radius'])
    .toBe('8px');
  await expect(slider).toHaveValue('8');
  // A changed pixel in the decoded embedded image establishes visible feedback, not just an IPC ack.
  await expect(page.locator('.frame-loading')).toHaveCount(0);
  await page.getByRole('button', { name: '背景颜色选择器', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '十六进制颜色' })).toBeVisible();
  await page.screenshot({
    path: path.join(root, 'test-results/heroui-color-popover.png'),
    animations: 'disabled',
  });
  const hex = page.getByRole('textbox', { name: '十六进制颜色' });
  await hex.fill('4F46E5');
  await hex.press('Tab');
  await expect
    .poll(async () => (await state()).browser.selectedElement.computed['background-color'])
    .toBe('rgb(79, 70, 229)');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '撤销页面修改', exact: true }).click();
  await expect
    .poll(async () => (await state()).browser.selectedElement.computed['background-color'])
    .toBe('rgb(51, 102, 153)');
  await page.locator('.live-choice').filter({ hasText: '文字对齐' }).getByRole('button').click();
  await page.getByRole('option', { name: '居中', exact: true }).click();
  await expect
    .poll(async () => (await state()).browser.selectedElement.computed['text-align'])
    .toBe('center');
  await page.getByRole('button', { name: '撤销页面修改', exact: true }).click();
  const samples: number[] = [];
  for (let iteration = 0; iteration < 12; iteration++) {
    const red = iteration % 2 === 1;
    const colorValue = page.getByRole('textbox', { name: '背景颜色颜色值', exact: true });
    await colorValue.fill(red ? '#e04040' : '#20a050');
    const latency = await page.evaluate(async (red) => {
      const picker = document.querySelector(
        'input[aria-label="背景颜色颜色值"]',
      ) as HTMLInputElement;
      const image = document.querySelector('.browser-frame') as HTMLImageElement;
      const state = await window.workbench.invoke<any>('app:snapshot');
      const target = state.browser.selectedElement.bounds;
      const s = state.browserFrame;
      const x = target.x + target.width / 2,
        y = target.y + 8;
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d')!;
      const start = performance.now();
      picker.blur();
      return await new Promise<number>((resolve, reject) => {
        const end = setTimeout(() => reject(Error('New color was never presented')), 5000);
        const frame = async () => {
          try {
            await image.decode();
            ctx.drawImage(
              image,
              Math.floor((x * image.naturalWidth) / s.width),
              Math.floor((y * image.naturalHeight) / s.height),
              1,
              1,
              0,
              0,
              1,
              1,
            );
            const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
            if (red ? r > 180 && g < 110 && b < 110 : g > 130 && r < 90 && b < 120) {
              clearTimeout(end);
              resolve(performance.now() - start);
              return;
            }
          } catch {}
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
    }, red);
    samples.push(latency);
    await expect
      .poll(async () => (await state()).browser.selectedElement?.computed?.['background-color'])
      .toBe(red ? 'rgb(224, 64, 64)' : 'rgb(32, 160, 80)');
  }
  await expect(page.getByRole('button', { name: '撤销页面修改', exact: true })).toBeEnabled();

  const decoy = await page.evaluate(async () => {
    const q = await window.workbench.invoke<any>('browser:query', { selector: '#decoy' });
    return window.workbench.invoke<any>('browser:element-details', { ref: q.elements[0].ref });
  });
  assert.equal(decoy.computed['background-color'], 'rgb(51, 102, 153)');
  assert.equal((await state()).browser.selectedElement.text, '开始整理');
  await page.screenshot({ path: path.join(root, 'test-results/element-controls.png') });
  assert.deepEqual(errors, []);
  const report = {
    passed: true,
    packaged: Boolean(packaged),
    coalescedUpdates: 60,
    undoEntries: 1,
    colorPresentedMs: samples,
    medianMs: [...samples].sort((a, b) => a - b)[6],
    maxMs: Math.max(...samples),
    semantics: selected.semantics,
    errors,
  };
  await writeFile(
    path.join(
      root,
      packaged
        ? 'test-results/element-controls-packaged.json'
        : 'test-results/element-controls-ui.json',
    ),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  await app.close();
  await new Promise<void>((r) => site.close(() => r()));
  await rm(dir, { recursive: true, force: true });
}
