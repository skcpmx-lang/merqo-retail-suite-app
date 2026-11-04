export interface BridgeResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: string;
}

interface SaudaBridge {
  invoke: (method: string, args?: unknown[]) => Promise<BridgeResponse>;
  onEvent: (cb: (payload: { type: string; message?: string }) => void) => () => void;
  platform: string;
  versions: { electron: string; chrome: string; node: string };
}

declare global {
  interface Window {
    sauda: SaudaBridge;
  }
}

export class ApiError extends Error {
  code: string;
  constructor(message: string, code = 'ERROR') {
    super(message);
    this.code = code;
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
    throw new ApiError(res.error || 'অজানা ত্রুটি', res.code);
  }
  return res.data as T;
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
