import { ActionButton } from './ui';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, Loader2, RefreshCw, X } from 'lucide-react';
import type { NativeNeoState, NeoSessionDetail, NeoSessionSummary } from '../shared/types';

const names: Record<string, string> = {
  snapshot: '查看页面',
  diff: '查看页面变化',
  act: '操作页面',
  read: '读取内容',
  grep: '查找内容',
  navigate: '打开网页',
  tabs: '管理标签页',
  run: '处理网页步骤',
  name_session: '开始任务',
  browser_target: '确认目标页面',
  'pages.list': '读取标签信息',
  'pages.getInfo': '确认页面',
  screenshot: '截取页面',
  pdf: '保存页面',
  download: '下载文件',
  upload: '上传文件',
  wait: '等待页面',
  evaluate_in_page: '执行页面脚本',
  request_human_help: '交给你处理',
  await_human_help: '等待你的操作',
};
function detailOf(step: NeoSessionDetail['dispatches'][number]) {
  try {
    const args = JSON.parse(step.argsJson || '{}');
    if (step.toolName === 'act')
      return (
        (
          {
            click: '点击元素',
            fill: '填写表单',
            select: '选择选项',
            press: '键盘操作',
            scroll: '滚动页面',
            type: '输入文字',
            dialog_accept: '确认页面弹窗',
            dialog_dismiss: '关闭页面弹窗',
          } as Record<string, string>
        )[args.kind] || '操作页面'
      );
  } catch {}
  return names[step.toolName] || '网页操作';
}
export function NeoHistory({
  state,
  selectedId,
  onAction,
}: {
  state?: NativeNeoState;
  selectedId?: string;
  onAction: <T = unknown>(name: string, payload?: unknown) => Promise<T>;
}) {
  const [records, setRecords] = useState<NeoSessionSummary[]>([]);
  const [selected, setSelected] = useState<string | undefined>(selectedId);
  const [detail, setDetail] = useState<NeoSessionDetail>();
  const [loading, setLoading] = useState(false);
  const revision = useRef(0);
  useEffect(() => {
    setSelected(selectedId);
  }, [selectedId]);
  const load = async () => {
    const current = ++revision.current;
    setLoading(true);
    const result = selected
      ? await onAction<NeoSessionDetail>('neo:record', { id: selected })
      : await onAction<NeoSessionSummary[]>('neo:records');
    if (current !== revision.current) return;
    if (selected) setDetail(result as NeoSessionDetail | undefined);
    else if (result)
      setRecords((result as NeoSessionSummary[]).filter((item) => item.dispatchCount > 0));
    setLoading(false);
  };
  useEffect(() => {
    setDetail(undefined);
    if (state?.status !== 'ready') return;
    void load();
    return () => {
      revision.current++;
    };
  }, [selected, state?.status]);
  return (
    <div className="recordings-view neo-history">
      <div className="recording-header">
        <div>
          <span className="eyebrow">网页任务</span>
          <h3>{selected ? '执行过程' : 'Neo 任务记录'}</h3>
          <p>查看网页任务实际执行过的操作。</p>
        </div>
        <ActionButton
          className="icon-button"
          aria-label="刷新 Neo 记录"
          isDisabled={loading || state?.status !== 'ready'}
          onPress={() => void load()}
        >
          <RefreshCw size={16} className={loading ? 'spin' : ''} />
        </ActionButton>
      </div>
      {state?.status !== 'ready' ? (
        <div className="recording-empty">
          <p>{state?.status === 'starting' ? '正在连接 Neo…' : 'Neo 暂未连接'}</p>
          <ActionButton className="secondary-button" onPress={() => void onAction('neo:connect')}>
            重新连接
          </ActionButton>
        </div>
      ) : selected ? (
        <>
          <ActionButton className="text-button neo-back" onPress={() => setSelected(undefined)}>
            <ArrowLeft size={13} />
            全部任务
          </ActionButton>
          {loading && !detail ? (
            <Loader2 className="spin" size={20} />
          ) : detail ? (
            <>
              <p className="neo-session-meta">
                {new Date(detail.session.startedAt).toLocaleString('zh-CN')} ·{' '}
                {detail.session.status === 'cancelled' ? '已停止' : '已记录'}
              </p>
              <ol className="step-list">
                {detail.dispatches
                  .filter((step) => !step.parentDispatchId)
                  .map((step, index) => {
                    let failed = false;
                    try {
                      failed = Boolean(JSON.parse(step.resultMeta || '{}').isError);
                    } catch {}
                    return (
                      <li key={step.dispatchId}>
                        <span className="step-index">{index + 1}</span>
                        <div>
                          <strong>{detailOf(step)}</strong>
                          {step.title && <span className="step-target">{step.title}</span>}
                          <span className="step-meta">
                            {step.durationMs === undefined
                              ? '处理中'
                              : `${(step.durationMs / 1000).toFixed(2)}s`}
                          </span>
                          <details className="neo-step-detail">
                            <summary>操作详情</summary>
                            <pre>{step.argsJson || '—'}</pre>
                          </details>
                        </div>
                        {failed ? <X size={13} /> : <Check size={13} className="step-check" />}
                      </li>
                    );
                  })}
              </ol>
            </>
          ) : (
            <p className="empty-detail">记录暂不可用，请刷新重试。</p>
          )}
        </>
      ) : records.length ? (
        <div className="neo-session-list">
          {records.map((record) => (
            <ActionButton key={record.sessionId} onPress={() => setSelected(record.sessionId)}>
              <strong>{record.name || '网页任务'}</strong>
              <span>
                {record.site || '浏览器'} · {record.dispatchCount} 次工具调用
              </span>
              <small>{new Date(record.startedAt).toLocaleString('zh-CN')}</small>
            </ActionButton>
          ))}
        </div>
      ) : (
        <div className="recording-empty">
          <h3>还没有网页任务</h3>
          <p>让 Agent 在网页中完成一件事，执行过程会保存在这里。</p>
        </div>
      )}
    </div>
  );
}
