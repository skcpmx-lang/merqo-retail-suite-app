import type { JSX } from 'react';

const PATHS: Record<string, JSX.Element> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7.5" height="7.5" rx="2" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="2" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="2" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2" />
    </>
  ),
  pos: (
    <>
      <path d="M3 4h2.5l2.2 10.2A2 2 0 0 0 9.66 16h8.1a2 2 0 0 0 1.96-1.6L21 8H6" />
      <circle cx="10" cy="20" r="1.4" />
      <circle cx="18" cy="20" r="1.4" />
    </>
  ),
  product: (
    <>
      <path d="M20.5 7.3 12 3 3.5 7.3v9.4L12 21l8.5-4.3z" />
      <path d="M3.5 7.3 12 11.6l8.5-4.3M12 11.6V21" />
    </>
  ),
  stock: (
    <>
      <path d="M3 9.5 12 4l9 5.5V19a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19z" />
      <path d="M8 20.5v-6h8v6" />
    </>
  ),
  cart: (
    <>
      <path d="M4 5h3l2.4 9.5a2 2 0 0 0 1.94 1.5h6.9a2 2 0 0 0 1.94-1.5L21.5 8H8" />
      <circle cx="11" cy="19.5" r="1.3" />
      <circle cx="18" cy="19.5" r="1.3" />
    </>
  ),
  purchase: (
    <>
      <path d="M12 3v12m0 0 4-4m-4 4-4-4" />
      <path d="M4 17v2.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V17" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 5.2a3.2 3.2 0 0 1 0 6.1M17.5 20a6.4 6.4 0 0 0-1.6-4.2A5 5 0 0 1 21.5 20" />
    </>
  ),
  supplier: (
    <>
      <path d="M2.5 7.5 12 3l9.5 4.5V17L12 21l-9.5-4z" />
      <path d="M7 10.5v5l5 2.4 5-2.4v-5" />
    </>
  ),
  expense: (
    <>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M9 9h6M9 13h6M9 17h3" />
    </>
  ),
  cash: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M6 12h.01M18 12h.01" />
    </>
  ),
  return: (
    <>
      <path d="M3 10a9 9 0 1 1 3 6.7" />
      <path d="M3 4.5V10h5.5" />
    </>
  ),
  report: (
    <>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </>
  ),
  chart: (
    <>
      <path d="M3 20h18" />
      <path d="M6 16V9M11 16V5M16 16v-4M21 16v-8" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.11a1.7 1.7 0 0 0-1.1-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06A2 2 0 1 1 3.7 16.9l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H2.4a2 2 0 1 1 0-4h.11A1.7 1.7 0 0 0 4.1 8.9a1.7 1.7 0 0 0-.34-1.87L3.7 6.97A2 2 0 1 1 6.53 4.14l.06.06a1.7 1.7 0 0 0 1.87.34H8.6a1.7 1.7 0 0 0 1.03-1.56V2.9a2 2 0 1 1 4 0v.11a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08a1.7 1.7 0 0 0 1.56 1.03H21.6a2 2 0 1 1 0 4h-.11A1.7 1.7 0 0 0 19.4 15z" />
    </>
  ),
  backup: (
    <>
      <ellipse cx="12" cy="5.5" rx="8" ry="3" />
      <path d="M4 5.5v13c0 1.66 3.58 3 8 3s8-1.34 8-3v-13" />
      <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l8 3v6c0 4.4-3.2 8.2-8 9.5C7.2 20.2 4 16.4 4 12V6z" />
      <path d="M9 12l2.2 2.2L15.5 10" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5M12 7.6h.01" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  check: <path d="m4.5 12.5 5 5L20 7" />,
  print: (
    <>
      <path d="M7 8V3.5h10V8" />
      <rect x="3" y="8" width="18" height="8.5" rx="2" />
      <path d="M7 16.5h10v4H7z" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13.5h9L17.5 7" />
    </>
  ),
  edit: (
    <>
      <path d="M4 20h4L20 8l-4-4L4 16z" />
      <path d="m14.5 5.5 4 4" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5" />
      <path d="M4 18.5V21h16v-2.5" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" />
      <path d="M4 18.5V21h16v-2.5" />
    </>
  ),
  barcode: (
    <>
      <path d="M3 5v14M6.5 5v14M10 5v10M13.5 5v14M17 5v10M20.5 5v14" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2.5" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V12l3.2 2" />
    </>
  ),
  logout: (
    <>
      <path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15" />
      <path d="M10 8 6 12l4 4M6 12h9" />
    </>
  ),
  lock: (
    <>
      <rect x="4.5" y="10" width="15" height="11" rx="2.5" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 8-8 3 3-2 2-2-2-3 3" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.3-5.6" />
      <path d="M20 4v4.5h-4.5" />
    </>
  ),
  warning: (
    <>
      <path d="M12 3.5 22 20H2z" />
      <path d="M12 9.5v4.5M12 17.2h.01" />
    </>
  ),
  chevronLeft: <path d="m14.5 6-6 6 6 6" />,
  chevronRight: <path d="m9.5 6 6 6-6 6" />,
  chevronDown: <path d="m6 9.5 6 6 6-6" />,
  filter: <path d="M3 5h18l-7 8v6l-4 2v-8z" />,
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  list: <path d="M4 6h16M4 12h16M4 18h16" />,
  tag: (
    <>
      <path d="M3 12V4.5A1.5 1.5 0 0 1 4.5 3H12l9 9-9 9z" />
      <circle cx="7.5" cy="7.5" r="1.3" />
    </>
  ),
  box: (
    <>
      <rect x="3.5" y="7" width="17" height="13" rx="2" />
      <path d="M3.5 11h17M9 7v4M15 7v4" />
    </>
  ),
  scan: (
    <>
      <path d="M3 8V5.5A2.5 2.5 0 0 1 5.5 3H8M16 3h2.5A2.5 2.5 0 0 1 21 5.5V8M21 16v2.5a2.5 2.5 0 0 1-2.5 2.5H16M8 21H5.5A2.5 2.5 0 0 1 3 18.5V16" />
      <path d="M3 12h18" />
    </>
  ),
  file: (
    <>
      <path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z" />
      <path d="M13 3v6h6" />
    </>
  ),
  wallet: (
    <>
      <rect x="3" y="6" width="18" height="13" rx="2.5" />
      <path d="M3 10h18M16.5 14.5h.01" />
    </>
  ),
};

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 18,
  strokeWidth = 1.7,
  className,
  style,
}: {
  name: IconName | string;
  size?: number;
  strokeWidth?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const path = PATHS[name] ?? PATHS.info!;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
    >
      {path}
    </svg>
  );
}

/** Original Sauda product mark: an abstract ledger "S" inside a rounded tile. */
export function SaudaLogo({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-label="Sauda">
      <rect width="48" height="48" rx="13" fill="url(#sauda-grad)" />
      <path
        d="M30.5 16.5c-1.5-2.1-4-3.3-6.9-3.3-4.2 0-7.1 2.2-7.1 5.4 0 3 2.3 4.5 6.3 5.5 3.6.9 5 1.6 5 3.3 0 1.8-1.8 3-4.6 3-2.9 0-5.2-1.2-6.8-3.4"
        stroke="#eafaf5"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <circle cx="33.5" cy="33" r="3.2" fill="#e9a23b" />
      <defs>
        <linearGradient id="sauda-grad" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop stopColor="#12907e" />
          <stop offset="1" stopColor="#06372f" />
        </linearGradient>
      </defs>
    </svg>
  );
}
