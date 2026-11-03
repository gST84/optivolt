import { supervisorToken } from '../../env.ts';

/** A state change of a watched entity. */
export interface LiveStateChange {
  entityId: string;
  state: string;
  attributes: Record<string, unknown>;
  changedAtMs: number;
}

type WebSocketLike = {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

export interface HaLiveOptions {
  haUrl: string;
  haToken: string;
  /** Injectable for tests. */
  createSocket?: (url: string) => WebSocketLike;
  /** Reconnect delays grow from this to maxBackoffMs. */
  backoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * One long-lived Home Assistant WebSocket connection for state changes of a set of entities, for
 * the real-time controller (the planner keeps using REST). Reconnects with growing back-off and
 * re-subscribes after every reconnect. In add-on mode it goes through the Supervisor proxy.
 */
export class HaLiveConnection {
  private socket: WebSocketLike | null = null;
  private entityIds: string[] = [];
  private listeners = new Set<(change: LiveStateChange) => void>();
  private nextId = 1;
  private retryMs: number;
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 'connecting' | 'connected' | 'disconnected', for status reporting. */
  status: 'connecting' | 'connected' | 'disconnected' = 'disconnected';
  lastError: string | null = null;

  constructor(private readonly options: HaLiveOptions) {
    this.retryMs = options.backoffMs ?? 1000;
  }

  /** Watch these entities (replaces the previous set; re-subscribes when connected). */
  watch(entityIds: string[]): void {
    this.entityIds = [...new Set(entityIds)].sort();
    if (this.status === 'connected') this.subscribe();
  }

  onChange(listener: (change: LiveStateChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.socket?.close();
    this.socket = null;
    this.status = 'disconnected';
  }

  private url(): string {
    return supervisorToken() ? 'ws://supervisor/core/websocket' : this.options.haUrl;
  }

  private connect(): void {
    this.status = 'connecting';
    const create = this.options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
    let socket: WebSocketLike;
    try {
      socket = create(this.url());
    } catch (err) {
      this.lastError = (err as Error).message;
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onmessage = (event) => this.handle(event.data);
    socket.onerror = (event) => { this.lastError = (event as { message?: string })?.message ?? 'WebSocket error'; };
    socket.onclose = () => {
      this.socket = null;
      this.status = 'disconnected';
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, this.options.maxBackoffMs ?? 60000);
    this.timer = setTimeout(() => { this.timer = null; if (!this.stopped) this.connect(); }, delay);
  }

  private subscribe(): void {
    if (!this.socket || this.entityIds.length === 0) return;
    this.socket.send(JSON.stringify({
      id: this.nextId++,
      type: 'subscribe_trigger',
      trigger: { platform: 'state', entity_id: this.entityIds },
    }));
  }

  private handle(raw: unknown): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === 'auth_required') {
      this.socket?.send(JSON.stringify({ type: 'auth', access_token: supervisorToken() ?? this.options.haToken }));
    } else if (msg.type === 'auth_ok') {
      this.status = 'connected';
      this.lastError = null;
      this.retryMs = this.options.backoffMs ?? 1000;
      this.subscribe();
    } else if (msg.type === 'auth_invalid') {
      this.lastError = `authentication failed: ${String(msg.message ?? '')}`;
      this.socket?.close();
    } else if (msg.type === 'event') {
      const to = ((msg.event as Record<string, unknown>)?.variables as Record<string, unknown>)?.trigger as Record<string, unknown> | undefined;
      const state = to?.to_state as { entity_id?: string; state?: string; attributes?: Record<string, unknown>; last_changed?: string } | undefined;
      if (!state?.entity_id) return;
      const change: LiveStateChange = {
        entityId: state.entity_id,
        state: String(state.state ?? ''),
        attributes: state.attributes ?? {},
        changedAtMs: new Date(state.last_changed ?? Date.now()).getTime(),
      };
      for (const listener of this.listeners) listener(change);
    }
  }
}
