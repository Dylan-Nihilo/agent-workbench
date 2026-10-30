import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, ChevronRight, Code2, Loader2, Search, Undo2, X } from 'lucide-react';
import type {
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
] as const;

export function ElementInspector({
  selected,
  tabId,
  previews,
  hidden,
  onAction,
  onClose,
  onSourceRequest,
}: {
  selected?: ElementRef;
  tabId?: string;
  previews: ElementPreview[];
  hidden?: boolean;
  onAction: <T = unknown>(action: string, payload?: unknown) => Promise<T>;
  onClose: () => void;
  onSourceRequest: (element: ElementDetails, changes?: ElementEdit) => void;
}) {
  const [loadedDetails, setDetails] = useState<ElementDetails>();
  const details = loadedDetails?.ref === selected?.ref ? loadedDetails : undefined;
  const [section, setSection] = useState<'text' | 'styles' | 'details'>('text');
  const [searchKind, setSearchKind] = useState<'text' | 'selector'>('text');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ElementQueryResult>();
  const [text, setText] = useState('');
  const [styles, setStyles] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const lastEdit = previews.at(-1);
  const [status, setStatus] = useState('');
  const request = useRef(0);
  const previousTab = useRef(tabId);

  const load = (value: ElementDetails, resetSection = false) => {
    setDetails(value);
    setText(value.textContent);
    setStyles({});
    setStatus('');
    if (resetSection) setSection(value.editableText ? 'text' : 'styles');
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

  const changes = (): ElementEdit => {
    if (!details) return {};
    const changedStyles = Object.fromEntries(
      Object.entries(styles)
        .filter(([key, value]) => value.trim() !== (details.computed[key] ?? ''))
        .map(([key, value]) => [key, value.trim()]),
    );
    return {
      ...(details.editableText && text !== details.textContent ? { text } : {}),
      ...(Object.keys(changedStyles).length ? { styles: changedStyles } : {}),
    };
  };
  const dirty = Object.keys(changes()).length > 0;
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
    }
    return Object.keys(combined).length ? combined : undefined;
  };
  const apply = async () => {
    if (!details || !dirty || busy) return;
    const ref = details.ref;
    const patch = changes();
    const current = request.current;
    setBusy(true);
    const result = await onAction<ElementEditResult>('browser:edit', { ref, ...patch });
    if (current !== request.current) return;
    setBusy(false);
    if (result) {
      load(result.element);
      setStatus('已应用到当前页面');
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
        <span>
          <Code2 size={14} />
          元素
        </span>
        <span className="inspector-context">{details ? `<${details.tag}>` : '选取或查找'}</span>
        <button className="icon-button" aria-label="关闭元素检查器" onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      <form
        className="element-search"
        onSubmit={(event) => {
          event.preventDefault();
          if (!query.trim() || busy) return;
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
        <select
          aria-label="元素查找方式"
          value={searchKind}
          onChange={(event) => setSearchKind(event.target.value as 'text' | 'selector')}
        >
          <option value="text">文字</option>
          <option value="selector">CSS</option>
        </select>
        <input
          aria-label="查找页面元素"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={searchKind === 'text' ? '查找文字、标题或按钮' : '#title、.price、button'}
        />
        <button type="submit" disabled={busy || !query.trim()}>
          查找
        </button>
      </form>
      {results && (
        <div className="element-results">
          <div className="element-results-heading">
            <span>
              {results.elements.length}
              {results.truncated ? '+' : ''} 个匹配
            </span>
            <button onClick={() => setResults(undefined)} aria-label="关闭查找结果">
              <X size={12} />
            </button>
          </div>
          {results.elements.map((element) => (
            <button
              key={element.ref}
              className={element.ref === details?.ref ? 'is-selected' : ''}
              onClick={() => void select(element.ref)}
            >
              <code>{element.tag}</code>
              <span>{element.name || element.text || element.selector}</span>
              <ChevronRight size={12} />
            </button>
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
              <button
                key={ancestor.ref}
                title={ancestor.selector}
                onClick={() => void select(ancestor.ref)}
              >
                {ancestor.tag}
                <ChevronRight size={10} />
              </button>
            ))}
            <span>{details.tag}</span>
          </div>
          <div className="inspector-tabs" role="tablist" aria-label="元素属性">
            {(
              [
                ['text', '内容'],
                ['styles', '样式'],
                ['details', '定位'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={section === id}
                className={section === id ? 'active' : ''}
                onClick={() => setSection(id)}
              >
                {label}
              </button>
            ))}
            <span>
              {details.bounds
                ? `${Math.round(details.bounds.width)} × ${Math.round(details.bounds.height)}`
                : ''}
            </span>
          </div>
          <div className="inspector-body">
            {section === 'text' ? (
              <>
                <label className="element-text-label" htmlFor="element-text-value">
                  元素文字
                </label>
                <textarea
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
                  <label key={name}>
                    <span>{label}</span>
                    <input
                      aria-label={label}
                      value={styles[name] ?? details.computed[name] ?? ''}
                      onChange={(event) =>
                        setStyles((previous) => ({ ...previous, [name]: event.target.value }))
                      }
                      disabled={busy}
                      spellCheck={false}
                    />
                  </label>
                ))}
              </div>
            ) : (
              <dl className="element-locator">
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
          </div>
          <footer className="inspector-footer">
            <button
              className="icon-button"
              title="撤销页面修改"
              aria-label="撤销页面修改"
              disabled={!lastEdit || busy}
              onClick={() => void undo()}
            >
              <Undo2 size={14} />
            </button>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => onSourceRequest(details, sourceChanges())}
            >
              修改源码
              <ArrowUpRight size={12} />
            </button>
            <button
              className="primary-button"
              disabled={!dirty || busy}
              onClick={() => void apply()}
            >
              {busy ? <Loader2 size={13} className="spin" /> : <Check size={13} />}应用预览
            </button>
          </footer>
          <div className="inspector-note inspector-feedback" role="status">
            {status || '页面预览可撤销，刷新后恢复。'}
          </div>
        </>
      ) : (
        <div className="inspector-empty" role="status">
          {status || '点击“选取元素”，再点击网页中的文字、图片或控件。'}
          {!!previews.length && (
            <button
              className="secondary-button"
              aria-label="撤销页面修改"
              disabled={busy}
              onClick={() => void undo()}
            >
              <Undo2 size={13} />
              撤销上次预览
            </button>
          )}
        </div>
      )}
    </section>
  );
}
