import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import type { NativeNeoState, NeoSessionDetail, NeoSessionSummary } from '../shared/types';

const exec = promisify(execFile);
export const NEO_SERVER_VERSION = '0.0.90';
const archives: Record<string, string> = {
  arm64: '68f525da82433642ca03a39908826e2bc341ca2afa86bf9e10a864146b047396',
  x64: '8183d518e7965d2dd6f08fbe8b03902a8fdf9bb82fc0f4f00a588fc2d3eb7b44',
};
export interface NeoTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}
export interface NeoToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  structuredContent?: Record<string, any>;
  isError?: boolean;
}
export interface NeoPage {
  pageId: number;
  targetId: string;
  tabId: number;
  windowId: number;
  browserProfileId?: string;
  title: string;
  url: string;
  isActive: boolean;
}
export type NeoDownload = (
  url: string,
  options: { signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; arrayBuffer: () => Promise<ArrayBuffer> }>;
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseNeoReply(body: string, streaming: boolean, id: number): any {
  const payloads = streaming
    ? body
        .split(/\r?\n\r?\n/)
        .map((event) =>
          event
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n'),
        )
        .filter((value) => value.trim() && value.trim() !== '[DONE]')
    : [body];
  const packet = payloads.map((value) => JSON.parse(value)).find((item) => item.id === id);
  if (!packet) throw new Error('Neo 未返回对应请求的结果');
  if (packet.error) throw new Error(String(packet.error.message || 'Neo 请求失败'));
  return packet.result;
}

async function verifyResources(root: string): Promise<string> {
  const metadata = JSON.parse(await readFile(path.join(root, 'artifact-metadata.json'), 'utf8'));
  if (metadata.version !== NEO_SERVER_VERSION || metadata.target !== `darwin-${process.arch}`)
    throw new Error('Neo 控制组件版本或架构不匹配');
  for (const relative of [
    'resources/bin/browseros-claw-server',
    'resources/skills/browserclaw/SKILL.md',
  ]) {
    const item = metadata.files?.find((entry: any) => entry.path === relative);
    if (!item || digest(await readFile(path.join(root, relative))) !== item.sha256)
      throw new Error('Neo 控制组件完整性校验失败');
  }
  await access(path.join(root, 'resources/bin/browseros-claw-server'), constants.X_OK);
  return path.join(root, 'resources');
}

/** Downloads the unchanged official component; never alters the installed browser bundle. */
export async function ensureNeoResources(
  cache: string,
  signal?: AbortSignal,
  download: NeoDownload = fetch,
): Promise<string> {
  const override = process.env.ATHENA_NEO_RESOURCES;
  if (override) return verifyResources(path.dirname(path.resolve(override)));
  const development = path.resolve('.runtime/neo-server', NEO_SERVER_VERSION);
  try {
    return await verifyResources(development);
  } catch {
    /* A packaged app uses its private cache. */
  }
  if (process.platform !== 'darwin' || !archives[process.arch])
    throw new Error('当前 Neo 控制组件支持 macOS Apple Silicon 和 Intel');
  const installed = path.join(cache, NEO_SERVER_VERSION);
  try {
    return await verifyResources(installed);
  } catch {
    /* Install a verified component below. */
  }
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(cache, '.install-'));
  try {
    const response = await download(
      `https://github.com/browseros-ai/BrowserOS/releases/download/claw-server/v${NEO_SERVER_VERSION}/browseros-claw-server-rust-resources-darwin-${process.arch}.zip`,
      {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
          : AbortSignal.timeout(120_000),
      },
    );
    if (!response.ok) throw new Error(`Neo 组件下载失败（${response.status}）`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (digest(bytes) !== archives[process.arch]) throw new Error('Neo 组件下载校验失败');
    const archive = path.join(temporary, 'resources.zip');
    await writeFile(archive, bytes, { mode: 0o600 });
    const unpacked = path.join(temporary, 'unpacked');
    await exec('/usr/bin/ditto', ['-x', '-k', archive, unpacked]);
    // The official ZIP does not retain the executable bit on macOS extraction.
    await chmod(path.join(unpacked, 'resources/bin/browseros-claw-server'), 0o755);
    await verifyResources(unpacked);
    signal?.throwIfAborted();
    try {
      await rename(unpacked, installed);
    } catch (error) {
      try {
        return await verifyResources(installed);
      } catch {
        throw error;
      }
    }
    return await verifyResources(installed);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export class NeoMcpSession {
  private sequence = 0;
  id = '';
  private closed = false;
  constructor(private baseUrl: string) {}
  async initialize(): Promise<void> {
    const result = await this.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'athena', title: 'Athena', version: '0.3.0' },
    });
    if (
      result.serverInfo?.name !== 'browseros-neo' ||
      result.serverInfo?.version !== NEO_SERVER_VERSION ||
      !this.id
    )
      throw new Error('Neo 控制服务身份不匹配');
    await this.request('notifications/initialized', {}, true);
  }
  private async request(method: string, params: unknown, notification = false): Promise<any> {
    if (this.closed) throw new Error('Neo 会话已关闭');
    const id = ++this.sequence;
    const response = await fetch(this.baseUrl + '/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json,text/event-stream',
        ...(this.id ? { 'Mcp-Session-Id': this.id } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }),
      signal: AbortSignal.timeout(35_000),
    });
    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId) this.id = sessionId;
    const body = await response.text();
    if (!response.ok) throw new Error(`Neo 请求失败（${response.status}）`);
    if (notification) return;
    return parseNeoReply(
      body,
      response.headers.get('content-type')?.includes('text/event-stream') ?? false,
      id,
    );
  }
  async tools(): Promise<NeoTool[]> {
    return (await this.request('tools/list', {})).tools;
  }
  call(name: string, args: Record<string, unknown>): Promise<NeoToolResult> {
    return this.request('tools/call', { name, arguments: args });
  }
  async pages(): Promise<NeoPage[]> {
    const result = await this.call('run', { code: 'return await browser.pages.list();' });
    const value = result.structuredContent?.value;
    if (result.isError || result.structuredContent?.ok !== true || !Array.isArray(value))
      throw new Error('Neo 无法读取页面对应关系');
    return value;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.id)
      await fetch(this.baseUrl + '/mcp', {
        method: 'DELETE',
        headers: { 'Mcp-Session-Id': this.id },
        signal: AbortSignal.timeout(3000),
      }).catch(() => {});
  }
}

export class NeoServer {
  private process?: ChildProcess;
  private startup?: Promise<void>;
  private abort?: AbortController;
  private baseUrl = '';
  private generation = 0;
  private state: NativeNeoState = { status: 'stopped' };
  tools: NeoTool[] = [];
  constructor(
    private options: {
      directory: string;
      download?: NeoDownload;
      onState: (state: NativeNeoState) => void;
      onDisconnect: () => void;
    },
  ) {}
  getState(): NativeNeoState {
    return { ...this.state };
  }
  private update(state: NativeNeoState) {
    this.state = state;
    this.options.onState(this.getState());
  }
  start(cdpEndpoint: string, browserVersion: string): Promise<void> {
    if (this.state.status === 'ready') return Promise.resolve();
    if (this.startup) return this.startup;
    this.startup = this.startInternal(cdpEndpoint, browserVersion).finally(() => {
      this.startup = undefined;
    });
    return this.startup;
  }
  private async startInternal(cdpEndpoint: string, browserVersion: string) {
    const generation = ++this.generation;
    const controller = new AbortController();
    this.abort = controller;
    this.update({ status: 'starting', version: NEO_SERVER_VERSION });
    try {
      const resources = await ensureNeoResources(
        path.join(this.options.directory, 'runtime'),
        controller.signal,
        this.options.download,
      );
      const endpoint = new URL(cdpEndpoint);
      if (
        endpoint.hostname !== '127.0.0.1' ||
        endpoint.protocol !== 'ws:' ||
        !Number(endpoint.port)
      )
        throw new Error('Neo 浏览器连接地址无效');
      const reservation = createServer();
      await new Promise<void>((resolve, reject) => {
        reservation.once('error', reject);
        reservation.listen(0, '127.0.0.1', resolve);
      });
      const port = (reservation.address() as { port: number }).port;
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
      const directory = this.options.directory;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(path.join(directory, 'analytics.json'), '{"enabled":false}', { mode: 0o600 });
      const behavior = path.join(directory, 'athena-behavior.toml');
      await writeFile(
        behavior,
        '[tabs]\ngrouping = "explicit"\n[scripts]\nisolated_world = true\n',
        { mode: 0o600 },
      );
      const config = path.join(directory, 'athena-server.json');
      await writeFile(
        config,
        JSON.stringify({
          ports: { server: port, cdp: Number(endpoint.port) },
          directories: { resources },
          flags: { devMode: true },
          instance: { browseros_version: browserVersion },
          replay: { retentionDays: 7 },
        }),
        { mode: 0o600 },
      );
      controller.signal.throwIfAborted();
      this.baseUrl = `http://127.0.0.1:${port}`;
      const child = spawn(path.join(resources, 'bin/browseros-claw-server'), ['--config', config], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          LANG: process.env.LANG || 'en_US.UTF-8',
          BROWSERCLAW_DIR: directory,
          BROWSERCLAW_CONFIG_FILE: behavior,
        },
      });
      this.process = child;
      child.stdout?.resume();
      child.stderr?.resume();
      let failed: Error | undefined;
      child.on('error', (error) => {
        failed = error;
      });
      child.on('exit', () => {
        if (generation !== this.generation) return;
        this.update({
          status: 'error',
          version: NEO_SERVER_VERSION,
          error: 'Neo 控制连接已断开，请重新连接',
        });
        this.options.onDisconnect();
      });
      const deadline = Date.now() + 15_000;
      let ready = false;
      while (Date.now() < deadline) {
        controller.signal.throwIfAborted();
        if (failed || child.exitCode !== null) throw failed ?? new Error('Neo 控制组件无法启动');
        try {
          ready = (
            await fetch(this.baseUrl + '/system/ready', { signal: AbortSignal.timeout(1000) })
          ).ok;
        } catch {
          /* Wait for this owned process to bind. */
        }
        if (ready) break;
        await delay(50);
      }
      if (!ready) throw new Error('Neo 控制连接超时');
      const session = await this.newSession();
      try {
        this.tools = await session.tools();
      } finally {
        await session.close();
      }
      controller.signal.throwIfAborted();
      this.update({ status: 'ready', version: NEO_SERVER_VERSION });
    } catch (error) {
      if (generation === this.generation) {
        this.generation++;
        this.process?.kill('SIGTERM');
        this.process = undefined;
        this.update({
          status: 'error',
          version: NEO_SERVER_VERSION,
          error: error instanceof Error ? error.message : 'Neo 连接失败',
        });
      }
      throw error;
    }
  }
  async newSession(): Promise<NeoMcpSession> {
    if (!this.baseUrl) throw new Error('Neo 控制服务未连接');
    const session = new NeoMcpSession(this.baseUrl);
    await session.initialize();
    return session;
  }
  private async api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
    if (!this.baseUrl || !this.process || this.process.exitCode !== null)
      throw new Error('Neo 控制服务未连接');
    const response = await fetch(this.baseUrl + route, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Neo 记录请求失败（${response.status}）`);
    return response.json() as Promise<T>;
  }
  async records(): Promise<NeoSessionSummary[]> {
    return (await this.api<{ items: NeoSessionSummary[] }>('/api/v1/sessions')).items;
  }
  detail(id: string): Promise<NeoSessionDetail> {
    return this.api('/api/v1/sessions/' + encodeURIComponent(id));
  }
  cancel(id: string): Promise<unknown> {
    return this.api('/api/v1/sessions/' + encodeURIComponent(id) + '/cancel', 'POST');
  }
  resolveHelp(id: string): Promise<{ resolved: boolean }> {
    return this.api('/api/v1/sessions/' + encodeURIComponent(id) + '/help/resolve', 'POST', {});
  }
  async stop(): Promise<void> {
    this.generation++;
    this.abort?.abort();
    const child = this.process;
    this.process = undefined;
    this.baseUrl = '';
    this.tools = [];
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(2000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    this.update({ status: 'stopped' });
  }
}
