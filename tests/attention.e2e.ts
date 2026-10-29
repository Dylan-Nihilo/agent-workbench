/** Isolated renderer → IPC → fake app-server test. No model, Feishu or user credentials are used.
 * Run after npm run build: npx tsx tests/attention.e2e.ts
 */
import assert from 'node:assert/strict';
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppSnapshot, PendingAgentRequest } from '../src/shared/types';

const root = process.cwd();
await access(path.join(root, 'dist/main/main.cjs'));
await mkdir(path.join(root, '.runtime'), { recursive: true });
await mkdir(path.join(root, 'test-results'), { recursive: true });
const temporary = await mkdtemp(path.join(root, '.runtime/attention-test-'));
const bin = path.join(temporary, 'bin');
const dataDir = path.join(temporary, 'user-data');
const protocolLog = path.join(temporary, 'protocol.jsonl');
const resolveControl = path.join(temporary, 'resolve-request');
await mkdir(bin, { recursive: true });
await mkdir(dataDir, { recursive: true });
await writeFile(protocolLog, '');

const fakeCodex = path.join(bin, 'codex');
await writeFile(
  fakeCodex,
  `#!${process.execPath}\n` +
    String.raw`
import fs from 'node:fs';
import readline from 'node:readline';

const log = process.env.WORKBENCH_ATTENTION_LOG;
const control = process.env.WORKBENCH_ATTENTION_RESOLVE;
const record = value => fs.appendFileSync(log, JSON.stringify(value) + '\n');
if (process.argv.includes('--version')) { console.log('codex-cli attention-fixture'); process.exit(0); }
if (process.argv[2] === 'login' && process.argv[3] === 'status') {
  console.error('Logged in using isolated test fixture'); process.exit(0);
}
if (process.argv[2] !== 'app-server') process.exit(2);

const threadId = 'attention-thread-' + process.pid;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const event = (method, params) => send({ method, params });
let counter = 0;
let current;
let mode;
let poll;
const pending = new Map();

function finish(text, turnId = current, status = 'completed') {
  event('item/agentMessage/delta', { threadId, turnId, itemId: 'answer-' + turnId, delta: text });
  event('item/completed', { threadId, turnId, item: { id: 'answer-' + turnId, type: 'agentMessage', text } });
  event('turn/completed', { threadId, turnId, turn: { id: turnId, status, items: [] } });
}
function resolved(requestId, turnId) {
  event('serverRequest/resolved', { threadId, turnId, requestId });
}

readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  record({ event: 'protocol', mode, message: request });
  const params = request.params || {};
  if (request.method === 'initialize') return send({ id: request.id, result: { userAgent: 'attention-fake-codex' } });
  if (request.method === 'thread/start' || request.method === 'thread/resume')
    return send({ id: request.id, result: { thread: { id: threadId } } });
  if (request.method === 'turn/start') {
    current = 'attention-turn-' + (++counter);
    mode = params.input[0].text.split('\n')[0];
    send({ id: request.id, result: { turn: { id: current, status: 'inProgress' } } });
    event('turn/started', { threadId, turnId: current, turn: { id: current, status: 'inProgress' } });
    if (mode === 'attention-input') {
      const id = 'question-410';
      pending.set(id, { kind: 'input', mode, turnId: current });
      return send({ id, method: 'item/tool/requestUserInput', params: {
        threadId, turnId: current, itemId: 'question-item', isBlocking: true,
        questions: [
          { id: 'scope', header: '检查方式', question: '这次如何验证页面？', isSecret: false, isOther: false,
            options: [{ label: '只读检查', description: '查看当前状态，不提交表单。' }, { label: '提交测试表单', description: '在测试页面执行一次提交。' }] },
          { id: 'note', header: '补充说明', question: '补充说明如何提供？', isSecret: false, isOther: true,
            options: [{ label: '默认检查', description: '使用默认验收步骤。' }] },
        ],
      } });
    }
    if (['attention-approval-decline', 'attention-approval-accept', 'attention-approval-expire'].includes(mode)) {
      // Reusing an RPC id across turns exercises the host's messageId boundary.
      const id = 42;
      pending.set(id, { kind: 'approval', mode, turnId: current });
      send({ id, method: 'item/commandExecution/requestApproval', params: {
        threadId, turnId: current, itemId: 'approval-item', command: "printf 'attention test only'",
        reason: mode === 'attention-approval-expire' ? '此请求将由测试 CLI 撤回。' : '验证桌面确认结果能回到 CLI；不会执行实际命令。',
      } });
      if (mode === 'attention-approval-expire') {
        const turnId = current;
        poll = setInterval(() => {
          if (!fs.existsSync(control)) return;
          clearInterval(poll);
          fs.unlinkSync(control);
          pending.delete(id);
          record({ event: 'server-resolved', mode, requestId: id, turnId });
          resolved(id, turnId);
          setTimeout(() => finish('CLI 已撤回请求，未执行操作。', turnId), 450);
        }, 20);
      }
      return;
    }
    return finish('Unexpected attention fixture prompt', current, 'failed');
  }
  if (request.method === 'turn/interrupt') {
    clearInterval(poll);
    pending.clear();
    send({ id: request.id, result: {} });
    return finish('Fixture task interrupted', current, 'interrupted');
  }
  if ('error' in request && pending.has(request.id)) {
    const item = pending.get(request.id);
    pending.delete(request.id);
    return finish('Protocol rejected fixture: ' + request.error.message, item.turnId, 'failed');
  }
  if ('result' in request && pending.has(request.id)) {
    const item = pending.get(request.id);
    pending.delete(request.id);
    record({ event: 'answered', mode: item.mode, requestId: request.id, result: request.result });
    resolved(request.id, item.turnId);
    let result;
    if (item.kind === 'input') {
      const values = request.result.answers;
      const valid = values?.scope?.answers?.[0] === '只读检查'
        && values?.note?.answers?.[0] === '使用隔离测试页面，不提交数据';
      result = valid ? '已收到只读检查与自定义说明，CLI 已继续完成。' : 'Unexpected user-input response';
      return setTimeout(() => finish(result, item.turnId, valid ? 'completed' : 'failed'), 450);
    }
    const expected = item.mode === 'attention-approval-decline' ? 'decline' : 'accept';
    const valid = request.result.decision === expected;
    result = valid ? (expected === 'decline' ? '已收到拒绝，未执行命令。' : '已收到允许，测试流程已完成。') : 'Unexpected approval response';
    return setTimeout(() => finish(result, item.turnId, valid ? 'completed' : 'failed'), 450);
  }
}).on('close', () => { clearInterval(poll); process.exit(0); });
`,
);
await chmod(fakeCodex, 0o700);
for (const name of ['claude', 'opencode', 'gemini']) {
  const executable = path.join(bin, name);
  await writeFile(
    executable,
    `#!${process.execPath}\nconsole.log('${name} isolated attention fixture');\n`,
  );
  await chmod(executable, 0o700);
}

const env: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: `${bin}${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`,
  WORKBENCH_USER_DATA_DIR: dataDir,
  WORKBENCH_ATTENTION_LOG: protocolLog,
  WORKBENCH_ATTENTION_RESOLVE: resolveControl,
  WORKBENCH_BROWSER_PATH:
    process.env.WORKBENCH_BROWSER_PATH ||
    process.env.WORKBENCH_BROWSEROS_PATH ||
    path.resolve(root, '../browseros-runtime/BrowserOS neo.app'),
};
for (const key of [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'WORKBENCH_DEV_SERVER_URL',
])
  delete env[key];

let application: ElectronApplication | undefined;
const errors: string[] = [];
const checks: string[] = [];
let passed = false;
try {
  application = await electron.launch({
    args: ['.'],
    cwd: root,
    env: Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  });
  const page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await expect(page.getByRole('heading', { name: '今天想完成什么？' })).toBeVisible();
  const snapshot = () => page.evaluate(() => window.workbench.invoke<AppSnapshot>('app:snapshot'));
  const initial = await snapshot();
  assert.equal(initial.agents.find((item) => item.id === 'codex')?.path, fakeCodex);
  assert.equal(initial.agents.find((item) => item.id === 'codex')?.authentication, 'ready');
  assert.equal(initial.feishu.paired, false);
  assert.equal(initial.feishu.appId, undefined);
  const actualDataDir = await application.evaluate(({ app }) => app.getPath('userData'));
  assert.equal(actualDataDir, dataDir);
  // Let the host finish its initial local-page navigation before starting an Agent turn.
  await expect
    .poll(async () => (await snapshot()).browser.title, { timeout: 30_000 })
    .toContain('今日清单');
  await expect.poll(async () => (await snapshot()).browser.loading).toBe(false);
  checks.push('Isolated Electron userData and fake CLI detected; no saved Feishu identity');

  const panel = page.getByRole('region', { name: 'Agent 待处理事项' });
  async function sendPrompt(text: string) {
    await expect(panel).toHaveCount(0);
    await page.getByRole('textbox', { name: '发送给 Agent 的任务' }).fill(text);
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect(panel).toBeVisible();
    await expect.poll(async () => (await snapshot()).pendingRequests?.length).toBe(1);
    return (await snapshot()).pendingRequests![0];
  }
  async function rejectStale(
    action: string,
    pending: PendingAgentRequest,
    value: Record<string, unknown>,
  ) {
    for (const wrong of [
      { conversationId: 'stale-conversation' },
      { messageId: 'stale-message' },
    ]) {
      const result = await page.evaluate(
        async ({ action, payload }) => {
          try {
            await window.workbench.invoke(action, payload);
            return { rejected: false, error: '' };
          } catch (error) {
            return { rejected: true, error: String(error) };
          }
        },
        {
          action,
          payload: {
            id: pending.request.id,
            conversationId: pending.conversationId,
            messageId: pending.messageId,
            ...value,
            ...wrong,
          },
        },
      );
      assert.equal(result.rejected, true);
      assert.match(result.error, /失效/);
      await expect(panel).toBeVisible();
      assert.equal((await snapshot()).pendingRequests?.length, 1);
    }
  }
  async function waitDone(pending: PendingAgentRequest, expectedText: string) {
    await expect(panel).toHaveCount(0);
    await expect
      .poll(async () => {
        const state = await snapshot();
        return state.conversations
          .find((item) => item.id === pending.conversationId)
          ?.messages.find((item) => item.id === pending.messageId)?.status;
      })
      .toBe('done');
    const state = await snapshot();
    assert.equal(
      state.conversations
        .find((item) => item.id === pending.conversationId)
        ?.messages.find((item) => item.id === pending.messageId)?.text,
      expectedText,
    );
    assert.equal(state.pendingRequests?.length, 0);
  }
  const recorded = async () =>
    (await readFile(protocolLog, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));

  const input = await sendPrompt('attention-input');
  assert.equal(input.kind, 'input');
  const submit = panel.getByRole('button', { name: '提交回答', exact: true });
  await expect(submit).toBeDisabled();
  await rejectStale('agent:user-input', input, {
    answers: { scope: ['只读检查'], note: ['默认检查'] },
  });
  assert.equal(
    (await recorded()).some((entry) => entry.event === 'answered'),
    false,
  );
  await panel.getByRole('radio', { name: /^只读检查/ }).check();
  await expect(submit).toBeDisabled();
  await panel.getByRole('radio', { name: '自行填写', exact: true }).check();
  const freeform = panel.getByRole('textbox', { name: '补充说明如何提供？', exact: true });
  await expect(freeform).toBeVisible();
  await freeform.fill('   ');
  await expect(submit).toBeDisabled();
  await freeform.fill('使用隔离测试页面，不提交数据');
  await expect(submit).toBeEnabled();
  await page.screenshot({
    path: path.join(root, 'test-results/attention.png'),
    animations: 'disabled',
  });
  await submit.click();
  await waitDone(input, '已收到只读检查与自定义说明，CLI 已继续完成。');
  const inputReplies = (await recorded()).filter(
    (entry) => entry.event === 'answered' && entry.mode === 'attention-input',
  );
  assert.equal(inputReplies.length, 1);
  assert.deepEqual(inputReplies[0].result.answers, {
    scope: { answers: ['只读检查'] },
    note: { answers: ['使用隔离测试页面，不提交数据'] },
  });
  checks.push(
    'User input: no implicit selection, required answers, isOther freeform, IPC round-trip and resolved card removal',
  );

  const declined = await sendPrompt('attention-approval-decline');
  assert.equal(declined.kind, 'approval');
  await rejectStale('agent:approval', declined, { approved: true });
  await panel.getByRole('button', { name: '拒绝', exact: true }).click();
  await waitDone(declined, '已收到拒绝，未执行命令。');
  checks.push(
    'Approval decline reaches the fake CLI and the task completes without running a command',
  );

  const accepted = await sendPrompt('attention-approval-accept');
  assert.equal(accepted.request.id, declined.request.id);
  assert.notEqual(accepted.messageId, declined.messageId);
  const reusedIdResult = await page.evaluate(
    async (payload) => {
      try {
        await window.workbench.invoke('agent:approval', payload);
        return false;
      } catch {
        return true;
      }
    },
    {
      id: declined.request.id,
      conversationId: declined.conversationId,
      messageId: declined.messageId,
      approved: true,
    },
  );
  assert.equal(reusedIdResult, true);
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: '允许这次操作', exact: true }).click();
  await waitDone(accepted, '已收到允许，测试流程已完成。');
  const approvalReplies = (await recorded()).filter(
    (entry) => entry.event === 'answered' && entry.mode.startsWith('attention-approval-'),
  );
  assert.deepEqual(
    approvalReplies.map((entry) => entry.result.decision),
    ['decline', 'accept'],
  );
  checks.push('Approval accept works; a reused RPC id with an old assistant messageId is rejected');

  const expired = await sendPrompt('attention-approval-expire');
  await writeFile(resolveControl, 'resolve');
  await expect(panel).toHaveCount(0);
  assert.equal((await snapshot()).pendingRequests?.length, 0);
  const expiredResult = await page.evaluate(
    async (payload) => {
      try {
        await window.workbench.invoke('agent:approval', payload);
        return false;
      } catch {
        return true;
      }
    },
    {
      id: expired.request.id,
      conversationId: expired.conversationId,
      messageId: expired.messageId,
      approved: true,
    },
  );
  assert.equal(expiredResult, true);
  await waitDone(expired, 'CLI 已撤回请求，未执行操作。');
  assert.equal(
    (await recorded()).filter(
      (entry) => entry.event === 'answered' && entry.mode === 'attention-approval-expire',
    ).length,
    0,
  );
  checks.push(
    'serverRequest/resolved removes the card and rejects subsequent approval without a CLI response',
  );

  assert.deepEqual(errors, []);
  assert.equal(application.windows().length, 1);
  passed = true;
  console.log(
    JSON.stringify({ passed: true, checks, screenshot: 'test-results/attention.png' }, null, 2),
  );
} catch (error) {
  if (application) {
    try {
      await (
        await application.firstWindow()
      ).screenshot({
        path: path.join(root, 'test-results/attention-failure.png'),
        animations: 'disabled',
      });
    } catch {
      /* The isolated renderer may have already exited. */
    }
  }
  throw error;
} finally {
  await writeFile(
    path.join(root, 'test-results/attention.json'),
    JSON.stringify({ passed, checks, errors }, null, 2),
  );
  await application?.close();
  await writeFile(
    path.join(root, 'test-results/attention-protocol.jsonl'),
    await readFile(protocolLog, 'utf8'),
  );
  await rm(temporary, { recursive: true, force: true });
}
