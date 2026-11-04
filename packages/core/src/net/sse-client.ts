import crypto from 'node:crypto';
import https from 'node:https';
import { signRequest } from './device-auth.js';

/**
 * Authenticated SSE client (Phase 3, Milestone C).
 *
 * Used by the Electron main process (never the renderer, and never a browser):
 *  - refuses any base URL that is not `https` — there is no HTTP fallback, so a
 *    misconfiguration surfaces as an error instead of a silent downgrade;
 *  - signs every (re)connection with the device key, so the server can re-authorise
 *    the stream after a reconnect;
 *  - remembers the last `seq` it saw and sends it as `Last-Event-ID`, so a reconnect
 *    after a network drop or a server restart resumes exactly where it stopped;
 *  - reports a **gap** when the next event is not `last + 1`, so the caller can
 *    refetch instead of quietly missing a sale;
 *  - ignores duplicate ids defensively (an event already delivered is dropped).
 */

export interface EventStreamClientOptions {
  baseUrl: string;
  tls: { caPem: string; fingerprint: string };
  deviceId: string;
  privateKeyPem: string;
  session: string;
  /** Resume point; 0/undefined starts at "now". */
  lastEventId?: number;
  onEvent: (event: { id: number; type: string; data: unknown; raw: string }) => void;
  /** Missing sequence range (inclusive): `from` is the first id never delivered. */
  onGap?: (from: number, toInclusive: number) => void;
  onError?: (err: { code: string; message: string; status?: number; retryable: boolean }) => void;
  onOpen?: () => void;
  retryDelayMs?: number;
  maxRetries?: number;
  /** Ceiling for the growing reconnect delay (default 10 s). */
  backoffMaxMs?: number;
  /** Randomise the delay by ±15 % so reconnecting clients do not synchronise (default true). */
  jitter?: boolean;
  /**
   * A connection that sends nothing — not even a heartbeat comment — for this long is
   * treated as dead (default 45 s; the server pings every 15 s). Without it a half-open
   * TCP connection after sleep/wake or a network change looks "connected" forever.
   */
  idleTimeoutMs?: number;
  /** Refuse a single SSE line larger than this (default 1 MiB) instead of buffering it. */
  maxBufferBytes?: number;
}

export interface EventStreamHandle {
  close: () => void;
  readonly lastEventId: number;
  readonly connected: boolean;
}

export function openEventStreamClient(opts: EventStreamClientOptions): EventStreamHandle {
  if (!/^https:\/\//i.test(opts.baseUrl)) {
    throw new Error('ইভেন্ট স্ট্রিম শুধু HTTPS-এ চলে — HTTP-তে নামানো যাবে না।');
  }
  const base = opts.baseUrl.replace(/\/+$/, '');
  const retryDelayMs = Math.max(50, opts.retryDelayMs ?? 2000);
  const maxRetries = opts.maxRetries ?? 20;
  const backoffMaxMs = Math.max(retryDelayMs, opts.backoffMaxMs ?? 10_000);
  const jitter = opts.jitter ?? true;
  const idleTimeoutMs = Math.max(0, opts.idleTimeoutMs ?? 45_000);
  const maxBufferBytes = Math.max(1024, opts.maxBufferBytes ?? 1024 * 1024);

  let lastEventId = Math.max(0, Math.floor(opts.lastEventId ?? 0));
  let closed = false;
  let connected = false;
  let retries = 0;
  let timer: NodeJS.Timeout | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let request: ReturnType<typeof https.request> | null = null;
  /** Set when the server closes the stream for a reason that must not be retried. */
  let stopReconnect = false;

  const disarmIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const armIdle = () => {
    disarmIdle();
    if (idleTimeoutMs <= 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (closed) return;
      // No heartbeat, no event: the connection is dead even though the socket is not.
      connected = false;
      opts.onError?.({ code: 'STREAM_IDLE', message: 'স্ট্রিম নিষ্ক্রিয় — আবার সংযোগ করা হচ্ছে।', retryable: true });
      request?.destroy();
      scheduleRetry();
    }, idleTimeoutMs);
  };

  const handle: EventStreamHandle = {
    close() {
      closed = true;
      stopReconnect = true;
      connected = false;
      if (timer) clearTimeout(timer);
      disarmIdle();
      request?.destroy();
    },
    get lastEventId() {
      return lastEventId;
    },
    get connected() {
      return connected;
    },
  };

  const scheduleRetry = () => {
    if (closed || stopReconnect) return;
    if (retries >= maxRetries) {
      opts.onError?.({ code: 'STREAM_EXHAUSTED', message: 'পুনঃসংযোগের সীমা শেষ।', retryable: false });
      return;
    }
    retries += 1;
    // Grow the delay (a dead server must not be hammered) but keep it bounded.
    const grown = Math.min(backoffMaxMs, retryDelayMs * retries);
    const delay = jitter ? Math.round(grown * (0.85 + Math.random() * 0.3)) : grown;
    if (timer) clearTimeout(timer);
    timer = setTimeout(connect, Math.max(10, delay));
  };

  function connect(): void {
    if (closed) return;
    const path = '/api/v1/events';
    const headers: Record<string, string> = {
      accept: 'text/event-stream',
      'x-sauda-session': opts.session,
      ...signRequest(opts.privateKeyPem, { method: 'GET', path, body: '', deviceId: opts.deviceId }),
    };
    if (lastEventId > 0) headers['last-event-id'] = String(lastEventId);

    request = https.request(
      {
        host: urlHost(base),
        port: urlPort(base),
        path,
        method: 'GET',
        headers,
        ca: opts.tls.caPem,
        // The pin is checked after the handshake as well; the CA is the cert itself.
        checkServerIdentity: (_host, cert) => {
          const pin = crypto.createHash('sha256').update(cert.raw).digest('hex').toUpperCase();
          if (pin !== opts.tls.fingerprint.replace(/[^0-9a-fA-F]/g, '').toUpperCase()) {
            return new Error('সার্ভারের সার্টিফিকেট পিন মেলেনি — সংযোগ প্রত্যাখ্যাত।');
          }
          return undefined;
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(Buffer.from(c)));
          res.on('end', () => {
            let code = 'STREAM_REJECTED';
            let message = `সংযোগ প্রত্যাখ্যাত (${res.statusCode})`;
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { code?: string; message?: string };
              code = parsed.code ?? code;
              message = parsed.message ?? message;
            } catch {
              /* keep defaults */
            }
            const retryable = (res.statusCode ?? 0) >= 500;
            opts.onError?.({ code, message, status: res.statusCode, retryable });
            if (retryable) scheduleRetry();
            else handle.close();
          });
          return;
        }
        connected = true;
        retries = 0;
        stopReconnect = false;
        armIdle();
        opts.onOpen?.();
        let buffer = '';
        let currentId = 0;
        let currentType = 'message';
        let currentData: string[] = [];

        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          armIdle();
          buffer += chunk;
          if (buffer.length > maxBufferBytes) {
            // A peer that never sends a newline must not grow our memory without bound.
            connected = false;
            opts.onError?.({ code: 'STREAM_OVERFLOW', message: 'স্ট্রিমের ডেটা সীমার বেশি — সংযোগ বন্ধ।', retryable: true });
            res.destroy();
            request?.destroy();
            scheduleRetry();
            return;
          }
          let index = buffer.indexOf('\n');
          while (index >= 0) {
            const line = buffer.slice(0, index).replace(/\r$/, '');
            buffer = buffer.slice(index + 1);
            index = buffer.indexOf('\n');
            if (line === '') {
              if (currentData.length) {
                deliver(currentId, currentType, currentData.join('\n'));
              }
              currentId = lastEventId;
              currentType = 'message';
              currentData = [];
              continue;
            }
            if (line.startsWith(':')) continue;
            const colon = line.indexOf(':');
            const field = colon === -1 ? line : line.slice(0, colon);
            const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
            if (field === 'id') currentId = Number(value) || 0;
            else if (field === 'event') currentType = value;
            else if (field === 'data') currentData.push(value);
          }
        });
        res.on('end', () => {
          connected = false;
          disarmIdle();
          if (!closed && !stopReconnect) scheduleRetry();
        });
        res.on('error', () => {
          connected = false;
          disarmIdle();
          if (!closed && !stopReconnect) scheduleRetry();
        });
      },
    );
    request.on('error', (err) => {
      connected = false;
      disarmIdle();
      if (closed || stopReconnect) return;
      opts.onError?.({ code: 'STREAM_ERROR', message: err.message, retryable: true });
      scheduleRetry();
    });
    // Arm before the response exists: a peer that accepts the TLS connection and then
    // never sends headers is just as dead as one that goes silent mid-stream.
    armIdle();
    request.end();
  }

  function deliver(id: number, type: string, raw: string): void {
    if (type === 'closed') {
      // The server told us why. A revoked, unapproved or expired-session device must stop
      // reconnecting entirely — retrying would only produce the same rejection.
      let reason = 'closed';
      try {
        reason = (JSON.parse(raw) as { reason?: string }).reason ?? reason;
      } catch {
        /* ignore */
      }
      const terminalReason = reason === 'revoked' || reason === 'device-not-approved' || reason === 'session-expired';
      opts.onError?.({ code: 'STREAM_CLOSED', message: reason, retryable: !terminalReason });
      if (terminalReason) {
        handle.close();
        return;
      }
      if (connected) scheduleRetry();
      return;
    }
    if (!id) return;
    if (id <= lastEventId) return; // duplicate: already delivered
    if (lastEventId > 0 && id > lastEventId + 1) opts.onGap?.(lastEventId + 1, id - 1);
    lastEventId = id;
    let data: unknown = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      /* keep the raw string */
    }
    opts.onEvent({ id, type, data, raw });
  }

  connect();
  return handle;
}

function urlHost(base: string): string {
  return new URL(base).hostname;
}

function urlPort(base: string): number {
  const parsed = new URL(base);
  return parsed.port ? Number(parsed.port) : 443;
}
