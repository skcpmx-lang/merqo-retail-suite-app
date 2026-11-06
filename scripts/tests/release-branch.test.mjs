/**
 * The release-branch rule (v1.2.0, requirement #20).
 *
 * v1.1.5 was published from a branch that was never merged into `main`. These tests pin the rule that
 * makes that impossible again, and they pin the *refusal* — a rule that only ever approves is not a
 * rule.
 */
import { describe, expect, it } from 'vitest';
import { checkReleaseBranch } from '../lib/release-branch.mjs';

const base = { tag: 'v1.2.0', tagCommit: 'a'.repeat(40), mainCommit: 'b'.repeat(40) };

describe('checkReleaseBranch', () => {
  it('accepts a tag whose commit is on main', () => {
    const verdict = checkReleaseBranch({ ...base, isAncestor: true });
    expect(verdict.ok).toBe(true);
    expect(verdict.code).toBe('ON_MAIN');
    expect(verdict.message).toContain('v1.2.0');
  });

  it('refuses a tag from an unmerged branch — the v1.1.5 mistake', () => {
    const verdict = checkReleaseBranch({ ...base, isAncestor: false });
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('OFF_MAIN');
    expect(verdict.message).toMatch(/not an ancestor of main/);
    expect(verdict.message).toMatch(/do not publish from a development branch/);
  });

  it('only overrides when the operator says so explicitly', () => {
    const verdict = checkReleaseBranch({ ...base, isAncestor: false, allowOffMain: true });
    expect(verdict.ok).toBe(true);
    expect(verdict.code).toBe('OVERRIDDEN');
    // the override is never silent: the message demands it be recorded
    expect(verdict.message).toMatch(/recorded in the release notes/);
  });

  it('refuses to decide when it cannot see the refs', () => {
    expect(checkReleaseBranch({ tag: 'v1.2.0', tagCommit: '', mainCommit: base.mainCommit, isAncestor: true })).toMatchObject({
      ok: false,
      code: 'MISSING_INPUT',
    });
  });

  it('names the ref it compared against, so the message is actionable', () => {
    const verdict = checkReleaseBranch({ ...base, isAncestor: false, mainRef: 'origin/trunk' });
    expect(verdict.message).toContain('origin/trunk');
  });
});
