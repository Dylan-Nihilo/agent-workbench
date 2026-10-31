import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BrowserRuntime, normalizeBrowserUrl } from './browser';
import {
  NeoServer,
  type NeoMcpSession,
  type NeoPage,
  type NeoToolResult,
  type NeoDownload,
} from './neo-server';
import type { ApprovalRequest, BrowserTool, NativeNeoState, ToolResult } from '../shared/types';

const exec = promisify(execFile);
const nativeNames = new Set([
  'tabs',
  'tab_groups',
  'navigate',
  'snapshot',
  'diff',
  'act',
  'download',
  'upload',
  'read',
  'grep',
  'screenshot',
  'pdf',
  'wait',
  'evaluate_in_page',
  'run',
  'request_human_help',
  'await_human_help',
]);
const readonlyNames = new Set([
  'snapshot',
  'diff',
  'read',
  'grep',
  'screenshot',
  'pdf',
  'wait',
  'await_human_help',
]);
const editorNames = new Set([
  'workbench_browser_query',
  'workbench_browser_inspect',
  'workbench_browser_controls',
  'workbench_browser_edit',
  'workbench_browser_undo',
]);
interface Task {
  id: string;
  client: NeoMcpSession;
  readonly: boolean;
  stopped: boolean;
  help: boolean;
}
const plain = (result: NeoToolResult) =>
  result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text || '')
    .join('\n\n');
const safeError = (error: unknown) =>
  (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/gi, 'Bearer [hidden]')
    .replace(/(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, '[hidden]')
    .slice(0, 1500);

/** Reuses Neo's browser tools; only application scope and task lifecycle live here. */
export class NeoBrowserRuntime {
  readonly server: NeoServer;
  private current?: Task;
  private starting?: Promise<void>;
  private endpoint = '';
  constructor(
    private browser: BrowserRuntime,
    private options: {
      directory: string;
      download?: NeoDownload;
      onState: (state: NativeNeoState) => void;
      onDisconnect: () => void;
      approve: (request: Omit<ApprovalRequest, 'id' | 'kind'>) => Promise<boolean>;
    },
  ) {
    this.server = new NeoServer({
      directory: options.directory,
      download: options.download,
      onState: options.onState,
      onDisconnect: () => {
        if (this.current) this.current.stopped = true;
        options.onDisconnect();
      },
    });
  }
  getState() {
    return this.server.getState();
  }
  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (
      this.browser.getState().status === 'ready' &&
      this.getState().status === 'ready' &&
      this.browser.getNativeConnection().endpoint === this.endpoint
    )
      return Promise.resolve();
    this.starting = (async () => {
      await this.browser.start();
      const connection = this.browser.getNativeConnection();
      if (this.endpoint && this.endpoint !== connection.endpoint) await this.server.stop();
      this.endpoint = connection.endpoint;
      const plist = path.resolve(connection.binaryPath, '../../Info.plist');
      const { stdout } = await exec('/usr/bin/plutil', [
        '-extract',
        'CFBundleShortVersionString',
        'raw',
        '-o',
        '-',
        plist,
      ]);
      await this.server.start(connection.endpoint, stdout.trim());
    })().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  getTools(): BrowserTool[] {
    const tools: BrowserTool[] = [
      {
        name: 'neo_status',
        description: '查看当前 Neo 原生浏览器连接状态。未连接时不能声称网页操作成功。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ];
    if (this.getState().status === 'ready') {
      for (const tool of this.server.tools) {
        if (!nativeNames.has(tool.name)) continue;
        const inputSchema = structuredClone(tool.inputSchema) as any;
        if (inputSchema.properties) delete inputSchema.properties.session;
        if (Array.isArray(inputSchema.required))
          inputSchema.required = inputSchema.required.filter((name: string) => name !== 'session');
        let prefix = '由 BrowserOS neo 原生执行。';
        if (tool.name === 'run' || tool.name === 'evaluate_in_page')
          prefix +=
            '高级脚本需要用户在 Athena 确认；普通网页操作优先用 neo_act（整表 fields 批量填写）、neo_read 和 neo_wait。';
        if (tool.name === 'upload') prefix += '上传本机文件前需要用户在 Athena 确认。';
        tools.push({
          name: `neo_${tool.name}`,
          description: `${prefix}\n${tool.description}`,
          inputSchema,
        });
      }
      tools.push({
        name: 'neo_focus_page',
        description: '把指定 Neo page 显示到 Athena 当前浏览器面板；page 来自原生 tabs/snapshot。',
        inputSchema: {
          type: 'object',
          properties: { page: { type: 'integer', minimum: 1 } },
          required: ['page'],
          additionalProperties: false,
        },
      });
    }
    return [...tools, ...this.browser.getTools().filter((tool) => editorNames.has(tool.name))];
  }
  isReadOnly(name: string, args: Record<string, unknown>): boolean {
    if (name === 'neo_status') return true;
    const native = name.slice(4);
    return (
      name.startsWith('neo_') &&
      (readonlyNames.has(native) ||
        (native === 'tabs' && ['list', 'active'].includes(String(args.action))))
    );
  }
  private check(task: Task) {
    if (this.current !== task || task.stopped) throw new Error('网页任务已停止，不能继续操作');
  }
  async beginTask(id: string, readonly = false): Promise<{ sessionId: string; context: string }> {
    if (this.current) throw new Error('上一个 Neo 任务尚未结束');
    const client = await this.server.newSession();
    const task: Task = { id, client, readonly, stopped: false, help: false };
    this.current = task;
    try {
      await client.call('name_session', {
        name: 'web task',
        category: 'other',
        summary: 'Athena user-requested webpage task',
      });
      const pages = await client.pages();
      this.check(task);
      const current = pages.find((page) => page.targetId === this.browser.getState().activeTabId);
      if (!current) throw new Error('Neo 与当前可见页面尚未对应，请重试连接');
      const binding = await client.call('browser_target', {
        action: 'set_window',
        windowId: current.windowId,
        strict: true,
      });
      if (binding.isError) throw new Error(plain(binding));
      this.check(task);
      if (!readonly) await this.browser.setNativeAgentActive(true);
      return {
        sessionId: client.id,
        context: `<neo_browser_context>\n${JSON.stringify({ engine: 'BrowserOS neo', currentPage: current, pages, sessionId: client.id }).replace(/</g, '\\u003c')}\nNeo pageId 是原生页面编号，不能与 Athena 的元素 ref 或 CDP targetId 混用。先使用当前页；在需要时用 neo_tabs 新建页。网页任务使用 neo_* 原生工具。选中元素的可撤销外观预览使用 workbench_browser_query/inspect/edit/undo。\n</neo_browser_context>`,
      };
    } catch (error) {
      if (this.current === task) this.current = undefined;
      await this.server.cancel(client.id).catch(() => {});
      await client.close();
      throw error;
    }
  }
  private async page(task: Task, id: unknown): Promise<NeoPage> {
    if (!Number.isInteger(id) || Number(id) < 1) throw new Error('需要当前 Neo 页面编号');
    const pages = await task.client.pages();
    this.check(task);
    const page = pages.find((item) => item.pageId === id);
    if (!page || !this.browser.getState().tabs.some((tab) => tab.id === page.targetId))
      throw new Error('Neo 页面引用已变化，请重新读取标签页');
    return page;
  }
  private async confirm(
    task: Task,
    action: ApprovalRequest['action'],
    title: string,
    detail: string,
  ) {
    this.check(task);
    const approved = await this.options.approve({ action, title, detail });
    this.check(task);
    if (!approved) throw new Error('用户未允许这次操作');
  }
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      if (name === 'neo_status') return { text: JSON.stringify(this.getState()) };
      const task = this.current;
      if (!task) throw new Error('Neo 网页任务尚未建立');
      this.check(task);
      if (task.readonly && !this.isReadOnly(name, args))
        throw new Error('本轮只允许读取，不能操作网页');
      if (Object.hasOwn(args, 'session')) throw new Error('不能替换宿主管理的 Neo 会话');
      const native = name.slice(4);
      if (!name.startsWith('neo_') || (!nativeNames.has(native) && native !== 'focus_page'))
        throw new Error('未开放的 Neo 操作');
      if (args.url !== undefined && args.url !== null && args.url !== 'about:blank') {
        if (typeof args.url !== 'string') throw new Error('网页地址格式无效');
        normalizeBrowserUrl(args.url);
      }
      const page = args.page === undefined ? undefined : await this.page(task, args.page);
      if (native === 'focus_page') {
        await this.browser.followNativeTarget(page!.targetId);
        return { text: '已显示目标页面，请使用当前 Neo 引用继续。' };
      }
      if (native === 'run' || native === 'evaluate_in_page')
        await this.confirm(
          task,
          'browser-script',
          '运行浏览器脚本',
          `这项高级操作可使用 Neo 的页面、浏览器数据及文件传输能力。请确认脚本符合你的任务。\n\n${JSON.stringify(args, null, 2)}`,
        );
      if (native === 'upload')
        await this.confirm(
          task,
          'browser-upload',
          '上传文件到网页',
          `目标：${page ? new URL(page.url).origin : '当前网页'}\n请确认要上传的文件：\n${JSON.stringify(args, null, 2)}`,
        );
      this.check(task);
      if (native === 'request_human_help') return await this.humanHelp(task, page!, args);
      const result = await this.browser.performNative(
        page?.targetId,
        async () => {
          this.check(task);
          return task.client.call(native, args);
        },
        task.readonly,
      );
      this.check(task);
      const target = result.structuredContent?.page;
      if (!task.readonly && native === 'tabs' && args.action === 'new' && target?.targetId)
        await this.browser.followNativeTarget(target.targetId);
      const images = result.content
        .filter(
          (item) =>
            item.type === 'image' &&
            item.data &&
            /^image\/(png|jpeg|webp)$/.test(item.mimeType || ''),
        )
        .map((item) => `data:${item.mimeType};base64,${item.data}`);
      return {
        text: plain(result) || JSON.stringify(result.structuredContent ?? {}),
        ...(images.length ? { images } : {}),
        isError: result.isError || result.structuredContent?.ok === false,
      };
    } catch (error) {
      return { text: safeError(error), isError: true };
    }
  }
  private async humanHelp(
    task: Task,
    page: NeoPage,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    await this.browser.followNativeTarget(page.targetId);
    task.help = true;
    // The native request waits for the human; never hold the browser input queue while it waits.
    const pending = task.client.call('request_human_help', args).catch(() => undefined);
    try {
      const approved = await this.options.approve({
        action: 'browser-help',
        title: '请在网页完成操作',
        detail: `${String(args.reason || '请完成页面操作')}\n${String(args.details || '')}\n完成后点击“已完成，继续”。`,
      });
      this.check(task);
      if (!approved) {
        await this.cancelTask();
        throw new Error('用户停止了网页处理');
      }
      const deadline = Date.now() + 5000;
      let resolved = false;
      while (Date.now() < deadline) {
        this.check(task);
        if ((await this.server.resolveHelp(task.client.id)).resolved) {
          resolved = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      if (!resolved) throw new Error('Neo 人工协作请求未建立，请重新获取页面状态');
      const result = await pending;
      if (result?.isError) throw new Error(plain(result));
      this.check(task);
      this.browser.allowAgentControl();
      return {
        text: '用户已完成网页处理并交回控制权。请重新 snapshot 获取当前状态与新的元素引用，再验证目标结果。',
        isError: false,
      };
    } finally {
      task.help = false;
    }
  }
  isHandingOver() {
    return this.current?.help === true;
  }
  async cancelTask(): Promise<void> {
    const task = this.current;
    if (!task || task.stopped) return;
    task.stopped = true;
    await this.browser.setNativeAgentActive(false);
    try {
      await this.server.cancel(task.client.id);
    } catch {
      // A disconnected native worker cannot be trusted to stop future script steps.
      await this.server.stop();
    }
  }
  async finishTask(id: string): Promise<void> {
    const task = this.current;
    if (!task || task.id !== id) return;
    this.current = undefined;
    await this.browser.setNativeAgentActive(false);
    await task.client.close();
  }
  async stop(): Promise<void> {
    await this.cancelTask();
    if (this.current) await this.finishTask(this.current.id);
    await this.server.stop();
  }
}
