/** Electron → IPC → real neo viewport regression. --before uses the saved 0.2.3 build. */
import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppSnapshot, ElementQueryResult } from '../src/shared/types';

const root = process.cwd();
const before = process.argv.includes('--before');
const appRoot = before ? path.join(root, '.runtime/viewport-before') : root;
const evidence = path.join(root, `test-results/viewport-fit${before ? '-before' : ''}`);
await access(path.join(appRoot, 'dist/main/main.cjs'));
await access(path.join(appRoot, 'resources/demo.html'));
await mkdir(path.join(root, '.runtime'), { recursive: true });
await mkdir(evidence, { recursive: true });
const temporary = await mkdtemp(path.join(root, '.runtime/viewport-ui-'));
const bin = path.join(temporary, 'bin');
await mkdir(bin);
for (const name of ['codex', 'claude', 'opencode', 'gemini']) {
  const file = path.join(bin, name);
  await writeFile(
    file,
    `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('${name} viewport-fixture');process.exit(0)}if(process.argv[2]==='login'){console.error('Logged in using isolated fixture');process.exit(0)}process.exit(2);\n`,
  );
  await chmod(file, 0o700);
}
const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html;charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  const responsive = request.url === '/responsive';
  response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${responsive ? '自适应页面' : '桌面页面'}</title><style>
html{scroll-behavior:auto}*{box-sizing:border-box}body{margin:0;font:16px system-ui;background:#f7f8fb;color:#242a35;${responsive ? '' : 'min-width:1100px;'}}main{position:relative;min-height:3400px;${responsive ? 'width:100%' : 'width:1100px'};padding:32px}h1{margin:0;font-size:28px}p{line-height:1.8;color:#6b7483}button{border:0;border-radius:8px;background:#293d73;color:white;font:inherit;height:42px;width:84px}#right{position:absolute;${responsive ? 'right:20px;' : 'left:1000px;'}top:120px}#counter{position:fixed;left:20px;top:76px;font-size:13px;color:#62718d}#scroll{position:fixed;left:20px;bottom:12px;font-size:12px;color:#62718d}#bottom{position:absolute;left:32px;top:3100px;padding:22px;background:white;border:1px solid #dfe5ef;border-radius:10px}.rule{position:absolute;left:0;right:0;top:180px;height:1px;background:#dfe5ef}
</style><main><h1>项目概览</h1><p>查看今天的进展与待办。</p><button id="right">查看详情</button><span class="rule"></span><section id="bottom">本周计划</section></main><span id="counter">已打开：0</span><span id="scroll">滚动位置：0</span><script>
let count=0;document.querySelector('#right').onclick=()=>document.querySelector('#counter').textContent='已打开：'+(++count);window.addEventListener('scroll',()=>document.querySelector('#scroll').textContent='滚动位置：'+Math.round(scrollY));
</script></html>`);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const application = await electron.launch({
  args: ['.'],
  cwd: appRoot,
  env: {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    WORKBENCH_USER_DATA_DIR: path.join(temporary, 'data'),
    WORKBENCH_BROWSER_PATH: path.resolve(
      '../browseros-runtime/BrowserOS neo.app/Contents/MacOS/BrowserOS neo',
    ),
  },
});
const checks: string[] = [];
const errors: string[] = [];
let geometry: unknown;
try {
  const page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.setSize(1400, 900);
    window.hide();
  });
  const snapshot = () => page.evaluate(() => window.workbench.invoke<AppSnapshot>('app:snapshot'));
  const query = (selector: string) =>
    page.evaluate(
      async (selector) =>
        (await window.workbench.invoke<ElementQueryResult>('browser:query', { selector }))
          .elements[0],
      selector,
    );
  const frameGeometry = () =>
    page.evaluate(async () => {
      const snapshot = await window.workbench.invoke<AppSnapshot>('app:snapshot');
      const surface = document.querySelector('.browser-surface')!.getBoundingClientRect();
      const image = document.querySelector<HTMLImageElement>('.browser-frame')!;
      return {
        surface: { width: surface.width, height: surface.height },
        frame: snapshot.browserFrame
          ? {
              width: snapshot.browserFrame.width,
              height: snapshot.browserFrame.height,
              tabId: snapshot.browserFrame.tabId,
            }
          : undefined,
        pixels: { width: image.naturalWidth, height: image.naturalHeight },
        loading: !!document.querySelector('.frame-loading'),
      };
    });
  const ready = async () => {
    await expect
      .poll(
        async () => {
          const value = await frameGeometry();
          if (!value.frame || !value.pixels.width || value.loading) return Number.POSITIVE_INFINITY;
          return Math.abs(
            (value.frame.height * value.surface.width) / value.frame.width - value.surface.height,
          );
        },
        { timeout: 10000 },
      )
      .toBeLessThanOrEqual(1.5);
    geometry = await frameGeometry();
    const value = geometry as Awaited<ReturnType<typeof frameGeometry>>;
    assert.ok(value.frame);
    assert.ok(
      Math.abs(value.pixels.width / value.pixels.height - value.frame.width / value.frame.height) <
        0.003,
      'The stream must preserve its native aspect ratio',
    );
  };
  const navigate = async (url: string, title: string) => {
    await page.getByRole('textbox', { name: '网页地址', exact: true }).fill(url);
    await page.getByRole('button', { name: '打开网页', exact: true }).click();
    await expect.poll(async () => (await snapshot()).browser.title).toBe(title);
    await expect.poll(async () => (await snapshot()).browser.loading).toBe(false);
    await ready();
  };
  const fit = async () => {
    await expect
      .poll(
        async () => {
          const element = await query('#right');
          const frame = (await snapshot()).browserFrame;
          return frame && element?.bounds
            ? frame.width - (element.bounds.x + element.bounds.width)
            : -10000;
        },
        {
          timeout: 10000,
          message:
            'The fixed-width page right edge must be inside the native viewport, not cropped',
        },
      )
      .toBeGreaterThanOrEqual(0);
    await ready();
  };
  const point = async (selector: string) => {
    const element = await query(selector);
    const frame = (await snapshot()).browserFrame;
    const surface = await page.locator('.browser-surface').boundingBox();
    assert.ok(element?.bounds && frame && surface);
    const scale = surface.width / frame.width;
    const x = surface.x + (element.bounds.x + element.bounds.width / 2) * scale;
    const y = surface.y + (element.bounds.y + element.bounds.height / 2) * scale;
    assert.ok(
      x >= surface.x &&
        x <= surface.x + surface.width &&
        y >= surface.y &&
        y <= surface.y + surface.height,
      'Target must be visible before a native coordinate click',
    );
    return { x, y };
  };
  const capture = async (name: string) => {
    await page.screenshot({ path: path.join(evidence, `${name}.png`) });
    const frame = (await snapshot()).browserFrame!;
    await writeFile(
      path.join(evidence, `${name}-page.jpg`),
      Buffer.from(frame.data.replace(/^data:image\/[^;]+;base64,/, ''), 'base64'),
    );
  };
  await expect
    .poll(async () => (await snapshot()).browser.status, { timeout: 30000 })
    .toBe('ready');
  await page.getByRole('button', { name: '展开浏览器', exact: true }).click();
  await navigate(origin, '桌面页面');
  await capture('initial');
  // This is the original failure gate, before any new zoom control is required.
  await fit();
  await expect(page.getByRole('combobox', { name: '页面缩放', exact: true })).toHaveValue('fit');
  let target = await point('#right');
  await page.mouse.click(target.x, target.y);
  await expect.poll(async () => (await query('#counter')).text).toBe('已打开：1');
  await capture('fit-620');
  checks.push(
    'A 1100px desktop page is completely visible at a 620px pane and its far-right control receives the actual click',
  );

  const separator = await page
    .getByRole('separator', { name: '调整浏览器宽度', exact: true })
    .boundingBox();
  assert.ok(separator);
  await page.mouse.move(separator.x + separator.width / 2, separator.y + 50);
  await page.mouse.down();
  await page.mouse.move(separator.x + separator.width / 2 + 240, separator.y + 50, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await frameGeometry()).surface.width).toBeLessThanOrEqual(390);
  await fit();
  const narrow = await frameGeometry();
  assert.ok(
    narrow.frame!.height > 1400,
    'Tall narrow fit must not silently clamp the virtual viewport to 1400px',
  );
  target = await point('#right');
  await page.mouse.click(target.x, target.y);
  await expect.poll(async () => (await query('#counter')).text).toBe('已打开：2');
  await capture('fit-390');
  checks.push('Narrow tall panes keep both edges and full viewport height with uniform scaling');

  await page.getByRole('button', { name: '选取元素', exact: true }).click();
  target = await point('#right');
  await page.mouse.move(target.x, target.y);
  await page.waitForTimeout(180);
  await capture('fit-hover');
  await page.mouse.click(target.x, target.y);
  await expect
    .poll(async () => (await snapshot()).browser.selectedElement?.selector)
    .toBe('#right');
  await page.getByRole('tab', { name: '内容', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '元素文字', exact: true })).toHaveValue(
    '查看详情',
  );
  assert.equal(
    (await query('#counter')).text,
    '已打开：2',
    'Inspecting must not activate the website control',
  );
  await fit();
  await capture('fit-inspector');
  await page.getByRole('button', { name: '关闭元素检查器', exact: true }).click();
  await fit();
  checks.push(
    'Hover/pick coordinates stay exact through inspector height changes and selection never clicks the page',
  );

  const surface = await page.locator('.browser-surface').boundingBox();
  assert.ok(surface);
  const frame = (await snapshot()).browserFrame!;
  const nativeDelta = (150 * frame.width) / surface.width;
  await page.mouse.move(surface.x + surface.width / 2, surface.y + surface.height / 2);
  await page.mouse.wheel(0, 150);
  await expect
    .poll(async () => Number((await query('#scroll')).text?.split('：')[1]))
    .toBeGreaterThan(nativeDelta - 8);
  const scrolled = Number((await query('#scroll')).text?.split('：')[1]);
  assert.ok(
    Math.abs((scrolled * surface.width) / frame.width - 150) < 10,
    'Wheel movement should remain 150 display pixels at fit scale',
  );
  checks.push(
    'Wheel scrolling uses the same scale as pointing and moves the intended display distance',
  );

  await page.getByRole('combobox', { name: '页面缩放', exact: true }).selectOption('actual');
  await expect
    .poll(async () => {
      const value = await frameGeometry();
      return Math.abs((value.frame?.width ?? 0) - value.surface.width);
    })
    .toBeLessThanOrEqual(1);
  await ready();
  const actual = await frameGeometry();
  assert.ok(
    Math.abs(actual.frame!.width - actual.surface.width) <= 1,
    '100% mode keeps one native CSS pixel per pane pixel',
  );
  await page.getByRole('combobox', { name: '页面缩放', exact: true }).selectOption('fit');
  await fit();
  checks.push(
    '100% and fit modes use their respective native viewport dimensions without stretching',
  );

  const firstId = (await snapshot()).browser.activeTabId;
  await page.getByRole('button', { name: '新建标签页', exact: true }).click();
  await navigate(`${origin}/responsive`, '自适应页面');
  await expect
    .poll(async () => {
      const value = await frameGeometry();
      return Math.abs((value.frame?.width ?? 0) - value.surface.width);
    })
    .toBeLessThanOrEqual(1);
  const responsive = await frameGeometry();
  assert.ok(
    Math.abs(responsive.frame!.width - responsive.surface.width) <= 1,
    'A responsive page without horizontal overflow must stay at 100% in fit mode',
  );
  target = await point('#right');
  await page.mouse.click(target.x, target.y);
  await expect.poll(async () => (await query('#counter')).text).toBe('已打开：1');
  await page.getByRole('tab', { name: '桌面页面', exact: true }).click();
  await expect.poll(async () => (await snapshot()).browser.activeTabId).toBe(firstId);
  await fit();
  await navigate(`${origin}/responsive`, '自适应页面');
  await expect
    .poll(async () => {
      const value = await frameGeometry();
      return Math.abs((value.frame?.width ?? 0) - value.surface.width);
    })
    .toBeLessThanOrEqual(1);
  const replaced = await frameGeometry();
  assert.ok(
    Math.abs(replaced.frame!.width - replaced.surface.width) <= 1,
    'New-document navigation must discard the previous desktop fit width',
  );
  checks.push(
    'Responsive pages retain their layout; tab switches and navigation recalculate the current page fit',
  );
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(evidence, 'result.json'),
    JSON.stringify({ passed: true, checks, errors, geometry }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, checks, evidence }, null, 2));
} catch (error) {
  const page = await application.firstWindow();
  await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  await writeFile(
    path.join(evidence, 'result.json'),
    JSON.stringify({ passed: false, checks, errors, geometry, error: String(error) }, null, 2),
  );
  throw error;
} finally {
  await application.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
