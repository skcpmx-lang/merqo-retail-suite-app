import { useEffect, useMemo, useRef, useState } from 'react';
import { call } from '../api.js';
import { money, qty, dateTime } from '../format.js';
import { Icon } from '../icons.js';
import {
  Badge,
  Banner,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  IconButton,
  Loading,
  Modal,
  MoneyInput,
  PageHead,
  Pagination,
  QtyInput,
  Select,
  TextInput,
  useUI,
} from '../ui.js';
import type { ProductWithMeta, Purchase, Supplier } from '../types.js';

interface Line {
  key: string;
  productId: number;
  name: string;
  unitId: number;
  unitLabel: string;
  factorMilli: number;
  qtyMilli: number;
  unitPricePaisa: number;
  discountPaisa: number;
}

let seq = 1;
const PAGE = 25;

export function PurchasesPage({ can }: { can: (perm?: string) => boolean }) {
  const ui = useUI();
  const [rows, setRows] = useState<Purchase[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Purchase | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  const canManage = can('purchase.manage');

  const load = async () => {
    setLoading(true);
    try {
      const res = await call<{ rows: Purchase[]; total: number }>('purchases.list', {
        search: search.trim() || undefined,
        from: from || undefined,
        to: to || undefined,
        page,
        pageSize: PAGE,
      });
      setRows(res.rows);
      setTotal(res.total);
    } catch (err) {
      ui.error('পারচেজ লোড ব্যর্থ', (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, from, to, page]);

  const openDetail = async (row: Purchase) => {
    try {
      setDetail(await call<Purchase | null>('purchases.get', row.id));
    } catch (err) {
      ui.error('বিস্তারিত লোড ব্যর্থ', (err as Error).message);
    }
  };

  const voidPurchase = async (row: Purchase) => {
    const res = await ui.confirm({
      title: 'পারচেজ বাতিল',
      message: `পারচেজ ${row.purchase_no} বাতিল করবেন?`,
      detail: 'স্টক ফেরত যাবে, সাপ্লায়ারের পাওনা সমন্বয় হবে এবং সম্পূর্ণ ঘটনা অডিট লগে সংরক্ষিত থাকবে। ডকুমেন্ট মুছে যাবে না।',
      danger: true,
      requireReason: true,
      reasonLabel: 'বাতিলের কারণ',
      confirmLabel: 'বাতিল করুন',
    });
    if (!res.ok) return;
    try {
      await call('purchases.void', row.id, res.reason);
      ui.success('পারচেজ বাতিল হয়েছে');
      setDetail(null);
      await load();
    } catch (err) {
      ui.error('বাতিল করা যায়নি', (err as Error).message);
    }
  };

  return (
    <>
      <PageHead
        title="পারচেজ"
        sub="সাপ্লায়ার থেকে মাল কেনা, স্টক ও পাওনা — সব এক জায়গায়"
        actions={
          canManage ? (
            <Button variant="primary" icon="plus" onClick={() => setEditorOpen(true)}>
              নতুন পারচেজ
            </Button>
          ) : null
        }
      />

      <Card>
        <div className="toolbar">
          <div className="global-search" style={{ maxWidth: 260 }}>
            <span className="search-icon">
              <Icon name="search" size={16} />
            </span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="পারচেজ নম্বর বা সাপ্লায়ার" />
          </div>
          <TextInput value={from} onChange={setFrom} type="date" />
          <TextInput value={to} onChange={setTo} type="date" />
          <span className="grow" />
          <span className="small muted">মোট {total} টি পারচেজ</span>
        </div>

        {loading ? (
          <Loading />
        ) : (
          <>
            <DataTable
              rows={rows}
              rowKey={(r) => r.id}
              onRowClick={openDetail}
              empty={<EmptyState icon="purchase" title="কোনো পারচেজ নেই" message="মাল কেনার পর এখানে লিখে রাখুন।" />}
              columns={[
                {
                  key: 'purchase_no',
                  label: 'পারচেজ',
                  render: (r) => (
                    <div>
                      <div className="bold mono">{r.purchase_no}</div>
                      <div className="tiny muted">{dateTime(r.purchase_date)}</div>
                    </div>
                  ),
                },
                { key: 'supplier_name', label: 'সাপ্লায়ার', render: (r) => r.supplier_name || '—' },
                { key: 'total_paisa', label: 'মোট', align: 'right', render: (r) => <span className="num bold">{money(r.total_paisa)}</span> },
                { key: 'paid_paisa', label: 'পরিশোধ', align: 'right', render: (r) => <span className="num">{money(r.paid_paisa)}</span> },
                {
                  key: 'due_paisa',
                  label: 'বাকি',
                  align: 'right',
                  render: (r) => (
                    <span className={`num ${r.due_paisa > 0 ? 'warn-text bold' : ''}`}>{money(r.due_paisa)}</span>
                  ),
                },
                {
                  key: 'status',
                  label: 'অবস্থা',
                  render: (r) =>
                    r.status === 'voided' ? (
                      <Badge tone="red">বাতিল</Badge>
                    ) : r.status === 'returned' ? (
                      <Badge tone="amber">রিটার্ন হয়েছে</Badge>
                    ) : (
                      <Badge tone="green">সম্পন্ন</Badge>
                    ),
                },
                {
                  key: 'act',
                  label: '',
                  align: 'right',
                  width: 70,
                  render: (r) => <IconButton icon="eye" title="বিস্তারিত" onClick={() => openDetail(r)} />,
                },
              ]}
            />
            <Pagination page={page} pageSize={PAGE} total={total} onPage={setPage} />
          </>
        )}
      </Card>

      {detail ? (
        <Modal
          title={`পারচেজ ${detail.purchase_no}`}
          sub={`${detail.supplier_name || 'সাপ্লায়ার নেই'} • ${dateTime(detail.purchase_date)}`}
          size="lg"
          onClose={() => setDetail(null)}
          footer={
            <>
              <Button onClick={() => setDetail(null)}>বন্ধ</Button>
              {detail.status !== 'voided' && can('return.manage') ? (
                <Button icon="return" onClick={() => ui.toast('info', 'রিটার্ন', 'রিটার্ন ও রিফান্ড পেজ থেকে এই পারচেজে রিটার্ন করুন।')}>
                  রিটার্ন
                </Button>
              ) : null}
              {detail.status !== 'voided' ? (
                <Button variant="danger" icon="trash" onClick={() => voidPurchase(detail)}>
                  বাতিল করুন
                </Button>
              ) : null}
            </>
          }
        >
          <div className="row" style={{ gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
            <Badge tone={detail.status === 'voided' ? 'red' : 'green'}>
              {detail.status === 'voided' ? 'বাতিল হয়েছে' : 'সম্পন্ন'}
            </Badge>
            {detail.note ? <span className="small muted">নোট: {detail.note}</span> : null}
          </div>
          <DataTable
            compact
            rows={detail.items ?? []}
            rowKey={(r: any) => r.id}
            columns={[
              { key: 'product_name', label: 'প্রোডাক্ট' },
              {
                key: 'qty_milli',
                label: 'পরিমাণ',
                align: 'right',
                render: (r: any) => (
                  <span className="num">
                    {qty(r.qty_milli)} {r.unit_short_name ?? ''}
                  </span>
                ),
              },
              { key: 'unit_price_paisa', label: 'দর', align: 'right', render: (r: any) => <span className="num">{money(r.unit_price_paisa)}</span> },
              { key: 'discount_paisa', label: 'ছাড়', align: 'right', render: (r: any) => <span className="num">{money(r.discount_paisa)}</span> },
              { key: 'line_total_paisa', label: 'মোট', align: 'right', render: (r: any) => <span className="num bold">{money(r.line_total_paisa)}</span> },
            ]}
          />
          <div className="col" style={{ marginTop: 12, gap: 4 }}>
            <Row label="সাবটোটাল" value={money(detail.subtotal_paisa)} />
            <Row label="ডিসকাউন্ট" value={`−${money(detail.discount_paisa)}`} />
            <Row label="অন্যান্য খরচ" value={money(detail.other_cost_paisa)} />
            <Row label="সর্বমোট" value={money(detail.total_paisa)} strong />
            <Row label="পরিশোধিত" value={money(detail.paid_paisa)} />
            <Row label="বাকি" value={money(detail.due_paisa)} strong />
          </div>
        </Modal>
      ) : null}

      {editorOpen ? (
        <PurchaseEditor
          onClose={() => setEditorOpen(false)}
          onSaved={() => {
            setEditorOpen(false);
            void load();
          }}
        />
      ) : null}
    </>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="row" style={{ justifyContent: 'flex-end', gap: 24 }}>
      <span className={strong ? 'bold' : 'muted small'}>{label}</span>
      <span className={`num ${strong ? 'bold' : ''}`} style={{ minWidth: 110, textAlign: 'right' }}>
        {value}
      </span>
    </div>
  );
}

function PurchaseEditor({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const ui = useUI();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [methods, setMethods] = useState<{ id: number; name: string; is_cash: 0 | 1 }[]>([]);
  const [supplierId, setSupplierId] = useState<number | ''>('');
  const [lines, setLines] = useState<Line[]>([]);
  const [discountType, setDiscountType] = useState<'none' | 'percent' | 'fixed'>('none');
  const [discountValue, setDiscountValue] = useState(0);
  const [otherCost, setOtherCost] = useState(0);
  const [paid, setPaid] = useState(0);
  const [methodId, setMethodId] = useState<number | ''>('');
  const [note, setNote] = useState('');
  const [purchaseDate, setPurchaseDate] = useState('');
  const [computation, setComputation] = useState<any | null>(null);
  const [computeError, setComputeError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // product picker
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<ProductWithMeta[]>([]);
  const [picking, setPicking] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [sup, met] = await Promise.all([
          call<{ rows: Supplier[] }>('suppliers.list', { pageSize: 200 }),
          call<any[]>('settings.paymentMethods'),
        ]);
        setSuppliers(sup.rows);
        setMethods(met);
        const cash = met.find((m: any) => m.is_cash === 1) ?? met[0];
        if (cash) setMethodId(cash.id);
      } catch (err) {
        ui.error('তথ্য লোড ব্যর্থ', (err as Error).message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    if (term.trim().length < 1) {
      setResults([]);
      return;
    }
    timer.current = window.setTimeout(async () => {
      try {
        const res = await call<{ rows: ProductWithMeta[] }>('products.list', { search: term.trim(), pageSize: 12 });
        setResults(res.rows);
      } catch {
        setResults([]);
      }
    }, 220);
  }, [term]);

  const addLine = (product: ProductWithMeta) => {
    setTerm('');
    setResults([]);
    setLines((prev) => {
      const idx = prev.findIndex((l) => l.productId === product.id);
      if (idx >= 0) {
        const copy = [...prev];
        copy[idx] = { ...copy[idx]!, qtyMilli: copy[idx]!.qtyMilli + 1000 };
        return copy;
      }
      return [
        ...prev,
        {
          key: `pl${seq++}`,
          productId: product.id,
          name: product.name,
          unitId: product.primary_unit_id ?? product.unit_id,
          unitLabel: product.primary_unit_short_name ?? product.unit_short_name ?? '',
          factorMilli: product.unit_factor_milli ?? 1000,
          qtyMilli: 1000,
          unitPricePaisa: product.avg_cost_micro > 0 ? Math.round(product.avg_cost_micro / 1000) : product.purchase_price,
          discountPaisa: 0,
        },
      ];
    });
  };

  const input = useMemo(
    () => ({
      supplierId: supplierId || null,
      lines: lines.map((l) => ({
        productId: l.productId,
        unitId: l.unitId,
        qtyMilli: l.qtyMilli,
        unitPricePaisa: l.unitPricePaisa,
        discountPaisa: l.discountPaisa || null,
      })),
      orderDiscountType: discountType,
      orderDiscountValue: discountValue,
      otherCostPaisa: otherCost,
      paidPaisa: paid,
      defaultMethodId: methodId || null,
      purchaseDate: purchaseDate || undefined,
      actor: { id: 0, username: 'ui' },
    }),
    [supplierId, lines, discountType, discountValue, otherCost, paid, methodId, purchaseDate],
  );

  useEffect(() => {
    if (!lines.length) {
      setComputation(null);
      return;
    }
    let alive = true;
    const t = window.setTimeout(async () => {
      try {
        const res = await call('purchases.compute', input);
        if (alive) {
          setComputation(res);
          setComputeError(null);
        }
      } catch (err) {
        if (alive) {
          setComputation(null);
          setComputeError((err as Error).message);
        }
      }
    }, 200);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [input, lines.length]);

  const needsSupplier = (computation?.due ?? 0) > 0 && !supplierId;

  const save = async () => {
    if (!lines.length) {
      ui.error('কোনো প্রোডাক্ট নেই', 'অন্তত একটি প্রোডাক্ট যোগ করুন।');
      return;
    }
    if (needsSupplier) {
      ui.error(
        'সাপ্লায়ার নির্বাচন করুন',
        'বাকি থাকা ক্রয়ের পাওনা সাপ্লায়ার খাতে যোগ করতে হয় — নইলে পুরো টাকা পরিশোধ করুন।',
      );
      return;
    }
    setSaving(true);
    try {
      const result = await call<{ purchaseNo: string }>('purchases.create', input);
      ui.success('পারচেজ সংরক্ষিত হয়েছে', `নম্বর ${result.purchaseNo}`);
      onSaved();
    } catch (err) {
      ui.error('সংরক্ষণ ব্যর্থ', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="নতুন পারচেজ"
      sub="সাপ্লায়ার থেকে মাল কেনার হিসাব"
      size="xl"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>বাতিল</Button>
          <Button variant="primary" icon="check" loading={saving} disabled={needsSupplier} onClick={save}>
            সংরক্ষণ করুন
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="সাপ্লায়ার">
          <Select
            value={supplierId}
            onChange={(v) => setSupplierId(v ? Number(v) : '')}
            options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
            placeholder="সাপ্লায়ার নির্বাচন"
          />
        </Field>
        <Field label="পারচেজ তারিখ" hint="খালি রাখলে আজকের তারিখ">
          <TextInput value={purchaseDate} onChange={setPurchaseDate} type="date" />
        </Field>
      </div>

      <div className="section-title" style={{ marginTop: 14 }}>
        প্রোডাক্ট যোগ করুন
      </div>
      <div style={{ position: 'relative' }}>
        <div className="global-search" style={{ maxWidth: 'none' }}>
          <span className="search-icon">
            <Icon name="search" size={16} />
          </span>
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="প্রোডাক্টের নাম, SKU বা বারকোড লিখুন"
            onFocus={() => setPicking(true)}
            onBlur={() => window.setTimeout(() => setPicking(false), 180)}
          />
        </div>
        {picking && results.length ? (
          <div className="search-results" style={{ position: 'absolute', zIndex: 30 }}>
            {results.map((p) => (
              <div
                key={p.id}
                className="search-result"
                onMouseDown={(e) => {
                  e.preventDefault();
                  addLine(p);
                }}
              >
                <div style={{ flex: 1 }}>
                  <div className="bold small">{p.name}</div>
                  <div className="tiny muted">
                    স্টক {qty(p.stock_base_milli)} {p.primary_unit_short_name ?? ''} • ক্রয়মূল্য {money(p.purchase_price)}
                  </div>
                </div>
                <Icon name="plus" size={16} />
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div style={{ marginTop: 10 }}>
        <DataTable
          compact
          rows={lines}
          rowKey={(r) => r.key}
          empty={<EmptyState icon="purchase" title="এখনো কোনো প্রোডাক্ট যোগ করা হয়নি" />}
          columns={[
            { key: 'name', label: 'প্রোডাক্ট' },
            {
              key: 'qty',
              label: 'পরিমাণ',
              width: 150,
              render: (r) => (
                <div className="row" style={{ gap: 4 }}>
                  <QtyInput
                    value={r.qtyMilli}
                    onChange={(v) => setLines((prev) => prev.map((l) => (l.key === r.key ? { ...l, qtyMilli: v } : l)))}
                  />
                  <span className="badge plain">{r.unitLabel}</span>
                </div>
              ),
            },
            {
              key: 'unitPrice',
              label: 'ক্রয়মূল্য',
              width: 130,
              render: (r) => (
                <MoneyInput
                  value={r.unitPricePaisa}
                  onChange={(v) => setLines((prev) => prev.map((l) => (l.key === r.key ? { ...l, unitPricePaisa: v } : l)))}
                />
              ),
            },
            {
              key: 'discount',
              label: 'ছাড়',
              width: 110,
              render: (r) => (
                <MoneyInput
                  value={r.discountPaisa}
                  onChange={(v) => setLines((prev) => prev.map((l) => (l.key === r.key ? { ...l, discountPaisa: v } : l)))}
                />
              ),
            },
            {
              key: 'lineTotal',
              label: 'মোট',
              align: 'right',
              render: (r) => (
                <span className="num bold">{money(Math.round((r.unitPricePaisa * r.qtyMilli) / 1000) - r.discountPaisa)}</span>
              ),
            },
            {
              key: 'del',
              label: '',
              width: 40,
              render: (r) => (
                <IconButton
                  icon="trash"
                  danger
                  title="বাদ দিন"
                  onClick={() => setLines((prev) => prev.filter((l) => l.key !== r.key))}
                />
              ),
            },
          ]}
        />
      </div>

      <div className="grid-2" style={{ marginTop: 14 }}>
        <div className="form-grid">
          <Field label="অর্ডার ডিসকাউন্ট">
            <Select
              value={discountType}
              onChange={(v) => setDiscountType(v as any)}
              options={[
                { value: 'none', label: 'নেই' },
                { value: 'percent', label: 'শতাংশ' },
                { value: 'fixed', label: 'টাকা' },
              ]}
            />
          </Field>
          <Field label="পরিমাণ">
            {discountType === 'percent' ? (
              <TextInput
                value={discountValue / 100}
                onChange={(v) => setDiscountValue(Math.round((Number(v.replace(/[^\d.]/g, '')) || 0) * 100))}
              />
            ) : (
              <MoneyInput value={discountValue} onChange={setDiscountValue} disabled={discountType === 'none'} />
            )}
          </Field>
          <Field label="পরিবহন / অন্যান্য খরচ">
            <MoneyInput value={otherCost} onChange={setOtherCost} />
          </Field>
          <Field label="এখন পরিশোধ">
            <MoneyInput value={paid} onChange={setPaid} />
          </Field>
          <Field label="পেমেন্ট মাধ্যম">
            <Select value={methodId} onChange={(v) => setMethodId(v ? Number(v) : '')} options={methods.map((m) => ({ value: m.id, label: m.name }))} />
          </Field>
          <Field label="নোট">
            <TextInput value={note} onChange={setNote} placeholder="যেমন: চালের চালান ১২" />
          </Field>
        </div>
        <div className="card" style={{ padding: 14, background: 'var(--surface-2)', alignSelf: 'start' }}>
          <div className="section-title">হিসাব</div>
          {computeError ? (
            <Banner tone="danger" icon="warning">
              {computeError}
            </Banner>
          ) : null}
          <Row label="সাবটোটাল" value={money(computation?.subtotal ?? 0)} />
          <Row label="ডিসকাউন্ট" value={`−${money(computation?.discount ?? 0)}`} />
          <Row label="অন্যান্য খরচ" value={money(computation?.otherCost ?? 0)} />
          <Row label="সর্বমোট" value={money(computation?.total ?? 0)} strong />
          <Row label="পরিশোধ" value={money(computation?.paid ?? 0)} />
          <Row label="বাকি" value={money(computation?.due ?? 0)} strong />
          {computation?.due > 0 && !supplierId ? (
            <Banner tone="warn" icon="warning">
              বাকি থাকলে সাপ্লায়ার নির্বাচন করুন, নইলে পুরো টাকা পরিশোধ করুন — নাহলে পাওনা কারও খাতে
              যোগ হবে না।
            </Banner>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
