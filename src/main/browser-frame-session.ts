export interface BrowserChannel {
  call<T = any>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(method: string, callback: (params: any) => void): void;
}

/** A child-frame CDP session carried by its owning page connection. */
export class BrowserFrameSession implements BrowserChannel {
  private sequence = 0;
  private closed = false;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private handlers = new Map<string, Array<(params: any) => void>>();

  constructor(
    private parent: BrowserChannel,
    readonly id: string,
  ) {}

  call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Frame session has closed'));
    return new Promise<T>((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Frame command timed out: ${method}`));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      void this.parent
        .call('Target.sendMessageToTarget', {
          sessionId: this.id,
          message: JSON.stringify({ id, method, params }),
        })
        .catch((error) => {
          const request = this.pending.get(id);
          if (!request) return;
          clearTimeout(request.timer);
          this.pending.delete(id);
          request.reject(error);
        });
    });
  }

  on(method: string, callback: (params: any) => void): void {
    this.handlers.set(method, [...(this.handlers.get(method) ?? []), callback]);
  }

  receive(message: string): void {
    if (this.closed) return;
    let packet: any;
    try {
      packet = JSON.parse(message);
    } catch {
      return;
    }
    if (packet.id !== undefined) {
      const request = this.pending.get(packet.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(packet.id);
      if (packet.error) request.reject(new Error(packet.error.message || 'Frame command failed'));
      else request.resolve(packet.result);
    } else if (packet.method) {
      for (const handle of this.handlers.get(packet.method) ?? []) handle(packet.params);
    }
  }

  close(): void {
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Frame session has closed'));
    }
    this.pending.clear();
    this.handlers.clear();
  }
}
