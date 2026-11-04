import { useEffect, useMemo, useState } from 'react';
import { call } from '../api.js';
import { money, today, addDays } from '../format.js';
import { Icon } from '../icons.js';
import {
  Badge,
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
  Select,
  Tabs,
  TextInput,
  useUI,
} from '../ui.js';

type Tab = 'overview' | 'trial' | 'pl' | 'bs' | 'ledger' | 'journal' | 'daybook' | 'cashbook' | 'reconcile' | 'coa';

interface Account {
  id: number;
  code: string;
  name: string;
  name_bn: string | null;
  type: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
  is_cash: number;
  is_bank: number;
  is_system: number;
  is_active: number;
}

const TYPE_LABEL: Record<string, string> = {
  asset: 'সম্পদ',
  liability: 'দায়',
  equity: 'মূলধন',
  income: 'আয়',
  expense: 'ব্যয়',
};

export function AccountingPage({ can }: { can: (perm?: string) => boolean }) {
  const ui = useUI();
  const [tab, setTab] = useState<Tab>('overview');
  const [from, setFrom] = useState(addDays(today(), -30));
  const [to, setTo] = useState(today());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [trial, setTrial] = useState<any>(null);
  const [pl, setPl] = useState<any>(null);
  const [bs, setBs] = useState<any>(null);
  const [journal, setJournal] = useState<any[]>([]);
  const [ledgerAccount, setLedgerAccount] = useState<number | ''>('');
  const [ledger, setLedger] = useState<any>(null);
  const [dayBook, setDayBook] = useState<any>(null);
  const [dayDate, setDayDate] = useState(today());
  const [cashBook, setCashBook] = useState<any>(null);
  const [recon, setRecon] = useState<any[]>([]);
  const [unbalanced, setUnbalanced] = useState<any[]>([]);

  const [voucherOpen, setVoucherOpen] = useState(false);
  const [voucherMemo, setVoucherMemo] = useState('');
  const [voucherDate, setVoucherDate] = useState(today());
  const [voucherLines, setVoucherLines] = useState<{ accountId: number | ''; debit: number; credit: number }[]>([
    { accountId: '', debit: 0, credit: 0 },
    { accountId: '', debit: 0, credit: 0 },
  ]);
  const [saving, setSaving] = useState(false);

  const canManage = can('accounting.manage');

  const loadAccounts = async () => {
    try {
      setAccounts(await call<Account[]>('accounting.accounts'));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    void loadAccounts();
  }, []);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      if (tab === 'overview' || tab === 'reconcile') {
        const [r, u] = await Promise.all([
          call<any[]>('accounting.reconcile', from, to),
          call<any[]>('accounting.unbalanced'),
        ]);
        setRecon(r);
        setUnbalanced(u);
      }
      if (tab === 'overview' || tab === 'trial') setTrial(await call<any>('accounting.trialBalance', from, to));
      if (tab === 'overview' || tab === 'pl') setPl(await call<any>('accounting.profitAndLoss', from, to));
      if (tab === 'overview' || tab === 'bs') setBs(await call<any>('accounting.balanceSheet', to));
      if (tab === 'journal') setJournal((await call<any>('accounting.journal', { from, to, limit: 300 })).rows ?? []);
      if (tab === 'ledger' && ledgerAccount) setLedger(await call<any>('accounting.ledger', Number(ledgerAccount), from, to));
      if (tab === 'daybook') setDayBook(await call<any>('accounting.dayBook', dayDate));
      if (tab === 'cashbook') setCashBook(await call<any>('accounting.cashBook', from, to));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, from, to, ledgerAccount, dayDate]);

  const voucherTotals = useMemo(() => {
    const debit = voucherLines.reduce((s, l) => s + Math.round(l.debit || 0), 0);
    const credit = voucherLines.reduce((s, l) => s + Math.round(l.credit || 0), 0);
    return { debit, credit, balanced: debit === credit && debit > 0 };
  }, [voucherLines]);

  const submitVoucher = async () => {
    if (!voucherTotals.balanced) return;
    setSaving(true);
    try {
      const entry = await call<any>('accounting.manualEntry', {
        date: voucherDate,
        memo: voucherMemo,
        lines: voucherLines
          .filter((l) => l.accountId && (l.debit > 0 || l.credit > 0))
          .map((l) => ({ accountId: Number(l.accountId), debit: Math.round(l.debit), credit: Math.round(l.credit) })),
      });
      ui.success('ভাউচার পোস্ট হয়েছে', entry.entry_no);
      setVoucherOpen(false);
      setVoucherMemo('');
      setVoucherLines([
        { accountId: '', debit: 0, credit: 0 },
        { accountId: '', debit: 0, credit: 0 },
      ]);
      await load();
    } catch (err) {
      ui.error('ভাউচার পোস্ট হয়নি', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const accountOptions = accounts
    .filter((a) => a.is_active)
    .map((a) => ({ value: a.id, label: `${a.code} — ${a.name_bn || a.name}` }));

  const dateBar = (
    <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
      <Field label="শুরুর তারিখ">
        <TextInput type="date" value={from} onChange={setFrom} />
      </Field>
      <Field label="শেষ তারিখ">
        <TextInput type="date" value={to} onChange={setTo} />
      </Field>
      <Button icon="refresh" onClick={load} loading={loading}>
        রিফ্রেশ
      </Button>
      {tab === 'daybook' ? (
        <Field label="দিনের তারিখ">
          <TextInput type="date" value={dayDate} onChange={setDayDate} />
        </Field>
      ) : null}
      <span className="grow" />
      {canManage ? (
        <Button icon="plus" onClick={() => setVoucherOpen(true)}>
          ম্যানুয়াল ভাউচার
        </Button>
      ) : null}
    </div>
  );

  const renderBody = () => {
    if (loading && !trial && !pl && !bs) return <Loading label="হিসাব লোড হচ্ছে…" />;
    switch (tab) {
      case 'overview':
        return (
          <div className="stack" style={{ gap: 14 }}>
            {recon.length ? (
              <Card><CardHead title="মিলকরণ (লেজার বনাম বাস্তব তথ্য)" />
                <div className="stack" style={{ gap: 6 }}>
                  {recon.map((r, i) => (
                    <div key={i} className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                      <span className="row" style={{ gap: 6 }}>
                        <Icon name={r.ok ? 'check' : 'warning'} size={15} style={{ color: r.ok ? 'var(--ok-600)' : 'var(--warn-600)' }} />
                        {r.check}
                      </span>
                      <span className="num small">
                        {money(r.ledger)} / {money(r.operational)}
                        {r.ok ? '' : ` (পার্থক্য ${money(r.difference)})`}
                      </span>
                    </div>
                  ))}
                </div>
              </Card>
            ) : null}
            {unbalanced.length ? (
              <Banner tone="warn">
                <b>অসামঞ্জস্যপূর্ণ এন্ট্রি:</b> {unbalanced.length} টি জার্নাল এন্ট্রিতে ডেবিট ও ক্রেডিট মিলছে না।
              </Banner>
            ) : (
              <Banner tone="success">
                প্রতিটি জার্নাল এন্ট্রিতে ডেবিট = ক্রেডিট — সব এন্ট্রি সমন্বিত।
              </Banner>
            )}
            <div className="grid-2">
              <Card><CardHead title="লাভ-ক্ষতি (সারসংক্ষেপ)" />
                {pl ? (
                  <div className="stack" style={{ gap: 4 }}>
                    <Row label="আয়" value={money(pl.income)} />
                    <Row label="বিক্রীত পণ্যের ক্রয়মূল্য" value={money(pl.cogs)} />
                    <Row label="পরিচালন ব্যয়" value={money(pl.expense)} />
                    <Row label="নিট লাভ" value={money(pl.netProfit)} bold />
                  </div>
                ) : (
                  <span className="muted small">লোড হচ্ছে…</span>
                )}
              </Card>
              <Card><CardHead title="ব্যালান্স শিট (সারসংক্ষেপ)" />
                {bs ? (
                  <div className="stack" style={{ gap: 4 }}>
                    <Row label="মোট সম্পদ" value={money(bs.totalAssets)} />
                    <Row label="মোট দায়" value={money(bs.totalLiabilities)} />
                    <Row label="মোট মূলধন" value={money(bs.totalEquity)} />
                    <Row label={bs.balanced ? 'সমন্বিত ✓' : 'অসামঞ্জস্য!'} value={`${money(bs.totalLiabilities + bs.totalEquity)}`} bold />
                  </div>
                ) : (
                  <span className="muted small">লোড হচ্ছে…</span>
                )}
              </Card>
            </div>
          </div>
        );
      case 'trial':
        return trial ? (
          <DataTable
            columns={[
              { key: 'code', label: 'কোড' },
              { key: 'name', label: 'খাত' },
              { key: 'debit', label: 'ডেবিট', align: 'right', render: (r: any) => money(r.debit) },
              { key: 'credit', label: 'ক্রেডিট', align: 'right', render: (r: any) => money(r.credit) },
            ]}
            rows={trial.rows ?? []}
            empty="কোনো এন্ট্রি নেই"
          />
        ) : null;
      case 'pl':
        return pl ? (
          <div className="stack" style={{ gap: 8 }}>
            {[
              ['আয়', pl.incomeRows],
              ['বিক্রীত পণ্যের ক্রয়মূল্য', pl.cogsRows],
              ['পরিচালন ব্যয়', pl.expenseRows],
            ].map(([label, rows]: any) => (
              <Card key={label}><CardHead title={label} />
                {rows?.length ? (
                  <div className="stack" style={{ gap: 3 }}>
                    {rows.map((r: any) => (
                      <Row key={r.code} label={`${r.code} — ${r.name}`} value={money(r.amount)} />
                    ))}
                  </div>
                ) : (
                  <span className="muted small">এই সময়ে কোনো এন্ট্রি নেই</span>
                )}
              </Card>
            ))}
            <Card><CardHead title="ফলাফল" />
              <Row label="মোট আয়" value={money(pl.income)} />
              <Row label="মোট ব্যয়" value={money(pl.cogs + pl.expense)} />
              <Row label="নিট লাভ / (ক্ষতি)" value={money(pl.netProfit)} bold />
            </Card>
          </div>
        ) : null;
      case 'bs':
        return bs ? (
          <div className="stack" style={{ gap: 8 }}>
            {[
              ['সম্পদ', bs.assets],
              ['দায়', bs.liabilities],
              ['মূলধন', bs.equity],
            ].map(([label, rows]: any) => (
              <Card key={label}><CardHead title={label} />
                {rows?.length ? (
                  <div className="stack" style={{ gap: 3 }}>
                    {rows.map((r: any) => (
                      <Row key={r.code} label={`${r.code} — ${r.name}`} value={money(r.amount)} />
                    ))}
                  </div>
                ) : (
                  <span className="muted small">কোনো ব্যালান্স নেই</span>
                )}
              </Card>
            ))}
            <Banner tone={bs.balanced ? 'success' : 'warn'}>
              {bs.balanced ? 'ব্যালান্স শিট সমন্বিত — ' : 'ব্যালান্স শিটে পার্থক্য আছে — '}
              সম্পদ {money(bs.totalAssets)} • দায় + মূলধন {money(bs.totalLiabilities + bs.totalEquity)}
            </Banner>
          </div>
        ) : null;
      case 'ledger':
        return (
          <div className="stack" style={{ gap: 10 }}>
            <Field label="হিসাব খাত">
              <Select
                value={ledgerAccount}
                onChange={(v) => setLedgerAccount(v ? Number(v) : '')}
                options={accountOptions}
                placeholder="খাত নির্বাচন করুন"
              />
            </Field>
            {ledger ? (
              <>
                <div className="row" style={{ gap: 20 }}>
                  <span className="small muted">প্রারম্ভিক: <b className="num">{money(ledger.opening)}</b></span>
                  <span className="small muted">সমাপনী: <b className="num">{money(ledger.closing)}</b></span>
                </div>
                <DataTable
                  columns={[
                    { key: 'entry_date', label: 'তারিখ' },
                    { key: 'entry_no', label: 'ভাউচার' },
                    { key: 'memo', label: 'বিবরণ' },
                    { key: 'debit', label: 'ডেবিট', align: 'right', render: (r: any) => (r.debit ? money(r.debit) : '—') },
                    { key: 'credit', label: 'ক্রেডিট', align: 'right', render: (r: any) => (r.credit ? money(r.credit) : '—') },
                    { key: 'balance', label: 'ব্যালান্স', align: 'right', render: (r: any) => money(r.balance) },
                  ]}
                  rows={ledger.rows ?? []}
                  empty="এই খাতে কোনো লেনদেন নেই"
                />
              </>
            ) : (
              <span className="muted small">খাত নির্বাচন করুন।</span>
            )}
          </div>
        );
      case 'journal':
        return (
          <DataTable
            columns={[
              { key: 'entry_date', label: 'তারিখ' },
              { key: 'entry_no', label: 'এন্ট্রি' },
              { key: 'source', label: 'উৎস' },
              { key: 'memo', label: 'বিবরণ' },
              { key: 'amount', label: 'অঙ্ক', align: 'right', render: (r: any) => money(r.amount) },
            ]}
            rows={journal}
            empty="এই সময়ে কোনো জার্নাল নেই"
          />
        );
      case 'daybook':
        return dayBook ? (
          <DataTable
            columns={[
              { key: 'entry_no', label: 'এন্ট্রি' },
              { key: 'source', label: 'উৎস' },
              { key: 'memo', label: 'বিবরণ' },
              { key: 'debit', label: 'ডেবিট', align: 'right', render: (r: any) => money(r.debit) },
              { key: 'credit', label: 'ক্রেডিট', align: 'right', render: (r: any) => money(r.credit) },
            ]}
            rows={dayBook.rows ?? dayBook ?? []}
            empty="এই দিনে কোনো এন্ট্রি নেই"
          />
        ) : null;
      case 'cashbook':
        return cashBook ? (
          <div className="stack" style={{ gap: 8 }}>
            <div className="row" style={{ gap: 20 }}>
              <span className="small muted">প্রারম্ভিক নগদ: <b className="num">{money(cashBook.opening)}</b></span>
              <span className="small muted">সমাপনী নগদ: <b className="num">{money(cashBook.closing)}</b></span>
            </div>
            <DataTable
              columns={[
                { key: 'entry_date', label: 'তারিখ' },
                { key: 'entry_no', label: 'ভাউচার' },
                { key: 'memo', label: 'বিবরণ' },
                { key: 'receipt', label: 'জমা', align: 'right', render: (r: any) => (r.debit ? money(r.debit) : '—') },
                { key: 'payment', label: 'খরচ', align: 'right', render: (r: any) => (r.credit ? money(r.credit) : '—') },
              ]}
              rows={cashBook.rows ?? []}
              empty="এই সময়ে নগদ লেনদেন নেই"
            />
          </div>
        ) : null;
      case 'reconcile':
        return (
          <div className="stack" style={{ gap: 8 }}>
            {recon.map((r, i) => (
              <Card key={i}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="row" style={{ gap: 6 }}>
                    <Badge tone={r.ok ? 'green' : 'red'}>{r.ok ? 'মিলেছে' : 'পার্থক্য'}</Badge>
                    {r.check}
                  </span>
                  <span className="num small">
                    লেজার {money(r.ledger)} • বাস্তব {money(r.operational)} • পার্থক্য {money(r.difference)}
                  </span>
                </div>
              </Card>
            ))}
            {unbalanced.length ? (
              <Card><CardHead title="অসামঞ্জস্যপূর্ণ এন্ট্রি" />
                {unbalanced.map((u) => (
                  <Row key={u.entry_id} label={`${u.entry_no}`} value={`ডেবিট ${money(u.debit)} / ক্রেডিট ${money(u.credit)}`} />
                ))}
              </Card>
            ) : null}
          </div>
        );
      case 'coa':
        return (
          <DataTable
            columns={[
              { key: 'code', label: 'কোড' },
              { key: 'name', label: 'খাত (বাংলা)' },
              { key: 'type', label: 'ধরন', render: (r: Account) => TYPE_LABEL[r.type] ?? r.type },
              { key: 'is_system', label: 'সিস্টেম', render: (r: Account) => (r.is_system ? 'হ্যাঁ' : 'না') },
              { key: 'is_active', label: 'সক্রিয়', render: (r: Account) => (r.is_active ? 'হ্যাঁ' : 'না') },
            ]}
            rows={accounts}
            empty="কোনো খাত নেই"
          />
        );
      default:
        return <EmptyState title="কিছু নেই" />;
    }
  };

  return (
    <>
      <PageHead
        title="হিসাব ও ব্যালান্স (ডাবল-এন্ট্রি)"
        sub="বিক্রয়, ক্রয়, পেমেন্ট, রিটার্ন ও খরচ স্বয়ংক্রিয়ভাবে জার্নালে পোস্ট হয় — কোনো এন্ট্রি এডিট বা ডিলিট হয় না, ভুল হলে রিভার্সাল হয়।"
        actions={
          <Badge tone="blue">
            <Icon name="lock" size={12} /> অডিট-সুরক্ষিত
          </Badge>
        }
      />
      <Tabs
        active={tab}
        onChange={(v) => setTab(v as Tab)}
        tabs={[
          { id: 'overview', label: 'সারসংক্ষেপ' },
          { id: 'trial', label: 'ট্রায়াল ব্যালান্স' },
          { id: 'pl', label: 'লাভ-ক্ষতি' },
          { id: 'bs', label: 'ব্যালান্স শিট' },
          { id: 'ledger', label: 'খতিয়ান' },
          { id: 'journal', label: 'জার্নাল' },
          { id: 'daybook', label: 'দিনের বই' },
          { id: 'cashbook', label: 'ক্যাশ বই' },
          { id: 'reconcile', label: 'মিলকরণ' },
          { id: 'coa', label: 'হিসাবের ছক' },
        ]}
      />
      <div className="stack" style={{ gap: 12 }}>
        {tab !== 'coa' ? dateBar : null}
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {renderBody()}
      </div>

      {voucherOpen ? (
        <Modal
          title="ম্যানুয়াল জার্নাল ভাউচার"
          sub="ডেবিট ও ক্রেডিট সমান হতে হবে; পোস্টের পর এন্ট্রি বদলানো যাবে না"
          size="lg"
          onClose={() => setVoucherOpen(false)}
          footer={
            <>
              <Button onClick={() => setVoucherOpen(false)}>বাতিল</Button>
              <Button variant="primary" icon="check" disabled={!voucherTotals.balanced || !voucherMemo.trim()} loading={saving} onClick={submitVoucher}>
                পোস্ট করুন
              </Button>
            </>
          }
        >
          <div className="form-grid">
            <Field label="তারিখ">
              <TextInput type="date" value={voucherDate} onChange={setVoucherDate} />
            </Field>
            <Field label="বিবরণ" span={2}>
              <TextInput value={voucherMemo} onChange={setVoucherMemo} placeholder="যেমন: মালিকের মূলধন জমা" />
            </Field>
            <div className="span-2">
              {voucherLines.map((l, idx) => (
                <div key={idx} className="row" style={{ gap: 6, marginBottom: 6, alignItems: 'flex-end' }}>
                  <div style={{ flex: 2 }}>
                    <Select
                      value={l.accountId}
                      onChange={(v) =>
                        setVoucherLines((prev) => prev.map((x, i) => (i === idx ? { ...x, accountId: v ? Number(v) : '' } : x)))
                      }
                      options={accountOptions}
                      placeholder="হিসাব খাত"
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <MoneyInput
                      value={l.debit}
                      onChange={(debit) => setVoucherLines((prev) => prev.map((x, i) => (i === idx ? { ...x, debit, credit: 0 } : x)))}
                    />
                  </div>
                  <span className="tiny muted">ডেবিট</span>
                  <div style={{ flex: 1 }}>
                    <MoneyInput
                      value={l.credit}
                      onChange={(credit) => setVoucherLines((prev) => prev.map((x, i) => (i === idx ? { ...x, credit, debit: 0 } : x)))}
                    />
                  </div>
                  <span className="tiny muted">ক্রেডিট</span>
                </div>
              ))}
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <Button size="sm" variant="ghost" onClick={() => setVoucherLines((prev) => [...prev, { accountId: '', debit: 0, credit: 0 }])}>
                  + লাইন
                </Button>
                <span className={`small ${voucherTotals.balanced ? 'muted' : 'warn-text'}`}>
                  ডেবিট {money(voucherTotals.debit)} / ক্রেডিট {money(voucherTotals.credit)}
                </span>
              </div>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="row" style={{ justifyContent: 'space-between', gap: 10 }}>
      <span className={bold ? 'bold' : 'muted small'}>{label}</span>
      <span className={`num ${bold ? 'bold' : ''}`}>{value}</span>
    </div>
  );
}
