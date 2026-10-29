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
  Play,
  RefreshCw,
  Square,
  X,
} from 'lucide-react';
import type {
  BrowserFrame,
  BrowserInput,
  BrowserState,
  RecordedStep,
  Recording,
} from '../shared/types';

interface Props {
  state: BrowserState;
  recordings: Recording[];
  liveSteps: RecordedStep[];
  onAction: <T = unknown>(action: string, payload?: unknown) => Promise<T>;
  onOpenSettings: () => void;
  onAnalyze: (id: string) => void;
  onClose: () => void;
  initialFrame?: BrowserFrame;
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
  initialFrame,
}: Props) {
  const [url, setUrl] = useState(state.url);
  const [mode, setMode] = useState<'page' | 'recordings'>('page');
  const [recordingId, setRecordingId] = useState<string>();
  const image = useRef<HTMLImageElement>(null);
  const lastFrame = useRef(initialFrame?.data || '');
  const surface = useRef<HTMLDivElement>(null);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const address = useRef<HTMLInputElement>(null);
  const viewport = useRef({
    width: initialFrame?.width || 960,
    height: initialFrame?.height || 720,
  });
  const composing = useRef(false);
  const compositionCommit = useRef<{ value: string; time: number } | undefined>(undefined);
  const pointerFrame = useRef<number>(0);
  const busy = state.status === 'starting' || state.loading;
  const ready = state.status === 'ready';
  const recording = recordings.find((item) => item.id === recordingId) || recordings[0];
  const sendInput = (input: BrowserInput) => {
    if (ready) void window.workbench.invoke('browser:input', input).catch(() => {});
  };

  useEffect(() => {
    if (document.activeElement !== address.current)
      setUrl(state.url === 'about:blank' ? '' : state.url);
  }, [state.url]);
  useEffect(
    () =>
      window.workbench.onEvent((event) => {
        if (event.type === 'browser:frame') {
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
    if (!surface.current || mode !== 'page' || !ready) return;
    let timer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver((entries) => {
      clearTimeout(timer);
      const bounds = entries[0].contentRect;
      timer = setTimeout(() => {
        if (bounds.width > 100 && bounds.height > 100)
          void window.workbench
            .invoke('browser:resize', {
              width: Math.floor(bounds.width),
              height: Math.floor(bounds.height),
            })
            .catch(() => {});
      }, 120);
    });
    observer.observe(surface.current);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [mode, ready]);
  useEffect(() => {
    const node = surface.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      if (!ready) return;
      event.preventDefault();
      const bounds = node.getBoundingClientRect();
      sendInput({
        type: 'wheel',
        x: ((event.clientX - bounds.left) * viewport.current.width) / bounds.width,
        y: ((event.clientY - bounds.top) * viewport.current.height) / bounds.height,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        modifiers: modifiers(event),
      });
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, [ready, mode]);

  const point = (event: React.MouseEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) * viewport.current.width) / bounds.width,
      y: ((event.clientY - bounds.top) * viewport.current.height) / bounds.height,
    };
  };
  const pointer = (event: React.MouseEvent<HTMLDivElement>, action: 'move' | 'down' | 'up') => {
    if (!ready || event.target === keyboard.current) return;
    if (action === 'down') {
      event.preventDefault();
      keyboard.current?.focus({ preventScroll: true });
    }
    const data: BrowserInput = {
      type: 'mouse',
      action,
      ...point(event),
      button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left',
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
          <button aria-label="打开网页" title="打开网页" type="submit">
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
            className={`subtle-button ${state.inspecting ? 'selected' : ''}`}
            disabled={!ready}
            onClick={() => {
              setMode('page');
              void onAction('browser:inspect', { enabled: !state.inspecting });
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
              点击页面元素，将它带入对话
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
            />
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
              }}
              onCompositionEnd={(event) => {
                composing.current = false;
                compositionCommit.current = { value: event.data, time: Date.now() };
                sendInput({ type: 'text', text: event.data });
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
            {state.inspecting && <span className="status-right">选择元素</span>}
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
    </section>
  );
}
