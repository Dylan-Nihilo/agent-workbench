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
  deferRestore?: boolean;
  restoreTimeoutMs?: number;
  sendTimeoutMs?: number;
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

function messageText(type: unknown, content: unknown): string | undefined {
  if (!isRecord(content)) return;
  if (type === 'text') return typeof content.text === 'string' ? content.text.trim() : undefined;
  if (type !== 'post') return;
  // Feishu receives direct post bodies; the official SDK also accepts locale-wrapped bodies.
  const body = Array.isArray(content.content)
    ? content
    : ['zh_cn', 'en_us', 'ja_jp']
        .map((locale) => content[locale])
        .find((value) => isRecord(value) && Array.isArray(value.content));
  if (!isRecord(body) || !Array.isArray(body.content)) return;
  const lines = typeof body.title === 'string' && body.title ? [body.title] : [];
  for (const paragraph of body.content) {
    if (!Array.isArray(paragraph)) return;
    let line = '';
    for (const element of paragraph) {
      if (!isRecord(element)) return;
      // Do not fetch media, expose resource keys or execute link targets/embedded content.
      if (
        typeof element.tag === 'string' &&
        ['text', 'a', 'md', 'code_block'].includes(element.tag) &&
        typeof element.text === 'string'
      )
        line += element.text;
    }
    lines.push(line);
  }
  return lines.join('\n').trim();
}

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
    (message.message_type !== 'text' && message.message_type !== 'post')
  )
    return;
  if (!isRecord(sender.sender_id) || typeof sender.sender_id.open_id !== 'string') return;
  if (
    typeof message.message_id !== 'string' ||
    typeof message.chat_id !== 'string' ||
    typeof message.content !== 'string' ||
    message.content.length > 100_000
  )
    return;
  let content: unknown;
  try {
    content = JSON.parse(message.content);
  } catch {
    return;
  }
  const text = messageText(message.message_type, content);
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
  private state: FeishuState = { status: 'restoring', paired: false };
  private credentials?: Credentials;
  private transport?: FeishuTransport;
  private setupAbort?: AbortController;
  private setupReady?: Promise<FeishuState>;
  private cancelConnection?: () => void;
  private restoring?: Promise<FeishuState>;
  private restored = false;
  private restoreError?: Error;
  private restoreGeneration = 0;
  private cancelRestore?: () => void;
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
    if (options.deferRestore) this.update({ status: 'restoring' });
    else void this.retryRestore().catch(() => {});
  }

  getState(): FeishuState {
    return { ...this.state };
  }

  async retryRestore(): Promise<FeishuState> {
    this.assertActive();
    if (this.restored) return this.getState();
    if (this.restoring) return this.restoring;
    const generation = ++this.restoreGeneration;
    let active = true;
    const current = () => active && generation === this.restoreGeneration && !this.disposed;
    const checkCurrent = () => {
      if (!current()) throw new Error('Feishu restore attempt is no longer active');
    };
    this.restoreError = undefined;
    this.update({ status: 'restoring', restoreFailed: false, error: undefined });
    const requestedTimeout = this.options.restoreTimeoutMs ?? 15_000;
    const timeoutMs =
      Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : 15_000;
    const timeoutError = new Error('Feishu restore deadline exceeded');
    let timer!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(timeoutError), timeoutMs);
      this.cancelRestore = () => {
        active = false;
        reject(new Error('Feishu restore cancelled'));
      };
    });
    const task = Promise.race([this.load(checkCurrent), deadline])
      .then((snapshot) => {
        checkCurrent();
        this.credentials = snapshot.credentials;
        this.inbox = snapshot.inbox;
        this.recoveryWarning = snapshot.recoveryWarning;
        this.restored = true;
        this.update({
          status: 'disconnected',
          hasSavedCredentials: Boolean(snapshot.credentials),
          appId: snapshot.credentials?.appId,
          paired: Boolean(snapshot.credentials?.binding),
          error: snapshot.recoveryWarning,
        });
        return this.getState();
      })
      .catch((error) => {
        active = false;
        const message =
          error === timeoutError
            ? '恢复飞书本地加密数据超时。原有加密文件未更改，请先完成 macOS 钥匙串授权，再重试恢复。'
            : '无法恢复飞书本地加密数据。原有加密文件未更改，请检查系统钥匙串授权与存储目录后重试。';
        if (generation === this.restoreGeneration && !this.disposed) {
          this.restoreError = new Error(message);
          this.update({ status: 'error', restoreFailed: true, error: message });
        }
        throw new Error(message);
      })
      .finally(() => {
        active = false;
        clearTimeout(timer);
        if (generation === this.restoreGeneration) {
          this.restoring = undefined;
          this.cancelRestore = undefined;
        }
      });
    this.restoring = task;
    return task;
  }

  private async ensureRestored(): Promise<void> {
    this.assertActive();
    if (this.restored) return;
    if (this.restoring) await this.restoring;
    else if (this.restoreError) throw this.restoreError;
    else await this.retryRestore();
    this.assertActive();
  }

  async beginSetup(): Promise<FeishuState> {
    await this.ensureRestored();
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
    await this.ensureRestored();
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
    await this.ensureRestored();
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
      status: this.restored ? 'disconnected' : this.restoreError ? 'error' : 'restoring',
      paired: Boolean(this.credentials?.binding),
      setupUrl: undefined,
      setupQr: undefined,
      error: this.restored ? undefined : this.restoreError?.message,
    });
    return this.getState();
  }

  async sendReply(message: FeishuMessage, text: string): Promise<void> {
    await this.ensureRestored();
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
    await this.sendBoundMessage('reply', message.id, text, credentials, binding, transport);
  }

  async sendNotification(id: string, text: string): Promise<boolean> {
    const credentials = this.credentials;
    const binding = credentials?.binding;
    const transport = this.transport;
    // Notifications never unlock saved credentials or establish a connection as a side effect.
    if (
      this.disposed ||
      !credentials ||
      !binding ||
      !transport ||
      !this.state.paired ||
      this.state.status !== 'connected'
    )
      return false;
    if (typeof id !== 'string' || !id.trim() || id.length > 1024)
      throw new Error('通知必须提供有效的稳定 ID。');
    if (typeof text !== 'string' || !text.trim()) return false;
    await this.sendBoundMessage('notification', id, text, credentials, binding, transport);
    return true;
  }

  private async sendBoundMessage(
    kind: 'reply' | 'notification',
    id: string,
    text: string,
    credentials: Credentials,
    binding: NonNullable<Credentials['binding']>,
    transport: FeishuTransport,
  ): Promise<void> {
    const generation = this.generation;
    const recipient = { ...binding };
    const { appId, appSecret, domain } = credentials;
    const routeChanged = new Error('飞书连接或配对已改变，停止发送结果。');
    const timedOut = new Error('Feishu delivery timed out');
    let active = true;
    const checkRoute = () => {
      if (
        !active ||
        this.disposed ||
        generation !== this.generation ||
        transport !== this.transport ||
        this.credentials !== credentials ||
        this.state.status !== 'connected' ||
        !this.state.paired ||
        credentials.appId !== appId ||
        credentials.appSecret !== appSecret ||
        credentials.domain !== domain ||
        credentials.binding !== binding ||
        binding.senderId !== recipient.senderId ||
        binding.chatId !== recipient.chatId ||
        binding.tenantKey !== recipient.tenantKey
      )
        throw routeChanged;
    };
    const chunks = Array.from(text).reduce<string[]>((all, character) => {
      if (!all.length || all[all.length - 1].length >= 3_000) all.push('');
      all[all.length - 1] += character;
      return all;
    }, []);
    const requestedTimeout = this.options.sendTimeoutMs ?? 15_000;
    const timeoutMs =
      Number.isFinite(requestedTimeout) && requestedTimeout > 0
        ? Math.min(requestedTimeout, 15_000)
        : 15_000;
    let timer!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        active = false;
        reject(timedOut);
      }, timeoutMs);
    });
    const sending = (async () => {
      for (let index = 0; index < chunks.length; index++) {
        checkRoute();
        const uuid = createHash('sha256')
          .update(
            JSON.stringify([
              appId,
              recipient.senderId,
              recipient.chatId,
              recipient.tenantKey ?? '',
              kind,
              id,
              text,
              index,
            ]),
          )
          .digest('hex')
          .slice(0, 32);
        await transport.send(recipient.chatId, chunks[index], uuid);
        checkRoute();
      }
    })();
    try {
      await Promise.race([sending, deadline]);
    } catch (error) {
      const label = kind === 'notification' ? '通知' : '结果';
      if (error === timedOut) {
        this.update({
          error: `飞书${label}发送超时，送达状态未知；内容保留在本机，请先检查飞书再重试。`,
        });
        throw timedOut;
      }
      if (error === routeChanged) {
        this.update({ error: `飞书连接或配对已改变，${label}发送已停止；已发送的分片无法撤回。` });
        throw routeChanged;
      }
      this.update({ error: `飞书${label}发送失败；内容仍保留在本机，请检查连接与发送消息权限。` });
      throw new Error(`Feishu ${kind} could not be delivered`);
    } finally {
      active = false;
      clearTimeout(timer);
    }
  }

  async dispose(): Promise<void> {
    this.cancelRestore?.();
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

  private async load(checkCurrent: () => void) {
    let credentials: Credentials | undefined;
    let credentialCiphertext: string | undefined;
    try {
      credentialCiphertext = await readFile(this.configFile(), 'utf8');
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    checkCurrent();
    this.update({ hasSavedCredentials: credentialCiphertext !== undefined });
    if (credentialCiphertext !== undefined) {
      const decrypted = await this.options.decrypt(credentialCiphertext);
      checkCurrent();
      const parsed: unknown = JSON.parse(decrypted);
      if (!validCredentials(parsed)) throw new Error('Invalid stored credentials');
      credentials = parsed;
    }
    let filenames: string[];
    try {
      filenames = await readdir(path.join(this.options.storageDir, 'inbox'));
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      filenames = [];
    }
    checkCurrent();
    const inbox = new Map<string, InboxItem>();
    let recoveryWarning: string | undefined;
    for (const filename of filenames) {
      if (!/^[a-f\d]{64}\.enc$/.test(filename)) continue;
      const ciphertext = await readFile(
        path.join(this.options.storageDir, 'inbox', filename),
        'utf8',
      );
      checkCurrent();
      const decrypted = await this.options.decrypt(ciphertext);
      checkCurrent();
      const entry = JSON.parse(decrypted) as InboxItem;
      if (
        !entry?.appId ||
        !entry.message?.id ||
        !['pending', 'running', 'done', 'failed'].includes(entry.status)
      )
        throw new Error('Invalid inbox item');
      const key = this.itemKey(entry.appId, entry.message.id);
      if (`${key}.enc` !== filename) throw new Error('Invalid inbox key');
      if (entry.status === 'running') {
        // Keep restore read-only: a crashed task stays failed in memory and is never replayed.
        entry.status = 'failed';
        recoveryWarning =
          '有上次中断的飞书任务，未自动重试。请先检查执行结果，再决定是否重新发送。';
      }
      inbox.set(key, entry);
    }
    checkCurrent();
    return { credentials, inbox, recoveryWarning };
  }

  private async writeEncrypted(filename: string, value: unknown) {
    const encrypted = await this.options.encrypt(JSON.stringify(value));
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
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
  private async saveCredentials(credentials: Credentials) {
    await this.writeEncrypted(this.configFile(), credentials);
    this.update({ hasSavedCredentials: true });
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
