/**
 * Release-note gate (D-3).
 *
 * The published release text must be the reviewed `docs/V<version>_RELEASE_NOTES.md`, which carries
 * the mandatory verification disclosures (two-PC and hardware still pending, the CI anomaly, the
 * "not claimed" list). CI-generated notes cannot contain those, so the release job refuses to
 * upload anything unless the reviewed file is present, complete, and free of unfilled
 * placeholders such as `<hash>` or `<bytes>`.
 */

/** Sections a release note must contain. Each entry is a label and a matcher for its heading. */
export const REQUIRED_SECTIONS = Object.freeze([
  ['what is new', /^##\s+what[’']?s new\b/im],
  ['installation', /^##\s+installation\b/im],
  // Version-agnostic on purpose (R-02): v1.1.4 required the literal "upgrading from v1.1.3", which
  // a v1.1.5 file could only satisfy by describing the wrong upgrade path. The heading must name a
  // version older than the release, checked in checkReleaseNotes().
  ['upgrading from the previous release', /^##\s+upgrading from\b/im],
  ['backup', /^##\s+backup\b/im],
  ['rollback', /^##\s+rollback\b/im],
  ['verification status', /^##\s+verification status\b/im],
  ['known limitations', /^##\s+known limitations\b/im],
  ['verify your download', /^##\s+verify (your|the) download\b/im],
]);

/** Phrases that must appear, because they are the disclosures the owner requires. */
export const REQUIRED_STATEMENTS = Object.freeze([
  ['pending physical verification', /(pending|BLOCKED \/ NOT VERIFIED|not verified)/i],
  ['no SmartScreen or reputation claim', /smartscreen/i],
  ['checksum instructions', /sha256sums\.txt/i],
]);

/** `<bytes>`, `<hash>`, `<subject>`, … — values that must be filled before publishing. */
const PLACEHOLDER = /<[A-Za-z][^<>\n]{0,60}>/g;

/**
 * @param {string} text
 * @param {{requireFilled?: boolean, requireSections?: boolean}} [options]
 * @returns {{issues: string[], placeholders: string[]}}
 */
export function checkReleaseNotes(text, options = {}) {
  const { requireFilled = false, requireSections = true, version } = options;
  const issues = [];
  const body = typeof text === 'string' ? text : '';

  if (!body.trim()) {
    return { issues: ['release notes are empty'], placeholders: [] };
  }

  if (requireSections) {
    for (const [label, matcher] of REQUIRED_SECTIONS) {
      if (!matcher.test(body)) issues.push(`missing required section: ${label}`);
    }
    // The upgrade section must describe a real, older baseline — "Upgrading from v1.1.5" in a
    // v1.1.5 note is not an upgrade path.
    const upgrade = /^##\s+upgrading from\s+v?(\d+\.\d+\.\d+)\b/im.exec(body);
    if (upgrade && version) {
      const named = upgrade[1];
      const toParts = (v) => String(v).split('.').map(Number);
      const [a1, a2, a3] = toParts(named);
      const [b1, b2, b3] = toParts(version);
      const older = a1 < b1 || (a1 === b1 && (a2 < b2 || (a2 === b2 && a3 < b3)));
      if (!older) {
        issues.push(
          `the upgrade section names v${named}, which is not older than the release version ${version}`,
        );
      }
    }
    for (const [label, matcher] of REQUIRED_STATEMENTS) {
      if (!matcher.test(body)) issues.push(`missing required disclosure: ${label}`);
    }
  }

  const placeholders = [...new Set(body.match(PLACEHOLDER) ?? [])];
  if (placeholders.length && requireFilled) {
    issues.push(
      `unfilled placeholders (${placeholders.length}): ${placeholders.slice(0, 8).join(', ')}${
        placeholders.length > 8 ? ', …' : ''
      }`,
    );
  }

  return { issues, placeholders };
}
