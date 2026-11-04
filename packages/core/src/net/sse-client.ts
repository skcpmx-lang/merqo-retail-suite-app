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

  let lastEventId = Math.max(0, Math.floor(opts.lastEventId ?? 0));
  let closed = false;
  let connected = false;
  let retries = 0;
  let timer: NodeJS.Timeout | null = null;
  let request: ReturnType<typeof https.request> | null = null;

  const handle: EventStreamHandle = {
    close() {
      closed = true;
      connected = false;
      if (timer) clearTimeout(timer);
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
    if (closed) return;
    if (retries >= maxRetries) {
      opts.onError?.({ code: 'STREAM_EXHAUSTED', message: 'পুনঃসংযোগের সীমা শেষ।', retryable: false });
      return;
    }
    retries += 1;
    timer = setTimeout(connect, retryDelayMs);
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
        opts.onOpen?.();
        let buffer = '';
        let currentId = 0;
        let currentType = 'message';
        let currentData: string[] = [];

        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
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
          if (!closed) scheduleRetry();
        });
        res.on('error', () => {
          connected = false;
          if (!closed) scheduleRetry();
        });
      },
    );
    request.on('error', (err) => {
      connected = false;
      if (closed) return;
      opts.onError?.({ code: 'STREAM_ERROR', message: err.message, retryable: true });
      scheduleRetry();
    });
    request.end();
  }

  function deliver(id: number, type: string, raw: string): void {
    if (type === 'closed') {
      // Server told us why (e.g. revoked). Do not reconnect blindly.
      let reason = 'closed';
      try {
        reason = (JSON.parse(raw) as { reason?: string }).reason ?? reason;
      } catch {
        /* ignore */
      }
      opts.onError?.({ code: 'STREAM_CLOSED', message: reason, retryable: reason === 'server-stop' });
      if (reason !== 'revoked') scheduleRetry();
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
