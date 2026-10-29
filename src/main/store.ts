import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Conversation, Recording, Settings } from '../shared/types';

export interface StoredData {
  settings: Settings;
  conversations: Conversation[];
  recordings: Recording[];
}
export class Store {
  data: StoredData;
  private timer?: ReturnType<typeof setTimeout>;
  private writes = Promise.resolve();
  constructor(private directory: string) {
    this.data = {
      settings: { workspace: path.join(directory, 'workspace'), agent: 'codex' },
      conversations: [],
      recordings: [],
    };
  }
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(
        await readFile(path.join(this.directory, 'workspace.json'), 'utf8'),
      );
      if (
        !parsed?.settings ||
        typeof parsed.settings.workspace !== 'string' ||
        !Array.isArray(parsed.conversations) ||
        !Array.isArray(parsed.recordings)
      )
        throw new Error('工作区数据格式不正确');
      this.data = parsed;
      for (const conversation of this.data.conversations)
        for (const message of conversation.messages)
          if (message.status === 'streaming') message.status = 'error';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(this.data.settings.workspace, { recursive: true });
  }
  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.save().catch(() => {}), 500);
  }
  save() {
    clearTimeout(this.timer);
    const json = JSON.stringify(this.data, null, 2);
    const file = path.join(this.directory, 'workspace.json');
    this.writes = this.writes
      .catch(() => {})
      .then(async () => {
        await writeFile(`${file}.tmp`, json, { mode: 0o600 });
        await rename(`${file}.tmp`, file);
      });
    return this.writes;
  }
}
