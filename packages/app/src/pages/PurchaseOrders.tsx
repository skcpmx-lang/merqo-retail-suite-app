import { useCallback, useEffect, useMemo, useState } from 'react';
import { call } from '../api.js';
import { useT } from '../i18n.js';
import { money, qty, dateShort } from '../format.js';
import {
  Banner,
  Button,
  Card,
  CardHead,
  DataTable,
  EmptyState,
  Field,
  Loading,
  Modal,
  MoneyInput,
  PageHead,
  QtyInput,
  Select,
  Spinner,
  TextInput,
  Tabs,
  useUI,
  useDebounced,
} from '../ui.js';

type Status = 'all' | 'open' | 'partial' | 'received' | 'cancelled';

interface PoItem {
  id: number;
  product_id: number;
  product_name: string;
  sku?: string | null;
  unit_label: string | null;
  factor_milli: number;
  qty_milli: number;
  received_base_milli: number;
  remaining_base_milli: number;
  unit_cost_paisa: number;
  line_total_paisa: number;
}

interface PurchaseOrder {
  id: number;
  po_no: string;
  supplier_id: number | null;
  supplier_name: string | null;
  order_date: string;
  expected_date: string | null;
  status: Exclude<Status, 'all'>;
  total_paisa: number;
  note: string | null;
  received_percent: number;
  items?: PoItem[];
  receipts?: any[];
}

interface DraftLine {
  productId: number;
  name: string;
  unitId: number;
  unitLabel: string;
  qtyMilli: number;
  unitCostPaisa: number;
}

export function PurchaseOrdersPage({ can }: { can: (p?: string) => boolean }) {
  const t = useT();
  const ui = useUI();
  const [status, setStatus] = useState<Status>('open');
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);
  const [rows, setRows] = useState<PurchaseOrder[]>([]);
  const [summary, setSummary] = useState<{ open: number; partial: number; open_value_paisa: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<PurchaseOrder | null>(null);
  const [composer, setComposer] = useState(false);
  const [receive, setReceive] = useState<PurchaseOrder | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, stats] = await Promise.all([
        call<{ rows: PurchaseOrder[]; total: number }>('purchases.poList', { status, q: debounced, limit: 200 }),
        call<typeof summary>('purchases.poSummary'),
      ]);
      setRows(list.rows ?? []);
      setSummary(stats);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [status, debounced]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = async (row: PurchaseOrder) => {
    try {
      const full = await call<PurchaseOrder>('purchases.poGet', row.id);
      setDetail(full);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const printPo = async (id: number) => {
    try {
      const html = await call<string>('print.document', 'po', { poId: id });
      await call('print.render', html, {});
      ui.success(t('common.print'));
    } catch (err) {
      ui.error((err as Error).message);
    }
  };

  const cancel = async (row: PurchaseOrder) => {
    const res = await ui.confirm({
      title: t('po.cancelConfirm'),
      message: 'বাতিলের কারণ লিখুন — এটি অডিট লগে সংরক্ষিত হবে।',
      requireReason: true,
      reasonLabel: 'কারণ',
      danger: true,
    });
    if (!res.ok || !res.reason) return;
    try {
      await call('purchases.poCancel', row.id, res.reason);
      ui.success(t('common.saved'));
      setDetail(null);
      await load();
    } catch (err) {
      ui.error((err as Error).message);
    }
  };

  const statusPill = (value: PurchaseOrder['status']) => {
    const tone = value === 'received' ? 'green' : value === 'partial' ? 'amber' : value === 'cancelled' ? 'red' : 'blue';
    return <span className={`pill ${tone}`}>{t(`po.status.${value}`)}</span>;
  };

  return (
    <>
      <PageHead
        title={t('po.title')}
        sub={summary ? `${summary.open} ${t('po.status.open')} • ${summary.partial} ${t('po.status.partial')}` : undefined}
        actions={
          <>
            <Button icon="refresh" variant="ghost" onClick={() => void load()}>
              {t('common.refresh')}
            </Button>
            {can('purchase.manage') ? (
              <Button variant="primary" icon="plus" onClick={() => setComposer(true)}>
                {t('po.new')}
              </Button>
            ) : null}
          </>
        }
      />

      {error ? <Banner tone="danger">{error}</Banner> : null}

      <div className="stat-grid" style={{ marginBottom: 16 }}>
        <div className="kpi">
          <div className="kpi-label">{t('po.status.open')}</div>
          <div className="kpi-value num">{summary?.open ?? 0}</div>
          <div className="kpi-foot">{t('nav.purchaseorders')}</div>
        </div>
        <div className="kpi warn">
          <div className="kpi-label">{t('po.status.partial')}</div>
          <div className="kpi-value num">{summary?.partial ?? 0}</div>
          <div className="kpi-foot">{t('po.remaining')}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">{t('common.total')}</div>
          <div className="kpi-value num">{money(summary?.open_value_paisa ?? 0)}</div>
          <div className="kpi-foot">{t('po.status.open')} + {t('po.status.partial')}</div>
        </div>
      </div>

      <Card>
        <div className="toolbar">
          <Tabs
            active={status}
            onChange={(v) => setStatus(v)}
            tabs={[
              { id: 'open', label: t('po.status.open') },
              { id: 'partial', label: t('po.status.partial') },
              { id: 'received', label: t('po.status.received') },
              { id: 'cancelled', label: t('po.status.cancelled') },
              { id: 'all', label: t('common.all') },
            ]}
          />
          <div className="grow" />
          <div style={{ width: 240 }}>
            <TextInput value={search} onChange={setSearch} placeholder={t('common.search')} />
          </div>
        </div>
        {loading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState icon="file" title={t('po.empty')} message={t('po.new')} action={<Button icon="plus" onClick={() => setComposer(true)}>{t('po.new')}</Button>} />
        ) : (
          <DataTable
            rows={rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => void openDetail(r)}
            columns={[
              { key: 'po_no', label: 'অর্ডার', render: (r) => <span className="bold num">{r.po_no}</span> },
              { key: 'supplier_name', label: t('nav.suppliers'), render: (r) => r.supplier_name ?? '—' },
              { key: 'order_date', label: t('common.date'), render: (r) => dateShort(r.order_date) },
              { key: 'expected_date', label: t('po.expected'), render: (r) => (r.expected_date ? dateShort(r.expected_date) : '—') },
              { key: 'status', label: t('common.status'), render: (r) => statusPill(r.status) },
              {
                key: 'received_percent',
                label: t('po.received'),
                align: 'right',
                render: (r) => (
                  <div style={{ minWidth: 90 }}>
                    <div className="tiny muted">{r.received_percent ?? 0}%</div>
                    <div className="progress" style={{ height: 5 }}>
                      <div className="track" style={{ width: `${Math.min(100, r.received_percent ?? 0)}%` }} />
                    </div>
                  </div>
                ),
              },
              { key: 'total_paisa', label: t('common.total'), money: true, align: 'right' },
              {
                key: 'actions',
                label: t('common.actions'),
                align: 'right',
                render: (r) => (
                  <div className="row" onClick={(e) => e.stopPropagation()}>
                    {r.status !== 'received' && r.status !== 'cancelled' ? (
                      <Button size="sm" variant="primary" icon="check" onClick={() => setReceive(r)}>
                        {t('po.receive')}
                      </Button>
                    ) : null}
                    <Button size="sm" variant="ghost" icon="print" onClick={() => void printPo(r.id)} />
                  </div>
                ),
              },
            ]}
          />
        )}
      </Card>

      {composer ? (
        <OrderComposer
          onClose={() => setComposer(false)}
          onSaved={async () => {
            setComposer(false);
            await load();
          }}
        />
      ) : null}

      {detail ? (
        <Modal
          title={detail.po_no}
          sub={`${detail.supplier_name ?? '—'} • ${dateShort(detail.order_date)}`}
          onClose={() => setDetail(null)}
          size="lg"
          footer={
            <>
              <Button variant="ghost" onClick={() => setDetail(null)}>
                {t('common.close')}
              </Button>
              {detail.status !== 'received' && detail.status !== 'cancelled' ? (
                <Button variant="danger" icon="close" onClick={() => void cancel(detail)}>
                  {t('po.status.cancelled')}
                </Button>
              ) : null}
              <Button variant="primary" icon="print" onClick={() => void printPo(detail.id)}>
                {t('common.print')}
              </Button>
            </>
          }
        >
          <div className="row" style={{ marginBottom: 12 }}>
            {statusPill(detail.status)}
            <span className="small muted">
              {t('po.received')}: {detail.received_percent ?? 0}% • {t('common.total')}: {money(detail.total_paisa)}
            </span>
          </div>
          <DataTable
            rows={detail.items ?? []}
            rowKey={(r) => r.id}
            compact
            columns={[
              { key: 'product_name', label: 'প্রোডাক্ট', render: (r) => (<><div className="bold small">{r.product_name}</div><div className="tiny muted">{r.sku}</div></>) },
              { key: 'qty_milli', label: t('common.qty'), align: 'right', render: (r) => `${qty(r.qty_milli, r.unit_label)}` },
              { key: 'received_base_milli', label: t('po.received'), align: 'right', render: (r) => qty(r.received_base_milli) },
              { key: 'remaining_base_milli', label: t('po.remaining'), align: 'right', render: (r) => qty(r.remaining_base_milli) },
              { key: 'unit_cost_paisa', label: t('common.price'), money: true, align: 'right' },
              { key: 'line_total_paisa', label: t('common.total'), money: true, align: 'right' },
            ]}
          />
          {detail.receipts && detail.receipts.length > 0 ? (
            <div style={{ marginTop: 14 }}>
              <div className="section-title">{t('po.receive')}</div>
              <table className="data" style={{ marginTop: 6 }}>
                <tbody>
                  {detail.receipts.map((r: any) => (
                    <tr key={r.id}>
                      <td className="num">{r.receipt_no}</td>
                      <td className="muted small">{dateShort(r.received_at)}</td>
                      <td className="num right">{money(r.total_paisa)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {detail.note ? <div className="small muted" style={{ marginTop: 12 }}>{detail.note}</div> : null}
        </Modal>
      ) : null}

      {receive ? (
        <ReceiveDialog
          order={receive}
          onClose={() => setReceive(null)}
          onSaved={async (poId) => {
            setReceive(null);
            await load();
            const fresh = await call<PurchaseOrder>('purchases.poGet', poId).catch(() => null);
            if (fresh) setDetail(fresh);
          }}
        />
      ) : null}
    </>
  );
}

function OrderComposer({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }) {
  const t = useT();
  const ui = useUI();
  const [supplierId, setSupplierId] = useState<number | ''>('');
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [expectedDate, setExpectedDate] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query);
  const [hits, setHits] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void call<{ rows: any[] }>('suppliers.list', { pageSize: 500 })
      .then((r) => setSuppliers(r.rows ?? []))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (debounced.trim().length < 1) {
      setHits([]);
      return;
    }
    let alive = true;
    void call<{ rows: any[] }>('products.list', { search: debounced, pageSize: 8 })
      .then((r) => {
        if (alive) setHits(r.rows ?? []);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [debounced]);

  const total = lines.reduce((s, l) => s + Math.round((l.qtyMilli * l.unitCostPaisa) / 1000), 0);

  const addProduct = (p: any) => {
    setLines((prev) => {
      if (prev.some((l) => l.productId === p.id)) return prev;
      return [
        ...prev,
        {
          productId: p.id,
          name: p.name,
          unitId: p.primary_unit_id ?? p.unit_id,
          unitLabel: p.unit_short_name ?? p.unit_name ?? '',
          qtyMilli: 1000,
          unitCostPaisa: p.purchase_price_paisa ?? p.purchase_price ?? 0,
        },
      ];
    });
    setQuery('');
    setHits([]);
  };

  const save = async () => {
    if (!lines.length) {
      ui.error('অন্তত একটি প্রোডাক্ট যোগ করুন।');
      return;
    }
    setSaving(true);
    try {
      await call('purchases.poCreate', {
        supplierId: supplierId === '' ? null : Number(supplierId),
        expectedDate: expectedDate || null,
        note: note || null,
        lines: lines.map((l) => ({
          productId: l.productId,
          unitId: l.unitId,
          qtyMilli: l.qtyMilli,
          unitCostPaisa: l.unitCostPaisa,
        })),
      });
      ui.success(t('common.saved'));
      await onSaved();
    } catch (err) {
      ui.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={t('po.new')}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" icon="check" loading={saving} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label={t('nav.suppliers')}>
          <Select
            value={supplierId}
            onChange={(v) => setSupplierId(v === '' ? '' : Number(v))}
            placeholder="—"
            options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
          />
        </Field>
        <Field label={t('po.expected')}>
          <TextInput value={expectedDate} onChange={setExpectedDate} type="date" />
        </Field>
      </div>

      <div className="field" style={{ marginTop: 10 }}>
        <label>{t('nav.products')}</label>
        <TextInput value={query} onChange={setQuery} placeholder="নাম, স্ক্যান কোড বা SKU" />
        {hits.length > 0 ? (
          <div className="search-results" style={{ position: 'relative', boxShadow: 'none', border: '1px solid var(--line)', borderRadius: 8, marginTop: 4 }}>
            {hits.map((p) => (
              <div key={p.id} className="search-result" onClick={() => addProduct(p)}>
                <div style={{ flex: 1 }}>
                  <div className="bold small">{p.name}</div>
                  <div className="tiny muted">
                    {p.sku ?? ''} • স্টক {qty(p.stock_base_milli)} {p.unit_short_name ?? ''}
                  </div>
                </div>
                <span className="num small">{money(p.purchase_price_paisa ?? 0)}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {lines.length === 0 ? (
        <div className="empty-state" style={{ padding: '24px 0' }}>
          <div className="es-title small">{t('common.none')}</div>
        </div>
      ) : (
        <table className="data" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>প্রোডাক্ট</th>
              <th className="right">{t('common.qty')}</th>
              <th className="right">{t('common.price')}</th>
              <th className="right">{t('common.total')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.productId}>
                <td>
                  <div className="bold small">{l.name}</div>
                  <div className="tiny muted">{l.unitLabel}</div>
                </td>
                <td className="right" style={{ width: 140 }}>
                  <QtyInput value={l.qtyMilli} onChange={(v) => setLines((p) => p.map((x) => (x.productId === l.productId ? { ...x, qtyMilli: v } : x)))} />
                </td>
                <td className="right" style={{ width: 150 }}>
                  <MoneyInput value={l.unitCostPaisa} onChange={(v) => setLines((p) => p.map((x) => (x.productId === l.productId ? { ...x, unitCostPaisa: v } : x)))} />
                </td>
                <td className="right num">{money(Math.round((l.qtyMilli * l.unitCostPaisa) / 1000))}</td>
                <td className="right">
                  <Button size="sm" variant="ghost" icon="trash" onClick={() => setLines((p) => p.filter((x) => x.productId !== l.productId))} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3} className="right bold">{t('common.total')}</td>
              <td className="right num bold">{money(total)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      )}

      <Field label={t('common.notes')} span={2}>
        <TextInput value={note} onChange={setNote} placeholder="ঐচ্ছিক" />
      </Field>
    </Modal>
  );
}

function ReceiveDialog({
  order,
  onClose,
  onSaved,
}: {
  order: PurchaseOrder;
  onClose: () => void;
  onSaved: (poId: number) => Promise<void>;
}) {
  const t = useT();
  const ui = useUI();
  const [full, setFull] = useState<PurchaseOrder | null>(null);
  const [qtys, setQtys] = useState<Record<number, number>>({});
  const [paid, setPaid] = useState(0);
  const [methods, setMethods] = useState<any[]>([]);
  const [methodId, setMethodId] = useState<number | ''>('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      const detail = await call<PurchaseOrder>('purchases.poGet', order.id);
      setFull(detail);
      const initial: Record<number, number> = {};
      for (const item of detail.items ?? []) {
        if (item.remaining_base_milli > 0) initial[item.id] = Math.round((item.remaining_base_milli * 1000) / item.factor_milli);
      }
      setQtys(initial);
      const pm = await call<any[]>('settings.paymentMethods');
      setMethods(pm ?? []);
      const cash = (pm ?? []).find((m: any) => m.is_cash === 1);
      if (cash) setMethodId(cash.id);
    })().catch((err) => ui.error((err as Error).message));
  }, [order.id, ui]);

  const total = useMemo(() => {
    if (!full) return 0;
    return (full.items ?? []).reduce((s, item) => {
      const q = qtys[item.id] ?? 0;
      return s + Math.round((q * item.unit_cost_paisa) / 1000);
    }, 0);
  }, [full, qtys]);

  const submit = async () => {
    if (!full) return;
    const items = (full.items ?? [])
      .filter((i) => (qtys[i.id] ?? 0) > 0)
      .map((i) => ({ poItemId: i.id, qtyMilli: qtys[i.id]! }));
    if (!items.length) {
      ui.error('গ্রহণের পরিমাণ শূন্য — অন্তত একটি লাইন পূরণ করুন।');
      return;
    }
    setSaving(true);
    try {
      const res = await call<{ status: string; purchaseNo: string }>('purchases.poReceive', {
        poId: full.id,
        items,
        paidPaisa: paid,
        defaultMethodId: methodId === '' ? null : Number(methodId),
        note: note || null,
      });
      ui.success(`${res.purchaseNo} • ${t('po.received')}`);
      await onSaved(full.id);
    } catch (err) {
      ui.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`${t('po.receive')} — ${order.po_no}`}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" icon="check" loading={saving} onClick={() => void submit()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      {!full ? (
        <div style={{ padding: 30, textAlign: 'center' }}>
          <Spinner />
        </div>
      ) : (
        <>
          <Banner tone="info">শুধু যা সত্যিই হাতে পেয়েছেন তা লিখুন — বাকি লাইন অর্ডারে খোলা থাকবে।</Banner>
          <table className="data" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>প্রোডাক্ট</th>
                <th className="right">{t('po.remaining')}</th>
                <th className="right">{t('po.receive')}</th>
                <th className="right">{t('common.total')}</th>
              </tr>
            </thead>
            <tbody>
              {(full.items ?? []).map((item) => {
                const remaining = Math.round((item.remaining_base_milli * 1000) / item.factor_milli);
                return (
                  <tr key={item.id}>
                    <td>
                      <div className="bold small">{item.product_name}</div>
                      <div className="tiny muted">{item.unit_label}</div>
                    </td>
                    <td className="right num">{qty(remaining)}</td>
                    <td className="right" style={{ width: 150 }}>
                      <QtyInput
                        value={qtys[item.id] ?? 0}
                        onChange={(v) => setQtys((prev) => ({ ...prev, [item.id]: Math.min(remaining, Math.max(0, v)) }))}
                      />
                    </td>
                    <td className="right num">{money(Math.round(((qtys[item.id] ?? 0) * item.unit_cost_paisa) / 1000))}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3} className="right bold">{t('common.total')}</td>
                <td className="right num bold">{money(total)}</td>
              </tr>
            </tfoot>
          </table>

          <div className="form-grid" style={{ marginTop: 12 }}>
            <Field label={t('common.paid')}>
              <MoneyInput value={paid} onChange={setPaid} />
            </Field>
            <Field label={t('pos.payment')}>
              <Select
                value={methodId}
                onChange={(v) => setMethodId(v === '' ? '' : Number(v))}
                options={methods.map((m) => ({ value: m.id, label: m.name }))}
              />
            </Field>
            <Field label={t('common.notes')} span={2}>
              <TextInput value={note} onChange={setNote} placeholder="ঐচ্ছিক" />
            </Field>
          </div>
        </>
      )}
    </Modal>
  );
}
