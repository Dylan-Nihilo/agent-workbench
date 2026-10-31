import { RadioGroup, Radio, Input, TextArea } from '@heroui/react';
import { ActionButton } from './ui';
import { useEffect, useRef, useState } from 'react';
import { MessageSquare, ShieldCheck } from 'lucide-react';
import type { PendingAgentRequest } from '../shared/types';

export function RequestPanel({
  pending,
  taskTitle,
  onRespond,
  onStop,
  onShowTask,
}: {
  pending: PendingAgentRequest;
  taskTitle: string;
  onRespond: (action: string, payload: unknown) => Promise<boolean>;
  onStop: () => void;
  onShowTask: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, { selected?: number; text?: string }>>({});
  const [sending, setSending] = useState(false);
  const form = useRef<HTMLDivElement>(null);
  useEffect(() => {
    form.current?.querySelector<HTMLElement>('input, textarea')?.focus();
  }, []);
  const respond = async (action: string, value: Record<string, unknown>) => {
    setSending(true);
    try {
      await onRespond(action, {
        id: pending.request.id,
        conversationId: pending.conversationId,
        messageId: pending.messageId,
        ...value,
      });
    } finally {
      setSending(false);
    }
  };
  const answerFor = (
    question: Extract<PendingAgentRequest, { kind: 'input' }>['request']['questions'][number],
  ) => {
    const value = answers[question.id];
    return (
      question.options?.[value?.selected ?? -1]?.label ??
      (question.isSecret ? value?.text : value?.text?.trim()) ??
      ''
    );
  };
  return (
    <div
      ref={form}
      className="approval-card request-panel"
      role="region"
      aria-label="Agent 待处理事项"
    >
      <div>
        {pending.kind === 'approval' ? <ShieldCheck size={17} /> : <MessageSquare size={17} />}
        <strong>{pending.kind === 'approval' ? pending.request.title : '需要你的回答'}</strong>
      </div>
      <ActionButton className="request-task text-button" onPress={onShowTask}>
        {taskTitle}
      </ActionButton>
      {pending.kind === 'approval' ? (
        <>
          <pre>{pending.request.detail}</pre>
          <div className="button-row">
            <ActionButton
              className="secondary-button"
              isDisabled={sending}
              onPress={() => void respond('agent:approval', { approved: false })}
            >
              {pending.request.action === 'browser-help' ? '停止处理' : '拒绝'}
            </ActionButton>
            <ActionButton
              className="primary-button"
              isDisabled={sending}
              onPress={() => void respond('agent:approval', { approved: true })}
            >
              {pending.request.action === 'browser-help' ? '已完成，继续' : '允许这次操作'}
            </ActionButton>
          </div>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const values = Object.fromEntries(
              pending.request.questions.map((question) => [question.id, [answerFor(question)]]),
            );
            void respond('agent:user-input', { answers: values });
          }}
        >
          <div className="request-questions">
            {pending.request.questions.map((question) => {
              const value = answers[question.id] ?? {};
              const options = question.options ?? [];
              const update = (patch: { selected?: number; text?: string }) =>
                setAnswers((previous) => ({
                  ...previous,
                  [question.id]: { ...previous[question.id], ...patch },
                }));
              const freeform =
                !options.length || (question.isOther && value.selected === options.length);
              return (
                <fieldset key={question.id} disabled={sending}>
                  <legend>{question.question}</legend>
                  {!!options.length && (
                    <RadioGroup
                      aria-label={question.question}
                      value={value.selected === undefined ? null : String(value.selected)}
                      onChange={(selected) => update({ selected: Number(selected) })}
                      isDisabled={sending}
                    >
                      {options.map((option, index) => (
                        <Radio key={index} value={String(index)} className="request-option">
                          <Radio.Content>
                            <Radio.Control>
                              <Radio.Indicator />
                            </Radio.Control>
                            <span>
                              <strong>{option.label}</strong>
                              {option.description && <small>{option.description}</small>}
                            </span>
                          </Radio.Content>
                        </Radio>
                      ))}
                      {question.isOther && (
                        <Radio value={String(options.length)} className="request-option">
                          <Radio.Content>
                            <Radio.Control>
                              <Radio.Indicator />
                            </Radio.Control>
                            自行填写
                          </Radio.Content>
                        </Radio>
                      )}
                    </RadioGroup>
                  )}
                  {freeform &&
                    (question.isSecret ? (
                      <Input
                        className="request-answer"
                        type="password"
                        aria-label={question.question}
                        autoComplete="off"
                        maxLength={20_000}
                        required
                        value={value.text ?? ''}
                        onChange={(event) => update({ text: event.target.value })}
                      />
                    ) : (
                      <TextArea
                        className="request-answer"
                        aria-label={question.question}
                        rows={2}
                        maxLength={20_000}
                        required
                        value={value.text ?? ''}
                        onChange={(event) => update({ text: event.target.value })}
                      />
                    ))}
                </fieldset>
              );
            })}
          </div>
          <div className="button-row">
            <ActionButton
              type="button"
              className="secondary-button"
              isDisabled={sending}
              onPress={onStop}
            >
              停止任务
            </ActionButton>
            <ActionButton
              type="submit"
              className="primary-button"
              isDisabled={
                sending || pending.request.questions.some((question) => !answerFor(question))
              }
            >
              {sending ? '提交中…' : '提交回答'}
            </ActionButton>
          </div>
        </form>
      )}
    </div>
  );
}
