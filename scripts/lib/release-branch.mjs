/**
 * The release-branch rule (v1.2.0, requirement #20 / risk R-01).
 *
 * v1.1.5 was published from a development branch: the tag `v1.1.5` is not an ancestor of `main`, so
 * the repository's front door still shows the v1.1.4-era tree while customers download v1.1.5. That
 * is a process defect, not a code defect, and no amount of testing catches it — only a rule does.
 *
 * The rule: a released tag's commit must be an ancestor of `main` (i.e. the exact tree that was
 * verified on main is the tree that was built), and the working tree must be clean at tag time.
 *
 * The decision is a pure function so it can be tested without a repository; the CLI that supplies
 * git's answers lives in scripts/audit-release-branch.mjs.
 */

/**
 * @param {object} input
 * @param {string} input.tag            tag name being released, e.g. "v1.2.0"
 * @param {string} input.tagCommit      commit the tag points at
 * @param {string} input.mainCommit     commit `main` points at
 * @param {boolean} input.isAncestor    true when tagCommit is an ancestor of (or equal to) mainCommit
 * @param {string} [input.mainRef]      name of the main ref, for messages (default "main")
 * @param {boolean} [input.allowOffMain] explicit operator override, for rebuilding a past release
 * @param {boolean} [input.shallow]     true when git says this repository is a shallow clone
 */
export function checkReleaseBranch({
  tag,
  tagCommit,
  mainCommit,
  isAncestor,
  mainRef = 'main',
  allowOffMain = false,
  shallow = false,
}) {
  // A shallow clone truncates history at an arbitrary boundary, so `git merge-base --is-ancestor`
  // answers about the commits it happens to have, not about the real history. In a depth-1 checkout
  // it reports "not an ancestor" for tags that ARE on main — a false alarm that invites an operator
  // to "fix" a repository that is fine, or (worse) to reach for --allow-off-main. Answering
  // "cannot tell, and here is how to fetch what is needed" is the only honest verdict, and it comes
  // before the missing-input check because a shallow clone is often the *reason* a ref is missing.
  if (shallow) {
    return {
      ok: false,
      code: 'SHALLOW_CLONE',
      message:
        'this repository is a shallow clone, so an ancestry answer would be a guess. ' +
        'Run `git fetch --unshallow --tags` (CI: actions/checkout with `fetch-depth: 0`) and check again.',
    };
  }
  if (!tag || !tagCommit || !mainCommit) {
    return { ok: false, code: 'MISSING_INPUT', message: 'tag, tagCommit and mainCommit are all required.' };
  }
  if (isAncestor) {
    return {
      ok: true,
      code: 'ON_MAIN',
      message: `${tag} (${short(tagCommit)}) is on ${mainRef} (${short(mainCommit)}) — the released tree is the verified main tree.`,
    };
  }
  if (allowOffMain) {
    return {
      ok: true,
      code: 'OVERRIDDEN',
      message: `${tag} (${short(tagCommit)}) is NOT on ${mainRef} (${short(mainCommit)}), but --allow-off-main was passed. ` +
        'This must be recorded in the release notes.',
    };
  }
  return {
    ok: false,
    code: 'OFF_MAIN',
    message:
      `${tag} (${short(tagCommit)}) is not an ancestor of ${mainRef} (${short(mainCommit)}). ` +
      `Merge the work into ${mainRef} and tag the merged commit before publishing — do not publish from a development branch.`,
  };
}

const short = (sha) => String(sha ?? '').slice(0, 7);
