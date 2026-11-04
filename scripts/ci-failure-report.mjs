/**
 * CI failure report.
 *
 * The GitHub runner log for a long job is served from blob storage and is frequently not
 * downloadable from a restricted network, while check-run annotations and the job summary always
 * are. This script turns the captured gate log into both:
 *
 *  - a job summary section that lists every failing test, its assertion message and the first
 *    stack frames, plus the tail of the log (never truncated),
 *  - `::error title=…` annotations for the most important lines (the runner caps those, the
 *    summary does not).
 *
 * It is deliberately defensive: a reporting failure must never change the outcome of a run.
 *
 *   node scripts/ci-failure-report.mjs --log ci-verify.log --label windows
 */
import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const logPath = arg('--log', 'ci-verify.log');
const label = arg('--label', 'ci');

const MAX_ANNOTATIONS = 10;

const clean = (text) =>
  String(text)
    .replace(/\r/g, '')
    .replace(/%/g, '%25')
    .replace(/\n/g, ' ');

const annotate = (level, title, message) => {
  const body = clean(message).slice(0, 900);
  console.log(`::${level} title=${title}::${body}`);
};

let log = '';
try {
  log = fs.readFileSync(logPath, 'utf8');
} catch {
  log = '';
}

const lines = log.split(/\r?\n/);

/** A failing vitest test header looks like ` FAIL  packages/core/test/x.test.ts > suite > name`. */
const isFailHeader = (line) => /^\s*(FAIL|×|✘)\s+\S+/.test(line) || /^\s*FAIL\s/.test(line);
/** Assertion and error lines we always want to show. */
const isErrorLine = (line) =>
  /^\s*(AssertionError|Error|TypeError|ReferenceError|RangeError|SyntaxError|TimeoutError)\b/.test(line) ||
  /^\s*(expected|Received|actual)\b.*/.test(line);
const isFrame = (line) => /^\s+at\s+.*[(:]/.test(line) || /^\s*❯\s/.test(line);
/** Vitest prints the assertion diff as `- expected` / `+ received` lines and a caret block. */
const isDiffLine = (line) => /^\s{0,4}[-+]\s/.test(line) || /^\s*\^+\s*$/.test(line);
const isSummaryLine = (line) =>
  /^\s*(Test Files|Tests|Duration|Start at|Snapshots)\s/.test(line) ||
  /^\s*✖\s+(typecheck|tests|ui wiring|license generator wiring|icons|build|electron trust|secrets|dependency)/.test(line) ||
  /^✖ verify failed:/.test(line);

const blocks = [];
let current = null;
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  if (isFailHeader(line)) {
    if (current) blocks.push(current);
    current = { header: line.trim(), detail: [] };
    continue;
  }
  if (current) {
    if (isErrorLine(line) || isFrame(line) || isDiffLine(line)) {
      if (current.detail.length < 14) current.detail.push(line.trimEnd());
    } else if (/^\s*$/.test(line)) {
      // keep blanks out of the block but do not close it: vitest may continue the same block
    } else if (isFailHeader(line) || isSummaryLine(line)) {
      blocks.push(current);
      current = null;
      i -= 1;
    }
  }
}
if (current) blocks.push(current);

const summaries = lines.filter(isSummaryLine);
const failedSteps = lines.filter((line) => /^✖\s+\S/.test(line) || /^✖ verify failed:/.test(line));

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
const section = [];
section.push(`## ${label}: gate log analysis`);
if (!lines.filter(Boolean).length) {
  section.push('_the gate log was empty or missing_');
} else {
  if (failedSteps.length) {
    section.push('### Failing gate steps');
    section.push('```');
    section.push(...failedSteps.slice(0, 20));
    section.push('```');
  }
  if (summaries.length) {
    section.push('### Vitest summary lines');
    section.push('```');
    section.push(...summaries.slice(-20));
    section.push('```');
  }
  if (blocks.length) {
    section.push(`### Failing tests (${blocks.length})`);
    for (const block of blocks.slice(0, 40)) {
      section.push('```');
      section.push(block.header);
      section.push(...block.detail);
      section.push('```');
    }
  }
  section.push('### Tail of the gate log (last 150 lines)');
  section.push('```');
  section.push(...lines.slice(-150));
  section.push('```');
}

if (summaryPath) {
  try {
    fs.appendFileSync(summaryPath, `${section.join('\n')}\n`);
  } catch {
    /* reporting must never fail the build */
  }
}

// Annotations: the failing steps first, then the failing test headers with their assertion line.
let emitted = 0;
for (const line of failedSteps) {
  if (emitted >= MAX_ANNOTATIONS) break;
  emitted += 1;
  annotate('error', `gate-step-${label}`, line);
}
for (const block of blocks) {
  if (emitted >= MAX_ANNOTATIONS) break;
  emitted += 1;
  annotate('error', `failing-test-${label}`, `${block.header} :: ${block.detail.slice(0, 4).join(' | ')}`);
}
if (!emitted && lines.filter(Boolean).length) {
  annotate('error', `gate-tail-${label}`, lines.filter(Boolean).slice(-6).join(' | '));
}

console.log(`[ci-failure-report] ${blocks.length} failing test block(s), ${emitted} annotation(s), summary written`);
