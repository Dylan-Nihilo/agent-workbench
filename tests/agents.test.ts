import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexSession, detectAgents } from '../src/main/agents.ts';
import type { AgentEvent, ToolResult } from '../src/shared/types.ts';

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-agent-test-'));
  const executable = path.join(directory, 'codex');
  const log = path.join(directory, 'requests.jsonl');
  const code = `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const log = ${JSON.stringify(log)};
if (process.argv.includes('--version')) { console.log('codex-cli test'); process.exit(0); }
if (process.argv.includes('status')) {
  fs.writeFileSync(log, JSON.stringify({apiKeyPresent:!!process.env.OPENAI_API_KEY}));
  console.error('Logged in using ChatGPT'); process.exit(0);
}
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const event = (method, params) => send({method, params});
let turn = 0, current, mode;
const finish = (status='completed', error) => event('turn/completed', {threadId:'thread-1',turn:{id:current,status,items:[],error}});
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 30));
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line); fs.appendFileSync(log, line+'\\n');
  const p = request.params || {};
  if (request.method === 'initialize') return send({id:request.id,result:{userAgent:'fake-codex'}});
  if (request.method === 'thread/start') return send({id:request.id,result:{thread:{id:'thread-1'}}});
  if (request.method === 'thread/resume') return p.threadId==='thread-1' ? send({id:request.id,result:{thread:{id:'thread-1'}}}) : send({id:request.id,error:{code:-32602,message:'Thread not found'}});
  if (request.method === 'turn/start') {
    current='turn-'+(++turn); mode=p.input[0].text.split('\\n')[0];
    send({id:request.id,result:{turn:{id:current,status:'inProgress'}}});
    event('turn/started',{threadId:'thread-1',turn:{id:current,status:'inProgress'}});
    if(mode==='fail') return finish('failed',{message:'model unavailable'});
    if(mode==='exit') return process.exit(7);
    if(mode==='cancel') return;
    if(mode==='approval'||mode==='approval-retracted') {
      send({id:100,method:'item/commandExecution/requestApproval',params:{threadId:'thread-1',turnId:current,itemId:'command-1',command:'touch example.txt',cwd:${JSON.stringify(directory)}}});
      if(mode==='approval-retracted') { event('serverRequest/resolved',{threadId:'thread-1',requestId:100}); finish(); }
      return;
    }
    if(mode.startsWith('question')) {
      const questions=[
        {id:'route',header:'路径',question:'请选择实现路径',options:[{label:'Small',description:'最小实现'},{label:'Full',description:'完整实现'}],isOther:mode==='question-other'},
        {id:'note',header:'备注',question:'请输入补充说明',isSecret:mode==='question-secret',options:null}
      ];
      if(mode==='question-malformed') questions[1].id='route';
      send({id:110,method:'item/tool/requestUserInput',params:{threadId:mode==='question-foreign'?'another-thread':'thread-1',turnId:current,itemId:'question-1',isBlocking:true,autoResolutionMs:1,questions}});
      if(mode==='question-retracted') { event('serverRequest/resolved',{threadId:'thread-1',requestId:110}); finish(); }
      if(mode==='question-foreign-resolved') event('serverRequest/resolved',{threadId:'another-thread',requestId:110});
      return;
    }
    if(mode==='tool'||mode==='unknown'||mode==='pending-tool') return send({id:101,method:'item/tool/call',params:{threadId:'thread-1',turnId:current,callId:'tool-1',tool:mode==='unknown'?'read_secret':'browser_snapshot',arguments:{}}});
    event('item/agentMessage/delta',{threadId:'thread-1',turnId:current,itemId:'message-'+turn,delta:'Hello'});
    event('item/agentMessage/delta',{threadId:'thread-1',turnId:current,itemId:'message-'+turn,delta:' world'});
    event('item/completed',{threadId:'thread-1',turnId:current,item:{id:'message-'+turn,type:'agentMessage',text:'Hello world'}});
    return finish();
  }
  if(request.method==='turn/interrupt') { send({id:request.id,result:{}}); return finish('interrupted'); }
  if(request.id===100 && 'result' in request) { event('serverRequest/resolved',{threadId:'thread-1',requestId:100}); event('item/agentMessage/delta',{threadId:'thread-1',turnId:current,itemId:'approval-result',delta:request.result.decision}); return finish(); }
  if(request.id===110 && ('result' in request || 'error' in request)) { event('serverRequest/resolved',{threadId:'thread-1',requestId:110}); event('item/agentMessage/delta',{threadId:'thread-1',turnId:current,itemId:'input-result',delta:'Answers handled'}); return finish(); }
  if(request.id===101 && 'result' in request && mode!=='pending-tool') { event('item/agentMessage/delta',{threadId:'thread-1',turnId:current,itemId:'tool-result',delta:request.result.success?'tool succeeded':'tool rejected'}); return finish(); }
});
`;
  await writeFile(executable, code);
  await chmod(executable, 0o700);
  return {
    directory,
    executable,
    log,
    async requests() {
      return (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for protocol event');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function session(
  f: Awaited<ReturnType<typeof fixture>>,
  events: AgentEvent[],
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult> = async () => ({
    text: 'snapshot',
  }),
  sessionId?: string,
) {
  return new CodexSession({
    workspace: f.directory,
    executablePath: f.executable,
    sessionId,
    tools: [
      {
        name: 'browser_snapshot',
        description: 'Read the current browser',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
    callTool,
    onEvent: (event) => events.push(event),
  });
}

test('structured streaming uses existing CLI and restrictive per-process configuration', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  const agent = session(f, events);
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  await agent.send('hello', 'Selected page');
  assert.equal(agent.sessionId, 'thread-1');
  assert.equal(
    events
      .filter((event) => event.type === 'delta')
      .map((event) => event.text)
      .join(''),
    'Hello world',
  );
  assert.equal(events.filter((event) => event.type === 'complete').length, 1);
  const requests = await f.requests();
  const start = requests.find((request) => request.method === 'thread/start').params;
  assert.equal(start.sandbox, 'read-only');
  assert.equal(start.approvalPolicy, 'untrusted');
  assert.equal(start.approvalsReviewer, 'user');
  assert.equal(start.model, undefined);
  assert.deepEqual(start.config.mcp_servers, {});
  assert.equal(start.config.features.plugins, false);
  assert.equal(start.config.features.default_mode_request_user_input, true);
  assert.equal(start.dynamicTools[0].type, 'function');
  assert.match(
    requests.find((request) => request.method === 'turn/start').params.input[0].text,
    /page_context/,
  );
});

test('browser tool bridge returns text and screenshot in the actual app-server schema', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  let calls = 0;
  const agent = session(f, events, async (name, args) => {
    calls++;
    assert.equal(name, 'browser_snapshot');
    assert.deepEqual(args, {});
    return { text: 'Current page', image: 'iVBORw0KGgo=' };
  });
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  await agent.send('tool');
  const reply = (await f.requests()).find((request) => request.id === 101 && request.result);
  assert.equal(calls, 1);
  assert.equal(reply.result.success, true);
  assert.deepEqual(
    reply.result.contentItems.map((item: { type: string }) => item.type),
    ['inputText', 'inputImage'],
  );
  assert.equal(reply.result.contentItems[1].imageUrl, 'data:image/png;base64,iVBORw0KGgo=');
  assert.ok(events.some((event) => event.type === 'tool' && event.call.status === 'done'));
});

test('unknown dynamic tools are refused without calling the host', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  let calls = 0;
  const agent = session(f, events, async () => {
    calls++;
    return { text: 'unexpected' };
  });
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  await agent.send('unknown');
  const reply = (await f.requests()).find((request) => request.id === 101 && request.result);
  assert.equal(calls, 0);
  assert.equal(reply.result.success, false);
});

test('command approval waits for an explicit decision and declines correctly', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  const agent = session(f, events);
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  const sent = agent.send('approval');
  await waitFor(() => events.some((event) => event.type === 'approval'));
  assert.equal(
    (await f.requests()).some((request) => request.id === 100 && request.result),
    false,
  );
  const approval = events.find((event) => event.type === 'approval');
  assert.ok(approval && approval.type === 'approval');
  agent.resolveApproval(approval.request.id, false);
  await sent;
  assert.equal(
    (await f.requests()).find((request) => request.id === 100 && request.result).result.decision,
    'decline',
  );
  assert.throws(() => agent.resolveApproval(approval.request.id, true), /不存在/);
  assert.equal(
    events.filter((event) => event.type === 'request-resolved' && event.id === approval.request.id)
      .length,
    1,
    'The local answer and server acknowledgement must not resolve the UI request twice',
  );
});

test('questions wait for an explicit validated answer and use the app-server answer envelope', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  const agent = session(f, events);
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  const sent = agent.send('question');
  await waitFor(() => events.some((event) => event.type === 'user-input'));
  const input = events.find((event) => event.type === 'user-input');
  assert.ok(input && input.type === 'user-input');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(
    (await f.requests()).some((request) => request.id === 110 && request.result),
    false,
  );
  assert.throws(
    () => agent.resolveUserInput('wrong-request', { route: ['Small'], note: ['ok'] }),
    /不存在/,
  );
  assert.throws(() => agent.resolveUserInput(input.request.id, { route: ['Small'] }), /每一个/);
  assert.throws(
    () =>
      agent.resolveUserInput(input.request.id, { route: ['Small'], note: ['ok'], extra: ['x'] }),
    /未知/,
  );
  assert.throws(
    () => agent.resolveUserInput(input.request.id, { route: ['Unknown'], note: ['ok'] }),
    /选项/,
  );
  assert.throws(
    () =>
      agent.resolveUserInput(input.request.id, { route: ['Small'], note: ['x'.repeat(20_001)] }),
    /最多/,
  );
  assert.throws(
    () => agent.resolveUserInput(input.request.id, { route: ['Small', 'Small'], note: ['ok'] }),
    /不重复/,
  );
  input.request.questions[0].isOther = true;
  assert.throws(
    () => agent.resolveUserInput(input.request.id, { route: ['Mutated'], note: ['ok'] }),
    /选项/,
    'UI event mutation must not change the validation policy',
  );
  agent.resolveUserInput(input.request.id, { route: ['Small'], note: ['用户提供的补充说明'] });
  await sent;
  const reply = (await f.requests()).find((request) => request.id === 110 && request.result);
  assert.deepEqual(reply.result, {
    answers: { route: { answers: ['Small'] }, note: { answers: ['用户提供的补充说明'] } },
  });
  assert.equal(
    events.filter((event) => event.type === 'request-resolved' && event.id === input.request.id)
      .length,
    1,
  );
  assert.throws(
    () => agent.resolveUserInput(input.request.id, { route: ['Small'], note: ['late'] }),
    /不存在/,
  );
});

test('explicit Other questions accept free text and secret answers never enter events', async (t) => {
  for (const mode of ['question-other', 'question-secret']) {
    const f = await fixture();
    const events: AgentEvent[] = [];
    const agent = session(f, events);
    t.after(() => {
      agent.close();
      return f.cleanup();
    });
    const sent = agent.send(mode);
    await waitFor(() => events.some((event) => event.type === 'user-input'));
    const input = events.find((event) => event.type === 'user-input');
    assert.ok(input && input.type === 'user-input');
    const answer = mode === 'question-secret' ? 'FAKE_SECRET_VALUE_NOT_FOR_LOGS' : '自由补充说明';
    assert.equal(input.request.questions[1].isSecret, mode === 'question-secret');
    assert.equal(input.request.questions[0].isOther, mode === 'question-other');
    agent.resolveUserInput(input.request.id, {
      route: [mode === 'question-other' ? 'Custom approach' : 'Full'],
      note: [answer],
    });
    await sent;
    assert.equal(JSON.stringify(events).includes(answer), false);
  }
});

test('server withdrawal resolves approvals and questions without an invented response', async (t) => {
  for (const mode of ['approval-retracted', 'question-retracted']) {
    const f = await fixture();
    const events: AgentEvent[] = [];
    const agent = session(f, events);
    t.after(() => {
      agent.close();
      return f.cleanup();
    });
    await agent.send(mode);
    const request = events.find(
      (event) => event.type === 'approval' || event.type === 'user-input',
    );
    assert.ok(request && (request.type === 'approval' || request.type === 'user-input'));
    assert.equal(
      events.filter((event) => event.type === 'request-resolved' && event.id === request.request.id)
        .length,
      1,
    );
    if (request.type === 'approval')
      assert.throws(() => agent.resolveApproval(request.request.id, true), /不存在/);
    else
      assert.throws(
        () => agent.resolveUserInput(request.request.id, { route: ['Full'], note: ['late'] }),
        /不存在/,
      );
    const rpcId = mode === 'approval-retracted' ? 100 : 110;
    assert.equal(
      (await f.requests()).some((message) => message.id === rpcId && message.result),
      false,
    );
  }
});

test('foreign-thread resolution cannot remove the active question', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  const agent = session(f, events);
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  const sent = agent.send('question-foreign-resolved');
  await waitFor(() => events.some((event) => event.type === 'user-input'));
  const input = events.find((event) => event.type === 'user-input');
  assert.ok(input && input.type === 'user-input');
  assert.equal(
    events.some((event) => event.type === 'request-resolved'),
    false,
  );
  agent.resolveUserInput(input.request.id, { route: ['Small'], note: ['ok'] });
  await sent;
});

test('malformed and foreign-thread questions never reach the UI', async (t) => {
  for (const mode of ['question-malformed', 'question-foreign']) {
    const f = await fixture();
    const events: AgentEvent[] = [];
    const agent = session(f, events);
    t.after(() => {
      agent.close();
      return f.cleanup();
    });
    await agent.send(mode);
    assert.equal(
      events.some((event) => event.type === 'user-input'),
      false,
    );
    const reply = (await f.requests()).find((request) => request.id === 110);
    if (mode === 'question-malformed') assert.equal(reply.error.code, -32602);
    else assert.deepEqual(reply.result, { answers: {} });
  }
});

test('interrupt and close clear pending questions with empty answers and no successful completion', async (t) => {
  for (const operation of ['interrupt', 'close'] as const) {
    const f = await fixture();
    const events: AgentEvent[] = [];
    const agent = session(f, events);
    t.after(() => {
      agent.close();
      return f.cleanup();
    });
    const stopped = assert.rejects(
      agent.send('question'),
      operation === 'close' ? /已关闭/ : /已停止/,
    );
    await waitFor(() => events.some((event) => event.type === 'user-input'));
    const input = events.find((event) => event.type === 'user-input');
    assert.ok(input && input.type === 'user-input');
    await agent[operation]();
    await stopped;
    await waitFor(async () =>
      (await f.requests()).some((request) => request.id === 110 && request.result),
    );
    const reply = (await f.requests()).find((request) => request.id === 110 && request.result);
    assert.deepEqual(reply.result, { answers: {} });
    assert.equal(
      events.filter((event) => event.type === 'request-resolved' && event.id === input.request.id)
        .length,
      1,
    );
    assert.equal(
      events.some((event) => event.type === 'complete'),
      false,
    );
    assert.throws(
      () => agent.resolveUserInput(input.request.id, { route: ['Full'], note: ['late'] }),
      /不存在/,
    );
  }
});

test('failed and canceled turns reject and never emit a successful completion', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  const agent = session(f, events);
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  await assert.rejects(agent.send('fail'), /model unavailable/);
  assert.equal(
    events.some((event) => event.type === 'complete'),
    false,
  );
  const canceled = assert.rejects(agent.send('cancel'), /任务已停止/);
  await waitFor(
    () =>
      events.filter((event) => event.type === 'status' && event.status === 'thinking').length === 2,
  );
  // The response may still be in transit; interrupt also handles that startup race.
  await agent.interrupt();
  await canceled;
  assert.equal(
    events.some((event) => event.type === 'complete'),
    false,
  );
  await agent.send('hello');
  assert.equal(events.filter((event) => event.type === 'complete').length, 1);
});

test('canceling a pending tool prevents its late result from reporting success', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  let release!: (result: ToolResult) => void;
  const agent = session(
    f,
    events,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  const canceled = assert.rejects(agent.send('pending-tool'), /任务已停止/);
  await waitFor(() => !!release);
  await agent.interrupt();
  await canceled;
  release({ text: 'late success' });
  await waitFor(() =>
    events.some((event) => event.type === 'tool' && event.call.status === 'error'),
  );
  assert.equal(
    events.some((event) => event.type === 'complete'),
    false,
  );
});

test('unexpected CLI exit rejects active work', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  const agent = session(f, events);
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  await assert.rejects(agent.send('exit'), /进程已退出/);
  assert.equal(
    events.some((event) => event.type === 'complete'),
    false,
  );
});

test('saved sessions use thread/resume and retain restrictive runtime settings', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  const agent = session(f, events, undefined, 'thread-1');
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  await agent.send('hello');
  const requests = await f.requests();
  assert.equal(
    requests.some((request) => request.method === 'thread/start'),
    false,
  );
  const resume = requests.find((request) => request.method === 'thread/resume').params;
  assert.equal(resume.threadId, 'thread-1');
  assert.equal(resume.sandbox, 'read-only');
  assert.equal(resume.dynamicTools, undefined);
  assert.deepEqual(resume.config.mcp_servers, {});
  assert.equal(agent.sessionId, 'thread-1');
});

test('a missing saved session does not silently replace conversation history', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  const agent = session(f, events, undefined, 'missing-thread');
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  await assert.rejects(agent.send('hello'), /无法恢复 Codex 会话/);
  const requests = await f.requests();
  assert.equal(
    requests.some(
      (request) => request.method === 'thread/start' || request.method === 'turn/start',
    ),
    false,
  );
  assert.equal(
    events.some((event) => event.type === 'complete'),
    false,
  );
});

test('discovery uses executable PATH entries and does not pass an API key to login status', async (t) => {
  const f = await fixture();
  const oldPath = process.env.PATH;
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.PATH = `${f.directory}${path.delimiter}${oldPath ?? ''}`;
  process.env.OPENAI_API_KEY = 'fake-test-only';
  t.after(async () => {
    process.env.PATH = oldPath;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
    await f.cleanup();
  });
  const agents = await detectAgents();
  const codex = agents.find((agent) => agent.id === 'codex');
  assert.ok(codex);
  assert.equal(codex.path, f.executable);
  assert.equal(codex.authentication, 'ready');
  assert.equal(codex.version, 'codex-cli test');
  assert.equal(JSON.parse(await readFile(f.log, 'utf8')).apiKeyPresent, false);
  assert.ok(agents.filter((agent) => agent.id !== 'codex').every((agent) => !agent.supported));
});
