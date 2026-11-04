/**
 * v1.1 — optional software lock hardening.
 *
 * The lock is a convenience, never a substitute for OS security, so these tests
 * only assert what it actually promises: no plain-text password is stored, a
 * repeated wrong password triggers a persistent cool-down, and a correct
 * password clears the counter.
 */
import { describe, expect, it } from 'vitest';
import {
  LOGIN_LOCKOUT_MINUTES,
  LOGIN_MAX_FAILURES,
  assertNotLocked,
  clearLoginFailures,
  createUser,
  login,
  registerLoginFailure,
} from '../src/index.js';
import { makeTestDb } from './helpers.js';

describe('login attempt protection', () => {
  it('locks a username after repeated failures — even with the right password', () => {
    const ctx = makeTestDb();
    const user = createUser(
      ctx.db,
      { username: 'till1', fullName: 'ক্যাশিয়ার', password: 'Strong#1234', role: 'cashier' },
      ctx.actor,
    );

    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) {
      expect(() => login(ctx.db, 'till1', 'nope-' + i)).toThrow();
    }

    // The counter is persisted, so the cool-down survives a process restart.
    const row = ctx.db.prepare('SELECT failures, locked_until FROM login_attempts WHERE username = ?').get('till1') as {
      failures: number;
      locked_until: string | null;
    };
    expect(row).toBeTruthy();
    expect(row.locked_until).toBeTruthy();

    expect(() => login(ctx.db, 'till1', 'Strong#1234')).toThrow(/মিনিট পর/);
    expect(LOGIN_LOCKOUT_MINUTES).toBeGreaterThan(0);

    // Nothing about the attempted password is stored anywhere.
    const dump = JSON.stringify(ctx.db.prepare('SELECT * FROM login_attempts').all());
    expect(dump).not.toContain('nope-');
    expect(dump).not.toContain('Strong#1234');

    clearLoginFailures(ctx.db, 'till1');
    expect(() => assertNotLocked(ctx.db, 'till1')).not.toThrow();
    expect(login(ctx.db, 'till1', 'Strong#1234').user?.id).toBe(user.id);
    ctx.cleanup();
  });

  it('clears the counter on a successful login', () => {
    const ctx = makeTestDb();
    createUser(ctx.db, { username: 'till2', fullName: 'ক্যাশিয়ার ২', password: 'Strong#1234', role: 'cashier' }, ctx.actor);

    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i += 1) registerLoginFailure(ctx.db, 'till2');
    expect(login(ctx.db, 'till2', 'Strong#1234').user?.username).toBe('till2');
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM login_attempts').get()).toEqual({ c: 0 });

    // A fresh run of failures starts from zero again.
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i += 1) registerLoginFailure(ctx.db, 'till2');
    expect(() => assertNotLocked(ctx.db, 'till2')).not.toThrow();
    ctx.cleanup();
  });

  it('is case-insensitive and does not leak whether an account exists', () => {
    const ctx = makeTestDb();
    createUser(ctx.db, { username: 'till3', fullName: 'ক্যাশিয়ার ৩', password: 'Strong#1234', role: 'cashier' }, ctx.actor);
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) {
      expect(() => login(ctx.db, 'TILL3', 'wrong')).toThrow(/ইউজারনেম বা পাসওয়ার্ড/);
    }
    const message = (() => {
      try {
        login(ctx.db, 'missing-user', 'wrong');
        return '';
      } catch (err) {
        return (err as Error).message;
      }
    })();
    expect(message).toMatch(/ইউজারনেম বা পাসওয়ার্ড/);
    ctx.cleanup();
  });
});
