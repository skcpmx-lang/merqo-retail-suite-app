import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon, type IconName } from './icons.js';
import { money } from './format.js';

/* ------------------------------------------------------------------ */
/* Focus management (v1.1.5)                                           */
/* ------------------------------------------------------------------ */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * True when an element is rendered and announced. Computed style, not `offsetParent`: the dialog
 * must behave the same in the browser and under the DOM test environment, and `offsetParent` is
 * always null where there is no layout engine.
 */
function isFocusVisible(el: HTMLElement): boolean {
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && !el.hasAttribute('disabled');
}

/** Elements inside `root` that can take focus, in DOM order. */
export function focusableIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isFocusVisible);
}

/**
 * Keeps Tab inside a dialog (v1.1.5, A-16).
 *
 * A POS is driven from the keyboard, and a modal that lets Tab escape into the page behind it
 * silently moves the cashier's next keystroke into a form they cannot see. Returns a cleanup that
 * puts focus back where it was, so the screen continues from where it left off.
 */
export function useFocusTrap(ref: React.RefObject<HTMLElement | null>, active = true): void {
  useEffect(() => {
    if (!active) return undefined;
    const previous = document.activeElement as HTMLElement | null;
    const root = ref.current;
    // Focus the first *field* when there is one — opening a dialog onto its own close button makes
    // the cashier press Tab before they can type — otherwise the first control.
    const firstField = root?.querySelector<HTMLElement>('input, select, textarea');
    const target = firstField ?? focusableIn(root)[0];
    if (target && !root?.contains(document.activeElement)) target.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = focusableIn(ref.current);
      if (!items.length) return;
      const firstItem = items[0]!;
      const lastItem = items[items.length - 1]!;
      const current = document.activeElement as HTMLElement | null;
      if (event.shiftKey && (current === firstItem || !ref.current?.contains(current))) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && current === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [ref, active]);
}

/* ------------------------------------------------------------------ */
/* Toasts + confirm                                                    */
/* ------------------------------------------------------------------ */

type ToastKind = 'success' | 'error' | 'warn' | 'info';
interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
}

interface ConfirmOptions {
  title: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  requireReason?: boolean;
  reasonLabel?: string;
}

interface UIContextValue {
  toast: (kind: ToastKind, title: string, message?: string) => void;
  success: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
  confirm: (options: ConfirmOptions) => Promise<{ ok: boolean; reason?: string }>;
}

const UIContext = createContext<UIContextValue | null>(null);

export function useUI(): UIContextValue {
  const ctx = useContext(UIContext);
  if (!ctx) throw new Error('UIProvider missing');
  return ctx;
}

export function UIProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [confirmState, setConfirmState] = useState<
    (ConfirmOptions & { resolve: (v: { ok: boolean; reason?: string }) => void }) | null
  >(null);
  const [reason, setReason] = useState('');
  const counter = useRef(1);

  const toast = useCallback((kind: ToastKind, title: string, message?: string) => {
    const id = counter.current++;
    setToasts((prev) => [...prev, { id, kind, title, message }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, kind === 'error' ? 8000 : 4200);
  }, []);

  const value = useMemo<UIContextValue>(
    () => ({
      toast,
      success: (t, m) => toast('success', t, m),
      error: (t, m) => toast('error', t, m),
      confirm: (options) =>
        new Promise((resolve) => {
          setReason('');
          setConfirmState({ ...options, resolve });
        }),
    }),
    [toast],
  );

  const close = (ok: boolean) => {
    if (!confirmState) return;
    confirmState.resolve({ ok, reason: ok ? reason : undefined });
    setConfirmState(null);
  };

  return (
    <UIContext.Provider value={value}>
      {children}
      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <Icon
              name={t.kind === 'success' ? 'check' : t.kind === 'error' ? 'warning' : 'info'}
              size={17}
              style={{ color: t.kind === 'error' ? 'var(--danger-500)' : t.kind === 'success' ? 'var(--success-500)' : 'var(--brand-500)', marginTop: 1 }}
            />
            <div style={{ minWidth: 0 }}>
              <div className="t-title">{t.title}</div>
              {t.message ? <div className="t-msg">{t.message}</div> : null}
            </div>
          </div>
        ))}
      </div>
      {confirmState ? (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && close(false)}>
          <div className="modal sm">
            <div className="modal-head">
              <h2>{confirmState.title}</h2>
              <button className="icon-btn" onClick={() => close(false)} aria-label="বন্ধ">
                <Icon name="close" size={17} />
              </button>
            </div>
            <div className="modal-body">
              <p style={{ margin: 0, whiteSpace: 'pre-line' }}>{confirmState.message}</p>
              {confirmState.detail ? (
                <p className="small muted" style={{ marginTop: 8, whiteSpace: 'pre-line' }}>
                  {confirmState.detail}
                </p>
              ) : null}
              {confirmState.requireReason ? (
                <div className="field" style={{ marginTop: 12 }}>
                  <label>{confirmState.reasonLabel ?? 'কারণ লিখুন'}</label>
                  <input
                    className="input"
                    autoFocus
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="কারণ লিখুন..."
                  />
                </div>
              ) : null}
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => close(false)}>
                {confirmState.cancelLabel ?? 'বাতিল'}
              </button>
              <button
                className={`btn ${confirmState.danger ? 'danger' : 'primary'}`}
                disabled={confirmState.requireReason && reason.trim().length < 2}
                onClick={() => close(true)}
              >
                {confirmState.confirmLabel ?? 'নিশ্চিত করুন'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </UIContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/* Buttons / layout                                                    */
/* ------------------------------------------------------------------ */

export function Button({
  children,
  onClick,
  variant = 'default',
  size,
  icon,
  loading,
  disabled,
  type = 'button',
  block,
  title,
  style,
}: {
  children?: ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  variant?: 'default' | 'primary' | 'ghost' | 'danger' | 'warn' | 'accent';
  size?: 'sm' | 'lg';
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit';
  block?: boolean;
  title?: string;
  style?: React.CSSProperties;
}) {
  const cls = ['btn', variant !== 'default' ? variant : '', size ?? '', block ? 'block' : '', loading ? 'loading' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <button className={cls} onClick={onClick} disabled={disabled || loading} type={type} title={title} style={style}>
      {icon && !loading ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      {children}
    </button>
  );
}

export function IconButton({
  icon,
  onClick,
  title,
  size = 16,
  danger,
}: {
  icon: IconName;
  onClick?: (e: React.MouseEvent) => void;
  title?: string;
  size?: number;
  danger?: boolean;
}) {
  return (
    <button
      className="icon-btn"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={danger ? { color: 'var(--danger-500)' } : undefined}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}

export function Card({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div className={`card ${className ?? ''}`} style={style}>
      {children}
    </div>
  );
}

export function CardHead({
  title,
  sub,
  actions,
}: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
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

export function PageHead({
  title,
  sub,
  actions,
}: {
  title: string;
  sub?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub ? <p>{sub}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}

export function StatCard({
  label,
  value,
  foot,
  icon,
  tone,
  delay = 0,
}: {
  label: string;
  value: ReactNode;
  foot?: ReactNode;
  icon: IconName;
  tone?: 'accent' | 'info' | 'danger' | 'warn';
  delay?: number;
}) {
  return (
    <div className={`stat ${tone ?? ''}`} style={{ animationDelay: `${delay}ms` }}>
      <div className="stat-icon">
        <Icon name={icon} size={17} />
      </div>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {foot ? <div className="stat-foot">{foot}</div> : null}
    </div>
  );
}

export function EmptyState({
  icon = 'box',
  title,
  message,
  action,
}: {
  icon?: IconName;
  title: string;
  message?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="icon">
        <Icon name={icon} size={24} />
      </div>
      <h4>{title}</h4>
      {message ? <p>{message}</p> : null}
      {action}
    </div>
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="spin" aria-label="লোড হচ্ছে">
      <circle cx="12" cy="12" r="9" fill="none" stroke="var(--line)" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="var(--brand-500)" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Loading({ label = 'লোড হচ্ছে…' }: { label?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 40, color: 'var(--muted)' }}>
      <Spinner /> {label}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Form controls                                                       */
/* ------------------------------------------------------------------ */

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
      {React.isValidElement(children)
        ? React.cloneElement(children as React.ReactElement<any>, { id, 'aria-invalid': Boolean(error) })
        : children}
      {error ? <div className="error">{error}</div> : hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  disabled,
  autoFocus,
  onKeyDown,
  className,
  inputRef,
  maxLength,
  id,
}: {
  value: string | number;
  onChange?: (v: string) => void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  className?: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  maxLength?: number;
  id?: string;
}) {
  return (
    <input
      id={id}
      ref={inputRef}
      className={`input ${className ?? ''}`}
      value={value ?? ''}
      type={type}
      disabled={disabled}
      autoFocus={autoFocus}
      onKeyDown={onKeyDown}
      maxLength={maxLength}
      placeholder={placeholder}
      onChange={(e) => onChange?.(e.target.value)}
    />
  );
}

/** Taka input: shows major units, stores/exposes poisa. */
export function MoneyInput({
  value,
  onChange,
  placeholder,
  disabled,
  id,
  autoFocus,
}: {
  value: number;
  onChange: (paisa: number) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState(() => (value ? (value / 100).toFixed(2) : ''));
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      setText(value ? (value / 100).toFixed(2) : '');
    }
  }, [value]);
  return (
    <input
      id={id}
      className="input num"
      inputMode="decimal"
      value={text}
      disabled={disabled}
      autoFocus={autoFocus}
      placeholder={placeholder ?? '0.00'}
      onChange={(e) => {
        const raw = e.target.value.replace(/[^0-9.০-৯]/g, '');
        const normalized = raw.replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d)));
        setText(raw);
        const num = Number(normalized);
        const paisa = Number.isFinite(num) ? Math.round(num * 100) : 0;
        last.current = paisa;
        onChange(paisa);
      }}
    />
  );
}

export function QtyInput({
  value,
  onChange,
  disabled,
  unit,
  autoFocus,
  id,
  onEnter,
}: {
  value: number;
  onChange: (milli: number) => void;
  disabled?: boolean;
  unit?: string;
  autoFocus?: boolean;
  id?: string;
  onEnter?: () => void;
}) {
  const [text, setText] = useState(() => (value ? String(value / 1000) : ''));
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      setText(value ? String(value / 1000) : '');
    }
  }, [value]);
  return (
    <div className="row" style={{ gap: 6 }}>
      <input
        id={id}
        className="input num"
        inputMode="decimal"
        value={text}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder="0"
        style={{ textAlign: 'right' }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onEnter) onEnter();
        }}
        onChange={(e) => {
          const raw = e.target.value.replace(/[^0-9.০-৯]/g, '');
          const normalized = raw.replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d)));
          setText(raw);
          const num = Number(normalized);
          const milli = Number.isFinite(num) ? Math.round(num * 1000) : 0;
          last.current = milli;
          onChange(milli);
        }}
      />
      {unit ? <span className="badge plain">{unit}</span> : null}
    </div>
  );
}

export function Select<T extends string | number>({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  id,
  className,
}: {
  value: T | '' | null;
  onChange: (v: string) => void;
  options: { value: T; label: string; disabled?: boolean }[];
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  return (
    <select
      id={id}
      className={`select ${className ?? ''}`}
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

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className="switch" style={disabled ? { opacity: 0.6 } : undefined}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
      <span>{label}</span>
    </label>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string; badge?: number }[];
  active: T;
  onChange: (id: T) => void;
}) {
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const index = tabs.findIndex((t) => t.id === active);
    const next = tabs[(index + step + tabs.length) % tabs.length];
    if (next) onChange(next.id);
  };
  return (
    <div className="tabs" role="tablist" onKeyDown={onKeyDown}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          id={`tab-${t.id}`}
          aria-selected={active === t.id}
          // Roving tabindex: one stop for the whole tab strip, arrows move between tabs.
          tabIndex={active === t.id ? 0 : -1}
          className={`tab ${active === t.id ? 'active' : ''}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.badge !== undefined && t.badge > 0 ? <span className="badge amber" style={{ marginLeft: 6 }}>{t.badge}</span> : null}
        </button>
      ))}
    </div>
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
    <div className="seg" role="group">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={value === o.value ? 'active' : ''}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */

export function Modal({
  title,
  sub,
  children,
  footer,
  onClose,
  size = 'md',
  hideClose,
}: {
  title: ReactNode;
  sub?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  hideClose?: boolean;
}) {
  const titleId = useId();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(bodyRef);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !hideClose) {
        // Escape must not also close a dialog stacked *under* this one.
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, hideClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !hideClose && onClose()}>
      <div
        className={`modal ${size === 'md' ? '' : size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={bodyRef}
      >
        <div className="modal-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {sub ? <div className="sub">{sub}</div> : null}
          </div>
          {!hideClose ? (
            <button className="icon-btn" onClick={onClose} aria-label="বন্ধ করুন">
              <Icon name="close" size={17} />
            </button>
          ) : null}
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Data table                                                          */
/* ------------------------------------------------------------------ */

export interface Column<T> {
  key: string;
  label: string;
  align?: 'left' | 'right' | 'center';
  width?: number | string;
  render?: (row: T, index: number) => ReactNode;
  sortable?: boolean;
  money?: boolean;
}

export function DataTable<T>({
  columns,
  rows,
  loading,
  empty,
  onRowClick,
  footer,
  rowKey,
  compact,
  maxHeight,
  sort,
}: {
  columns: Column<T>[];
  rows: T[];
  loading?: boolean;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  footer?: ReactNode;
  rowKey?: (row: T, i: number) => string | number;
  compact?: boolean;
  maxHeight?: number | string;
  /** Current sort, announced on the header so a screen reader knows the order (v1.1.5). */
  sort?: { key: string; dir: 'asc' | 'desc' };
}) {
  if (loading) return <Loading />;
  if (!rows.length) return <>{empty ?? <EmptyState title="কোনো তথ্য পাওয়া যায়নি" message="ফিল্টার বদলে আবার চেষ্টা করুন।" />}</>;
  return (
    <div className={`table-wrap ${compact ? 'table-compact' : ''}`} style={{ maxHeight }}>
      <table className="data">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={c.align === 'right' ? 'right' : c.align === 'center' ? 'center' : ''}
                style={{ width: c.width }}
                scope="col"
                aria-sort={sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={rowKey ? rowKey(row, i) : i}
              className={onRowClick ? 'clickable' : ''}
              // A clickable row must be reachable and operable from the keyboard: a cashier
              // driving the till without a mouse could not open a sale or a product before.
              tabIndex={onRowClick ? 0 : undefined}
              role={onRowClick ? 'button' : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={
                onRowClick
                  ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onRowClick(row);
                      }
                    }
                  : undefined
              }
            >
              {columns.map((c) => {
                const raw = (row as any)[c.key];
                const content = c.render ? c.render(row, i) : c.money ? money(raw) : raw ?? '—';
                return (
                  <td
                    key={c.key}
                    className={`${c.align === 'right' ? 'right' : c.align === 'center' ? 'center' : ''} ${c.money ? 'num' : ''}`}
                  >
                    {content}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        {footer ? <tfoot>{footer}</tfoot> : null}
      </table>
    </div>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="pagination">
      <span>
        {from}–{to} / {total}
      </span>
      <button className="btn sm icon" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        <Icon name="chevronLeft" size={15} />
      </button>
      <span className="num">
        {page} / {pages}
      </span>
      <button className="btn sm icon" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        <Icon name="chevronRight" size={15} />
      </button>
    </div>
  );
}

/**
 * A key cap, for the shortcut hints the till relies on (v1.1.5). Screen readers get the label;
 * sighted users get the cap. Kept as a `<kbd>` so it is semantic, not decorative text.
 */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/** A key cap plus what it does, e.g. ⌨ F2 — খুঁজুন. */
export function KeyHint({ keys, children }: { keys: string; children?: ReactNode }) {
  return (
    <span className="kbd-hint">
      <Kbd>{keys}</Kbd>
      {children ? <span>{children}</span> : null}
    </span>
  );
}

export function Badge({ tone, children }: { tone?: 'green' | 'red' | 'amber' | 'blue' | 'teal' | 'plain'; children: ReactNode }) {
  return <span className={`badge ${tone ?? ''}`}>{children}</span>;
}

export function KV({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="kv">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

export function Banner({
  tone = 'info',
  icon = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'danger' | 'success';
  icon?: IconName;
  children: ReactNode;
}) {
  return (
    <div className={`banner ${tone}`}>
      <Icon name={icon} size={16} style={{ marginTop: 2, flex: 'none' }} />
      <div>{children}</div>
    </div>
  );
}

export function useDebounced<T>(value: T, delay = 280): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(t);
  }, [value, delay]);
  return debounced;
}
