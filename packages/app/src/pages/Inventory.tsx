import { useEffect, useState } from 'react';
import { call } from '../api.js';
import { money, qty, dateTime, today, addDays } from '../format.js';
import { Icon } from '../icons.js';
import {
  Badge,
  Banner,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Loading,
  Modal,
  MoneyInput,
  PageHead,
  Pagination,
  QtyInput,
  Select,
  Tabs,
  TextInput,
  useDebounced,
  useUI,
} from '../ui.js';
import type { ProductWithMeta, StockMovement } from '../types.js';

type Tab = 'stock' | 'movements' | 'alerts';

const PAGE_SIZE = 25;

export function InventoryPage({ can }: { can: (perm?: string) => boolean }) {
  const ui = useUI();
  const [tab, setTab] = useState<Tab>('stock');
  const [stockValue, setStockValue] = useState(0);

  // stock tab
  const [rows, setRows] = useState<ProductWithMeta[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);
  const [stockState, setStockState] = useState<'all' | 'low' | 'out' | 'in'>('all');
  const [loading, setLoading] = useState(true);

  // movements tab
  const [moves, setMoves] = useState<StockMovement[]>([]);
  const [moveTotal, setMoveTotal] = useState(0);
  const [movePage, setMovePage] = useState(1);
  const [moveType, setMoveType] = useState('');
  const [moveFrom, setMoveFrom] = useState(addDays(today(), -30));
  const [moveTo, setMoveTo] = useState(today());
  const [moveSearch, setMoveSearch] = useState('');
  const debouncedMove = useDebounced(moveSearch);
  const [moveLoading, setMoveLoading] = useState(false);

  // alerts tab
  const [lowRows, setLowRows] = useState<any[]>([]);
  const [outRows, setOutRows] = useState<any[]>([]);
  const [expiring, setExpiring] = useState<any[]>([]);

  // adjustment modal
  const [adjusting, setAdjusting] = useState<ProductWithMeta | null>(null);
  const [counted, setCounted] = useState(0);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [adjustType, setAdjustType] = useState<'count' | 'damage' | 'expiry'>('count');
  const [costPerUnit, setCostPerUnit] = useState(0);
  const [busy, setBusy] = useState(false);

  const canAdjust = can('stock.adjust');

  const loadStock = async () => {
    setLoading(true);
    try {
      const [res, value] = await Promise.all([
        call<{ rows: ProductWithMeta[]; total: number }>('products.list', {
          search: debounced.trim() || undefined,
          stockState,
          page,
          pageSize: PAGE_SIZE,
          sort: 'name',
        }),
        call<number>('inventory.stockValue'),
      ]);
      setRows(res.rows);
      setTotal(res.total);
      setStockValue(value);
    } catch (err) {
      ui.error('স্টক লোড ব্যর্থ', (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (tab === 'stock') void loadStock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, debounced, stockState, page]);

  useEffect(() => {
    if (tab !== 'movements') return;
    let alive = true;
    setMoveLoading(true);
    const t = window.setTimeout(async () => {
      try {
        const res = await call<{ rows: StockMovement[]; total: number }>('inventory.movements', {
          type: moveType || null,
          from: moveFrom,
          to: moveTo,
          search: debouncedMove.trim() || undefined,
          page: movePage,
          pageSize: 30,
        });
        if (alive) {
          setMoves(res.rows);
          setMoveTotal(res.total);
        }
      } catch (err) {
        if (alive) ui.error('মুভমেন্ট লোড ব্যর্থ', (err as Error).message);
      } finally {
        if (alive) setMoveLoading(false);
      }
    }, 200);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, moveType, moveFrom, moveTo, debouncedMove, movePage]);

  useEffect(() => {
    if (tab !== 'alerts') return;
    (async () => {
      try {
        const [low, out, exp] = await Promise.all([
          call<any[]>('inventory.low', 200),
          call<any[]>('inventory.out', 200),
          call<any[]>('inventory.expiring', 90).catch(() => []),
        ]);
        setLowRows(low);
        setOutRows(out);
        setExpiring(exp);
      } catch (err) {
        ui.error('অ্যালার্ট লোড ব্যর্থ', (err as Error).message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const openAdjust = (product: ProductWithMeta, type: 'count' | 'damage' | 'expiry') => {
    setAdjusting(product);
    setAdjustType(type);
    setCounted(type === 'count' ? product.stock_base_milli : 0);
    setReason('');
    setNote('');
    setCostPerUnit(product.avg_cost_micro > 0 ? product.avg_cost_micro : product.purchase_price * 1000);
  };

  const submitAdjust = async () => {
    if (!adjusting) return;
    if (!reason.trim()) {
      ui.error('কারণ দিতে হবে', 'প্রতিটি স্টক সমন্বয়ের কারণ লেখা বাধ্যতামূলক।');
      return;
    }
    setBusy(true);
    try {
      if (adjustType === 'count') {
        await call('inventory.adjust', {
          productId: adjusting.id,
          newQtyBaseMilli: counted,
          reason,
          note: note || null,
          type: 'adjustment',
          costMicro: costPerUnit || null,
        });
      } else {
        await call('inventory.writeOff', {
          productId: adjusting.id,
          qtyBaseMilli: counted,
          type: adjustType,
          reason,
          note: note || null,
        });
      }
      ui.success('স্টক আপডেট হয়েছে', adjusting.name);
      setAdjusting(null);
      await loadStock();
    } catch (err) {
      ui.error('সমন্বয় ব্যর্থ', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const delta = adjusting ? counted - adjusting.stock_base_milli : 0;

  return (
    <>
      <PageHead
        title="স্টক ও ইনভেন্টরি"
        sub="প্রতিটি স্টক পরিবর্তন অডিটসহ সংরক্ষিত হয়"
        actions={
          <div className="row" style={{ gap: 8 }}>
            <Badge tone="teal">মোট স্টক মূল্য {money(stockValue)}</Badge>
            <Button icon="refresh" onClick={() => void loadStock()}>
              রিফ্রেশ
            </Button>
          </div>
        }
      />

      <Card>
        <div className="toolbar">
          <Tabs
            active={tab}
            onChange={setTab}
            tabs={[
              { id: 'stock', label: 'স্টক তালিকা' },
              { id: 'movements', label: 'স্টক মুভমেন্ট' },
              { id: 'alerts', label: 'অ্যালার্ট', badge: lowRows.length + outRows.length },
            ]}
          />
          <span className="grow" />
          {tab === 'stock' ? (
            <>
              <div className="global-search" style={{ maxWidth: 260 }}>
                <span className="search-icon">
                  <Icon name="search" size={16} />
                </span>
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="প্রোডাক্ট খুঁজুন" />
              </div>
              <Select
                value={stockState}
                onChange={(v) => {
                  setStockState(v as any);
                  setPage(1);
                }}
                options={[
                  { value: 'all', label: 'সব' },
                  { value: 'in', label: 'স্টক আছে' },
                  { value: 'low', label: 'কম স্টক' },
                  { value: 'out', label: 'স্টক শেষ' },
                ]}
              />
            </>
          ) : null}
        </div>

        {tab === 'stock' ? (
          loading ? (
            <Loading />
          ) : (
            <>
              <DataTable
                rows={rows}
                rowKey={(r) => r.id}
                empty={<EmptyState icon="stock" title="স্টক তালিকা খালি" message="প্রথমে প্রোডাক্ট যোগ করুন।" />}
                columns={[
                  {
                    key: 'name',
                    label: 'প্রোডাক্ট',
                    render: (r) => (
                      <div>
                        <div className="bold">{r.name}</div>
                        <div className="tiny muted">
                          {r.sku ?? '—'} {r.category_name ? `• ${r.category_name}` : ''}
                        </div>
                      </div>
                    ),
                  },
                  {
                    key: 'stock_base_milli',
                    label: 'বর্তমান স্টক',
                    align: 'right',
                    render: (r) => {
                      const out = r.stock_base_milli <= 0;
                      const low = !out && r.stock_base_milli <= r.min_stock_base_milli;
                      return (
                        <span className={`num bold ${out ? 'danger-text' : low ? 'warn-text' : ''}`}>
                          {qty(r.stock_base_milli)} {r.primary_unit_short_name ?? ''}
                        </span>
                      );
                    },
                  },
                  {
                    key: 'min_stock_base_milli',
                    label: 'সর্বনিম্ন',
                    align: 'right',
                    render: (r) => <span className="num muted">{qty(r.min_stock_base_milli)}</span>,
                  },
                  {
                    key: 'avg_cost_micro',
                    label: 'গড় ক্রয়/ইউনিট',
                    align: 'right',
                    render: (r) => (
                      <span className="num">{r.avg_cost_micro ? money(Math.round(r.avg_cost_micro / 1000)) : '—'}</span>
                    ),
                  },
                  {
                    key: 'value',
                    label: 'স্টক মূল্য',
                    align: 'right',
                    render: (r) => (
                      <span className="num bold">{money(Math.round((r.stock_base_milli * r.avg_cost_micro) / 1e9))}</span>
                    ),
                  },
                  {
                    key: 'actions',
                    label: '',
                    align: 'right',
                    width: 120,
                    render: (r) =>
                      canAdjust ? (
                        <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                          <Button size="sm" onClick={() => openAdjust(r, 'count')}>
                            সমন্বয়
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => openAdjust(r, 'damage')}>
                            নষ্ট
                          </Button>
                        </div>
                      ) : null,
                  },
                ]}
              />
              <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPage={setPage} />
            </>
          )
        ) : null}

        {tab === 'movements' ? (
          <>
            <div className="toolbar" style={{ borderTop: '1px solid var(--line)' }}>
              <div className="global-search" style={{ maxWidth: 240 }}>
                <span className="search-icon">
                  <Icon name="search" size={16} />
                </span>
                <input value={moveSearch} onChange={(e) => setMoveSearch(e.target.value)} placeholder="প্রোডাক্ট বা কারণ" />
              </div>
              <Select
                value={moveType}
                onChange={(v) => {
                  setMoveType(v);
                  setMovePage(1);
                }}
                options={[
                  { value: '', label: 'সব ধরন' },
                  { value: 'opening', label: 'ওপেনিং' },
                  { value: 'purchase', label: 'পারচেজ' },
                  { value: 'sale', label: 'বিক্রয়' },
                  { value: 'sale_return', label: 'সেলস রিটার্ন' },
                  { value: 'purchase_return', label: 'পারচেজ রিটার্ন' },
                  { value: 'adjustment', label: 'সমন্বয়' },
                  { value: 'damage', label: 'নষ্ট' },
                  { value: 'expiry', label: 'মেয়াদোত্তীর্ণ' },
                ]}
              />
              <TextInput value={moveFrom} onChange={setMoveFrom} type="date" />
              <TextInput value={moveTo} onChange={setMoveTo} type="date" />
            </div>
            {moveLoading ? (
              <Loading />
            ) : (
              <>
                <DataTable
                  rows={moves}
                  rowKey={(r) => r.id}
                  empty={<EmptyState icon="list" title="কোনো মুভমেন্ট নেই" message="নির্বাচিত সময়ে কোনো স্টক পরিবর্তন হয়নি।" />}
                  columns={[
                    { key: 'created_at', label: 'সময়', render: (r) => <span className="small">{dateTime(r.created_at)}</span> },
                    { key: 'product_name', label: 'প্রোডাক্ট' },
                    {
                      key: 'type',
                      label: 'ধরন',
                      render: (r) => <Badge tone={r.qty_base_milli >= 0 ? 'green' : 'amber'}>{MOVE_LABEL[r.type] ?? r.type}</Badge>,
                    },
                    {
                      key: 'qty_base_milli',
                      label: 'পরিবর্তন',
                      align: 'right',
                      render: (r) => (
                        <span className={`num bold ${r.qty_base_milli >= 0 ? 'success-text' : 'danger-text'}`}>
                          {r.qty_base_milli >= 0 ? '+' : ''}
                          {qty(r.qty_base_milli)}
                        </span>
                      ),
                    },
                    { key: 'balance_after_milli', label: 'ব্যালেন্স', align: 'right', render: (r) => <span className="num">{qty(r.balance_after_milli)}</span> },
                    { key: 'reason', label: 'কারণ/নোট', render: (r) => <span className="small muted">{r.reason || r.note || '—'}</span> },
                    { key: 'username', label: 'ইউজার', render: (r) => <span className="small">{r.username ?? '—'}</span> },
                  ]}
                />
                <Pagination page={movePage} pageSize={30} total={moveTotal} onPage={setMovePage} />
              </>
            )}
          </>
        ) : null}

        {tab === 'alerts' ? (
          <div className="card-body">
            <div className="grid-2">
              <div>
                <div className="section-title">স্টক শেষ ({outRows.length})</div>
                <DataTable
                  compact
                  rows={outRows}
                  rowKey={(r: any) => `o${r.id}`}
                  empty={<EmptyState icon="check" title="সব প্রোডাক্ট স্টকে আছে" />}
                  columns={[
                    { key: 'name', label: 'প্রোডাক্ট' },
                    { key: 'unit_short_name', label: 'ইউনিট', align: 'right' },
                    {
                      key: 'act',
                      label: '',
                      align: 'right',
                      render: (r: any) =>
                        canAdjust ? (
                          <Button size="sm" onClick={() => openAdjust(r, 'count')}>
                            স্টক যোগ
                          </Button>
                        ) : null,
                    },
                  ]}
                />
              </div>
              <div>
                <div className="section-title">কম স্টক ({lowRows.length})</div>
                <DataTable
                  compact
                  rows={lowRows}
                  rowKey={(r: any) => `l${r.id}`}
                  empty={<EmptyState icon="check" title="কোনো কম স্টক নেই" />}
                  columns={[
                    { key: 'name', label: 'প্রোডাক্ট' },
                    {
                      key: 'stock_base_milli',
                      label: 'স্টক',
                      align: 'right',
                      render: (r: any) => <span className="num warn-text">{qty(r.stock_base_milli)}</span>,
                    },
                    {
                      key: 'min_stock_base_milli',
                      label: 'সর্বনিম্ন',
                      align: 'right',
                      render: (r: any) => <span className="num muted">{qty(r.min_stock_base_milli)}</span>,
                    },
                  ]}
                />
              </div>
            </div>
            <div className="divider" />
            <div className="section-title">মেয়াদ শেষের পথে (৯০ দিনে) — {expiring.length}</div>
            <DataTable
              compact
              rows={expiring}
              rowKey={(r: any, i) => `e${i}`}
              empty={<EmptyState icon="check" title="মেয়াদোত্তীর্ণ ব্যাচ নেই" message="ব্যাচ ও মেয়াদ ট্র্যাকিং চালু থাকলে এখানে দেখা যাবে।" />}
              columns={[
                { key: 'product_name', label: 'প্রোডাক্ট', render: (r: any) => r.product_name ?? r.name ?? '—' },
                { key: 'batch_no', label: 'ব্যাচ', render: (r: any) => r.batch_no ?? '—' },
                { key: 'expiry_date', label: 'মেয়াদ', render: (r: any) => r.expiry_date ?? '—' },
                { key: 'qty_base_milli', label: 'পরিমাণ', align: 'right', render: (r: any) => <span className="num">{qty(r.qty_base_milli ?? 0)}</span> },
              ]}
            />
          </div>
        ) : null}
      </Card>

      {adjusting ? (
        <Modal
          title={adjustType === 'count' ? 'স্টক সমন্বয়' : adjustType === 'damage' ? 'নষ্ট স্টক লিখন' : 'মেয়াদোত্তীর্ণ লিখন'}
          sub={`${adjusting.name} • বর্তমান স্টক ${qty(adjusting.stock_base_milli)} ${adjusting.primary_unit_short_name ?? ''}`}
          onClose={() => setAdjusting(null)}
          footer={
            <>
              <Button onClick={() => setAdjusting(null)}>বাতিল</Button>
              <Button variant="primary" loading={busy} onClick={submitAdjust} icon="check">
                সংরক্ষণ করুন
              </Button>
            </>
          }
        >
          <div className="form-grid">
            <Field label={adjustType === 'count' ? 'নিরীক্ষণের পর প্রকৃত স্টক' : 'কত স্টক বাদ যাবে'} span={2}>
              <QtyInput value={counted} onChange={setCounted} unit={adjusting.primary_unit_short_name ?? undefined} autoFocus />
            </Field>
            {adjustType === 'count' ? (
              <div className="span-2">
                <Banner tone={delta === 0 ? 'info' : delta > 0 ? 'success' : 'warn'} icon="stock">
                  {delta === 0
                    ? 'স্টকে কোনো পরিবর্তন হবে না।'
                    : delta > 0
                      ? `${qty(delta)} ${adjusting.primary_unit_short_name ?? ''} স্টক বাড়বে (ওজন/yr মূল্য যোগ হবে)।`
                      : `${qty(Math.abs(delta))} ${adjusting.primary_unit_short_name ?? ''} স্টক কমবে।`}
                </Banner>
              </div>
            ) : null}
            <Field label="কারণ *" span={2}>
              <TextInput value={reason} onChange={setReason} placeholder="যেমন: মাসিক স্টক গণনা, ভাঙা প্যাকেট" />
            </Field>
            <Field label="নোট (ঐচ্ছিক)" span={2}>
              <TextInput value={note} onChange={setNote} />
            </Field>
            {adjustType === 'count' && delta > 0 ? (
              <Field label="নতুন স্টকের ক্রয়মূল্য / ইউনিট" span={2} hint="খালি রাখলে আগের গড় ক্রয়মূল্য ব্যবহার হবে">
                <MoneyInput value={costPerUnit} onChange={setCostPerUnit} />
              </Field>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </>
  );
}

const MOVE_LABEL: Record<string, string> = {
  opening: 'ওপেনিং',
  purchase: 'পারচেজ',
  sale: 'বিক্রয়',
  sale_return: 'সেলস রিটার্ন',
  purchase_return: 'পারচেজ রিটার্ন',
  adjustment: 'সমন্বয়',
  damage: 'নষ্ট',
  expiry: 'মেয়াদোত্তীর্ণ',
  transfer: 'স্থানান্তর',
};
