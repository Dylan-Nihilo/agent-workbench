import WebSocket from 'ws';

/** The application owns this connection; browser agents never receive its address. */
export class CdpConnection {
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private handlers = new Map<string, Array<(params: any) => void>>();
  private constructor(private socket: WebSocket) {
    socket.on('message', (raw) => {
      let message: any;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.id) {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error)
          request.reject(new Error(message.error.message || 'Browser command failed'));
        else request.resolve(message.result);
      } else if (message.method) {
        for (const handle of this.handlers.get(message.method) ?? []) handle(message.params);
      }
    });
    socket.on('close', () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('Browser connection closed'));
      }
      this.pending.clear();
      for (const handle of this.handlers.get('connection:closed') ?? []) handle({});
    });
    socket.on('error', () => {});
  }

  static connect(url: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { handshakeTimeout: 10_000, maxPayload: 32 * 1024 * 1024 });
      socket.once('open', () => resolve(new CdpConnection(socket)));
      socket.once('error', reject);
    });
  }

  call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('Browser is not connected'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser command timed out: ${method}`));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, callback: (params: any) => void): void {
    this.handlers.set(method, [...(this.handlers.get(method) ?? []), callback]);
  }

  close(): void {
    this.socket.close();
  }
}
