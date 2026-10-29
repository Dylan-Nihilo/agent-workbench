import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import QRCode from 'qrcode';
import type { FeishuMessage, FeishuState } from '../shared/types';

interface Credentials {
  appId: string;
  appSecret: string;
  domain?: 'feishu' | 'lark';
  binding?: { senderId: string; chatId: string; tenantKey?: string };
}

interface InboxItem {
  appId: string;
  message: FeishuMessage;
  kind: 'pair' | 'command';
  status: 'pending' | 'running' | 'done' | 'failed';
}

export interface FeishuConnectorOptions {
  storageDir: string;
  encrypt: (text: string) => Promise<string>;
  decrypt: (text: string) => Promise<string>;
  onState: (state: FeishuState) => void;
  onMessage: (message: FeishuMessage) => Promise<void>;
}

interface TransportCallbacks {
  onReady: () => void;
  onError: (error: unknown) => void;
  onReconnecting: () => void;
  onReconnected: () => void;
  onMessage: (event: unknown) => Promise<void>;
}

export interface FeishuTransport {
  start: () => Promise<void>;
  close: () => void;
  send: (chatId: string, text: string, uuid: string) => Promise<void>;
}

export interface FeishuDependencies {
  registerApp: typeof lark.registerApp;
  qrCode: (url: string) => Promise<string>;
  createTransport: (credentials: Credentials, callbacks: TransportCallbacks) => FeishuTransport;
}

const quietLogger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
const sdkDependencies: FeishuDependencies = {
  registerApp: (options) => lark.registerApp(options),
  qrCode: (url) => QRCode.toDataURL(url, { width: 288, margin: 2, errorCorrectionLevel: 'M' }),
  createTransport(credentials, callbacks) {
    const config = {
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      domain: credentials.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
      logger: quietLogger,
      loggerLevel: lark.LoggerLevel.error,
    };
    const client = new lark.Client(config);
    const ws = new lark.WSClient({
      ...config,
      autoReconnect: true,
      handshakeTimeoutMs: 15_000,
      wsConfig: { pingTimeout: 30 },
      onReady: callbacks.onReady,
      onError: callbacks.onError,
      onReconnecting: callbacks.onReconnecting,
      onReconnected: callbacks.onReconnected,
    });
    const eventDispatcher = new lark.EventDispatcher({ logger: quietLogger }).register({
      'im.message.receive_v1': callbacks.onMessage,
    });
    return {
      start: () => ws.start({ eventDispatcher }),
      close: () => ws.close({ force: true }),
      async send(chatId, text, uuid) {
        const response = await client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }), uuid },
        });
        if (response.code !== 0)
          throw new Error(`Feishu send failed (${response.code ?? 'unknown'})`);
      },
    };
  },
};

const isCancel = (text: string) => /^(?:\/cancel|取消|停止)$/i.test(text.trim());
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const errorCode = (error: unknown) =>
  isRecord(error) && typeof error.code === 'string' ? error.code : '';

function parseMessage(
  event: unknown,
  appId: string,
): { message: FeishuMessage; tenantKey: string } | undefined {
  if (!isRecord(event) || !isRecord(event.sender) || !isRecord(event.message)) return;
  const sender = event.sender;
  const message = event.message;
  // The SDK flattens the trusted v2 event header before invoking this handler.
  if (
    event.app_id !== appId ||
    typeof event.tenant_key !== 'string' ||
    !event.tenant_key ||
    sender.tenant_key !== event.tenant_key
  )
    return;
  if (
    sender.sender_type !== 'user' ||
    message.chat_type !== 'p2p' ||
    message.message_type !== 'text'
  )
    return;
  if (!isRecord(sender.sender_id) || typeof sender.sender_id.open_id !== 'string') return;
  if (
    typeof message.message_id !== 'string' ||
    typeof message.chat_id !== 'string' ||
    typeof message.content !== 'string'
  )
    return;
  let content: unknown;
  try {
    content = JSON.parse(message.content);
  } catch {
    return;
  }
  if (!isRecord(content) || typeof content.text !== 'string') return;
  const text = content.text.trim();
  if (
    !text ||
    text.length > 20_000 ||
    !message.message_id ||
    !message.chat_id ||
    !sender.sender_id.open_id
  )
    return;
  const time = Number(message.create_time);
  return {
    tenantKey: event.tenant_key,
    message: {
      id: message.message_id,
      text,
      senderId: sender.sender_id.open_id,
      chatId: message.chat_id,
      timestamp: Number.isFinite(time) && time > 0 ? time : Date.now(),
    },
  };
}

function validCredentials(value: unknown): value is Credentials {
  if (
    !isRecord(value) ||
    typeof value.appId !== 'string' ||
    !/^cli_[\da-f]{16}$/i.test(value.appId)
  )
    return false;
  if (
    typeof value.appSecret !== 'string' ||
    !value.appSecret.trim() ||
    value.appSecret.length > 1024
  )
    return false;
  if (value.domain !== undefined && value.domain !== 'feishu' && value.domain !== 'lark')
    return false;
  return (
    value.binding === undefined ||
    (isRecord(value.binding) &&
      typeof value.binding.senderId === 'string' &&
      typeof value.binding.chatId === 'string' &&
      (value.binding.tenantKey === undefined || typeof value.binding.tenantKey === 'string'))
  );
}

export class FeishuConnector {
  private state: FeishuState = { status: 'disconnected', paired: false };
  private credentials?: Credentials;
  private transport?: FeishuTransport;
  private setupAbort?: AbortController;
  private setupReady?: Promise<FeishuState>;
  private cancelConnection?: () => void;
  private ready: Promise<void>;
  private generation = 0;
  private disposed = false;
  private pairingExpiresAt = 0;
  private pairingAttempts = 0;
  private recoveryWarning?: string;
  private inbox = new Map<string, InboxItem>();
  private receiptQueue: Promise<void> = Promise.resolve();
  private commandQueue: Promise<void> = Promise.resolve();
  private tasks = new Set<Promise<void>>();

  constructor(
    private options: FeishuConnectorOptions,
    private dependencies: FeishuDependencies = sdkDependencies,
  ) {
    this.ready = this.load().catch(() => {
      this.update({
        status: 'error',
        error: '无法读取飞书本地加密配置，请检查系统钥匙串与存储目录。',
      });
      throw new Error('Feishu encrypted storage is unavailable');
    });
    // A renderer may read the initial state before invoking an async method.
    void this.ready.catch(() => {});
  }

  getState(): FeishuState {
    return { ...this.state };
  }

  async beginSetup(): Promise<FeishuState> {
    await this.ready;
    this.assertActive();
    if (this.setupReady && this.state.status === 'configuring') return this.setupReady;
    this.disconnect();
    const generation = this.generation;
    const controller = new AbortController();
    this.setupAbort = controller;
    this.update({
      status: 'configuring',
      paired: false,
      setupUrl: undefined,
      setupQr: undefined,
      pairingCode: undefined,
      error: undefined,
    });
    let resolveReady!: (state: FeishuState) => void;
    let rejectReady!: (error: Error) => void;
    this.setupReady = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    controller.signal.addEventListener(
      'abort',
      () => rejectReady(new Error('Feishu setup cancelled')),
      { once: true },
    );
    const current = () =>
      !controller.signal.aborted && generation === this.generation && !this.disposed;
    const qrTimeout = setTimeout(() => {
      if (!current()) return;
      this.update({
        status: 'error',
        error: '获取飞书二维码超时，请检查网络后重试。',
        setupUrl: undefined,
        setupQr: undefined,
      });
      controller.abort();
    }, 30_000);
    qrTimeout.unref();
    controller.signal.addEventListener('abort', () => clearTimeout(qrTimeout), { once: true });
    const task = (async () => {
      const probe = 'Workbench encrypted storage check';
      if ((await this.options.decrypt(await this.options.encrypt(probe))) !== probe)
        throw new Error('Encrypted storage check failed');
      if (!current()) throw new Error('Feishu setup cancelled');
      return this.dependencies.registerApp({
        createOnly: true,
        source: 'agent-workbench',
        signal: controller.signal,
        appPreset: { name: 'Workbench Demo', desc: '连接本机 Workbench，协作浏览与执行任务' },
        addons: {
          preset: false,
          scopes: { tenant: ['im:message.p2p_msg:readonly', 'im:message:send_as_bot'] },
          events: { items: { tenant: ['im.message.receive_v1'] } },
        },
        onQRCodeReady: (info) => {
          clearTimeout(qrTimeout);
          void this.dependencies
            .qrCode(info.url)
            .then((qr) => {
              if (!current()) return;
              this.update({ setupUrl: info.url, setupQr: qr });
              resolveReady(this.getState());
            })
            .catch(() => {
              if (!current()) return;
              controller.abort();
              this.update({
                status: 'error',
                error: '无法生成飞书连接二维码，请重试。',
                setupUrl: undefined,
                setupQr: undefined,
              });
              rejectReady(new Error('Unable to render Feishu setup QR code'));
            });
        },
      });
    })()
      .then(async (result) => {
        if (!current()) return;
        const credentials: Credentials = {
          appId: result.client_id,
          appSecret: result.client_secret,
          // Registration does not document the open_id's application scope; pairing establishes it.
          domain: result.user_info?.tenant_brand === 'lark' ? 'lark' : 'feishu',
        };
        if (!validCredentials(credentials)) throw new Error('Invalid registration credentials');
        await this.saveCredentials(credentials);
        if (!current()) return;
        this.credentials = credentials;
        this.setupAbort = undefined;
        this.setupReady = undefined;
        this.update({
          appId: credentials.appId,
          paired: false,
          setupUrl: undefined,
          setupQr: undefined,
        });
        await this.connect();
      })
      .catch((error) => {
        const code = errorCode(error);
        if (!current()) {
          rejectReady(new Error('Feishu setup cancelled'));
          return;
        }
        const message =
          code === 'expired_token'
            ? '二维码已过期，请重新连接飞书。'
            : code === 'access_denied'
              ? '已取消创建飞书机器人。'
              : '飞书机器人创建或连接失败，请重试或使用手动配置。';
        this.update({ status: 'error', error: message, setupUrl: undefined, setupQr: undefined });
        rejectReady(new Error(message));
      })
      .finally(() => clearTimeout(qrTimeout));
    this.track(task);
    return this.setupReady;
  }

  async configure(input: { appId: string; appSecret: string }): Promise<FeishuState> {
    await this.ready;
    this.assertActive();
    const credentials = {
      appId: input?.appId?.trim(),
      appSecret: input?.appSecret?.trim(),
      domain: 'feishu' as const,
    };
    if (!validCredentials(credentials))
      throw new Error('请填写有效的新机器人 App ID 与 App Secret。');
    this.disconnect();
    await this.receiptQueue;
    await this.saveCredentials(credentials);
    this.credentials = credentials;
    this.update({
      appId: credentials.appId,
      paired: false,
      pairingCode: undefined,
      error: undefined,
    });
    return this.getState();
  }

  async connect(): Promise<FeishuState> {
    await this.ready;
    this.assertActive();
    if (this.transport && (this.state.status === 'connected' || this.state.status === 'connecting'))
      return this.getState();
    if (!this.credentials) throw new Error('请先创建或配置 Workbench 专用飞书机器人。');
    const credentials = this.credentials;
    const generation = ++this.generation;
    this.transport?.close();
    if (!credentials.binding) this.newPairingCode();
    this.update({
      status: 'connecting',
      appId: credentials.appId,
      paired: Boolean(credentials.binding),
      error: this.recoveryWarning,
    });
    let settled = false;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.cancelConnection = () => {
      if (!settled) {
        settled = true;
        rejectReady(new Error('Feishu connection cancelled'));
      }
    };
    void ready.catch(() => {});
    const current = () => generation === this.generation && !this.disposed;
    const connected = () => {
      if (!current()) return;
      this.update({ status: 'connected', error: this.recoveryWarning });
      if (!settled) {
        settled = true;
        resolveReady();
      }
      this.resumePending();
    };
    const fail = () => {
      if (!current()) return;
      this.update({
        status: 'error',
        error: '飞书长连接失败，请检查网络、机器人发布状态和事件订阅配置。',
      });
      if (!settled) {
        settled = true;
        rejectReady(new Error('Feishu connection failed'));
      }
    };
    let transport: FeishuTransport;
    try {
      transport = this.dependencies.createTransport(credentials, {
        onReady: connected,
        onReconnected: connected,
        onReconnecting: () => {
          if (current()) this.update({ status: 'connecting' });
        },
        onError: fail,
        onMessage: (event) => {
          if (!current()) return Promise.resolve();
          const operation = this.receiptQueue.then(() =>
            this.acceptEvent(event, credentials.appId, generation),
          );
          this.receiptQueue = operation.catch(() => {
            if (current())
              this.update({
                error: '飞书消息未能保存到本地，未执行该指令。请检查存储空间后重发。',
              });
          });
          return operation;
        },
      });
    } catch {
      fail();
      this.cancelConnection = undefined;
      throw new Error('无法初始化飞书连接。');
    }
    this.transport = transport;
    const timer = setTimeout(() => {
      if (!current() || settled) return;
      transport.close();
      this.transport = undefined;
      fail();
      this.generation++;
    }, 30_000);
    timer.unref();
    try {
      await transport.start();
      await ready;
      return this.getState();
    } catch {
      if (current()) {
        transport.close();
        this.transport = undefined;
        fail();
      }
      throw new Error('无法建立飞书长连接。');
    } finally {
      clearTimeout(timer);
      if (current()) this.cancelConnection = undefined;
    }
  }

  disconnect(): FeishuState {
    this.generation++;
    this.setupAbort?.abort();
    this.setupAbort = undefined;
    this.setupReady = undefined;
    this.cancelConnection?.();
    this.cancelConnection = undefined;
    this.transport?.close();
    this.transport = undefined;
    this.update({
      status: 'disconnected',
      paired: Boolean(this.credentials?.binding),
      setupUrl: undefined,
      setupQr: undefined,
      error: undefined,
    });
    return this.getState();
  }

  async sendReply(message: FeishuMessage, text: string): Promise<void> {
    await this.ready;
    this.assertActive();
    const credentials = this.credentials;
    const binding = credentials?.binding;
    const entry = credentials && this.inbox.get(this.itemKey(credentials.appId, message.id));
    if (
      !binding ||
      !entry ||
      binding.senderId !== message.senderId ||
      binding.chatId !== message.chatId ||
      entry.message.senderId !== message.senderId ||
      entry.message.chatId !== message.chatId
    ) {
      throw new Error('只能回复已配对操作者的原始会话。');
    }
    const transport = this.transport;
    if (!transport || this.state.status !== 'connected')
      throw new Error('飞书尚未连接，结果已保留在本机。');
    if (typeof text !== 'string' || !text.trim()) return;
    const chunks = Array.from(text).reduce<string[]>((all, character) => {
      if (!all.length || all[all.length - 1].length >= 3_000) all.push('');
      all[all.length - 1] += character;
      return all;
    }, []);
    for (let index = 0; index < chunks.length; index++) {
      if (transport !== this.transport || this.credentials !== credentials)
        throw new Error('飞书连接已改变，停止发送结果。');
      const uuid = createHash('sha256')
        .update(`${credentials.appId}:${message.id}:${text}:${index}`)
        .digest('hex')
        .slice(0, 32);
      try {
        await transport.send(message.chatId, chunks[index], uuid);
      } catch {
        this.update({ error: '飞书结果发送失败；结果仍保留在本机，请检查连接与发送消息权限。' });
        throw new Error('Feishu reply could not be delivered');
      }
    }
  }

  async dispose(): Promise<void> {
    this.disconnect();
    this.disposed = true;
    await this.receiptQueue;
    // Agent work belongs to the caller; do not keep app shutdown waiting on it.
  }

  private assertActive() {
    if (this.disposed) throw new Error('Feishu connector has been disposed');
  }
  private update(patch: Partial<FeishuState>) {
    this.state = { ...this.state, ...patch };
    this.options.onState(this.getState());
  }
  private itemKey(appId: string, messageId: string) {
    return createHash('sha256').update(`${appId}:${messageId}`).digest('hex');
  }
  private inboxFile(key: string) {
    return path.join(this.options.storageDir, 'inbox', `${key}.enc`);
  }
  private configFile() {
    return path.join(this.options.storageDir, 'credentials.enc');
  }
  private newPairingCode() {
    this.pairingAttempts = 0;
    this.pairingExpiresAt = Date.now() + 10 * 60_000;
    const code = randomBytes(8).toString('hex').toUpperCase().match(/.{4}/g)!.join('-');
    this.update({ pairingCode: `WB-${code}` });
  }
  private track(task: Promise<void>) {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
  }

  private async load() {
    await mkdir(path.join(this.options.storageDir, 'inbox'), { recursive: true, mode: 0o700 });
    try {
      const credentials: unknown = JSON.parse(
        await this.options.decrypt(await readFile(this.configFile(), 'utf8')),
      );
      if (!validCredentials(credentials)) throw new Error('Invalid stored credentials');
      this.credentials = credentials;
      this.update({ appId: credentials.appId, paired: Boolean(credentials.binding) });
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    for (const filename of await readdir(path.join(this.options.storageDir, 'inbox'))) {
      if (!/^[a-f\d]{64}\.enc$/.test(filename)) continue;
      const entry = JSON.parse(
        await this.options.decrypt(
          await readFile(path.join(this.options.storageDir, 'inbox', filename), 'utf8'),
        ),
      ) as InboxItem;
      if (
        !entry?.appId ||
        !entry.message?.id ||
        !['pending', 'running', 'done', 'failed'].includes(entry.status)
      )
        throw new Error('Invalid inbox item');
      const key = this.itemKey(entry.appId, entry.message.id);
      if (`${key}.enc` !== filename) throw new Error('Invalid inbox key');
      if (entry.status === 'running') {
        // A crashed process may have completed side effects. Never replay it automatically.
        entry.status = 'failed';
        await this.saveItem(entry);
        this.recoveryWarning =
          '有上次中断的飞书任务，未自动重试。请先检查执行结果，再决定是否重新发送。';
        this.update({ error: this.recoveryWarning });
      }
      this.inbox.set(key, entry);
    }
  }

  private async writeEncrypted(filename: string, value: unknown) {
    const encrypted = await this.options.encrypt(JSON.stringify(value));
    const temporary = `${filename}.${randomBytes(6).toString('hex')}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(encrypted, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, filename);
      const directory = await open(path.dirname(filename), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
  private saveCredentials(credentials: Credentials) {
    return this.writeEncrypted(this.configFile(), credentials);
  }
  private saveItem(item: InboxItem) {
    return this.writeEncrypted(this.inboxFile(this.itemKey(item.appId, item.message.id)), item);
  }

  private async acceptEvent(event: unknown, appId: string, generation: number) {
    if (generation !== this.generation || this.disposed) return;
    const received = parseMessage(event, appId);
    if (!received || this.credentials?.appId !== appId) return;
    const { message, tenantKey } = received;
    const key = this.itemKey(appId, message.id);
    if (this.inbox.has(key)) return;
    const credentials = this.credentials;
    if (!credentials.binding) {
      if (Date.now() > this.pairingExpiresAt || this.pairingAttempts >= 10) this.newPairingCode();
      this.pairingAttempts++;
      const code = message.text.replace(/^(?:\/pair|配对|绑定)\s+/i, '').toUpperCase();
      if (!this.state.pairingCode || code !== this.state.pairingCode) return;
      const paired = {
        ...credentials,
        binding: { senderId: message.senderId, chatId: message.chatId, tenantKey },
      };
      const item: InboxItem = { appId, message, kind: 'pair', status: 'pending' };
      await this.saveItem(item);
      if (generation !== this.generation || this.disposed) return;
      await this.saveCredentials(paired);
      if (generation !== this.generation || this.disposed) return;
      this.credentials = paired;
      this.inbox.set(key, item);
      this.update({
        paired: true,
        pairingCode: undefined,
        lastMessageAt: Date.now(),
        error: undefined,
      });
      this.schedule(item);
      return;
    }
    if (
      credentials.binding.senderId !== message.senderId ||
      credentials.binding.chatId !== message.chatId ||
      (credentials.binding.tenantKey && credentials.binding.tenantKey !== tenantKey)
    )
      return;
    const item: InboxItem = { appId, message, kind: 'command', status: 'pending' };
    await this.saveItem(item);
    this.inbox.set(key, item);
    if (generation !== this.generation || this.disposed) return;
    this.update({ lastMessageAt: Date.now() });
    this.schedule(item);
  }

  private resumePending() {
    for (const item of this.inbox.values())
      if (item.appId === this.credentials?.appId && item.status === 'pending') this.schedule(item);
  }
  private scheduled = new Set<string>();
  private schedule(item: InboxItem) {
    const key = this.itemKey(item.appId, item.message.id);
    if (this.scheduled.has(key) || item.status !== 'pending') return;
    this.scheduled.add(key);
    const run = async () => {
      if (
        this.disposed ||
        item.appId !== this.credentials?.appId ||
        !this.transport ||
        this.state.status !== 'connected'
      )
        return;
      const binding = this.credentials.binding;
      if (binding?.senderId !== item.message.senderId || binding.chatId !== item.message.chatId)
        return;
      try {
        item.status = 'running';
        await this.saveItem(item);
        if (item.kind === 'pair')
          await this.sendReply(
            item.message,
            '已与本机 Workbench 配对。发送文字即可开始任务，发送 /cancel 可取消当前任务。',
          );
        else await this.options.onMessage(item.message);
        item.status = 'done';
        await this.saveItem(item);
      } catch {
        item.status = 'failed';
        try {
          await this.saveItem(item);
        } catch {
          this.update({
            error: '飞书任务状态保存失败，请检查本地存储。为避免重复操作，不会自动重试。',
          });
          return;
        }
        this.update({ error: '飞书任务处理失败，未自动重试；请查看本机任务记录。' });
        if (item.kind !== 'pair') {
          try {
            await this.sendReply(
              item.message,
              '任务处理失败，请查看本机 Workbench 中的错误信息。为避免重复操作，本次未自动重试。',
            );
          } catch {
            /* sendReply already reports the delivery failure to the desktop. */
          }
        }
      }
    };
    const task = (isCancel(item.message.text) ? run() : this.commandQueue.then(run)).finally(() => {
      this.scheduled.delete(key);
    });
    if (!isCancel(item.message.text)) this.commandQueue = task;
    this.track(task);
  }
}
