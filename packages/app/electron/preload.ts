import { contextBridge, ipcRenderer } from 'electron';

/**
 * Minimal, audited bridge. The renderer never gets Node.js access — every
 * operation goes through one validated IPC channel.
 */
const bridge = {
  invoke: (method: string, args: unknown[] = []): Promise<{ ok: boolean; data?: any; error?: string; code?: string }> =>
    ipcRenderer.invoke('sauda:invoke', method, args),
  onEvent: (cb: (payload: { type: string; message?: string }) => void) => {
    const listener = (_e: unknown, payload: { type: string; message?: string }) => cb(payload);
    ipcRenderer.on('sauda:event', listener);
    return () => ipcRenderer.removeListener('sauda:event', listener);
  },
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
};

contextBridge.exposeInMainWorld('sauda', bridge);

export type SaudaBridge = typeof bridge;
