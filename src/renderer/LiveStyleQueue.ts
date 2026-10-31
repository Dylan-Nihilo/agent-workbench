import type { ElementEditResult } from '../shared/types';

/** One in-flight write, one latest pending patch, and one undo entry per gesture. */
export class LiveStyleQueue {
  private pending: Record<string, string> = {};
  private editId?: string;
  private running?: Promise<void>;
  private frame?: number;
  private finishing = false;
  private closed = false;
  constructor(
    private ref: string,
    private action: <T>(name: string, payload: unknown) => Promise<T>,
    private committed: (result: ElementEditResult) => void,
    private failed: (message: string) => void,
  ) {}
  get busy() {
    return Boolean(this.running || this.frame || Object.keys(this.pending).length);
  }
  enqueue(property: string, value: string) {
    if (this.closed) return;
    this.pending[property] = value;
    if (!this.frame && !this.running)
      this.frame = requestAnimationFrame(() => {
        this.frame = undefined;
        void this.drain();
      });
  }
  finish() {
    if (this.closed) return Promise.resolve();
    this.finishing = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    return this.drain();
  }
  dispose() {
    this.closed = true;
    this.pending = {};
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = undefined;
  }
  private drain(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        while (!this.closed) {
          if (Object.keys(this.pending).length) {
            const styles = this.pending;
            this.pending = {};
            const result = await this.action<{ editId: string }>('browser:preview-styles', {
              ref: this.ref,
              styles,
              editId: this.editId,
            });
            if (!result) throw new Error('预览未应用，请重新选取元素');
            this.editId = result.editId;
          } else if (this.finishing && this.editId) {
            this.finishing = false;
            const result = await this.action<ElementEditResult>('browser:commit-styles', {
              ref: this.ref,
              editId: this.editId,
            });
            this.editId = undefined;
            if (!result) throw new Error('预览回读失败，请检查页面后重试');
            if (!this.closed) this.committed(result);
          } else {
            this.finishing = false;
            break;
          }
        }
      } catch (error) {
        this.pending = {};
        this.finishing = false;
        if (!this.closed) this.failed(error instanceof Error ? error.message : '预览失败');
      }
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
}
