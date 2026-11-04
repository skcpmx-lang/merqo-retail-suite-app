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
  /**
   * Shop events from the Main PC's authenticated stream (client mode). The payload is
   * a hint to refetch — it is never treated as authoritative data.
   */
  onV1Event: (
    cb: (payload: {
      kind: 'event' | 'state' | 'resync';
      id?: number;
      type?: string;
      data?: unknown;
      state?: string;
      detail?: string;
      from?: number;
    }) => void,
  ) => {
    const listener = (_e: unknown, payload: Record<string, unknown>) =>
      cb(payload as { kind: 'event' | 'state' | 'resync' });
    ipcRenderer.on('sauda:v1-event', listener);
    return () => ipcRenderer.removeListener('sauda:v1-event', listener);
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
