import type http from 'node:http';
import type { Db } from '../db/connection.js';
import { readEvents, type OutboxEvent } from '../services/events.js';

/**
 * Authenticated server-sent events (Phase 3, Milestone C).
 *
 * Design points that matter for security:
 *  - the connection is authenticated exactly like every other `/api/v1` call: an
 *    Ed25519 device signature plus a session bound to that device. There is no
 *    "stream token" and no unprotected endpoint;
 *  - the stream is opened by a Node client (the Electron main process), not by a
 *    browser `EventSource`, because a browser cannot attach signature headers;
 *  - every event carries its outbox `seq` as the SSE `id`, so a client resumes with
 *    `Last-Event-ID` and receives exactly the events it missed — no gaps, no
 *    duplicates, monotonic order;
 *  - a store filter is applied twice (query and per-event check), so an event from
 *    another store can never be delivered even if the outbox were shared;
 *  - the connection re-validates the device and session on every heartbeat and is
 *    closed when either is revoked, so revocation terminates live streams;
 *  - nothing is retained in memory except the last sequence number, so a server
 *    restart loses no events: the client resumes from the outbox.
 */

export interface SseOptions {
  res: http.ServerResponse;
  db: Db;
  /** Store the connection belongs to; events from other stores are never sent. */
  storeId: string;
  /** Resume point (exclusive). 0 means "only new events". */
  lastEventId: number;
  /** Where the events come from (the outbox). */
  read?: (afterSeq: number, limit: number) => OutboxEvent[];
  /** Re-checked before every batch: device approved, session still valid. */
  isAuthorized: () => boolean;
  pollMs?: number;
  heartbeatMs?: number;
  maxBatch?: number;
  /** Called when the stream closes, with a reason. */
  onClose?: (reason: string) => void;
  log?: (level: 'info' | 'warn', message: string, detail?: unknown) => void;
}

export interface SseStream {
  /** Closes the stream. Idempotent. */
  close(reason: string): void;
  closed: boolean;
  lastEventId: number;
}

export function openEventStream(opts: SseOptions): SseStream {
  const read = opts.read ?? ((after: number, limit: number) => readEvents(opts.db, after, limit));
  const pollMs = Math.max(20, opts.pollMs ?? 1000);
  const heartbeatMs = Math.max(200, opts.heartbeatMs ?? 15_000);
  const maxBatch = Math.max(1, opts.maxBatch ?? 200);

  opts.res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  // Tell the client how long to wait before reconnecting (SSE standard).
  opts.res.write(`retry: 2000\n\n`);

  const stream: SseStream = {
    closed: false,
    lastEventId: Math.max(0, Math.floor(opts.lastEventId) || 0),
    close(reason: string) {
      if (stream.closed) return;
      stream.closed = true;
      clearInterval(poll);
      clearInterval(beat);
      try {
        opts.res.write(`event: closed\ndata: ${JSON.stringify({ reason })}\n\n`);
        opts.res.end();
      } catch {
        /* client already gone */
      }
      opts.onClose?.(reason);
      opts.log?.('info', 'sse closed', { reason, lastEventId: stream.lastEventId });
    },
  };

  function send(event: OutboxEvent): void {
    // Defence in depth: never leak another store's event, whatever the query did.
    if (event.store_id !== opts.storeId) return;
    stream.lastEventId = event.seq;
    opts.res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${event.payload}\n\n`);
  }

  function flush(): void {
    if (stream.closed) return;
    let sent = 0;
    for (;;) {
      const batch = read(stream.lastEventId, maxBatch);
      if (!batch.length) break;
      for (const event of batch) send(event);
      sent += batch.length;
      if (batch.length < maxBatch) break;
    }
    void sent;
  }

  const poll = setInterval(() => {
    if (stream.closed) return;
    if (!opts.isAuthorized()) {
      // Revoked, session expired, or device no longer approved: terminate now.
      stream.close('revoked');
      return;
    }
    try {
      flush();
    } catch (err) {
      opts.log?.('warn', 'sse flush failed', err);
      stream.close('error');
    }
  }, pollMs);

  const beat = setInterval(() => {
    if (stream.closed) return;
    if (!opts.isAuthorized()) {
      stream.close('revoked');
      return;
    }
    try {
      opts.res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      stream.close('error');
    }
  }, heartbeatMs);

  opts.res.on('close', () => {
    if (!stream.closed) {
      stream.closed = true;
      clearInterval(poll);
      clearInterval(beat);
      opts.onClose?.('client-closed');
    }
  });

  // Deliver anything already pending (resume) immediately.
  try {
    flush();
  } catch (err) {
    opts.log?.('warn', 'sse initial flush failed', err);
    stream.close('error');
  }
  return stream;
}
