import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AppSnapshot,
  ElementDetails,
  ElementQueryResult,
  ToolResult,
} from '../src/shared/types';

const root = process.cwd();
await mkdir(path.join(root, '.runtime'), { recursive: true });
await mkdir(path.join(root, 'test-results'), { recursive: true });
const temporary = await mkdtemp(path.join(root, '.runtime/workbench-ui-'));
const bin = path.join(temporary, 'bin');
await mkdir(bin);
const log = path.join(temporary, 'protocol.jsonl');
const executable = path.join(bin, 'codex');
await writeFile(
  executable,
  `#!${process.execPath}\n` +
    `
import fs from 'node:fs';import readline from 'node:readline';
const log=${JSON.stringify(log)};
if(process.argv.includes('--version')){console.log('codex-cli workbench-fixture');process.exit(0)}
if(process.argv[2]==='login'){console.error('Logged in using test fixture');process.exit(0)}
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
let turns=0;
readline.createInterface({input:process.stdin}).on('line',line=>{
const r=JSON.parse(line);fs.appendFileSync(log,line+'\\n');
if(r.method==='initialize')return send({id:r.id,result:{userAgent:'fixture'}});
if(r.method==='thread/start'||r.method==='thread/resume')return send({id:r.id,result:{thread:{id:'ui-thread'}}});
if(r.method==='turn/start'){
const turnId='ui-turn-'+(++turns);
send({id:r.id,result:{turn:{id:turnId,status:'inProgress'}}});
send({method:'turn/started',params:{threadId:'ui-thread',turn:{id:turnId}}});
send({method:'item/agentMessage/delta',params:{threadId:'ui-thread',turnId:turnId,itemId:'reply',delta:'元素上下文已收到。'}});
send({method:'turn/completed',params:{threadId:'ui-thread',turnId:turnId,turn:{id:turnId,status:'completed'}}});
}});
`,
);
await chmod(executable, 0o700);
const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  if (request.url === '/two')
    response.end(
      '<!doctype html><title>页面 B</title><h1>第二个页面</h1><a href="/popup" target="_blank">打开新标签</a>',
    );
  else if (request.url === '/popup')
    response.end('<!doctype html><title>弹出页面</title><h1>第三个页面</h1>');
  else
    response.end(
      '<!doctype html><html lang="zh-CN"><title>页面 A</title><style>body{font:16px system-ui;margin:32px;color:#202634}h1{font-size:24px;color:rgb(32,38,52)}.duplicate{padding:8px}input{padding:8px}#add{background:linear-gradient(135deg,#3c5ee8,#123c9f);color:white}</style><h1 data-testid="headline">需要修改的标题</h1><div class="duplicate">相同文字</div><div class="duplicate">相同文字</div><label>任务<input id="task" /></label><button id="add">添加</button></html>',
    );
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const application = await electron.launch({
  args: ['.'],
  cwd: root,
  env: {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    WORKBENCH_USER_DATA_DIR: path.join(temporary, 'data'),
  },
});
const checks: string[] = [];
const errors: string[] = [];
try {
  const page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.hide();
  });
  const snapshot = () => page.evaluate(() => window.workbench.invoke<AppSnapshot>('app:snapshot'));
  const viewportReady = async () =>
    expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const state = await window.workbench.invoke<AppSnapshot>('app:snapshot');
            const bounds = document.querySelector('.browser-surface')!.getBoundingClientRect();
            return Math.max(
              Math.abs((state.browserFrame?.width ?? 0) - Math.floor(bounds.width)),
              Math.abs((state.browserFrame?.height ?? 0) - Math.floor(bounds.height)),
            );
          }),
        { timeout: 10_000 },
      )
      .toBeLessThanOrEqual(1);
  const currentPage = () =>
    page.evaluate(async () =>
      JSON.parse((await window.workbench.invoke<ToolResult>('browser:snapshot')).text),
    );
  await expect
    .poll(async () => (await snapshot()).browser.title, { timeout: 30_000 })
    .toContain('今日清单');
  await page.screenshot({
    path: path.join(root, 'docs/screenshots/chat.png'),
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '展开浏览器', exact: true }).click();
  await expect(page.locator('.browser-drawer')).toHaveAttribute('aria-hidden', 'false');
  await page.waitForFunction(() => {
    const drawer = document.querySelector('.browser-drawer')!;
    return (
      drawer.clientWidth >=
      parseFloat(getComputedStyle(drawer).getPropertyValue('--browser-drawer-width')) - 1
    );
  });
  await expect
    .poll(async () =>
      page.locator('.browser-frame').evaluate((node: HTMLImageElement) => node.naturalWidth),
    )
    .toBeGreaterThan(100);
  await viewportReady();
  await page.screenshot({
    path: path.join(root, 'docs/screenshots/workspace.png'),
    animations: 'disabled',
  });
  const navigate = async (url: string, title: string) => {
    await page.getByRole('textbox', { name: '网页地址', exact: true }).fill(url);
    await page.getByRole('button', { name: '打开网页', exact: true }).click();
    await expect.poll(async () => (await snapshot()).browser.title).toBe(title);
    await expect.poll(async () => (await snapshot()).browser.loading).toBe(false);
  };
  await navigate(`${origin}/one`, '页面 A');
  await expect(page.getByRole('tab', { name: '页面 A', exact: true })).toBeVisible();
  const firstId = (await snapshot()).browser.activeTabId;
  await page.getByRole('button', { name: '录制', exact: true }).click();
  await page.getByRole('button', { name: '元素检查器', exact: true }).click();
  await page.getByRole('combobox', { name: '元素查找方式' }).selectOption('selector');
  await page.getByRole('textbox', { name: '查找页面元素' }).fill('[data-testid="headline"]');
  await page.getByRole('button', { name: '查找', exact: true }).click();
  await page.locator('.element-results > button').filter({ hasText: '需要修改的标题' }).click();
  const text = page.getByRole('textbox', { name: '元素文字', exact: true });
  await expect(text).toHaveValue('需要修改的标题');
  await text.fill('标题已精准修改');
  await page.getByRole('button', { name: '应用预览', exact: true }).click();
  await expect.poll(async () => (await currentPage()).text).toContain('标题已精准修改');
  await page.getByRole('tab', { name: '样式', exact: true }).click();
  await page.getByRole('textbox', { name: '字号', exact: true }).fill('32px');
  await page.getByRole('textbox', { name: '文字颜色', exact: true }).fill('#3c5ee8');
  await page.getByRole('button', { name: '应用预览', exact: true }).click();
  await expect
    .poll(async () => page.getByRole('textbox', { name: '字号', exact: true }).inputValue())
    .toBe('32px');
  assert.equal(
    await page.evaluate(() => window.scrollY),
    0,
    'The workspace must not scroll outside its window',
  );
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const state = await window.workbench.invoke<AppSnapshot>('app:snapshot');
          const bounds = document.querySelector('.browser-surface')!.getBoundingClientRect();
          return Math.max(
            Math.abs((state.browserFrame?.width ?? 0) - Math.floor(bounds.width)),
            Math.abs((state.browserFrame?.height ?? 0) - Math.floor(bounds.height)),
          );
        }),
      { timeout: 10_000 },
    )
    .toBeLessThanOrEqual(1);
  await page.screenshot({
    path: path.join(root, 'test-results/workbench-inspector.png'),
    animations: 'disabled',
  });
  checks.push(
    'Non-interactive heading selected through CSS query, exact text and style previews applied in the real page',
  );

  await page.getByRole('button', { name: '新建标签页', exact: true }).click();
  await expect(page.getByRole('tab', { name: '新标签页', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('button', { name: '打开网页', exact: true })).toBeEnabled();
  await navigate(`${origin}/two`, '页面 B');
  await expect(page.getByRole('tab', { name: '页面 A', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: '页面 B', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: '页面 A', exact: true }).click();
  await expect.poll(async () => (await snapshot()).browser.activeTabId).toBe(firstId);
  await expect.poll(async () => (await currentPage()).text).toContain('标题已精准修改');
  checks.push('Multiple real tabs retain their pages and restore the active page when switched');

  assert.equal((await snapshot()).browser.previewEdits?.length, 2);
  await page.getByRole('button', { name: '查找', exact: true }).click();
  await page.locator('.element-results > button').filter({ hasText: '标题已精准修改' }).click();
  await expect(page.getByRole('button', { name: '撤销页面修改', exact: true })).toBeEnabled();
  await page.getByRole('tab', { name: '样式', exact: true }).click();

  await page.getByRole('button', { name: '修改源码', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '发送给 Agent 的任务' })).toHaveValue(
    /将选中元素.*源码/,
  );
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect
    .poll(async () => (await snapshot()).conversations[0]?.messages.at(-1)?.status)
    .toBe('done');
  const requests = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const input = requests.find((request) => request.method === 'turn/start').params.input[0].text;
  assert.match(input, /标题已精准修改/);
  assert.match(input, /32px/);
  assert.ok(input.includes(firstId!));
  assert.match(input, /data-testid/);
  checks.push(
    'Source-edit handoff carries precise tab, element locator and accumulated preview changes to the local CLI',
  );

  await page.getByRole('button', { name: '撤销页面修改', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '字号', exact: true })).toHaveValue('24px');
  await page.getByRole('button', { name: '撤销页面修改', exact: true }).click();
  await expect.poll(async () => (await currentPage()).text).toContain('需要修改的标题');
  assert.equal((await snapshot()).browser.previewEdits?.length, 0);
  checks.push('Text and CSS previews undo independently without replacing the target element');

  await page.getByRole('textbox', { name: '查找页面元素' }).fill('.duplicate');
  await page.getByRole('button', { name: '查找', exact: true }).click();
  await expect(page.locator('.element-results > button')).toHaveCount(2);
  await page.locator('.element-results > button').first().click();
  await page.getByRole('tab', { name: '内容', exact: true }).click();
  await page.getByRole('textbox', { name: '元素文字', exact: true }).fill('第一处文本预览');
  await page.getByRole('button', { name: '应用预览', exact: true }).click();
  await expect.poll(async () => (await snapshot()).browser.previewEdits?.length).toBe(1);
  await page.getByRole('button', { name: '查找', exact: true }).click();
  await page.locator('.element-results > button').filter({ hasText: '相同文字' }).click();
  await page.getByRole('button', { name: '撤销页面修改', exact: true }).click();
  await expect.poll(async () => (await snapshot()).browser.previewEdits?.length).toBe(0);
  await expect.poll(async () => (await currentPage()).text).not.toContain('第一处文本预览');
  checks.push(
    'Cross-element undo consumes the successful patch even when selection changes before IPC resolves',
  );

  await page.getByRole('textbox', { name: '查找页面元素' }).fill('#add');
  await page.getByRole('button', { name: '查找', exact: true }).click();
  await page.locator('.element-results > button').filter({ hasText: '添加' }).click();
  await page.getByRole('tab', { name: '样式', exact: true }).click();
  const redGradient = 'linear-gradient(135deg, #d9363e 0%, #c41e3a 55%, #9f1239 100%)';
  await page.getByRole('textbox', { name: '背景 / 渐变', exact: true }).fill(redGradient);
  await page
    .getByRole('textbox', { name: '阴影', exact: true })
    .fill('0 4px 12px rgba(159, 18, 57, 0.24)');
  await page.getByRole('tab', { name: '动效', exact: true }).click();
  await page.getByRole('combobox', { name: '元素动效' }).selectOption('breathe-bounce');
  await page.getByRole('spinbutton', { name: '动效周期' }).fill('1.6');
  await page.getByRole('button', { name: '应用预览', exact: true }).click();
  const inspectSelected = () =>
    page.evaluate(async () => {
      const state = await window.workbench.invoke<AppSnapshot>('app:snapshot');
      return window.workbench.invoke<ElementDetails>('browser:element-details', {
        ref: state.browser.selectedElement!.ref,
      });
    });
  await expect.poll(async () => (await inspectSelected()).animationState).toBe('running');
  assert.match((await inspectSelected()).computed['background-image'], /217, 54, 62/);
  assert.equal((await snapshot()).browser.previewEdits?.at(-1)?.changes.animation?.duration, 1600);
  await viewportReady();
  await expect(page.locator('.frame-loading')).toHaveCount(0);
  await page.screenshot({ path: path.join(root, 'test-results/motion-inspector.png') });
  await page.getByRole('button', { name: '修改源码', exact: true }).click();
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect
    .poll(async () => (await snapshot()).conversations[0]?.messages.at(-1)?.status)
    .toBe('done');
  const secondInput = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((request) => request.method === 'turn/start')
    .at(-1).params.input[0].text;
  const carriedPreview = JSON.parse(
    secondInput.match(/页面预览修改（仅当前DOM，不代表源码已保存）：([^\n]+)/)![1],
  );
  assert.equal(carriedPreview.animation.duration, 1600);
  assert.equal(carriedPreview.styles['background-image'], redGradient);
  await page.getByRole('combobox', { name: '元素动效' }).selectOption('none');
  await page.getByRole('button', { name: '应用预览', exact: true }).click();
  await expect.poll(async () => (await inspectSelected()).animation ?? null).toBeNull();
  await page.getByRole('button', { name: '撤销页面修改', exact: true }).click();
  await expect.poll(async () => (await inspectSelected()).animationState).toBe('running');
  await page.getByRole('button', { name: '撤销页面修改', exact: true }).click();
  await expect.poll(async () => (await snapshot()).browser.previewEdits?.length).toBe(0);
  assert.match((await inspectSelected()).computed['background-image'], /60, 94, 232/);
  assert.equal((await inspectSelected()).animation ?? null, null);
  checks.push(
    'Gradient, shadow and breathing-bounce preview cross IPC, retain source context, stop and undo correctly',
  );

  await page.getByRole('button', { name: '结束录制', exact: true }).click();
  const recording = (await snapshot()).recordings[0];
  assert.ok(recording.steps.some((step) => step.kind === 'edit'));
  assert.ok(recording.steps.some((step) => step.kind === 'undo'));
  assert.ok(new Set(recording.steps.map((step) => step.tabId).filter(Boolean)).size >= 2);
  checks.push('Recording preserves exact edit/undo targets and multiple tab identities');
  await page.getByRole('button', { name: '网页', exact: true }).click();
  await page.getByRole('button', { name: '关闭元素检查器' }).click();
  await page.screenshot({
    path: path.join(root, 'test-results/workbench-workspace.png'),
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '关闭标签 页面 B', exact: true }).click();
  await expect.poll(async () => (await snapshot()).browser.tabs.length).toBe(1);
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1060, 700),
  );
  await page.getByRole('button', { name: '元素检查器', exact: true }).click();
  await viewportReady();
  const layout = await page.evaluate(() => ({
    scrollY: window.scrollY,
    width: document.documentElement.scrollWidth,
    innerWidth,
    bottom: document.querySelector('.element-inspector')!.getBoundingClientRect().bottom,
    innerHeight,
  }));
  assert.equal(layout.scrollY, 0);
  assert.ok(layout.width <= layout.innerWidth);
  assert.ok(layout.bottom <= layout.innerHeight + 1);
  await page.screenshot({
    path: path.join(root, 'test-results/workbench-compact.png'),
    animations: 'disabled',
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const motion = await page
    .locator('.browser-drawer')
    .evaluate((node) => getComputedStyle(node).transitionDuration);
  assert.ok(parseFloat(motion) < 0.001);
  checks.push('Minimum window layout stays within the viewport and respects reduced motion');
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(root, 'test-results/workbench.json'),
    JSON.stringify({ passed: true, checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, checks }));
} catch (error) {
  const page = (await application.windows())[0];
  const frameGeometry = await page
    ?.evaluate(async () => {
      const state = await window.workbench.invoke<AppSnapshot>('app:snapshot');
      const rect = document.querySelector('.browser-surface')!.getBoundingClientRect();
      const img = document.querySelector<HTMLImageElement>('.browser-frame')!;
      return {
        surface: { width: rect.width, height: rect.height },
        frame: { width: state.browserFrame?.width, height: state.browserFrame?.height },
        naturalImage: { width: img.naturalWidth, height: img.naturalHeight },
        loading: !!document.querySelector('.frame-loading'),
      };
    })
    .catch(() => undefined);
  await writeFile(
    path.join(root, 'test-results/workbench-frame-failure.json'),
    JSON.stringify({ frameGeometry }, null, 2),
  );
  await page
    ?.screenshot({ path: path.join(root, 'test-results/workbench-failure.png') })
    .catch(() => {});
  await writeFile(
    path.join(root, 'test-results/workbench.json'),
    JSON.stringify({ passed: false, checks, errors }, null, 2),
  );
  throw error;
} finally {
  await application.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
