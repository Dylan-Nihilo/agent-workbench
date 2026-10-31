import { Input, TextArea, Tabs } from '@heroui/react';
import { NativeSelect } from '@heroui-pro/react';
import { ActionButton } from './ui';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ElementControlSurface } from '../shared/element-controls';
const ElementControls = lazy(() => import('./ElementControls'));
import { ArrowUpRight, Check, ChevronRight, Loader2, Search, Undo2, X } from 'lucide-react';
import type {
  ElementAnimation,
  ElementDetails,
  ElementEdit,
  ElementEditResult,
  ElementPreview,
  ElementQueryResult,
  ElementRef,
} from '../shared/types';

const fields = [
  ['font-size', '字号'],
  ['font-weight', '字重'],
  ['line-height', '行高'],
  ['color', '文字颜色'],
  ['background-color', '背景颜色'],
  ['border-radius', '圆角'],
  ['width', '宽度'],
  ['height', '高度'],
  ['padding', '内边距'],
  ['margin', '外边距'],
  ['letter-spacing', '字间距'],
  ['opacity', '透明度'],
  ['background-image', '背景 / 渐变'],
  ['box-shadow', '阴影'],
  ['transform', '变换'],
] as const;

type MotionChoice = 'none' | 'custom' | 'breathe' | 'bounce' | 'breathe-bounce';
function motionPreset(
  choice: Exclude<MotionChoice, 'none' | 'custom'>,
  duration: number,
): ElementAnimation {
  const breathe = choice !== 'bounce';
  const bounce = choice !== 'breathe';
  return {
    keyframes: [
      { offset: 0, styles: { transform: 'translateY(0px) scale(1)', opacity: '1' } },
      {
        offset: 0.5,
        styles: {
          transform: `translateY(${bounce ? '-5px' : '0px'}) scale(${breathe ? '1.04' : '1'})`,
          opacity: breathe ? '0.94' : '1',
        },
      },
      { offset: 1, styles: { transform: 'translateY(0px) scale(1)', opacity: '1' } },
    ],
    duration,
    iterations: 'infinite',
    easing: 'ease-in-out',
    direction: 'normal',
  };
}

export function ElementInspector({
  selected,
  tabId,
  previews,
  controlSurface,
  hidden,
  onAction,
  onClose,
  onSourceRequest,
}: {
  selected?: ElementRef;
  tabId?: string;
  previews: ElementPreview[];
  controlSurface?: ElementControlSurface;
  hidden?: boolean;
  onAction: <T = unknown>(action: string, payload?: unknown) => Promise<T>;
  onClose: () => void;
  onSourceRequest: (element: ElementDetails, changes?: ElementEdit) => void;
}) {
  const [loadedDetails, setDetails] = useState<ElementDetails>();
  const details = loadedDetails?.ref === selected?.ref ? loadedDetails : undefined;
  const [section, setSection] = useState<'adjust' | 'text' | 'styles' | 'motion' | 'details'>(
    'adjust',
  );
  const [searchKind, setSearchKind] = useState<'text' | 'selector'>('text');
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [results, setResults] = useState<ElementQueryResult>();
  const [text, setText] = useState('');
  const [styles, setStyles] = useState<Record<string, string>>({});
  const [motion, setMotion] = useState<MotionChoice>('none');
  const [duration, setDuration] = useState('1.8');
  const [busy, setBusy] = useState(false);
  const lastEdit = previews.at(-1);
  const [status, setStatus] = useState('');
  const request = useRef(0);
  const previousTab = useRef(tabId);
  const syncedPreview = useRef('');
  const dirtyRef = useRef(false);

  const load = (value: ElementDetails, resetSection = false) => {
    setDetails(value);
    setText(value.textContent);
    setStyles({});
    setMotion(value.animation ? 'custom' : 'none');
    setDuration(String((value.animation?.duration ?? 1800) / 1000));
    setStatus('');
    if (resetSection) setSection('adjust');
  };
  useEffect(() => {
    const current = ++request.current;
    setDetails(undefined);
    setStatus('');
    setBusy(false);
    if (previousTab.current !== tabId) {
      previousTab.current = tabId;
      setResults(undefined);
    }
    if (!selected?.ref) return;
    setBusy(true);
    void onAction<ElementDetails>('browser:element-details', { ref: selected.ref }).then(
      (value) => {
        if (current !== request.current) return;
        setBusy(false);
        if (value) load(value, true);
        else setStatus('元素已变化，请重新选取。');
      },
    );
    return () => {
      request.current++;
    };
  }, [selected?.ref, tabId, onAction]);

  useEffect(() => {
    if (controlSurface?.ref === selected?.ref) setSection('adjust');
  }, [controlSurface?.revision]);

  const originalDuration = details?.animation?.duration ?? 1800;
  const durationMs =
    duration === String(originalDuration / 1000) ? originalDuration : Number(duration) * 1000;
  const validMotion =
    motion === 'none' ||
    (duration.trim() !== '' &&
      Number.isFinite(durationMs) &&
      durationMs >= 100 &&
      durationMs <= 60_000);
  const changes = (): ElementEdit => {
    if (!details) return {};
    const changedStyles = Object.fromEntries(
      Object.entries(styles)
        .filter(([key, value]) => value.trim() !== (details.computed[key] ?? ''))
        .map(([key, value]) => [key, value.trim()]),
    );
    const animation =
      motion === 'none'
        ? null
        : motion === 'custom'
          ? details.animation
            ? { ...details.animation, duration: durationMs }
            : null
          : motionPreset(motion, durationMs);
    return {
      ...(details.editableText && text !== details.textContent ? { text } : {}),
      ...(Object.keys(changedStyles).length ? { styles: changedStyles } : {}),
      ...(validMotion && JSON.stringify(animation) !== JSON.stringify(details.animation ?? null)
        ? { animation }
        : {}),
    };
  };
  const dirty = Object.keys(changes()).length > 0;
  const hasFormDraft = Boolean(
    details &&
    ((details.editableText && text !== details.textContent) ||
      Object.entries(styles).some(([key, value]) => value !== (details.computed[key] ?? '')) ||
      motion !== (details.animation ? 'custom' : 'none') ||
      duration !== String((details.animation?.duration ?? 1800) / 1000)),
  );
  dirtyRef.current = hasFormDraft;
  const previewRevision = previews
    .filter((edit) => edit.nodeId === details?.nodeId && edit.frameId === details?.frameId)
    .map((edit) => edit.editId)
    .join('|');
  useEffect(() => {
    if (!details || busy || hasFormDraft) return;
    const signature = `${details.ref}:${previewRevision}`;
    if (syncedPreview.current === signature) return;
    syncedPreview.current = signature;
    const current = request.current;
    void window.workbench
      .invoke<ElementDetails>('browser:element-details', { ref: details.ref })
      .then((value) => {
        if (value && current === request.current && !dirtyRef.current) load(value);
      })
      .catch(() => {});
  }, [details?.ref, previewRevision, busy, hasFormDraft, onAction]);
  const sourceChanges = (): ElementEdit | undefined => {
    if (!details) return;
    const all = [
      ...previews
        .filter(
          (edit) =>
            edit.tabId === details.tabId &&
            edit.frameId === details.frameId &&
            edit.documentId === details.documentId &&
            edit.nodeId === details.nodeId,
        )
        .map((edit) => edit.changes),
      changes(),
    ];
    const combined: ElementEdit = {};
    for (const patch of all) {
      if (patch.text !== undefined) combined.text = patch.text;
      if (patch.styles) combined.styles = { ...combined.styles, ...patch.styles };
      if (patch.animation !== undefined) combined.animation = patch.animation;
    }
    return Object.keys(combined).length ? combined : undefined;
  };
  const apply = async () => {
    if (!details || !dirty || busy || !validMotion) return;
    const ref = details.ref;
    const patch = changes();
    const current = request.current;
    setBusy(true);
    const result = await onAction<ElementEditResult>('browser:edit', { ref, ...patch });
    if (current !== request.current) return;
    setBusy(false);
    if (result) {
      load(result.element);
      setStatus(
        result.element.animationState === 'reduced-motion'
          ? '样式已应用；系统减少动态效果，动效未播放。'
          : '已应用到当前页面',
      );
    }
  };
  const undo = async () => {
    if (!lastEdit || busy) return;
    const current = request.current;
    setBusy(true);
    const result = await onAction<ElementEditResult>('browser:undo', { editId: lastEdit.editId });
    if (current !== request.current) return;
    setBusy(false);
    if (result) {
      load(result.element);
      setStatus('已撤销页面修改');
    }
  };
  const select = async (ref: string) => {
    if (busy) return;
    const sameElement = ref === selected?.ref;
    const current = ++request.current;
    setResults(undefined);
    setDetails(undefined);
    setStatus('');
    setBusy(true);
    const result = await onAction<ElementDetails>('browser:element', { ref });
    if (current !== request.current) return;
    if (!result) {
      setBusy(false);
      setStatus('元素已变化，请重新查找。');
    } else if (sameElement) {
      load(result, true);
      setBusy(false);
    }
  };
  return (
    <section className="element-inspector" aria-label="元素检查器" hidden={hidden}>
      <header className="inspector-heading">
        <div className="inspector-target-summary">
          <strong title={details?.name}>{details?.name || '选择一个元素'}</strong>
          <span className="inspector-context">
            {details
              ? `${details.semantics?.kind === 'button' ? '按钮' : details.semantics?.kind === 'link' ? '链接' : details.semantics?.kind === 'textbox' ? '输入框' : details.tag}${details.semantics?.source === 'inferred' ? ' · 推断' : ''} · <${details.tag}>`
              : '在网页中选取，或按文字和 CSS 查找'}
          </span>
        </div>
        {details && (
          <ActionButton
            className={`icon-button ${searchOpen ? 'is-on' : ''}`}
            aria-label="查找其他元素"
            aria-expanded={searchOpen}
            title="查找其他元素"
            onPress={() => setSearchOpen((value) => !value)}
          >
            <Search size={15} />
          </ActionButton>
        )}
        <ActionButton
          className="icon-button"
          aria-label="关闭元素检查器"
          title="返回对话"
          onPress={onClose}
        >
          <X size={15} />
        </ActionButton>
      </header>
      <form
        hidden={Boolean(details) && !searchOpen}
        className="element-search"
        onSubmit={(event) => {
          event.preventDefault();
          if (!query.trim() || busy) return;
          setSearchOpen(true);
          const current = request.current;
          setBusy(true);
          void onAction<ElementQueryResult>('browser:query', { [searchKind]: query.trim() }).then(
            (value) => {
              if (current !== request.current) return;
              setBusy(false);
              if (value) {
                setResults(value);
                setStatus(value.elements.length ? '' : '没有找到匹配的元素');
              }
            },
          );
        }}
      >
        <Search size={13} />
        <NativeSelect>
          <NativeSelect.Trigger
            aria-label="元素查找方式"
            value={searchKind}
            onChange={(event) => setSearchKind(event.target.value as 'text' | 'selector')}
          >
            <NativeSelect.Option value="text">文字</NativeSelect.Option>
            <NativeSelect.Option value="selector">CSS</NativeSelect.Option>
          </NativeSelect.Trigger>
        </NativeSelect>
        <Input
          aria-label="查找页面元素"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={searchKind === 'text' ? '查找文字、标题或按钮' : '#title、.price、button'}
        />
        <ActionButton type="submit" isDisabled={busy || !query.trim()}>
          查找
        </ActionButton>
      </form>
      {results && (!details || searchOpen) && (
        <div className="element-results">
          <div className="element-results-heading">
            <span>
              {results.elements.length}
              {results.truncated ? '+' : ''} 个匹配
            </span>
            <ActionButton onPress={() => setResults(undefined)} aria-label="关闭查找结果">
              <X size={12} />
            </ActionButton>
          </div>
          {results.elements.map((element) => (
            <ActionButton
              key={element.ref}
              className={element.ref === details?.ref ? 'is-selected' : ''}
              onPress={() => void select(element.ref)}
            >
              <code>{element.tag}</code>
              <span>{element.name || element.text || element.selector}</span>
              <ChevronRight size={12} />
            </ActionButton>
          ))}
        </div>
      )}
      {busy && !details ? (
        <div className="inspector-empty">
          <Loader2 size={16} className="spin" />
          读取元素…
        </div>
      ) : details ? (
        <>
          <div className="element-breadcrumb" aria-label="元素层级">
            {[...details.ancestors].reverse().map((ancestor) => (
              <ActionButton
                key={ancestor.ref}
                title={ancestor.selector}
                onPress={() => void select(ancestor.ref)}
              >
                {ancestor.tag}
                <ChevronRight size={10} />
              </ActionButton>
            ))}
            <span>{details.tag}</span>
          </div>
          <Tabs
            variant="secondary"
            className="inspector-properties"
            selectedKey={section}
            onSelectionChange={(key) => setSection(key as typeof section)}
          >
            <Tabs.ListContainer className="inspector-tabs-row">
              <Tabs.List className="inspector-tabs" aria-label="元素属性">
                {(
                  [
                    ['adjust', '调整'],
                    ['text', '内容'],
                    ['styles', 'CSS'],
                    ['motion', '动效'],
                    ['details', '定位'],
                  ] as const
                ).map(([id, label]) => (
                  <Tabs.Tab key={id} id={id} aria-label={id === 'styles' ? '样式' : label}>
                    {label}
                    <Tabs.Indicator />
                  </Tabs.Tab>
                ))}
              </Tabs.List>
            </Tabs.ListContainer>
            <Tabs.Panel id={section} className="inspector-body">
              {section === 'adjust' ? (
                <Suspense fallback={<p className="inspector-note">准备调整控件…</p>}>
                  <ElementControls
                    key={details.ref + ':' + (controlSurface?.revision || 'default')}
                    element={details}
                    surface={controlSurface?.ref === details.ref ? controlSurface : undefined}
                    onAction={onAction}
                    onCommit={(result) => load(result.element)}
                  />
                </Suspense>
              ) : section === 'text' ? (
                <>
                  <label className="element-text-label" htmlFor="element-text-value">
                    元素文字
                  </label>
                  <TextArea
                    id="element-text-value"
                    aria-label="元素文字"
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    disabled={!details.editableText || busy}
                    maxLength={20_000}
                    rows={3}
                  />
                  {!details.editableText && (
                    <p className="inspector-note">
                      {details.editReason || '请选取单独的文字元素进行修改。'}
                    </p>
                  )}
                </>
              ) : section === 'styles' ? (
                <div className="style-fields">
                  {fields.map(([name, label]) => (
                    <label
                      key={name}
                      className={
                        ['background-image', 'box-shadow', 'transform'].includes(name)
                          ? 'wide'
                          : undefined
                      }
                    >
                      <span>{label}</span>
                      <Input
                        aria-label={label}
                        value={styles[name] ?? details.computed[name] ?? ''}
                        onChange={(event) =>
                          setStyles((previous) => ({ ...previous, [name]: event.target.value }))
                        }
                        disabled={busy}
                        spellCheck={false}
                        maxLength={500}
                      />
                    </label>
                  ))}
                </div>
              ) : section === 'motion' ? (
                <div className="motion-fields">
                  <label>
                    <span>动效</span>
                    <NativeSelect>
                      <NativeSelect.Trigger
                        aria-label="元素动效"
                        value={motion}
                        disabled={busy}
                        onChange={(event) => setMotion(event.target.value as MotionChoice)}
                      >
                        <NativeSelect.Option value="none">无</NativeSelect.Option>
                        {details.animation && (
                          <NativeSelect.Option value="custom">当前自定义动效</NativeSelect.Option>
                        )}
                        <NativeSelect.Option value="breathe">呼吸</NativeSelect.Option>
                        <NativeSelect.Option value="bounce">弹跳</NativeSelect.Option>
                        <NativeSelect.Option value="breathe-bounce">呼吸弹跳</NativeSelect.Option>
                      </NativeSelect.Trigger>
                    </NativeSelect>
                  </label>
                  <label>
                    <span>周期（秒）</span>
                    <Input
                      aria-label="动效周期"
                      type="number"
                      min="0.1"
                      max="60"
                      step="0.1"
                      value={duration}
                      disabled={busy || motion === 'none'}
                      onChange={(event) => setDuration(event.target.value)}
                    />
                  </label>
                  <p className="inspector-note" role="status">
                    {!validMotion
                      ? '周期应为 0.1–60 秒。'
                      : details.animationState === 'reduced-motion'
                        ? '系统已减少动态效果，动效配置保留但不播放。'
                        : details.animation
                          ? `已配置 ${details.animation.duration / 1000} 秒的动效。选择“无”并应用可停止本次预览动效。`
                          : '选择动效后应用预览，可随时撤销。'}
                  </p>
                </div>
              ) : (
                <dl className="element-locator">
                  <dt>元素语义</dt>
                  <dd>
                    {details.semantics?.kind || details.role || '未确认'}
                    {details.semantics?.source === 'inferred' ? '（推断）' : ''}
                  </dd>
                  <dt>识别依据</dt>
                  <dd>{details.semantics?.evidence.join(' · ') || '未发现明确的交互语义'}</dd>
                  {details.backendNodeId && (
                    <>
                      <dt>浏览器节点</dt>
                      <dd>{details.backendNodeId}</dd>
                    </>
                  )}

                  <dt>CSS 选择器</dt>
                  <dd>
                    <code>{details.selector}</code>
                  </dd>
                  <dt>元素引用</dt>
                  <dd>
                    <code>{details.ref}</code>
                  </dd>
                  {!!details.shadowPath.length && (
                    <>
                      <dt>Shadow 路径</dt>
                      <dd>
                        <code>{details.shadowPath.join(' → ')}</code>
                      </dd>
                    </>
                  )}
                  {details.frameId && (
                    <>
                      <dt>Frame</dt>
                      <dd>
                        <code>{details.frameId}</code>
                      </dd>
                    </>
                  )}
                  {Object.entries(details.attributes)
                    .slice(0, 8)
                    .map(([key, value]) => (
                      <div className="attribute-pair" key={key}>
                        <dt>{key}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                </dl>
              )}
            </Tabs.Panel>
          </Tabs>
          <footer className="inspector-footer">
            <ActionButton
              className="icon-button"
              title="撤销页面修改"
              aria-label="撤销页面修改"
              isDisabled={!lastEdit || busy}
              onPress={() => void undo()}
            >
              <Undo2 size={14} />
            </ActionButton>
            <ActionButton
              className="secondary-button"
              isDisabled={busy || !validMotion}
              onPress={() => onSourceRequest(details, sourceChanges())}
            >
              修改源码
              <ArrowUpRight size={12} />
            </ActionButton>
            {section !== 'adjust' && (
              <ActionButton
                className="primary-button"
                isDisabled={!dirty || busy || !validMotion}
                onPress={() => void apply()}
              >
                {busy ? <Loader2 size={13} className="spin" /> : <Check size={13} />}应用预览
              </ActionButton>
            )}
          </footer>
          <div className="inspector-note inspector-feedback" role="status">
            {status || '页面预览可撤销，刷新后恢复。'}
          </div>
        </>
      ) : (
        <div className="inspector-empty" role="status">
          <p>{status || '从网页选取文字、图片或控件，开始调整。'}</p>
          <ActionButton
            className="secondary-button"
            onPress={() => void onAction('browser:inspect', { enabled: true })}
          >
            从网页选取
          </ActionButton>
          {!!previews.length && (
            <ActionButton
              className="secondary-button"
              aria-label="撤销页面修改"
              isDisabled={busy}
              onPress={() => void undo()}
            >
              <Undo2 size={13} />
              撤销上次预览
            </ActionButton>
          )}
        </div>
      )}
    </section>
  );
}
