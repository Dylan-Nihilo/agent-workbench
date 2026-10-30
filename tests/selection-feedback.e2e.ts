/** Real Electron UI + neo, deterministic CLI task lifecycle; no real accounts or messages. */
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
const temp = await mkdtemp(path.join(root, '.runtime/selection-ui-'));
const evidence = path.join(root, 'test-results/selection-feedback');
await mkdir(evidence, { recursive: true });
const bin = path.join(temp, 'bin');
await mkdir(bin);
const control = path.join(temp, 'release');
const log = path.join(temp, 'protocol.jsonl');
await writeFile(log, '');
const executable = path.join(bin, 'codex');
await writeFile(
  executable,
  `#!${process.execPath}\n` +
    String.raw`
import fs from 'node:fs';import readline from 'node:readline';
if(process.argv.includes('--version')){console.log('codex-cli interaction-fixture');process.exit(0)}
if(process.argv[2]==='login'){console.error('Logged in using isolated fixture');process.exit(0)}
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
const event=(method,params)=>send({method,params});
const threadId='interaction-thread';let count=0,current,mode,poll;
const finish=(text,status='completed')=>{
clearInterval(poll);
event('item/agentMessage/delta',{threadId,turnId:current,itemId:'answer-'+current,delta:text});
event('turn/completed',{threadId,turnId:current,turn:{id:current,status}});
};
readline.createInterface({input:process.stdin}).on('line',line=>{
const r=JSON.parse(line);fs.appendFileSync(process.env.INTERACTION_LOG,line+'\n');
if(r.method==='initialize')return send({id:r.id,result:{userAgent:'fixture'}});
if(r.method==='thread/start'||r.method==='thread/resume')return send({id:r.id,result:{thread:{id:threadId}}});
if(r.method==='turn/start'){
current='turn-'+(++count);const input=r.params.input[0].text;mode=input.split('\n')[0];
const selected=JSON.parse(input.match(/<selected_element_snapshot>\n([^\n]+)/)[1]);
send({id:r.id,result:{turn:{id:current,status:'inProgress'}}});
event('turn/started',{threadId,turnId:current,turn:{id:current}});
poll=setInterval(()=>{
if(!fs.existsSync(process.env.INTERACTION_RELEASE))return;
fs.unlinkSync(process.env.INTERACTION_RELEASE);clearInterval(poll);
const args=mode==='interaction-failure'?{ref:selected.ref,styles:{color:'url(https://example.invalid/a)'}}:{ref:selected.ref,text:'让想法成为现实',styles:{color:'rgb(45, 69, 155)'}};
send({id:900,method:'item/tool/call',params:{threadId,turnId:current,callId:'edit-'+current,tool:'workbench_browser_edit',arguments:args}});
},20);return;
}
if(r.method==='turn/interrupt'){send({id:r.id,result:{}});return finish('已停止','interrupted')}
if(r.id===900&&r.result)return finish(r.result.success?'页面已更新':r.result.contentItems[0].text);
}).on('close',()=>{clearInterval(poll);process.exit(0)});
`,
);
await chmod(executable, 0o700);
const server = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html;charset=utf-8');
  response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>交互预览</title><style>
body{margin:0;background:#f6f7fa;color:#202735;font:15px system-ui}main{margin:60px 38px;max-width:530px}.eyebrow{font-size:11px;letter-spacing:2px;color:#7a8493}h1{font-size:32px;line-height:1.3;font-weight:600;margin:20px 0}p{color:#6b7483;line-height:1.8}button{margin-top:18px;border:0;border-radius:9px;padding:12px 22px;color:white;background:#242a35;font:inherit}#card{margin-top:28px;padding:24px;background:white;border:1px solid #e3e7ee;border-radius:14px}#card p{margin:5px 0 0}svg{width:30px;height:30px}
</style><main><span class="eyebrow">DAILY STUDIO</span><h1 id="headline">把下一步想清楚</h1><p>整理想法，留出专注的时间。<br>从今天最重要的一件事开始。</p><button id="start" onclick="document.querySelector('#clicks').textContent=++window.clicks">开始整理</button><span id="clicks">0</span><section id="card"><svg viewBox="0 0 30 30"><circle cx="15" cy="15" r="11" fill="#c8d2e9"/></svg><strong>每周计划</strong><p>让进展清晰可见。</p></section></main><script>window.clicks=0</script></html>`);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const application = await electron.launch({
  args: ['.'],
  cwd: root,
  env: {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    WORKBENCH_USER_DATA_DIR: path.join(temp, 'data'),
    INTERACTION_LOG: log,
    INTERACTION_RELEASE: control,
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
  await expect
    .poll(async () => (await snapshot()).browser.status, { timeout: 30000 })
    .toBe('ready');
  await page.getByRole('button', { name: '展开浏览器', exact: true }).click();
  await page.getByRole('textbox', { name: '网页地址', exact: true }).fill(url);
  await page.getByRole('button', { name: '打开网页', exact: true }).click();
  await expect.poll(async () => (await snapshot()).browser.title).toBe('交互预览');
  const ready = async () => {
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const state = await window.workbench.invoke<AppSnapshot>('app:snapshot');
          const bounds = document.querySelector('.browser-surface')!.getBoundingClientRect();
          return Math.max(
            Math.abs((state.browserFrame?.width ?? 0) - Math.floor(bounds.width)),
            Math.abs((state.browserFrame?.height ?? 0) - Math.floor(bounds.height)),
          );
        }),
      )
      .toBeLessThanOrEqual(1);
    await expect(page.locator('.frame-loading')).toHaveCount(0);
  };
  await ready();
  const query = (selector: string) =>
    page.evaluate(
      async (selector) =>
        (await window.workbench.invoke<ElementQueryResult>('browser:query', { selector }))
          .elements[0],
      selector,
    );
  const point = async (selector: string) => {
    const target = await query(selector);
    assert.ok(target.bounds);
    const bounds = await page.locator('.browser-surface').boundingBox();
    assert.ok(bounds);
    return {
      x: bounds.x + target.bounds.x + target.bounds.width / 2,
      y: bounds.y + target.bounds.y + target.bounds.height / 2,
    };
  };
  const screenshot = async (name: string) => {
    const result = await page.evaluate(() =>
      window.workbench.invoke<ToolResult>('browser:snapshot'),
    );
    assert.ok(result.text);
    await page.screenshot({ path: path.join(evidence, name + '.png') });
    const native = (await snapshot()).browserFrame!;
    await writeFile(
      path.join(evidence, name + '-page.jpg'),
      Buffer.from(native.data.replace(/^data:image\/[^;]+;base64,/, ''), 'base64'),
    );
  };
  await page.getByRole('button', { name: '选取元素', exact: true }).click();
  await expect(page.locator('.inspect-tip')).toContainText('悬停预览，点击选中');
  await expect(page.getByRole('textbox', { name: '元素文字', exact: true })).toHaveCount(0);
  await ready();
  let target = await point('#headline');
  await page.mouse.move(target.x, target.y);
  // Wait for the streamed frame to include the native hover overlay.
  await page.waitForTimeout(180);
  await screenshot('hover');
  assert.equal((await snapshot()).browser.selectedElement, undefined);
  await page.mouse.click(target.x, target.y);
  await expect(page.getByRole('textbox', { name: '元素文字', exact: true })).toHaveValue(
    '把下一步想清楚',
  );
  await expect.poll(async () => (await snapshot()).browser.inspecting).toBe(false);
  await ready();
  await screenshot('selected');
  checks.push(
    'Hover precedes click; picker does not open the inspector until selection; exact heading selected',
  );

  await page.getByRole('button', { name: '选取元素', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await snapshot()).browser.inspecting).toBe(false);
  for (const hideControl of ['.browser-toggle', '.browser-heading button']) {
    await page.getByRole('button', { name: '选取元素', exact: true }).click();
    await page.locator(hideControl).click();
    await expect(page.locator('.browser-drawer')).toHaveAttribute('aria-hidden', 'true');
    await page.evaluate(() => window.workbench.invoke('browser:snapshot'));
    await expect.poll(async () => (await snapshot()).browser.inspecting).toBe(false);
    await page.getByRole('button', { name: '展开浏览器', exact: true }).click();
    await ready();
  }
  await page.getByRole('button', { name: '选取元素', exact: true }).click();
  await ready();
  target = await point('#start');
  await page.mouse.move(target.x, target.y);
  await page.mouse.click(target.x, target.y);
  await expect
    .poll(async () => (await snapshot()).browser.selectedElement?.selector)
    .toBe('#start');
  assert.equal((await query('#clicks')).text, '0');
  await ready();
  checks.push(
    'Escape and both drawer close paths cancel picker; picking a button does not execute its website action',
  );
  const heading = await query('#headline');
  await page.evaluate((ref) => window.workbench.invoke('browser:element', { ref }), heading.ref);
  await expect(page.getByRole('textbox', { name: '元素文字', exact: true })).toHaveValue(
    '把下一步想清楚',
  );
  await ready();
  const send = async (text: string) => {
    await page.getByRole('textbox', { name: '发送给 Agent 的任务' }).fill(text);
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect(page.getByRole('button', { name: '停止任务', exact: true })).toBeVisible();
    await expect(page.locator('.browser-agent-status')).toBeVisible();
    await expect.poll(async () => (await readFile(log, 'utf8')).includes(text)).toBe(true);
  };
  await send('interaction-success');
  await page.waitForTimeout(180);
  await screenshot('working');
  await writeFile(control, 'continue');
  await expect.poll(async () => (await query('#headline')).text).toBe('让想法成为现实');
  await expect(page.getByRole('button', { name: '停止任务', exact: true })).toHaveCount(0);
  await expect(page.locator('.browser-agent-status')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '元素文字', exact: true })).toHaveValue(
    '让想法成为现实',
  );
  await ready();
  await screenshot('complete');
  const requests = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const input = requests.find((r) => r.method === 'turn/start').params.input[0].text;
  assert.match(input, /selected_element_snapshot/);
  assert.match(input, /editableText/);
  checks.push(
    'Selected-target context is freshly inspected before the model turn; processing feedback ends after exact element edit',
  );

  await send('interaction-failure');
  await writeFile(control, 'continue');
  await expect(page.getByRole('button', { name: '停止任务', exact: true })).toHaveCount(0);
  await expect(page.locator('.browser-agent-status')).toHaveCount(0);
  assert.equal((await query('#headline')).text, '让想法成为现实');
  await expect(page.locator('.tool-call.error')).toBeVisible();
  await page.evaluate(
    (ref) => window.workbench.invoke('browser:element', { ref }),
    (await query('#headline')).ref,
  );
  await send('interaction-cancel');
  await page.getByRole('button', { name: '停止任务', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止任务', exact: true })).toHaveCount(0);
  await expect(page.locator('.browser-agent-status')).toHaveCount(0);
  assert.equal((await query('#headline')).text, '让想法成为现实');
  checks.push('Rejected edit and explicit stop leave the page intact and clear processing state');
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(evidence, 'result.json'),
    JSON.stringify({ passed: true, checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, checks, evidence }, null, 2));
} catch (error) {
  await application
    .firstWindow()
    .then((page) => page.screenshot({ path: path.join(evidence, 'failure.png') }))
    .catch(() => {});
  await writeFile(
    path.join(evidence, 'result.json'),
    JSON.stringify({ passed: false, checks, errors, error: String(error) }, null, 2),
  );
  throw error;
} finally {
  await application.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
