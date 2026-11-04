import React, {
  createContext,
  useCallback,
  useRef,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

export function dt(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function dtTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${dt(value)} ${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

export function todayInput(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

export function addDaysInput(days: number): string {
  const now = new Date(Date.now() + days * 86_400_000);
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Icons                                                               */
/* ------------------------------------------------------------------ */

const ICONS: Record<string, string> = {
  dashboard: 'M4 13h6V4H4v9Zm0 7h6v-5H4v5Zm10 0h6V11h-6v9Zm0-16v5h6V4h-6Z',
  users: 'M16 14a4 4 0 1 0-8 0m12 6v-1a5 5 0 0 0-4-4H8a5 5 0 0 0-4 4v1m8-13a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z',
  key: 'M15 7a4 4 0 1 1-3.5 6L9 15.5l-2 2H4v-3l8-8a4 4 0 0 1 3-3.5M16 8h.01',
  license: 'M7 3h7l4 4v14H7V3Zm7 0v4h4M10 12h6M10 16h6M10 8h2',
  plus: 'M12 5v14M5 12h14',
  check: 'M20 6 9 17l-5-5',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.35-4.35',
  print: 'M6 9V3h12v6M6 18H4v-7h16v7h-2M6 14h12v7H6v-7Z',
  download: 'M12 3v12m0 0 4-4m-4 4-4-4M4 21h16',
  upload: 'M12 21V9m0 0 4 4m-4-4-4 4M4 3h16',
  refresh: 'M20 11a8 8 0 1 0-2.3 6.3M20 5v6h-6',
  trash: 'M4 7h16M9 7V4h6v3m-8 0 1 14h8l1-14',
  edit: 'M4 20h4l10-10-4-4L4 16v4Zm10-14 4 4',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3Zm-3 9 2 2 4-4',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v5l3 2',
  file: 'M7 3h7l4 4v14H7V3Zm7 0v4h4',
  alert: 'M12 4 2 20h20L12 4Zm0 5v6m0 3h.01',
  chevron: 'M9 6l6 6-6 6',
  sun: 'M12 4V2m0 20v-2m8-8h2M2 12h2m13.6-5.6 1.4-1.4M4.6 19.4l1.4-1.4m12 0 1.4 1.4M4.6 4.6l1.4 1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8-3a8 8 0 0 0-.1-1.2l2-1.4-2-3.4-2.2.9a8 8 0 0 0-2-1.2L15.4 2h-4l-.3 2.4a8 8 0 0 0-2 1.2l-2.2-.9-2 3.4 2 1.4a8 8 0 0 0 0 2.4l-2 1.4 2 3.4 2.2-.9a8 8 0 0 0 2 1.2l.3 2.4h4l.3-2.4a8 8 0 0 0 2-1.2l2.2.9 2-3.4-2-1.4c.1-.4.1-.8.1-1.2Z',
  database: 'M12 3c4 0 8 1 8 3s-4 3-8 3-8-1-8-3 4-3 8-3Zm8 6v4c0 2-4 3-8 3s-8-1-8-3V9m16 8v4c0 2-4 3-8 3s-8-1-8-3v-4',
  copy: 'M9 9h11v11H9V9Zm-5 6V4h11',
  external: 'M14 4h6v6M20 4 10 14M18 14v6H4V6h6',
  close: 'M6 6l12 12M18 6 6 18',
  eye: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  lock: 'M6 11h12v10H6V11Zm3 0V7a3 3 0 0 1 6 0v4M12 15v2',
  briefcase: 'M3 8h18v12H3V8Zm6 0V5h6v3',
  chart: 'M4 20h16M7 16V9m5 7V5m5 11v-4',
};

export type IconName = keyof typeof ICONS;

/** Bengali digits for UI copy (কী ১, ধাপ ২ …) — keeps the console consistent. */
export function bnNum(value: number | string): string {
  return String(value).replace(/\d/g, (digit) => '০১২৩৪৫৬৭৮৯'[Number(digit)]);
}

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  const path = ICONS[name] ?? ICONS.alert;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d={path} />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Toasts / confirm                                                    */
/* ------------------------------------------------------------------ */

type ToastKind = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
}

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  requireReason?: boolean;
  reasonLabel?: string;
}

interface UICtx {
  success: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
  info: (title: string, message?: string) => void;
  confirm: (options: ConfirmOptions) => Promise<{ ok: boolean; reason?: string }>;
}

const UI = createContext<UICtx | null>(null);

export function useUI(): UICtx {
  const ctx = useContext(UI);
  if (!ctx) throw new Error('UIProvider missing');
  return ctx;
}

export function UIProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmState, setConfirmState] = useState<(ConfirmOptions & { resolve: (v: { ok: boolean; reason?: string }) => void }) | null>(null);
  const [reason, setReason] = useState('');
  const counter = useRef(1);

  const push = useCallback((kind: ToastKind, title: string, message?: string) => {
    const id = counter.current++;
    setToasts((prev) => [...prev, { id, kind, title, message }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4200);
  }, []);

  const value = useMemo<UICtx>(
    () => ({
      success: (title, message) => push('success', title, message),
      error: (title, message) => push('error', title, message),
      info: (title, message) => push('info', title, message),
      confirm: (options) =>
        new Promise((resolve) => {
          setReason('');
          setConfirmState({ ...options, resolve });
        }),
    }),
    [push],
  );

  const close = (ok: boolean) => {
    if (!confirmState) return;
    if (ok && confirmState.requireReason && !reason.trim()) {
      push('error', 'কারণ লিখতে হবে');
      return;
    }
    confirmState.resolve({ ok, reason: reason.trim() || undefined });
    setConfirmState(null);
  };

  return (
    <UI.Provider value={value}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <Icon name={t.kind === 'error' ? 'alert' : t.kind === 'success' ? 'check' : 'alert'} size={16} />
            <div>
              <div className="toast-title">{t.title}</div>
              {t.message ? <div className="toast-msg">{t.message}</div> : null}
            </div>
          </div>
        ))}
      </div>
      {confirmState ? (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-label={confirmState.title}>
            <div className="modal-head">
              <h3>{confirmState.title}</h3>
              <button className="icon-btn" onClick={() => close(false)} aria-label="বন্ধ">
                <Icon name="close" size={16} />
              </button>
            </div>
            <div className="modal-body">
              <p className="muted">{confirmState.message}</p>
              {confirmState.requireReason ? (
                <Field label={confirmState.reasonLabel ?? 'কারণ'}>
                  <textarea
                    className="input"
                    rows={3}
                    value={reason}
                    autoFocus
                    onChange={(e) => setReason(e.target.value)}
                  />
                </Field>
              ) : null}
            </div>
            <div className="modal-foot">
              <Button variant="ghost" onClick={() => close(false)}>
                বাতিল
              </Button>
              <Button variant={confirmState.danger ? 'danger' : 'primary'} onClick={() => close(true)}>
                {confirmState.confirmLabel ?? 'নিশ্চিত করুন'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </UI.Provider>
  );
}

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

export function Button({
  children,
  onClick,
  variant = 'default',
  size,
  icon,
  loading,
  disabled,
  block,
  type = 'button',
  title,
}: {
  children?: ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  variant?: 'default' | 'primary' | 'ghost' | 'danger' | 'warn';
  size?: 'sm' | 'lg';
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  block?: boolean;
  type?: 'button' | 'submit';
  title?: string;
}) {
  return (
    <button
      className={`btn ${variant} ${size ?? ''} ${block ? 'block' : ''}`}
      onClick={onClick}
      disabled={disabled || loading}
      type={type}
      title={title}
    >
      {loading ? <span className="spinner sm" /> : icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      {children}
    </button>
  );
}

export function IconButton({
  icon,
  onClick,
  title,
  danger,
}: {
  icon: IconName;
  onClick?: (e: React.MouseEvent) => void;
  title: string;
  danger?: boolean;
}) {
  return (
    <button className={`icon-btn ${danger ? 'danger' : ''}`} onClick={onClick} title={title} aria-label={title}>
      <Icon name={icon} size={16} />
    </button>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={`card ${className ?? ''}`}>{children}</section>;
}

export function CardHead({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="card-head">
      <div>
        <h3>{title}</h3>
        {sub ? <div className="sub">{sub}</div> : null}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </div>
  );
}

export function PageHead({ title, sub, actions }: { title: string; sub?: string; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {sub ? <p>{sub}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  span,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  span?: 2 | 3;
}) {
  const id = useId();
  return (
    <div className={`field ${span ? `span-${span}` : ''}`}>
      {label ? <label htmlFor={id}>{label}</label> : null}
      {React.isValidElement(children) ? React.cloneElement(children as React.ReactElement<any>, { id }) : children}
      {error ? <div className="error">{error}</div> : hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

export function Input({
  value,
  onChange,
  placeholder,
  type = 'text',
  disabled,
  autoFocus,
  id,
  maxLength,
  onKeyDown,
}: {
  value: string | number;
  onChange?: (v: string) => void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  id?: string;
  maxLength?: number;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <input
      id={id}
      className="input"
      value={value ?? ''}
      type={type}
      disabled={disabled}
      autoFocus={autoFocus}
      maxLength={maxLength}
      placeholder={placeholder}
      onKeyDown={onKeyDown}
      onChange={(e) => onChange?.(e.target.value)}
    />
  );
}

export function TextArea({
  value,
  onChange,
  rows = 3,
  placeholder,
  id,
  disabled,
}: {
  value: string;
  onChange?: (v: string) => void;
  rows?: number;
  placeholder?: string;
  id?: string;
  disabled?: boolean;
}) {
  return (
    <textarea
      id={id}
      className="input"
      rows={rows}
      value={value ?? ''}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange?.(e.target.value)}
    />
  );
}

export function Select<T extends string | number>({
  value,
  onChange,
  options,
  placeholder,
  id,
  disabled,
}: {
  value: T | '' | null;
  onChange: (v: string) => void;
  options: { value: T; label: string; disabled?: boolean }[];
  placeholder?: string;
  id?: string;
  disabled?: boolean;
}) {
  return (
    <select
      id={id}
      className="input"
      value={value === null || value === undefined ? '' : String(value)}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button className={`switch ${checked ? 'on' : ''}`} role="switch" aria-checked={checked} onClick={() => onChange(!checked)}>
      <span className="knob" />
      <span>{label}</span>
    </button>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          className={value === o.value ? 'on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Badge({ tone = 'plain', children }: { tone?: 'plain' | 'green' | 'amber' | 'red' | 'blue' | 'teal'; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function Banner({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'danger' | 'success'; children: ReactNode }) {
  return (
    <div className={`banner ${tone}`}>
      <Icon name={tone === 'danger' || tone === 'warn' ? 'alert' : 'shield'} size={16} />
      <div>{children}</div>
    </div>
  );
}

export function Stat({
  label,
  value,
  foot,
  icon,
  tone,
}: {
  label: string;
  value: ReactNode;
  foot?: ReactNode;
  icon: IconName;
  tone?: 'accent' | 'danger' | 'warn' | 'good';
}) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        <span className="stat-icon">
          <Icon name={icon} size={15} />
        </span>
      </div>
      <div className="stat-value num">{value}</div>
      {foot ? <div className="stat-foot">{foot}</div> : null}
    </div>
  );
}

export function Empty({ icon = 'file', title, message, action }: { icon?: IconName; title: string; message?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={icon} size={22} />
      </div>
      <div className="empty-title">{title}</div>
      {message ? <div className="empty-msg">{message}</div> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} />;
}

export interface Column<T> {
  key: string;
  label: string;
  align?: 'left' | 'right' | 'center';
  width?: number | string;
  render?: (row: T, index: number) => ReactNode;
}

export function Table<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  empty,
  loading,
  compact,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey?: (row: T, i: number) => string | number;
  onRowClick?: (row: T) => void;
  empty?: ReactNode;
  loading?: boolean;
  compact?: boolean;
}) {
  if (loading) {
    return (
      <div className="table-loading">
        <Spinner size={20} />
      </div>
    );
  }
  if (!rows.length) return <>{empty ?? <Empty title="কোনো তথ্য নেই" />}</>;
  return (
    <div className={`table-wrap ${compact ? 'compact' : ''}`}>
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.align ?? 'left'} style={{ width: c.width }}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={rowKey ? rowKey(row, i) : i} className={onRowClick ? 'clickable' : ''} onClick={onRowClick ? () => onRowClick(row) : undefined}>
              {columns.map((c) => (
                <td key={c.key} className={c.align ?? 'left'}>
                  {c.render ? c.render(row, i) : String((row as Record<string, unknown>)[c.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Modal({
  title,
  sub,
  children,
  footer,
  onClose,
  size = 'md',
}: {
  title: ReactNode;
  sub?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    // Move focus into the dialog so a keyboard user is not left behind it.
    dialogRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={`modal ${size}`}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : 'ডায়ালগ'}
        tabIndex={-1}
        ref={dialogRef}
      >
        <div className="modal-head">
          <div>
            <h3>{title}</h3>
            {sub ? <div className="sub">{sub}</div> : null}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="বন্ধ">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Steps({
  steps,
  active,
  maxReached,
  onSelect,
}: {
  steps: { id: number; label: string }[];
  active: number;
  maxReached: number;
  onSelect: (id: number) => void;
}) {
  return (
    <ol className="steps">
      {steps.map((s) => {
        const done = s.id < active;
        const locked = s.id > maxReached;
        function select() {
          if (!locked) onSelect(s.id);
        }
        return (
          <li key={s.id} className={`${s.id === active ? 'active' : ''} ${done ? 'done' : ''} ${locked ? 'locked' : ''}`}>
            <button onClick={select} disabled={locked} aria-current={s.id === active ? 'step' : undefined}>
              <span className="step-no">{done ? <Icon name="check" size={12} /> : s.id}</span>
              <span className="step-label">{s.label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function KeyValue({ items }: { items: { label: string; value: ReactNode; mono?: boolean }[] }) {
  return (
    <dl className="kv">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd className={item.mono ? 'mono' : ''}>{item.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
