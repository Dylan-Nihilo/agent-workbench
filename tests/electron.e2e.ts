import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserFrame, ToolResult } from '../src/shared/types';

const root = process.cwd();
await mkdir(path.join(root, '.runtime'), { recursive: true });
const dataDir = await mkdtemp(path.join(root, '.runtime/ui-test-'));
await mkdir(path.join(root, 'test-results'), { recursive: true });
await mkdir(path.join(root, 'docs/screenshots'), { recursive: true });
const application = await electron.launch({
  args: ['.'],
  cwd: root,
  env: {
    ...process.env,
    WORKBENCH_USER_DATA_DIR: dataDir,
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
  },
});
const errors: string[] = [];
const checks: string[] = [];
try {
  const page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await expect(page.getByRole('heading', { name: '今天想完成什么？' })).toBeVisible();
  expect(application.windows()).toHaveLength(1);
  await expect(page.locator('.browser-drawer')).toHaveAttribute('aria-hidden', 'true');
  await page.screenshot({
    path: path.join(root, 'docs/screenshots/chat.png'),
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '展开浏览器', exact: true }).click();
  await page.waitForFunction(() => {
    const drawer = document.querySelector('.browser-drawer')!;
    return (
      drawer.clientWidth >=
      parseFloat(getComputedStyle(drawer).getPropertyValue('--browser-drawer-width')) - 1
    );
  });
  await expect
    .poll(
      async () =>
        page.evaluate(
          async () => (await window.workbench.invoke<any>('app:snapshot')).browser.status,
        ),
      { timeout: 30_000 },
    )
    .toBe('ready');
  await expect
    .poll(
      async () =>
        page.evaluate(
          async () => (await window.workbench.invoke<any>('app:snapshot')).browser.title,
        ),
      { timeout: 15_000 },
    )
    .toContain('今日清单');
  if (process.env.WORKBENCH_HIDE_TEST_WINDOW === '1') {
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.webContents.setBackgroundThrottling(false);
      window.hide();
    });
  }
  await expect
    .poll(
      async () =>
        page.locator('.browser-frame').evaluate((node: HTMLImageElement) => node.naturalWidth),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(100);
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const snapshot = await window.workbench.invoke<any>('app:snapshot');
          const surface = document.querySelector('.browser-surface')!.getBoundingClientRect();
          return Math.abs(snapshot.browserFrame.width - Math.floor(surface.width));
        }),
      { timeout: 10_000 },
    )
    .toBeLessThanOrEqual(1);
  checks.push('Electron renderer, real BrowserOS neo and live frame');
  await page
    .locator('.topbar-actions')
    .getByRole('button', { name: '收起浏览器', exact: true })
    .click();
  await expect(page.locator('.browser-drawer')).toHaveAttribute('aria-hidden', 'true');
  expect(application.windows()).toHaveLength(1);
  await page.getByRole('button', { name: '展开浏览器', exact: true }).click();
  await page.waitForFunction(() => {
    const drawer = document.querySelector('.browser-drawer')!;
    return (
      drawer.clientWidth >=
      parseFloat(getComputedStyle(drawer).getPropertyValue('--browser-drawer-width')) - 1
    );
  });
  await page.getByRole('separator', { name: '调整浏览器宽度' }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const snapshot = await window.workbench.invoke<any>('app:snapshot');
        return Math.abs(
          snapshot.browserFrame.width - document.querySelector('.browser-surface')!.clientWidth,
        );
      }),
    )
    .toBeLessThanOrEqual(1);
  checks.push('One app window; browser slides in, collapses, retains page and resizes');
  await page.getByRole('textbox', { name: '发送给 Agent 的任务' }).focus();
  await page.screenshot({
    path: path.join(root, 'docs/screenshots/workspace.png'),
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(
    page.locator('.agent-setting-row').filter({ has: page.getByText('Codex', { exact: true }) }),
  ).toContainText('可使用');
  await expect(page.locator('.agent-setting-row').filter({ hasText: 'Claude' })).toBeVisible();
  await page.screenshot({ path: path.join(root, 'test-results/agents.png') });
  await page.getByRole('button', { name: '关闭设置' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  checks.push('Actual CLI detection and settings dialog');

  const snapshot = async () =>
    page.evaluate(async () =>
      JSON.parse((await window.workbench.invoke<ToolResult>('browser:snapshot')).text),
    );
  let state = await snapshot();
  const input =
    state.elements.find((item: any) => item.tag === 'input' && item.role === 'textbox') ||
    state.elements.find((item: any) => item.tag === 'input' && item.name?.includes('任务'));
  if (!input?.bounds) throw new Error('No task input found in real page snapshot');
  const frame = await page.evaluate(
    async () => (await window.workbench.invoke<any>('app:snapshot')).browserFrame as BrowserFrame,
  );
  const surface = page.locator('.browser-surface');
  const surfaceBounds = await surface.boundingBox();
  if (!surfaceBounds) throw new Error('Missing browser surface');
  const clickElement = async (element: any) => {
    await expect(page.locator('.frame-loading')).toHaveCount(0);
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const s = await window.workbench.invoke<any>('app:snapshot');
          const b = document.querySelector('.browser-surface')!.getBoundingClientRect();
          return Math.max(
            Math.abs(s.browserFrame.width - Math.floor(b.width)),
            Math.abs(s.browserFrame.height - Math.floor(b.height)),
          );
        }),
      )
      .toBeLessThanOrEqual(1);
    element = (await snapshot()).elements.find((item: any) => item.ref === element.ref) ?? element;
    const actualFrame = await page.evaluate(
      async () => (await window.workbench.invoke<any>('app:snapshot')).browserFrame as BrowserFrame,
    );
    const box = await surface.boundingBox();
    if (!box || !element.bounds) throw new Error('Missing element bounds');
    await page.mouse.click(
      box.x + ((element.bounds.x + element.bounds.width / 2) * box.width) / actualFrame.width,
      box.y + ((element.bounds.y + element.bounds.height / 2) * box.height) / actualFrame.height,
    );
  };
  await page.getByRole('button', { name: '录制', exact: true }).click();
  await expect(page.locator('.recording-strip')).toBeVisible();
  await clickElement(input);
  await expect(page.getByRole('textbox', { name: '网页键盘输入' })).toBeFocused();
  await page.keyboard.type('Workbench interface check');
  state = await snapshot();
  const add = state.elements.find((item: any) => item.tag === 'button' && item.name === '添加');
  await clickElement(add);
  await expect
    .poll(async () => (await snapshot()).text, { timeout: 10_000 })
    .toContain('Workbench interface check');
  checks.push('Real mouse coordinates and keyboard forwarded through embedded frame');
  await page.getByRole('button', { name: '结束录制', exact: true }).click();
  await expect(page.getByRole('button', { name: '让 Agent 理解这段操作' })).toBeEnabled();
  const recording = await page.evaluate(
    async () => (await window.workbench.invoke<any>('app:snapshot')).recordings[0],
  );
  expect(
    recording.steps.some(
      (step: any) => step.kind === 'fill' && step.value === 'Workbench interface check',
    ),
  ).toBeTruthy();
  expect(recording.steps.some((step: any) => step.kind === 'click')).toBeTruthy();
  await page.screenshot({ path: path.join(root, 'docs/screenshots/recording.png') });
  checks.push('Human recording persisted with actual input and click');
  await page.getByRole('button', { name: '网页', exact: true }).click();
  await expect
    .poll(async () =>
      page.locator('.browser-frame').evaluate((node: HTMLImageElement) => node.naturalWidth),
    )
    .toBeGreaterThan(100);
  await page.getByRole('button', { name: '选取元素', exact: true }).click();
  state = await snapshot();
  await clickElement(
    state.elements.find((item: any) => item.tag === 'button' && item.name === '添加'),
  );
  await expect(page.locator('.selected-context')).toContainText('添加');
  await page.getByRole('button', { name: '移除选中元素' }).click();
  checks.push('Element picking attaches context without submitting form');

  if (process.env.WORKBENCH_LIVE_AGENT_TEST === '1') {
    const textarea = page.getByRole('textbox', { name: '发送给 Agent 的任务' });
    await textarea.fill(
      '请使用当前浏览器页面，把“Electron 联调通过”添加到今日清单。添加后确认页面里存在这项任务，用一句中文告诉我结果。不要使用终端或文件工具。',
    );
    await page.getByRole('button', { name: '发送任务' }).click();
    await expect
      .poll(
        async () =>
          page.evaluate(
            async () =>
              (await window.workbench.invoke<any>('app:snapshot')).conversations[0]?.messages.at(-1)
                ?.status,
          ),
        { timeout: 120_000 },
      )
      .not.toBe('streaming');
    const completed = await page.evaluate(async () =>
      (await window.workbench.invoke<any>('app:snapshot')).conversations[0]?.messages.at(-1),
    );
    expect(completed?.status, completed?.text).toBe('done');
    await expect
      .poll(async () => (await snapshot()).text, { timeout: 10_000 })
      .toContain('Electron 联调通过');
    await expect(page.locator('.message.assistant .tool-call')).not.toHaveCount(0);
    await page.screenshot({ path: path.join(root, 'docs/screenshots/agent-browser.png') });
    checks.push('Actual renderer send → Codex → BrowserOS actions → streamed UI result');
  }
  if (process.env.WORKBENCH_LIVE_ANALYSIS_TEST === '1') {
    const before = (await snapshot()).text;
    await page.getByRole('button', { name: /操作记录/ }).click();
    await page.getByRole('button', { name: '让 Agent 理解这段操作' }).click();
    await expect
      .poll(
        async () =>
          page.evaluate(
            async () =>
              (await window.workbench.invoke<any>('app:snapshot')).conversations[0]?.messages.at(-1)
                ?.status,
          ),
        { timeout: 120_000 },
      )
      .not.toBe('streaming');
    const analyzed = await page.evaluate(async () =>
      (await window.workbench.invoke<any>('app:snapshot')).conversations[0]?.messages.at(-1),
    );
    expect(analyzed?.status, analyzed?.text).toBe('done');
    expect(analyzed.text).toContain('Workbench interface check');
    expect((await snapshot()).text).toBe(before);
    await page.screenshot({ path: path.join(root, 'docs/screenshots/recording-analysis.png') });
    checks.push('Actual recording-analysis button → Codex understanding; webpage unchanged');
  }
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '飞书', exact: true }).click();
  await expect(page.getByRole('button', { name: '创建专用机器人' })).toBeVisible();
  await page.screenshot({ path: path.join(root, 'docs/screenshots/feishu.png') });
  await page.getByRole('button', { name: '关闭设置' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  checks.push('Feishu setup surface available; registration not triggered by test');
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ ok: true, checks, pageErrors: errors }, null, 2));
  const resultName =
    process.env.WORKBENCH_LIVE_AGENT_TEST === '1'
      ? 'electron-live.json'
      : process.env.WORKBENCH_LIVE_ANALYSIS_TEST === '1'
        ? 'electron-analysis.json'
        : 'electron.json';
  await writeFile(
    path.join(root, 'test-results', resultName),
    JSON.stringify({ ok: true, checks, pageErrors: errors }, null, 2),
  );
} catch (error) {
  const page = await application.firstWindow().catch(() => undefined);
  await page
    ?.screenshot({ path: path.join(root, 'test-results/electron-failure.png') })
    .catch(() => {});
  const evidence = await page
    ?.evaluate(async () => ({
      app: await window.workbench.invoke('app:snapshot'),
      browser: await window.workbench.invoke('browser:diagnostics'),
    }))
    .catch(() => undefined);
  if (evidence) {
    delete (evidence.app as any).browserFrame;
    await writeFile(
      path.join(root, 'test-results/electron-failure.json'),
      JSON.stringify(evidence, null, 2),
    );
  }
  console.error(error);
  process.exitCode = 1;
} finally {
  await application.close();
  await rm(dataDir, { recursive: true, force: true });
}
