#!/usr/bin/env node
/**
 * Refuses to publish a release whose tag is not on `main` (v1.2.0, requirement #20).
 *
 *   node scripts/audit-release-branch.mjs                      # HEAD's tag vs origin/main
 *   node scripts/audit-release-branch.mjs --tag v1.2.0
 *   node scripts/audit-release-branch.mjs --main origin/main --allow-off-main
 *
 * Exit 0 = the tagged commit is on main (or the operator explicitly overrode it).
 * Exit 1 = the tagged commit is not on main. This step runs in release.yml before the draft release
 * is created, so an unmerged branch can never be published again.
 *
 * When the refs cannot be resolved (a shallow checkout without `main`, for example) the script fails
 * closed: an unverifiable release is not a verified release.
 */
import { spawnSync } from 'node:child_process';
import { checkReleaseBranch } from './lib/release-branch.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const tag = value('--tag', process.env.GITHUB_REF_NAME ?? 'HEAD');
const mainRef = value('--main', 'origin/main');
const allowOffMain = flag('--allow-off-main');

const git = (gitArgs) => spawnSync('git', gitArgs, { encoding: 'utf8' });
const rev = (ref) => {
  const res = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return res.status === 0 ? res.stdout.trim() : '';
};

const tagCommit = rev(tag);
const mainCommit = rev(mainRef);

if (!tagCommit || !mainCommit) {
  console.error(
    `✖ release-branch gate: cannot resolve ${tagCommit ? mainRef : tag} — refusing to treat an unverifiable release as verified.`,
  );
  process.exit(1);
}

// `git merge-base --is-ancestor A B` exits 0 when A is an ancestor of B (or equal to it).
const ancestry = git(['merge-base', '--is-ancestor', tagCommit, mainCommit]);
const isAncestor = ancestry.status === 0;

const verdict = checkReleaseBranch({ tag, tagCommit, mainCommit, isAncestor, mainRef, allowOffMain });
if (!verdict.ok) {
  console.error(`✖ release-branch gate: ${verdict.message}`);
  process.exit(1);
}
console.log(`✔ release-branch gate: ${verdict.message}`);
