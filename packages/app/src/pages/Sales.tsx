import { useCallback, useEffect, useState } from 'react';
import { call } from '../api.js';
import { useShopRefresh } from '../lib/use-shop-refresh.js';
import { money, qty, dateTime, today, addDays } from '../format.js';
import { Icon } from '../icons.js';
import {
  Badge,
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
  Select,
  TextInput,
  useUI,
} from '../ui.js';
import type { AppSettings, Sale } from '../types.js';
import type { PageId } from '../App.js';
import { SaleReturnModal } from './Returns.js';

const PAGE = 25;

export function SalesPage({
  can,
  settings,
  navigate,
}: {
  can: (perm?: string) => boolean;
  settings: AppSettings | null;
  navigate: (p: PageId) => void;
}) {
  const ui = useUI();
  const [rows, setRows] = useState<Sale[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState(addDays(today(), -30));
  const [to, setTo] = useState(today());
  const [status, setStatus] = useState<'all' | 'completed' | 'voided' | 'returned'>('all');
  const [hasDue, setHasDue] = useState(false);
  const [loading, setLoading] = useState(true);

  const [detail, setDetail] = useState<Sale | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [returning, setReturning] = useState<Sale | null>(null);
  const [methods, setMethods] = useState<any[]>([]);
  const [collectOpen, setCollectOpen] = useState(false);

  useShopRefresh('sales', () => void load());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await call<{ rows: Sale[]; total: number }>('sales.list', {
        search: search.trim() || undefined,
        from,
        to,
        status,
        hasDue: hasDue || undefined,
        page,
        pageSize: PAGE,
      });
      setRows(res.rows);
      setTotal(res.total);
    } catch (err) {
      ui.error('সেলস লোড ব্যর্থ', (err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [search, from, to, status, hasDue, page, ui]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    call<any[]>('settings.paymentMethods').then(setMethods).catch(() => setMethods([]));
  }, []);

  const openDetail = async (row: Sale) => {
    try {
      setDetail(await call<Sale | null>('sales.get', row.id));
    } catch (err) {
      ui.error('ইনভয়েস লোড ব্যর্থ', (err as Error).message);
    }
  };

  const showReceipt = async (sale: Sale, duplicate = false) => {
    try {
      setReceipt(await call<string>('print.receiptHtml', sale.id, { duplicate }));
    } catch (err) {
      ui.error('রিসিট তৈরি ব্যর্থ', (err as Error).message);
    }
  };

  const print = async (sale: Sale, duplicate = false) => {
    try {
      const res = await call<any>('print.print', sale.id, { duplicate });
      ui.success('প্রিন্ট হয়েছে', res?.printer);
    } catch (err) {
      ui.error('প্রিন্ট ব্যর্থ', (err as Error).message);
    }
  };

  const voidSale = async (sale: Sale) => {
    const res = await ui.confirm({
      title: 'ইনভয়েস বাতিল',
      message: `ইনভয়েস ${sale.invoice_no} (${money(sale.total_paisa)}) বাতিল করবেন?`,
      detail:
        'স্টক ফেরত যাবে, আদায় করা টাকা ফেরত হিসাবে দেখাবে এবং কাস্টমারের বাকি সমন্বয় হবে। ইনভয়েসটি মুছে যাবে না — অডিট লগে সংরক্ষিত থাকবে।',
      danger: true,
      requireReason: true,
      reasonLabel: 'বাতিলের কারণ',
      confirmLabel: 'বাতিল করুন',
    });
    if (!res.ok) return;
    try {
      await call('sales.void', sale.id, res.reason);
      ui.success('ইনভয়েস বাতিল হয়েছে', sale.invoice_no);
      setDetail(null);
      await load();
    } catch (err) {
      ui.error('বাতিল করা যায়নি', (err as Error).message);
    }
  };

  return (
    <>
      <PageHead
        title="সেলস ও ইনভয়েস"
        sub="সব বিক্রয়ের পূর্ণ রেকর্ড — প্রিন্ট, রিটার্ন ও বাতিল"
        actions={
          can('pos.sell') ? (
            <Button variant="primary" icon="pos" onClick={() => navigate('pos')}>
              নতুন বিক্রয়
            </Button>
          ) : null
        }
      />

      <Card>
        <div className="toolbar">
          <div className="global-search" style={{ maxWidth: 250 }}>
            <span className="search-icon">
              <Icon name="search" size={16} />
            </span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ইনভয়েস নম্বর বা কাস্টমার"
              onKeyDown={(e) => e.key === 'Enter' && void load()}
            />
          </div>
          <TextInput value={from} onChange={setFrom} type="date" />
          <TextInput value={to} onChange={setTo} type="date" />
          <Select
            value={status}
            onChange={(v) => setStatus(v as any)}
            options={[
              { value: 'all', label: 'সব ইনভয়েস' },
              { value: 'completed', label: 'সম্পন্ন' },
              { value: 'returned', label: 'রিটার্ন হয়েছে' },
              { value: 'voided', label: 'বাতিল' },
            ]}
          />
          <Button
            size="sm"
            variant={hasDue ? 'warn' : 'default'}
            icon="wallet"
            onClick={() => {
              setHasDue((v) => !v);
              setPage(1);
            }}
          >
            শুধু বাকি
          </Button>
          <span className="grow" />
          <span className="small muted">মোট {total} টি</span>
        </div>

        {loading ? (
          <Loading />
        ) : (
          <>
            <DataTable
              rows={rows}
              rowKey={(r) => r.id}
              onRowClick={openDetail}
              empty={<EmptyState icon="cart" title="কোনো ইনভয়েস নেই" message="নির্বাচিত সময়ে কোনো বিক্রয় হয়নি।" />}
              columns={[
                {
                  key: 'invoice_no',
                  label: 'ইনভয়েস',
                  render: (r) => (
                    <div>
                      <div className="bold mono">{r.invoice_no}</div>
                      <div className="tiny muted">{dateTime(r.sale_date)}</div>
                    </div>
                  ),
                },
                {
                  key: 'customer_name',
                  label: 'কাস্টমার',
                  render: (r) => (
                    <div>
                      <div>{r.customer_name || 'ওয়াক-ইন'}</div>
                      <div className="tiny muted">{r.cashier_name ?? ''}</div>
                    </div>
                  ),
                },
                { key: 'total_paisa', label: 'মোট', align: 'right', render: (r) => <span className="num bold">{money(r.total_paisa)}</span> },
                { key: 'paid_paisa', label: 'পরিশোধ', align: 'right', render: (r) => <span className="num">{money(r.paid_paisa)}</span> },
                {
                  key: 'due_paisa',
                  label: 'বাকি',
                  align: 'right',
                  render: (r) => <span className={`num ${r.due_paisa > 0 ? 'warn-text bold' : 'muted'}`}>{money(r.due_paisa)}</span>,
                },
                {
                  key: 'profit_paisa',
                  label: 'প্রফিট',
                  align: 'right',
                  render: (r) => (
                    <span className={`num ${r.status === 'voided' ? 'muted' : r.profit_paisa >= 0 ? 'success-text' : 'danger-text'}`}>
                      {money(r.profit_paisa)}
                    </span>
                  ),
                },
                {
                  key: 'status',
                  label: 'অবস্থা',
                  render: (r) =>
                    r.status === 'voided' ? (
                      <Badge tone="red">বাতিল</Badge>
                    ) : r.status === 'returned' ? (
                      <Badge tone="amber">রিটার্ন</Badge>
                    ) : (
                      <Badge tone="green">সম্পন্ন</Badge>
                    ),
                },
                {
                  key: 'act',
                  label: '',
                  align: 'right',
                  width: 70,
                  render: (r) => <IconButton icon="print" title="রিসিট" onClick={() => void showReceipt(r)} />,
                },
              ]}
            />
            <Pagination page={page} pageSize={PAGE} total={total} onPage={setPage} />
          </>
        )}
      </Card>

      {detail ? (
        <Modal
          title={`ইনভয়েস ${detail.invoice_no}`}
          sub={`${detail.customer_name || 'ওয়াক-ইন'} • ${dateTime(detail.sale_date)} • ক্যাশিয়ার ${detail.cashier_name ?? '—'}`}
          size="lg"
          onClose={() => setDetail(null)}
          footer={
            <>
              <Button onClick={() => setDetail(null)}>বন্ধ</Button>
              <Button icon="eye" onClick={() => void showReceipt(detail)}>
                রিসিট দেখুন
              </Button>
              <Button icon="print" onClick={() => void print(detail)}>
                প্রিন্ট
              </Button>
              <Button icon="print" onClick={() => void print(detail, true)}>
                ডুপ্লিকেট কপি
              </Button>
              {detail.due_paisa > 0 && detail.customer_id ? (
                <Button variant="accent" icon="wallet" onClick={() => setCollectOpen(true)}>
                  বাকি আদায়
                </Button>
              ) : null}
              {can('return.manage') && detail.status === 'completed' ? (
                <Button icon="return" onClick={() => setReturning(detail)}>
                  রিটার্ন
                </Button>
              ) : null}
              {detail.status === 'completed' ? (
                <Button variant="danger" icon="trash" onClick={() => void voidSale(detail)}>
                  বাতিল
                </Button>
              ) : null}
            </>
          }
        >
          <div className="row" style={{ gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
            <Badge tone={detail.status === 'voided' ? 'red' : detail.status === 'returned' ? 'amber' : 'green'}>
              {detail.status === 'voided' ? 'বাতিল হয়েছে' : detail.status === 'returned' ? 'আংশিক রিটার্ন' : 'সম্পন্ন'}
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
                    {r.returned_qty_milli ? <span className="tiny muted"> (ফেরত {qty(r.returned_qty_milli)})</span> : null}
                  </span>
                ),
              },
              { key: 'unit_price_paisa', label: 'দর', align: 'right', render: (r: any) => <span className="num">{money(r.unit_price_paisa)}</span> },
              { key: 'discount_paisa', label: 'ছাড়', align: 'right', render: (r: any) => <span className="num">{money(r.discount_paisa)}</span> },
              { key: 'line_total_paisa', label: 'মোট', align: 'right', render: (r: any) => <span className="num bold">{money(r.line_total_paisa)}</span> },
            ]}
          />
          <div className="col" style={{ marginTop: 12, gap: 4 }}>
            <SumRow label="সাবটোটাল" value={money(detail.subtotal_paisa)} />
            <SumRow label="ডিসকাউন্ট" value={`−${money(detail.discount_paisa)}`} />
            {detail.tax_paisa ? <SumRow label="ভ্যাট" value={money(detail.tax_paisa)} /> : null}
            <SumRow label="সর্বমোট" value={money(detail.total_paisa)} strong />
            <SumRow label="পরিশোধিত" value={money(detail.paid_paisa)} />
            {detail.change_paisa ? <SumRow label="ফেরত দেওয়া" value={money(detail.change_paisa)} /> : null}
            <SumRow label="বাকি" value={money(detail.due_paisa)} strong />
            <SumRow label="প্রফিট" value={money(detail.profit_paisa)} />
          </div>
        </Modal>
      ) : null}

      {receipt ? (
        <Modal
          title="রিসিট প্রিভিউ"
          sub={settings ? `${settings.receipt_width} মিমি থার্মাল` : undefined}
          onClose={() => setReceipt(null)}
          footer={
            <>
              <Button onClick={() => setReceipt(null)}>বন্ধ</Button>
              {detail ? (
                <Button variant="primary" icon="print" onClick={() => void print(detail)}>
                  প্রিন্ট করুন
                </Button>
              ) : null}
            </>
          }
        >
          <div className="receipt-frame">
            <iframe title="রিসিট প্রিভিউ" srcDoc={receipt} />
          </div>
        </Modal>
      ) : null}

      {returning ? (
        <SaleReturnModal
          sale={returning}
          onClose={() => setReturning(null)}
          onDone={() => {
            setReturning(null);
            setDetail(null);
            void load();
          }}
        />
      ) : null}

      {collectOpen && detail ? (
        <CollectDueModal
          sale={detail}
          methods={methods}
          onClose={() => setCollectOpen(false)}
          onDone={() => {
            setCollectOpen(false);
            setDetail(null);
            void load();
          }}
        />
      ) : null}
    </>
  );
}

function SumRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="row" style={{ justifyContent: 'flex-end', gap: 24 }}>
      <span className={strong ? 'bold' : 'muted small'}>{label}</span>
      <span className={`num ${strong ? 'bold' : ''}`} style={{ minWidth: 110, textAlign: 'right' }}>
        {value}
      </span>
    </div>
  );
}

function CollectDueModal({
  sale,
  methods,
  onClose,
  onDone,
}: {
  sale: Sale;
  methods: { id: number; name: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const ui = useUI();
  const [amount, setAmount] = useState(sale.due_paisa);
  const [methodId, setMethodId] = useState<number | ''>(methods[0]?.id ?? '');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!sale.customer_id) return;
    if (amount <= 0) {
      ui.error('টাকার পরিমাণ দিন');
      return;
    }
    if (!methodId) {
      ui.error('পেমেন্ট মাধ্যম নির্বাচন করুন');
      return;
    }
    setBusy(true);
    try {
      const res = await call<{ newBalance: number }>('customers.receivePayment', {
        customerId: sale.customer_id,
        amount,
        methodId,
        reference: reference || null,
        note: `ইনভয়েস ${sale.invoice_no} এর বাকি`,
      });
      ui.success('আদায় সম্পন্ন', `কাস্টমারের বর্তমান বাকি ${money(res.newBalance)}`);
      onDone();
    } catch (err) {
      ui.error('আদায় ব্যর্থ', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="বাকি আদায়"
      sub={`${sale.customer_name ?? ''} • ইনভয়েস ${sale.invoice_no}`}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>বাতিল</Button>
          <Button variant="primary" loading={busy} onClick={submit} icon="check">
            আদায় করুন
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="টাকার পরিমাণ" span={2}>
          <MoneyInput value={amount} onChange={setAmount} autoFocus />
        </Field>
        <Field label="পেমেন্ট মাধ্যম" span={2}>
          <Select value={methodId} onChange={(v) => setMethodId(Number(v))} options={methods.map((m) => ({ value: m.id, label: m.name }))} />
        </Field>
        <Field label="রেফারেন্স (ঐচ্ছিক)" span={2}>
          <TextInput value={reference} onChange={setReference} />
        </Field>
      </div>
    </Modal>
  );
}
