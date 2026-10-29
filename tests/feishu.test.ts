import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

function postEvent(id: string, content: unknown) {
  const value = event(id, '', { messageType: 'post' });
  value.message.content = JSON.stringify(content);
  return value;
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

test('restore has a deadline, preserves saved ciphertext, blocks replacement and discards late results', async () => {
  const h = await harness();
  let restored: FeishuConnector | undefined;
  let releaseOld!: (value: string) => void;
  try {
    await h.connector.configure({ appId: APP_ID, appSecret: SECRET });
    await h.connector.dispose();
    const filename = path.join(h.storageDir, 'credentials.enc');
    const ciphertext = await readFile(filename, 'utf8');
    let unlocked = false;
    restored = new FeishuConnector(
      {
        ...h.options,
        restoreTimeoutMs: 40,
        decrypt: (value) =>
          unlocked
            ? h.decrypt(value)
            : new Promise<string>((resolve) => {
                releaseOld = resolve;
              }),
      },
      h.dependencies,
    );
    assert.equal(restored.getState().status, 'restoring');
    const connecting = restored.connect();
    await until(() => restored!.getState().hasSavedCredentials === true);
    assert.equal(restored.getState().appId, undefined);
    await assert.rejects(connecting, /超时/);
    assert.equal(restored.getState().status, 'error');
    assert.equal(restored.getState().hasSavedCredentials, true);
    assert.match(restored.getState().error!, /原有加密文件未更改/);
    await assert.rejects(
      restored.configure({ appId: 'cli_fedcba9876543210', appSecret: 'replacement' }),
      /恢复/,
    );
    await assert.rejects(restored.beginSetup(), /恢复/);
    await assert.rejects(restored.connect(), /恢复/);
    assert.equal(await readFile(filename, 'utf8'), ciphertext);
    assert.equal(h.connections, 0);
    assert.equal(h.registrations, 0);
    unlocked = true;
    const state = await restored.retryRestore();
    assert.equal(state.status, 'disconnected');
    assert.equal(state.appId, APP_ID);
    assert.equal(state.hasSavedCredentials, true);
    releaseOld(JSON.stringify({ appId: 'cli_fedcba9876543210', appSecret: 'late-result' }));
    await delay(20);
    assert.equal(restored.getState().appId, APP_ID);
    assert.equal(restored.getState().error, undefined);
    assert.equal(await readFile(filename, 'utf8'), ciphertext);
    assert.equal(h.connections, 0);
  } finally {
    releaseOld?.('{}');
    await restored?.dispose();
    await h.cleanup();
  }
});

test('deferred restoration waits for an explicit retry and restores the existing binding without connecting', async () => {
  const h = await harness();
  let restored: FeishuConnector | undefined;
  try {
    await h.connector.configure({ appId: APP_ID, appSecret: SECRET });
    await h.connector.dispose();
    await writeFile(
      path.join(h.storageDir, 'credentials.enc'),
      await h.options.encrypt(
        JSON.stringify({
          appId: APP_ID,
          appSecret: SECRET,
          binding: { senderId: OWNER, chatId: CHAT, tenantKey: TENANT },
        }),
      ),
    );
    let decryptCalls = 0;
    restored = new FeishuConnector(
      {
        ...h.options,
        deferRestore: true,
        decrypt: async (value) => {
          decryptCalls++;
          return h.decrypt(value);
        },
      },
      h.dependencies,
    );
    await delay(20);
    assert.equal(decryptCalls, 0);
    assert.equal(restored.getState().status, 'restoring');
    const states = await Promise.all([restored.retryRestore(), restored.retryRestore()]);
    assert.equal(decryptCalls, 1);
    assert.equal(states[0].appId, APP_ID);
    assert.equal(states[1].paired, true);
    assert.equal(states[0].status, 'disconnected');
    assert.equal(h.connections, 0);
  } finally {
    await restored?.dispose();
    await h.cleanup();
  }
});

test('decrypt errors cannot make an existing configuration look absent and retry remains available', async () => {
  const h = await harness();
  let restored: FeishuConnector | undefined;
  try {
    await h.connector.configure({ appId: APP_ID, appSecret: SECRET });
    await h.connector.dispose();
    const ciphertext = await readFile(path.join(h.storageDir, 'credentials.enc'), 'utf8');
    let denied = true;
    restored = new FeishuConnector(
      {
        ...h.options,
        deferRestore: true,
        decrypt: async (value) => {
          if (denied)
            throw Object.assign(new Error('private keychain details'), { code: 'ENOENT' });
          return h.decrypt(value);
        },
      },
      h.dependencies,
    );
    await assert.rejects(restored.retryRestore(), /无法恢复/);
    assert.equal(restored.getState().hasSavedCredentials, true);
    assert.equal(restored.disconnect().status, 'error');
    assert.equal(JSON.stringify(h.states).includes('private keychain details'), false);
    denied = false;
    assert.equal((await restored.retryRestore()).appId, APP_ID);
    assert.equal(await readFile(path.join(h.storageDir, 'credentials.enc'), 'utf8'), ciphertext);
  } finally {
    await restored?.dispose();
    await h.cleanup();
  }
});

test('file read failures expose recovery before the saved-credentials check completes', async () => {
  const h = await harness();
  let restored: FeishuConnector | undefined;
  try {
    await h.connector.dispose();
    const filename = path.join(h.storageDir, 'credentials.enc');
    await mkdir(filename);
    restored = new FeishuConnector({ ...h.options, deferRestore: true }, h.dependencies);
    await assert.rejects(restored.retryRestore(), /无法恢复/);
    assert.equal(restored.getState().status, 'error');
    assert.equal(restored.getState().hasSavedCredentials, undefined);
    assert.equal(restored.getState().restoreFailed, true);
    await assert.rejects(restored.beginSetup(), /恢复/);
    await assert.rejects(restored.configure({ appId: APP_ID, appSecret: SECRET }), /恢复/);
    assert.equal(h.registrations, 0);
    await rm(filename, { recursive: true });
    const state = await restored.retryRestore();
    assert.equal(state.status, 'disconnected');
    assert.equal(state.restoreFailed, false);
    assert.equal(state.hasSavedCredentials, false);
  } finally {
    await restored?.dispose();
    await h.cleanup();
  }
});

test('inbox restoration is atomic and read-only even when an interrupted item decrypts after the deadline', async () => {
  const h = await harness();
  let restored: FeishuConnector | undefined;
  let releaseOld!: (value: string) => void;
  try {
    await h.connector.configure({ appId: APP_ID, appSecret: SECRET });
    const message: FeishuMessage = {
      id: 'restore-inbox',
      text: 'previous operation',
      senderId: OWNER,
      chatId: CHAT,
      timestamp: Date.now(),
    };
    const inboxFile = path.join(
      h.storageDir,
      'inbox',
      `${createHash('sha256').update(`${APP_ID}:${message.id}`).digest('hex')}.enc`,
    );
    await mkdir(path.dirname(inboxFile), { recursive: true });
    const entry = { appId: APP_ID, message, kind: 'command', status: 'running' };
    const inboxCiphertext = await h.options.encrypt(JSON.stringify(entry));
    await writeFile(inboxFile, inboxCiphertext);
    await h.connector.dispose();
    let unlocked = false;
    restored = new FeishuConnector(
      {
        ...h.options,
        restoreTimeoutMs: 40,
        decrypt: (value) =>
          value === inboxCiphertext && !unlocked
            ? new Promise<string>((resolve) => {
                releaseOld = resolve;
              })
            : h.decrypt(value),
      },
      h.dependencies,
    );
    await assert.rejects(restored.connect(), /超时/);
    assert.equal(restored.getState().hasSavedCredentials, true);
    assert.equal(restored.getState().appId, undefined);
    assert.equal(await readFile(inboxFile, 'utf8'), inboxCiphertext);
    releaseOld(JSON.stringify(entry));
    await delay(20);
    assert.equal(restored.getState().status, 'error');
    assert.equal(await readFile(inboxFile, 'utf8'), inboxCiphertext);
    unlocked = true;
    const state = await restored.retryRestore();
    assert.equal(state.appId, APP_ID);
    assert.match(state.error!, /上次中断/);
    assert.equal(await readFile(inboxFile, 'utf8'), inboxCiphertext);
  } finally {
    releaseOld?.('{}');
    await restored?.dispose();
    await h.cleanup();
  }
});

test('disposing during restoration stops the wait and ignores the eventual decrypted result', async () => {
  const h = await harness();
  let restored: FeishuConnector | undefined;
  let release!: (value: string) => void;
  try {
    await h.connector.configure({ appId: APP_ID, appSecret: SECRET });
    await h.connector.dispose();
    restored = new FeishuConnector(
      {
        ...h.options,
        deferRestore: true,
        decrypt: () =>
          new Promise<string>((resolve) => {
            release = resolve;
          }),
      },
      h.dependencies,
    );
    const pending = restored.retryRestore();
    const rejection = assert.rejects(pending);
    await until(() => typeof release === 'function');
    await restored.dispose();
    await rejection;
    const stateCount = h.states.length;
    release(JSON.stringify({ appId: APP_ID, appSecret: SECRET }));
    await delay(20);
    assert.equal(h.states.length, stateCount);
    assert.equal(restored.getState().appId, undefined);
  } finally {
    release?.('{}');
    await restored?.dispose();
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

test('post messages keep visible text and paragraphs through the actual SDK event dispatcher', async () => {
  const received: FeishuMessage[] = [];
  const h = await harness(async (message) => {
    received.push(message);
  });
  try {
    await h.connectAndPair();
    const dispatcher = new EventDispatcher({
      logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    }).register({
      'im.message.receive_v1': (data) => h.callbacks.onMessage(data),
    });
    const post = postEvent('post-direct', {
      title: '页面测试',
      content: [
        [
          { tag: 'text', text: '先读取', style: ['bold'] },
          { tag: 'a', text: '当前页面', href: 'javascript:must-not-execute' },
        ],
        [
          { tag: 'text', text: '然后告诉我结果。' },
          { tag: 'img', image_key: 'private-image-key' },
          { tag: 'media', file_key: 'private-file-key' },
        ],
      ],
    });
    await dispatcher.invoke(
      {
        schema: '2.0',
        header: {
          app_id: APP_ID,
          tenant_key: TENANT,
          event_type: 'im.message.receive_v1',
          event_id: 'post-event',
          create_time: String(Date.now()),
        },
        event: { sender: post.sender, message: post.message },
      },
      { needCheck: false },
    );
    await until(() => received.length === 1);
    assert.equal(received[0].text, '页面测试\n先读取当前页面\n然后告诉我结果。');
    assert.equal(received[0].text.includes('private-'), false);
    assert.equal(received[0].text.includes('javascript:'), false);
    await h.callbacks.onMessage(post);
    await delay(20);
    assert.equal(received.length, 1);
  } finally {
    await h.cleanup();
  }
});

test('localized post messages are accepted while media-only, malformed and oversized posts are ignored', async () => {
  const received: FeishuMessage[] = [];
  const h = await harness(async (message) => {
    received.push(message);
  });
  try {
    await h.connectAndPair();
    await h.callbacks.onMessage(
      postEvent('post-localized', {
        zh_cn: {
          content: [
            [{ tag: 'text', text: '查看页面' }],
            [{ tag: 'code_block', language: 'text', text: '只读检查' }],
          ],
        },
        en_us: { content: [[{ tag: 'text', text: 'Ignored alternate translation' }]] },
      }),
    );
    await h.callbacks.onMessage(
      postEvent('media-only', { content: [[{ tag: 'img', image_key: 'do-not-download' }]] }),
    );
    await h.callbacks.onMessage(
      postEvent('malformed-post', { content: [{ tag: 'text', text: 'invalid paragraph' }] }),
    );
    await h.callbacks.onMessage(
      postEvent('oversized-post', { content: [[{ tag: 'text', text: 'x'.repeat(20_001) }]] }),
    );
    await h.callbacks.onMessage(
      postEvent('unknown-tag', { content: [[{ tag: 'script', text: 'must not run' }]] }),
    );
    await until(() => received.length === 1);
    assert.equal(received[0].text, '查看页面\n只读检查');
    await delay(20);
    assert.equal(received.length, 1);
  } finally {
    await h.cleanup();
  }
});

test('a cancellation sent as a rich-text post still bypasses a long-running command', async () => {
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
    await h.callbacks.onMessage(event('post-long', 'long task'));
    await until(() => received.includes('long task'));
    await h.callbacks.onMessage(
      postEvent('post-cancel', { content: [[{ tag: 'text', text: '/cancel' }]] }),
    );
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
