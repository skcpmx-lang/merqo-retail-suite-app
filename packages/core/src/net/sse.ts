import type http from 'node:http';
import type { Db } from '../db/connection.js';
import { readEvents, retentionFloor, type OutboxEvent } from '../services/events.js';

/**
 * Authenticated server-sent events (Phase 3, Milestone C; hardened in the SSE wiring pass).
 *
 * Security and lifecycle rules, all of them enforced here rather than by the caller:
 *
 *  - **No parallel auth path.** The route is inside `/api/v1`: Ed25519 device signature,
 *    approved device, session bound to that device. The hub receives an `authorize`
 *    callback that re-checks the device *and* the session on every heartbeat and every
 *    poll, so a revoked device, an expired session or a device that stopped being
 *    approved loses the stream within one interval.
 *  - **Store isolation.** The outbox read is filtered by `store_id` and every event is
 *    checked again before it is written, so a stream can never carry another shop's row.
 *  - **Monotonic ids.** The SSE `id` is the outbox `seq`; a connection never sends an id
 *    it already sent, and a resume sends only `seq > Last-Event-ID`.
 *  - **Truncated history is declared, not hidden.** If a client asks for a sequence
 *    older than what retention has kept, it receives `event: resync` with the first
 *    available id and continues from there; the caller must refetch.
 *  - **Bounded resources.** A connection that cannot keep up is closed (`slow-consumer`)
 *    once its kernel/user buffer passes a limit, the hub caps concurrent streams, and a
 *    device may hold only one stream (a second connection replaces the first).
 *  - **Clean shutdown.** `closeAll()` ends every stream with `event: closed` before the
 *    listener stops, so no client keeps reading a dead socket and no buffered events are
 *    delivered after revocation or stop.
 */

export type SseCloseReason =
  | 'revoked'
  | 'session-expired'
  | 'device-not-approved'
  | 'server-stop'
  | 'slow-consumer'
  | 'client-closed'
  | 'replaced'
  | 'error';

export interface EventStreamHubOptions {
  db: Db;
  pollMs?: number;
  heartbeatMs?: number;
  maxBatch?: number;
  /** Concurrent stream policy (see docs). Default 32. */
  maxStreams?: number;
  /** Close a connection whose unflushed buffer exceeds this. Default 1 MiB. */
  maxBufferedBytes?: number;
  /** Reconnect churn limit per device, per minute. Default 30. */
  maxOpensPerMinute?: number;

  read?: (afterSeq: number, limit: number) => OutboxEvent[];
  log?: (level: 'info' | 'warn', message: string, detail?: unknown) => void;
}

export interface OpenStreamInput {
  deviceId: string;
  storeId: string;
  res: http.ServerResponse;
  /** Resume point (exclusive). 0 = live only, from the current end of the outbox. */
  lastEventId: number;
  /** Returns a close reason when the connection is no longer allowed, null when it is. */
  authorize: () => SseCloseReason | null;
  /**
   * Per-event visibility. Returning false keeps the payload from being sent (the
   * sequence still advances so the stream cannot stall, and the client refetches).
   * Used for permission-based visibility on top of the store filter.
   */
  canSee?: (event: OutboxEvent) => boolean;
}

export interface SseStream {
  readonly deviceId: string;
  readonly lastEventId: number;
  readonly closed: boolean;
  close(reason: SseCloseReason): void;
}

export type OpenStreamResult =
  | { ok: true; stream: SseStream }
  | { ok: false; code: 'STREAM_LIMIT' | 'STREAM_RATE_LIMITED' };

export class EventStreamHub {
  private readonly streams = new Map<string, SseStream>();
  private readonly pollMs: number;
  private readonly heartbeatMs: number;
  private readonly maxBatch: number;
  private readonly maxStreams: number;
  private readonly maxBufferedBytes: number;
  private readonly read: (afterSeq: number, limit: number) => OutboxEvent[];
  private readonly maxOpensPerMinute: number;
  private readonly opens = new Map<string, number[]>();

  constructor(private readonly opts: EventStreamHubOptions) {
    this.pollMs = Math.max(20, opts.pollMs ?? 1000);
    this.heartbeatMs = Math.max(200, opts.heartbeatMs ?? 15_000);
    this.maxBatch = Math.max(1, opts.maxBatch ?? 200);
    this.maxStreams = Math.max(1, opts.maxStreams ?? 32);
    this.maxBufferedBytes = Math.max(4096, opts.maxBufferedBytes ?? 1024 * 1024);
    this.read = opts.read ?? ((after, limit) => readEvents(opts.db, after, limit));
    this.maxOpensPerMinute = Math.max(1, opts.maxOpensPerMinute ?? 30);
  }

  count(): number {
    return this.streams.size;
  }

  /** The highest sequence that retention has already removed (0 when nothing was pruned). */
  retentionFloor(): number {
    return retentionFloor(this.opts.db);
  }

  /** True when this device is allowed to open another stream right now. */
  private withinReconnectBudget(deviceId: string, now = Date.now()): boolean {
    const window = 60_000;
    const recent = (this.opens.get(deviceId) ?? []).filter((t) => now - t < window);
    if (recent.length >= this.maxOpensPerMinute) {
      this.opens.set(deviceId, recent);
      return false;
    }
    recent.push(now);
    this.opens.set(deviceId, recent);
    return true;
  }

  open(input: OpenStreamInput): OpenStreamResult {
    if (!this.withinReconnectBudget(input.deviceId)) {
      this.opts.log?.('warn', 'sse reconnect budget exceeded', { device_id: input.deviceId });
      return { ok: false, code: 'STREAM_RATE_LIMITED' };
    }
    // One stream per device: a reconnect replaces the old connection instead of
    // accumulating sockets.
    const existing = this.streams.get(input.deviceId);
    if (existing) existing.close('replaced');
    if (this.streams.size >= this.maxStreams) return { ok: false, code: 'STREAM_LIMIT' };

    const stream = this.start(input, () => {
      if (this.streams.get(input.deviceId) === stream) this.streams.delete(input.deviceId);
    });
    this.streams.set(input.deviceId, stream);
    return { ok: true, stream };
  }

  closeDevice(deviceId: string, reason: SseCloseReason = 'revoked'): void {
    this.streams.get(deviceId)?.close(reason);
  }

  closeAll(reason: SseCloseReason = 'server-stop'): void {
    for (const stream of [...this.streams.values()]) stream.close(reason);
    this.streams.clear();
  }

  private start(input: OpenStreamInput, onClosed: () => void): SseStream {
    const { res } = input;
    const log = this.opts.log;
    let lastEventId = Math.max(0, Math.floor(input.lastEventId) || 0);
    let closed = false;
    let backpressured = false;
    let poll: NodeJS.Timeout | null = null;
    let beat: NodeJS.Timeout | null = null;

    const floor = this.retentionFloor();
    const truncated = lastEventId > 0 && lastEventId < floor;

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-sauda-retention-floor': String(floor),
    });
    res.write('retry: 2000\n\n');
    if (truncated) {
      // Declare the gap instead of silently starting in the middle.
      lastEventId = floor;
      res.write(
        `event: resync\ndata: ${JSON.stringify({ reason: 'HISTORY_TRUNCATED', from: floor })}\n\n`,
      );
      log?.('warn', 'sse resume older than retained history', { device_id: input.deviceId, floor });
    }

    const stream: SseStream = {
      deviceId: input.deviceId,
      get lastEventId() {
        return lastEventId;
      },
      get closed() {
        return closed;
      },
      close(reason: SseCloseReason) {
        if (closed) return;
        closed = true;
        if (poll) clearInterval(poll);
        if (beat) clearInterval(beat);
        try {
          res.write(`event: closed\ndata: ${JSON.stringify({ reason })}\n\n`);
          res.end();
        } catch {
          /* the peer is already gone */
        }
        onClosed();
        log?.('info', 'sse closed', {
          device_id: input.deviceId,
          store_id: input.storeId,
          last_event_id: lastEventId,
          reason,
        });
      },
    };

    const write = (chunk: string): boolean => {
      if (closed) return false;
      // A peer that will not read must not grow our memory without bound.
      if (res.writableLength > this.maxBufferedBytes) {
        stream.close('slow-consumer');
        return false;
      }
      const ok = res.write(chunk);
      if (!ok) backpressured = true;
      return ok;
    };

    const send = (event: OutboxEvent): void => {
      // Defence in depth: never leak another store's event.
      if (event.store_id !== input.storeId) return;
      if (event.seq <= lastEventId) return;
      lastEventId = event.seq;
      // Permission-based visibility: the sequence still advances so the stream cannot
      // stall, but the payload is withheld from a role that may not see it.
      if (input.canSee && !input.canSee(event)) {
        this.opts.log?.('info', 'sse event withheld by permission', {
          device_id: input.deviceId,
          seq: event.seq,
          type: event.type,
        });
        return;
      }
      write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${event.payload}\n\n`);
    };

    const flush = (): void => {
      if (closed) return;
      if (backpressured) {
        // Wait for 'drain'; but a client that stays stuck is closed above.
        if (res.writableLength > this.maxBufferedBytes) stream.close('slow-consumer');
        return;
      }
      for (;;) {
        const batch = this.read(lastEventId, this.maxBatch);
        if (!batch.length) break;
        for (const event of batch) send(event);
        if (closed || backpressured || batch.length < this.maxBatch) break;
      }
    };

    res.on('drain', () => {
      backpressured = false;
      flush();
    });
    res.on('close', () => {
      if (!closed) {
        closed = true;
        if (poll) clearInterval(poll);
        if (beat) clearInterval(beat);
        onClosed();
        log?.('info', 'sse client disconnected', { device_id: input.deviceId, last_event_id: lastEventId });
      }
    });

    poll = setInterval(() => {
      if (closed) return;
      const reason = input.authorize();
      if (reason) {
        stream.close(reason);
        return;
      }
      flush();
    }, this.pollMs);

    beat = setInterval(() => {
      if (closed) return;
      const reason = input.authorize();
      if (reason) {
        stream.close(reason);
        return;
      }
      write(`: ping ${Date.now()}\n\n`);
    }, this.heartbeatMs);

    log?.('info', 'sse opened', {
      device_id: input.deviceId,
      store_id: input.storeId,
      resume_from: input.lastEventId,
      truncated,
      streams: this.streams.size + 1,
    });
    return stream;
  }
}
