/** Manual integration check: ./node_modules/.bin/tsx tests/live-agent.e2e.ts
 * Uses the existing Codex login and makes two real model turns. Never runs in npm test.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserRuntime, discoverBrowserOS } from '../src/main/browser';
import { CodexSession, detectAgents } from '../src/main/agents';
import type { AgentEvent, ElementRef, RecordedStep } from '../src/shared/types';

type Snapshot = { documentId: string; text: string; elements: ElementRef[] };
const storageDir = await mkdtemp(join(tmpdir(), 'workbench-live-agent-'));
const runId = randomUUID().slice(0, 8);
const aiValue = `诺瓦客户-${runId}`;
const humanValue = `手工验收-${runId}`;
const events: AgentEvent[] = [];
const humanSteps: RecordedStep[] = [];
const toolCalls: Array<{ name: string; success: boolean }> = [];
let screenshots = 0;
let frames = 0;
let agent: CodexSession | undefined;
let busy = false;
let runtime: BrowserRuntime | undefined;
let completedTurns = 0;
const startedAt = Date.now();

const fixture = createServer((request, response) => {
  const human = request.url === '/human';
  if (request.url !== '/' && !human) {
    response.writeHead(404).end();
    return;
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'none'",
  );
  response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Workbench 本地验收</title>
    <style>body{font:18px system-ui;padding:40px;max-width:700px}label{display:block;margin:24px 0}input,button{font:inherit;padding:12px}input{display:block;margin-top:8px;width:380px}button{cursor:pointer}</style>
    <h1>${human ? '人工验收记录' : '客户登记'}</h1>
    <label>${human ? '验收说明' : '客户名称'}<input id="${human ? 'note' : 'customer'}" aria-label="${human ? '验收说明' : '客户名称'}"></label>
    <button id="save">${human ? '提交验收' : '保存客户'}</button><p role="status" id="status">尚未提交</p>
    <script>document.getElementById('save').onclick=()=>{document.getElementById('status').textContent='${human ? '已提交验收：' : '已保存客户：'}'+document.querySelector('input').value;}</script></html>`);
});

async function eventually<T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
  timeout = 10000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (matches(value)) return value;
    } catch {
      /* Navigation can invalidate a snapshot. */
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error('Expected fixture browser state did not arrive');
}

async function turn(prompt: string, context?: string): Promise<string> {
  const offset = events.length;
  const timer = setTimeout(() => agent?.close(), 150000);
  busy = true;
  try {
    await agent!.send(prompt, context);
    const complete = events.slice(offset).find((event) => event.type === 'complete');
    assert.ok(complete?.type === 'complete', 'Real Codex turn must complete');
    completedTurns++;
    return complete.text ?? '';
  } finally {
    busy = false;
    clearTimeout(timer);
  }
}

async function humanClick(element: ElementRef): Promise<void> {
  assert.ok(element.bounds);
  const { x, y, width, height } = element.bounds;
  await runtime!.dispatchInput({
    type: 'mouse',
    action: 'down',
    x: x + width / 2,
    y: y + height / 2,
  });
  await runtime!.dispatchInput({
    type: 'mouse',
    action: 'up',
    x: x + width / 2,
    y: y + height / 2,
  });
}

try {
  const binary = await discoverBrowserOS(process.env.WORKBENCH_BROWSEROS_TEST_BINARY);
  assert.ok(binary, 'Install BrowserOS neo or set WORKBENCH_BROWSEROS_TEST_BINARY');
  const codex = (await detectAgents()).find(
    (candidate) => candidate.id === 'codex' && candidate.available,
  );
  assert.ok(codex?.path, 'A local Codex CLI is required');
  assert.notEqual(
    codex.authentication,
    'missing',
    'Sign in using codex login before this manual check',
  );
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  runtime = new BrowserRuntime({
    storageDir,
    binaryPath: binary,
    onState() {},
    onFrame() {
      frames++;
    },
    onStep: (step) => humanSteps.push(step),
    onSelected() {},
    onHumanTakeover() {
      if (busy) void agent?.interrupt();
    },
  });
  await runtime.start();
  await runtime.navigate(`${origin}/`);
  const snapshot = async () => JSON.parse((await runtime!.snapshot()).text) as Snapshot;
  await eventually(snapshot, (value) =>
    value.elements.some((element) => element.selector === '#customer'),
  );
  runtime.allowAgentControl();
  const allowedTools = new Set([
    'workbench_browser_snapshot',
    'workbench_browser_screenshot',
    'workbench_browser_fill',
    'workbench_browser_click',
  ]);
  agent = new CodexSession({
    workspace: storageDir,
    executablePath: codex.path,
    tools: runtime.getTools().filter((tool) => allowedTools.has(tool.name)),
    callTool: async (name, args) => {
      assert.equal(
        new URL(runtime!.getState().url).origin,
        origin,
        'Tools must stay on the local fixture',
      );
      assert.ok(allowedTools.has(name), 'Only local browser tools are allowed');
      const result = await runtime!.callTool(name, args);
      toolCalls.push({ name, success: !result.isError });
      if (result.image) screenshots++;
      console.log(JSON.stringify({ stage: 'browser-tool', name, success: !result.isError }));
      return result;
    },
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'approval') agent!.resolveApproval(event.request.id, false);
      if (event.type === 'error')
        console.log(JSON.stringify({ stage: 'agent-error', message: event.message }));
    },
  });
  console.log(JSON.stringify({ stage: 'ai-browser-start', codexVersion: codex.version }));
  const browserReply = await turn(
    `这是本地浏览器集成验收，仅操作当前页面。先用 workbench_browser_snapshot 获取当前元素，再用 workbench_browser_screenshot 获取截图，将「客户名称」填写为「${aiValue}」，点击「保存客户」，最后用 snapshot 检查实际保存结果。只使用提供的 workbench_browser_* 工具；不要调用命令、读写文件、访问其他地址。完成后简短报告看到的结果。`,
  );
  const afterAI = await eventually(snapshot, (value) =>
    value.text.includes(`已保存客户：${aiValue}`),
  );
  assert.equal(
    afterAI.elements.find((element) => element.selector === '#customer')?.value,
    aiValue,
  );
  for (const name of allowedTools)
    assert.ok(
      toolCalls.some((call) => call.name === name && call.success),
      `Expected real successful callback for ${name}`,
    );
  assert.ok(screenshots > 0 && frames > 0);
  assert.equal(
    events.some((event) => event.type === 'approval'),
    false,
    'No command or file approval should be needed',
  );
  assert.equal(
    events.some(
      (event) =>
        event.type === 'tool' &&
        ['commandExecution', 'fileChange', 'mcpToolCall'].includes(event.call.name),
    ),
    false,
    'No non-browser actions are allowed',
  );

  await runtime.navigate(`${origin}/human`);
  const beforeHuman = await eventually(snapshot, (value) =>
    value.elements.some((element) => element.selector === '#note'),
  );
  runtime.startRecording();
  await humanClick(beforeHuman.elements.find((element) => element.selector === '#note')!);
  await runtime.dispatchInput({ type: 'text', text: humanValue });
  await humanClick(beforeHuman.elements.find((element) => element.selector === '#save')!);
  await eventually(snapshot, (value) => value.text.includes(`已提交验收：${humanValue}`));
  await eventually(
    async () => humanSteps,
    (steps) =>
      steps.some(
        (step) => step.kind === 'fill' && step.value === humanValue && step.source === 'human',
      ),
  );
  const recording = runtime.stopRecording();
  assert.ok(
    recording.steps.some(
      (step) =>
        step.target?.name === '验收说明' && step.value === humanValue && step.source === 'human',
    ),
  );
  assert.ok(
    recording.steps.some(
      (step) =>
        step.kind === 'click' && step.target?.name === '提交验收' && step.source === 'human',
    ),
  );
  const callsBeforeAnalysis = toolCalls.length;
  console.log(
    JSON.stringify({ stage: 'recording-analysis-start', recordedSteps: recording.steps.length }),
  );
  const analysisReply = await turn(
    '只分析附带的人类操作记录，不要调用任何工具、不要继续操作页面、不要读写文件。找出用户填写的输入框名称、输入的完整原文、随后点击的提交按钮名称。仅输出一个 JSON 对象，键为 target、inputValue、button，不要代码围栏或其他文字。',
    JSON.stringify(recording),
  );
  const analysis = JSON.parse(analysisReply.trim());
  assert.equal(analysis.target, '验收说明');
  assert.equal(analysis.inputValue, humanValue);
  assert.equal(analysis.button, '提交验收');
  assert.equal(
    toolCalls.length,
    callsBeforeAnalysis,
    'Recording analysis must not operate the browser',
  );
  assert.equal(
    events.some((event) => event.type === 'approval'),
    false,
    'Neither turn may request elevated actions',
  );
  assert.equal(
    events.some(
      (event) =>
        event.type === 'tool' &&
        ['commandExecution', 'fileChange', 'mcpToolCall'].includes(event.call.name),
    ),
    false,
    'Neither turn may use non-browser actions',
  );
  console.log(
    JSON.stringify(
      {
        passed: true,
        completedTurns,
        elapsedMs: Date.now() - startedAt,
        browser: {
          engine: runtime.getState().engine,
          successfulToolCallbacks: toolCalls.filter((call) => call.success).length,
          screenshots,
          receivedFrames: frames,
          domVerified: true,
          reply: browserReply,
        },
        recording: { steps: recording.steps.length, humanInputVerified: true, analysis },
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      passed: false,
      completedTurns,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
} finally {
  agent?.close();
  await runtime?.dispose();
  if (fixture.listening) {
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
  await rm(storageDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
