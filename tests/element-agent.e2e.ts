/** Manual check with two real Codex turns on an isolated local page. */
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
const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, WORKBENCH_USER_DATA_DIR: path.join(dir, 'data') },
});
const errors: string[] = [];
try {
  const page = await app.firstWindow();
  await page.evaluate('window.__name = (fn) => fn');
  page.on('pageerror', (e) => errors.push(e.message));
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.webContents.setBackgroundThrottling(false);
    w.hide();
  });
  const state = () => page.evaluate(() => window.workbench.invoke<any>('app:snapshot'));
  await expect.poll(async () => (await state()).browser.status, { timeout: 30000 }).toBe('ready');
  await page.getByRole('button', { name: '展开浏览器', exact: true }).click();
  await page.evaluate((url) => window.workbench.invoke('browser:navigate', { url }), url);
  const selected = await page.evaluate(async () => {
    const q = await window.workbench.invoke<any>('browser:query', { selector: '#target' });
    return window.workbench.invoke<any>('browser:element', { ref: q.elements[0].ref });
  });
  assert.equal(selected.semantics.kind, 'button');
  await expect(page.getByRole('slider', { name: '圆角滑块' })).toBeVisible();
  await expect(page.locator('.inspector-context')).toContainText('按钮');
  const send = async (text: string) => {
    const before = (await state()).conversations
      .flatMap((c: any) => c.messages)
      .filter((m: any) => m.role === 'assistant').length;
    await page.getByRole('textbox', { name: '发送给 Agent 的任务' }).fill(text);
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect
      .poll(
        async () => {
          const messages = (await state()).conversations
            .flatMap((c: any) => c.messages)
            .filter((m: any) => m.role === 'assistant');
          return messages.length > before ? messages.at(-1)?.status : 'waiting';
        },
        { timeout: 180000 },
      )
      .toBe('done');
  };
  await send(
    '只针对选中的元素，为我提供背景颜色、圆角（0到80px）、透明度的调整面板。用 workbench_browser_controls，不要修改页面，不要运行命令、读写文件或导航。',
  );
  const panel = (await state()).browser.elementControls;
  assert(panel);
  assert.deepEqual(panel.controls.map((c: any) => c.property).sort(), [
    'background-color',
    'border-radius',
    'opacity',
  ]);
  await expect(page.getByRole('slider', { name: '圆角滑块' })).toHaveAttribute('max', '80');
  assert.equal(
    (await state()).browser.previewEdits.length,
    0,
    'Generating a panel must not edit the page',
  );
  await page.screenshot({ path: path.join(root, 'test-results/element-agent-panel.png') });
  await send(
    '仅将当前选中按钮背景预览为 #234567、圆角设为 24px，使用 workbench_browser_edit 一次应用。不要点击、导航、运行命令、改源码或改其他元素。简短报告回读结果。',
  );
  const edited = (await state()).browser.selectedElement;
  assert.equal(edited.ref, selected.ref);
  assert.equal(edited.computed['background-color'], 'rgb(35, 69, 103)');
  assert.equal(edited.computed['border-radius'], '24px');
  await expect(page.getByRole('slider', { name: '圆角滑块' })).toHaveValue('24');
  const decoy = await page.evaluate(async () => {
    const q = await window.workbench.invoke<any>('browser:query', { selector: '#decoy' });
    return window.workbench.invoke<any>('browser:element-details', { ref: q.elements[0].ref });
  });
  assert.equal(decoy.computed['background-color'], 'rgb(51, 102, 153)');
  assert.equal(edited.text, '开始整理');
  const messages = (await state()).conversations
    .flatMap((c: any) => c.messages)
    .filter((m: any) => m.role === 'assistant');
  const tools = messages
    .flatMap((m: any) => m.tools ?? [])
    .map((t: any) => ({ name: t.name, status: t.status }));
  assert(tools.some((t: any) => t.name === 'workbench_browser_controls' && t.status === 'done'));
  assert(tools.some((t: any) => t.name === 'workbench_browser_edit' && t.status === 'done'));
  assert.deepEqual(errors, []);
  const report = {
    passed: true,
    panel,
    tools,
    background: edited.computed['background-color'],
    radius: edited.computed['border-radius'],
    errors,
  };
  await writeFile(
    path.join(root, 'test-results/element-agent.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  await app.close();
  await new Promise<void>((r) => site.close(() => r()));
  await rm(dir, { recursive: true, force: true });
}
