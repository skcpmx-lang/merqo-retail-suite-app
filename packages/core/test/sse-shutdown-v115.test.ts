/**
 * Shutdown is terminal for an event-stream hub (R-06).
 *
 * v1.1.4 shipped a Windows CI flake — "closes every stream when the server stops" — that a wider
 * wait hid rather than explained. The cause: `stop()` emptied the hub with `closeAll()`, but a
 * request that had already been authenticated could still reach `hub.open()` afterwards. It then
 * registered a stream on an empty map, wrote 200 to a socket that was about to be destroyed, and
 * left two intervals behind. Nothing was holding a lock, so the test's `waitFor(count === 0)` could
 * pass or fail depending on who won the race.
 *
 * These tests prove the deterministic exit instead:
 *
 *  - after `beginShutdown()`, `open()` fails with `SERVER_STOPPING` and writes no bytes;
 *  - `streamCount()` stays 0 for every later attempt, so `stop()` resolves to a settled state;
 *  - every existing stream is told `event: closed` with reason `server-stop`;
 *  - shutdown is idempotent, because `before-quit` and an explicit stop can both fire;
 *  - a plain `closeAll()` (revoking all streams) does **not** poison the hub — a reconnect after a
 *    revocation burst must still work.
 */
import type http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStreamHub, type SseCloseReason } from '../src/net/sse.js';
import type { Db } from '../src/db/connection.js';

/** The slice of `http.ServerResponse` the hub actually touches, recorded for assertions. */
interface FakeResponse {
  res: http.ServerResponse;
  written: string[];
  ended: boolean;
  emit(event: string): void;
}

function fakeResponse(): FakeResponse {
  const written: string[] = [];
  const listeners = new Map<string, Array<() => void>>();
  const res = {
    writableLength: 0,
    writeHead: () => res,
    write: (chunk: string) => {
      written.push(chunk);
      return true;
    },
    end: () => {
      const state = { ended: true };
      (res as unknown as { ended: boolean }).ended = state.ended;
      return res;
    },
    on: (event: string, handler: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      return res;
    },
  } as unknown as http.ServerResponse;
  return {
    res,
    written,
    get ended() {
      return Boolean((res as unknown as { ended?: boolean }).ended);
    },
    emit(event: string) {
      for (const handler of listeners.get(event) ?? []) handler();
    },
  } as FakeResponse;
}

/**
 * A hub with a stub database: the outbox read is injected (empty) and the only query the hub makes
 * itself is the retention floor, which has no row here, so the floor is 0.
 */
function hub(extra: { log?: (level: 'info' | 'warn', message: string, detail?: unknown) => void } = {}) {
  const db = { prepare: () => ({ get: () => undefined }) } as unknown as Db;
  return new EventStreamHub({
    db,
    read: () => [],
    pollMs: 50,
    heartbeatMs: 500,
    ...extra,
  });
}

const openArgs = (deviceId: string, res: http.ServerResponse) => ({
  deviceId,
  storeId: 'store-1',
  res,
  lastEventId: 0,
  authorize: (): SseCloseReason | null => null,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a hub that is stopping accepts nothing', () => {
  it('refuses a stream that arrives after shutdown began, without writing a header', () => {
    const server = hub();
    server.beginShutdown();

    const response = fakeResponse();
    const result = server.open(openArgs('dev-1', response.res));

    expect(result).toEqual({ ok: false, code: 'SERVER_STOPPING' });
    expect(server.count()).toBe(0);
    // A refused stream must not look like a successful one to the client: no 200, no `retry:`.
    expect(response.written).toEqual([]);
  });

  it('stays closed for every later attempt — the settled state stop() returns in', () => {
    const server = hub();
    server.beginShutdown();
    for (let i = 0; i < 5; i += 1) {
      expect(server.open(openArgs(`dev-${i}`, fakeResponse().res))).toEqual({
        ok: false,
        code: 'SERVER_STOPPING',
      });
    }
    expect(server.count()).toBe(0);
    expect(server.isStopping()).toBe(true);
  });

  it('tells every open stream why it is closing', () => {
    const server = hub();
    const first = fakeResponse();
    const second = fakeResponse();
    expect(server.open(openArgs('dev-1', first.res)).ok).toBe(true);
    expect(server.open(openArgs('dev-2', second.res)).ok).toBe(true);
    expect(server.count()).toBe(2);

    server.beginShutdown();

    expect(server.count()).toBe(0);
    for (const response of [first, second]) {
      expect(response.written).toContain('event: closed\ndata: {"reason":"server-stop"}\n\n');
      expect(response.ended).toBe(true);
    }
  });

  it('leaves no timer behind after shutdown', () => {
    vi.useFakeTimers();
    const server = hub();
    expect(server.open(openArgs('dev-1', fakeResponse().res)).ok).toBe(true);
    // poll + heartbeat are both armed while the stream is live.
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    server.beginShutdown();

    // The v1.1.4 race left these two intervals running after stop() resolved.
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersToNextTimer();
    expect(server.count()).toBe(0);
  });

  it('is idempotent, because before-quit and an explicit stop can both run', () => {
    const server = hub();
    server.beginShutdown();
    expect(() => server.beginShutdown()).not.toThrow();
    expect(server.count()).toBe(0);
    expect(server.isStopping()).toBe(true);
  });
});

describe('a hub that is only closing streams is not stopping', () => {
  it('keeps serving after closeAll(), so revoking every stream is recoverable', () => {
    const server = hub();
    const revoked = fakeResponse();
    expect(server.open(openArgs('dev-1', revoked.res)).ok).toBe(true);

    server.closeAll('revoked');

    expect(revoked.written).toContain('event: closed\ndata: {"reason":"revoked"}\n\n');
    expect(server.isStopping()).toBe(false);
    // A device that reconnects after its session was re-issued must still get a stream.
    const reconnected = fakeResponse();
    expect(server.open(openArgs('dev-1', reconnected.res)).ok).toBe(true);
    expect(server.count()).toBe(1);
    server.beginShutdown();
  });

  it('refuses a stream after shutdown but not before, for the same device', () => {
    const server = hub();
    expect(server.open(openArgs('dev-9', fakeResponse().res)).ok).toBe(true);
    server.beginShutdown('server-stop');
    expect(server.open(openArgs('dev-9', fakeResponse().res)).ok).toBe(false);
  });
});
