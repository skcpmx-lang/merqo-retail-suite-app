/**
 * v1.1.4 Phase 3 — D-11 role/route decisions (electron-free).
 */
import { describe, expect, it } from 'vitest';
import { decideModeChange, decideRoute, describeDatabaseRole, isLocalRoute } from '../electron/mode-policy.js';

describe('route selection', () => {
  it('forwards every business route to the Main PC in client mode', () => {
    const business = [
      'sale.create',
      'sale.void',
      'payment.receive',
      'products.list',
      'products.create',
      'customers.list',
      'customers.create',
      'inventory.adjust',
      'stock.count',
      'accounting.journal',
      'reports.sales',
      'settings.get',
      'settings.update',
      'backup.create',
      'backup.restore',
      'auth.login',
      'auth.logout',
      'devices.list',
      'devices.approve',
    ];
    for (const method of business) {
      expect(decideRoute('terminal', method), method).toBe('remote');
    }
  });

  it('keeps printer, display, LAN and app routes on the local machine', () => {
    for (const method of ['print.receiptHtml', 'print.print', 'app.info', 'display.push', 'lan.status', 'meta.permissions', 'license.fingerprint', 'terminal.status']) {
      expect(decideRoute('terminal', method), method).toBe('local');
    }
  });

  it('never treats a client licence as authoritative', () => {
    expect(decideRoute('terminal', 'license.state')).toBe('remote');
    expect(decideRoute('terminal', 'license.activateKey')).toBe('remote');
  });

  it('runs everything locally in server and off modes', () => {
    for (const mode of ['host', 'off'] as const) {
      expect(decideRoute(mode, 'sale.create')).toBe('local');
      expect(decideRoute(mode, 'print.print')).toBe('local');
    }
    expect(isLocalRoute('sale.create')).toBe(false);
  });
});

describe('mode changes', () => {
  it('refuses to promote a paired client into a Main Server', () => {
    const decision = decideModeChange({ from: 'terminal', to: 'host', paired: true, hasActiveServer: true });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('CLIENT_PROMOTION_BLOCKED');
    expect(decision.message).toContain('সংযোগ বিচ্ছিন্ন');
  });

  it('allows a client to become a server only after it is unpaired', () => {
    expect(decideModeChange({ from: 'terminal', to: 'host', paired: false, hasActiveServer: true }).allowed).toBe(true);
  });

  it('requires a configured server before entering client mode', () => {
    const decision = decideModeChange({ from: 'host', to: 'terminal', paired: false, hasActiveServer: false });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('NO_SERVER_CONFIGURED');
    expect(decideModeChange({ from: 'host', to: 'terminal', paired: false, hasActiveServer: true }).allowed).toBe(true);
  });

  it('always requires a restart so the database is reopened in the right role', () => {
    expect(decideModeChange({ from: 'host', to: 'terminal', paired: false, hasActiveServer: true }).requiresRestart).toBe(true);
    expect(decideModeChange({ from: 'host', to: 'host', paired: false, hasActiveServer: true }).requiresRestart).toBe(false);
  });
});

describe('database role', () => {
  it('marks a client database as non-authoritative and never backed up locally', () => {
    const client = describeDatabaseRole('terminal');
    expect(client.role).toBe('client');
    expect(client.authoritative).toBe(false);
    expect(client.migrated).toBe(false);
    expect(client.backup).toBe('not-local');
  });

  it('marks the Main Server database as the shop of record', () => {
    const server = describeDatabaseRole('host');
    expect(server).toMatchObject({ role: 'main-server', authoritative: true, migrated: true, backup: 'local' });
  });
});
