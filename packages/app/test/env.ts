/**
 * Minimal browser-ish globals for renderer smoke tests.
 *
 * The real UI runs inside Electron, so a plain Node environment has no `window`.
 * Importing this module first gives the pages exactly the surface they touch at
 * module scope (the preload bridge, matchMedia, storage, size), so we can render
 * every screen to a string and catch crashes without a display server.
 */
const listeners = new Map<string, Set<(ev: unknown) => void>>();

export const bridgeCalls: string[] = [];

export const stubWindow = {
  sauda: {
    invoke: async (method: string) => {
      bridgeCalls.push(method);
      return { ok: true, data: null as unknown };
    },
    onEvent: () => () => undefined,
    platform: 'test',
    versions: { electron: '0.0.0-test', chrome: '0.0.0-test', node: '0.0.0-test' },
  },
  matchMedia: (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }),
  addEventListener: (type: string, cb: (ev: unknown) => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(cb);
  },
  removeEventListener: (type: string, cb: (ev: unknown) => void) => {
    listeners.get(type)?.delete(cb);
  },
  dispatchEvent: () => true,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  requestAnimationFrame: (cb: (t: number) => void) => globalThis.setTimeout(() => cb(0), 0),
  cancelAnimationFrame: (id: number) => globalThis.clearTimeout(id),
  innerWidth: 1440,
  innerHeight: 900,
  localStorage: {
    store: new Map<string, string>(),
    getItem(key: string) {
      return this.store.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      this.store.set(key, value);
    },
    removeItem(key: string) {
      this.store.delete(key);
    },
  },
};

(globalThis as unknown as { window: unknown }).window = stubWindow;
if (typeof (globalThis as unknown as { navigator?: unknown }).navigator === 'undefined') {
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'bn-BD', userAgent: 'vitest' },
    configurable: true,
  });
}
