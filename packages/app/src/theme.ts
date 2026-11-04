export type ThemePref = 'light' | 'dark' | 'system';

const MEDIA = '(prefers-color-scheme: dark)';

function effective(pref: ThemePref): 'light' | 'dark' {
  if (pref === 'system') {
    return typeof window !== 'undefined' && window.matchMedia?.(MEDIA).matches ? 'dark' : 'light';
  }
  return pref;
}

/** Applies the theme to <html data-theme>; safe to call before first paint. */
export function applyTheme(pref: ThemePref): void {
  if (typeof document === 'undefined') return;
  const theme = effective(pref);
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme;
  document.body?.classList.toggle('theme-dark', theme === 'dark');
}

/** Keeps 'system' in sync when the OS theme changes while the app is open. */
export function watchSystemTheme(pref: ThemePref): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
  const mq = window.matchMedia(MEDIA);
  const handler = () => {
    if (pref === 'system') applyTheme('system');
  };
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}
