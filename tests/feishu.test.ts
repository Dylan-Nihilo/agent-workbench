import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EventDispatcher } from '@larksuiteoapi/node-sdk';
import { FeishuConnector, type FeishuDependencies } from '../src/main/feishu.ts';
import type { FeishuMessage, FeishuState } from '../src/shared/types';

const APP_ID = 'cli_0123456789abcdef';
const SECRET = 'test-secret-not-for-renderer';
const OWNER = 'ou_test_operator';
const CHAT = 'oc_test_private';
const TENANT = 'tenant-test';

const delay = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) assert.fail('Expected condition did not become true');
    await delay();
  }
}

function event(
  id: string,
  text: string,
  extra: {
    senderId?: string;
    chatId?: string;
    chatType?: string;
    senderType?: string;
    messageType?: string;
    appId?: string;
    tenantKey?: string;
    senderTenantKey?: string;
  } = {},
) {
  return {
    app_id: extra.appId ?? APP_ID,
    tenant_key: extra.tenantKey ?? TENANT,
    sender: {
      sender_type: extra.senderType ?? 'user',
      sender_id: { open_id: extra.senderId ?? OWNER },
      tenant_key: extra.senderTenantKey ?? TENANT,
    },
    message: {
      message_id: id,
      chat_id: extra.chatId ?? CHAT,
      chat_type: extra.chatType ?? 'p2p',
      message_type: extra.messageType ?? 'text',
      content: JSON.stringify({ text }),
      create_time: String(Date.now()),
    },
  };
}

async function harness(onMessage: (message: FeishuMessage) => Promise<void> = async () => {}) {
  const storageDir = await mkdtemp(path.join(os.tmpdir(), 'workbench-feishu-test-'));
  const key = randomBytes(32);
  const encrypt = async (text: string) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  };
  const decrypt = async (text: string) => {
    const buffer = Buffer.from(text, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12));
    cipher.setAuthTag(buffer.subarray(12, 28));
    return Buffer.concat([cipher.update(buffer.subarray(28)), cipher.final()]).toString('utf8');
  };
  const states: FeishuState[] = [];
  const sent: { chatId: string; text: string; uuid: string }[] = [];
  let callbacks!: Parameters<FeishuDependencies['createTransport']>[1];
  let registration!: Parameters<FeishuDependencies['registerApp']>[0];
  let finishRegistration!: (value: Awaited<ReturnType<FeishuDependencies['registerApp']>>) => void;
  let sendFailure = false;
  let autoReady = true;
  let connections = 0;
  let registrations = 0;
  let closes = 0;
  const dependencies: FeishuDependencies = {
    registerApp: (options) => {
      registrations++;
      registration = options;
      options.onQRCodeReady({
        url: 'https://accounts.feishu.cn/setup-test?code=opaque-value',
        expireIn: 600,
      });
      return new Promise((resolve, reject) => {
        finishRegistration = resolve;
        options.signal?.addEventListener('abort', () => reject({ code: 'abort' }), { once: true });
      });
    },
    qrCode: async () => 'data:image/png;base64,fixture',
    createTransport(_credentials, handlers) {
      callbacks = handlers;
      connections++;
      return {
        start: async () => {
          if (autoReady) handlers.onReady();
        },
        close: () => {
          closes++;
        },
        send: async (chatId, text, uuid) => {
          if (sendFailure) throw new Error('private upstream token must not escape');
          sent.push({ chatId, text, uuid });
        },
      };
    },
  };
  const options = {
    storageDir,
    encrypt,
    decrypt,
    onMessage,
    onState: (state: FeishuState) => states.push(state),
  };
  const connector = new FeishuConnector(options, dependencies);
  return {
    connector,
    dependencies,
    options,
    states,
    sent,
    storageDir,
    decrypt,
    get callbacks() {
      return callbacks;
    },
    get registration() {
      return registration;
    },
    get connections() {
      return connections;
    },
    get registrations() {
      return registrations;
    },
    get closes() {
      return closes;
    },
    setSendFailure(value: boolean) {
      sendFailure = value;
    },
    setAutoReady(value: boolean) {
      autoReady = value;
    },
    finishRegistration: (ownerId = OWNER) =>
      finishRegistration({
        client_id: APP_ID,
        client_secret: SECRET,
        user_info: { open_id: ownerId, tenant_brand: 'feishu' },
      }),
    async connectAndPair() {
      await connector.configure({ appId: APP_ID, appSecret: SECRET });
      await connector.connect();
      await callbacks.onMessage(event('pair-1', connector.getState().pairingCode!));
      await until(() => sent.length === 1);
      return connector;
    },
    async cleanup() {
      await connector.dispose();
      await delay(20);
      await rm(storageDir, { recursive: true, force: true });
    },
  };
}

test('configuration is encrypted and never exposed in state', async () => {
  const h = await harness();
  try {
    await assert.rejects(h.connector.configure({ appId: 'invalid', appSecret: SECRET }));
    await h.connector.configure({ appId: APP_ID, appSecret: SECRET });
    const ciphertext = await readFile(path.join(h.storageDir, 'credentials.enc'), 'utf8');
    assert.equal(ciphertext.includes(SECRET), false);
    assert.equal(JSON.parse(await h.decrypt(ciphertext)).appSecret, SECRET);
    assert.equal(JSON.stringify(h.states).includes(SECRET), false);
    assert.equal(h.connections, 0);
  } finally {
    await h.cleanup();
  }
});

test('connection readiness and operator pairing remain separate states', async () => {
  const h = await harness();
  try {
    h.setAutoReady(false);
    await h.connector.configure({ appId: APP_ID, appSecret: SECRET });
    const connecting = h.connector.connect();
    await until(() => h.connections === 1);
    assert.equal(h.connector.getState().status, 'connecting');
    h.callbacks.onReady();
    await connecting;
    assert.equal(h.connector.getState().status, 'connected');
    assert.equal(h.connector.getState().paired, false);
    const code = h.connector.getState().pairingCode!;
    await h.callbacks.onMessage(event('group-pair', code, { chatType: 'group' }));
    await h.callbacks.onMessage(event('bot-pair', code, { senderType: 'app' }));
    await h.callbacks.onMessage(event('wrong-pair', 'WB-WRONG'));
    assert.equal(h.connector.getState().paired, false);
    await h.callbacks.onMessage(event('actual-pair', `绑定 ${code}`));
    assert.equal(h.connector.getState().paired, true);
    assert.equal(h.connector.getState().pairingCode, undefined);
    await until(() => h.sent.length === 1);
    h.callbacks.onReconnecting();
    assert.equal(h.connector.getState().status, 'connecting');
    h.callbacks.onReconnected();
    assert.equal(h.connector.getState().status, 'connected');
  } finally {
    await h.cleanup();
  }
});

test('disconnect cancels an outstanding connection and ignores stale readiness', async () => {
  const h = await harness();
  try {
    h.setAutoReady(false);
    await h.connector.configure({ appId: APP_ID, appSecret: SECRET });
    const connecting = h.connector.connect();
    await until(() => h.connections === 1);
    h.connector.disconnect();
    h.callbacks.onReady();
    await assert.rejects(connecting);
    assert.equal(h.connector.getState().status, 'disconnected');
  } finally {
    await h.cleanup();
  }
});

test('messages are persisted before dispatch, deduplicated, and restricted to the paired DM', async () => {
  const received: FeishuMessage[] = [];
  const h = await harness(async (message) => {
    const filename = createHash('sha256').update(`${APP_ID}:${message.id}`).digest('hex') + '.enc';
    const disk = JSON.parse(
      await h.decrypt(await readFile(path.join(h.storageDir, 'inbox', filename), 'utf8')),
    );
    assert.equal(disk.status, 'running');
    received.push(message);
  });
  try {
    await h.connectAndPair();
    await Promise.all(
      Array.from({ length: 6 }, () => h.callbacks.onMessage(event('message-1', '检查这个页面'))),
    );
    await h.callbacks.onMessage(event('stranger', '删除文件', { senderId: 'ou_other' }));
    await h.callbacks.onMessage(event('other-chat', '操作', { chatId: 'oc_other' }));
    await h.callbacks.onMessage(event('image', 'image', { messageType: 'image' }));
    await until(() => received.length === 1);
    assert.equal(received[0].id, 'message-1');
    await until(async () => {
      const files = await readdir(path.join(h.storageDir, 'inbox'));
      const entries = await Promise.all(
        files
          .filter((name) => name.endsWith('.enc'))
          .map(async (name) =>
            JSON.parse(
              await h.decrypt(await readFile(path.join(h.storageDir, 'inbox', name), 'utf8')),
            ),
          ),
      );
      return entries.every((item) => item.status === 'done');
    });
    await h.connector.dispose();
    const restarted = new FeishuConnector(h.options, h.dependencies);
    await restarted.connect();
    assert.equal(restarted.getState().paired, true);
    await h.callbacks.onMessage(event('message-1', '检查这个页面'));
    await delay(30);
    assert.equal(received.length, 1);
    await restarted.dispose();
  } finally {
    await h.cleanup();
  }
});

test('acknowledgement does not wait for agent work and cancellation bypasses the task queue', async () => {
  let release!: () => void;
  const running = new Promise<void>((resolve) => {
    release = resolve;
  });
  const received: string[] = [];
  const h = await harness(async (message) => {
    received.push(message.text);
    if (message.text === 'long task') await running;
    if (message.text === '/cancel') release();
  });
  try {
    await h.connectAndPair();
    await h.callbacks.onMessage(event('long-1', 'long task'));
    await until(() => received.includes('long task'));
    await h.callbacks.onMessage(event('cancel-1', '/cancel'));
    await until(() => received.includes('/cancel'));
    assert.deepEqual(received, ['long task', '/cancel']);
  } finally {
    release();
    await h.cleanup();
  }
});

test('failed agent callbacks remain failed and are not silently retried', async () => {
  let calls = 0;
  const h = await harness(async () => {
    calls++;
    throw new Error('secret-from-agent');
  });
  try {
    await h.connectAndPair();
    await h.callbacks.onMessage(event('failed-1', 'run'));
    await until(() => h.connector.getState().error?.includes('处理失败') ?? false);
    await h.callbacks.onMessage(event('failed-1', 'run'));
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(h.states).includes('secret-from-agent'), false);
    await until(() => h.sent.length === 2);
  } finally {
    await h.cleanup();
  }
});

test('a durable inbox write failure rejects the receipt and never dispatches the command', async () => {
  let calls = 0;
  const h = await harness(async () => {
    calls++;
  });
  try {
    await h.connectAndPair();
    const encrypt = h.options.encrypt;
    h.options.encrypt = async (text) => {
      if (JSON.parse(text).kind === 'command') throw new Error('disk or keychain failure');
      return encrypt(text);
    };
    await assert.rejects(h.callbacks.onMessage(event('persist-fail', 'run once')));
    assert.equal(calls, 0);
    assert.match(h.connector.getState().error!, /未能保存/);
    h.options.encrypt = encrypt;
    await h.callbacks.onMessage(event('persist-fail', 'run once'));
    await until(() => calls === 1);
  } finally {
    await h.cleanup();
  }
});

test('QR setup binds the code holder using the bot event identity, not registration-scoped open_id', async () => {
  const h = await harness();
  try {
    const setup = await h.connector.beginSetup();
    assert.equal(setup.status, 'configuring');
    assert.equal(setup.setupQr, 'data:image/png;base64,fixture');
    assert.equal(h.registration.createOnly, true);
    assert.equal(h.registration.appId, undefined);
    assert.equal(h.registration.addons?.preset, false);
    assert.deepEqual(h.registration.addons?.scopes?.tenant, [
      'im:message.p2p_msg:readonly',
      'im:message:send_as_bot',
    ]);
    assert.equal(h.registration.addons?.scopes?.user, undefined);
    h.finishRegistration('ou_registration_scope_is_different');
    await until(() => h.connector.getState().status === 'connected');
    const code = h.connector.getState().pairingCode!;
    assert.match(code, /^WB-(?:[A-F\d]{4}-){3}[A-F\d]{4}$/);
    await h.callbacks.onMessage(event('no-code', 'hello', { senderId: 'ou_someone_else' }));
    assert.equal(h.connector.getState().paired, false);
    await h.callbacks.onMessage(event('right-owner', code));
    assert.equal(h.connector.getState().paired, true);
    const credentials = JSON.parse(
      await h.decrypt(await readFile(path.join(h.storageDir, 'credentials.enc'), 'utf8')),
    );
    assert.equal(credentials.ownerId, undefined);
    assert.deepEqual(credentials.binding, { senderId: OWNER, chatId: CHAT, tenantKey: TENANT });
    assert.equal(JSON.stringify(h.states).includes(SECRET), false);
    assert.equal(h.connector.getState().setupUrl, undefined);
    await until(() => h.sent.length === 1);
  } finally {
    await h.cleanup();
  }
});

test('pairing rejects mismatched applications, cross-tenant senders and missing tenant identity', async () => {
  let calls = 0;
  const h = await harness(async () => {
    calls++;
  });
  try {
    await h.connector.configure({ appId: APP_ID, appSecret: SECRET });
    await h.connector.connect();
    const code = h.connector.getState().pairingCode!;
    await h.callbacks.onMessage(event('other-app', code, { appId: 'cli_fedcba9876543210' }));
    await h.callbacks.onMessage(
      event('cross-tenant', code, { senderTenantKey: 'tenant-outsider' }),
    );
    const missing = event('missing-tenant', code) as Record<string, unknown>;
    delete missing.tenant_key;
    await h.callbacks.onMessage(missing);
    assert.equal(h.connector.getState().paired, false);
    await h.callbacks.onMessage(event('allowed', code));
    assert.equal(h.connector.getState().paired, true);
    await until(() => h.sent.length === 1);
    await h.callbacks.onMessage(
      event('other-tenant-command', 'run', {
        tenantKey: 'tenant-outsider',
        senderTenantKey: 'tenant-outsider',
      }),
    );
    await delay(20);
    assert.equal(calls, 0);
    assert.equal(h.sent.length, 1);
  } finally {
    await h.cleanup();
  }
});

test('the installed SDK flattens the actual v2 envelope into the accepted pairing event', async () => {
  const h = await harness();
  try {
    await h.connector.configure({ appId: APP_ID, appSecret: SECRET });
    await h.connector.connect();
    let observed: Record<string, unknown> | undefined;
    const dispatcher = new EventDispatcher({
      logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    }).register({
      'im.message.receive_v1': async (data) => {
        observed = data;
        await h.callbacks.onMessage(data);
      },
    });
    const flat = event('sdk-pair', `绑定 ${h.connector.getState().pairingCode}`);
    await dispatcher.invoke(
      {
        schema: '2.0',
        header: {
          app_id: APP_ID,
          tenant_key: TENANT,
          event_type: 'im.message.receive_v1',
          event_id: 'event-sdk-pair',
          create_time: String(Date.now()),
        },
        event: { sender: flat.sender, message: flat.message },
      },
      { needCheck: false },
    );
    assert.equal(observed?.app_id, APP_ID);
    assert.equal(observed?.tenant_key, TENANT);
    assert.equal(observed?.header, undefined);
    assert.equal(h.connector.getState().paired, true);
    await until(() => h.sent.length === 1);
  } finally {
    await h.cleanup();
  }
});

test('concurrent setup requests share a single registration flow', async () => {
  const h = await harness();
  try {
    const results = await Promise.all([h.connector.beginSetup(), h.connector.beginSetup()]);
    assert.equal(h.registrations, 1);
    assert.equal(results[0].setupUrl, results[1].setupUrl);
    h.connector.disconnect();
  } finally {
    await h.cleanup();
  }
});

test('registration never begins when credentials cannot be encrypted locally', async () => {
  const h = await harness();
  try {
    h.options.encrypt = async () => {
      throw new Error('keychain unavailable');
    };
    await assert.rejects(h.connector.beginSetup());
    assert.equal(h.registrations, 0);
    assert.equal(h.connector.getState().status, 'error');
  } finally {
    await h.cleanup();
  }
});

test('cancelled registration cannot install credentials or create a connection', async () => {
  const h = await harness();
  try {
    await h.connector.beginSetup();
    h.connector.disconnect();
    h.finishRegistration();
    await delay(20);
    assert.equal(h.connections, 0);
    assert.equal(h.connector.getState().appId, undefined);
    assert.equal(h.connector.getState().status, 'disconnected');
  } finally {
    await h.cleanup();
  }
});

test('replies cannot target other chats and use a stable UUID for retries', async () => {
  const received: FeishuMessage[] = [];
  const h = await harness(async (message) => {
    received.push(message);
  });
  try {
    await h.connectAndPair();
    await h.callbacks.onMessage(event('reply-1', 'read page'));
    await until(() => received.length === 1);
    await assert.rejects(h.connector.sendReply({ ...received[0], chatId: 'oc_other' }, 'result'));
    await assert.rejects(h.connector.sendReply({ ...received[0], id: 'invented' }, 'result'));
    await h.connector.sendReply(received[0], 'result');
    await h.connector.sendReply(received[0], 'result');
    assert.equal(h.sent[1].uuid, h.sent[2].uuid);
    h.setSendFailure(true);
    await assert.rejects(h.connector.sendReply(received[0], 'different result'));
    assert.equal(JSON.stringify(h.states).includes('private upstream token'), false);
    assert.match(h.connector.getState().error!, /发送失败/);
  } finally {
    await h.cleanup();
  }
});

test('a task interrupted after dispatch is not automatically replayed on restart', async () => {
  const received: FeishuMessage[] = [];
  const h = await harness(async (message) => {
    received.push(message);
  });
  try {
    await h.connectAndPair();
    await h.connector.dispose();
    const message: FeishuMessage = {
      id: 'crashed-1',
      text: 'side effect',
      senderId: OWNER,
      chatId: CHAT,
      timestamp: Date.now(),
    };
    const filename = createHash('sha256').update(`${APP_ID}:${message.id}`).digest('hex') + '.enc';
    await writeFile(
      path.join(h.storageDir, 'inbox', filename),
      await h.options.encrypt(
        JSON.stringify({ appId: APP_ID, message, kind: 'command', status: 'running' }),
      ),
      { mode: 0o600 },
    );
    const restarted = new FeishuConnector(h.options, h.dependencies);
    await restarted.connect();
    await h.callbacks.onMessage(event('crashed-1', 'side effect'));
    await delay(30);
    assert.equal(received.length, 0);
    assert.ok(h.states.some((state) => state.error?.includes('上次中断')));
    await restarted.dispose();
  } finally {
    await h.cleanup();
  }
});
