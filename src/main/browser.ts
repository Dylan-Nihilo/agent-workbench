import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type {
  BrowserFrame,
  BrowserTab,
  ElementDetails,
  ElementQuery,
  ElementQueryResult,
  ElementEdit,
  ElementEditResult,
  ElementAnimation,
  BrowserInput,
  BrowserState,
  BrowserTool,
  ElementRef,
  RecordedStep,
  Recording,
  ToolResult,
} from '../shared/types';
import {
  ELEMENT_STYLE_PROPERTIES,
  ELEMENT_ANIMATION_PROPERTIES,
  ELEMENT_BACKGROUND_FUNCTIONS,
  ELEMENT_PREVIEW_LIMITS,
  ELEMENT_UNSAFE_CSS_PATTERN,
} from '../shared/types';
import { CdpConnection } from './browser-cdp';
import { browserPageSource } from './browser-page';
import { BrowserFrameSession, type BrowserChannel } from './browser-frame-session';

const execFileAsync = promisify(execFile);
const WORLD = 'workbench-browser-observer';
const PREVIEW_MAX_EDGE = 2048;
const PREVIEW_INTERVAL = 1000 / 24;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const editableStyles = new Set<string>(ELEMENT_STYLE_PROPERTIES);
const animatedStyles = new Set<string>(ELEMENT_ANIMATION_PROPERTIES);
const backgroundFunctions = new Set<string>(ELEMENT_BACKGROUND_FUNCTIONS);
const unsafeCss = new RegExp(ELEMENT_UNSAFE_CSS_PATTERN, 'i');

function validateStyles(
  value: unknown,
  properties: ReadonlySet<string>,
  allowEmpty: boolean,
): asserts value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('样式修改格式无效');
  const entries = Object.entries(value);
  if (entries.length > ELEMENT_PREVIEW_LIMITS.styleCount || (!allowEmpty && !entries.length))
    throw new Error('样式属性数量无效');
  for (const [name, item] of entries) {
    if (
      !properties.has(name) ||
      typeof item !== 'string' ||
      item.length > ELEMENT_PREVIEW_LIMITS.styleValueLength ||
      (!allowEmpty && !item.trim()) ||
      unsafeCss.test(item)
    )
      throw new Error(`不支持的 CSS 属性或值：${name}`);
    if (['background', 'background-image'].includes(name)) {
      const functions = [...item.matchAll(/([a-z][a-z0-9-]*)\s*\(/gi)].map((match) =>
        match[1].toLowerCase(),
      );
      if (functions.some((fn) => !backgroundFunctions.has(fn)))
        throw new Error('背景仅支持安全渐变、颜色和布局函数');
    }
  }
}

function validEasing(value: unknown): boolean {
  if (
    typeof value !== 'string' ||
    value.length > ELEMENT_PREVIEW_LIMITS.easingLength ||
    unsafeCss.test(value)
  )
    return false;
  const easing = value.trim().toLowerCase();
  if (
    ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'step-start', 'step-end'].includes(
      easing,
    )
  )
    return true;
  const curve = /^cubic-bezier\((.*)\)$/.exec(easing);
  if (curve) {
    const parts = curve[1].split(',').map((part) => part.trim());
    if (
      parts.length !== 4 ||
      parts.some((part) => !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(part))
    )
      return false;
    const numbers = parts.map(Number);
    return (
      numbers.every(Number.isFinite) &&
      numbers[0] >= 0 &&
      numbers[0] <= 1 &&
      numbers[2] >= 0 &&
      numbers[2] <= 1
    );
  }
  const steps =
    /^steps\(\s*(\d+)\s*(?:,\s*(start|end|jump-start|jump-end|jump-none|jump-both)\s*)?\)$/.exec(
      easing,
    );
  return (
    !!steps &&
    Number(steps[1]) >= (steps[2] === 'jump-none' ? 2 : 1) &&
    Number(steps[1]) <= ELEMENT_PREVIEW_LIMITS.stepsMax
  );
}

function validateAnimation(value: unknown): asserts value is ElementAnimation {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !['keyframes', 'duration', 'iterations', 'easing', 'direction'].includes(key),
    )
  )
    throw new Error('动画配置格式无效');
  const animation = value as ElementAnimation;
  if (
    !Array.isArray(animation.keyframes) ||
    animation.keyframes.length < ELEMENT_PREVIEW_LIMITS.keyframesMin ||
    animation.keyframes.length > ELEMENT_PREVIEW_LIMITS.keyframesMax
  )
    throw new Error('动画需要 2–12 个关键帧');
  if (
    !Number.isFinite(animation.duration) ||
    animation.duration < ELEMENT_PREVIEW_LIMITS.durationMin ||
    animation.duration > ELEMENT_PREVIEW_LIMITS.durationMax
  )
    throw new Error('动画时长必须为 100–60000 毫秒');
  if (
    animation.iterations !== undefined &&
    animation.iterations !== 'infinite' &&
    (!Number.isFinite(animation.iterations) ||
      animation.iterations < 1 ||
      animation.iterations > ELEMENT_PREVIEW_LIMITS.iterationsMax)
  )
    throw new Error('动画次数必须为 1–100 或 infinite');
  if (animation.easing !== undefined && !validEasing(animation.easing))
    throw new Error('动画 easing 无效');
  if (
    animation.direction !== undefined &&
    !['normal', 'reverse', 'alternate', 'alternate-reverse'].includes(animation.direction)
  )
    throw new Error('动画方向无效');
  let previous = 0;
  for (const frame of animation.keyframes) {
    if (
      !frame ||
      typeof frame !== 'object' ||
      Array.isArray(frame) ||
      Object.keys(frame).some((key) => !['offset', 'styles'].includes(key))
    )
      throw new Error('动画关键帧格式无效');
    if (frame.offset !== undefined) {
      if (!Number.isFinite(frame.offset) || frame.offset < previous || frame.offset > 1)
        throw new Error('动画 offset 必须在 0–1 之间且非递减');
      previous = frame.offset;
    }
    validateStyles(frame.styles, animatedStyles, false);
  }
}

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

export function redactBrowserText(value: unknown, limit = 2000): string {
  return String(value ?? '')
    .replace(/Bearer\s+\S+/gi, 'Bearer [hidden]')
    .replace(/(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, '[hidden]')
    .replace(/((?:password|secret|token|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[hidden]')
    .slice(0, limit);
}

function recordedEditValue(value: string): string {
  try {
    const input = JSON.parse(value);
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('Invalid edit');
    const output: Record<string, unknown> = {};
    let truncated = false;
    if (typeof input.text === 'string') {
      output.text = redactBrowserText(input.text, 20_000);
      truncated ||= input.text.length > 20_000;
    }
    if (input.styles && typeof input.styles === 'object' && !Array.isArray(input.styles)) {
      const entries = Object.entries(input.styles);
      output.styles = Object.fromEntries(
        entries.slice(0, 30).map(([key, item]) => {
          const text = typeof item === 'string' ? item : '[invalid style]';
          truncated ||= key.length > 100 || text.length > 500;
          return [redactBrowserText(key, 100), redactBrowserText(text, 500)];
        }),
      );
      truncated ||= entries.length > 30;
    }
    if (typeof input.editId === 'string') output.editId = redactBrowserText(input.editId, 1500);
    if (input.animation === null) output.animation = null;
    else if (input.animation !== undefined) {
      validateAnimation(input.animation);
      const animation = input.animation as ElementAnimation;
      output.animation = {
        ...animation,
        keyframes: animation.keyframes.map((frame) => ({
          ...frame,
          styles: Object.fromEntries(
            Object.entries(frame.styles).map(([key, item]) => [
              key,
              redactBrowserText(item, ELEMENT_PREVIEW_LIMITS.styleValueLength),
            ]),
          ),
        })),
      };
    }
    if (truncated) output.truncated = true;
    return JSON.stringify(output);
  } catch {
    return JSON.stringify({ unavailable: true, reason: 'Invalid edit payload' });
  }
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

interface FrameContext {
  id: string;
  parentId?: string;
  url: string;
  channel: BrowserChannel;
  revision: number;
  contextId?: number;
  documentId?: string;
  source?: 'human' | 'agent';
}
interface TabSession {
  info: BrowserTab;
  page: CdpConnection;
  mainFrameId: string;
  frames: Map<string, FrameContext>;
  channels: Set<BrowserChannel>;
  children: Set<BrowserFrameSession>;
  pendingFrames: Set<Promise<void>>;
  activation: number;
  source: 'human' | 'agent';
  diagnostics: Array<{ time: number; kind: string; text: string }>;
  edits: Array<{
    id: string;
    frameId: string;
    documentId: string;
    localId: string;
    localRef?: string;
    changes?: ElementEdit;
  }>;
}
interface ScopedElement {
  tabId: string;
  activation: number;
  frameId: string;
  revision: number;
  documentId: string;
  localRef: string;
}
interface FrameGeometry {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}
interface PreparedContext {
  channel: BrowserChannel;
  contextId: number;
  revision: number;
}

/** One BrowserHost owns all neo targets and grants input only to the visible tab. */
export class BrowserRuntime {
  private state: BrowserState = {
    status: 'missing',
    engine: 'browseros',
    tabs: [],
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
  private endpoint = '';
  private tabs = new Map<string, TabSession>();
  private attaching = new Map<string, Promise<TabSession>>();
  private activeTabId = '';
  private refs = new Map<string, ScopedElement>();
  private width = 1100;
  private height = 760;
  private frameAckTimer?: ReturnType<typeof setTimeout>;
  private starting?: Promise<void>;
  private disposed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private leaseGeneration = 0;
  private agentAllowed = true;
  private suppressMouseUp = false;
  private pointerMove?: Promise<void>;
  private latestMove?: Extract<BrowserInput, { type: 'mouse' }>;
  private hoverEpoch = 0;
  private workingFeedback?: ScopedElement & { ref: string };
  private recording?: Recording;

  constructor(private options: BrowserOptions) {}

  listTabs(): BrowserTab[] {
    return [...this.tabs.values()].map((tab) => ({ ...tab.info }));
  }
  getState(): BrowserState {
    const tab = this.tabs.get(this.activeTabId);
    return structuredClone({
      ...this.state,
      ...(tab?.info ?? {}),
      tabs: this.listTabs(),
      activeTabId: tab?.info.id,
      previewEdits:
        tab?.edits.flatMap((edit) => {
          const frame = tab.frames.get(edit.frameId);
          return edit.localRef && edit.changes && frame?.documentId === edit.documentId
            ? [
                {
                  editId: edit.id,
                  tabId: tab.info.id,
                  frameId: edit.frameId,
                  documentId: edit.documentId,
                  nodeId: edit.localRef,
                  changes: edit.changes,
                },
              ]
            : [];
        }) ?? [],
    });
  }
  private update(patch: Partial<BrowserState> = {}): void {
    this.state = { ...this.state, ...patch };
    this.options.onState(this.getState());
  }
  private updateTab(tab: TabSession, patch: Partial<BrowserTab>): void {
    if (this.tabs.get(tab.info.id) !== tab) return;
    Object.assign(tab.info, patch);
    this.update();
  }
  private log(tab: TabSession | undefined, kind: string, text: unknown): void {
    if (!tab) return;
    tab.diagnostics.push({ time: Date.now(), kind, text: redactBrowserText(text) });
    if (tab.diagnostics.length > 150) tab.diagnostics.shift();
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }
  private activeTab(): TabSession {
    const tab = this.tabs.get(this.activeTabId);
    if (!tab || this.state.status !== 'ready') throw new Error('BrowserOS neo 尚未就绪');
    return tab;
  }
  private async until<T>(
    check: () => Promise<T | undefined | false>,
    timeout = 10_000,
  ): Promise<T> {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = await check();
      if (value) return value as T;
      await wait(50);
    }
    throw new Error('等待浏览器响应超时');
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
        error: '未找到 BrowserOS neo。请安装官方 neo，或指定其应用路径。',
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
    let failure: Error | undefined;
    let endpoint = '';
    child.stderr?.on('data', (data) => {
      const match = data
        .toString()
        .match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/);
      if (match) endpoint = match[1];
    });
    child.on('error', (error) => {
      failure = error;
    });
    child.on('exit', () => {
      if (!this.disposed && this.process === child)
        this.update({
          status: 'error',
          loading: false,
          error: 'BrowserOS neo 已退出，请重新启动。',
        });
    });
    try {
      this.endpoint = await this.until(async () => {
        if (failure) throw failure;
        if (child.exitCode !== null) throw new Error('BrowserOS neo 启动失败');
        return endpoint || undefined;
      }, 20_000);
      this.browser = await CdpConnection.connect(this.endpoint);
      this.browser.on('Target.targetCreated', (p) => {
        void this.handleTarget(p.targetInfo);
      });
      this.browser.on('Target.targetInfoChanged', (p) => {
        void this.handleTarget(p.targetInfo);
      });
      this.browser.on('Target.targetDestroyed', (p) => {
        void this.removeTarget(p.targetId);
      });
      const { targetInfos } = await this.browser.call('Target.getTargets');
      const first = targetInfos.find((item: any) => item.type === 'page');
      if (!first) throw new Error('BrowserOS neo 没有创建可用页面');
      const tab = await this.attachTab(first);
      await this.activateTab(tab, 'human', false);
      await this.browser.call('Target.setDiscoverTargets', { discover: true });
      if (initial !== undefined) {
        this.updateTab(tab, { url: initial, loading: true });
        const result = await tab.page.call('Page.navigate', { url: initial });
        if (result.errorText) throw new Error(result.errorText);
        await this.refreshTab(tab);
      }
      this.update({ status: 'ready', error: undefined });
    } catch (error) {
      const message = redactBrowserText(error instanceof Error ? error.message : error);
      await this.dispose();
      this.update({ status: 'error', loading: false, error: message });
      throw new Error(message);
    }
  }

  private async handleTarget(info: any): Promise<void> {
    if (this.disposed || info.type !== 'page') return;
    const existing = this.tabs.get(info.targetId);
    if (existing) {
      this.updateTab(existing, {
        title: info.title || existing.info.title,
        url: info.url || existing.info.url,
      });
      return;
    }
    try {
      await this.attachTab(info);
    } catch (error) {
      this.log(
        this.tabs.get(this.activeTabId),
        'tab.error',
        error instanceof Error ? error.message : error,
      );
    }
  }
  private attachTab(info: any): Promise<TabSession> {
    const pending = this.attaching.get(info.targetId);
    if (pending) return pending;
    const existing = this.tabs.get(info.targetId);
    if (existing) return Promise.resolve(existing);
    const task = this.attachTabInternal(info).finally(() => this.attaching.delete(info.targetId));
    this.attaching.set(info.targetId, task);
    return task;
  }
  private async attachTabInternal(info: any): Promise<TabSession> {
    const host = new URL(this.endpoint).host;
    const target = await this.until(async () => {
      const all = (await (await fetch(`http://${host}/json/list`)).json()) as any[];
      return all.find((item) => item.id === info.targetId && item.webSocketDebuggerUrl);
    });
    const page = await CdpConnection.connect(target.webSocketDebuggerUrl);
    const tab: TabSession = {
      info: {
        id: info.targetId,
        title: info.title || '新标签页',
        url: info.url || 'about:blank',
        loading: false,
        canGoBack: false,
        canGoForward: false,
      },
      page,
      mainFrameId: '',
      frames: new Map(),
      channels: new Set(),
      children: new Set(),
      pendingFrames: new Set(),
      activation: 0,
      source: 'human',
      diagnostics: [],
      edits: [],
    };
    this.tabs.set(tab.info.id, tab);
    try {
      await this.installChannel(tab, page, true);
      page.on('Page.screencastFrame', (p) => {
        if (this.disposed || this.activeTabId !== tab.info.id) {
          void page.call('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
          return;
        }
        this.options.onFrame({
          data: `data:image/jpeg;base64,${p.data}`,
          width: p.metadata.deviceWidth || this.width,
          height: p.metadata.deviceHeight || this.height,
          tabId: tab.info.id,
        });
        this.frameAckTimer = setTimeout(() => {
          this.frameAckTimer = undefined;
          void page.call('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
        }, PREVIEW_INTERVAL);
      });
      page.on('connection:closed', () => {
        if (!this.disposed && this.tabs.get(tab.info.id) === tab)
          void this.removeTarget(tab.info.id);
      });
      await page.call('Emulation.setDeviceMetricsOverride', {
        width: this.width,
        height: this.height,
        deviceScaleFactor: 2,
        mobile: false,
      });
      await this.refreshTab(tab);
      this.update();
      return tab;
    } catch (error) {
      this.tabs.delete(tab.info.id);
      page.close();
      throw error;
    }
  }
  private registerFrame(
    tab: TabSession,
    frame: any,
    channel: BrowserChannel,
    parentId?: string,
  ): FrameContext {
    let entry = tab.frames.get(frame.id);
    if (!entry) {
      entry = {
        id: frame.id,
        parentId: frame.parentId || parentId,
        url: frame.url || '',
        channel,
        revision: 0,
      };
      tab.frames.set(frame.id, entry);
    } else {
      entry.url = frame.url || entry.url;
      if (frame.parentId || parentId) entry.parentId = frame.parentId || parentId;
      if (
        entry.channel !== channel &&
        (channel !== tab.page || !tab.children.has(entry.channel as BrowserFrameSession))
      ) {
        this.invalidateFrame(tab, entry);
        entry.channel = channel;
      }
    }
    return entry;
  }
  private invalidateFrame(tab: TabSession, frame: FrameContext): void {
    frame.revision++;
    frame.contextId = undefined;
    frame.documentId = undefined;
    frame.source = undefined;
    for (const [ref, scope] of this.refs)
      if (scope.tabId === tab.info.id && scope.frameId === frame.id) this.refs.delete(ref);
    const editCount = tab.edits.length;
    tab.edits = tab.edits.filter((edit) => edit.frameId !== frame.id);
    if (this.activeTabId === tab.info.id && this.state.selectedElement?.frameId === frame.id)
      this.update({ selectedElement: undefined });
    else if (this.activeTabId === tab.info.id && tab.edits.length !== editCount) this.update();
  }
  private async installChannel(
    tab: TabSession,
    channel: BrowserChannel,
    root = false,
  ): Promise<void> {
    if (tab.channels.has(channel)) return;
    tab.channels.add(channel);
    const contexts = new Map<number, string>();
    const children = new Map<string, BrowserFrameSession>();
    channel.on('Runtime.executionContextCreated', (p) => {
      const c = p.context;
      if (c.name === WORLD && c.auxData?.frameId) {
        contexts.set(c.id, c.auxData.frameId);
        const f = tab.frames.get(c.auxData.frameId);
        if (f?.channel === channel) f.contextId = c.id;
      }
    });
    channel.on('Runtime.executionContextDestroyed', (p) => {
      const frame = tab.frames.get(contexts.get(p.executionContextId) || '');
      if (frame?.channel === channel && frame.contextId === p.executionContextId)
        frame.contextId = undefined;
      contexts.delete(p.executionContextId);
    });
    channel.on('Runtime.executionContextsCleared', () => {
      for (const frame of tab.frames.values())
        if (frame.channel === channel) frame.contextId = undefined;
      contexts.clear();
    });
    channel.on('Runtime.bindingCalled', (p) => {
      if (
        this.disposed ||
        this.tabs.get(tab.info.id) !== tab ||
        p.name !== '__workbenchEvent' ||
        typeof p.payload !== 'string' ||
        p.payload.length > 256_000
      )
        return;
      const frameId =
        contexts.get(p.executionContextId) ||
        [...tab.frames.values()].find(
          (f) => f.channel === channel && f.contextId === p.executionContextId,
        )?.id;
      const frame = frameId && tab.frames.get(frameId);
      if (!frame || frame.channel !== channel) return;
      try {
        const payload = JSON.parse(p.payload);
        if (payload.kind === 'hover-frame') {
          if (
            !this.state.inspecting ||
            this.activeTabId !== tab.info.id ||
            frame.documentId !== payload.docId
          )
            return;
          for (const other of tab.frames.values()) {
            if (other.id === frame.id || !other.contextId) continue;
            void other.channel
              .call('Runtime.evaluate', {
                expression: 'globalThis.__workbenchPage?.leave()',
                contextId: other.contextId,
              })
              .catch(() => {});
          }
          return;
        }
        this.recordEvent(tab, frame, payload);
      } catch {}
    });
    channel.on('Page.frameNavigated', (p) => {
      const frame = this.registerFrame(tab, p.frame, channel);
      this.invalidateFrame(tab, frame);
      if (root && !p.frame.parentId) {
        tab.mainFrameId = frame.id;
        tab.activation++;
        tab.edits = [];
        this.clearTabRefs(tab);
        if (this.activeTabId === tab.info.id)
          this.update({ selectedElement: undefined, inspecting: false });
        this.updateTab(tab, { url: frame.url });
      }
      this.appendStep({
        kind: 'navigate',
        description: `打开 ${evidenceUrl(frame.url)}`,
        url: evidenceUrl(frame.url),
        source: tab.source,
        tabId: tab.info.id,
        frameId: frame.id,
      });
      if (root && !p.frame.parentId) void this.refreshTab(tab);
      else if (this.activeTabId === tab.info.id && this.state.inspecting)
        void this.prepareFrame(tab, frame).catch(() => {});
    });
    channel.on('Page.frameDetached', (p) => {
      if (p.reason === 'swap') return;
      const frame = tab.frames.get(p.frameId);
      if (frame) {
        this.invalidateFrame(tab, frame);
        tab.frames.delete(frame.id);
      }
    });
    channel.on('Page.navigatedWithinDocument', (p) => {
      const frame = tab.frames.get(p.frameId);
      if (frame) frame.url = p.url;
      if (p.frameId === tab.mainFrameId) {
        this.updateTab(tab, { url: p.url });
        void this.refreshTab(tab);
      }
    });
    channel.on('Page.frameStartedLoading', (p) => {
      if (p.frameId === tab.mainFrameId) this.updateTab(tab, { loading: true });
    });
    channel.on('Page.frameStoppedLoading', (p) => {
      if (p.frameId === tab.mainFrameId) {
        this.updateTab(tab, { loading: false });
        void this.refreshTab(tab);
      }
    });
    channel.on('Runtime.consoleAPICalled', (p) =>
      this.log(
        tab,
        `console.${p.type}`,
        p.args.map((arg: any) => arg.value ?? arg.description ?? '').join(' '),
      ),
    );
    channel.on('Runtime.exceptionThrown', (p) =>
      this.log(
        tab,
        'exception',
        p.exceptionDetails.exception?.description || p.exceptionDetails.text,
      ),
    );
    channel.on('Network.responseReceived', (p) =>
      this.log(tab, 'network', `${p.response.status} ${evidenceUrl(p.response.url)}`),
    );
    channel.on('Network.loadingFailed', (p) => this.log(tab, 'network.error', p.errorText));
    channel.on('Page.javascriptDialogOpening', () => {
      this.log(tab, 'dialog', '页面弹窗已关闭；请在页面控件中完成交互。');
      void channel.call('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
    });
    channel.on('Fetch.requestPaused', (p) => {
      let allowed = p.request.url === 'about:blank';
      try {
        normalizeBrowserUrl(p.request.url);
        allowed = true;
      } catch {}
      void channel
        .call(
          allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest',
          allowed
            ? { requestId: p.requestId }
            : { requestId: p.requestId, errorReason: 'BlockedByClient' },
        )
        .catch(() => {});
      if (!allowed) this.log(tab, 'navigation.blocked', '阻止了非 HTTP(S) 页面导航');
    });
    channel.on('Target.receivedMessageFromTarget', (p) =>
      children.get(p.sessionId)?.receive(p.message),
    );
    channel.on('Target.detachedFromTarget', (p) => {
      const child = children.get(p.sessionId);
      if (!child) return;
      child.close();
      children.delete(p.sessionId);
      tab.children.delete(child);
      tab.channels.delete(child);
      for (const frame of tab.frames.values())
        if (frame.channel === child) {
          this.invalidateFrame(tab, frame);
          tab.frames.delete(frame.id);
        }
    });
    channel.on('Target.attachedToTarget', (p) => {
      if (p.targetInfo.type !== 'iframe') {
        void channel.call('Target.detachFromTarget', { sessionId: p.sessionId }).catch(() => {});
        return;
      }
      const child = new BrowserFrameSession(channel, p.sessionId);
      children.set(p.sessionId, child);
      tab.children.add(child);
      const setup = this.installChannel(tab, child)
        .catch((error) =>
          this.log(tab, 'frame.error', error instanceof Error ? error.message : error),
        )
        .finally(() => tab.pendingFrames.delete(setup));
      tab.pendingFrames.add(setup);
    });
    await channel.call('Page.enable');
    await channel.call('DOM.enable');
    const tree = await channel.call('Page.getFrameTree');
    const walk = (node: any, parentId?: string) => {
      this.registerFrame(tab, node.frame, channel, parentId);
      for (const child of node.childFrames || []) walk(child, node.frame.id);
    };
    walk(tree.frameTree);
    if (root) tab.mainFrameId = tree.frameTree.frame.id;
    await channel.call('Runtime.enable');
    await channel.call('Network.enable');
    await channel.call('Runtime.addBinding', {
      name: '__workbenchEvent',
      executionContextName: WORLD,
    });
    await channel.call('Page.addScriptToEvaluateOnNewDocument', {
      source: browserPageSource,
      worldName: WORLD,
    });
    await channel.call('Fetch.enable', {
      patterns: [{ resourceType: 'Document', requestStage: 'Request' }],
    });
    await channel.call('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: false,
      filter: [{ type: 'iframe', exclude: false }, { exclude: true }],
    });
    for (const frame of tab.frames.values())
      if (frame.channel === channel) await this.prepareFrame(tab, frame).catch(() => {});
  }
  private async collectFrames(tab: TabSession): Promise<FrameContext[]> {
    if (tab.pendingFrames.size) await Promise.allSettled([...tab.pendingFrames]);
    const tree = await tab.page.call('Page.getFrameTree');
    const present = new Set<string>();
    const walk = (node: any, parentId?: string) => {
      present.add(node.frame.id);
      this.registerFrame(tab, node.frame, tab.page, parentId);
      for (const child of node.childFrames || []) walk(child, node.frame.id);
    };
    walk(tree.frameTree);
    tab.mainFrameId = tree.frameTree.frame.id;
    // OOPIF children may be reported only by their own target's frame tree.
    return [...tab.frames.values()].filter(
      (frame) => present.has(frame.id) || frame.channel !== tab.page,
    );
  }
  private async prepareFrame(tab: TabSession, frame: FrameContext): Promise<PreparedContext> {
    if (this.disposed || this.tabs.get(tab.info.id) !== tab) throw new Error('页面已关闭');
    for (let attempt = 0; attempt < 3; attempt++) {
      const channel = frame.channel;
      let revision = frame.revision;
      const assertOwner = () => {
        if (tab.frames.get(frame.id) !== frame) throw new Error('元素所在 iframe 已移除');
        if (frame.channel !== channel || frame.revision !== revision)
          throw new Error('Frame context changed during preparation');
      };
      try {
        assertOwner();
        // A world survives many bridge calls; its document identity still needs validation.
        const contextId =
          frame.contextId ??
          ((
            await channel.call('Page.createIsolatedWorld', {
              frameId: frame.id,
              worldName: WORLD,
            })
          ).executionContextId as number);
        assertOwner();
        const ready = await channel.call('Runtime.evaluate', {
          expression:
            '({ready:typeof globalThis.__workbenchPage === "object" && typeof globalThis.__workbenchEvent === "function",documentId:globalThis.__workbenchPage?.docId})',
          contextId,
          returnByValue: true,
        });
        assertOwner();
        if (ready.exceptionDetails) throw new Error(ready.exceptionDetails.text);
        let documentId = ready.result.value?.documentId;
        if (!ready.result.value?.ready) {
          await channel.call('Runtime.addBinding', {
            name: '__workbenchEvent',
            executionContextId: contextId,
          });
          assertOwner();
          const installed = await channel.call('Runtime.evaluate', {
            expression: `${browserPageSource}\nglobalThis.__workbenchPage.docId`,
            contextId,
            returnByValue: true,
          });
          assertOwner();
          if (installed.exceptionDetails)
            throw new Error(
              installed.exceptionDetails.exception?.description || installed.exceptionDetails.text,
            );
          documentId = installed.result.value;
        }
        if (typeof documentId !== 'string' || !documentId) throw new Error('页面框架身份无效');
        const newDocument = frame.documentId !== documentId;
        if (frame.documentId && frame.documentId !== documentId) {
          this.invalidateFrame(tab, frame);
          revision = frame.revision;
        }
        frame.documentId = documentId;
        frame.contextId = contextId;
        if (newDocument)
          await channel.call('Runtime.evaluate', {
            expression: `globalThis.__workbenchPage.setInspect(${this.activeTabId === tab.info.id && this.state.inspecting})`,
            contextId,
          });
        assertOwner();
        return { contextId, channel, revision };
      } catch (error) {
        if (frame.channel === channel && frame.revision === revision) frame.contextId = undefined;
        const message = error instanceof Error ? error.message : String(error);
        if (
          attempt === 2 ||
          !/Cannot find (?:context|execution context)|Execution context was destroyed|No frame with given id|No frame for given id|Frame context changed during preparation/i.test(
            message,
          )
        )
          throw error;
        await wait(25);
      }
    }
    throw new Error('无法连接页面框架');
  }
  private assertPreparedContext(
    tab: TabSession,
    frame: FrameContext,
    prepared: PreparedContext,
  ): void {
    if (
      tab.frames.get(frame.id) !== frame ||
      frame.channel !== prepared.channel ||
      frame.revision !== prepared.revision ||
      frame.contextId !== prepared.contextId
    )
      throw new Error('页面框架已改变，请重新获取元素。');
  }
  private async bridge<T = any>(
    tab: TabSession,
    frame: FrameContext,
    expression: string,
    guard?: () => void,
  ): Promise<T> {
    const prepared = await this.prepareFrame(tab, frame);
    guard?.();
    this.assertPreparedContext(tab, frame, prepared);
    const result = await prepared.channel.call('Runtime.evaluate', {
      expression,
      contextId: prepared.contextId,
      returnByValue: true,
      awaitPromise: true,
    });
    this.assertPreparedContext(tab, frame, prepared);
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description || result.exceptionDetails.text,
      );
    return result.result.value as T;
  }
  private mainFrame(tab: TabSession): FrameContext {
    const frame = tab.frames.get(tab.mainFrameId);
    if (!frame) throw new Error('页面框架尚未就绪');
    return frame;
  }
  private async refreshTab(tab: TabSession): Promise<void> {
    try {
      const result = await tab.page.call('Runtime.evaluate', {
        expression: '({title:document.title,url:location.href})',
        returnByValue: true,
      });
      const history = await tab.page.call('Page.getNavigationHistory');
      if (result.result.value)
        this.updateTab(tab, {
          title: result.result.value.title,
          url: result.result.value.url,
          canGoBack: history.currentIndex > 0,
          canGoForward: history.currentIndex < history.entries.length - 1,
        });
    } catch {}
  }
  private async startScreencast(tab: TabSession): Promise<void> {
    await tab.page.call('Page.startScreencast', {
      format: 'jpeg',
      quality: 88,
      maxWidth: PREVIEW_MAX_EDGE,
      maxHeight: PREVIEW_MAX_EDGE,
      everyNthFrame: 1,
      maxFramesInFlight: 1,
      sendLastFrame: true,
    });
  }
  private clearTabRefs(tab: TabSession): void {
    for (const [ref, scope] of this.refs) if (scope.tabId === tab.info.id) this.refs.delete(ref);
  }
  private async clearOutline(tab: TabSession): Promise<void> {
    for (const frame of tab.frames.values())
      await this.bridge(tab, frame, 'globalThis.__workbenchPage.clearOverlays()').catch(() => {});
  }
  private async activateTab(
    tab: TabSession,
    source: 'human' | 'agent',
    record = true,
  ): Promise<void> {
    if (this.activeTabId === tab.info.id) return;
    const previous = this.tabs.get(this.activeTabId);
    if (this.frameAckTimer) clearTimeout(this.frameAckTimer);
    this.frameAckTimer = undefined;
    if (previous) {
      await previous.page.call('Page.stopScreencast').catch(() => {});
      await previous.page
        .call('Emulation.setFocusEmulationEnabled', { enabled: false })
        .catch(() => {});
      await this.clearOutline(previous);
      previous.activation++;
      this.clearTabRefs(previous);
    }
    this.activeTabId = tab.info.id;
    tab.activation++;
    tab.source = source;
    this.clearTabRefs(tab);
    this.suppressMouseUp = false;
    this.update({ selectedElement: undefined, inspecting: false });
    this.options.onFrame({ data: '', width: this.width, height: this.height, tabId: tab.info.id });
    await tab.page.call('Emulation.setDeviceMetricsOverride', {
      width: this.width,
      height: this.height,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await tab.page.call('Page.bringToFront');
    // Headless neo can leave a restored native tab hidden; the embedded active page must keep rendering.
    await tab.page.call('Emulation.setFocusEmulationEnabled', { enabled: true });
    await this.startScreencast(tab);
    await this.refreshTab(tab);
    if (record)
      this.appendStep({
        kind: 'navigate',
        description: `切换页面：${tab.info.title || evidenceUrl(tab.info.url)}`,
        url: evidenceUrl(tab.info.url),
        source,
        tabId: tab.info.id,
        frameId: tab.mainFrameId,
      });
  }
  allowAgentControl(): void {
    this.agentAllowed = true;
  }
  revokeAgentControl(): void {
    this.leaseGeneration++;
    this.agentAllowed = false;
  }
  private humanTakeover(source: string): void {
    this.revokeAgentControl();
    this.log(this.tabs.get(this.activeTabId), 'control', `Human takeover: ${source}`);
    this.options.onHumanTakeover();
  }
  newTab(url?: string): Promise<BrowserTab> {
    const initial = url === undefined ? 'about:blank' : normalizeBrowserUrl(url);
    this.humanTakeover('new-tab');
    return this.serialize(() => this.createTab(initial, 'human'));
  }
  private async createTab(
    url: string,
    source: 'human' | 'agent',
    guard?: () => void,
  ): Promise<BrowserTab> {
    if (!this.browser || this.state.status !== 'ready') throw new Error('浏览器尚未就绪');
    guard?.();
    const result = await this.browser.call('Target.createTarget', {
      url: 'about:blank',
      newWindow: false,
    });
    const tab = await this.attachTab({
      targetId: result.targetId,
      type: 'page',
      url: 'about:blank',
      title: '新标签页',
    });
    guard?.();
    await this.activateTab(tab, source);
    if (url !== 'about:blank') await this.navigateInternal(tab, url, source);
    return { ...tab.info };
  }
  switchTab(id: string): Promise<void> {
    if (!this.tabs.has(id)) return Promise.reject(new Error('标签页不存在'));
    this.humanTakeover('switch-tab');
    return this.serialize(async () => {
      const tab = this.attaching.has(id) ? await this.attaching.get(id) : this.tabs.get(id);
      if (!tab) throw new Error('标签页已关闭');
      if (id === this.activeTabId) return;
      await this.activateTab(tab, 'human');
    });
  }
  closeTab(id: string): Promise<void> {
    if (!this.tabs.has(id)) return Promise.reject(new Error('标签页不存在'));
    this.humanTakeover('close-tab');
    return this.serialize(() => this.closeTabInternal(id, 'human'));
  }
  private async closeTabInternal(id: string, source: 'human' | 'agent'): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error('标签页已关闭');
    if (this.tabs.size === 1) await this.createTab('about:blank', source);
    else if (this.activeTabId === id)
      await this.activateTab(
        [...this.tabs.values()].find((other) => other !== tab)!,
        source,
      );
    this.tabs.delete(id);
    this.clearTabRefs(tab);
    for (const child of tab.children) child.close();
    tab.page.close();
    await this.browser!.call('Target.closeTarget', { targetId: id });
    this.update();
  }
  private async removeTarget(id: string): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const wasActive = this.activeTabId === id;
    this.tabs.delete(id);
    this.clearTabRefs(tab);
    for (const child of tab.children) child.close();
    tab.page.close();
    if (this.disposed) return;
    if (wasActive) {
      this.activeTabId = '';
      this.update({ selectedElement: undefined, inspecting: false });
      void this.serialize(async () => {
        const next = this.tabs.values().next().value as TabSession | undefined;
        if (next) await this.activateTab(next, 'agent');
        else if (this.state.status === 'ready') await this.createTab('about:blank', 'agent');
      }).catch((error) => this.update({ error: redactBrowserText(error) }));
    }
    this.update();
  }

  private requireActive(id: string): TabSession {
    const tab = this.activeTab();
    if (tab.info.id !== id) throw new Error('活动标签页已改变，请重新获取当前页面。');
    return tab;
  }
  private async setSource(
    tab: TabSession,
    source: 'human' | 'agent',
    only?: FrameContext,
  ): Promise<void> {
    tab.source = source;
    for (const frame of only ? [only] : await this.collectFrames(tab)) {
      if (frame.source === source) continue;
      await this.bridge(
        tab,
        frame,
        `globalThis.__workbenchPage.setSource(${JSON.stringify(source)})`,
      );
      frame.source = source;
    }
  }
  navigate(url: string): Promise<void> {
    const target = normalizeBrowserUrl(url);
    const tab = this.activeTab();
    this.humanTakeover('navigate');
    return this.serialize(() =>
      this.navigateInternal(this.requireActive(tab.info.id), target, 'human'),
    );
  }
  private async navigateInternal(
    tab: TabSession,
    url: string,
    source: 'human' | 'agent',
  ): Promise<void> {
    tab.source = source;
    tab.activation++;
    this.clearTabRefs(tab);
    tab.edits = [];
    if (this.activeTabId === tab.info.id)
      this.update({ inspecting: false, selectedElement: undefined });
    this.updateTab(tab, { loading: true });
    const result = await tab.page.call('Page.navigate', { url: normalizeBrowserUrl(url) });
    if (result.errorText) {
      this.updateTab(tab, { loading: false });
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
    const id = this.activeTab().info.id;
    this.humanTakeover(direction < 0 ? 'back' : 'forward');
    return this.serialize(async () => {
      const tab = this.requireActive(id);
      tab.source = 'human';
      const h = await tab.page.call('Page.getNavigationHistory');
      const entry = h.entries[h.currentIndex + direction];
      if (entry) {
        tab.activation++;
        this.clearTabRefs(tab);
        await tab.page.call('Page.navigateToHistoryEntry', { entryId: entry.id });
      }
    });
  }
  reload(): Promise<void> {
    const id = this.activeTab().info.id;
    this.humanTakeover('reload');
    return this.serialize(async () => {
      const tab = this.requireActive(id);
      tab.activation++;
      tab.source = 'human';
      this.clearTabRefs(tab);
      await tab.page.call('Page.reload');
    });
  }
  resize(width: number, height: number): Promise<void> {
    if (!Number.isFinite(width) || !Number.isFinite(height))
      return Promise.reject(new Error('Invalid browser viewport'));
    const w = Math.round(Math.min(1920, Math.max(320, width))),
      h = Math.round(Math.min(1400, Math.max(100, height)));
    if (w === this.width && h === this.height) return Promise.resolve();
    this.width = w;
    this.height = h;
    if (this.state.status !== 'ready') return Promise.resolve();
    return this.serialize(async () => {
      const tab = this.activeTab();
      if (this.frameAckTimer) clearTimeout(this.frameAckTimer);
      this.frameAckTimer = undefined;
      await tab.page.call('Page.stopScreencast');
      await tab.page.call('Emulation.setDeviceMetricsOverride', {
        width: w,
        height: h,
        deviceScaleFactor: 2,
        mobile: false,
      });
      await this.startScreencast(tab);
    });
  }

  private async geometry(tab: TabSession, frame: FrameContext): Promise<FrameGeometry> {
    if (frame.id === tab.mainFrameId) return { x: 0, y: 0, scaleX: 1, scaleY: 1 };
    const parent = frame.parentId && tab.frames.get(frame.parentId);
    if (!parent) throw new Error('无法定位此 iframe 的父页面');
    const base = await this.geometry(tab, parent);
    const prepared = await this.prepareFrame(tab, parent);
    this.assertPreparedContext(tab, parent, prepared);
    const owner = await prepared.channel.call('DOM.getFrameOwner', { frameId: frame.id });
    this.assertPreparedContext(tab, parent, prepared);
    const node = await prepared.channel.call('DOM.resolveNode', {
      backendNodeId: owner.backendNodeId,
      executionContextId: prepared.contextId,
    });
    if (!node.object.objectId) throw new Error('无法定位 iframe 元素');
    try {
      this.assertPreparedContext(tab, parent, prepared);
      const result = await prepared.channel.call('Runtime.callFunctionOn', {
        objectId: node.object.objectId,
        functionDeclaration:
          'function(){const r=this.getBoundingClientRect();const t=getComputedStyle(this).transform;if(t!=="none"){const m=new DOMMatrix(t);if(!m.is2D||Math.abs(m.b)>0.0001||Math.abs(m.c)>0.0001)throw new Error("Rotated or 3D iframe coordinates are not supported");}const sx=r.width/this.offsetWidth,sy=r.height/this.offsetHeight;return{x:r.x+this.clientLeft*sx,y:r.y+this.clientTop*sy,scaleX:sx,scaleY:sy};}',
        returnByValue: true,
      });
      this.assertPreparedContext(tab, parent, prepared);
      if (result.exceptionDetails)
        throw new Error(
          result.exceptionDetails.exception?.description || result.exceptionDetails.text,
        );
      const box = result.result.value;
      if (!box || !Number.isFinite(box.scaleX) || !box.scaleX || !box.scaleY)
        throw new Error('iframe 当前不可见');
      return {
        x: base.x + box.x * base.scaleX,
        y: base.y + box.y * base.scaleY,
        scaleX: base.scaleX * box.scaleX,
        scaleY: base.scaleY * box.scaleY,
      };
    } finally {
      await prepared.channel
        .call('Runtime.releaseObject', { objectId: node.object.objectId })
        .catch(() => {});
    }
  }
  private async revealFrame(
    tab: TabSession,
    frame: FrameContext,
    guard?: () => void,
  ): Promise<void> {
    if (frame.id === tab.mainFrameId) return;
    const parent = frame.parentId && tab.frames.get(frame.parentId);
    if (!parent) throw new Error('无法定位此 iframe 的父页面');
    await this.revealFrame(tab, parent, guard);
    const owner = await parent.channel.call('DOM.getFrameOwner', { frameId: frame.id });
    guard?.();
    await parent.channel.call('DOM.scrollIntoViewIfNeeded', { backendNodeId: owner.backendNodeId });
  }
  private async inputPoint(
    tab: TabSession,
    frame: FrameContext,
    localRef: string,
    guard: () => void,
  ): Promise<{ x: number; y: number }> {
    await this.revealFrame(tab, frame, guard);
    const box = await this.bridge(
      tab,
      frame,
      `globalThis.__workbenchPage.bounds(${JSON.stringify(localRef)})`,
      guard,
    );
    if (box.disabled) throw new Error('Element is disabled');
    const offset = await this.geometry(tab, frame);
    const point = { x: offset.x + box.x * offset.scaleX, y: offset.y + box.y * offset.scaleY };
    const hit = await this.hitFrame(tab, point.x, point.y);
    if (frame.id !== tab.mainFrameId && hit.id !== frame.id)
      throw new Error('此 iframe 元素被父页面的其它元素遮挡');
    guard();
    return point;
  }
  private async hitFrame(tab: TabSession, x: number, y: number): Promise<FrameContext> {
    let frame = this.mainFrame(tab);
    for (let depth = 0; depth < 10; depth++) {
      const offset = await this.geometry(tab, frame);
      const local = { x: (x - offset.x) / offset.scaleX, y: (y - offset.y) / offset.scaleY };
      const prepared = await this.prepareFrame(tab, frame);
      this.assertPreparedContext(tab, frame, prepared);
      const hit = await prepared.channel.call('Runtime.evaluate', {
        expression: `(()=>{let el=document.elementFromPoint(${local.x},${local.y});while(el?.shadowRoot){const next=el.shadowRoot.elementFromPoint(${local.x},${local.y});if(!next||next===el)break;el=next;}return el;})()`,
        contextId: prepared.contextId,
      });
      this.assertPreparedContext(tab, frame, prepared);
      if (!hit.result.objectId) return frame;
      let childId: string | undefined;
      try {
        const described = await prepared.channel.call('DOM.describeNode', {
          objectId: hit.result.objectId,
        });
        this.assertPreparedContext(tab, frame, prepared);
        childId = described.node.frameId;
      } finally {
        await prepared.channel
          .call('Runtime.releaseObject', { objectId: hit.result.objectId })
          .catch(() => {});
      }
      const child = childId && tab.frames.get(childId);
      if (!child) return frame;
      const geometry = await this.geometry(tab, child);
      const viewport = await this.bridge(tab, child, '({width:innerWidth,height:innerHeight})');
      const cx = (x - geometry.x) / geometry.scaleX,
        cy = (y - geometry.y) / geometry.scaleY;
      if (cx < 0 || cy < 0 || cx >= viewport.width || cy >= viewport.height) return frame;
      frame = child;
    }
    throw new Error('iframe 嵌套过深，无法安全定位此坐标');
  }
  private expose(
    tab: TabSession,
    frame: FrameContext,
    element: any,
    geometry?: FrameGeometry,
  ): ElementRef {
    const documentId = frame.documentId || String(element.documentId || '');
    const ref = `${tab.info.id}/${tab.activation}/${frame.id}/${frame.revision}/${element.ref}`;
    this.refs.set(ref, {
      tabId: tab.info.id,
      activation: tab.activation,
      frameId: frame.id,
      revision: frame.revision,
      documentId,
      localRef: element.ref,
    });
    const bounds =
      element.bounds && geometry
        ? {
            x: geometry.x + element.bounds.x * geometry.scaleX,
            y: geometry.y + element.bounds.y * geometry.scaleY,
            width: element.bounds.width * geometry.scaleX,
            height: element.bounds.height * geometry.scaleY,
          }
        : element.bounds;
    return {
      ...element,
      ref,
      nodeId: element.ref,
      tabId: tab.info.id,
      frameId: frame.id,
      documentId,
      bounds,
    };
  }
  private async resolveRef(
    ref: string,
  ): Promise<{ tab: TabSession; frame: FrameContext; scope: ScopedElement }> {
    if (typeof ref !== 'string' || ref.length > 1500) throw new Error('元素引用无效');
    const scope = this.refs.get(ref),
      tab = this.activeTab();
    if (!scope || scope.tabId !== tab.info.id || scope.activation !== tab.activation)
      throw new Error('元素引用已失效或属于其他标签页，请重新获取 snapshot/query。');
    const frame = tab.frames.get(scope.frameId);
    if (!frame) throw new Error('元素所在 iframe 已移除');
    await this.prepareFrame(tab, frame);
    if (frame.revision !== scope.revision || frame.documentId !== scope.documentId)
      throw new Error('元素所在文档已改变，请重新获取引用。');
    return { tab, frame, scope };
  }
  private async atPoint(tab: TabSession, x: number, y: number): Promise<ElementRef | null> {
    await this.collectFrames(tab);
    const frame = await this.hitFrame(tab, x, y);
    const offset = await this.geometry(tab, frame);
    const element = await this.bridge(
      tab,
      frame,
      `globalThis.__workbenchPage.atPoint(${(x - offset.x) / offset.scaleX},${(y - offset.y) / offset.scaleY})`,
    );
    return element ? this.expose(tab, frame, element, offset) : null;
  }
  dispatchInput(input: BrowserInput): Promise<void> {
    if (!input || typeof input !== 'object')
      return Promise.reject(new Error('Invalid browser input'));
    const id = this.activeTab().info.id;
    if (input.tabId !== undefined && input.tabId !== id)
      return Promise.reject(new Error('忽略了来自旧标签页的输入。'));
    if (input.type === 'resize') return this.resize(input.width, input.height);
    if (input.type === 'mouse') this.hoverEpoch++;
    if (input.type === 'mouse' && input.action === 'leave') {
      const tab = this.activeTab(),
        epoch = this.hoverEpoch,
        activation = tab.activation;
      this.latestMove = undefined;
      const cleared = this.clearHover(tab, epoch, activation);
      // Hover acknowledgements can wait on a resize; cleanup must never block page actions.
      if (this.pointerMove)
        void this.pointerMove
          .then(
            () => this.clearHover(tab, epoch, activation),
            () => this.clearHover(tab, epoch, activation),
          )
          .catch(() => {});
      return cleared;
    }
    if (
      input.type === 'mouse' &&
      input.button &&
      !['left', 'middle', 'right'].includes(input.button)
    )
      return Promise.reject(new Error('Invalid mouse button'));
    if (
      input.type === 'mouse' &&
      input.buttons !== undefined &&
      (!Number.isInteger(input.buttons) || input.buttons < 0 || input.buttons > 31)
    )
      return Promise.reject(new Error('Invalid mouse buttons'));
    if (input.type === 'mouse' && input.action === 'move' && !input.buttons) {
      if (
        ![input.x, input.y].every(Number.isFinite) ||
        input.x < 0 ||
        input.y < 0 ||
        input.x > this.width ||
        input.y > this.height
      )
        return Promise.reject(new Error('Pointer is outside the browser viewport'));
      if (
        input.modifiers !== undefined &&
        (!Number.isInteger(input.modifiers) || input.modifiers < 0 || input.modifiers > 15)
      )
        return Promise.reject(new Error('Invalid keyboard modifiers'));
      this.latestMove = { ...input, tabId: id };
      if (!this.pointerMove) {
        this.pointerMove = (async () => {
          while (this.latestMove) {
            const move = this.latestMove;
            this.latestMove = undefined;
            const tab = this.tabs.get(move.tabId!);
            if (!tab || this.activeTabId !== move.tabId) continue;
            await tab.page.call('Input.dispatchMouseEvent', {
              type: 'mouseMoved',
              x: move.x,
              y: move.y,
              button: move.buttons ? move.button || 'left' : 'none',
              buttons: move.buttons || 0,
              modifiers: move.modifiers || 0,
            });
          }
        })().finally(() => {
          this.pointerMove = undefined;
        });
      }
      return this.pointerMove;
    }
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
      const tab = this.requireActive(id);
      if (input.type === 'key' && input.key === 'Escape' && this.state.inspecting) {
        if (input.action === 'down') await this.setInspectInternal(tab, false);
        return;
      }
      if (input.type === 'mouse' && input.action === 'up' && this.suppressMouseUp) {
        this.suppressMouseUp = false;
        return;
      }
      if (input.type === 'mouse' || input.type === 'wheel')
        if (
          ![input.x, input.y].every(Number.isFinite) ||
          input.x < 0 ||
          input.y < 0 ||
          input.x > this.width ||
          input.y > this.height
        )
          throw new Error('Pointer is outside the browser viewport');
      if (
        'modifiers' in input &&
        input.modifiers !== undefined &&
        (!Number.isInteger(input.modifiers) || input.modifiers < 0 || input.modifiers > 15)
      )
        throw new Error('Invalid keyboard modifiers');
      await this.setSource(tab, 'human');
      if (input.type === 'mouse') {
        if (
          !['move', 'down', 'up'].includes(input.action) ||
          (input.button && !['left', 'middle', 'right'].includes(input.button))
        )
          throw new Error('Invalid mouse input');
        if (this.state.inspecting && input.action === 'down') {
          const element = await this.atPoint(tab, input.x, input.y);
          this.suppressMouseUp = true;
          if (element) await this.selectElementInternal(element.ref, false);
          return;
        }
        await tab.page.call('Input.dispatchMouseEvent', {
          type: { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased' }[
            input.action as 'move' | 'down' | 'up'
          ],
          x: input.x,
          y: input.y,
          button: input.button || 'left',
          ...(input.buttons !== undefined ? { buttons: input.buttons } : {}),
          clickCount: input.action === 'move' ? 0 : Math.min(3, Math.max(1, input.clickCount || 1)),
          modifiers: input.modifiers || 0,
        });
      } else if (input.type === 'wheel') {
        if (![input.deltaX, input.deltaY].every(Number.isFinite))
          throw new Error('Invalid scroll input');
        await tab.page.call('Input.dispatchMouseEvent', {
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
        await tab.page.call('Input.insertText', { text: input.text });
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
        await tab.page.call('Input.dispatchKeyEvent', {
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
  private async clearHover(tab: TabSession, epoch: number, activation: number): Promise<void> {
    if (
      this.hoverEpoch !== epoch ||
      this.activeTabId !== tab.info.id ||
      tab.activation !== activation
    )
      return;
    await Promise.allSettled(
      [...tab.frames.values()]
        .filter((frame) => frame.contextId)
        .map((frame) =>
          frame.channel.call('Runtime.evaluate', {
            expression: 'globalThis.__workbenchPage?.leave()',
            contextId: frame.contextId,
          }),
        ),
    );
  }
  setInspect(enabled: boolean): Promise<void> {
    const id = this.activeTab().info.id;
    return this.serialize(() => this.setInspectInternal(this.requireActive(id), !!enabled));
  }
  private async setInspectInternal(tab: TabSession, enabled: boolean): Promise<void> {
    const frames = await this.collectFrames(tab);
    await Promise.all(
      frames.map((frame) =>
        this.bridge(tab, frame, `globalThis.__workbenchPage.setInspect(${enabled})`).catch(
          () => {},
        ),
      ),
    );
    this.update({ inspecting: enabled });
  }
  setElementFeedback(ref: string, phase: 'working' | null): Promise<void> {
    return this.serialize(async () => {
      if (phase === 'working') {
        const { tab, frame, scope } = await this.resolveRef(ref);
        if (this.workingFeedback && this.workingFeedback.ref !== ref)
          await this.clearWorkingFeedback(this.workingFeedback);
        this.workingFeedback = { ...scope, ref };
        await this.bridge(
          tab,
          frame,
          `globalThis.__workbenchPage.feedback(${JSON.stringify(scope.localRef)},'working')`,
        );
        return;
      }
      const scope = this.workingFeedback;
      if (!scope || scope.ref !== ref) return;
      this.workingFeedback = undefined;
      await this.clearWorkingFeedback(scope);
    });
  }
  private async clearWorkingFeedback(scope: ScopedElement): Promise<void> {
    const tab = this.tabs.get(scope.tabId),
      frame = tab?.frames.get(scope.frameId);
    if (!tab || !frame || frame.documentId !== scope.documentId) return;
    await this.bridge(
      tab,
      frame,
      `globalThis.__workbenchPage.feedback(${JSON.stringify(scope.localRef)},null)`,
    ).catch(() => {});
  }

  snapshot(): Promise<ToolResult> {
    const id = this.activeTab().info.id;
    return this.serialize(() => this.snapshotInternal(this.requireActive(id)));
  }
  private async snapshotInternal(tab: TabSession): Promise<ToolResult> {
    const frames = await this.collectFrames(tab),
      items: ElementRef[] = [],
      details: any[] = [],
      texts: string[] = [];
    for (const frame of frames) {
      try {
        const value = await this.bridge(tab, frame, 'globalThis.__workbenchPage.snapshot()');
        const geometry = await this.geometry(tab, frame);
        frame.documentId = value.documentId;
        items.push(...value.elements.map((item: any) => this.expose(tab, frame, item, geometry)));
        texts.push(value.text || '');
        details.push({
          frameId: frame.id,
          parentId: frame.parentId,
          url: evidenceUrl(frame.url),
          documentId: value.documentId,
        });
      } catch (error) {
        details.push({
          frameId: frame.id,
          url: evidenceUrl(frame.url),
          error: redactBrowserText(error instanceof Error ? error.message : error),
        });
      }
    }
    if (!details.some((frame) => frame.documentId)) throw new Error('当前页面框架尚未可读');
    return {
      text: JSON.stringify(
        {
          tabId: tab.info.id,
          url: evidenceUrl(tab.info.url),
          title: tab.info.title,
          documentId: this.mainFrame(tab).documentId,
          text: texts.join('\n\n').slice(0, 12_000),
          elements: items.slice(0, 240),
          frames: details,
        },
        null,
        2,
      ),
    };
  }
  screenshot(): Promise<ToolResult> {
    const id = this.activeTab().info.id;
    return this.serialize(() => this.screenshotInternal(this.requireActive(id)));
  }
  private async screenshotInternal(tab: TabSession): Promise<ToolResult> {
    const frames = await this.collectFrames(tab),
      masked: FrameContext[] = [];
    const activation = tab.activation;
    const scopes: Array<{
      id: string;
      channel: BrowserChannel;
      revision: number;
      documentId?: string;
    }> = [];
    const unchanged = async () => {
      const current = await this.collectFrames(tab);
      if (
        this.activeTabId !== tab.info.id ||
        tab.activation !== activation ||
        current.length !== scopes.length
      )
        throw new Error('页面在截图期间发生变化，已丢弃截图，请重试。');
      for (const scope of scopes) {
        const frame = current.find((item) => item.id === scope.id);
        if (!frame || frame.channel !== scope.channel)
          throw new Error('页面框架在截图期间发生变化，已丢弃截图。');
        await this.prepareFrame(tab, frame);
        if (frame.revision !== scope.revision || frame.documentId !== scope.documentId)
          throw new Error('页面文档在截图期间发生变化，已丢弃截图，请重试。');
      }
    };
    try {
      for (const frame of frames) {
        await this.bridge(tab, frame, 'globalThis.__workbenchPage.mask(true)');
        masked.push(frame);
        scopes.push({
          id: frame.id,
          channel: frame.channel,
          revision: frame.revision,
          documentId: frame.documentId,
        });
      }
      await unchanged();
      const result = await tab.page.call('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
      });
      await unchanged();
      return {
        text: `BrowserOS neo 页面截图（tab ${tab.info.id}）：${evidenceUrl(tab.info.url)}。可访问的敏感输入框已遮盖。`,
        image: result.data,
      };
    } finally {
      for (const frame of masked)
        await this.bridge(tab, frame, 'globalThis.__workbenchPage.mask(false)').catch(() => {});
    }
  }
  queryElements(query: ElementQuery & { frameId?: string }): Promise<ElementQueryResult> {
    const id = this.activeTab().info.id;
    return this.serialize(() => this.queryInternal(this.requireActive(id), query));
  }
  private async queryInternal(
    tab: TabSession,
    query: ElementQuery & { frameId?: string },
  ): Promise<ElementQueryResult> {
    if (!query || typeof query !== 'object' || Array.isArray(query))
      throw new Error('查询条件无效');
    if (
      Object.keys(query).some(
        (key) => !['selector', 'text', 'role', 'exact', 'limit', 'frameId'].includes(key),
      )
    )
      throw new Error('查询含未知字段');
    for (const key of ['selector', 'text', 'role', 'frameId'] as const)
      if (query[key] !== undefined && (typeof query[key] !== 'string' || query[key]!.length > 1000))
        throw new Error('查询条件格式无效');
    if (![query.selector, query.text, query.role].some((value) => value?.trim()))
      throw new Error('请提供 selector、文字或 role');
    if (query.exact !== undefined && typeof query.exact !== 'boolean')
      throw new Error('exact 必须为布尔值');
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('查询数量必须在1到100之间');
    const all = await this.collectFrames(tab),
      frames = query.frameId ? all.filter((frame) => frame.id === query.frameId) : all;
    if (!frames.length) throw new Error('指定的 iframe 不存在');
    const { frameId: _, ...criteria } = query;
    const elements: ElementRef[] = [];
    const warnings: Array<{ frameId: string; message: string }> = [];
    let truncated = false;
    for (const frame of frames) {
      try {
        const result = await this.bridge(
          tab,
          frame,
          `globalThis.__workbenchPage.query(${JSON.stringify({ ...criteria, limit })})`,
        );
        truncated ||= result.truncated;
        if (!result.elements.length) continue;
        const geometry = await this.geometry(tab, frame);
        elements.push(
          ...result.elements.map((element: any) => this.expose(tab, frame, element, geometry)),
        );
      } catch (error) {
        if (query.frameId) throw error;
        warnings.push({
          frameId: frame.id,
          message: redactBrowserText(error instanceof Error ? error.message : error),
        });
      }
    }
    const result = {
      documentId: this.mainFrame(tab).documentId || '',
      elements: elements.slice(0, limit),
      truncated: truncated || elements.length > limit,
      ...(warnings.length ? { warnings } : {}),
    };
    return result;
  }
  getElementDetails(ref: string): Promise<ElementDetails> {
    return this.serialize(() => this.detailsInternal(ref));
  }
  private async detailsInternal(ref: string): Promise<ElementDetails> {
    const { tab, frame, scope } = await this.resolveRef(ref);
    const detail = await this.bridge(
      tab,
      frame,
      `globalThis.__workbenchPage.inspect(${JSON.stringify(scope.localRef)})`,
    );
    return this.exposeDetails(tab, frame, detail);
  }
  private async exposeDetails(
    tab: TabSession,
    frame: FrameContext,
    detail: any,
  ): Promise<ElementDetails> {
    const geometry = await this.geometry(tab, frame);
    return {
      ...detail,
      ...this.expose(tab, frame, detail, geometry),
      documentId: frame.documentId || detail.documentId,
      ancestors: (detail.ancestors || []).map((element: any) =>
        this.expose(tab, frame, element, geometry),
      ),
    };
  }
  selectElement(ref: string): Promise<ElementDetails> {
    const scope = this.refs.get(ref);
    if (!scope || scope.tabId !== this.activeTabId)
      return Promise.reject(new Error('元素引用已失效或属于其他标签页'));
    this.humanTakeover('inspect');
    return this.serialize(() => this.selectElementInternal(ref));
  }
  private async selectElementInternal(ref: string, reveal = true): Promise<ElementDetails> {
    const { tab, frame, scope } = await this.resolveRef(ref);
    await this.setSource(tab, 'human');
    if (reveal) {
      await this.revealFrame(tab, frame);
      await this.bridge(
        tab,
        frame,
        `globalThis.__workbenchPage.reveal(${JSON.stringify(scope.localRef)})`,
      );
    }
    await this.clearOutline(tab);
    await this.bridge(
      tab,
      frame,
      `globalThis.__workbenchPage.outline(${JSON.stringify(scope.localRef)})`,
    );
    const detail = await this.detailsInternal(ref);
    this.update({ selectedElement: detail, inspecting: false });
    this.options.onSelected(detail);
    return detail;
  }
  editElement(ref: string, changes: ElementEdit): Promise<ElementEditResult> {
    const scope = this.refs.get(ref);
    if (!scope || scope.tabId !== this.activeTabId)
      return Promise.reject(new Error('元素引用已失效或属于其他标签页'));
    this.humanTakeover('edit');
    return this.serialize(() => this.editInternal(ref, changes, 'human'));
  }
  private validateEdit(changes: ElementEdit): void {
    if (
      !changes ||
      typeof changes !== 'object' ||
      Array.isArray(changes) ||
      Object.keys(changes).some((key) => !['text', 'styles', 'animation'].includes(key))
    )
      throw new Error('元素修改格式无效');
    if (
      changes.text !== undefined &&
      (typeof changes.text !== 'string' || changes.text.length > 20_000)
    )
      throw new Error('文字内容过长或无效');
    if (changes.styles !== undefined) validateStyles(changes.styles, editableStyles, true);
    if (changes.animation !== undefined && changes.animation !== null)
      validateAnimation(changes.animation);
    if (
      changes.text === undefined &&
      !Object.keys(changes.styles || {}).length &&
      changes.animation === undefined
    )
      throw new Error('没有提供修改内容');
  }
  private registerEdit(tab: TabSession, frame: FrameContext, localId: string): string {
    const id = `${tab.info.id}/${frame.id}/${frame.documentId}/${localId}`;
    if (!tab.edits.some((edit) => edit.id === id))
      tab.edits.push({ id, frameId: frame.id, documentId: frame.documentId || '', localId });
    return id;
  }
  private async editInternal(
    ref: string,
    changes: ElementEdit,
    source: 'human' | 'agent',
    guard?: () => void,
  ): Promise<ElementEditResult> {
    this.validateEdit(changes);
    const { tab, frame, scope } = await this.resolveRef(ref);
    await this.setSource(tab, source, frame);
    const result = await this.bridge(
      tab,
      frame,
      `globalThis.__workbenchPage.edit(${JSON.stringify({ ref: scope.localRef, ...changes })})`,
      guard,
    );
    const editId = this.registerEdit(tab, frame, result.editId);
    const metadata = tab.edits.find((edit) => edit.id === editId)!;
    metadata.localRef = scope.localRef;
    metadata.changes = structuredClone(changes);
    await this.bridge(
      tab,
      frame,
      `globalThis.__workbenchPage.outline(${JSON.stringify(result.element.ref)})`,
    );
    const element = await this.exposeDetails(tab, frame, result.element);
    this.update({ selectedElement: element });
    this.options.onSelected(element);
    return { editId, element };
  }
  undoEdit(editId?: string): Promise<ElementEditResult> {
    const tab = this.activeTab();
    if (editId !== undefined && typeof editId !== 'string')
      return Promise.reject(new Error('修改ID无效'));
    this.humanTakeover('undo');
    return this.serialize(() =>
      this.undoInternal(this.requireActive(tab.info.id), editId, 'human'),
    );
  }
  private async undoInternal(
    tab: TabSession,
    id: string | undefined,
    source: 'human' | 'agent',
    guard?: () => void,
  ): Promise<ElementEditResult> {
    const edit = id ? tab.edits.find((item) => item.id === id) : tab.edits.at(-1);
    if (!edit) throw new Error('当前标签页没有可撤销的修改');
    const frame = tab.frames.get(edit.frameId);
    if (!frame) throw new Error('修改所在框架已移除');
    await this.prepareFrame(tab, frame);
    if (frame.documentId !== edit.documentId) throw new Error('修改所在文档已改变，无法撤销');
    await this.setSource(tab, source, frame);
    const result = await this.bridge(
      tab,
      frame,
      `globalThis.__workbenchPage.undo(${JSON.stringify(edit.localId)})`,
      guard,
    );
    tab.edits = tab.edits.filter((item) => item.id !== edit.id);
    await this.bridge(
      tab,
      frame,
      `globalThis.__workbenchPage.outline(${JSON.stringify(result.element.ref)})`,
    );
    const element = await this.exposeDetails(tab, frame, result.element);
    this.update({ selectedElement: element });
    this.options.onSelected(element);
    return { editId: edit.id, element };
  }

  startRecording(): void {
    const tab = this.activeTab();
    if (this.recording) return;
    this.recording = {
      id: randomUUID(),
      title: tab.info.title || '浏览器操作',
      startedAt: Date.now(),
      steps: [],
    };
    this.update({ recording: true });
    this.appendStep({
      kind: 'navigate',
      description: `打开 ${evidenceUrl(tab.info.url)}`,
      url: evidenceUrl(tab.info.url),
      source: 'human',
      tabId: tab.info.id,
      frameId: tab.mainFrameId,
    });
  }
  stopRecording(): Recording {
    if (!this.recording) throw new Error('当前没有录制');
    const recording = structuredClone({ ...this.recording, endedAt: Date.now() });
    this.recording = undefined;
    this.update({ recording: false });
    return recording;
  }
  private recordEvent(tab: TabSession, frame: FrameContext, event: any): void {
    if (
      !this.recording ||
      !event ||
      !['click', 'fill', 'select', 'key', 'scroll', 'edit', 'undo'].includes(event.kind) ||
      !['human', 'agent'].includes(event.source)
    )
      return;
    if (typeof event.docId !== 'string') return;
    if (frame.documentId && frame.documentId !== event.docId) return;
    frame.documentId = event.docId;
    const target =
      event.target && typeof event.target.ref === 'string'
        ? this.expose(tab, frame, {
            ...event.target,
            name: redactBrowserText(event.target.name).slice(0, 180),
          })
        : undefined;
    const value =
      typeof event.value === 'string'
        ? ['edit', 'undo'].includes(event.kind)
          ? recordedEditValue(event.value)
          : redactBrowserText(event.value)
        : undefined;
    const verbs: Record<string, string> = {
      click: '点击',
      fill: '填写',
      select: '选择',
      key: '按键',
      scroll: '滚动',
      edit: '修改元素',
      undo: '撤销修改',
    };
    const editId =
      typeof event.editId === 'string' ? this.registerEdit(tab, frame, event.editId) : undefined;
    if (event.kind === 'undo' && editId) tab.edits = tab.edits.filter((edit) => edit.id !== editId);
    this.appendStep({
      kind: event.kind,
      description: `${verbs[event.kind]}${target?.name ? `「${target.name}」` : ''}${value && ['key', 'scroll'].includes(event.kind) ? ` ${value}` : ''}`,
      url: evidenceUrl(frame.url || tab.info.url),
      source: event.source,
      target,
      value,
      tabId: tab.info.id,
      frameId: frame.id,
      editId,
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
      last.tabId === step.tabId &&
      last.frameId === step.frameId &&
      last.target?.ref === step.target?.ref &&
      last.source === step.source &&
      step.timestamp - last.timestamp < 1500
    ) {
      step.id = last.id;
      this.recording.steps[this.recording.steps.length - 1] = step;
    } else this.recording.steps.push(step);
    this.options.onStep(structuredClone(step));
  }

  getTools(): BrowserTool[] {
    const tool = (
      name: string,
      description: string,
      properties: Record<string, unknown> = {},
      required: string[] = [],
      target = true,
    ): BrowserTool => ({
      name: `workbench_browser_${name}`,
      description,
      inputSchema: {
        type: 'object',
        properties: {
          ...(target
            ? {
                tabId: {
                  type: 'string',
                  description: '目标必须是当前活动标签页；其他页面先用 switch_tab。',
                },
              }
            : {}),
          ...properties,
        },
        required,
        additionalProperties: false,
      },
    });
    const ref = {
      type: 'string',
      description: '当前活动标签页 snapshot/query 返回的精确元素引用；切换或导航后必须重取。',
    };
    return [
      tool('tabs', '列出工作台中的真实浏览器标签页及活动页。', {}, [], false),
      tool(
        'new_tab',
        '新建并显示工作台内的标签页；不打开系统浏览器。',
        { url: { type: 'string' } },
        [],
        false,
      ),
      tool(
        'switch_tab',
        '切换可见标签页；旧元素引用失效，之后先获取 snapshot。',
        { tabId: { type: 'string' } },
        ['tabId'],
        false,
      ),
      tool('close_tab', '关闭指定标签页。', { tabId: { type: 'string' } }, ['tabId'], false),
      tool('snapshot', '读取当前标签页及可访问iframe的DOM文字、元素与frame标识。'),
      tool('screenshot', '获取当前可见标签页截图，遮盖可访问frame中的敏感输入框。'),
      tool('query', '按CSS selector、文字或role查找精确DOM节点（含开放Shadow DOM）。', {
        selector: { type: 'string' },
        text: { type: 'string' },
        role: { type: 'string' },
        exact: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        frameId: { type: 'string' },
      }),
      tool(
        'inspect',
        '读取精确元素属性、计算样式（含渐变、阴影、变换）、工具预览动画配置与实际播放状态、祖先和frame，不改变页面。',
        { ref },
        ['ref'],
      ),
      tool(
        'edit',
        '临时修改精确DOM文字、渐变背景、阴影、变换，或用animation结构创建可撤销WAAPI动效。styles支持列出的CSS属性；禁用URL、var/attr、代码、转义、!important和原始animation/transition属性。animation:null只取消Workbench自身动画；尊重减少动态效果设置。这是页面预览，不代表源码已修改。',
        {
          ref,
          text: { type: 'string', maxLength: 20_000 },
          styles: {
            type: 'object',
            maxProperties: ELEMENT_PREVIEW_LIMITS.styleCount,
            propertyNames: { enum: [...ELEMENT_STYLE_PROPERTIES] },
            additionalProperties: {
              type: 'string',
              maxLength: ELEMENT_PREVIEW_LIMITS.styleValueLength,
            },
            description:
              '支持linear/radial/conic-gradient及安全颜色、box-shadow/text-shadow、transform/filter。空值删除该行内属性。',
          },
          animation: {
            anyOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                required: ['keyframes', 'duration'],
                properties: {
                  keyframes: {
                    type: 'array',
                    minItems: ELEMENT_PREVIEW_LIMITS.keyframesMin,
                    maxItems: ELEMENT_PREVIEW_LIMITS.keyframesMax,
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['styles'],
                      properties: {
                        offset: {
                          type: 'number',
                          minimum: 0,
                          maximum: 1,
                          description: '已指定的offset必须非递减。',
                        },
                        styles: {
                          type: 'object',
                          minProperties: 1,
                          maxProperties: ELEMENT_PREVIEW_LIMITS.styleCount,
                          propertyNames: { enum: [...ELEMENT_ANIMATION_PROPERTIES] },
                          additionalProperties: {
                            type: 'string',
                            minLength: 1,
                            maxLength: ELEMENT_PREVIEW_LIMITS.styleValueLength,
                          },
                        },
                      },
                    },
                  },
                  duration: {
                    type: 'number',
                    minimum: ELEMENT_PREVIEW_LIMITS.durationMin,
                    maximum: ELEMENT_PREVIEW_LIMITS.durationMax,
                    description: '一轮时长，单位毫秒。',
                  },
                  iterations: {
                    anyOf: [
                      { type: 'number', minimum: 1, maximum: ELEMENT_PREVIEW_LIMITS.iterationsMax },
                      { type: 'string', enum: ['infinite'] },
                    ],
                  },
                  easing: {
                    type: 'string',
                    maxLength: ELEMENT_PREVIEW_LIMITS.easingLength,
                    description:
                      'linear/ease/ease-in/ease-out/ease-in-out/step-start/step-end，或合法cubic-bezier()/steps()。',
                  },
                  direction: {
                    type: 'string',
                    enum: ['normal', 'reverse', 'alternate', 'alternate-reverse'],
                  },
                },
              },
            ],
          },
        },
        ['ref'],
      ),
      tool('undo', '撤销当前标签页的预览修改。', { editId: { type: 'string' } }),
      tool('navigate', '在当前标签页打开HTTP(S)地址。', { url: { type: 'string' } }, ['url']),
      tool('click', '点击当前snapshot/query中的精确元素。', { ref }, ['ref']),
      tool('fill', '填写当前元素引用对应的文本输入框。', { ref, value: { type: 'string' } }, [
        'ref',
        'value',
      ]),
      tool('select', '选择下拉框的option value。', { ref, value: { type: 'string' } }, [
        'ref',
        'value',
      ]),
      tool(
        'press',
        '发送Enter、Tab、Escape、Backspace或方向键。',
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
        '滚动当前标签页。',
        { deltaY: { type: 'number', minimum: -1500, maximum: 1500 } },
        ['deltaY'],
      ),
      tool('diagnostics', '读取当前标签页console和网络摘要，不包含请求正文。'),
    ];
  }
  callTool(name: string, args: unknown): Promise<ToolResult> {
    const generation = this.leaseGeneration,
      capturedTab = this.activeTabId;
    return this.serialize(async () => {
      try {
        this.activeTab();
        if (!args || typeof args !== 'object' || Array.isArray(args))
          throw new Error('Tool arguments must be an object');
        const input = args as Record<string, unknown>,
          definition = this.getTools().find((tool) => tool.name === name);
        if (!definition) throw new Error('Unknown browser tool');
        const properties = definition.inputSchema.properties as Record<string, unknown>;
        if (Object.keys(input).some((key) => !(key in properties)))
          throw new Error('Unexpected browser tool argument');
        if (
          input.tabId !== undefined &&
          (typeof input.tabId !== 'string' || input.tabId.length > 200)
        )
          throw new Error('tabId is invalid');
        const assertLease = () => {
          if (!this.agentAllowed || generation !== this.leaseGeneration)
            throw new Error('用户已接管浏览器，请等待新的用户请求。');
        };
        const json = (value: unknown): ToolResult => ({ text: JSON.stringify(value, null, 2) });
        if (name === 'workbench_browser_tabs')
          return json({ activeTabId: this.activeTabId, tabs: this.listTabs() });
        if (name === 'workbench_browser_new_tab') {
          assertLease();
          if (input.url !== undefined && typeof input.url !== 'string')
            throw new Error('url is invalid');
          return json(
            await this.createTab(
              input.url === undefined ? 'about:blank' : normalizeBrowserUrl(input.url),
              'agent',
              assertLease,
            ),
          );
        }
        if (name === 'workbench_browser_switch_tab') {
          assertLease();
          const target = typeof input.tabId === 'string' && this.tabs.get(input.tabId);
          if (!target) throw new Error('标签页不存在');
          await this.activateTab(target, 'agent');
          return json({ activeTabId: this.activeTabId, tabs: this.listTabs() });
        }
        if (name === 'workbench_browser_close_tab') {
          assertLease();
          if (typeof input.tabId !== 'string') throw new Error('tabId is required');
          await this.closeTabInternal(input.tabId, 'agent');
          return json({ activeTabId: this.activeTabId, tabs: this.listTabs() });
        }
        const tab = this.requireActive(typeof input.tabId === 'string' ? input.tabId : capturedTab);
        if (name === 'workbench_browser_snapshot') return await this.snapshotInternal(tab);
        if (name === 'workbench_browser_screenshot') return await this.screenshotInternal(tab);
        if (name === 'workbench_browser_diagnostics') return json(tab.diagnostics);
        if (name === 'workbench_browser_query') {
          const { tabId: _, ...query } = input;
          return json(await this.queryInternal(tab, query as ElementQuery & { frameId?: string }));
        }
        if (name === 'workbench_browser_inspect') {
          if (typeof input.ref !== 'string') throw new Error('ref is required');
          return json(await this.detailsInternal(input.ref));
        }
        assertLease();
        if (name === 'workbench_browser_navigate') {
          if (typeof input.url !== 'string') throw new Error('url is required');
          await this.navigateInternal(tab, normalizeBrowserUrl(input.url), 'agent');
          return { text: '页面正在加载，继续前请重新获取 snapshot。' };
        }
        if (name === 'workbench_browser_edit') {
          if (typeof input.ref !== 'string') throw new Error('ref is required');
          return json(
            await this.editInternal(
              input.ref,
              {
                ...(input.text !== undefined ? { text: input.text as string } : {}),
                ...(input.styles !== undefined
                  ? { styles: input.styles as Record<string, string> }
                  : {}),
                ...(input.animation !== undefined
                  ? { animation: input.animation as ElementAnimation | null }
                  : {}),
              },
              'agent',
              assertLease,
            ),
          );
        }
        if (name === 'workbench_browser_undo') {
          if (input.editId !== undefined && typeof input.editId !== 'string')
            throw new Error('editId is invalid');
          return json(
            await this.undoInternal(tab, input.editId as string | undefined, 'agent', assertLease),
          );
        }
        if (
          [
            'workbench_browser_click',
            'workbench_browser_fill',
            'workbench_browser_select',
          ].includes(name)
        ) {
          if (typeof input.ref !== 'string') throw new Error('ref is required');
          const { frame, scope } = await this.resolveRef(input.ref);
          await this.setSource(tab, 'agent', frame);
          assertLease();
          const point = await this.inputPoint(tab, frame, scope.localRef, assertLease);
          if (name === 'workbench_browser_click') {
            await tab.page.call('Input.dispatchMouseEvent', {
              type: 'mousePressed',
              button: 'left',
              clickCount: 1,
              ...point,
            });
            await tab.page.call('Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              button: 'left',
              clickCount: 1,
              ...point,
            });
          } else {
            if (typeof input.value !== 'string' || input.value.length > 20_000)
              throw new Error('value must be a string of at most 20,000 characters');
            if (name === 'workbench_browser_fill') {
              await this.bridge(
                tab,
                frame,
                `globalThis.__workbenchPage.focus(${JSON.stringify(scope.localRef)})`,
                assertLease,
              );
              assertLease();
              await tab.page.call('Input.insertText', { text: input.value });
            } else
              await this.bridge(
                tab,
                frame,
                `globalThis.__workbenchPage.select(${JSON.stringify(scope.localRef)},${JSON.stringify(input.value)})`,
                assertLease,
              );
          }
        } else if (name === 'workbench_browser_press') {
          const keys: Record<string, number> = {
            Enter: 13,
            Tab: 9,
            Escape: 27,
            Backspace: 8,
            ArrowUp: 38,
            ArrowDown: 40,
            ArrowLeft: 37,
            ArrowRight: 39,
          };
          if (typeof input.key !== 'string' || !Object.hasOwn(keys, input.key))
            throw new Error('Unsupported key');
          await this.setSource(tab, 'agent');
          assertLease();
          await tab.page.call('Input.dispatchKeyEvent', {
            type: 'rawKeyDown',
            key: input.key,
            code: input.key,
            windowsVirtualKeyCode: keys[input.key],
          });
          await tab.page.call('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: input.key,
            code: input.key,
            windowsVirtualKeyCode: keys[input.key],
          });
        } else if (name === 'workbench_browser_scroll') {
          if (
            typeof input.deltaY !== 'number' ||
            !Number.isFinite(input.deltaY) ||
            Math.abs(input.deltaY) > 1500
          )
            throw new Error('deltaY must be between -1500 and 1500');
          await this.setSource(tab, 'agent');
          assertLease();
          await tab.page.call('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: this.width / 2,
            y: this.height / 2,
            deltaX: 0,
            deltaY: input.deltaY,
          });
        }
        return { text: '操作已执行，请用 snapshot 或 screenshot 核对实际结果。' };
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
    this.revokeAgentControl();
    this.recording = undefined;
    if (this.frameAckTimer) clearTimeout(this.frameAckTimer);
    this.frameAckTimer = undefined;
    for (const tab of this.tabs.values()) {
      for (const child of tab.children) child.close();
      tab.page.close();
    }
    this.tabs.clear();
    this.refs.clear();
    this.activeTabId = '';
    try {
      await this.browser?.call('Browser.close');
    } catch {}
    this.browser?.close();
    this.browser = undefined;
    if (this.process?.exitCode === null) this.process.kill('SIGTERM');
    this.update({
      status: 'stopped',
      loading: false,
      recording: false,
      inspecting: false,
      selectedElement: undefined,
    });
  }
}
