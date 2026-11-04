import { useEffect, useMemo, useState } from 'react';
import { call } from '../api.js';
import { useShopRefresh } from '../lib/use-shop-refresh.js';
import { BarList, CHART_COLORS, LineChart } from '../charts.js';
import { dateTime, greeting, money, qty, relative, today } from '../format.js';
import { Icon } from '../icons.js';
import {
  Button,
  Card,
  CardHead,
  DataTable,
  EmptyState,
  Segmented,
  Spinner,
  StatCard,
  useUI,
} from '../ui.js';
import type { DashboardStats, SeriesPoint, User } from '../types.js';
import type { PageId } from '../App.js';

type Range = 'today' | 'week' | 'month' | 'year';

const QUICK: { id: PageId; label: string; icon: string; perm?: string }[] = [
  { id: 'pos', label: 'নতুন বিক্রয়', icon: 'pos', perm: 'pos.sell' },
  { id: 'products', label: 'প্রোডাক্ট যোগ', icon: 'plus', perm: 'product.manage' },
  { id: 'customers', label: 'কাস্টমার যোগ', icon: 'user', perm: 'customer.manage' },
  { id: 'suppliers', label: 'সাপ্লায়ার যোগ', icon: 'supplier', perm: 'supplier.manage' },
  { id: 'purchases', label: 'নতুন পারচেজ', icon: 'purchase', perm: 'purchase.manage' },
  { id: 'expenses', label: 'এক্সপেন্স', icon: 'expense', perm: 'expense.manage' },
  { id: 'customers', label: 'বাকি আদায়', icon: 'wallet', perm: 'customer.manage' },
  { id: 'reports', label: 'রিপোর্ট দেখুন', icon: 'report', perm: 'report.view' },
];

export function DashboardPage({
  user,
  navigate,
  can,
}: {
  user: User;
  navigate: (p: PageId) => void;
  can: (perm?: string) => boolean;
}) {
  const ui = useUI();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [series, setSeries] = useState<SeriesPoint[]>([]);
  const [range, setRange] = useState<Range>('week');
  const [recent, setRecent] = useState<any | null>(null);
  const [low, setLow] = useState<any[]>([]);
  const [out, setOut] = useState<any[]>([]);
  const [trends, setTrends] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [brand, setBrand] = useState<{ name: string; type: string; address: string; phone: string; website: string; logo: string | null }>({
    name: '',
    type: '',
    address: '',
    phone: '',
    website: '',
    logo: null,
  });

  useEffect(() => {
    void (async () => {
      try {
        const settings = await call<any>('settings.get');
        const logo = await call<string | null>('settings.logoDataUrl').catch(() => null);
        setBrand({
          name: settings.business_name ?? '',
          type: settings.business_type ?? '',
          address: settings.business_address ?? '',
          phone: settings.business_phone ?? '',
          website: settings.business_website ?? '',
          logo,
        });
      } catch {
        /* the dashboard works without branding */
      }
    })();
  }, []);

  const load = async () => {
    try {
      const [s, r, l, o, t] = await Promise.all([
        call<DashboardStats>('dashboard.stats'),
        call<any>('dashboard.recent'),
        call<any[]>('inventory.low', 6),
        call<any[]>('inventory.out', 6),
        call<any>('dashboard.trends'),
      ]);
      setStats(s);
      setRecent(r);
      setLow(l);
      setOut(o);
      setTrends(t);
    } catch (err) {
      ui.error('ড্যাশবোর্ড লোড ব্যর্থ', (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // Shop events from the Main PC invalidate this screen (client mode).
  useShopRefresh('dashboard', () => void load());

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let alive = true;
    call<SeriesPoint[]>('dashboard.series', range)
      .then((data) => alive && setSeries(data))
      .catch(() => alive && setSeries([]));
    return () => {
      alive = false;
    };
  }, [range]);

  const labels = useMemo(() => series.map((p) => p.iso), [series]);
  const chartSeries = useMemo(
    () => [
      { key: 'sales', label: 'বিক্রয়', color: CHART_COLORS[0]!, values: series.map((p) => p.sales_paisa) },
      { key: 'profit', label: 'প্রফিট', color: CHART_COLORS[1]!, values: series.map((p) => p.profit_paisa) },
      { key: 'purchase', label: 'পারচেজ', color: CHART_COLORS[2]!, values: series.map((p) => p.purchase_paisa) },
    ],
    [series],
  );

  const weekGrowth = useMemo(() => {
    if (!trends) return null;
    const prev = trends.prev_week_sales || 0;
    if (!prev) return null;
    const delta = ((trends.week_sales - prev) / prev) * 100;
    return delta;
  }, [trends]);

  if (loading || !stats) {
    return (
      <div className="stat-grid">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="skeleton" style={{ height: 96 }} />
        ))}
      </div>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            {greeting()}, {user.full_name.split(' ')[0] || user.username}
          </h1>
          <p>আজকের ব্যবসার সারসংক্ষেপ — সব সংখ্যা সরাসরি ডাটাবেজ থেকে আসছে।</p>
        </div>
        <div className="page-actions">
          <Button icon="refresh" onClick={() => void load()}>
            রিফ্রেশ
          </Button>
          {can('pos.sell') ? (
            <Button variant="primary" icon="pos" onClick={() => navigate('pos')}>
              নতুন বিক্রয় (F2)
            </Button>
          ) : null}
        </div>
      </div>

      <div className="brand-hero">
        <div className="brand-hero-logo">
          {brand.logo ? <img src={brand.logo} alt="" /> : <Icon name="dashboard" size={26} />}
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="brand-hero-name">{brand.name || 'আপনার প্রতিষ্ঠানের নাম'}</div>
          <div className="brand-hero-meta">
            {[brand.type, brand.address, brand.phone, brand.website].filter(Boolean).join(' • ') || 'সেটিংস → ব্যবসা ও রিসিট থেকে তথ্য দিন'}
          </div>
        </div>
        <div className="grow" />
        <div className="brand-hero-date">{today()}</div>
      </div>

      <div className="stat-grid">
        <StatCard label="আজকের বিক্রয়" value={money(stats.today_sales_paisa)} icon="pos" foot={`${stats.today_sales_count} টি ইনভয়েস`} delay={0} />
        <StatCard label="আজকের প্রফিট" value={money(stats.today_profit_paisa)} icon="chart" tone="accent" foot="ওয়েটেড অ্যাভারেজ কস্ট অনুযায়ী" delay={40} />
        <StatCard label="মোট বিক্রয়" value={money(stats.total_sales_paisa)} icon="wallet" foot={`মোট প্রফিট ${money(stats.total_profit_paisa)}`} delay={80} />
        <StatCard
          label="কাস্টমার বাকি"
          value={money(stats.total_due_paisa)}
          icon="users"
          tone={stats.total_due_paisa > 0 ? 'warn' : undefined}
          foot={`${stats.total_customers} জন কাস্টমার`}
          delay={120}
        />
        <StatCard label="সাপ্লায়ার পাওনা" value={money(stats.total_payable_paisa)} icon="supplier" tone="info" foot={`${stats.total_suppliers} জন সাপ্লায়ার`} delay={160} />
        <StatCard label="স্টক মূল্য" value={money(stats.stock_value_paisa)} icon="stock" foot={`${stats.total_products} টি প্রোডাক্ট`} delay={200} />
        <StatCard label="নগদ ক্যাশ" value={money(stats.cash_in_hand_paisa)} icon="cash" foot="ক্যাশ রেজিস্টার অনুযায়ী" delay={240} />
        <StatCard
          label="স্টক অ্যালার্ট"
          value={`${stats.low_stock_count + stats.out_of_stock_count}`}
          icon="warning"
          tone={stats.low_stock_count + stats.out_of_stock_count > 0 ? 'danger' : undefined}
          foot={`${stats.low_stock_count} কম • ${stats.out_of_stock_count} শেষ`}
          delay={280}
        />
      </div>

      <div className="grid-2" style={{ marginBottom: 14 }}>
        <Card>
          <CardHead
            title="বিক্রয় ও প্রফিট পর্যালোচনা"
            sub="প্রতিদিনের প্রকৃত লেনদেন"
            actions={
              <Segmented
                value={range}
                onChange={setRange}
                options={[
                  { value: 'today', label: 'আজ' },
                  { value: 'week', label: '৭ দিন' },
                  { value: 'month', label: '৩০ দিন' },
                  { value: 'year', label: 'বছর' },
                ]}
              />
            }
          />
          <div className="card-body">
            <LineChart labels={labels} series={chartSeries} height={236} />
          </div>
        </Card>

        <Card>
          <CardHead title="দ্রুত কাজ" sub="এক ক্লিকে শুরু করুন" />
          <div className="card-body">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 9 }}>
              {QUICK.filter((q) => can(q.perm)).map((q) => (
                <button
                  key={`${q.id}-${q.label}`}
                  className="product-tile"
                  style={{ minHeight: 66, justifyContent: 'center', gap: 5 }}
                  onClick={() => navigate(q.id)}
                >
                  <Icon name={q.icon as any} size={18} style={{ color: 'var(--brand-600)' }} />
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{q.label}</span>
                </button>
              ))}
            </div>
          </div>
        </Card>
      </div>

      <div className="grid-3" style={{ marginBottom: 14 }}>
        <Card>
          <CardHead title="সপ্তাহের পারফরম্যান্স" sub="গত ৭ দিন বনাম তার আগের ৭ দিন" />
          <div className="card-body">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <div className="tiny muted">এই সপ্তাহের বিক্রয়</div>
                <div className="num bold" style={{ fontSize: 20 }}>{money(trends?.week_sales ?? 0)}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="tiny muted">আগের সপ্তাহ</div>
                <div className="num" style={{ fontSize: 15 }}>{money(trends?.prev_week_sales ?? 0)}</div>
              </div>
            </div>
            {weekGrowth !== null ? (
              <div className="row small" style={{ marginTop: 8, gap: 6 }}>
                <span className={`badge ${weekGrowth >= 0 ? 'green' : 'red'}`}>
                  {weekGrowth >= 0 ? '▲' : '▼'} {Math.abs(weekGrowth).toFixed(1)}%
                </span>
                <span className="muted">পরিবর্তন</span>
              </div>
            ) : (
              <div className="tiny muted" style={{ marginTop: 8 }}>তুলনার জন্য আগের সপ্তাহের তথ্য নেই।</div>
            )}
            <div className="divider" />
            <BarList
              items={(trends?.top_products ?? []).map((p: any) => ({
                label: p.name,
                value: p.revenue,
                sub: `বিক্রি: ${qty(p.qty_base)} (বেস ইউনিট)`,
              }))}
            />
          </div>
        </Card>

        <Card>
          <CardHead
            title="স্টক সতর্কতা"
            sub={`${low.length + out.length} টি প্রোডাক্টে নজর দিন`}
            actions={
              can('report.view') ? (
                <Button size="sm" variant="ghost" onClick={() => navigate('inventory')}>
                  সব দেখুন
                </Button>
              ) : undefined
            }
          />
          <div className="card-body tight">
            {out.length === 0 && low.length === 0 ? (
              <EmptyState icon="check" title="সব স্টক ঠিক আছে" message="কোনো প্রোডাক্টের স্টক কম নেই।" />
            ) : (
              <div className="col" style={{ gap: 6 }}>
                {out.map((p) => (
                  <div key={`out-${p.id}`} className="row" style={{ justifyContent: 'space-between', padding: '5px 2px' }}>
                    <span className="small" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.name}
                    </span>
                    <span className="badge red">স্টক শেষ</span>
                  </div>
                ))}
                {low.map((p) => (
                  <div key={`low-${p.id}`} className="row" style={{ justifyContent: 'space-between', padding: '5px 2px' }}>
                    <span className="small" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.name}
                    </span>
                    <span className="badge amber num">{qty(p.stock_base_milli)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>

        <Card>
          <CardHead title="সাম্প্রতিক লেনদেন" sub="সর্বশেষ ৮টি কার্যক্রম" />
          <div className="card-body tight">
            <DataTable
              compact
              columns={[
                {
                  key: 'label',
                  label: 'কার্যক্রম',
                  render: (row: any) => (
                    <div>
                      <div className="small bold">{row.label}</div>
                      <div className="tiny muted">{row.sub}</div>
                    </div>
                  ),
                },
                {
                  key: 'amount',
                  label: 'টাকা',
                  align: 'right',
                  render: (row: any) => <span className="num small bold">{money(row.amount)}</span>,
                },
              ]}
              rows={[
                ...(recent?.sales ?? []).map((s: any) => ({
                  label: `বিক্রয় ${s.invoice_no}`,
                  sub: `${s.customer_name} • ${relative(s.sale_date)}`,
                  amount: s.total_paisa,
                  at: s.sale_date,
                })),
                ...(recent?.purchases ?? []).map((p: any) => ({
                  label: `পারচেজ ${p.purchase_no}`,
                  sub: `${p.supplier_name} • ${relative(p.purchase_date)}`,
                  amount: -p.total_paisa,
                  at: p.purchase_date,
                })),
                ...(recent?.expenses ?? []).map((e: any) => ({
                  label: 'এক্সপেন্স',
                  sub: `${e.description} • ${relative(e.expense_date)}`,
                  amount: -e.amount_paisa,
                  at: e.expense_date,
                })),
              ]
                .sort((a, b) => (a.at < b.at ? 1 : -1))
                .slice(0, 8)}
              rowKey={(row: any, i) => `${row.label}-${i}`}
              empty={<EmptyState icon="cart" title="এখনো কোনো লেনদেন নেই" message="প্রথম বিক্রয় শুরু করুন।" />}
            />
          </div>
        </Card>
      </div>

      <Card>
        <CardHead
          title="আজকের সারসংক্ষেপ"
          sub="মোট পরিসংখ্যান"
          actions={<span className="badge plain">{dateTime(new Date().toISOString())}</span>}
        />
        <div className="card-body">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 12 }}>
            <SummaryKV label="আজকের এক্সপেন্স" value={money(stats.today_expense_paisa)} />
            <SummaryKV label="আজকের বাকি আদায়" value={money(stats.today_collection_paisa)} />
            <SummaryKV label="মোট পারচেজ" value={money(stats.total_purchases_paisa)} />
            <SummaryKV label="মোট এক্সপেন্স" value={money(stats.total_expenses_paisa)} />
          </div>
        </div>
      </Card>
    </>
  );
}

function SummaryKV({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px' }}>
      <div className="tiny muted">{label}</div>
      <div className="num bold" style={{ fontSize: 17 }}>{value}</div>
    </div>
  );
}

export { Spinner };
