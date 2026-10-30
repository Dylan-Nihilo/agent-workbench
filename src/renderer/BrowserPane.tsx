import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  Circle,
  Download,
  Globe2,
  Loader2,
  MousePointer2,
  PanelBottom,
  Play,
  Plus,
  RefreshCw,
  Square,
  X,
} from 'lucide-react';
import type {
  BrowserFrame,
  BrowserInput,
  BrowserState,
  BrowserViewport,
  ElementDetails,
  ElementEdit,
  RecordedStep,
  Recording,
} from '../shared/types';
import { ElementInspector } from './ElementInspector';

interface Props {
  state: BrowserState;
  recordings: Recording[];
  liveSteps: RecordedStep[];
  onAction: <T = unknown>(action: string, payload?: unknown) => Promise<T>;
  onOpenSettings: () => void;
  onAnalyze: (id: string) => void;
  onClose: () => void;
  onSourceRequest: (element: ElementDetails, changes?: ElementEdit) => void;
  initialFrame?: BrowserFrame;
  agentStatus?: string;
}
function modifiers(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}) {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}
export function BrowserPane({
  state,
  recordings,
  liveSteps,
  onAction,
  onOpenSettings,
  onAnalyze,
  onClose,
  onSourceRequest,
  initialFrame,
  agentStatus,
}: Props) {
  const [url, setUrl] = useState(state.url);
  const [mode, setMode] = useState<'page' | 'recordings'>('page');
  const [recordingId, setRecordingId] = useState<string>();
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [frameLoading, setFrameLoading] = useState(!initialFrame?.data);
  const [viewportPending, setViewportPending] = useState(false);
  const [tabBusy, setTabBusy] = useState(false);
  const [zoomModes, setZoomModes] = useState<Record<string, 'fit' | 'actual'>>({});
  const [zoomPercent, setZoomPercent] = useState(100);
  const [fitLimited, setFitLimited] = useState(false);
  const [viewportError, setViewportError] = useState(false);
  const [viewportRetry, setViewportRetry] = useState(0);
  const zoomMode = zoomModes[state.activeTabId ?? ''] ?? 'fit';
  const image = useRef<HTMLImageElement>(null);
  const lastFrame = useRef(initialFrame?.data || '');
  const activeTab = useRef(state.activeTabId);
  const surface = useRef<HTMLDivElement>(null);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const address = useRef<HTMLInputElement>(null);
  const viewport = useRef({
    width: initialFrame?.width || 960,
    height: initialFrame?.height || 720,
  });
  const decodedViewport = useRef<BrowserViewport | undefined>(undefined);
  const expectedViewport = useRef<
    (BrowserViewport & { surfaceWidth: number; surfaceHeight: number }) | undefined
  >(undefined);
  const resizeRequest = useRef(0);
  const composing = useRef(false);
  const compositionTab = useRef<string | undefined>(undefined);
  const compositionCommit = useRef<{ value: string; time: number } | undefined>(undefined);
  const pointerFrame = useRef<number>(0);
  const inspectActive = useRef(false);
  const busy = state.status === 'starting' || state.loading;
  const ready = state.status === 'ready';
  const recording = recordings.find((item) => item.id === recordingId) || recordings[0];
  const alignedViewport = () => {
    const bounds = surface.current?.getBoundingClientRect();
    const expected = expectedViewport.current;
    const bitmap = image.current;
    return Boolean(
      bounds &&
      expected &&
      bitmap?.naturalWidth &&
      Math.abs(
        bitmap.naturalWidth -
          (bitmap.naturalHeight * viewport.current.width) / viewport.current.height,
      ) <= 2 &&
      expected.tabId === activeTab.current &&
      Math.abs(expected.surfaceWidth - Math.floor(bounds.width)) <= 1 &&
      Math.abs(expected.surfaceHeight - Math.floor(bounds.height)) <= 1 &&
      Math.abs(viewport.current.width - expected.width) <= 1 &&
      Math.abs(viewport.current.height - expected.height) <= 1 &&
      decodedViewport.current?.tabId === expected.tabId &&
      decodedViewport.current?.width === viewport.current.width &&
      decodedViewport.current?.height === viewport.current.height,
    );
  };
  const sendInput = (input: BrowserInput) => {
    if (ready && !frameLoading && !viewportPending && alignedViewport())
      void window.workbench
        .invoke('browser:input', { ...input, tabId: input.tabId ?? activeTab.current })
        .catch(() => {});
  };

  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        (!state.inspecting && !inspectActive.current) ||
        document.querySelector('dialog[open]')
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      void onAction('browser:inspect', { enabled: false });
    };
    window.addEventListener('keydown', cancel, true);
    return () => window.removeEventListener('keydown', cancel, true);
  }, [state.inspecting, onAction]);
  useEffect(() => {
    if (mode !== 'page' && state.inspecting) void onAction('browser:inspect', { enabled: false });
  }, [mode, state.inspecting, onAction]);
  useEffect(() => () => cancelAnimationFrame(pointerFrame.current), []);
  useEffect(() => {
    if (document.activeElement !== address.current)
      setUrl(state.url === 'about:blank' ? '' : state.url);
  }, [state.url]);
  useEffect(() => {
    if (state.selectedElement) {
      setInspectorOpen(true);
      setMode('page');
    }
  }, [state.selectedElement?.ref]);
  useEffect(() => {
    if (state.activeTabId !== activeTab.current) {
      activeTab.current = state.activeTabId;
      lastFrame.current = '';
      decodedViewport.current = undefined;
      image.current?.removeAttribute('src');
      setFrameLoading(true);
    }
  }, [state.activeTabId]);
  useEffect(
    () =>
      window.workbench.onEvent((event) => {
        if (event.type === 'browser:state') inspectActive.current = event.state.inspecting;
        if (event.type === 'browser:state' && event.state.activeTabId !== activeTab.current) {
          activeTab.current = event.state.activeTabId;
          lastFrame.current = '';
          decodedViewport.current = undefined;
          image.current?.removeAttribute('src');
          setFrameLoading(true);
        }
        if (event.type === 'browser:frame') {
          if (event.frame.tabId && event.frame.tabId !== activeTab.current) return;
          if (!event.frame.data) {
            lastFrame.current = '';
            decodedViewport.current = undefined;
            image.current?.removeAttribute('src');
            setFrameLoading(true);
            return;
          }
          viewport.current = { width: event.frame.width, height: event.frame.height };
          lastFrame.current = event.frame.data.startsWith('data:')
            ? event.frame.data
            : `data:image/jpeg;base64,${event.frame.data}`;
          if (image.current) image.current.src = lastFrame.current;
        }
      }),
    [],
  );
  useEffect(() => {
    expectedViewport.current = undefined;
    setViewportPending(true);
    if (!surface.current || mode !== 'page' || !ready || state.loading) return;
    let timer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver((entries) => {
      clearTimeout(timer);
      const bounds = entries[0].contentRect;
      expectedViewport.current = undefined;
      setViewportPending(true);
      setViewportError(false);
      const current = ++resizeRequest.current;
      const tabId = state.activeTabId;
      timer = setTimeout(() => {
        if (bounds.width > 100 && bounds.height > 100)
          void window.workbench
            .invoke<BrowserViewport>('browser:resize', {
              width: Math.floor(bounds.width),
              height: Math.floor(bounds.height),
              fitToWidth: zoomMode === 'fit',
              tabId,
            })
            .then((value) => {
              if (
                !value ||
                current !== resizeRequest.current ||
                tabId !== activeTab.current ||
                value.tabId !== tabId
              )
                return;
              expectedViewport.current = {
                ...value,
                surfaceWidth: Math.floor(bounds.width),
                surfaceHeight: Math.floor(bounds.height),
              };
              setZoomPercent(Math.round((bounds.width / value.width) * 100));
              setFitLimited(Boolean(value.limited));
              setViewportPending(!alignedViewport());
            })
            .catch(() => {
              if (current === resizeRequest.current && tabId === activeTab.current)
                setViewportError(true);
            });
      }, 120);
    });
    observer.observe(surface.current);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
      resizeRequest.current++;
    };
  }, [mode, ready, zoomMode, state.activeTabId, state.url, state.loading, viewportRetry]);
  useEffect(() => {
    const node = surface.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      if (!ready) return;
      event.preventDefault();
      const bounds = node.getBoundingClientRect();
      const scale = viewport.current.width / bounds.width;
      sendInput({
        type: 'wheel',
        x: (event.clientX - bounds.left) * scale,
        y: (event.clientY - bounds.top) * scale,
        deltaX: (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * scale,
        deltaY: (event.shiftKey && !event.deltaX ? 0 : event.deltaY) * scale,
        modifiers: modifiers(event),
      });
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, [ready, frameLoading, viewportPending, mode]);

  const point = (event: React.MouseEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const scale = viewport.current.width / bounds.width;
    return {
      x: (event.clientX - bounds.left) * scale,
      y: (event.clientY - bounds.top) * scale,
    };
  };
  const pointer = (event: React.MouseEvent<HTMLDivElement>, action: 'move' | 'down' | 'up') => {
    if (!ready || frameLoading || viewportPending || event.target === keyboard.current) return;
    if (!alignedViewport()) return;
    if (action === 'down') {
      event.preventDefault();
      keyboard.current?.focus({ preventScroll: true });
    }
    const data: BrowserInput = {
      type: 'mouse',
      tabId: activeTab.current,
      action,
      ...point(event),
      button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left',
      buttons: event.buttons,
      clickCount: action === 'move' ? 0 : event.detail || 1,
      modifiers: modifiers(event),
    };
    if (action === 'move') {
      cancelAnimationFrame(pointerFrame.current);
      pointerFrame.current = requestAnimationFrame(() => sendInput(data));
    } else sendInput(data);
  };
  const key = (event: React.KeyboardEvent<HTMLTextAreaElement>, action: 'down' | 'up') => {
    if (
      composing.current ||
      event.nativeEvent.isComposing ||
      event.key === 'Process' ||
      event.key === 'Dead'
    )
      return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') return;
    if ((event.metaKey || event.ctrlKey) && ['l', 't', 'w'].includes(event.key.toLowerCase()))
      return;
    if (event.key === 'Tab' && event.shiftKey && event.ctrlKey) return;
    event.preventDefault();
    sendInput({
      type: 'key',
      action,
      key: event.key,
      code: event.code,
      keyCode: event.keyCode,
      modifiers: modifiers(event),
      text:
        action === 'down' &&
        event.key.length === 1 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
          ? event.key
          : undefined,
    });
  };
  const navigate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (tabBusy || !ready) return;
    const target = url.trim();
    if (!target) return;
    await onAction('browser:navigate', { url: target });
    address.current?.blur();
  };
  const toggleRecord = async () => {
    if (state.recording) {
      const saved = await onAction<Recording>('recording:stop');
      if (saved) {
        setRecordingId(saved.id);
        setMode('recordings');
      }
    } else {
      setMode('page');
      await onAction('recording:start');
    }
  };
  const newTab = async () => {
    if (tabBusy) return;
    setTabBusy(true);
    setMode('page');
    setUrl('');
    address.current?.focus();
    try {
      await onAction('browser:new-tab');
    } finally {
      setTabBusy(false);
    }
  };
  const changeTab = async (action: 'browser:switch-tab' | 'browser:close-tab', id: string) => {
    if (tabBusy) return;
    setTabBusy(true);
    setMode('page');
    try {
      await onAction(action, { id });
    } finally {
      setTabBusy(false);
    }
  };
  return (
    <section className="browser-pane" aria-label="浏览器">
      <header className="browser-heading">
        <div className="browser-heading-name">
          <Globe2 size={16} />
          <span>浏览器</span>
          <span className="engine-label">BrowserOS neo</span>
        </div>
        <button
          className="icon-button quiet"
          aria-label="收起浏览器"
          title="收起浏览器"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <div className="browser-tabbar" role="tablist" aria-label="网页标签">
        {(state.tabs ?? []).map((tab, index) => (
          <div
            className={`browser-tab ${tab.id === state.activeTabId ? 'is-active' : ''}`}
            key={tab.id}
          >
            <button
              role="tab"
              aria-selected={tab.id === state.activeTabId}
              aria-label={tab.title || '新标签页'}
              tabIndex={tab.id === state.activeTabId ? 0 : -1}
              disabled={tabBusy}
              title={tab.url === 'about:blank' ? '新标签页' : tab.url}
              onClick={() => {
                setMode('page');
                void changeTab('browser:switch-tab', tab.id);
              }}
              onKeyDown={(event) => {
                const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                if (!offset) return;
                event.preventDefault();
                const next = state.tabs[(index + offset + state.tabs.length) % state.tabs.length];
                void changeTab('browser:switch-tab', next.id);
              }}
            >
              {tab.loading ? <Loader2 size={12} className="spin" /> : <Globe2 size={12} />}
              <span>{tab.title || '新标签页'}</span>
            </button>
            <button
              className="tab-close"
              aria-label={`关闭标签 ${tab.title || '新标签页'}`}
              disabled={tabBusy}
              onClick={() => void changeTab('browser:close-tab', tab.id)}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button
          className="icon-button new-tab-button"
          aria-label="新建标签页"
          title="新建标签页 ⌘T"
          disabled={!ready || tabBusy}
          onClick={() => void newTab()}
        >
          <Plus size={15} />
        </button>
      </div>
      <div className="browser-navigation">
        <div className="nav-buttons">
          <button
            className="icon-button"
            title="后退"
            aria-label="后退"
            disabled={!ready || !state.canGoBack}
            onClick={() => void onAction('browser:back')}
          >
            <ArrowLeft size={16} />
          </button>
          <button
            className="icon-button"
            title="前进"
            aria-label="前进"
            disabled={!ready || !state.canGoForward}
            onClick={() => void onAction('browser:forward')}
          >
            <ArrowRight size={16} />
          </button>
          <button
            className="icon-button"
            title="刷新"
            aria-label="刷新"
            disabled={!ready}
            onClick={() => void onAction('browser:reload')}
          >
            <RefreshCw size={15} className={busy ? 'spin' : ''} />
          </button>
        </div>
        <form className="address-field" onSubmit={(event) => void navigate(event)}>
          <Globe2 size={13} />
          <input
            ref={address}
            aria-label="网页地址"
            placeholder="输入网址"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onFocus={(event) => event.target.select()}
            spellCheck={false}
          />
          <button aria-label="打开网页" title="打开网页" type="submit" disabled={!ready || tabBusy}>
            <ArrowUpRight size={14} />
          </button>
        </form>
      </div>
      <div className="browser-tools">
        <div className="segment-tabs">
          <button className={mode === 'page' ? 'active' : ''} onClick={() => setMode('page')}>
            网页
          </button>
          <button
            className={mode === 'recordings' ? 'active' : ''}
            onClick={() => setMode('recordings')}
          >
            操作记录{recordings.length > 0 && <span>{recordings.length}</span>}
          </button>
        </div>
        <div className="tool-buttons">
          <button
            className={`icon-button ${inspectorOpen ? 'is-on' : ''}`}
            title="元素检查器"
            aria-label="元素检查器"
            disabled={!ready}
            onClick={() => {
              setMode('page');
              setInspectorOpen((value) => !value);
            }}
          >
            <PanelBottom size={15} />
          </button>
          <button
            className={`subtle-button ${state.inspecting ? 'selected' : ''}`}
            disabled={!ready}
            onClick={() => {
              setMode('page');
              inspectActive.current = !state.inspecting;
              void onAction<boolean>('browser:inspect', { enabled: !state.inspecting }).then(
                (ok) => {
                  if (!ok) inspectActive.current = false;
                },
              );
            }}
          >
            <MousePointer2 size={14} />
            选取元素
          </button>
          <button
            className={`subtle-button ${state.recording ? 'recording' : ''}`}
            disabled={!ready}
            onClick={() => void toggleRecord()}
          >
            {state.recording ? <Square size={11} fill="currentColor" /> : <Circle size={12} />}
            <span>{state.recording ? '结束录制' : '录制'}</span>
          </button>
        </div>
      </div>
      {mode === 'page' ? (
        <div className="browser-canvas-wrap">
          {state.inspecting && (
            <div className="inspect-tip">
              <MousePointer2 size={13} />
              悬停预览，点击选中
              <kbd>Esc 取消</kbd>
              <button
                aria-label="取消选取"
                onClick={() => void onAction('browser:inspect', { enabled: false })}
              >
                <X size={13} />
              </button>
            </div>
          )}
          <div
            ref={surface}
            className={`browser-surface ${state.inspecting ? 'inspecting' : ''}`}
            onMouseDown={(event) => pointer(event, 'down')}
            onMouseUp={(event) => pointer(event, 'up')}
            onMouseMove={(event) => pointer(event, 'move')}
            onMouseLeave={() => {
              cancelAnimationFrame(pointerFrame.current);
              if (state.inspecting) sendInput({ type: 'mouse', action: 'leave', x: 0, y: 0 });
            }}
            onContextMenu={(event) => event.preventDefault()}
          >
            <img
              ref={(node) => {
                image.current = node;
                if (node && lastFrame.current) node.src = lastFrame.current;
              }}
              className="browser-frame"
              alt={state.title ? `${state.title}，可交互网页` : 'BrowserOS neo 页面'}
              draggable={false}
              onLoad={() => {
                const node = image.current;
                const source = lastFrame.current;
                const frame = { ...viewport.current, tabId: activeTab.current };
                if (!node) return;
                void node
                  .decode()
                  .then(() => {
                    if (
                      image.current !== node ||
                      lastFrame.current !== source ||
                      node.currentSrc !== source ||
                      activeTab.current !== frame.tabId
                    )
                      return;
                    if (
                      Math.abs(
                        node.naturalWidth - (node.naturalHeight * frame.width) / frame.height,
                      ) > 2
                    ) {
                      decodedViewport.current = undefined;
                      setViewportPending(true);
                      return;
                    }
                    decodedViewport.current = frame;
                    setFrameLoading(false);
                    setViewportPending(!alignedViewport());
                  })
                  .catch(() => {});
              }}
            />
            {ready && (frameLoading || viewportPending) && (
              <div className="frame-loading">
                {viewportError ? (
                  <>
                    <span>页面显示调整失败</span>
                    <button
                      className="secondary-button"
                      onClick={() => setViewportRetry((value) => value + 1)}
                    >
                      重试
                    </button>
                  </>
                ) : (
                  <>
                    <Loader2 size={19} className="spin" />
                    <span>正在显示页面</span>
                  </>
                )}
              </div>
            )}
            <textarea
              ref={keyboard}
              className="browser-keyboard"
              aria-label="网页键盘输入"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              onKeyDown={(event) => key(event, 'down')}
              onKeyUp={(event) => key(event, 'up')}
              onCompositionStart={() => {
                composing.current = true;
                compositionTab.current = activeTab.current;
              }}
              onCompositionEnd={(event) => {
                composing.current = false;
                compositionCommit.current = { value: event.data, time: Date.now() };
                sendInput({ type: 'text', text: event.data, tabId: compositionTab.current });
                event.currentTarget.value = '';
              }}
              onInput={(event) => {
                if (composing.current || (event.nativeEvent as InputEvent).isComposing) return;
                const text = event.currentTarget.value;
                const duplicate =
                  compositionCommit.current?.value === text &&
                  Date.now() - compositionCommit.current.time < 100;
                if (text && !duplicate) sendInput({ type: 'text', text });
                event.currentTarget.value = '';
              }}
              onPaste={(event) => {
                event.preventDefault();
                sendInput({ type: 'text', text: event.clipboardData.getData('text/plain') });
              }}
            />
            {!ready && (
              <div className="browser-unavailable">
                <div className="browser-unavailable-icon">
                  {state.status === 'starting' ? (
                    <Loader2 size={28} className="spin" />
                  ) : (
                    <Globe2 size={28} />
                  )}
                </div>
                <h3>
                  {state.status === 'starting'
                    ? '正在打开浏览器'
                    : state.status === 'missing'
                      ? '连接 BrowserOS neo'
                      : '浏览器尚未就绪'}
                </h3>
                <p>{state.error || '选择本机的 BrowserOS neo，即可在这里浏览和操作网页。'}</p>
                {state.status !== 'starting' && (
                  <div className="button-row">
                    <button className="primary-button" onClick={onOpenSettings}>
                      浏览器设置
                    </button>
                    <button
                      className="secondary-button"
                      onClick={() => void onAction('browser:start')}
                    >
                      重新连接
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
          {state.recording && (
            <div className="recording-strip">
              <span className="record-dot" />
              <span>正在记录操作</span>
              <span className="muted">{liveSteps.length} 步</span>
              <button onClick={() => void toggleRecord()}>结束并查看</button>
            </div>
          )}
          <div className="browser-status">
            <span className={`status-dot ${ready ? 'online' : ''}`} />
            <span>
              {ready
                ? state.title || 'BrowserOS neo 已连接'
                : state.status === 'starting'
                  ? '正在连接'
                  : '未连接'}
            </span>
            <select
              className="viewport-mode"
              aria-label="页面缩放"
              title={fitLimited ? '页面超宽，可按住 Shift 滚轮横向查看' : '选择页面显示比例'}
              value={zoomMode}
              disabled={!ready || state.loading}
              onChange={(event) => {
                if (state.activeTabId)
                  setZoomModes((previous) => ({
                    ...previous,
                    [state.activeTabId!]: event.target.value as 'fit' | 'actual',
                  }));
              }}
            >
              <option value="fit">
                适应宽度{zoomMode === 'fit' && zoomPercent < 100 ? ` · ${zoomPercent}%` : ''}
              </option>
              <option value="actual">100%</option>
            </select>
            {fitLimited && zoomMode === 'fit' && <span className="viewport-limit">可横向滚动</span>}
            {state.inspecting ? (
              <span className="status-right">选择元素</span>
            ) : agentStatus ? (
              <span className="browser-agent-status" role="status">
                <span className="thinking-dot" />
                {agentStatus}
              </span>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="recordings-view">
          {!recording ? (
            <div className="recording-empty">
              <Circle size={30} strokeWidth={1.2} />
              <h3>保留操作发生的过程</h3>
              <p>点击录制，完成一段网页操作。结束后可以交给 Agent 理解和整理。</p>
              <button
                className="secondary-button"
                disabled={!ready}
                onClick={() => void toggleRecord()}
              >
                <Circle size={13} />
                开始录制
              </button>
            </div>
          ) : (
            <>
              <div className="recording-header">
                <div>
                  <span className="eyebrow">操作记录</span>
                  <h3>{recording.title}</h3>
                  <p>
                    {recording.steps.length} 个步骤 ·{' '}
                    {new Date(recording.startedAt).toLocaleTimeString('zh-CN', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                </div>
                <button
                  className="icon-button"
                  title="导出操作记录"
                  aria-label="导出操作记录"
                  onClick={() => void onAction('recording:export', { id: recording.id })}
                >
                  <Download size={16} />
                </button>
              </div>
              {recordings.length > 1 && (
                <select
                  className="recording-select"
                  aria-label="选择操作记录"
                  value={recording.id}
                  onChange={(event) => setRecordingId(event.target.value)}
                >
                  {recordings.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title} · {item.steps.length} 步
                    </option>
                  ))}
                </select>
              )}
              <ol className="step-list">
                {recording.steps.map((step, index) => (
                  <li key={step.id}>
                    <span className="step-index">{index + 1}</span>
                    <div>
                      <strong>{step.description}</strong>
                      {step.target?.name && <span className="step-target">{step.target.name}</span>}
                      {step.value && <code>{step.value}</code>}
                      <span className="step-meta">
                        {Math.max(0, (step.timestamp - recording.startedAt) / 1000).toFixed(1)}s
                        {step.source === 'agent' ? ' · Agent' : ''}
                      </span>
                    </div>
                    <Check size={13} className="step-check" />
                  </li>
                ))}
              </ol>
              {!recording.steps.length && (
                <p className="empty-detail">这段录制没有捕获到操作。回到网页重新录制一段流程。</p>
              )}
              <div className="recording-footer">
                <button
                  className="primary-button"
                  disabled={!recording.steps.length}
                  onClick={() => onAnalyze(recording.id)}
                >
                  <Play size={14} />让 Agent 理解这段操作
                </button>
                <p>
                  {recording.summary
                    ? '已有分析结果，再次分析会创建新的对话。'
                    : '整理操作目标、关键步骤和需要确认的预期。'}
                </p>
              </div>
            </>
          )}
        </div>
      )}
      <ElementInspector
        hidden={mode !== 'page' || !inspectorOpen}
        selected={state.selectedElement}
        tabId={state.activeTabId}
        previews={state.previewEdits ?? []}
        onAction={onAction}
        onClose={() => setInspectorOpen(false)}
        onSourceRequest={onSourceRequest}
      />
    </section>
  );
}
