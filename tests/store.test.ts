import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/main/store';

test('workspace persists and interrupted responses do not look live after restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-store-'));
  try {
    const first = new Store(directory);
    await first.load();
    first.data.conversations.push({
      id: 'one',
      title: '工作',
      updatedAt: 1,
      messages: [
        { id: 'message', role: 'assistant', text: '尚未完成', createdAt: 1, status: 'streaming' },
      ],
    });
    await first.save();
    const second = new Store(directory);
    await second.load();
    assert.equal(second.data.conversations[0].messages[0].status, 'error');
    assert.equal(second.data.conversations[0].messages[0].text, '尚未完成');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('corrupt data is preserved instead of being silently overwritten', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-store-'));
  try {
    const file = path.join(directory, 'workspace.json');
    await writeFile(file, '{invalid');
    await assert.rejects(() => new Store(directory).load());
    assert.equal(await readFile(file, 'utf8'), '{invalid');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
