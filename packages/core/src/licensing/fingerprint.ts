import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { DeviceFingerprint, DeviceFingerprintComponent } from '../domain/types.js';
import { canonicalJson, sha256Hex } from './crypto.js';

/**
 * Device fingerprint strategy (documented in docs/04-licensing.md).
 *
 * We deliberately DO NOT use: computer name, Windows user account, Windows
 * installation id, MAC address alone, or any registry value that changes on a
 * Windows reinstall.
 *
 * Instead we hash stable hardware identities exposed by the firmware:
 *
 *   board_uuid   45%  SMBIOS system UUID  — survives Windows reinstall
 *   disk_serial  30%  primary physical disk serial number
 *   cpu_id       15%  processor id
 *   bios_serial  10%  BIOS serial number
 *
 * Only SHA-256 hashes of the individual values ever leave the machine — the raw
 * hardware identifiers are never stored in a licence or in the database.
 *
 * Matching is weighted: the sum of the weights of the components that still
 * match must reach 60%. That tolerates a single component replacement (e.g. a
 * new SSD: 45+15+10 = 70%) while a different computer scores ~0%.
 */

export const FINGERPRINT_VERSION = 1;
export const MATCH_THRESHOLD = 0.6;

export const COMPONENT_WEIGHTS: Record<string, number> = {
  board_uuid: 45,
  disk_serial: 30,
  cpu_id: 15,
  bios_serial: 10,
};

export const COMPONENT_LABELS: Record<string, string> = {
  board_uuid: 'মাদারবোর্ড UUID',
  disk_serial: 'প্রাইমারি ডিস্ক সিরিয়াল',
  cpu_id: 'প্রসেসর আইডি',
  bios_serial: 'BIOS সিরিয়াল',
};

/** Firmware placeholders that must never be treated as a real identity. */
const PLACEHOLDER = /^(to be filled by o\.e\.m\.?|default string|none|unknown|0{8,}|f{8,}|0{4}-0{4})$/i;

function clean(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (PLACEHOLDER.test(text)) return null;
  if (/^0+$/.test(text.replace(/[-:]/g, ''))) return null;
  if (/^f+$/i.test(text.replace(/[-:]/g, ''))) return null;
  if (/^03000200-0400-0500-0006-000700080009$/i.test(text)) return null;
  return text;
}

function runPowershell(command: string): string | null {
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { encoding: 'utf8', timeout: 12_000, windowsHide: true },
    );
    return clean(out);
  } catch {
    return null;
  }
}

function runWmic(args: string[]): string | null {
  try {
    const out = execFileSync('wmic', args, { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    const lines = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    // first line is the column header
    return clean(lines[1] ?? null);
  } catch {
    return null;
  }
}

function windowsValue(powershell: string, wmicArgs: string[]): string | null {
  return runPowershell(powershell) ?? runWmic(wmicArgs);
}

function linuxDiskSerial(): string | null {
  try {
    const blocks = fs.readdirSync('/sys/block').filter((b) => /^(sd|nvme|vd|mmcblk)/.test(b));
    for (const b of blocks) {
      for (const p of [`/sys/block/${b}/device/serial`, `/sys/block/${b}/serial`]) {
        try {
          const v = clean(fs.readFileSync(p, 'utf8'));
          if (v) return v;
        } catch {
          /* next */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function macDiskSerial(): string | null {
  try {
    const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
      encoding: 'utf8',
      timeout: 8000,
    });
    const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    return clean(m?.[1] ?? null);
  } catch {
    return null;
  }
}

/** Collect the raw (unhashed) hardware identifiers for the current machine. */
export function collectRawComponents(platform: string = process.platform): {
  key: string;
  label: string;
  value: string | null;
  weight: number;
}[] {
  if (platform === 'win32') {
    return [
      {
        key: 'board_uuid',
        label: COMPONENT_LABELS.board_uuid!,
        weight: COMPONENT_WEIGHTS.board_uuid!,
        value: windowsValue('(Get-CimInstance Win32_ComputerSystemProduct).UUID', ['csproduct', 'get', 'uuid']),
      },
      {
        key: 'disk_serial',
        label: COMPONENT_LABELS.disk_serial!,
        weight: COMPONENT_WEIGHTS.disk_serial!,
        value: windowsValue(
          '(Get-CimInstance Win32_DiskDrive | Sort-Object Index | Select-Object -First 1).SerialNumber',
          ['diskdrive', 'get', 'serialnumber'],
        ),
      },
      {
        key: 'cpu_id',
        label: COMPONENT_LABELS.cpu_id!,
        weight: COMPONENT_WEIGHTS.cpu_id!,
        value: windowsValue('(Get-CimInstance Win32_Processor).ProcessorId', ['cpu', 'get', 'processorid']),
      },
      {
        key: 'bios_serial',
        label: COMPONENT_LABELS.bios_serial!,
        weight: COMPONENT_WEIGHTS.bios_serial!,
        value: windowsValue('(Get-CimInstance Win32_BIOS).SerialNumber', ['bios', 'get', 'serialnumber']),
      },
    ];
  }
  if (platform === 'darwin') {
    return [
      { key: 'board_uuid', label: COMPONENT_LABELS.board_uuid!, weight: COMPONENT_WEIGHTS.board_uuid!, value: macDiskSerial() },
      {
        key: 'disk_serial',
        label: COMPONENT_LABELS.disk_serial!,
        weight: COMPONENT_WEIGHTS.disk_serial!,
        value: (() => {
          try {
            const out = execFileSync('system_profiler', ['SPStorageDataType'], { encoding: 'utf8', timeout: 15000 });
            const m = out.match(/Volume UUID:\s*([A-Z0-9-]+)/);
            return clean(m?.[1] ?? null);
          } catch {
            return null;
          }
        })(),
      },
      {
        key: 'cpu_id',
        label: COMPONENT_LABELS.cpu_id!,
        weight: COMPONENT_WEIGHTS.cpu_id!,
        value: clean(os.cpus()[0]?.model ?? null),
      },
      { key: 'bios_serial', label: COMPONENT_LABELS.bios_serial!, weight: COMPONENT_WEIGHTS.bios_serial!, value: null },
    ];
  }
  // Linux (and CI): machine-id is stable across reboots but changes on reinstall,
  // so it is only a development fallback. Real installs run on Windows.
  let machineId: string | null = null;
  try {
    machineId = clean(fs.readFileSync('/etc/machine-id', 'utf8'));
  } catch {
    machineId = null;
  }
  let productUuid: string | null = null;
  try {
    productUuid = clean(fs.readFileSync('/sys/class/dmi/id/product_uuid', 'utf8'));
  } catch {
    productUuid = null;
  }
  return [
    { key: 'board_uuid', label: COMPONENT_LABELS.board_uuid!, weight: COMPONENT_WEIGHTS.board_uuid!, value: productUuid ?? machineId },
    { key: 'disk_serial', label: COMPONENT_LABELS.disk_serial!, weight: COMPONENT_WEIGHTS.disk_serial!, value: linuxDiskSerial() ?? machineId },
    {
      key: 'cpu_id',
      label: COMPONENT_LABELS.cpu_id!,
      weight: COMPONENT_WEIGHTS.cpu_id!,
      value: clean(`${os.cpus()[0]?.model ?? ''}/${os.arch()}/${os.cpus().length}`),
    },
    { key: 'bios_serial', label: COMPONENT_LABELS.bios_serial!, weight: COMPONENT_WEIGHTS.bios_serial!, value: null },
  ];
}

/** Turn raw identifiers into the stamped fingerprint stored in a licence. */
export function fingerprintFromComponents(
  raw: { key: string; label: string; value: string | null; weight: number }[],
  platform: string = process.platform,
): DeviceFingerprint {
  const components = raw
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((c) => ({
      key: c.key,
      hash: c.value ? sha256Hex(`${c.key}:${c.value}`).slice(0, 32) : '',
      weight: c.weight,
    }));
  const hash = sha256Hex(canonicalJson(components)).slice(0, 40);
  return {
    version: FINGERPRINT_VERSION,
    hash,
    components,
    collected_at: new Date().toISOString(),
    platform,
  };
}

export function componentsWithAvailability(
  raw: { key: string; label: string; value: string | null; weight: number }[],
): DeviceFingerprintComponent[] {
  return raw.map((c) => ({
    key: c.key,
    label: c.label,
    value: c.value ? `••••${c.value.slice(-4)}` : 'পাওয়া যায়নি',
    weight: c.weight,
    available: Boolean(c.value),
  }));
}

let cached: DeviceFingerprint | null = null;

export function getDeviceFingerprint(force = false): DeviceFingerprint {
  if (!force && cached) return cached;
  const raw = collectRawComponents();
  const available = raw.filter((c) => c.value).length;
  if (available === 0) {
    // Absolute last resort so the app can still start and explain the problem.
    const fallback = `${os.hostname()}|${os.platform()}|${os.arch()}`;
    const fingerprint = fingerprintFromComponents(
      raw.map((c, i) => ({ ...c, value: i === 0 ? fallback : null })),
    );
    cached = fingerprint;
    return fingerprint;
  }
  cached = fingerprintFromComponents(raw);
  return cached;
}

export interface MatchResult {
  ok: boolean;
  score: number;
  matched: { key: string; matched: boolean; weight: number }[];
  message: string;
}

export function compareFingerprints(licensed: DeviceFingerprint, current: DeviceFingerprint): MatchResult {
  if (licensed.version !== current.version) {
    return {
      ok: false,
      score: 0,
      matched: [],
      message: 'ডিভাইস ফিঙ্গারপ্রিন্ট ভার্সন মিলছে না — লাইসেন্সটি পুনরায় তৈরি করতে হবে।',
    };
  }
  const matched: { key: string; matched: boolean; weight: number }[] = [];
  let totalWeight = 0;
  let matchedWeight = 0;
  for (const lc of licensed.components) {
    if (!lc.hash) continue; // the licensed device could not read it → ignore
    const cc = current.components.find((c) => c.key === lc.key);
    totalWeight += lc.weight;
    const isMatch = Boolean(cc && cc.hash && cc.hash === lc.hash);
    if (isMatch) matchedWeight += lc.weight;
    matched.push({ key: lc.key, matched: isMatch, weight: lc.weight });
  }
  if (totalWeight === 0) {
    return { ok: false, score: 0, matched, message: 'এই ডিভাইসে প্রয়োজনীয় হার্ডওয়্যার তথ্য পাওয়া যায়নি।' };
  }
  const score = matchedWeight / totalWeight;
  return {
    ok: score >= MATCH_THRESHOLD,
    score,
    matched,
    message:
      score >= MATCH_THRESHOLD
        ? 'ডিভাইস মিলেছে।'
        : `এই লাইসেন্সটি অন্য কম্পিউটারের জন্য তৈরি। মিল: ${(score * 100).toFixed(0)}% (প্রয়োজন ${(
            MATCH_THRESHOLD * 100
          ).toFixed(0)}%)।`,
  };
}

export function fingerprintForDisplay(): { hash: string; components: DeviceFingerprintComponent[]; platform: string } {
  const raw = collectRawComponents();
  const fp = fingerprintFromComponents(raw);
  return { hash: fp.hash, components: componentsWithAvailability(raw), platform: fp.platform };
}

export function testFingerprint(seed: string): DeviceFingerprint {
  return fingerprintFromComponents(
    Object.keys(COMPONENT_WEIGHTS).map((key) => ({
      key,
      label: COMPONENT_LABELS[key] ?? key,
      weight: COMPONENT_WEIGHTS[key]!,
      value: sha256Hex(`${seed}:${key}`),
    })),
    'test',
  );
}

export function deviceIdForSupport(hash: string): string {
  // Human-readable, non-reversible short id the customer can read over the phone.
  const group = hash.slice(0, 16).toUpperCase().match(/.{1,4}/g) ?? [];
  return group.join('-');
}

export const nodeCrypto = crypto;
