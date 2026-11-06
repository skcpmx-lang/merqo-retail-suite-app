import { useCallback, useEffect, useMemo, useState } from 'react';
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
  IconButton,
  Loading,
  Modal,
  MoneyInput,
  PageHead,
  Pagination,
  QtyInput,
  Select,
  Switch,
  Tabs,
  TextInput,
  useUI,
} from '../ui.js';
import type { Purchase, ReturnDoc, Sale } from '../types.js';

const PAGE = 25;

export function ReturnsPage({ can }: { can: (perm?: string) => boolean }) {
  const ui = useUI();
  const [tab, setTab] = useState<'all' | 'sale' | 'purchase'>('all');
  const [rows, setRows] = useState<ReturnDoc[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [from, setFrom] = useState(addDays(today(), -90));
  const [to, setTo] = useState(today());
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<ReturnDoc | null>(null);

  const [startOpen, setStartOpen] = useState<null | 'sale' | 'purchase'>(null);
  const [sale, setSale] = useState<Sale | null>(null);
  const [purchase, setPurchase] = useState<Purchase | null>(null);
  const [term, setTerm] = useState('');
  const [options, setOptions] = useState<any[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await call<{ rows: ReturnDoc[]; total: number }>('returns.list', {
        kind: tab,
        from,
        to,
        search: search.trim() || undefined,
        page,
        pageSize: PAGE,
      });
      setRows(res.rows);
      setTotal(res.total);
    } catch (err) {
      ui.error('রিটার্ন লোড ব্যর্থ', (err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [tab, from, to, search, page, ui]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!startOpen) return;
    let alive = true;
    const t = window.setTimeout(async () => {
      try {
        if (startOpen === 'sale') {
          const res = await call<{ rows: Sale[] }>('sales.list', { search: term.trim() || undefined, pageSize: 15 });
          if (alive) setOptions(res.rows.filter((r) => r.status !== 'voided'));
        } else {
          const res = await call<{ rows: Purchase[] }>('purchases.list', { search: term.trim() || undefined, pageSize: 15 });
          if (alive) setOptions(res.rows.filter((r) => r.status !== 'voided'));
        }
      } catch {
        if (alive) setOptions([]);
      }
    }, 220);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [term, startOpen]);

  const pick = async (row: any) => {
    try {
      if (startOpen === 'sale') setSale(await call<Sale>('sales.get', row.id));
      else setPurchase(await call<Purchase>('purchases.get', row.id));
      setStartOpen(null);
      setTerm('');
      setOptions([]);
    } catch (err) {
      ui.error('লোড ব্যর্থ', (err as Error).message);
    }
  };

  const openDetail = async (row: ReturnDoc) => {
    try {
      setDetail(await call<ReturnDoc | null>('returns.get', row.id));
    } catch (err) {
      ui.error('রিটার্ন লোড ব্যর্থ', (err as Error).message);
    }
  };

  return (
    <>
      <PageHead
        title="রিটার্ন ও রিফান্ড"
        sub="কাস্টমার ফেরত ও সাপ্লায়ারকে ফেরত — স্টক ও হিসাব নিজে থেকেই সমন্বয় হয়"
        actions={
          can('return.manage') ? (
            <>
              <Button icon="purchase" onClick={() => setStartOpen('purchase')}>
                পারচেজ রিটার্ন
              </Button>
              <Button variant="primary" icon="return" onClick={() => setStartOpen('sale')}>
                সেলস রিটার্ন
              </Button>
            </>
          ) : null
        }
      />

      <Card>
        <div className="toolbar">
          <Tabs
            active={tab}
            onChange={(t) => {
              setTab(t);
              setPage(1);
            }}
            tabs={[
              { id: 'all', label: 'সব' },
              { id: 'sale', label: 'সেলস রিটার্ন' },
              { id: 'purchase', label: 'পারচেজ রিটার্ন' },
            ]}
          />
          <span className="grow" />
          <div className="global-search" style={{ maxWidth: 220 }}>
            <span className="search-icon">
              <Icon name="search" size={16} />
            </span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="রিটার্ন নম্বর বা নাম" />
          </div>
          <TextInput value={from} onChange={setFrom} type="date" />
          <TextInput value={to} onChange={setTo} type="date" />
        </div>

        {loading ? (
          <Loading />
        ) : (
          <>
            <DataTable
              rows={rows}
              rowKey={(r) => r.id}
              onRowClick={openDetail}
              empty={<EmptyState icon="return" title="কোনো রিটার্ন নেই" message="কাস্টমার কিছু ফেরত দিলে এখানে লিখুন।" />}
              columns={[
                {
                  key: 'return_no',
                  label: 'রিটার্ন',
                  render: (r) => (
                    <div>
                      <div className="bold mono">{r.return_no}</div>
                      <div className="tiny muted">{dateTime(r.return_date)}</div>
                    </div>
                  ),
                },
                {
                  key: 'kind',
                  label: 'ধরন',
                  render: (r) => <Badge tone={r.kind === 'sale' ? 'amber' : 'blue'}>{r.kind === 'sale' ? 'সেলস' : 'পারচেজ'}</Badge>,
                },
                { key: 'party_name', label: 'পক্ষ', render: (r) => r.party_name || '—' },
                { key: 'ref_no', label: 'মূল ডকুমেন্ট', render: (r) => <span className="mono small">{r.ref_no ?? '—'}</span> },
                { key: 'total_paisa', label: 'মোট', align: 'right', render: (r) => <span className="num">{money(r.total_paisa)}</span> },
                {
                  key: 'refund_paisa',
                  label: 'রিফান্ড',
                  align: 'right',
                  render: (r) => <span className="num bold">{money(r.refund_paisa)}</span>,
                },
                {
                  key: 'restock',
                  label: 'স্টক',
                  align: 'center',
                  render: (r) => (r.restock === 1 ? <Icon name="check" size={15} style={{ color: 'var(--success-500)' }} /> : <span className="tiny muted">ফেরত হয়নি</span>),
                },
                { key: 'act', label: '', align: 'right', width: 50, render: (r) => <IconButton icon="eye" title="বিস্তারিত" onClick={() => openDetail(r)} /> },
              ]}
            />
            <Pagination page={page} pageSize={PAGE} total={total} onPage={setPage} />
          </>
        )}
      </Card>

      {startOpen ? (
        <Modal
          title={startOpen === 'sale' ? 'কোন ইনভয়েসের রিটার্ন?' : 'কোন পারচেজের রিটার্ন?'}
          sub="ইনভয়েস/পারচেজ নম্বর বা নাম দিয়ে খুঁজুন"
          onClose={() => setStartOpen(null)}
          footer={<Button onClick={() => setStartOpen(null)}>বাতিল</Button>}
        >
          <div className="global-search" style={{ maxWidth: 'none' }}>
            <span className="search-icon">
              <Icon name="search" size={16} />
            </span>
            <input autoFocus value={term} onChange={(e) => setTerm(e.target.value)} placeholder={startOpen === 'sale' ? 'যেমন: INV-000123' : 'যেমন: PUR-000045'} />
          </div>
          <div className="col" style={{ gap: 6, marginTop: 10, maxHeight: 360, overflow: 'auto' }}>
            {options.length === 0 ? (
              <EmptyState icon="file" title="কিছু পাওয়া যায়নি" message="নম্বরটি সম্পূর্ণ লিখে খুঁজুন।" />
            ) : (
              options.map((row: any) => (
                <button key={row.id} className="search-result" style={{ textAlign: 'left', width: '100%' }} onClick={() => void pick(row)}>
                  <span className="kind">{startOpen === 'sale' ? 'ইনভয়েস' : 'পারচেজ'}</span>
                  <div style={{ flex: 1 }}>
                    <div className="bold small">{startOpen === 'sale' ? row.invoice_no : row.purchase_no}</div>
                    <div className="tiny muted">
                      {(startOpen === 'sale' ? row.customer_name : row.supplier_name) || '—'} • {dateTime(startOpen === 'sale' ? row.sale_date : row.purchase_date)}
                    </div>
                  </div>
                  <span className="num small bold">{money(row.total_paisa)}</span>
                </button>
              ))
            )}
          </div>
        </Modal>
      ) : null}

      {sale ? (
        <SaleReturnModal
          sale={sale}
          onClose={() => setSale(null)}
          onDone={() => {
            setSale(null);
            void load();
          }}
        />
      ) : null}

      {purchase ? (
        <PurchaseReturnModal
          purchase={purchase}
          onClose={() => setPurchase(null)}
          onDone={() => {
            setPurchase(null);
            void load();
          }}
        />
      ) : null}

      {detail ? (
        <Modal
          title={`রিটার্ন ${detail.return_no}`}
          sub={`${detail.kind === 'sale' ? 'সেলস রিটার্ন' : 'পারচেজ রিটার্ন'} • ${dateTime(detail.return_date)}`}
          size="lg"
          onClose={() => setDetail(null)}
          footer={<Button onClick={() => setDetail(null)}>বন্ধ</Button>}
        >
          <DataTable
            compact
            rows={detail.items ?? []}
            rowKey={(r: any) => r.id}
            columns={[
              { key: 'product_name', label: 'প্রোডাক্ট' },
              { key: 'qty_milli', label: 'পরিমাণ', align: 'right', render: (r: any) => <span className="num">{qty(r.qty_milli)}</span> },
              { key: 'unit_price_paisa', label: 'দর', align: 'right', render: (r: any) => <span className="num">{money(r.unit_price_paisa)}</span> },
              {
                key: 'condition',
                label: 'অবস্থা',
                render: (r: any) => (
                  <Badge tone={r.condition === 'good' ? 'green' : r.condition === 'damaged' ? 'red' : 'amber'}>
                    {r.condition === 'good' ? 'ভালো' : r.condition === 'damaged' ? 'নষ্ট' : 'মেয়াদোত্তীর্ণ'}
                  </Badge>
                ),
              },
              { key: 'restocked', label: 'স্টকে', align: 'center', render: (r: any) => (r.restocked === 1 ? 'হ্যাঁ' : 'না') },
              { key: 'line_total_paisa', label: 'মোট', align: 'right', render: (r: any) => <span className="num bold">{money(r.line_total_paisa)}</span> },
            ]}
          />
          <div className="col" style={{ marginTop: 10, gap: 2 }}>
            <div className="row" style={{ justifyContent: 'flex-end', gap: 24 }}>
              <span className="muted small">সর্বমোট</span>
              <span className="num bold" style={{ minWidth: 120, textAlign: 'right' }}>
                {money(detail.total_paisa)}
              </span>
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', gap: 24 }}>
              <span className="muted small">রিফান্ড</span>
              <span className="num bold" style={{ minWidth: 120, textAlign: 'right' }}>
                {money(detail.refund_paisa)}
              </span>
            </div>
            {detail.note ? <Banner tone={'info'}>{detail.note}</Banner> : null}
          </div>
        </Modal>
      ) : null}
    </>
  );
}

export function SaleReturnModal({
  sale,
  onClose,
  onDone,
}: {
  sale: Sale;
  onClose: () => void;
  onDone: () => void;
}) {
  const ui = useUI();
  const [qtys, setQtys] = useState<Record<number, number>>({});
  const [conditions, setConditions] = useState<Record<number, 'good' | 'damaged' | 'expired'>>({});
  const [restock, setRestock] = useState(true);
  const [refund, setRefund] = useState(0);
  const [methodId, setMethodId] = useState<number | ''>('');
  const [note, setNote] = useState('');
  const [methods, setMethods] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    call<any[]>('settings.paymentMethods').then((m) => {
      setMethods(m);
      const cash = m.find((x: any) => x.is_cash === 1) ?? m[0];
      if (cash) setMethodId(cash.id);
    });
  }, []);

  const items = sale.items ?? [];
  const computedTotal = useMemo(() => {
    return items.reduce((sum, item) => {
      const q = qtys[item.id] ?? 0;
      if (!q) return sum;
      const perUnit = item.qty_milli > 0 ? item.line_total_paisa / item.qty_milli : 0;
      return sum + Math.round(perUnit * q);
    }, 0);
  }, [items, qtys]);

  // A return can only pay cash up to the credit it creates; anything beyond an
  // outstanding due settles the due instead (server enforces the same rule).
  const refundable = Math.max(0, computedTotal - Math.max(0, sale.due_paisa ?? 0));
  const appliedToDue = Math.max(0, refund - refundable);

  useEffect(() => {
    if (!touched) setRefund(refundable);
  }, [refundable, touched]);

  const submit = async () => {
    const lines = Object.entries(qtys)
      .filter(([, q]) => q > 0)
      .map(([lineId, qtyMilli]) => ({
        lineId: Number(lineId),
        qtyMilli,
        condition: conditions[Number(lineId)] ?? ('good' as const),
      }));
    if (!lines.length) {
      ui.error('পরিমাণ দিন', 'যে পণ্য ফেরত আসছে তার পরিমাণ লিখুন।');
      return;
    }
    setBusy(true);
    try {
      const res = await call<{ returnNo: string; refund: number; appliedToDue: number }>('returns.createSaleReturn', {
        saleId: sale.id,
        items: lines,
        restock,
        refundPaisa: refund,
        refundMethodId: methodId || null,
        note: note || null,
      });
      const adjust = res.appliedToDue > 0 ? ` • বাকির সাথে সমন্বয় ${money(res.appliedToDue)}` : '';
      ui.success('রিটার্ন সম্পন্ন', `${res.returnNo} • নগদ রিফান্ড ${money(res.refund)}${adjust}`);
      onDone();
    } catch (err) {
      ui.error('রিটার্ন ব্যর্থ', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="সেলস রিটার্ন"
      sub={`ইনভয়েস ${sale.invoice_no} • ${sale.customer_name || 'ওয়াক-ইন'}`}
      size="xl"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>বাতিল</Button>
          <Button variant="primary" icon="check" loading={busy} onClick={submit}>
            রিটার্ন সম্পন্ন করুন
          </Button>
        </>
      }
    >
      <DataTable
        compact
        rows={items}
        rowKey={(r) => r.id}
        columns={[
          { key: 'product_name', label: 'প্রোডাক্ট' },
          {
            key: 'sold',
            label: 'বিক্রি / আগে ফেরত',
            align: 'right',
            render: (r) => (
              <span className="num">
                {qty(r.qty_milli)} {r.unit_short_name ?? ''}
                {r.returned_qty_milli ? <span className="tiny muted"> / {qty(r.returned_qty_milli)}</span> : null}
              </span>
            ),
          },
          {
            key: 'qty',
            label: 'ফেরতের পরিমাণ',
            width: 150,
            render: (r) => {
              const max = r.qty_milli - (r.returned_qty_milli ?? 0);
              return (
                <QtyInput
                  value={qtys[r.id] ?? 0}
                  onChange={(v) => setQtys((prev) => ({ ...prev, [r.id]: Math.min(v, max) }))}
                />
              );
            },
          },
          {
            key: 'condition',
            label: 'অবস্থা',
            width: 140,
            render: (r) => (
              <Select
                value={conditions[r.id] ?? 'good'}
                onChange={(v) => setConditions((prev) => ({ ...prev, [r.id]: v as any }))}
                options={[
                  { value: 'good', label: 'ভালো (স্টকে ফিরবে)' },
                  { value: 'damaged', label: 'নষ্ট' },
                  { value: 'expired', label: 'মেয়াদোত্তীর্ণ' },
                ]}
              />
            ),
          },
          { key: 'line_total_paisa', label: 'মূল্য', align: 'right', render: (r) => <span className="num">{money(r.line_total_paisa)}</span> },
        ]}
      />

      <div className="grid-2" style={{ marginTop: 14 }}>
        <div className="form-grid">
          <Field label="রিফান্ডের পরিমাণ" hint={`নগদে সর্বোচ্চ ${money(refundable)} — এর বেশি হলে বাকির সাথে সমন্বয় হবে`}>
            <MoneyInput
              value={refund}
              onChange={(v) => {
                setTouched(true);
                setRefund(v);
              }}
            />
          </Field>
          <Field label="রিফান্ড মাধ্যম">
            <Select value={methodId} onChange={(v) => setMethodId(Number(v))} options={methods.map((m) => ({ value: m.id, label: m.name }))} />
          </Field>
          <div className="span-2">
            <Switch checked={restock} onChange={setRestock} label="ভালো অবস্থার পণ্য আবার স্টকে ফিরবে" />
          </div>
          <Field label="নোট" span={2}>
            <TextInput value={note} onChange={setNote} placeholder="যেমন: সাইজ মেলেনি" />
          </Field>
        </div>
        <div className="card" style={{ padding: 14, background: 'var(--surface-2)', alignSelf: 'start' }}>
          <div className="section-title">হিসাব</div>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="muted small">ফেরতের মূল্য</span>
            <span className="num bold">{money(computedTotal)}</span>
          </div>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="muted small">রিফান্ড</span>
            <span className="num bold">{money(refund)}</span>
          </div>
          {appliedToDue > 0 ? (
            <>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="muted small">বাকির সাথে সমন্বয়</span>
                <span className="num bold">{money(appliedToDue)}</span>
              </div>
              <Banner tone="info" icon="info">
                ইনভয়েসে বাকি থাকায় {money(appliedToDue)} নগদ ফেরত হবে না — কাস্টমারের বাকির সাথে সমন্বয় হবে।
              </Banner>
            </>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

export function PurchaseReturnModal({
  purchase,
  onClose,
  onDone,
}: {
  purchase: Purchase;
  onClose: () => void;
  onDone: () => void;
}) {
  const ui = useUI();
  const [qtys, setQtys] = useState<Record<number, number>>({});
  const [methodId, setMethodId] = useState<number | ''>('');
  const [methods, setMethods] = useState<any[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [refund, setRefund] = useState(0);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    call<any[]>('settings.paymentMethods').then((m) => {
      setMethods(m);
      const cash = m.find((x: any) => x.is_cash === 1) ?? m[0];
      if (cash) setMethodId(cash.id);
    });
  }, []);

  const items = purchase.items ?? [];
  const total = useMemo(
    () =>
      items.reduce((sum, item) => {
        const q = qtys[item.id] ?? 0;
        if (!q) return sum;
        const perUnit = item.qty_milli > 0 ? item.line_total_paisa / item.qty_milli : 0;
        return sum + Math.round(perUnit * q);
      }, 0),
    [items, qtys],
  );
  useEffect(() => {
    if (!touched) setRefund(total);
  }, [total, touched]);

  const submit = async () => {
    const lines = Object.entries(qtys)
      .filter(([, q]) => q > 0)
      .map(([lineId, qtyMilli]) => ({ lineId: Number(lineId), qtyMilli }));
    if (!lines.length) {
      ui.error('পরিমাণ দিন', 'ফেরত দেওয়ার পরিমাণ লিখুন।');
      return;
    }
    setBusy(true);
    try {
      const res = await call<{ returnNo: string; refund: number }>('returns.createPurchaseReturn', {
        purchaseId: purchase.id,
        items: lines,
        refundPaisa: refund,
        refundMethodId: methodId || null,
        note: note || null,
      });
      ui.success('পারচেজ রিটার্ন সম্পন্ন', `${res.returnNo} • ফেরত ${money(res.refund)}`);
      onDone();
    } catch (err) {
      ui.error('রিটার্ন ব্যর্থ', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="পারচেজ রিটার্ন"
      sub={`পারচেজ ${purchase.purchase_no} • ${purchase.supplier_name || '—'}`}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>বাতিল</Button>
          <Button variant="primary" icon="check" loading={busy} onClick={submit}>
            ফেরত দিন
          </Button>
        </>
      }
    >
      <DataTable
        compact
        rows={items}
        rowKey={(r) => r.id}
        columns={[
          { key: 'product_name', label: 'প্রোডাক্ট' },
          {
            key: 'qty_milli',
            label: 'কেনা / আগে ফেরত',
            align: 'right',
            render: (r) => (
              <span className="num">
                {qty(r.qty_milli)}
                {r.returned_qty_milli ? <span className="tiny muted"> / {qty(r.returned_qty_milli)}</span> : null}
              </span>
            ),
          },
          {
            key: 'qty',
            label: 'ফেরতের পরিমাণ',
            width: 150,
            render: (r) => (
              <QtyInput
                value={qtys[r.id] ?? 0}
                onChange={(v) => setQtys((prev) => ({ ...prev, [r.id]: Math.min(v, r.qty_milli - (r.returned_qty_milli ?? 0)) }))}
              />
            ),
          },
          { key: 'unit_price_paisa', label: 'দর', align: 'right', render: (r) => <span className="num">{money(r.unit_price_paisa)}</span> },
        ]}
      />
      <div className="form-grid" style={{ marginTop: 12 }}>
        <Field label="ফেরত পাওয়ার পরিমাণ">
          <MoneyInput
            value={refund}
            onChange={(v) => {
              setTouched(true);
              setRefund(v);
            }}
          />
        </Field>
        <Field label="মাধ্যম">
          <Select value={methodId} onChange={(v) => setMethodId(Number(v))} options={methods.map((m) => ({ value: m.id, label: m.name }))} />
        </Field>
        <Field label="নোট" span={2}>
          <TextInput value={note} onChange={setNote} placeholder="যেমন: প্যাকেট ছেঁড়া" />
        </Field>
      </div>
    </Modal>
  );
}
