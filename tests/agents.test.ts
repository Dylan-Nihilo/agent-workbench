import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexSession, browserToolsFingerprint, detectAgents } from '../src/main/agents.ts';
import type { AgentEvent, ToolResult } from '../src/shared/types.ts';

async function fixture(
  options: {
    initializeDelayMs?: number;
    threadStartDelayMs?: number;
    waitForLogin?: boolean;
    loginMessage?: string;
  } = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-agent-test-'));
  const executable = path.join(directory, 'codex');
  const log = path.join(directory, 'requests.jsonl');
  const code = `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const log = ${JSON.stringify(log)};
const options = ${JSON.stringify(options)};
if (process.argv.includes('--version')) {
  if(options.waitForLogin) { setInterval(()=>{if(fs.existsSync(log+'.login')) {console.log('codex-cli test');process.exit(0);}},10); }
  else { console.log('codex-cli test'); process.exit(0); }
}
if (process.argv.includes('status')) {
  fs.writeFileSync(log+'.login','checked');
  fs.writeFileSync(log, JSON.stringify({apiKeyPresent:!!process.env.OPENAI_API_KEY}));
  console.error(options.loginMessage || 'Logged in using ChatGPT'); process.exit(0);
}
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const event = (method, params) => send({method, params});
let turn = 0, current, mode, pendingTool = false;
const finish = (status='completed', error) => event('turn/completed', {threadId:'thread-1',turn:{id:current,status,items:[],error}});
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 30));
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line); fs.appendFileSync(log, line+'\\n');
  const p = request.params || {};
  if (request.method === 'initialize') return setTimeout(()=>send({id:request.id,result:{userAgent:'fake-codex'}}),options.initializeDelayMs||0);
  if (request.method === 'thread/start') return setTimeout(()=>send({id:request.id,result:{thread:{id:'thread-1'}}}),options.threadStartDelayMs||0);
  if (request.method === 'thread/resume') return p.threadId==='thread-1' ? send({id:request.id,result:{thread:{id:'thread-1'}}}) : send({id:request.id,error:{code:-32602,message:'Thread not found'}});
  if (request.method === 'turn/start') {
    current='turn-'+(++turn); mode=p.input[0].text.split('\\n')[0];
    if(mode==='pre-ack') {
      event('turn/started',{threadId:'thread-1',turn:{id:current,status:'inProgress'}});
      send({id:110,method:'item/tool/requestUserInput',params:{threadId:'thread-1',turnId:current,itemId:'pre-ack-input',isBlocking:true,questions:[{id:'choice',header:'选择',question:'Choose one',options:[{label:'A',description:''},{label:'B',description:''}]}]}});
      return setTimeout(()=>send({id:request.id,result:{turn:{id:current,status:'inProgress'}}}),30);
    }
    send({id:request.id,result:{turn:{id:current,status:'inProgress'}}});
    event('turn/started',{threadId:'thread-1',turn:{id:current,status:'inProgress'}});
    if(mode==='fail') return finish('failed',{message:'model unavailable'});
    if(mode==='fatal-error') return event('error',{threadId:'thread-1',turnId:current,error:{message:'connection lost'},willRetry:false});
    if(mode==='exit') return process.exit(7);
    if(mode==='cancel'||mode==='cancel-ack-only') { event('item/agentMessage/delta',{threadId:'thread-1',turnId:current,itemId:'cancel-wait',delta:'Waiting for cancellation'}); return; }
    if(mode==='descendant') {
      const descendant=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      fs.writeFileSync(log+'.pid',String(descendant.pid));
      event('item/agentMessage/delta',{threadId:'thread-1',turnId:current,itemId:'child-wait',delta:'Child running'});return;
    }
    if(mode==='late-terminal') {
      event('turn/started',{threadId:'thread-1',turn:{id:'previous-turn',status:'inProgress'}});
      event('turn/completed',{threadId:'thread-1',turn:{id:'previous-turn',status:'completed',items:[]}});
    }
    if(mode==='exit-code') event('item/completed',{threadId:'thread-1',turnId:current,item:{id:'failed-command',type:'commandExecution',status:'completed',command:'npm test',exitCode:2,aggregatedOutput:'test failed'}});
    if(mode==='file-approval') {
      event('item/started',{threadId:'thread-1',turnId:current,item:{id:'file-1',type:'fileChange',status:'inProgress',changes:[{path:${JSON.stringify(path.join(directory, 'index.html'))},kind:{type:'update'},diff:'-Old label\\n+New label'}]}});
      return send({id:120,method:'item/fileChange/requestApproval',params:{threadId:'thread-1',turnId:current,itemId:'file-1',startedAtMs:Date.now(),grantRoot:null}});
    }
    if(mode==='approval'||mode==='approval-retracted'||mode==='approval-with-tool') {
      send({id:100,method:'item/commandExecution/requestApproval',params:{threadId:'thread-1',turnId:current,itemId:'command-1',command:'touch example.txt',cwd:${JSON.stringify(directory)}}});
      if(mode==='approval-retracted') { event('serverRequest/resolved',{threadId:'thread-1',requestId:100}); finish(); }
      if(mode==='approval-with-tool') event('item/started',{threadId:'thread-1',turnId:current,item:{id:'parallel-tool',type:'commandExecution',status:'inProgress',command:'test fixture'}});
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
    if(mode==='tool'||mode==='unknown'||mode==='pending-tool'||mode==='foreign-tool') {
      pendingTool=mode==='pending-tool';
      return send({id:101,method:'item/tool/call',params:{threadId:'thread-1',turnId:mode==='foreign-tool'?'previous-turn':current,callId:'tool-1',tool:mode==='unknown'?'read_secret':'browser_snapshot',arguments:{}}});
    }
    event('item/agentMessage/delta',{threadId:'thread-1',turnId:current,itemId:'message-'+turn,delta:'Hello'});
    event('item/agentMessage/delta',{threadId:'thread-1',turnId:current,itemId:'message-'+turn,delta:' world'});
    event('item/completed',{threadId:'thread-1',turnId:current,item:{id:'message-'+turn,type:'agentMessage',text:'Hello world'}});
    return finish();
  }
  if(request.method==='turn/interrupt') { send({id:request.id,result:{}}); if(mode==='cancel-ack-only') return; return finish('interrupted'); }
  if(request.id===100 && 'result' in request) { event('serverRequest/resolved',{threadId:'thread-1',requestId:100}); event('item/agentMessage/delta',{threadId:'thread-1',turnId:current,itemId:'approval-result',delta:request.result.decision}); return finish(); }
  if(request.id===110 && ('result' in request || 'error' in request)) { event('serverRequest/resolved',{threadId:'thread-1',requestId:110}); event('item/agentMessage/delta',{threadId:'thread-1',turnId:current,itemId:'input-result',delta:'Answers handled'}); return finish(); }
  if(request.id===120 && 'result' in request) return finish();
  if(request.id===101 && 'result' in request && !pendingTool) { event('item/agentMessage/delta',{threadId:'thread-1',turnId:current,itemId:'tool-result',delta:request.result.success?'tool succeeded':'tool rejected'}); return finish(); }
});
`;
  await writeFile(executable, code);
  await chmod(executable, 0o700);
  return {
    directory,
    executable,
    log,
    async requests() {
      return (
        await readFile(log, 'utf8').catch((error) => {
          if (error.code === 'ENOENT') return '';
          throw error;
        })
      )
        .trim()
        .split('\n')
        .filter(Boolean)
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
  overrides: Partial<ConstructorParameters<typeof CodexSession>[0]> = {},
) {
  const tools = [
    {
      name: 'browser_snapshot',
      description: 'Read the current browser',
      inputSchema: { type: 'object', properties: {} },
    },
  ];
  return new CodexSession({
    workspace: f.directory,
    executablePath: f.executable,
    sessionId,
    sessionToolsFingerprint: sessionId ? browserToolsFingerprint(tools) : undefined,
    tools,
    callTool,
    onEvent: (event) => events.push(event),
    ...overrides,
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
  assert.deepEqual(start.environments, [
    { environmentId: 'local', cwd: f.directory, runtimeWorkspaceRoots: [f.directory] },
  ]);
  assert.deepEqual(
    requests.find((request) => request.method === 'turn/start').params.environments,
    start.environments,
  );
  assert.equal(start.dynamicTools[0].type, 'function');
  assert.match(start.developerInstructions, /exact tabId, frameId, documentId and ref/);
  assert.match(start.developerInstructions, /preview is not saved source code/);
  assert.match(start.developerInstructions, /verify the actual owning file\/component/);
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
  await waitFor(() =>
    events.some((event) => event.type === 'delta' && event.text === 'Waiting for cancellation'),
  );
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
  const eventCount = events.length;
  release({ text: 'late success' });
  await waitFor(async () =>
    (await f.requests()).some((request) => request.id === 101 && request.result),
  );
  assert.equal(
    events.slice(eventCount).some((event) => event.type === 'tool'),
    false,
    'A late tool must not attach itself to a later turn',
  );
  assert.equal(
    (await f.requests()).find((request) => request.id === 101 && request.result).result.success,
    false,
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
  assert.equal(agent.isClosed, true);
  assert.equal(agent.sessionId, 'thread-1');
  const replacement = session(f, [], undefined, agent.sessionId, {
    sessionToolsFingerprint: agent.toolsFingerprint,
  });
  t.after(() => replacement.close());
  await replacement.send('hello');
  assert.equal(
    events.some((event) => event.type === 'complete'),
    false,
  );
});

test('a fatal stream error closes the connection instead of leaving an unknown live turn', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  const agent = session(f, events);
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  await assert.rejects(agent.send('fatal-error'), /connection lost/);
  assert.equal(agent.isClosed, true);
  assert.equal(agent.sessionId, 'thread-1');
  assert.equal(
    events.some((event) => event.type === 'complete'),
    false,
  );
});

test('tool fingerprints ignore object and tool ordering but include schema changes', () => {
  const a = {
    name: 'a',
    description: 'A',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  };
  const b = { name: 'b', description: 'B', inputSchema: { properties: {}, type: 'object' } };
  assert.equal(
    browserToolsFingerprint([a, b]),
    browserToolsFingerprint([{ ...b, inputSchema: { type: 'object', properties: {} } }, a]),
  );
  assert.notEqual(
    browserToolsFingerprint([a]),
    browserToolsFingerprint([
      { ...a, inputSchema: { type: 'object', properties: { count: { type: 'number' } } } },
    ]),
  );
});

test('old tools upgrade into a disclosed new execution session with preserved visible history', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  const agent = session(f, events, undefined, 'legacy-thread', {
    sessionToolsFingerprint: browserToolsFingerprint([]),
    historyForToolUpgrade: JSON.stringify([
      { role: 'user', text: 'Only edit the checkout button.' },
      { role: 'assistant', text: 'The source is checkout.html.' },
    ]),
  });
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  await agent.send('Continue using the new tools');
  const requests = await f.requests();
  assert.equal(
    requests.some((request) => request.method === 'thread/resume'),
    false,
  );
  assert.equal(requests.filter((request) => request.method === 'thread/start').length, 1);
  assert.match(
    requests.find((request) => request.method === 'turn/start').params.input[0].text,
    /conversation_history[\s\S]*checkout\.html/,
  );
  assert.equal(agent.sessionId, 'thread-1');
  assert.equal(agent.replacedSessionId, 'legacy-thread');
  assert.notEqual(agent.toolsFingerprint, browserToolsFingerprint([]));
  assert.ok(
    events.some((event) => event.type === 'status' && /保留原会话/.test(event.label ?? '')),
  );
  await agent.send('A later turn');
  const turns = (await f.requests()).filter((request) => request.method === 'turn/start');
  assert.equal(turns[1].params.input[0].text.includes('conversation_history'), false);
});

test('unknown tool versions require visible history and never silently replace the saved session', async (t) => {
  const f = await fixture();
  const agent = session(f, [], undefined, 'legacy-thread', { sessionToolsFingerprint: undefined });
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  await assert.rejects(agent.send('continue'), /需要已保存的可见对话历史/);
  assert.equal(agent.sessionId, 'legacy-thread');
  assert.equal(agent.toolsFingerprint, undefined);
  assert.equal(agent.replacedSessionId, undefined);
  assert.deepEqual(await f.requests(), []);
});

test('canceling migration before its first turn retains the old session and fingerprint', async (t) => {
  const f = await fixture({ threadStartDelayMs: 500 });
  const oldFingerprint = browserToolsFingerprint([]);
  const agent = session(f, [], undefined, 'legacy-thread', {
    sessionToolsFingerprint: oldFingerprint,
    historyForToolUpgrade: JSON.stringify([{ role: 'user', text: 'Keep this history' }]),
  });
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  const stopped = assert.rejects(agent.send('continue'), /任务已停止/);
  await waitFor(async () =>
    (await f.requests()).some((request) => request.method === 'thread/start'),
  );
  await agent.interrupt();
  await stopped;
  assert.equal(agent.isClosed, true);
  assert.equal(agent.sessionId, 'legacy-thread');
  assert.equal(agent.toolsFingerprint, oldFingerprint);
  assert.equal(agent.replacedSessionId, undefined);
  assert.equal(
    (await f.requests()).some((request) => request.method === 'turn/start'),
    false,
  );
});

test('startup cancellation terminates a pending handshake without waiting for its request timeout', async (t) => {
  const f = await fixture({ initializeDelayMs: 1000 });
  const agent = session(f, []);
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  const stopped = assert.rejects(agent.send('hello'), /任务已停止/);
  await waitFor(async () =>
    (await f.requests()).some((request) => request.method === 'initialize'),
  );
  await agent.interrupt();
  await stopped;
  assert.equal(agent.isClosed, true);
  assert.equal(
    (await f.requests()).some((request) => request.method === 'thread/start'),
    false,
  );
});

test('an interrupt ACK without a completed event closes the stalled connection', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  const agent = session(f, events);
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  const stopped = assert.rejects(agent.send('cancel-ack-only'), /未确认结束/);
  await waitFor(() => events.some((event) => event.type === 'delta'));
  await agent.interrupt();
  await stopped;
  assert.equal(agent.isClosed, true);
  assert.equal(
    events.some((event) => event.type === 'complete'),
    false,
  );
});

test('questions arriving before turn-start acknowledgement are queued and remain answerable', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  const agent = session(f, events);
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  const done = agent.send('pre-ack');
  await waitFor(() => events.some((event) => event.type === 'user-input'));
  const request = events.find((event) => event.type === 'user-input');
  assert.ok(request?.type === 'user-input');
  agent.resolveUserInput(request.request.id, { choice: ['A'] });
  await done;
  assert.deepEqual(
    (await f.requests()).find((request) => request.id === 110 && request.result).result,
    { answers: { choice: { answers: ['A'] } } },
  );
});

test('late terminal notifications cannot finish or replace the current turn', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  const agent = session(f, events);
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  await agent.send('late-terminal');
  const completions = events.filter((event) => event.type === 'complete');
  assert.equal(completions.length, 1);
  assert.equal(completions[0].text, 'Hello world');
});

test('tools from another turn are refused and nonzero command exits are failures', async (t) => {
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
  await agent.send('foreign-tool');
  assert.equal(calls, 0);
  assert.equal(
    (await f.requests()).find((request) => request.id === 101 && request.result).result.success,
    false,
  );
  await agent.send('exit-code');
  assert.ok(
    events.some(
      (event) =>
        event.type === 'tool' &&
        event.call.id === 'failed-command' &&
        event.call.status === 'error',
    ),
  );
});

test('concurrent tool activity does not hide a pending approval', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  const agent = session(f, events);
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  const done = agent.send('approval-with-tool');
  await waitFor(() =>
    events.some((event) => event.type === 'tool' && event.call.id === 'parallel-tool'),
  );
  assert.equal(events.filter((event) => event.type === 'status').at(-1)?.status, 'waiting');
  const approval = events.find((event) => event.type === 'approval');
  assert.ok(approval?.type === 'approval');
  agent.resolveApproval(approval.request.id, false);
  await done;
});

test('file approvals include their exact path and patch before accepting the one operation', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  const agent = session(f, events);
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  const done = agent.send('file-approval');
  await waitFor(() => events.some((event) => event.type === 'approval'));
  const approval = events.find((event) => event.type === 'approval');
  assert.ok(approval?.type === 'approval');
  assert.equal(approval.request.kind, 'file');
  assert.ok(approval.request.detail.includes(path.join(f.directory, 'index.html')));
  assert.match(approval.request.detail, /-Old label\n\+New label/);
  agent.resolveApproval(approval.request.id, true);
  await done;
  assert.equal(
    (await f.requests()).find((request) => request.id === 120 && request.result).result.decision,
    'accept',
  );
});

test(
  'closing a POSIX CLI session terminates its owned command process group',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = await fixture();
    const events: AgentEvent[] = [];
    const agent = session(f, events);
    let pid: number | undefined;
    t.after(() => {
      agent.close();
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
      return f.cleanup();
    });
    const stopped = assert.rejects(agent.send('descendant'), /已关闭/);
    await waitFor(() =>
      events.some((event) => event.type === 'delta' && event.text === 'Child running'),
    );
    pid = Number(await readFile(f.log + '.pid', 'utf8'));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    process.kill(pid, 0);
    agent.close();
    await stopped;
    await waitFor(() => {
      try {
        process.kill(pid!, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
    });
  },
);

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

test('Codex version and login probes run independently without serial startup waits', async () => {
  const f = await fixture({ waitForLogin: true });
  const oldPath = process.env.PATH;
  process.env.PATH = `${f.directory}${path.delimiter}${oldPath ?? ''}`;
  try {
    const codex = (await detectAgents()).find((agent) => agent.id === 'codex');
    assert.equal(
      codex?.available,
      true,
      'The version fixture only finishes after the login process has run',
    );
    assert.equal(codex.version, 'codex-cli test');
    assert.equal(codex.authentication, 'ready');
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await f.cleanup();
  }
});

test('a zero-exit not-logged-in response is not misreported as authenticated', async () => {
  const f = await fixture({ loginMessage: 'Not logged in' });
  const oldPath = process.env.PATH;
  process.env.PATH = `${f.directory}${path.delimiter}${oldPath ?? ''}`;
  try {
    const codex = (await detectAgents()).find((agent) => agent.id === 'codex');
    assert.equal(codex?.authentication, 'missing');
    assert.match(codex?.detail ?? '', /codex login/);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await f.cleanup();
  }
});
