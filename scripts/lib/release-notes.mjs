/**
 * Release-note gate (D-3).
 *
 * The published release text must be the reviewed `docs/V1.1.4_RELEASE_NOTES.md`, which carries
 * the mandatory verification disclosures (two-PC and hardware still pending, the CI anomaly, the
 * "not claimed" list). CI-generated notes cannot contain those, so the release job refuses to
 * upload anything unless the reviewed file is present, complete, and free of unfilled
 * placeholders such as `<hash>` or `<bytes>`.
 */

/** Sections a release note must contain. Each entry is a label and a matcher for its heading. */
export const REQUIRED_SECTIONS = Object.freeze([
  ['what is new', /^##\s+what[’']?s new\b/im],
  ['installation', /^##\s+installation\b/im],
  ['upgrading from v1.1.3', /^##\s+upgrading from v1\.1\.3\b/im],
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
  const { requireFilled = false, requireSections = true } = options;
  const issues = [];
  const body = typeof text === 'string' ? text : '';

  if (!body.trim()) {
    return { issues: ['release notes are empty'], placeholders: [] };
  }

  if (requireSections) {
    for (const [label, matcher] of REQUIRED_SECTIONS) {
      if (!matcher.test(body)) issues.push(`missing required section: ${label}`);
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
