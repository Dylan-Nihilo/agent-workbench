import { useCallback, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import {
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Command,
  Copy,
  FolderOpen,
  Globe2,
  Link2,
  Loader2,
  MessageSquare,
  MousePointer2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Square,
  Terminal,
  Unplug,
  X,
} from 'lucide-react';
import { BrowserPane } from './BrowserPane';
import type {
  AgentInfo,
  AppEvent,
  AppSnapshot,
  ApprovalRequest,
  BrowserFrame,
  BrowserState,
  ChatMessage,
  Conversation,
  ElementRef,
  FeishuState,
  RecordedStep,
  Recording,
  Settings,
} from '../shared/types';

const emptyBrowser: BrowserState = {
  status: 'starting',
  engine: 'browseros',
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  recording: false,
  inspecting: false,
};
const emptyFeishu: FeishuState = { status: 'disconnected', paired: false };
type SettingsTab = 'agent' | 'browser' | 'feishu';
function basename(value: string) {
  return value.split(/[\\/]/).filter(Boolean).pop() || '工作目录';
}
function pageSource(value: string) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}
function errorText(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,
    '',
  );
}

function ToolActivity({ tools }: { tools: NonNullable<ChatMessage['tools']> }) {
  const name = (raw: string) => {
    const names: Record<string, string> = {
      snapshot: '查看页面',
      screenshot: '截取页面',
      click: '点击元素',
      fill: '填写内容',
      select: '选择选项',
      navigate: '打开网页',
      scroll: '滚动页面',
      key: '键盘操作',
      logs: '读取页面日志',
      inspect: '检查元素',
    };
    return (
      Object.entries(names).find(([key]) => raw.includes(key))?.[1] ||
      raw.replace(/^workbench_browser_/, '')
    );
  };
  return (
    <div className="tool-activity">
      {tools.map((tool) => (
        <details className={`tool-call ${tool.status}`} key={tool.id}>
          <summary>
            {tool.status === 'running' ? (
              <Loader2 size={13} className="spin" />
            ) : tool.status === 'error' ? (
              <X size={13} />
            ) : (
              <Check size={13} />
            )}
            <span>{name(tool.name)}</span>
            <ChevronRight size={12} />
          </summary>
          <pre>{tool.output || JSON.stringify(tool.input, null, 2)}</pre>
        </details>
      ))}
    </div>
  );
}
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      className="settings-dialog"
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="dialog-content">
        <div className="dialog-heading">
          <h2>{title}</h2>
          <button className="icon-button" aria-label="关闭设置" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

export default function App() {
  const [loaded, setLoaded] = useState(false);
  const [settings, setSettings] = useState<Settings>({ workspace: '', agent: 'codex' });
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [browser, setBrowser] = useState<BrowserState>(emptyBrowser);
  const [feishu, setFeishu] = useState<FeishuState>(emptyFeishu);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string>();
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [liveSteps, setLiveSteps] = useState<RecordedStep[]>([]);
  const [draft, setDraft] = useState('');
  const [selected, setSelected] = useState<ElementRef>();
  const [sidebar, setSidebar] = useState(true);
  const [browserVisible, setBrowserVisible] = useState(false);
  const [browserWidth, setBrowserWidth] = useState(620);
  const [panelWidth, setPanelWidth] = useState(1100);
  const [resizingBrowser, setResizingBrowser] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [agentMenu, setAgentMenu] = useState(false);
  const [statusLabel, setStatusLabel] = useState('正在思考');
  const [approval, setApproval] = useState<ApprovalRequest>();
  const [toast, setToast] = useState<{ text: string; error: boolean }>();
  const [refreshing, setRefreshing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [manualAppId, setManualAppId] = useState('');
  const [manualSecret, setManualSecret] = useState('');
  const composer = useRef<HTMLTextAreaElement>(null);
  const panels = useRef<HTMLDivElement>(null);
  const resizeStart = useRef<{ x: number; width: number } | undefined>(undefined);
  const revealBrowserOnTool = useRef(true);
  const scroll = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const lastFrame = useRef<BrowserFrame | undefined>(undefined);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const conversation = conversations.find((item) => item.id === conversationId);
  const messages = conversation?.messages || [];
  const busy = conversations.some((item) =>
    item.messages.some((message) => message.status === 'streaming'),
  );
  const currentBusy = messages.some((message) => message.status === 'streaming');
  const currentAgent = agents.find((item) => item.id === settings.agent);
  const connected = feishu.status === 'connected' && feishu.paired;
  const drawerWidth = Math.round(Math.min(browserWidth, Math.max(390, panelWidth - 350)));

  const showToast = useCallback((text: string, error = false) => {
    setToast({ text, error });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(undefined), error ? 6500 : 3200);
  }, []);
  const action = useCallback(
    async <T = unknown,>(name: string, payload?: unknown): Promise<T> => {
      try {
        return await window.workbench.invoke<T>(name, payload);
      } catch (error) {
        showToast(errorText(error), true);
        return undefined as T;
      }
    },
    [showToast],
  );
  const upsert = useCallback((next: Conversation) => {
    setConversations((previous) =>
      [next, ...previous.filter((item) => item.id !== next.id)].sort(
        (a, b) => b.updatedAt - a.updatedAt,
      ),
    );
    setConversationId((previous) => previous || next.id);
  }, []);
  useEffect(() => {
    if (!window.workbench) {
      showToast('请在 Workbench 桌面应用中打开这个工作区', true);
      return;
    }
    const handle = (event: AppEvent) => {
      if (event.type === 'browser:frame') lastFrame.current = event.frame;
      else if (event.type === 'browser:state') {
        setBrowser((previous) => {
          if (event.state.recording && !previous.recording) setLiveSteps([]);
          return event.state;
        });
      } else if (event.type === 'browser:step')
        setLiveSteps((previous) => {
          const index = previous.findIndex((step) => step.id === event.step.id);
          return index < 0
            ? [...previous, event.step]
            : previous.map((step) => (step.id === event.step.id ? event.step : step));
        });
      else if (event.type === 'browser:selected') {
        setSelected(event.element);
        composer.current?.focus();
      } else if (event.type === 'recording:saved')
        setRecordings((previous) => [
          event.recording,
          ...previous.filter((item) => item.id !== event.recording.id),
        ]);
      else if (event.type === 'feishu:state') {
        setFeishu(event.state);
        if (event.state.status !== 'configuring') setConnecting(false);
      } else if (event.type === 'conversation:updated') upsert(event.conversation);
      else if (event.type === 'notice') showToast(event.message, event.level === 'error');
      else if (event.type === 'agent:event') {
        const agentEvent = event.event;
        if (agentEvent.type === 'status' && agentEvent.status === 'starting')
          revealBrowserOnTool.current = true;
        if (
          agentEvent.type === 'tool' &&
          agentEvent.call.name.startsWith('workbench_browser_') &&
          revealBrowserOnTool.current
        ) {
          setBrowserVisible(true);
          revealBrowserOnTool.current = false;
        }
        if (agentEvent.type === 'status')
          setStatusLabel(
            agentEvent.label ||
              {
                starting: '正在连接本机 Agent',
                thinking: '正在思考',
                working: '正在处理页面',
                waiting: '等待你的确认',
                idle: '',
              }[agentEvent.status],
          );
        if (agentEvent.type === 'approval') setApproval(agentEvent.request);
        if (agentEvent.type === 'complete' || agentEvent.type === 'error') setApproval(undefined);
        setConversations((previous) =>
          previous.map((item) => {
            if (item.id !== event.conversationId) return item;
            const updated = [...item.messages];
            const index = updated.findLastIndex((message) => message.role === 'assistant');
            if (index < 0) return item;
            const message = { ...updated[index], tools: [...(updated[index].tools || [])] };
            if (agentEvent.type === 'delta') message.text += agentEvent.text;
            if (agentEvent.type === 'tool') {
              const ti = message.tools.findIndex((tool) => tool.id === agentEvent.call.id);
              if (ti < 0) message.tools.push(agentEvent.call);
              else message.tools[ti] = agentEvent.call;
            }
            if (agentEvent.type === 'complete') {
              message.status = 'done';
              if (!message.text && agentEvent.text) message.text = agentEvent.text;
            }
            if (agentEvent.type === 'error') {
              message.status = 'error';
              if (!message.text) message.text = agentEvent.message;
            }
            updated[index] = message;
            return { ...item, messages: updated };
          }),
        );
      }
    };
    const unsubscribe = window.workbench.onEvent(handle);
    void window.workbench
      .invoke<AppSnapshot>('app:snapshot')
      .then((snapshot) => {
        lastFrame.current = snapshot.browserFrame;
        setSettings(snapshot.settings);
        setAgents(snapshot.agents);
        setBrowser(snapshot.browser);
        setFeishu(snapshot.feishu);
        setConversations(snapshot.conversations);
        setRecordings(snapshot.recordings);
        setConversationId(snapshot.conversations[0]?.id);
        setLoaded(true);
      })
      .catch((error) => showToast(errorText(error), true));
    return unsubscribe;
  }, [showToast, upsert]);
  useEffect(() => {
    if (stickToBottom.current)
      scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'instant' });
  }, [messages, currentBusy]);
  useEffect(() => {
    if (composer.current) {
      composer.current.style.height = 'auto';
      composer.current.style.height = `${Math.min(160, composer.current.scrollHeight)}px`;
    }
  }, [draft]);
  useEffect(() => setSelected(undefined), [browser.url]);
  useEffect(() => {
    if (!panels.current) return;
    const observer = new ResizeObserver(([entry]) => setPanelWidth(entry.contentRect.width));
    observer.observe(panels.current);
    return () => observer.disconnect();
  }, []);

  const newConversation = useCallback(async () => {
    const item = await action<Conversation>('conversation:new');
    if (item) {
      upsert(item);
      setConversationId(item.id);
      setDraft('');
      setSelected(undefined);
      stickToBottom.current = true;
      composer.current?.focus();
    }
  }, [action, upsert]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      if ((event.target as HTMLElement)?.classList.contains('browser-keyboard')) return;
      if (event.key === 'n') {
        event.preventDefault();
        void newConversation();
      }
      if (event.key === 'b') {
        event.preventDefault();
        setSidebar((value) => !value);
      }
      if (event.key === 'l') {
        event.preventDefault();
        setBrowserVisible(true);
        setTimeout(
          () => document.querySelector<HTMLInputElement>('input[aria-label="网页地址"]')?.focus(),
          30,
        );
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [newConversation]);
  const send = async () => {
    if (!draft.trim() || busy) return;
    const context = selected
      ? `用户选中了网页元素：${JSON.stringify(selected)}\n当前页面：${pageSource(browser.url)}`
      : undefined;
    const result = await action<{ conversationId: string }>('conversation:send', {
      id: conversationId,
      text: draft.trim(),
      context,
    });
    if (result) {
      setConversationId(result.conversationId);
      setDraft('');
      setSelected(undefined);
      stickToBottom.current = true;
    }
  };
  const analyze = async (id: string) => {
    const result = await action<{ conversationId: string }>('recording:analyze', { id });
    if (result) {
      setConversationId(result.conversationId);
      stickToBottom.current = true;
    }
  };
  const refreshAgents = async () => {
    setRefreshing(true);
    const result = await action<AgentInfo[]>('agents:refresh');
    if (result) setAgents(result);
    setRefreshing(false);
  };
  const workspace = async () => {
    const result = await action<Settings>('settings:workspace');
    if (result) {
      setSettings(result);
      await newConversation();
    }
  };
  const setupFeishu = async () => {
    setConnecting(true);
    const result = await action<FeishuState>('feishu:setup');
    if (result) setFeishu(result);
    setConnecting(false);
  };
  const selectBrowser = async () => {
    const result = await action<Settings>('settings:browser');
    if (result) setSettings(result);
  };
  const selectAgent = async (id: string) => {
    const result = await action<Settings>('settings:agent', { id });
    if (result) setSettings(result);
    setAgentMenu(false);
  };
  const openLink = (url: string) => void action('shell:openExternal', { url });

  return (
    <div
      className={`app-shell ${sidebar ? '' : 'sidebar-collapsed'} ${browserVisible ? '' : 'browser-collapsed'}`}
    >
      {sidebar && (
        <aside className="sidebar">
          <div className="window-drag sidebar-top">
            <button
              className="icon-button"
              title="收起侧栏 · ⌘B"
              aria-label="收起侧栏"
              onClick={() => setSidebar(false)}
            >
              <PanelLeftClose size={17} />
            </button>
          </div>
          <div className="brand">
            <span className="brand-mark">
              <Command size={18} strokeWidth={1.7} />
            </span>
            <span>Workbench</span>
          </div>
          <button className="new-conversation" onClick={() => void newConversation()}>
            <Plus size={17} />
            <span>新对话</span>
            <kbd>⌘N</kbd>
          </button>
          <button
            className="workspace-selector"
            onClick={() => void workspace()}
            title={settings.workspace}
          >
            <FolderOpen size={16} />
            <span>{basename(settings.workspace)}</span>
            <ChevronDown size={13} />
          </button>
          <div className="sidebar-section-label">对话</div>
          <nav className="conversation-list" aria-label="对话列表">
            {conversations.length ? (
              conversations.map((item) => (
                <button
                  key={item.id}
                  className={`conversation-link ${item.id === conversationId ? 'active' : ''}`}
                  onClick={() => {
                    setConversationId(item.id);
                    setSelected(undefined);
                    stickToBottom.current = true;
                  }}
                  title={item.title}
                >
                  {item.messages.some((message) => message.status === 'streaming') ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    <MessageSquare size={14} />
                  )}
                  <span>{item.title}</span>
                </button>
              ))
            ) : (
              <p className="sidebar-empty">新的对话会保存在这里</p>
            )}
          </nav>
          <div className="sidebar-bottom">
            <button className="sidebar-connection" onClick={() => setSettingsTab('feishu')}>
              <Link2 size={16} />
              <span>飞书</span>
              <span className={`connection-caption ${connected ? 'connected' : ''}`}>
                {connected ? '已连接' : feishu.status === 'connected' ? '待配对' : '连接'}
              </span>
            </button>
            <button className="sidebar-settings" onClick={() => setSettingsTab('agent')}>
              <Settings2 size={16} />
              <span>设置</span>
            </button>
            <div className="local-note">
              <span className="status-dot online" />
              <span>本机工作区</span>
            </div>
          </div>
        </aside>
      )}
      <main className="work-area">
        <header className="topbar window-drag">
          <div className={`topbar-title ${sidebar ? '' : 'with-traffic-lights'}`}>
            {!sidebar && (
              <button
                className="icon-button"
                aria-label="展开侧栏"
                onClick={() => setSidebar(true)}
              >
                <PanelLeftOpen size={17} />
              </button>
            )}
            <span>{conversation?.title || '新对话'}</span>
          </div>
          <div className="topbar-actions">
            <button
              className={`connection-button ${connected ? 'is-connected' : ''}`}
              onClick={() => setSettingsTab('feishu')}
            >
              <Link2 size={14} />
              <span>{connected ? '飞书已连接' : '连接飞书'}</span>
            </button>
            <span className="toolbar-divider" />
            <button
              className={`browser-toggle ${browserVisible ? 'is-on' : ''}`}
              aria-label={browserVisible ? '收起浏览器' : '展开浏览器'}
              title="浏览器"
              onClick={() => {
                setBrowserVisible((value) => !value);
                if (browserVisible) composer.current?.focus();
              }}
            >
              <PanelRightOpen size={18} />
              <span>浏览器</span>
            </button>
          </div>
        </header>
        <div
          ref={panels}
          className={`workspace-panels ${resizingBrowser ? 'is-resizing' : ''}`}
          style={{ '--browser-drawer-width': `${drawerWidth}px` } as React.CSSProperties}
        >
          <section className="chat-panel" aria-label="AI 对话">
            <div
              className="chat-scroll"
              ref={scroll}
              onScroll={() => {
                const node = scroll.current;
                if (node)
                  stickToBottom.current =
                    node.scrollHeight - node.scrollTop - node.clientHeight < 120;
              }}
            >
              {!messages.length ? (
                <div className="welcome">
                  <div className="welcome-symbol">
                    <Command size={25} strokeWidth={1.2} />
                  </div>
                  <h1>今天想完成什么？</h1>
                  <p>
                    打开网页、选中元素，
                    <br />
                    或录下你想复现的一段操作。
                  </p>
                  <div className="welcome-actions">
                    <button
                      onClick={() => {
                        setDraft('检查当前页面的主要内容和可交互元素。');
                        setBrowserVisible(true);
                        composer.current?.focus();
                      }}
                    >
                      <Globe2 size={16} />
                      <span>查看当前页面</span>
                      <ArrowUpRight size={14} />
                    </button>
                    <button
                      disabled={browser.status !== 'ready' || browser.recording}
                      onClick={() => {
                        setBrowserVisible(true);
                        void action('recording:start');
                      }}
                    >
                      <Circle size={15} />
                      <span>录制一段操作</span>
                      <ArrowUpRight size={14} />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="messages">
                  {messages.map((message) => (
                    <article
                      key={message.id}
                      className={`message ${message.role} ${message.status === 'error' ? 'message-error' : ''}`}
                    >
                      {message.role === 'user' ? (
                        <>
                          <div className="user-message-text">{message.text}</div>
                          {message.source === 'feishu' && (
                            <div className="message-source">
                              <Link2 size={11} />
                              来自飞书
                            </div>
                          )}
                          {message.context && message.source !== 'feishu' && (
                            <div className="message-context">
                              <MousePointer2 size={11} />
                              已附加页面上下文
                            </div>
                          )}
                        </>
                      ) : (
                        <>
                          <div className="assistant-label">
                            <Command size={14} />
                            <span>Workbench</span>
                          </div>
                          {!!message.tools?.length && <ToolActivity tools={message.tools} />}
                          {message.text && (
                            <div className="markdown">
                              <Markdown
                                components={{
                                  img: () => null,
                                  a: ({ href, children }) => (
                                    <a
                                      href={href}
                                      onClick={(event) => {
                                        event.preventDefault();
                                        if (href) openLink(href);
                                      }}
                                    >
                                      {children}
                                    </a>
                                  ),
                                }}
                              >
                                {message.text}
                              </Markdown>
                            </div>
                          )}
                          {message.status === 'streaming' && (
                            <div className="thinking-line">
                              <span className="thinking-dot" />
                              <span>{statusLabel || '正在处理'}</span>
                            </div>
                          )}
                          {message.status === 'error' && (
                            <span className="message-failure">这次任务未完成</span>
                          )}
                          {message.status === 'done' && message.text && (
                            <div className="message-actions">
                              <button
                                className="icon-button"
                                title="复制回答"
                                aria-label="复制回答"
                                onClick={() => {
                                  void action('app:copy', { text: message.text });
                                  showToast('已复制回答');
                                }}
                              >
                                <Copy size={13} />
                              </button>
                            </div>
                          )}
                        </>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </div>
            <div className="composer-area">
              {approval && (
                <div className="approval-card">
                  <div>
                    <ShieldCheck size={17} />
                    <strong>{approval.title}</strong>
                  </div>
                  <pre>{approval.detail}</pre>
                  <div className="button-row">
                    <button
                      className="secondary-button"
                      onClick={() => {
                        void action('agent:approval', { id: approval.id, approved: false });
                        setApproval(undefined);
                      }}
                    >
                      拒绝
                    </button>
                    <button
                      className="primary-button"
                      onClick={() => {
                        void action('agent:approval', { id: approval.id, approved: true });
                        setApproval(undefined);
                      }}
                    >
                      允许这次操作
                    </button>
                  </div>
                </div>
              )}
              <div className={`composer ${busy ? 'is-busy' : ''}`}>
                {selected && (
                  <div className="selected-context">
                    <MousePointer2 size={13} />
                    <span>{selected.name || selected.tag}</span>
                    <code>{selected.role || selected.tag}</code>
                    <button aria-label="移除选中元素" onClick={() => setSelected(undefined)}>
                      <X size={12} />
                    </button>
                  </div>
                )}
                <textarea
                  ref={composer}
                  aria-label="发送给 Agent 的任务"
                  placeholder={
                    selected ? '对这个元素有什么想法？' : '描述任务，或选中页面中的元素…'
                  }
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  rows={2}
                  onKeyDown={(event) => {
                    if (
                      event.key === 'Enter' &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                />
                <div className="composer-controls">
                  <div className="agent-picker-wrap">
                    <button
                      className="agent-picker"
                      aria-expanded={agentMenu}
                      onClick={() => setAgentMenu((value) => !value)}
                    >
                      <Terminal size={14} />
                      <span>{currentAgent?.name || 'Codex'}</span>
                      <span className={`status-dot ${currentAgent?.available ? 'online' : ''}`} />
                      <ChevronDown size={12} />
                    </button>
                    {agentMenu && (
                      <div className="agent-menu">
                        {agents.map((agent) => (
                          <button
                            key={agent.id}
                            disabled={!agent.available || !agent.supported || busy}
                            onClick={() => void selectAgent(agent.id)}
                          >
                            <div>
                              <strong>{agent.name}</strong>
                              <span>
                                {agent.available
                                  ? agent.supported
                                    ? agent.version || '已安装'
                                    : '已检测，暂未接入'
                                  : '未检测到'}
                              </span>
                            </div>
                            {agent.id === settings.agent && <Check size={14} />}
                          </button>
                        ))}
                        <button
                          className="agent-menu-settings"
                          onClick={() => {
                            setAgentMenu(false);
                            setSettingsTab('agent');
                          }}
                        >
                          管理本机 Agent
                          <ArrowUpRight size={13} />
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="composer-right">
                    <span className="composer-hint">
                      {busy && !currentBusy ? '另一任务进行中' : '↵ 发送'}
                    </span>
                    {busy ? (
                      <button
                        className="send-button stop-button"
                        aria-label="停止任务"
                        title="停止任务"
                        onClick={() => void action('conversation:stop')}
                      >
                        <Square size={12} fill="currentColor" />
                      </button>
                    ) : (
                      <button
                        className="send-button"
                        aria-label="发送任务"
                        disabled={!loaded || !draft.trim() || !currentAgent?.available}
                        onClick={() => void send()}
                      >
                        <ArrowUp size={18} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <div className="composer-footer">
                <FolderOpen size={11} />
                <button onClick={() => void workspace()} title={settings.workspace}>
                  {basename(settings.workspace)}
                </button>
                {browser.recording && (
                  <span className="composer-recording">
                    <span className="record-dot" />
                    录制中
                  </span>
                )}
              </div>
            </div>
          </section>
          <aside
            className={`browser-drawer ${browserVisible ? 'is-open' : ''}`}
            aria-label="浏览器侧栏"
            aria-hidden={!browserVisible}
            inert={!browserVisible}
          >
            <div
              className="browser-resizer"
              role="separator"
              aria-label="调整浏览器宽度"
              aria-orientation="vertical"
              aria-valuenow={drawerWidth}
              tabIndex={browserVisible ? 0 : -1}
              onPointerDown={(event) => {
                resizeStart.current = { x: event.clientX, width: drawerWidth };
                setResizingBrowser(true);
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (resizeStart.current)
                  setBrowserWidth(
                    Math.max(
                      390,
                      Math.min(
                        panelWidth - 350,
                        resizeStart.current.width + resizeStart.current.x - event.clientX,
                      ),
                    ),
                  );
              }}
              onPointerUp={(event) => {
                resizeStart.current = undefined;
                setResizingBrowser(false);
                event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onPointerCancel={() => {
                resizeStart.current = undefined;
                setResizingBrowser(false);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                  event.preventDefault();
                  setBrowserWidth(
                    Math.max(
                      390,
                      Math.min(
                        panelWidth - 350,
                        drawerWidth + (event.key === 'ArrowLeft' ? 30 : -30),
                      ),
                    ),
                  );
                }
              }}
            />
            <BrowserPane
              state={browser}
              recordings={recordings}
              liveSteps={liveSteps}
              initialFrame={lastFrame.current}
              onAction={action}
              onOpenSettings={() => setSettingsTab('browser')}
              onAnalyze={(id) => void analyze(id)}
              onClose={() => {
                setBrowserVisible(false);
                composer.current?.focus();
              }}
            />
          </aside>
        </div>
      </main>
      {toast && (
        <div
          className={`toast ${toast.error ? 'error' : ''}`}
          role={toast.error ? 'alert' : 'status'}
        >
          {toast.error ? <Circle size={14} /> : <Check size={14} />}
          <span>{toast.text}</span>
          <button aria-label="关闭提示" onClick={() => setToast(undefined)}>
            <X size={13} />
          </button>
        </div>
      )}
      {settingsTab && (
        <Modal title="设置与连接" onClose={() => setSettingsTab(null)}>
          <div className="settings-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={settingsTab === 'agent'}
              className={settingsTab === 'agent' ? 'active' : ''}
              onClick={() => setSettingsTab('agent')}
            >
              <Terminal size={15} />
              本机 Agent
            </button>
            <button
              role="tab"
              aria-selected={settingsTab === 'browser'}
              className={settingsTab === 'browser' ? 'active' : ''}
              onClick={() => setSettingsTab('browser')}
            >
              <Globe2 size={15} />
              浏览器
            </button>
            <button
              role="tab"
              aria-selected={settingsTab === 'feishu'}
              className={settingsTab === 'feishu' ? 'active' : ''}
              onClick={() => setSettingsTab('feishu')}
            >
              <Link2 size={15} />
              飞书
            </button>
          </div>
          <div className="settings-body">
            {settingsTab === 'agent' && (
              <>
                <div className="settings-section-heading">
                  <div>
                    <h3>使用你已有的 Agent</h3>
                    <p>读取本机安装状态。浏览器任务目前使用 Codex。</p>
                  </div>
                  <button
                    className="icon-button"
                    aria-label="刷新 Agent 列表"
                    title="刷新"
                    disabled={refreshing}
                    onClick={() => void refreshAgents()}
                  >
                    <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
                  </button>
                </div>
                <div className="agent-settings-list">
                  {agents.map((agent) => (
                    <div className="agent-setting-row" key={agent.id}>
                      <div className="integration-icon">
                        <Terminal size={19} />
                      </div>
                      <div>
                        <strong>{agent.name}</strong>
                        <p>{agent.available ? agent.version || '已安装' : '未检测到安装'}</p>
                        {agent.available && agent.path && (
                          <small title={agent.path}>{agent.path}</small>
                        )}
                      </div>
                      <span
                        className={`small-badge ${agent.available && agent.supported ? 'success' : ''}`}
                      >
                        {agent.available
                          ? agent.supported
                            ? agent.authentication === 'missing'
                              ? '需要登录'
                              : '可使用'
                            : '已检测'
                          : '未安装'}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="settings-note">
                  Codex 使用你在终端中已有的登录状态。需要登录时，在终端执行{' '}
                  <code>codex login</code>，然后刷新。
                </div>
                <button className="text-button" onClick={() => void workspace()}>
                  <FolderOpen size={14} />
                  更换工作目录
                  <ArrowUpRight size={13} />
                </button>
              </>
            )}
            {settingsTab === 'browser' && (
              <>
                <div className="integration-heading">
                  <div className="integration-icon large">
                    <Globe2 size={24} />
                  </div>
                  <div>
                    <h3>BrowserOS neo</h3>
                    <p>在当前工作区中浏览、操作和记录网页。</p>
                  </div>
                  <span className={`small-badge ${browser.status === 'ready' ? 'success' : ''}`}>
                    {browser.status === 'ready'
                      ? '已连接'
                      : browser.status === 'starting'
                        ? '连接中'
                        : '未连接'}
                  </span>
                </div>
                <div className="setting-detail">
                  <label>应用位置</label>
                  <p className="file-path">
                    {browser.binaryPath || settings.browserPath || '尚未选择 BrowserOS neo'}
                  </p>
                  <button className="secondary-button" onClick={() => void selectBrowser()}>
                    <FolderOpen size={14} />
                    选择 BrowserOS neo
                  </button>
                </div>
                {browser.error && <div className="inline-error">{browser.error}</div>}
                <div className="settings-note">
                  网页使用独立的浏览器配置，不会导入日常浏览器中的账号。需要访问受保护页面时，可以在侧边浏览器中自行登录。
                </div>
                <button className="text-button" onClick={() => openLink('https://browseros.com/')}>
                  <ArrowUpRight size={14} />
                  下载 BrowserOS neo
                </button>
              </>
            )}
            {settingsTab === 'feishu' && (
              <>
                <div className="integration-heading">
                  <div className="integration-icon large">
                    <Link2 size={24} />
                  </div>
                  <div>
                    <h3>把任务带到飞书</h3>
                    <p>私聊专用机器人，查看结果或继续当前任务。</p>
                  </div>
                  <span className={`small-badge ${connected ? 'success' : ''}`}>
                    {connected
                      ? '已配对'
                      : feishu.status === 'connected'
                        ? '等待配对'
                        : feishu.status === 'connecting'
                          ? '连接中'
                          : '未连接'}
                  </span>
                </div>
                {feishu.status === 'configuring' || feishu.setupQr ? (
                  <div className="feishu-setup">
                    {feishu.setupQr ? (
                      <img src={feishu.setupQr} alt="飞书新应用授权二维码" />
                    ) : (
                      <Loader2 size={32} className="spin" />
                    )}
                    <div>
                      <strong>使用飞书扫码</strong>
                      <p>创建专用机器人，并确认接收私聊与回复消息的权限。</p>
                      {feishu.setupUrl && (
                        <button className="text-button" onClick={() => openLink(feishu.setupUrl!)}>
                          在浏览器中打开
                          <ArrowUpRight size={13} />
                        </button>
                      )}
                      <button
                        className="text-button cancel-setup"
                        onClick={() => void action('feishu:disconnect')}
                      >
                        取消创建
                      </button>
                    </div>
                  </div>
                ) : feishu.status === 'connected' ? (
                  <div className="feishu-paired">
                    <div className="connected-check">
                      <Check size={21} />
                    </div>
                    <h4>{feishu.paired ? '飞书已准备好' : '连接已建立，再完成一次配对'}</h4>
                    {feishu.paired ? (
                      <p>
                        在与机器人的私聊中描述任务。保持 Mac 在线，Workbench
                        会在这里执行并回复结果。
                      </p>
                    ) : (
                      <>
                        <p>向新机器人私聊发送下面这条消息：</p>
                        <button
                          className="pairing-code"
                          onClick={() => {
                            void action('app:copy', { text: `绑定 ${feishu.pairingCode}` });
                            showToast('已复制配对消息');
                          }}
                        >
                          <code>绑定 {feishu.pairingCode}</code>
                          <Copy size={15} />
                        </button>
                        <small>配对后，仅接受你的任务指令。</small>
                        {feishu.appId && (
                          <button
                            className="text-button"
                            onClick={() =>
                              openLink(
                                `https://applink.feishu.cn/client/bot/open?appId=${encodeURIComponent(feishu.appId!)}`,
                              )
                            }
                          >
                            打开飞书机器人
                            <ArrowUpRight size={13} />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                ) : (
                  <div className="feishu-intro">
                    <div className="connection-path">
                      <MessageSquare size={20} />
                      <span />
                      <Command size={20} />
                    </div>
                    <p>
                      创建一个属于这个工作区的机器人，
                      <br />
                      从飞书发起网页任务。
                    </p>
                    <button
                      className="primary-button"
                      disabled={connecting || feishu.status === 'connecting'}
                      onClick={() => void setupFeishu()}
                    >
                      {connecting ? <Loader2 size={15} className="spin" /> : <Plus size={15} />}
                      创建专用机器人
                    </button>
                    {feishu.appId && (
                      <button className="text-button" onClick={() => void action('feishu:connect')}>
                        连接已保存的机器人
                      </button>
                    )}
                  </div>
                )}
                {feishu.error && <div className="inline-error">{feishu.error}</div>}
                {feishu.appId && (
                  <div className="connection-details">
                    <span>{feishu.botName || '应用 ID'}</span>
                    <code>{feishu.appId}</code>
                    {feishu.status === 'connected' && (
                      <button
                        className="text-button"
                        onClick={() => void action('feishu:disconnect')}
                      >
                        <Unplug size={13} />
                        断开连接
                      </button>
                    )}
                  </div>
                )}
                {feishu.status !== 'connected' && (
                  <details className="manual-connection">
                    <summary>
                      使用已有应用凭据
                      <ChevronDown size={14} />
                    </summary>
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void action<FeishuState>('feishu:configure', {
                          appId: manualAppId.trim(),
                          appSecret: manualSecret.trim(),
                        }).then((result) => {
                          if (result) {
                            setFeishu(result);
                            setManualSecret('');
                            void action('feishu:connect');
                          }
                        });
                      }}
                    >
                      <label>
                        App ID
                        <input
                          value={manualAppId}
                          onChange={(event) => setManualAppId(event.target.value)}
                          autoComplete="off"
                          placeholder="cli_…"
                          required
                        />
                      </label>
                      <label>
                        App Secret
                        <input
                          type="password"
                          value={manualSecret}
                          onChange={(event) => setManualSecret(event.target.value)}
                          autoComplete="new-password"
                          required
                        />
                      </label>
                      <button className="secondary-button" type="submit">
                        保存并连接
                      </button>
                    </form>
                  </details>
                )}
              </>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
