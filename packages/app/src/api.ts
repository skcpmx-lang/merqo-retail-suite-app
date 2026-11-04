export interface BridgeResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: string;
  /** Structured failure payload (e.g. stale-cart conflicts). */
  details?: unknown;
}

interface SaudaBridge {
  invoke: (method: string, args?: unknown[]) => Promise<BridgeResponse>;
  onEvent: (cb: (payload: { type: string; message?: string }) => void) => () => void;
  onV1Event?: (cb: (payload: ShopEvent) => void) => () => void;
  platform: string;
  versions: { electron: string; chrome: string; node: string };
}

declare global {
  interface Window {
    sauda: SaudaBridge;
  }
}

/**
 * An event from the Main PC's authenticated stream (client mode). It is a *hint*:
 * the renderer refetches through the normal routes and never renders payload data as
 * if it were the source of truth.
 */
export interface ShopEvent {
  kind: 'event' | 'state' | 'resync';
  id?: number;
  type?: string;
  data?: unknown;
  state?: string;
  detail?: string;
  from?: number;
}

export class ApiError extends Error {
  code: string;
  /**
   * Structured failure payload from the backend. For a stale cart this is
   * `{ conflicts: [...] }`, which is what lets the POS mark the exact lines that moved.
   */
  details?: unknown;
  constructor(message: string, code = 'ERROR', details?: unknown) {
    super(message);
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** Single entry point for every backend call. Errors carry the Bangla message. */
export async function call<T = any>(method: string, ...args: unknown[]): Promise<T> {
  if (!window.sauda) throw new ApiError('অ্যাপ্লিকেশন ব্রিজ পাওয়া যায়নি — অনুগ্রহ করে অ্যাপটি পুনরায় চালু করুন।');
  const res = await window.sauda.invoke(method, args);
  if (!res.ok) {
    // The licence gate lives in the main process; when it fires the shell must
    // fall back to the activation screen instead of leaving dead buttons.
    if (res.code === 'LICENSE_REQUIRED') window.dispatchEvent(new Event('sauda:license-required'));
    throw new ApiError(res.error || 'অজানা ত্রুটি', res.code, res.details);
  }
  return res.data as T;
}

export function onV1Event(cb: (payload: ShopEvent) => void): () => void {
  if (!window.sauda?.onV1Event) return () => undefined;
  return window.sauda.onV1Event(cb);
}

export function onEvent(cb: (payload: { type: string; message?: string }) => void): () => void {
  if (!window.sauda?.onEvent) return () => undefined;
  return window.sauda.onEvent(cb);
}

/** Raw base64 image data URL for a locally stored image (used for logos/photos). */
export async function fileToDataUrl(_path: string): Promise<string | null> {
  return null;
}

export const platform = window.sauda?.platform ?? 'web';
