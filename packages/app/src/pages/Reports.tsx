import { useEffect, useMemo, useState } from 'react';
import { call } from '../api.js';
import { useShopRefresh } from '../lib/use-shop-refresh.js';
import { CHART_COLORS, LineChart } from '../charts.js';
import { money, qty, dateShort, today, monthStart, addDays } from '../format.js';
import { Icon } from '../icons.js';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Loading,
  PageHead,
  Select,
  Spinner,
  TextInput,
  useUI,
} from '../ui.js';
import type { ReportColumn, ReportFilter, ReportResult } from '../types.js';

interface ReportMeta {
  id: string;
  title: string;
  description: string;
  group: 'sales' | 'profit' | 'purchase' | 'expense' | 'party' | 'stock' | 'cash' | 'return' | 'accounting' | 'crm' | 'ops';
  needsRange: boolean;
}

const GROUPS: { id: string; label: string; icon: string }[] = [
  { id: 'all', label: 'সব রিপোর্ট', icon: 'report' },
  { id: 'sales', label: 'বিক্রয়', icon: 'cart' },
  { id: 'profit', label: 'প্রফিট', icon: 'chart' },
  { id: 'purchase', label: 'পারচেজ', icon: 'purchase' },
  { id: 'expense', label: 'এক্সপেন্স', icon: 'expense' },
  { id: 'party', label: 'কাস্টমার ও সাপ্লায়ার', icon: 'users' },
  { id: 'stock', label: 'স্টক', icon: 'stock' },
  { id: 'cash', label: 'ক্যাশ ও পেমেন্ট', icon: 'cash' },
  { id: 'return', label: 'রিটার্ন', icon: 'return' },
  { id: 'accounting', label: 'হিসাব (লেজার)', icon: 'shield' },
  { id: 'crm', label: 'CRM ও লয়্যালটি', icon: 'users' },
  { id: 'ops', label: 'স্টক অপারেশন', icon: 'box' },
];

const PRESETS = [
  { id: 'today', label: 'আজ' },
  { id: 'week', label: '৭ দিন' },
  { id: 'month', label: 'এই মাস' },
  { id: 'prev_month', label: 'গত মাস' },
  { id: 'year', label: 'এই বছর' },
  { id: 'custom', label: 'কাস্টম' },
];

export function ReportsPage({ can }: { can: (perm?: string) => boolean }) {
  const ui = useUI();
  const [catalog, setCatalog] = useState<ReportMeta[]>([]);
  const [group, setGroup] = useState('all');
  const [active, setActive] = useState<string>('sales_daily');
  const [preset, setPreset] = useState('month');
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [search, setSearch] = useState('');
  const [result, setResult] = useState<ReportResult | null>(null);
  const [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const [categories, setCategories] = useState<any[]>([]);
  const [categoryId, setCategoryId] = useState<number | ''>('');
  const [customers, setCustomers] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [customerId, setCustomerId] = useState<number | ''>('');
  const [supplierId, setSupplierId] = useState<number | ''>('');

  useEffect(() => {
    (async () => {
      try {
        const [cat, cats, cust, sup] = await Promise.all([
          call<ReportMeta[]>('reports.catalog'),
          call<any[]>('settings.categories'),
          call<{ rows: any[] }>('customers.list', { pageSize: 200 }),
          call<{ rows: any[] }>('suppliers.list', { pageSize: 200 }),
        ]);
        setCatalog(cat);
        setCategories(cats);
        setCustomers(cust.rows);
        setSuppliers(sup.rows);
      } catch (err) {
        ui.error('রিপোর্ট তালিকা লোড ব্যর্থ', (err as Error).message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const meta = catalog.find((c) => c.id === active);

  const filter: ReportFilter = useMemo(
    () => ({
      from: meta?.needsRange ? from : undefined,
      to: meta?.needsRange ? to : undefined,
      category_id: categoryId || null,
      customer_id: customerId || null,
      supplier_id: supplierId || null,
      search: search.trim() || undefined,
    }),
    [meta?.needsRange, from, to, categoryId, customerId, supplierId, search],
  );

  // A new sale/payment/stock change makes the open report stale; re-run it.
  useShopRefresh('reports', () => void run());

  const run = async () => {
    if (!active) return;
    setRunning(true);
    try {
      const res = await call<ReportResult>('reports.run', active, filter);
      setResult(res);
    } catch (err) {
      ui.error('রিপোর্ট চালানো যায়নি', (err as Error).message);
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, filter]);

  const applyPreset = (id: string) => {
    setPreset(id);
    const now = today();
    if (id === 'today') {
      setFrom(now);
      setTo(now);
    } else if (id === 'week') {
      setFrom(addDays(now, -6));
      setTo(now);
    } else if (id === 'month') {
      setFrom(monthStart());
      setTo(now);
    } else if (id === 'prev_month') {
      const d = new Date(`${monthStart()}T00:00:00`);
      d.setMonth(d.getMonth() - 1);
      const first = d.toISOString().slice(0, 10);
      const last = new Date(new Date(`${monthStart()}T00:00:00`).getTime() - 86400000).toISOString().slice(0, 10);
      setFrom(first);
      setTo(last);
    } else if (id === 'year') {
      setFrom(`${now.slice(0, 4)}-01-01`);
      setTo(now);
    }
  };

  const doExport = async (kind: 'Csv' | 'Xlsx' | 'Pdf') => {
    setExporting(kind);
    try {
      const path = await call<string | null>(`reports.export${kind}` as any, active, filter);
      if (path) ui.success('ফাইল সংরক্ষিত হয়েছে', path);
    } catch (err) {
      ui.error('এক্সপোর্ট ব্যর্থ', (err as Error).message);
    } finally {
      setExporting(null);
    }
  };

  const visible = catalog.filter((c) => (group === 'all' || c.group === group) && (!search || c.title.includes(search)));

  const chartLabels = useMemo(() => result?.chart?.map((p) => p.iso) ?? [], [result]);
  const chartSeries = useMemo(
    () =>
      result?.chart && result.chart.length
        ? [
            { key: 'sales', label: 'বিক্রয়', color: CHART_COLORS[0]!, values: result.chart.map((p) => p.sales_paisa) },
            { key: 'profit', label: 'প্রফিট', color: CHART_COLORS[1]!, values: result.chart.map((p) => p.profit_paisa) },
            { key: 'purchase', label: 'পারচেজ', color: CHART_COLORS[2]!, values: result.chart.map((p) => p.purchase_paisa) },
          ]
        : [],
    [result],
  );

  const columns: Column<Record<string, any>>[] = (result?.columns ?? []).map((c: ReportColumn) => ({
    key: c.key,
    label: c.label,
    align: c.align ?? 'left',
    render: (row) => {
      const value = row[c.key];
      if (value === null || value === undefined || value === '') return '—';
      if (c.format === 'money') return <span className="num">{money(Number(value))}</span>;
      if (c.format === 'qty') return <span className="num">{qty(Number(value))}</span>;
      if (c.format === 'date') return <span className="small">{dateShort(String(value))}</span>;
      if (c.format === 'int') return <span className="num">{Number(value).toLocaleString('bn-BD')}</span>;
      if (c.format === 'percent') return <span className="num">{(Number(value) / 100).toFixed(2)}%</span>;
      return <span>{String(value)}</span>;
    },
  }));

  return (
    <>
      <PageHead
        title="রিপোর্ট ও অ্যানালিটিক্স"
        sub={`${catalog.length} টি রিপোর্ট — সব সরাসরি ডাটাবেজ থেকে, CSV/Excel/PDF এক্সপোর্ট সহ`}
        actions={
          <>
            <Button icon="download" loading={exporting === 'Csv'} onClick={() => void doExport('Csv')}>
              CSV
            </Button>
            <Button icon="download" loading={exporting === 'Xlsx'} onClick={() => void doExport('Xlsx')}>
              Excel
            </Button>
            <Button variant="primary" icon="print" loading={exporting === 'Pdf'} onClick={() => void doExport('Pdf')}>
              PDF
            </Button>
          </>
        }
      />

      <div className="grid-2-even" style={{ alignItems: 'start' }}>
        <Card>
          <div className="card-head">
            <div>
              <h3>রিপোর্ট নির্বাচন</h3>
              <div className="sub">{visible.length} টি রিপোর্ট</div>
            </div>
          </div>
          <div className="card-body tight">
            <div className="chip-row" style={{ marginBottom: 8 }}>
              {GROUPS.map((g) => (
                <button key={g.id} className={`chip ${group === g.id ? 'active' : ''}`} onClick={() => setGroup(g.id)}>
                  {g.label}
                </button>
              ))}
            </div>
            <div className="global-search" style={{ maxWidth: 'none', marginBottom: 8 }}>
              <span className="search-icon">
                <Icon name="search" size={16} />
              </span>
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="রিপোর্ট খুঁজুন" />
            </div>
            <div className="report-list">
              {visible.map((r) => (
                <button
                  key={r.id}
                  className={`report-item ${active === r.id ? 'active' : ''}`}
                  onClick={() => setActive(r.id)}
                >
                  <div>
                    <div className="bold small">{r.title}</div>
                    <div className="tiny muted">{r.description}</div>
                  </div>
                  {active === r.id ? <Icon name="check" size={15} /> : null}
                </button>
              ))}
            </div>
          </div>
        </Card>

        <div className="col">
          <Card>
            <div className="card-head">
              <div>
                <h3>{meta?.title ?? 'রিপোর্ট'}</h3>
                <div className="sub">{meta?.description}</div>
              </div>
              <Button icon="refresh" loading={running} onClick={() => void run()}>
                রিফ্রেশ
              </Button>
            </div>
            <div className="card-body">
              {meta?.needsRange !== false ? (
                <>
                  <div className="chip-row" style={{ marginBottom: 8 }}>
                    {PRESETS.map((p) => (
                      <button key={p.id} className={`chip ${preset === p.id ? 'active' : ''}`} onClick={() => applyPreset(p.id)}>
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <Field label="শুরু">
                      <TextInput
                        value={from}
                        onChange={(v) => {
                          setFrom(v);
                          setPreset('custom');
                        }}
                        type="date"
                      />
                    </Field>
                    <Field label="শেষ">
                      <TextInput
                        value={to}
                        onChange={(v) => {
                          setTo(v);
                          setPreset('custom');
                        }}
                        type="date"
                      />
                    </Field>
                    {meta?.id?.includes('categor') ? (
                      <Field label="ক্যাটাগরি">
                        <Select
                          value={categoryId}
                          onChange={(v) => setCategoryId(v ? Number(v) : '')}
                          options={categories.map((c) => ({ value: c.id, label: c.name }))}
                          placeholder="সব"
                        />
                      </Field>
                    ) : null}
                    {meta?.id === 'customer_sales' || meta?.id === 'customer_due' ? (
                      <Field label="কাস্টমার">
                        <Select
                          value={customerId}
                          onChange={(v) => setCustomerId(v ? Number(v) : '')}
                          options={customers.map((c) => ({ value: c.id, label: c.name }))}
                          placeholder="সব"
                        />
                      </Field>
                    ) : null}
                    {meta?.id === 'supplier_purchase' || meta?.id === 'supplier_payable' ? (
                      <Field label="সাপ্লায়ার">
                        <Select
                          value={supplierId}
                          onChange={(v) => setSupplierId(v ? Number(v) : '')}
                          options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
                          placeholder="সব"
                        />
                      </Field>
                    ) : null}
                  </div>
                </>
              ) : (
                <Badge tone="plain">এই রিপোর্টে তারিখের সীমা প্রয়োজন নেই</Badge>
              )}
            </div>
          </Card>

          <Card>
            <div className="card-head">
              <div>
                <h3>{result?.title ?? 'ফলাফল'}</h3>
                <div className="sub">{result?.subtitle}</div>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <Badge tone="teal">{result?.rows.length ?? 0} সারি</Badge>
              </div>
            </div>
            <div className="card-body">
              {running ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: 30 }}>
                  <Spinner size={22} />
                </div>
              ) : chartLabels.length > 1 ? (
                <div style={{ marginBottom: 12 }}>
                  <LineChart labels={chartLabels} series={chartSeries} height={180} />
                </div>
              ) : null}
              {!running && result ? (
                <DataTable
                  rows={result.rows}
                  maxHeight={430}
                  columns={columns}
                  rowKey={(row: any, i) => String(row.id ?? i)}
                  footer={
                    result.totals && Object.keys(result.totals).length ? (
                      <tr>
                        {result.columns.map((c, i) => {
                          const value = result.totals[c.key];
                          if (i === 0 && value === undefined) return <td key={c.key}>সর্বমোট</td>;
                          if (value === undefined) return <td key={c.key} />;
                          return (
                            <td key={c.key} className={`num ${c.align === 'right' ? 'right' : ''}`}>
                              {c.format === 'money' ? money(Number(value)) : c.format === 'qty' ? qty(Number(value)) : String(value)}
                            </td>
                          );
                        })}
                      </tr>
                    ) : undefined
                  }
                  empty={<EmptyState icon="report" title="এই সময়ে কোনো তথ্য নেই" message="তারিখের সীমা বদলে দেখুন।" />}
                />
              ) : !running ? (
                <EmptyState icon="report" title="রিপোর্ট চালান" message="উপরের ফিল্টার ঠিক করে “রিফ্রেশ” চাপুন।" />
              ) : null}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

type Column<T> = {
  key: string;
  label: string;
  align?: 'left' | 'right' | 'center';
  render?: (row: T, index: number) => React.ReactNode;
};

export { Loading };
