/**
 * v1.1.4 audit — the client's resume point survives a restart, and events never become data.
 *
 * `TerminalManager` keeps `last_event_id` in `terminal.json`, so a Client PC that is closed and
 * reopened asks the server to resume from the last id it saw instead of silently starting at
 * "now". The renderer side (`ShopQueryRegistry`) must only ever turn an event into a *refetch*
 * request; it holds no payload, so a stale or forged hint cannot become business data.
 *
 * Source-level assertions: constructing a real connected terminal needs a live Main PC, which is
 * covered by the socket-level suites; what must not regress here is the persistence wiring.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ShopQueryRegistry } from '../src/lib/shop-events.js';

const electronDir = path.resolve(__dirname, '..', 'electron');
const read = (name: string) => fs.readFileSync(path.join(electronDir, name), 'utf8');

describe('client resume point', () => {
  const terminal = read('terminal.ts');

  it('persists the last event id and reuses it when the stream reopens', () => {
    expect(terminal).toMatch(/last_event_id:\s*Number\(raw\.last_event_id \?\? 0\)/);
    expect(terminal).toMatch(/this\.config\.last_event_id = event\.id;\s*\n\s*this\.save\(\);/);
    expect(terminal).toMatch(/lastEventId:\s*this\.config\.last_event_id \|\| undefined/);
  });

  it('drops a duplicate delivered after a resume', () => {
    expect(terminal).toMatch(/if \(event\.id <= this\.config\.last_event_id\) return;/);
  });

  it('forgets the resume point when the device is forgotten (new pairing starts clean)', () => {
    expect(terminal).toMatch(/this\.config\.last_event_id = 0;\s*\n\s*this\.save\(\);/);
  });

  it('turns a detected gap into a resync request, not a mutation', () => {
    expect(terminal).toMatch(/onGap: \(from, to\) => this\.sink\?\.onResync\?\.\(from\)/);
  });
});

describe('events are hints, never data', () => {
  it('a registry refresh is invoked with no event payload', () => {
    const registry = new ShopQueryRegistry({ debounceMs: 0 });
    let calls = 0;
    let receivedArgs: unknown[] = [];
    registry.register('sales', (...args: unknown[]) => {
      calls += 1;
      receivedArgs = args;
    });
    registry.handle({ kind: 'event', id: 3, type: 'sale.created' });
    registry.flush();
    expect(calls).toBe(1);
    expect(receivedArgs).toEqual([]);
  });

  it('a duplicate event does not refetch twice, and a resync refetches everything', () => {
    const registry = new ShopQueryRegistry({ debounceMs: 0 });
    let sales = 0;
    let products = 0;
    registry.register('sales', () => (sales += 1));
    registry.register('products', () => (products += 1));

    registry.handle({ kind: 'event', id: 5, type: 'sale.created' });
    registry.handle({ kind: 'event', id: 5, type: 'sale.created' }); // duplicate
    registry.flush();
    expect(sales).toBe(1);
    expect(registry.ignoredDuplicates).toBe(1);

    registry.handle({ kind: 'resync', from: 6 });
    registry.flush();
    expect(sales).toBe(2);
    expect(products).toBe(1);
  });

  it('an unknown event type falls back to a full refresh rather than being ignored', () => {
    const registry = new ShopQueryRegistry({ debounceMs: 0 });
    let sales = 0;
    let products = 0;
    registry.register('sales', () => (sales += 1));
    registry.register('products', () => (products += 1));
    registry.handle({ kind: 'event', id: 9, type: 'something.new' });
    registry.flush();
    expect(sales).toBe(1);
    expect(products).toBe(1);
  });

  it('a failing screen does not stop the others from refreshing', () => {
    const errors: string[] = [];
    const registry = new ShopQueryRegistry({
      debounceMs: 0,
      onError: (key) => errors.push(key),
    });
    let sales = 0;
    registry.register('sales', () => {
      throw new Error('boom');
    });
    registry.register('products', () => (sales += 1));
    registry.handle({ kind: 'resync', from: 1 });
    registry.flush();
    expect(errors).toEqual(['sales']);
    expect(sales).toBe(1);
  });
});
