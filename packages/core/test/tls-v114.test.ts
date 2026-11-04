/**
 * Phase 3, Milestone A — TLS transport, certificate generation and pinning.
 *
 * Security tests, not happy-path tests: the interesting cases are a wrong pin, a
 * missing pin, a plaintext client against a TLS host, and a certificate that does
 * not belong to this server.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import tls from 'node:tls';
import { describe, expect, it } from 'vitest';
import {
  checkPinnedFingerprint,
  fingerprintOf,
  fingerprintOfDer,
  generateServerCertificate,
  listLocalIpv4,
  pemToDer,
  shortFingerprint,
} from '../src/net/certificate.js';
import { createRpcClient, startRpcHost, type RpcHost } from '../src/net/rpc.js';

const TOKEN = 'b'.repeat(64);

async function host(tls?: { certPem: string; keyPem: string; fingerprint?: string }): Promise<RpcHost> {
  return startRpcHost({
    port: 0,
    token: TOKEN,
    tls,
    version: '1.1.4',
    businessName: () => 'টেস্ট স্টোর',
    authenticate: async (username) => ({
      id: 1,
      username,
      full_name: 'মালিক',
      role: 'admin',
      permissions: [],
    }),
    invoke: async () => ({ ok: true, data: 'hello' }),
    allowRemote: () => true,
  });
}

describe('certificate generation', () => {
  const cert = generateServerCertificate({
    commonName: 'Sauda Main Server',
    ips: ['192.168.0.10'],
    days: 30,
  });

  it('produces a real X.509 certificate that Node can parse and verify', () => {
    const parsed = new crypto.X509Certificate(cert.certPem);
    expect(parsed.subject).toContain('Sauda Main Server');
    expect(parsed.subject).toContain('Sauda Retail Suite');
    // Self-signed: it verifies against its own public key.
    expect(parsed.verify(crypto.createPublicKey(cert.keyPem))).toBe(true);
    expect(new Date(parsed.validTo).getTime()).toBeGreaterThan(Date.now());
  });

  it('covers loopback, localhost and the supplied LAN address', () => {
    const parsed = new crypto.X509Certificate(cert.certPem);
    expect(parsed.checkIP('127.0.0.1')).toBe('127.0.0.1');
    expect(parsed.checkIP('192.168.0.10')).toBe('192.168.0.10');
    expect(parsed.checkHost('localhost')).toBe('localhost');
    // A different address must not validate.
    expect(parsed.checkIP('10.9.9.9')).toBeUndefined();
  });

  it('uses a 2048-bit RSA key and a fresh serial per certificate', () => {
    const other = generateServerCertificate({ ips: ['192.168.0.10'] });
    expect(cert.certPem).not.toBe(other.certPem);
    const parsed = new crypto.X509Certificate(cert.certPem);
    expect(parsed.publicKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
    expect(fingerprintOf(cert.certPem)).not.toBe(fingerprintOf(other.certPem));
  });

  it('encodes a serial that starts with zero bytes as minimal DER', () => {
    // Regression: a leading 0x00 in the serial used to produce a non-minimal INTEGER,
    // which OpenSSL rejects with "illegal padding" — so roughly 1 first boot in 256
    // would fail to create its certificate.
    const zeroed = generateServerCertificate({
      serial: Buffer.from([0x00, 0x00, 0x5c, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d]),
    });
    const parsed = new crypto.X509Certificate(zeroed.certPem);
    expect(parsed.serialNumber.toUpperCase()).toBe('5C0102030405060708090A0B0C0D');
    // A high-bit serial still needs its leading zero to stay positive.
    const highBit = generateServerCertificate({
      serial: Buffer.from([0xff, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f]),
    });
    expect(new crypto.X509Certificate(highBit.certPem).serialNumber.toUpperCase()).toBe(
      'FF0102030405060708090A0B0C0D0E0F',
    );
  });

  it('produces certificates a TLS context accepts across many random serials', () => {
    // Cheap sweep over the randomness that caused the intermittent failure above.
    for (let i = 0; i < 40; i += 1) {
      const generated = generateServerCertificate({ ips: ['192.168.0.10'] });
      expect(() => tls.createSecureContext({ cert: generated.certPem, key: generated.keyPem })).not.toThrow();
    }
  }, 60_000);

  it('ignores malformed IP input instead of producing a broken SAN', () => {
    const weird = generateServerCertificate({ ips: ['999.1.1.1', 'not-an-ip', '10.0.0.5'] });
    const parsed = new crypto.X509Certificate(weird.certPem);
    expect(parsed.checkIP('10.0.0.5')).toBe('10.0.0.5');
    expect(parsed.subjectAltName).not.toContain('999.1.1.1');
  });

  it('reports local IPv4 addresses without loopback-only noise', () => {
    const ips = listLocalIpv4();
    expect(Array.isArray(ips)).toBe(true);
    expect(ips.every((ip) => ip.split('.').length === 4)).toBe(true);
  });
});

describe('fingerprint pinning', () => {
  const cert = generateServerCertificate();

  it('accepts the exact pin (case and separators ignored)', () => {
    expect(checkPinnedFingerprint(cert.certPem, cert.fingerprint).ok).toBe(true);
    const spaced = cert.fingerprint.toLowerCase().match(/.{1,2}/g)!.join(':');
    expect(checkPinnedFingerprint(cert.certPem, spaced).ok).toBe(true);
  });

  it('rejects a different pin and reports the actual value without throwing', () => {
    const other = generateServerCertificate();
    const result = checkPinnedFingerprint(cert.certPem, other.fingerprint);
    expect(result).toMatchObject({ ok: false, code: 'CERT_MISMATCH' });
    expect(result.actual).toBe(cert.fingerprint);
  });

  it('fails closed on an empty or garbage pin', () => {
    expect(checkPinnedFingerprint(cert.certPem, '').ok).toBe(false);
    expect(checkPinnedFingerprint(cert.certPem, 'zzzz').ok).toBe(false);
  });

  it('handles a corrupt certificate without crashing', () => {
    expect(checkPinnedFingerprint('not a certificate', 'AABB').ok).toBe(false);
  });

  it('derives the pin from the DER body, not the PEM text', () => {
    const der = pemToDer(cert.certPem);
    expect(fingerprintOfDer(der)).toBe(cert.fingerprint);
    expect(crypto.createHash('sha256').update(der).digest('hex').toUpperCase()).toBe(cert.fingerprint);
    expect(shortFingerprint(cert.fingerprint)).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  });
});

describe('TLS listener', () => {
  it('serves HTTPS with a pinned client and keeps the sealed envelope', async () => {
    const cert = generateServerCertificate();
    const server = await host({ certPem: cert.certPem, keyPem: cert.keyPem, fingerprint: cert.fingerprint });
    try {
      expect(server.protocol).toBe('https');
      expect(server.tls_fingerprint).toBe(cert.fingerprint);
      const client = createRpcClient({
        baseUrl: `https://127.0.0.1:${server.port}`,
        token: TOKEN,
        tls: { caPem: cert.certPem, fingerprint: cert.fingerprint },
      });
      const health = await client.health();
      expect(health.ok).toBe(true);
      const login = await client.invoke('auth.login', ['owner', 'owner123']);
      expect(login.ok).toBe(true);
      expect(login.session).toBeTruthy();
      const call = await client.invoke('products.list', []);
      expect(call).toMatchObject({ ok: true, data: 'hello' });
    } finally {
      await server.stop();
    }
  });

  it('refuses a client that pins a different certificate', async () => {
    const cert = generateServerCertificate();
    const impostor = generateServerCertificate();
    const server = await host({ certPem: cert.certPem, keyPem: cert.keyPem, fingerprint: cert.fingerprint });
    try {
      const client = createRpcClient({
        baseUrl: `https://127.0.0.1:${server.port}`,
        token: TOKEN,
        tls: { caPem: impostor.certPem, fingerprint: impostor.fingerprint },
      });
      const health = await client.health();
      expect(health.ok).toBe(false);
      expect(['CERT_MISMATCH', 'OFFLINE']).toContain(health.code);
    } finally {
      await server.stop();
    }
  });

  it('rejects a plaintext HTTP request to a TLS port', async () => {
    const cert = generateServerCertificate();
    const server = await host({ certPem: cert.certPem, keyPem: cert.keyPem, fingerprint: cert.fingerprint });
    try {
      const result = await new Promise<{ ok: boolean }>((resolve) => {
        const req = http.get(
          { host: '127.0.0.1', port: server.port, path: '/health', timeout: 3000 },
          (res) => {
            res.resume();
            resolve({ ok: res.statusCode === 200 });
          },
        );
        req.on('error', () => resolve({ ok: false }));
        req.on('timeout', () => {
          req.destroy();
          resolve({ ok: false });
        });
      });
      expect(result.ok).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it('still supports the plaintext test transport when no TLS material is given', async () => {
    const server = await host();
    try {
      expect(server.protocol).toBe('http');
      expect(server.tls_fingerprint).toBeNull();
      const client = createRpcClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: TOKEN });
      expect((await client.health()).ok).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it('rejects a request with the wrong shop token even over TLS', async () => {
    const cert = generateServerCertificate();
    const server = await host({ certPem: cert.certPem, keyPem: cert.keyPem, fingerprint: cert.fingerprint });
    try {
      const client = createRpcClient({
        baseUrl: `https://127.0.0.1:${server.port}`,
        token: 'c'.repeat(64),
        tls: { caPem: cert.certPem, fingerprint: cert.fingerprint },
      });
      // The liveness probe answers (it must, for diagnostics) but reveals nothing,
      // and any real call is refused at the token check.
      const health = await client.health();
      expect(health.ok).toBe(true);
      expect((health.data as { business?: string } | undefined)?.business).toBeUndefined();
      const call = await client.invoke('auth.login', ['owner', 'owner123']);
      expect(call.ok).toBe(false);
      expect(call.code).toBe('UNAUTHORIZED');
    } finally {
      await server.stop();
    }
  });
});
