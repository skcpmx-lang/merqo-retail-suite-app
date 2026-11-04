/** Bridge to the Electron main process. Nothing else talks to Node. */
export interface LicgenBridge {
  invoke: (method: string, ...args: unknown[]) => Promise<any>;
  platform: string;
  versions: { electron: string; node: string };
}

declare global {
  interface Window {
    licgen?: LicgenBridge;
  }
}

export const hasBridge = Boolean(window.licgen);

export async function call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
  if (!window.licgen) {
    throw new Error('এই উইন্ডোটি অ্যাপ্লিকেশনের বাইরে খোলা হয়েছে — সাউদা লাইসেন্স জেনারেটর চালু করুন।');
  }
  return (await window.licgen.invoke(method, ...args)) as T;
}

export function copyText(text: string): Promise<void> {
  return call('copy', text).then(() => undefined);
}
