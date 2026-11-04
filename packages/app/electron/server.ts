import { ServerRuntime, type ServerHealth } from './server-runtime.js';

/**
 * Process-wide handle to the Main Server runtime.
 *
 * The runtime itself is created once, in `main.ts`, and shared with the IPC layer
 * through this module so that the Server (a) is never duplicated inside the
 * process and (b) is reachable from the settings/tray UI without importing
 * Electron into the route table.
 */

let runtime: ServerRuntime | null = null;

export function initServerRuntime(instance: ServerRuntime): ServerRuntime {
  runtime = instance;
  return runtime;
}

export function getServerRuntime(): ServerRuntime | null {
  return runtime;
}

export function serverHealth(): ServerHealth | null {
  return runtime ? runtime.health() : null;
}
