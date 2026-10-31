/** Manual check: uses the user's existing Codex login for one local fixture task. */
import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
const dir = await mkdtemp(path.join(root, '.runtime/neo-live-'));
const saved: unknown[] = [];
const site = createServer(async (req, res) => {
  if (req.url === '/save' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    saved.push(JSON.parse(body));
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
    return;
  }
  res.setHeader('content-type', 'text/html;charset=utf-8');
  res.end(
    '<!doctype html><meta charset="utf-8"><title>Neo 本地验收</title><style>body{font:18px system-ui;margin:40px}label{display:block;margin:20px 0}input,button{font:inherit;padding:8px}</style><h1>发布登记</h1><label>标题<input id="title" aria-label="标题"></label><label>负责人<input id="owner" aria-label="负责人"></label><button id="save">保存</button><p id="result">尚未保存</p><script>save.onclick=async()=>{await fetch("/save",{method:"POST",body:JSON.stringify({title:document.querySelector("#title").value,owner:owner.value})});result.textContent="已保存";}</script>',
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
  page.on('pageerror', (e) => errors.push(e.message));
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.webContents.setBackgroundThrottling(false);
    w.hide();
  });
  await expect
    .poll(
      () =>
        page.evaluate(async () => (await window.workbench.invoke<any>('app:snapshot')).neo?.status),
      { timeout: 30000 },
    )
    .toBe('ready');
  await page.getByRole('button', { name: '展开浏览器', exact: true }).click();
  await page.evaluate((url) => window.workbench.invoke('browser:navigate', { url }), url);
  const prompt =
    '这是本地集成验收。仅操作当前页，用 neo_snapshot 获取引用，使用 neo_act 的 fields 一次填写标题为 Athena 发布、负责人为 Ada，再点击保存。用 neo_read 或 neo_snapshot 核验“已保存”。只使用 neo_snapshot/neo_act/neo_read/neo_wait；不要命令、文件、脚本、其他地址。完成后一句话说明。';
  await page.getByRole('textbox', { name: '发送给 Agent 的任务' }).fill(prompt);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect.poll(() => saved.length, { timeout: 180000 }).toBe(1);
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const s = await window.workbench.invoke<any>('app:snapshot');
          return s.conversations
            .flatMap((c: any) => c.messages)
            .filter((m: any) => m.role === 'assistant')
            .at(-1)?.status;
        }),
      { timeout: 120000 },
    )
    .toBe('done');
  assert.deepEqual(saved, [{ title: 'Athena 发布', owner: 'Ada' }]);
  const records = await page.evaluate(() => window.workbench.invoke<any[]>('neo:records'));
  const record = records.find((x) => x.dispatchCount > 4);
  assert(record);
  const detail = await page.evaluate(
    (id) => window.workbench.invoke<any>('neo:record', { id }),
    record.sessionId,
  );
  assert(detail.dispatches.some((x: any) => x.toolName === 'act' && x.argsJson.includes('fields')));
  await page.getByRole('radio', { name: '网页任务', exact: true }).click();
  await page.locator('.neo-session-list button').first().click();
  await expect(page.getByRole('heading', { name: '执行过程' })).toBeVisible();
  await expect(page.locator('.neo-history')).toContainText('填写表单');
  await page.screenshot({ path: path.join(root, 'test-results/neo-live.png') });
  const report = {
    passed: true,
    saved,
    sessionId: record.sessionId,
    status: detail.session.status,
    dispatches: detail.dispatches.map((x: any) => ({ tool: x.toolName, duration: x.durationMs })),
    errors,
  };
  assert.deepEqual(errors, []);
  await writeFile(path.join(root, 'test-results/neo-live.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await app.close();
  await new Promise<void>((r) => site.close(() => r()));
  await rm(dir, { recursive: true, force: true });
}
