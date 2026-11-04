import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCustomer,
  createProduct,
  createRpcClient,
  createSale,
  generateLanToken,
  isPrivateAddress,
  lanUrls,
  login,
  startRpcHost,
  type RpcClient,
  type RpcHost,
  type RpcUser,
  type RpcResponse,
} from '../src/index.js';
import { makeTestDb, type TestContext } from './helpers.js';

const TOKEN = generateLanToken();

function asRpcUser(user: { id: number; username: string; full_name: string; role: string; permissions: string[] }): RpcUser {
  return {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    role: user.role as RpcUser['role'],
    permissions: user.permissions ?? [],
  };
}

describe('LAN transport', () => {
  let ctx: TestContext;
  let host: RpcHost;
  let port = 0;
  let productId = 0;
  let calls: string[] = [];

  const invoke = async (method: string, args: unknown[], user: RpcUser | null): Promise<RpcResponse> => {
    calls.push(method);
    try {
      switch (method) {
        case 'shop.info':
          return { ok: true, data: `${ctx.db ? 'ok' : 'no'}:${user?.username ?? 'anon'}` };
        case 'products.list':
          return {
            ok: true,
            data: ctx.db.prepare('SELECT id, name FROM products').all(),
          };
        case 'products.create': {
          if (user?.role !== 'admin') return { ok: false, error: 'অনুমতি নেই', code: 'FORBIDDEN' };
          const p = createProduct(
            ctx.db,
            { name: String(args[0]), unitId: ctx.unitPieceId, salePrice: 10_000, openingStockMilli: 10_000 },
            { id: user.id, username: user.username },
          );
          productId = p.id;
          return { ok: true, data: p };
        }
        case 'pos.sell': {
          if (!user) return { ok: false, error: 'লগইন করুন', code: 'AUTH_REQUIRED' };
          const sale = createSale(ctx.db, {
            lines: [{ productId: productId || 1, unitId: ctx.unitPieceId, qtyMilli: 1000 }],
            paidPaisa: 10_000,
            defaultMethodId: ctx.cashMethodId,
            actor: { id: user.id, username: user.username },
          });
          return { ok: true, data: sale };
        }
        default:
          return { ok: false, error: 'অজানা রুট', code: 'NOT_FOUND' };
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  };

  beforeAll(async () => {
    ctx = makeTestDb();
    host = await startRpcHost({
      port: 0,
      token: TOKEN,
      version: '1.1.0',
      businessName: () => 'টেস্ট মার্ট',
      invoke,
      authenticate: async (username, password) => asRpcUser(login(ctx.db, username, password).user),
    });
    port = host.port;
  });

  afterAll(async () => {
    await host?.stop();
    ctx?.cleanup();
  });

  const client = (token = TOKEN): RpcClient => createRpcClient({ baseUrl: `http://127.0.0.1:${port}`, token });

  it('serves a health probe with the business identity', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const json = (await res.json()) as RpcResponse;
    expect(json.ok).toBe(true);
    expect((json.data as any).business).toBe('টেস্ট মার্ট');
    expect((json.data as any).version).toBe('1.1.0');
  });

  it('rejects a wrong token before any route runs', async () => {
    const res = await client('0'.repeat(64)).invoke('shop.info', []);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('UNAUTHORIZED');
  });

  it('refuses unauthenticated routes and accepts a real login session', async () => {
    const c = client();
    const denied = await c.invoke('products.list', []);
    expect(denied.ok).toBe(false);
    expect(denied.code).toBe('AUTH_REQUIRED');

    const login1 = await c.invoke('auth.login', ['admin', 'admin123']);
    expect(login1.ok).toBe(true);
    expect(login1.session).toMatch(/^[0-9a-f]{64}$/);
    const listed = await c.invoke('products.list', []);
    expect(listed.ok).toBe(true);
  });

  it('rejects bad credentials without creating a session', async () => {
    const c = client();
    const bad = await c.invoke('auth.login', ['admin', 'wrong']);
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('AUTH_FAILED');
    expect(bad.session).toBeUndefined();
    expect((await c.invoke('products.list', [])).code).toBe('AUTH_REQUIRED');
  });

  it('enforces permissions on the host, not the terminal', async () => {
    const c = client();
    const authed = await c.invoke('auth.login', ['admin', 'admin123']);
    expect(authed.ok).toBe(true);
    // createProduct runs with the *host's* user record
    const created = await c.invoke('products.create', ['লাক্স সাবান']);
    expect(created.ok).toBe(true);
    const row = ctx.db.prepare("SELECT id FROM products WHERE name = 'লাক্স সাবান'").get() as { id: number };
    productId = row.id;
    const sale = await c.invoke('pos.sell', [{}]);
    expect(sale.ok).toBe(true);
  });

  it('drops the session on logout and refuses it afterwards', async () => {
    const c = client();
    await c.invoke('auth.login', ['admin', 'admin123']);
    expect((await c.invoke('shop.info', [])).ok).toBe(true);
    expect((await c.invoke('auth.logout', [])).ok).toBe(true);
    expect((await c.invoke('shop.info', [])).code).toBe('AUTH_REQUIRED');
  });

  it('reports an offline host instead of hanging', async () => {
    const dead = createRpcClient({ baseUrl: 'http://127.0.0.1:1', token: TOKEN, timeoutMs: 1500 });
    const res = await dead.invoke('shop.info', []);
    expect(res.ok).toBe(false);
    expect(['OFFLINE', 'TIMEOUT']).toContain(res.code);
    expect((await dead.health()).ok).toBe(false);
  });

  it('only accepts private network addresses', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:192.168.0.44')).toBe(true);
    expect(isPrivateAddress('10.1.2.3')).toBe(true);
    expect(isPrivateAddress('172.20.5.5')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('172.32.0.1')).toBe(false);
    expect(lanUrls(4747).some((u) => u.includes(':4747'))).toBe(true);
  });

  it('refuses a public peer even with the right token (threat model)', async () => {
    const localOnly = await startRpcHost({
      port: 0,
      token: TOKEN,
      version: '1.1.0',
      businessName: () => 'x',
      invoke,
      authenticate: async () => {
        throw new Error('no');
      },
      allowRemote: () => false,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${localOnly.port}/health`);
      expect(res.status).toBe(403);
    } finally {
      await localOnly.stop();
    }
  });

  it('caps oversized bodies and unknown paths', async () => {
    const notFound = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(notFound.status).toBe(404);
    const big = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: 'x'.repeat(2_100_000),
    }).catch(() => null);
    expect(big === null || big.status >= 400).toBe(true);
  });
});

describe('LAN settings contract', () => {
  it('generates a 256-bit hex token that is different every time', () => {
    const a = generateLanToken();
    const b = generateLanToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});
