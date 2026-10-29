import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type {
  BrowserFrame,
  BrowserInput,
  BrowserState,
  BrowserTool,
  ElementRef,
  RecordedStep,
  Recording,
  ToolResult,
} from '../shared/types';
import { CdpConnection } from './browser-cdp';
import { browserPageSource } from './browser-page';

const execFileAsync = promisify(execFile);
const WORLD = 'workbench-browser-observer';
const PREVIEW_MAX_EDGE = 2048;
const PREVIEW_INTERVAL = 1000 / 24;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function normalizeBrowserUrl(input: string): string {
  if (typeof input !== 'string' || !input.trim() || input.length > 4096)
    throw new Error('请输入有效的 HTTP 或 HTTPS 地址');
  let value = input.trim();
  if (/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(?::\d+)?(?:\/|$)/i.test(value))
    value = `http://${value}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) value = `https://${value}`;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password)
    throw new Error('浏览器仅允许不含凭据的 HTTP / HTTPS 地址');
  return url.href;
}

export function redactBrowserText(value: unknown): string {
  return String(value ?? '')
    .replace(/Bearer\s+\S+/gi, 'Bearer [hidden]')
    .replace(/(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, '[hidden]')
    .replace(/((?:password|secret|token|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[hidden]')
    .slice(0, 2000);
}

function evidenceUrl(value: string): string {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol)
      ? `${url.origin}${url.pathname}`
      : url.protocol;
  } catch {
    return '';
  }
}

async function brandedBinary(candidate: string): Promise<string | undefined> {
  try {
    const app = candidate.endsWith('.app')
      ? candidate
      : candidate.slice(0, candidate.lastIndexOf('.app/') + 4);
    if (!app.endsWith('.app')) return undefined;
    const { stdout } = await execFileAsync('/usr/bin/plutil', [
      '-convert',
      'json',
      '-o',
      '-',
      join(app, 'Contents/Info.plist'),
    ]);
    const info = JSON.parse(stdout);
    if (info.CFBundleIdentifier !== 'com.browseros.BrowserClaw') return undefined;
    const binary = join(app, 'Contents/MacOS', info.CFBundleExecutable);
    if (!candidate.endsWith('.app') && resolve(candidate) !== resolve(binary)) return undefined;
    await access(binary, constants.X_OK);
    return binary;
  } catch {
    return undefined;
  }
}

export async function discoverBrowserOS(
  explicit?: string,
  storageDir?: string,
): Promise<string | undefined> {
  if (explicit) return brandedBinary(resolve(explicit));
  const candidates = [
    process.env.WORKBENCH_BROWSEROS_PATH,
    '/Applications/BrowserOS neo.app',
    join(homedir(), 'Applications/BrowserOS neo.app'),
    resolve(process.cwd(), '../browseros-runtime/BrowserOS neo.app'),
    storageDir ? join(storageDir, 'runtime/BrowserOS neo.app') : undefined,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const binary = await brandedBinary(candidate);
    if (binary) return binary;
  }
  return undefined;
}

interface BrowserOptions {
  storageDir: string;
  binaryPath?: string;
  onState: (state: BrowserState) => void;
  onFrame: (frame: BrowserFrame) => void;
  onStep: (step: RecordedStep) => void;
  onSelected: (element: ElementRef) => void;
  onHumanTakeover: () => void;
}

/** Owns one real BrowserOS neo page. Electron only displays its interactive frame stream. */
export class BrowserRuntime {
  private state: BrowserState = {
    status: 'missing',
    engine: 'browseros',
    url: '',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    recording: false,
    inspecting: false,
  };
  private process?: ChildProcess;
  private browser?: CdpConnection;
  private page?: CdpConnection;
  private targetId = '';
  private mainFrameId = '';
  private contextId?: number;
  private documentId = '';
  private width = 1100;
  private height = 760;
  private frameAckTimer?: ReturnType<typeof setTimeout>;
  private starting?: Promise<void>;
  private disposed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private leaseGeneration = 0;
  private agentAllowed = true;
  private suppressMouseUp = false;
  private source: 'human' | 'agent' = 'human';
  private recording?: Recording;
  private diagnostics: Array<{ time: number; kind: string; text: string }> = [];

  constructor(private options: BrowserOptions) {}

  getState(): BrowserState {
    return structuredClone(this.state);
  }

  private update(patch: Partial<BrowserState>): void {
    this.state = { ...this.state, ...patch };
    this.options.onState(this.getState());
  }

  private log(kind: string, text: unknown): void {
    this.diagnostics.push({ time: Date.now(), kind, text: redactBrowserText(text) });
    if (this.diagnostics.length > 150) this.diagnostics.shift();
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }

  start(initialUrl?: string): Promise<void> {
    if (this.state.status === 'ready') return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.startInternal(initialUrl).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async startInternal(initialUrl?: string): Promise<void> {
    const initial = initialUrl === undefined ? undefined : normalizeBrowserUrl(initialUrl);
    this.disposed = false;
    const binary = await discoverBrowserOS(this.options.binaryPath, this.options.storageDir);
    if (!binary) {
      this.update({
        status: 'missing',
        error: '未找到 BrowserOS neo。请安装官方 neo，或在设置中指定其应用路径。',
      });
      throw new Error(this.state.error);
    }
    this.update({ status: 'starting', binaryPath: binary, error: undefined });
    const profile = join(this.options.storageDir, 'browseros-profile');
    await mkdir(profile, { recursive: true });
    const child = spawn(
      binary,
      [
        '--headless=new',
        '--force-device-scale-factor=2',
        '--remote-debugging-port=0',
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-browseros-server',
        '--disable-browseros-server-updater',
        '--disable-browseros-extensions',
        '--browseros-disable-url-overrides',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-features=MediaRouter',
        '--disable-gpu',
        '--disable-sync',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        'about:blank',
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
          LANG: process.env.LANG || 'en_US.UTF-8',
          BROWSERCLAW_DIR: join(profile, 'claw-state'),
        },
      },
    );
    this.process = child;
    let launchError: Error | undefined;
    let endpointFromOutput = '';
    child.stderr?.on('data', (data) => {
      const match = data
        .toString()
        .match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/);
      if (match) endpointFromOutput = match[1];
    });
    child.on('error', (error) => {
      launchError = error;
    });
    child.on('exit', () => {
      if (!this.disposed && this.process === child)
        this.update({
          status: 'error',
          loading: false,
          error: 'BrowserOS neo 已退出。请重新启动浏览器。',
        });
    });
    try {
      const endpoint = await this.until(async () => {
        if (launchError) throw launchError;
        if (child.exitCode !== null) throw new Error('BrowserOS neo 启动失败');
        return endpointFromOutput || undefined;
      }, 20_000);
      this.browser = await CdpConnection.connect(endpoint);
      const url = new URL(endpoint);
      const response = await fetch(`http://${url.host}/json/list`);
      const targets = (await response.json()) as Array<{
        id: string;
        type: string;
        webSocketDebuggerUrl: string;
      }>;
      const target = targets.find((item) => item.type === 'page');
      if (!target) throw new Error('BrowserOS neo 没有创建可用页面');
      this.targetId = target.id;
      this.page = await CdpConnection.connect(target.webSocketDebuggerUrl);
      this.installPageEvents();
      await this.page.call('Page.enable');
      const tree = await this.page.call('Page.getFrameTree');
      this.mainFrameId = tree.frameTree.frame.id;
      await this.page.call('Runtime.enable');
      await this.page.call('Network.enable');
      await this.page.call('Runtime.addBinding', {
        name: '__workbenchEvent',
        executionContextName: WORLD,
      });
      await this.page.call('Page.addScriptToEvaluateOnNewDocument', {
        source: browserPageSource,
        worldName: WORLD,
      });
      const world = await this.page.call('Page.createIsolatedWorld', {
        frameId: this.mainFrameId,
        worldName: WORLD,
      });
      this.contextId = world.executionContextId;
      await this.page.call('Runtime.evaluate', {
        expression: browserPageSource,
        contextId: this.contextId,
      });
      await this.page.call('Emulation.setDeviceMetricsOverride', {
        width: this.width,
        height: this.height,
        deviceScaleFactor: 2,
        mobile: false,
      });
      await this.page.call('Page.bringToFront');
      await this.startScreencast();
      await this.page.call('Fetch.enable', {
        patterns: [{ resourceType: 'Document', requestStage: 'Request' }],
      });
      this.browser.on('Target.targetCreated', (params) => {
        void this.handlePopup(params.targetInfo);
      });
      this.browser.on('Target.targetInfoChanged', (params) => {
        void this.handlePopup(params.targetInfo);
      });
      await this.browser.call('Target.setDiscoverTargets', { discover: true });
      if (initial !== undefined) {
        // Startup is not a user action. Finish it before exposing a ready browser.
        this.update({ url: initial, loading: true });
        const navigation = await this.page.call('Page.navigate', { url: initial });
        if (navigation.errorText) throw new Error(navigation.errorText);
        await this.refreshPageState();
        this.update({ status: 'ready', error: undefined });
        return;
      }
      this.update({
        status: 'ready',
        loading: false,
        url: 'about:blank',
        title: '新标签页',
        error: undefined,
      });
    } catch (error) {
      const message = redactBrowserText(error instanceof Error ? error.message : error);
      await this.dispose();
      this.update({ status: 'error', error: message, loading: false });
      throw new Error(message);
    }
  }

  private async until<T>(
    check: () => Promise<T | undefined | false>,
    timeout = 10_000,
  ): Promise<T> {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = await check();
      if (value) return value as T;
      await wait(60);
    }
    throw new Error('等待浏览器响应超时');
  }

  private installPageEvents(): void {
    const page = this.page!;
    page.on('Runtime.executionContextCreated', (params) => {
      const ctx = params.context;
      if (ctx.name === WORLD && ctx.auxData?.frameId === this.mainFrameId) this.contextId = ctx.id;
    });
    page.on('Runtime.executionContextDestroyed', (params) => {
      if (params.executionContextId === this.contextId) this.contextId = undefined;
    });
    page.on('Runtime.executionContextsCleared', () => {
      this.contextId = undefined;
    });
    page.on('Runtime.bindingCalled', (params) => {
      if (
        params.name !== '__workbenchEvent' ||
        params.executionContextId !== this.contextId ||
        typeof params.payload !== 'string' ||
        params.payload.length > 16_000
      )
        return;
      try {
        this.recordEvent(JSON.parse(params.payload));
      } catch {}
    });
    page.on('Page.frameNavigated', (params) => {
      if (params.frame.parentId) return;
      this.mainFrameId = params.frame.id;
      this.documentId = '';
      this.contextId = undefined;
      this.update({ url: params.frame.url, selectedElement: undefined });
      this.appendStep({
        kind: 'navigate',
        description: `打开 ${evidenceUrl(params.frame.url)}`,
        url: evidenceUrl(params.frame.url),
        source: this.source,
      });
      void this.refreshPageState();
    });
    page.on('Page.navigatedWithinDocument', (params) => {
      if (params.frameId === this.mainFrameId) {
        this.update({ url: params.url });
        void this.refreshPageState();
      }
    });
    page.on('Page.frameStartedLoading', (params) => {
      if (params.frameId === this.mainFrameId) this.update({ loading: true });
    });
    page.on('Page.frameStoppedLoading', (params) => {
      if (params.frameId === this.mainFrameId) {
        this.update({ loading: false });
        void this.refreshPageState();
      }
    });
    page.on('Page.screencastFrame', (params) => {
      if (this.disposed || this.page !== page) return;
      // Metadata dimensions are CSS/DIP coordinates, not the JPEG's physical pixels.
      this.options.onFrame({
        data: `data:image/jpeg;base64,${params.data}`,
        width: params.metadata.deviceWidth || this.width,
        height: params.metadata.deviceHeight || this.height,
      });
      // One in-flight frame provides backpressure; retain the final dirty frame without polling.
      this.frameAckTimer = setTimeout(() => {
        this.frameAckTimer = undefined;
        void page.call('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
      }, PREVIEW_INTERVAL);
    });
    page.on('Runtime.consoleAPICalled', (params) =>
      this.log(
        `console.${params.type}`,
        params.args.map((arg: any) => arg.value ?? arg.description ?? '').join(' '),
      ),
    );
    page.on('Runtime.exceptionThrown', (params) =>
      this.log(
        'exception',
        params.exceptionDetails.exception?.description || params.exceptionDetails.text,
      ),
    );
    page.on('Network.responseReceived', (params) =>
      this.log('network', `${params.response.status} ${evidenceUrl(params.response.url)}`),
    );
    page.on('Network.loadingFailed', (params) => this.log('network.error', params.errorText));
    page.on('Page.javascriptDialogOpening', () => {
      this.log('dialog', '页面弹窗已关闭；请在普通页面控件中完成交互。');
      void page.call('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
    });
    page.on('Fetch.requestPaused', (params) => {
      let allowed = params.request.url === 'about:blank';
      try {
        normalizeBrowserUrl(params.request.url);
        allowed = true;
      } catch {}
      void page
        .call(
          allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest',
          allowed
            ? { requestId: params.requestId }
            : { requestId: params.requestId, errorReason: 'BlockedByClient' },
        )
        .catch(() => {});
      if (!allowed) this.log('navigation.blocked', '阻止了非 HTTP(S) 页面导航');
    });
    page.on('connection:closed', () => {
      if (!this.disposed && this.page === page)
        this.update({ status: 'error', loading: false, error: 'BrowserOS neo 连接已断开' });
    });
  }

  private async handlePopup(info: { targetId: string; type: string; url: string }): Promise<void> {
    if (
      this.disposed ||
      info.type !== 'page' ||
      info.targetId === this.targetId ||
      !info.url ||
      info.url === 'about:blank'
    )
      return;
    try {
      const url = normalizeBrowserUrl(info.url);
      await this.browser?.call('Target.closeTarget', { targetId: info.targetId });
      await this.serialize(() => this.navigateInternal(url, this.source));
    } catch {
      await this.browser?.call('Target.closeTarget', { targetId: info.targetId }).catch(() => {});
    }
  }

  private async refreshPageState(): Promise<void> {
    try {
      const result = await this.page?.call('Runtime.evaluate', {
        expression: '({title:document.title,url:location.href})',
        returnByValue: true,
      });
      const history = await this.page?.call('Page.getNavigationHistory');
      if (result?.result.value)
        this.update({
          title: result.result.value.title,
          url: result.result.value.url,
          canGoBack: history.currentIndex > 0,
          canGoForward: history.currentIndex < history.entries.length - 1,
        });
    } catch {}
  }

  private async startScreencast(): Promise<void> {
    // Native DPR 2 is required: emulation alone leaves the composited screencast at DPR 1.
    await this.page!.call('Page.startScreencast', {
      format: 'jpeg',
      quality: 88,
      maxWidth: PREVIEW_MAX_EDGE,
      maxHeight: PREVIEW_MAX_EDGE,
      everyNthFrame: 1,
      maxFramesInFlight: 1,
      sendLastFrame: true,
    });
  }

  private async bridge<T = any>(expression: string): Promise<T> {
    this.requireReady();
    // BFCache can announce a restored context before frameNavigated clears the cache.
    // Resolve the named world from the active frame instead of waiting for another event.
    const contextId = await this.prepareBridgeContext();
    const result = await this.page!.call('Runtime.evaluate', {
      expression,
      contextId,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description || result.exceptionDetails.text,
      );
    return result.result.value as T;
  }

  private async prepareBridgeContext(): Promise<number> {
    const page = this.page!;
    for (let attempt = 0; attempt < 3; attempt++) {
      this.requireReady();
      try {
        const tree = await page.call('Page.getFrameTree');
        const frameId = tree.frameTree.frame.id;
        const world = await page.call('Page.createIsolatedWorld', {
          frameId,
          worldName: WORLD,
        });
        const contextId = world.executionContextId as number;
        const ready = await page.call('Runtime.evaluate', {
          expression:
            'typeof globalThis.__workbenchPage === "object" && typeof globalThis.__workbenchEvent === "function"',
          contextId,
          returnByValue: true,
        });
        if (ready.exceptionDetails)
          throw new Error(
            ready.exceptionDetails.exception?.description || ready.exceptionDetails.text,
          );
        if (!ready.result.value) {
          await page.call('Runtime.addBinding', {
            name: '__workbenchEvent',
            executionContextId: contextId,
          });
          const installed = await page.call('Runtime.evaluate', {
            expression: browserPageSource,
            contextId,
          });
          if (installed.exceptionDetails)
            throw new Error(
              installed.exceptionDetails.exception?.description || installed.exceptionDetails.text,
            );
        }
        this.mainFrameId = frameId;
        this.contextId = contextId;
        return contextId;
      } catch (error) {
        this.contextId = undefined;
        const message = error instanceof Error ? error.message : String(error);
        if (
          attempt === 2 ||
          !/Cannot find (?:context|execution context)|Execution context was destroyed|No frame with given id|No frame for given id/i.test(
            message,
          )
        )
          throw error;
        await wait(30);
      }
    }
    throw new Error('无法连接当前页面的隔离上下文');
  }

  private requireReady(): void {
    if (!this.page || this.state.status !== 'ready') throw new Error('BrowserOS neo 尚未就绪');
  }

  private async setSource(source: 'human' | 'agent'): Promise<void> {
    this.source = source;
    await this.bridge(`globalThis.__workbenchPage.setSource(${JSON.stringify(source)})`);
  }

  allowAgentControl(): void {
    this.agentAllowed = true;
  }

  private humanTakeover(source: string): void {
    this.leaseGeneration++;
    this.agentAllowed = false;
    this.log('control', `Human takeover: ${source}`);
    this.options.onHumanTakeover();
  }

  navigate(url: string): Promise<void> {
    const normalized = normalizeBrowserUrl(url);
    this.humanTakeover('navigate');
    return this.serialize(() => this.navigateInternal(normalized, 'human'));
  }

  private async navigateInternal(url: string, source: 'human' | 'agent'): Promise<void> {
    this.requireReady();
    this.source = source;
    this.documentId = '';
    this.contextId = undefined;
    this.update({ loading: true, inspecting: false, selectedElement: undefined });
    const result = await this.page!.call('Page.navigate', { url: normalizeBrowserUrl(url) });
    if (result.errorText) {
      this.update({ loading: false });
      throw new Error(result.errorText);
    }
  }

  back(): Promise<void> {
    return this.historyMove(-1);
  }
  forward(): Promise<void> {
    return this.historyMove(1);
  }

  private historyMove(direction: number): Promise<void> {
    this.humanTakeover(direction < 0 ? 'back' : 'forward');
    return this.serialize(async () => {
      this.requireReady();
      this.source = 'human';
      const history = await this.page!.call('Page.getNavigationHistory');
      const entry = history.entries[history.currentIndex + direction];
      if (entry) {
        this.documentId = '';
        this.contextId = undefined;
        await this.page!.call('Page.navigateToHistoryEntry', { entryId: entry.id });
      }
    });
  }

  reload(): Promise<void> {
    this.humanTakeover('reload');
    return this.serialize(async () => {
      this.requireReady();
      this.source = 'human';
      this.documentId = '';
      this.contextId = undefined;
      await this.page!.call('Page.reload');
    });
  }

  resize(width: number, height: number): Promise<void> {
    if (!Number.isFinite(width) || !Number.isFinite(height))
      return Promise.reject(new Error('Invalid browser viewport'));
    const w = Math.round(Math.min(1920, Math.max(320, width)));
    const h = Math.round(Math.min(1400, Math.max(240, height)));
    if (w === this.width && h === this.height) return Promise.resolve();
    this.width = w;
    this.height = h;
    if (this.state.status !== 'ready') return Promise.resolve();
    return this.serialize(async () => {
      if (this.frameAckTimer) clearTimeout(this.frameAckTimer);
      this.frameAckTimer = undefined;
      await this.page!.call('Page.stopScreencast');
      await this.page!.call('Emulation.setDeviceMetricsOverride', {
        width: w,
        height: h,
        deviceScaleFactor: 2,
        mobile: false,
      });
      await this.startScreencast();
    });
  }

  dispatchInput(input: BrowserInput): Promise<void> {
    if (!input || typeof input !== 'object')
      return Promise.reject(new Error('Invalid browser input'));
    if (input.type === 'resize') return this.resize(input.width, input.height);
    if (
      (input.type === 'mouse' && input.action === 'down') ||
      input.type === 'text' ||
      input.type === 'wheel' ||
      (input.type === 'key' && input.action === 'down')
    )
      this.humanTakeover(
        input.type === 'mouse' ? 'mouse-down' : input.type === 'key' ? 'key-down' : input.type,
      );
    return this.serialize(async () => {
      this.requireReady();
      if (input.type === 'mouse' && input.action === 'up' && this.suppressMouseUp) {
        this.suppressMouseUp = false;
        return;
      }
      await this.setSource('human');
      if (input.type === 'mouse' || input.type === 'wheel') {
        if (
          ![input.x, input.y].every(Number.isFinite) ||
          input.x < 0 ||
          input.y < 0 ||
          input.x > this.width ||
          input.y > this.height
        )
          throw new Error('Pointer is outside the browser viewport');
      }
      if (
        'modifiers' in input &&
        input.modifiers !== undefined &&
        (!Number.isInteger(input.modifiers) || input.modifiers < 0 || input.modifiers > 15)
      )
        throw new Error('Invalid keyboard modifiers');
      if (input.type === 'mouse') {
        if (
          !['move', 'down', 'up'].includes(input.action) ||
          (input.button && !['left', 'middle', 'right'].includes(input.button))
        )
          throw new Error('Invalid mouse input');
        if (this.state.inspecting && input.action === 'down') {
          const element = await this.bridge<ElementRef | null>(
            `globalThis.__workbenchPage.atPoint(${input.x},${input.y})`,
          );
          this.suppressMouseUp = true;
          if (element) {
            await this.bridge(`globalThis.__workbenchPage.outline(${JSON.stringify(element.ref)})`);
            this.update({ inspecting: false, selectedElement: element });
            this.options.onSelected(element);
          }
          return;
        }
        await this.page!.call('Input.dispatchMouseEvent', {
          type: { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased' }[input.action],
          x: input.x,
          y: input.y,
          button: input.button || 'left',
          clickCount: input.action === 'move' ? 0 : Math.min(3, Math.max(1, input.clickCount || 1)),
          modifiers: input.modifiers || 0,
        });
      } else if (input.type === 'wheel') {
        if (![input.deltaX, input.deltaY].every(Number.isFinite))
          throw new Error('Invalid scroll input');
        await this.page!.call('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: input.x,
          y: input.y,
          deltaX: Math.max(-5000, Math.min(5000, input.deltaX)),
          deltaY: Math.max(-5000, Math.min(5000, input.deltaY)),
          modifiers: input.modifiers || 0,
        });
      } else if (input.type === 'text') {
        if (typeof input.text !== 'string' || input.text.length > 20_000)
          throw new Error('Text input is too long');
        await this.page!.call('Input.insertText', { text: input.text });
      } else if (input.type === 'key') {
        if (
          !['down', 'up'].includes(input.action) ||
          typeof input.key !== 'string' ||
          typeof input.code !== 'string' ||
          input.key.length > 100 ||
          input.code.length > 100 ||
          (input.text?.length || 0) > 100
        )
          throw new Error('Invalid key input');
        await this.page!.call('Input.dispatchKeyEvent', {
          type: input.action === 'up' ? 'keyUp' : input.text ? 'keyDown' : 'rawKeyDown',
          key: input.key,
          code: input.code,
          windowsVirtualKeyCode: input.keyCode,
          nativeVirtualKeyCode: input.keyCode,
          modifiers: input.modifiers || 0,
          text: input.action === 'down' ? input.text : undefined,
        });
      } else throw new Error('Unsupported browser input');
    });
  }

  async setInspect(enabled: boolean): Promise<void> {
    this.requireReady();
    this.update({ inspecting: !!enabled });
    if (!enabled)
      await this.serialize(() => this.bridge('globalThis.__workbenchPage.outline(null)'));
  }

  startRecording(): void {
    this.requireReady();
    if (this.recording) return;
    this.recording = {
      id: randomUUID(),
      title: this.state.title || '浏览器操作',
      startedAt: Date.now(),
      steps: [],
    };
    this.update({ recording: true });
    this.appendStep({
      kind: 'navigate',
      description: `打开 ${evidenceUrl(this.state.url)}`,
      url: evidenceUrl(this.state.url),
      source: 'human',
    });
  }

  stopRecording(): Recording {
    if (!this.recording) throw new Error('当前没有录制');
    const recording = structuredClone({ ...this.recording, endedAt: Date.now() });
    this.recording = undefined;
    this.update({ recording: false });
    return recording;
  }

  private recordEvent(event: any): void {
    if (
      !this.recording ||
      !event ||
      !['click', 'fill', 'select', 'key', 'scroll'].includes(event.kind)
    )
      return;
    if (event.source !== 'human' && event.source !== 'agent') return;
    const target =
      event.target && typeof event.target.ref === 'string'
        ? {
            ref: event.target.ref.slice(0, 100),
            tag: String(event.target.tag || '').slice(0, 30),
            name: redactBrowserText(event.target.name).slice(0, 180),
            selector:
              typeof event.target.selector === 'string'
                ? event.target.selector.slice(0, 500)
                : undefined,
          }
        : undefined;
    const value = typeof event.value === 'string' ? redactBrowserText(event.value) : undefined;
    const verb = { click: '点击', fill: '填写', select: '选择', key: '按键', scroll: '滚动' }[
      event.kind as 'click'
    ];
    this.appendStep({
      kind: event.kind,
      description: `${verb}${target?.name ? `「${target.name}」` : ''}${value && ['key', 'scroll'].includes(event.kind) ? ` ${value}` : ''}`,
      url: evidenceUrl(this.state.url),
      source: event.source,
      target,
      value,
    });
  }

  private appendStep(data: Omit<RecordedStep, 'id' | 'timestamp'>): void {
    if (!this.recording || this.recording.steps.length >= 2000) return;
    const step: RecordedStep = { ...data, id: randomUUID(), timestamp: Date.now() };
    const last = this.recording.steps.at(-1);
    if (
      last &&
      ['fill', 'select', 'scroll'].includes(step.kind) &&
      last.kind === step.kind &&
      last.target?.ref === step.target?.ref &&
      last.source === step.source &&
      step.timestamp - last.timestamp < 1500
    ) {
      step.id = last.id;
      this.recording.steps[this.recording.steps.length - 1] = step;
    } else this.recording.steps.push(step);
    this.options.onStep(structuredClone(step));
  }

  snapshot(): Promise<ToolResult> {
    return this.serialize(() => this.snapshotInternal());
  }

  private async snapshotInternal(): Promise<ToolResult> {
    const snapshot = await this.bridge('globalThis.__workbenchPage.snapshot()');
    this.documentId = snapshot.documentId;
    snapshot.url = evidenceUrl(snapshot.url);
    return { text: JSON.stringify(snapshot, null, 2) };
  }

  screenshot(): Promise<ToolResult> {
    return this.serialize(() => this.screenshotInternal());
  }

  private async screenshotInternal(): Promise<ToolResult> {
    this.requireReady();
    try {
      await this.bridge('globalThis.__workbenchPage.mask(true)');
      const result = await this.page!.call('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
      });
      return {
        text: `当前 BrowserOS neo 页面截图：${evidenceUrl(this.state.url)}。敏感输入框已遮盖。`,
        image: result.data,
      };
    } finally {
      await this.bridge('globalThis.__workbenchPage.mask(false)').catch(() => {});
    }
  }

  getTools(): BrowserTool[] {
    const tool = (
      name: string,
      description: string,
      properties: Record<string, unknown> = {},
      required: string[] = [],
    ): BrowserTool => ({
      name: `workbench_browser_${name}`,
      description,
      inputSchema: { type: 'object', properties, required, additionalProperties: false },
    });
    const ref = {
      type: 'string',
      description: '当前 snapshot 返回的元素 ref；导航后必须重新取得。',
    };
    return [
      tool(
        'snapshot',
        '查看 App 内同一个 BrowserOS neo 页面的文字和可操作元素；操作前先获取 ref。',
      ),
      tool('screenshot', '获取同一页面截图，敏感输入框遮盖。'),
      tool('navigate', '在 App 内浏览器打开 HTTP(S) 地址。', { url: { type: 'string' } }, ['url']),
      tool('click', '点击当前 snapshot 中的元素。', { ref }, ['ref']),
      tool('fill', '填写一个文本输入框。', { ref, value: { type: 'string' } }, ['ref', 'value']),
      tool('select', '选择下拉框中的一个 option value。', { ref, value: { type: 'string' } }, [
        'ref',
        'value',
      ]),
      tool(
        'press',
        '发送 Enter、Tab、Escape、Backspace 或方向键。',
        {
          key: {
            type: 'string',
            enum: [
              'Enter',
              'Tab',
              'Escape',
              'Backspace',
              'ArrowUp',
              'ArrowDown',
              'ArrowLeft',
              'ArrowRight',
            ],
          },
        },
        ['key'],
      ),
      tool(
        'scroll',
        '滚动当前浏览器页面。',
        { deltaY: { type: 'number', minimum: -1500, maximum: 1500 } },
        ['deltaY'],
      ),
      tool('diagnostics', '读取当前浏览器的 console、异常和网络状态摘要，不包含请求或响应正文。'),
    ];
  }

  callTool(name: string, args: unknown): Promise<ToolResult> {
    const generation = this.leaseGeneration;
    return this.serialize(async () => {
      try {
        this.requireReady();
        if (!args || typeof args !== 'object' || Array.isArray(args))
          throw new Error('Tool arguments must be an object');
        const input = args as Record<string, unknown>;
        const definition = this.getTools().find((tool) => tool.name === name);
        if (!definition) throw new Error('Unknown browser tool');
        const properties = definition.inputSchema.properties as Record<string, unknown>;
        if (Object.keys(input).some((key) => !(key in properties)))
          throw new Error('Unexpected browser tool argument');
        if (name === 'workbench_browser_snapshot') return await this.snapshotInternal();
        if (name === 'workbench_browser_screenshot') return await this.screenshotInternal();
        if (name === 'workbench_browser_diagnostics')
          return { text: JSON.stringify(this.diagnostics, null, 2) };
        const assertLease = () => {
          if (!this.agentAllowed || generation !== this.leaseGeneration)
            throw new Error('用户已接管浏览器；请停止操作，等待新的用户请求。');
        };
        assertLease();
        if (name === 'workbench_browser_navigate') {
          if (typeof input.url !== 'string') throw new Error('url is required');
          await this.navigateInternal(normalizeBrowserUrl(input.url), 'agent');
          return { text: '页面正在加载。继续操作前请获取新的 snapshot。' };
        }
        await this.setSource('agent');
        assertLease();
        if (
          [
            'workbench_browser_click',
            'workbench_browser_fill',
            'workbench_browser_select',
          ].includes(name)
        ) {
          if (
            typeof input.ref !== 'string' ||
            !this.documentId ||
            !input.ref.startsWith(`${this.documentId}:`)
          )
            throw new Error('元素引用已失效。请重新获取 snapshot。');
          if (name === 'workbench_browser_click') {
            const box = await this.bridge(
              `globalThis.__workbenchPage.bounds(${JSON.stringify(input.ref)})`,
            );
            assertLease();
            if (box.disabled) throw new Error('Element is disabled');
            await this.page!.call('Input.dispatchMouseEvent', {
              type: 'mousePressed',
              x: box.x,
              y: box.y,
              button: 'left',
              clickCount: 1,
            });
            await this.page!.call('Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              x: box.x,
              y: box.y,
              button: 'left',
              clickCount: 1,
            });
          } else {
            if (typeof input.value !== 'string' || input.value.length > 20_000)
              throw new Error('value must be a string of at most 20,000 characters');
            if (name === 'workbench_browser_fill') {
              await this.bridge(`globalThis.__workbenchPage.focus(${JSON.stringify(input.ref)})`);
              assertLease();
              await this.page!.call('Input.insertText', { text: input.value });
            } else
              await this.bridge(
                `globalThis.__workbenchPage.select(${JSON.stringify(input.ref)},${JSON.stringify(input.value)})`,
              );
          }
        } else if (name === 'workbench_browser_press') {
          const codes: Record<string, number> = {
            Enter: 13,
            Tab: 9,
            Escape: 27,
            Backspace: 8,
            ArrowUp: 38,
            ArrowDown: 40,
            ArrowLeft: 37,
            ArrowRight: 39,
          };
          if (typeof input.key !== 'string' || !Object.hasOwn(codes, input.key))
            throw new Error('Unsupported key');
          await this.page!.call('Input.dispatchKeyEvent', {
            type: 'rawKeyDown',
            key: input.key,
            code: input.key,
            windowsVirtualKeyCode: codes[input.key],
          });
          await this.page!.call('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: input.key,
            code: input.key,
            windowsVirtualKeyCode: codes[input.key],
          });
        } else if (name === 'workbench_browser_scroll') {
          if (
            typeof input.deltaY !== 'number' ||
            !Number.isFinite(input.deltaY) ||
            Math.abs(input.deltaY) > 1500
          )
            throw new Error('deltaY must be between -1500 and 1500');
          await this.page!.call('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: this.width / 2,
            y: this.height / 2,
            deltaX: 0,
            deltaY: input.deltaY,
          });
        }
        return { text: '操作已执行。请用 snapshot 或 screenshot 核对实际结果。' };
      } catch (error) {
        return {
          text: redactBrowserText(error instanceof Error ? error.message : error),
          isError: true,
        };
      }
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.frameAckTimer) clearTimeout(this.frameAckTimer);
    this.frameAckTimer = undefined;
    this.agentAllowed = false;
    this.leaseGeneration++;
    this.recording = undefined;
    this.page?.close();
    try {
      await this.browser?.call('Browser.close');
    } catch {}
    this.browser?.close();
    if (this.process?.exitCode === null) this.process.kill('SIGTERM');
    this.page = undefined;
    this.browser = undefined;
    this.contextId = undefined;
    this.documentId = '';
    this.update({ status: 'stopped', loading: false, recording: false, inspecting: false });
  }
}
