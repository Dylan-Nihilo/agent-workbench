import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TurnNotifications } from '../src/main/notifications.ts';
import type { AgentEvent } from '../src/shared/types.ts';

const approval: AgentEvent = {
  type: 'approval',
  request: { id: 'a1', title: '允许修改文件？', detail: 'private command', kind: 'file' },
};

function fixture(source: 'desktop' | 'feishu' = 'desktop') {
  const sent: { id: string; text: string }[] = [];
  let failures = 0;
  const notifications = new TurnNotifications(
    { id: 'turn-one', title: '检查网页', source },
    async (id, text) => {
      sent.push({ id, text });
      return true;
    },
    () => failures++,
  );
  return { notifications, sent, failures: () => failures };
}

test('desktop approvals and final replies notify once without sending command details', async () => {
  const f = fixture();
  f.notifications.handle(approval);
  f.notifications.handle(approval);
  await f.notifications.settled();
  f.notifications.handle({ type: 'complete', text: '页面检查完成' });
  f.notifications.handle({ type: 'complete', text: 'duplicate' });
  await f.notifications.settled();
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[0].text, /需要你审核/);
  assert.doesNotMatch(f.sent[0].text, /private command/);
  assert.match(f.sent[1].text, /页面检查完成/);
  assert.notEqual(f.sent[0].id, f.sent[1].id);
});

test('Feishu tasks receive attention notifications without duplicate final replies', async () => {
  const f = fixture('feishu');
  f.notifications.handle(approval);
  await f.notifications.settled();
  f.notifications.handle({ type: 'complete', text: 'remote result' });
  await f.notifications.settled();
  assert.equal(f.sent.length, 1);
});

test('resolved and ended requests are discarded before delivery', async () => {
  const f = fixture();
  f.notifications.handle(approval);
  f.notifications.handle({ type: 'request-resolved', id: 'a1' });
  await f.notifications.settled();
  assert.equal(f.sent.length, 0);
  f.notifications.handle({ ...approval, request: { ...approval.request, id: 'a2' } });
  f.notifications.handle({ type: 'error', message: '任务已停止' });
  await f.notifications.settled();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /任务已停止/);
});

test('question notification omits secret questions and strips access-bearing URLs', async () => {
  const f = fixture();
  f.notifications.handle({
    type: 'user-input',
    request: {
      id: 'q1',
      questions: [
        {
          id: 'choice',
          header: '选择',
          question: '选择 https://example.com/page?token=private#key',
          isSecret: false,
          options: [{ label: '继续', description: 'description' }],
        },
      ],
    },
  });
  await f.notifications.settled();
  assert.match(f.sent[0].text, /需要你的回答/);
  assert.match(f.sent[0].text, /https:\/\/example.com\/page/);
  assert.match(f.sent[0].text, /继续/);
  assert.doesNotMatch(f.sent[0].text, /secret content|token=|#key/);
  f.notifications.handle({
    type: 'user-input',
    request: {
      id: 'secret-request',
      questions: [{ id: 'secret', header: 'Secret', question: 'secret content', isSecret: true }],
    },
  });
  await f.notifications.settled();
  f.notifications.handle({
    type: 'user-input',
    request: {
      id: 'followup',
      questions: [
        {
          id: 'confirm',
          header: '确认',
          question: '继续使用 secret answer？',
          isSecret: false,
          options: [{ label: '使用 secret answer', description: 'private' }],
        },
      ],
    },
  });
  await f.notifications.settled();
  assert.doesNotMatch(f.sent[1].text, /secret content/);
  assert.doesNotMatch(f.sent[2].text, /secret answer/);
  f.notifications.handle({ type: 'complete', text: 'secret answer echoed by Agent' });
  await f.notifications.settled();
  assert.doesNotMatch(f.sent[3].text, /secret answer/);
});

test('notification failures do not throw into Agent execution or prevent later delivery', async () => {
  const sent: string[] = [];
  let failures = 0;
  const n = new TurnNotifications(
    { id: 'two', title: 'test', source: 'desktop' },
    async (_id, text) => {
      sent.push(text);
      if (sent.length === 1) throw new Error('offline');
      return true;
    },
    () => failures++,
  );
  assert.doesNotThrow(() => n.handle(approval));
  await n.settled();
  n.handle({ type: 'complete', text: 'done' });
  await n.settled();
  assert.equal(failures, 1);
  assert.equal(sent.length, 2);
});
