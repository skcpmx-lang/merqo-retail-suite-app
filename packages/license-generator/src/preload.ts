import { contextBridge, ipcRenderer } from 'electron';

/**
 * The generator's renderer is a trusted, local-only window; it can still only
 * reach the main process through this explicit, small API surface.
 */
contextBridge.exposeInMainWorld('licgen', {
  invoke: async (method: string, ...args: unknown[]) => {
    const result = await ipcRenderer.invoke('licgen:invoke', method, args);
    if (!result || !result.ok) {
      throw new Error(result?.error ?? 'অজানা ত্রুটি');
    }
    return result.data;
  },
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
  },
});
