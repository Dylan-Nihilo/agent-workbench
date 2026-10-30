/** Manual live check: ./node_modules/.bin/tsx tests/live-motion.e2e.ts
 * Uses one real Codex turn and an isolated BrowserOS profile. Never runs in npm test.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexSession, browserToolsFingerprint, detectAgents } from '../src/main/agents';
import { BrowserRuntime, discoverBrowserOS } from '../src/main/browser';
import type { AgentEvent, ElementDetails, ElementEdit, RecordedStep } from '../src/shared/types';

type MotionState = {
  backgroundImage: string;
  transform: string;
  opacity: string;
  sitePresent: boolean;
  siteState: string;
  siteTime: number | null;
  siteCancelCount: number;
  animations: Array<{ id: string; state: string; currentTime: number | null }>;
};

const fixtureHtml = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><title>Local motion fixture</title>
<style>
body{font:18px system-ui;margin:0;background:#f4f6fa;color:#202b43;padding:64px}
button{font:600 20px system-ui;color:white;border:3px solid #182744;border-radius:16px;padding:20px 44px;background-image:linear-gradient(110deg,#123abc,#277ee8)}
p{margin-top:32px}
</style>
<h1>按钮预览验收</h1><button id="motion-button" data-testid="motion-button">立即开始</button>
<p>这是隔离的本地页面，按钮没有提交或跳转行为。</p>
<script>
const button=document.querySelector('#motion-button');
window.siteAnimation=button.animate([{borderColor:'#182744'},{borderColor:'#7489ad'},{borderColor:'#182744'}],{duration:5000,iterations:Infinity});
window.siteAnimation.id='fixture-site-animation';
window.siteCancelCount=0;
const cancel=window.siteAnimation.cancel.bind(window.siteAnimation);
window.siteAnimation.cancel=()=>{window.siteCancelCount++;return cancel();};
</script></html>`;
const workspace = await mkdtemp(path.join(tmpdir(), 'workbench-live-motion-'));
const sourceFile = path.join(workspace, 'fixture.html');
const resultRoot = path.resolve('test-results');
await mkdir(resultRoot, { recursive: true });
const evidenceDir = await mkdtemp(path.join(resultRoot, 'live-motion-'));
await writeFile(sourceFile, fixtureHtml);
await writeFile(path.join(evidenceDir, 'fixture.html'), fixtureHtml);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const originalHash = hash(fixtureHtml);
const startedAt = Date.now();
const report: Record<string, unknown> = {
  passed: false,
  syntheticFixture: true,
  fixtureSourceHash: originalHash,
  emulatedMotionPreference: 'no-preference',
  evidenceDir,
};
const steps: RecordedStep[] = [];
const events: AgentEvent[] = [];
const calls: Array<{
  name: string;
  args: Record<string, unknown>;
  success: boolean;
  text: string;
}> = [];
const prohibited: string[] = [];
let runtime: BrowserRuntime | undefined;
let agent: CodexSession | undefined;
let agentBusy = false;
let timeout: ReturnType<typeof setTimeout> | undefined;
let frameCount = 0;

const server = createServer(async (request, response) => {
  if (request.url !== '/' || request.method !== 'GET') {
    response.writeHead(404).end();
    return;
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'none'",
  );
  try {
    response.end(await readFile(sourceFile, 'utf8'));
  } catch {
    response.writeHead(500).end();
  }
});

async function eventually<T>(read: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    try {
      const value = await read();
      if (matches(value)) return value;
    } catch {
      /* Navigation may still be settling. */
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error('Expected local fixture state did not arrive');
}

function ownedPage() {
  const state = runtime!.getState();
  const tab = (runtime as any).tabs.get(state.activeTabId);
  assert.ok(tab?.page, 'Only this test-owned BrowserRuntime page may be inspected');
  return tab.page;
}

async function motionState(): Promise<MotionState> {
  const response = await ownedPage().call('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const element=document.querySelector('#motion-button');
      const style=getComputedStyle(element), animations=element.getAnimations(), site=window.siteAnimation;
      return {backgroundImage:style.backgroundImage,transform:style.transform,opacity:style.opacity,
        sitePresent:animations.includes(site),siteState:site.playState,siteTime:typeof site.currentTime==='number'?site.currentTime:null,siteCancelCount:window.siteCancelCount,
        animations:animations.map(animation=>({id:animation.id,state:animation.playState,currentTime:typeof animation.currentTime==='number'?animation.currentTime:null}))};
    })()`,
  });
  if (response.exceptionDetails)
    throw new Error('Could not inspect the isolated fixture animation state');
  return response.result.value;
}

function isRedGradient(value: string): boolean {
  if (!/linear-gradient\(/i.test(value)) return false;
  const rgb = [...value.matchAll(/rgba?\(([^)]*)\)/g)].map((match) =>
    match[1]
      .split(/[,\s/]+/)
      .filter(Boolean)
      .slice(0, 3)
      .map(Number),
  );
  const srgb = [...value.matchAll(/color\(srgb\s+([^)]*)\)/g)].map((match) =>
    match[1]
      .split(/[\s/]+/)
      .filter(Boolean)
      .slice(0, 3)
      .map((value) => Number(value) * 255),
  );
  return [...rgb, ...srgb].filter(([r, g, b]) => r > 100 && r > g * 1.3 && r > b * 1.3).length >= 2;
}

async function capture(filename: string): Promise<void> {
  const result = await runtime!.screenshot();
  assert.ok(result.image, 'Expected a real BrowserOS screenshot');
  const data = result.image.startsWith('data:') ? result.image.split(',')[1] : result.image;
  await writeFile(path.join(evidenceDir, filename), Buffer.from(data, 'base64'));
}

try {
  const binary = await discoverBrowserOS(process.env.WORKBENCH_BROWSEROS_TEST_BINARY);
  assert.ok(binary, 'Install BrowserOS neo or set WORKBENCH_BROWSEROS_TEST_BINARY');
  const codex = (await detectAgents()).find(
    (candidate) => candidate.id === 'codex' && candidate.available && candidate.supported,
  );
  assert.ok(codex?.path, 'A working local Codex CLI is required');
  assert.notEqual(
    codex.authentication,
    'missing',
    'Use the existing codex login before this manual test',
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  runtime = new BrowserRuntime({
    storageDir: path.join(workspace, 'browser'),
    binaryPath: binary,
    onState() {},
    onFrame() {
      frameCount++;
    },
    onStep: (step) => steps.push(step),
    onSelected() {},
    onHumanTakeover() {
      if (agentBusy) void agent?.interrupt();
    },
  });
  const allowed = new Set([
    'workbench_browser_snapshot',
    'workbench_browser_query',
    'workbench_browser_inspect',
    'workbench_browser_edit',
    'workbench_browser_undo',
    'workbench_browser_screenshot',
  ]);
  const tools = runtime.getTools().filter((tool) => allowed.has(tool.name));
  const edit = tools.find((tool) => tool.name === 'workbench_browser_edit');
  assert.ok(
    (edit?.inputSchema.properties as Record<string, unknown> | undefined)?.animation,
    'Animation tool schema is not ready; no model request was made',
  );
  await runtime.start();
  await ownedPage().call('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  });
  await runtime.navigate(`${origin}/`);
  const query = await eventually(
    () => runtime!.queryElements({ selector: '#motion-button', limit: 2 }),
    (result) => result.elements.length === 1,
  );
  const selected: ElementDetails = await runtime.selectElement(query.elements[0].ref);
  for (const field of ['ref', 'tabId', 'frameId', 'documentId', 'nodeId', 'selector'] as const)
    assert.ok(selected[field], `Real inspect must supply ${field}`);
  assert.ok(
    'animation' in selected,
    'Page animation inspection is not ready; no model request was made',
  );
  const before = await eventually(
    motionState,
    (state) => state.sitePresent && state.siteState === 'running',
  );
  assert.equal(before.animations.length, 1);
  assert.equal(before.siteCancelCount, 0);
  assert.match(before.backgroundImage, /linear-gradient/);
  assert.equal(isRedGradient(before.backgroundImage), false);
  await capture('before.png');
  runtime.startRecording();
  runtime.allowAgentControl();
  report.codexVersion = codex.version;
  report.toolsFingerprint = browserToolsFingerprint(tools);
  report.selection = selected;
  report.before = before;

  agent = new CodexSession({
    workspace,
    executablePath: codex.path,
    tools,
    callTool: async (name, args) => {
      assert.ok(allowed.has(name));
      assert.equal(
        new URL(runtime!.getState().url).origin,
        origin,
        'The model must stay in the local fixture',
      );
      assert.equal(runtime!.getState().activeTabId, selected.tabId);
      if (name === 'workbench_browser_edit') {
        assert.equal(typeof args.ref, 'string');
        const actualTarget = await runtime!.getElementDetails(args.ref as string);
        assert.equal(
          actualTarget.nodeId,
          selected.nodeId,
          'Only the selected fixture button may be edited',
        );
        assert.equal(actualTarget.frameId, selected.frameId);
        assert.equal(actualTarget.documentId, selected.documentId);
      }
      const result = await runtime!.callTool(name, args);
      calls.push({ name, args, success: !result.isError, text: result.text });
      console.log(JSON.stringify({ stage: 'browser-tool', name, success: !result.isError }));
      return result;
    },
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'approval') {
        prohibited.push(`approval:${event.request.kind}`);
        agent!.resolveApproval(event.request.id, false);
        void agent!.interrupt();
      }
      if (event.type === 'user-input') {
        prohibited.push('unexpected-user-input');
        void agent!.interrupt();
      }
      if (
        event.type === 'tool' &&
        ['commandExecution', 'fileChange', 'mcpToolCall'].includes(event.call.name)
      ) {
        prohibited.push(event.call.name);
        void agent!.interrupt();
      }
      if (event.type === 'error')
        console.log(JSON.stringify({ stage: 'agent-error', message: event.message }));
    },
  });
  agentBusy = true;
  timeout = setTimeout(() => agent?.close(), 150000);
  await agent.send(
    '把这个按钮改成红色渐变，加呼吸弹跳动画。请直接在当前本地测试页面预览，动画保持循环运行，颜色和节奏自行选择，不需要追问。只改附带选中上下文所指的按钮，不点击、不导航、不提交表单、不改源码，不运行本机命令或文件操作。保留网站本来已有的动画。请使用当前浏览器工具实际完成，并通过 inspect 或 screenshot 核对结果；先不要撤销，测试宿主会在完成后独立验收并撤销。',
    JSON.stringify({
      selectedElement: selected,
      pageUrl: `${origin}/`,
      purpose: 'isolated browser preview integration test',
    }),
  );
  agentBusy = false;
  clearTimeout(timeout);
  assert.deepEqual(prohibited, []);
  assert.ok(
    calls.some((call) => call.name === 'workbench_browser_edit' && call.success),
    'The real model must perform a successful edit',
  );
  const inspected = await runtime.getElementDetails(selected.ref);
  assert.ok(inspected.animation && inspected.animation.keyframes.length >= 2);
  assert.equal(inspected.animationState, 'running');
  const after = await eventually(
    motionState,
    (state) =>
      isRedGradient(state.backgroundImage) &&
      state.animations.some(
        (animation) =>
          animation.id.startsWith('workbench-preview:') && animation.state === 'running',
      ),
  );
  const owned = after.animations.filter((animation) =>
    animation.id.startsWith('workbench-preview:'),
  );
  assert.equal(owned.length, 1, 'Exactly one Workbench-owned animation should be active');
  assert.equal(
    after.animations.length,
    2,
    'The website animation must remain alongside the new owned animation',
  );
  assert.equal(after.sitePresent, true);
  assert.equal(after.siteState, 'running');
  assert.equal(after.siteCancelCount, 0);
  await new Promise((resolve) => setTimeout(resolve, 240));
  const later = await motionState();
  const laterOwned = later.animations.find((animation) => animation.id === owned[0].id);
  assert.ok(laterOwned && laterOwned.state === 'running');
  const timeAdvanced =
    typeof laterOwned.currentTime === 'number' &&
    typeof owned[0].currentTime === 'number' &&
    laterOwned.currentTime > owned[0].currentTime + 20;
  const transformChanged = later.transform !== after.transform;
  assert.ok(
    timeAdvanced || transformChanged,
    'The owned animation must actually advance, not merely exist',
  );
  const previews = runtime.getState().previewEdits ?? [];
  assert.ok(
    previews.some((preview) => preview.nodeId === selected.nodeId && preview.changes.animation),
    'Preview changes must retain the animation contract',
  );
  assert.equal(
    hash(await readFile(sourceFile, 'utf8')),
    originalHash,
    'Browser preview must not modify source',
  );
  await capture('animated-red.png');

  const targetEdits = previews.filter(
    (preview) => preview.tabId === selected.tabId && preview.nodeId === selected.nodeId,
  );
  assert.ok(targetEdits.length > 0);
  for (const preview of [...targetEdits].reverse()) await runtime.undoEdit(preview.editId);
  const undone = await motionState();
  assert.equal(undone.backgroundImage, before.backgroundImage);
  assert.equal((await runtime.getElementDetails(selected.ref)).animation, null);
  assert.equal(undone.animations.length, 1);
  assert.equal(undone.animations[0].id, 'fixture-site-animation');
  assert.equal(undone.sitePresent, true);
  assert.equal(undone.siteState, 'running');
  assert.equal(undone.siteCancelCount, 0);
  assert.ok(
    typeof undone.siteTime === 'number' &&
      typeof before.siteTime === 'number' &&
      undone.siteTime > before.siteTime,
  );
  await capture('undone-blue.png');
  await eventually(
    async () => steps,
    (recorded) => recorded.some((step) => step.kind === 'undo'),
  );
  const recording = runtime.stopRecording();
  const recordedChanges = recording.steps
    .filter((step) => step.kind === 'edit')
    .map((step) => ({ step, changes: JSON.parse(step.value ?? '{}') as ElementEdit }));
  assert.ok(
    recordedChanges.some(
      ({ step, changes }) =>
        step.source === 'agent' &&
        step.target?.nodeId === selected.nodeId &&
        changes.animation &&
        changes.animation.keyframes.length >= 2,
    ),
    'Recording edit.value JSON must contain the actual animation changes',
  );
  assert.equal(hash(await readFile(sourceFile, 'utf8')), originalHash);
  await writeFile(path.join(evidenceDir, 'recording.json'), JSON.stringify(recording, null, 2));
  Object.assign(report, {
    passed: true,
    modelTurns: 1,
    frameCount,
    after,
    later,
    undone,
    animation: inspected.animation,
    timeAdvanced,
    transformChanged,
    sourceUnchanged: true,
    websiteAnimationPreserved: true,
    ownedAnimationCount: owned.length,
    undoCount: targetEdits.length,
    recordingIncludesAnimation: true,
    previewEdits: previews,
    completion: events.find((event) => event.type === 'complete'),
  });
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  report.completion = events.find((event) => event.type === 'complete');
  report.sourceUnchanged = await readFile(sourceFile, 'utf8')
    .then((source) => hash(source) === originalHash)
    .catch(() => false);
  process.exitCode = 1;
} finally {
  agentBusy = false;
  clearTimeout(timeout);
  agent?.close();
  runtime?.revokeAgentControl();
  await runtime?.dispose();
  if (server.listening) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  Object.assign(report, {
    elapsedMs: Date.now() - startedAt,
    temporaryWorkspaceRemoved: true,
    prohibited,
    toolCalls: calls,
  });
  await writeFile(path.join(evidenceDir, 'result.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        passed: report.passed,
        elapsedMs: report.elapsedMs,
        evidenceDir,
        error: report.error,
        toolCalls: calls.length,
        temporaryWorkspaceRemoved: true,
      },
      null,
      2,
    ),
  );
}
