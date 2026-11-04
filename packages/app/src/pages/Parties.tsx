import { useEffect, useState } from 'react';
import { call } from '../api.js';
import { money, dateShort, dateTime, today, addDays } from '../format.js';
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
  IconButton,
  Loading,
  Modal,
  MoneyInput,
  PageHead,
  Pagination,
  Select,
  Switch,
  Tabs,
  TextInput,
  useUI,
} from '../ui.js';
import type { AppSettings, Customer, Supplier } from '../types.js';

const PAGE = 25;

/* ------------------------------------------------------------------ */
/* Customers                                                           */
/* ------------------------------------------------------------------ */

export function CustomersPage({ can, settings }: { can: (perm?: string) => boolean; settings: AppSettings | null }) {
  const ui = useUI();
  const [rows, setRows] = useState<Customer[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [onlyDue, setOnlyDue] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<{ id: number | null } & Record<string, any> | null>(null);
  const [statement, setStatement] = useState<any | null>(null);
  const [paying, setPaying] = useState<Customer | null>(null);
  const [methods, setMethods] = useState<any[]>([]);
  const [from, setFrom] = useState(addDays(today(), -180));
  const [to, setTo] = useState(today());
  const [profile, setProfile] = useState<Customer | null>(null);
  const [profileLoyalty, setProfileLoyalty] = useState<any>(null);
  const [profileHistory, setProfileHistory] = useState<any[]>([]);
  const [limitInput, setLimitInput] = useState(0);
  const [groupInput, setGroupInput] = useState('');
  const [levelInput, setLevelInput] = useState<'retail' | 'wholesale' | 'special'>('retail');
  const [importing, setImporting] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await call<{ rows: Customer[]; total: number }>('customers.list', {
        search: search.trim() || undefined,
        onlyDue,
        page,
        pageSize: PAGE,
        sort: 'due',
        direction: 'desc',
      });
      setRows(res.rows);
      setTotal(res.total);
    } catch (err) {
      ui.error('কাস্টমার লোড ব্যর্থ', (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, onlyDue, page]);

  useEffect(() => {
    call<any[]>('settings.paymentMethods').then(setMethods).catch(() => setMethods([]));
  }, []);

  const save = async () => {
    if (!editing) return;
    try {
      const payload = {
        name: editing.name,
        phone: editing.phone || null,
        address: editing.address || null,
        openingBalance: editing.openingBalance ?? 0,
        note: editing.note || null,
      };
      if (editing.id) await call('customers.update', editing.id, payload);
      else await call('customers.create', payload);
      ui.success('সংরক্ষিত হয়েছে', editing.name);
      setEditing(null);
      await load();
    } catch (err) {
      ui.error('সংরক্ষণ ব্যর্থ', (err as Error).message);
    }
  };

  const openStatement = async (row: Customer) => {
    try {
      const st = await call<any>('customers.statement', row.id, from, to);
      setStatement(st);
    } catch (err) {
      ui.error('স্টেটমেন্ট লোড ব্যর্থ', (err as Error).message);
    }
  };

  const openProfile = async (row: Customer) => {
    setProfile(row);
    setLimitInput(Math.round(row.credit_limit_paisa ?? 0));
    setGroupInput(row.group_name ?? '');
    setLevelInput(((row as any).price_level as any) ?? 'retail');
    try {
      const [loyalty, history] = await Promise.all([
        call<any>('loyalty.summary', row.id).catch(() => null),
        call<any[]>('loyalty.history', row.id, 100).catch(() => []),
      ]);
      setProfileLoyalty(loyalty);
      setProfileHistory(history);
    } catch {
      setProfileLoyalty(null);
      setProfileHistory([]);
    }
  };

  const exportCsv = async () => {
    try {
      const csv = await call<string>('customers.exportCsv');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `customers-${today()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      ui.success('CSV ডাউনলোড হয়েছে');
    } catch (err) {
      ui.error('এক্সপোর্ট ব্যর্থ', (err as Error).message);
    }
  };

  const importCsv = async (file: File) => {
    setImporting(true);
    try {
      const text = await file.text();
      const res = await call<{ created: number; updated: number; skipped: any[] }>('customers.importCsv', text);
      ui.success('ইমপোর্ট সম্পন্ন', `${res.created} নতুন, ${res.updated} হালনাগাদ, ${res.skipped.length} বাদ`);
      await load();
    } catch (err) {
      ui.error('ইমপোর্ট ব্যর্থ', (err as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const dueTotal = rows.reduce((s, r) => s + Math.max(0, r.balance_paisa), 0);

  return (
    <>
      <PageHead
        title="কাস্টমার ও বাকি"
        sub="বাকি খাতা, আদায় ও স্টেটমেন্ট"
        actions={
          can('customer.manage') ? (
            <Button variant="primary" icon="plus" onClick={() => setEditing({ id: null, name: '', phone: '', address: '', openingBalance: 0, note: '' })}>
              নতুন কাস্টমার
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
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="নাম, মোবাইল বা ঠিকানা"
              onKeyDown={(e) => e.key === 'Enter' && void load()}
            />
          </div>
          <Switch checked={onlyDue} onChange={(v) => { setOnlyDue(v); setPage(1); }} label="শুধু বাকিদার" />
          <span className="grow" />
          {can('customer.manage') ? (
            <>
              <Button size="sm" variant="ghost" icon="download" onClick={exportCsv}>
                CSV এক্সপোর্ট
              </Button>
              <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }}>
                <Icon name="upload" size={15} /> {importing ? 'ইমপোর্ট হচ্ছে…' : 'CSV ইমপোর্ট'}
                <input
                  type="file"
                  accept=".csv,text/csv"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void importCsv(file);
                    e.target.value = '';
                  }}
                />
              </label>
            </>
          ) : null}
          <span className="small muted">
            {total} জন • এই পাতায় বাকি <span className="num bold">{money(dueTotal)}</span>
          </span>
        </div>

        {loading ? (
          <Loading />
        ) : (
          <>
            <DataTable
              rows={rows}
              rowKey={(r) => r.id}
              empty={<EmptyState icon="users" title="কোনো কাস্টমার নেই" message="নতুন কাস্টমার যোগ করুন।" />}
              columns={[
                {
                  key: 'name',
                  label: 'কাস্টমার',
                  render: (r) => (
                    <div>
                      <div className="bold">
                        {r.name} {r.is_walkin ? <Badge tone="plain">ওয়াক-ইন</Badge> : null}
                        {r.is_active === 0 ? <Badge tone="red">নিষ্ক্রিয়</Badge> : null}
                      </div>
                      <div className="tiny muted">{r.address || 'ঠিকানা নেই'}</div>
                    </div>
                  ),
                },
                { key: 'phone', label: 'মোবাইল', render: (r) => <span className="mono">{r.phone || '—'}</span> },
                {
                  key: 'group_name',
                  label: 'গ্রুপ',
                  render: (r) => ((r.group_name ?? r.group_name) ? <Badge tone="teal">{(r.group_name ?? r.group_name)}</Badge> : <span className="muted">—</span>),
                },
                {
                  key: 'credit_limit_paisa',
                  label: 'বাকির সীমা',
                  align: 'right',
                  render: (r) => (
                    <span className={`num small ${(r.credit_limit_paisa ?? 0) > 0 && r.balance_paisa > (r.credit_limit_paisa ?? 0) ? 'warn-text' : 'muted'}`}>
                      {(r.credit_limit_paisa ?? 0) > 0 ? money((r.credit_limit_paisa ?? 0)) : 'সীমা নেই'}
                    </span>
                  ),
                },
                {
                  key: 'loyalty_points',
                  label: 'পয়েন্ট',
                  align: 'right',
                  render: (r) => <span className="num small">{r.loyalty_points ?? 0}</span>,
                },
                {
                  key: 'balance_paisa',
                  label: 'বাকি',
                  align: 'right',
                  render: (r) => (
                    <span className={`num bold ${r.balance_paisa > 0 ? 'warn-text' : 'muted'}`}>{money(r.balance_paisa)}</span>
                  ),
                },
                {
                  key: 'act',
                  label: '',
                  align: 'right',
                  width: 150,
                  render: (r) => (
                    <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                      <IconButton icon="user" title="প্রোফাইল ও লয়্যালটি" onClick={() => openProfile(r)} />
                      <IconButton icon="file" title="স্টেটমেন্ট" onClick={() => openStatement(r)} />
                      {!r.is_walkin && can('customer.manage') ? (
                        <Button size="sm" variant="accent" onClick={() => setPaying(r)}>
                          আদায়
                        </Button>
                      ) : null}
                      {can('customer.manage') ? (
                        <IconButton
                          icon="edit"
                          title="সম্পাদনা"
                          onClick={() =>
                            setEditing({
                              id: r.id,
                              name: r.name,
                              phone: r.phone ?? '',
                              address: r.address ?? '',
                              openingBalance: r.opening_balance_paisa,
                              note: r.note ?? '',
                            })
                          }
                        />
                      ) : null}
                    </div>
                  ),
                },
              ]}
            />
            <Pagination page={page} pageSize={PAGE} total={total} onPage={setPage} />
          </>
        )}
      </Card>

      {editing ? (
        <Modal
          title={editing.id ? 'কাস্টমার সম্পাদনা' : 'নতুন কাস্টমার'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button onClick={() => setEditing(null)}>বাতিল</Button>
              <Button variant="primary" onClick={save} icon="check">
                সংরক্ষণ
              </Button>
            </>
          }
        >
          <div className="form-grid">
            <Field label="নাম *" span={2}>
              <TextInput value={editing.name} onChange={(v) => setEditing({ ...editing, name: v })} autoFocus />
            </Field>
            <Field label="মোবাইল">
              <TextInput value={editing.phone} onChange={(v) => setEditing({ ...editing, phone: v })} placeholder="01XXXXXXXXX" />
            </Field>
            <Field label="ওপেনিং বাকি" hint="আগের খাতার বাকি থাকলে">
              <MoneyInput value={editing.openingBalance ?? 0} onChange={(v) => setEditing({ ...editing, openingBalance: v })} disabled={Boolean(editing.id)} />
            </Field>
            <Field label="ঠিকানা" span={2}>
              <TextInput value={editing.address} onChange={(v) => setEditing({ ...editing, address: v })} />
            </Field>
            <Field label="নোট" span={2}>
              <TextInput value={editing.note} onChange={(v) => setEditing({ ...editing, note: v })} />
            </Field>
          </div>
        </Modal>
      ) : null}

      {profile ? (
        <Modal
          title={`প্রোফাইল — ${profile.name}`}
          sub={profile.phone ? `${profile.phone} • বাকি ${money(profile.balance_paisa)}` : `বাকি ${money(profile.balance_paisa)}`}
          size="lg"
          onClose={() => setProfile(null)}
          footer={<Button onClick={() => setProfile(null)}>বন্ধ করুন</Button>}
        >
          <div className="stack" style={{ gap: 14 }}>
            <Card>
              <CardHead title="বাকির সীমা ও গ্রুপ" />
              <div className="form-grid">
                <Field label="বাকির সীমা (০ = সীমা নেই)">
                  <MoneyInput value={limitInput} onChange={setLimitInput} />
                </Field>
                <Field label="কাস্টমার গ্রুপ">
                  <TextInput value={groupInput} onChange={setGroupInput} placeholder="যেমন: পাইকারি" />
                </Field>
                <Field label="দামের স্তর">
                  <Select
                    value={levelInput}
                    onChange={(v) => setLevelInput((v as any) || 'retail')}
                    options={[
                      { value: 'retail', label: 'খুচরা' },
                      { value: 'wholesale', label: 'পাইকারি' },
                      { value: 'special', label: 'বিশেষ' },
                    ]}
                  />
                </Field>
                <div className="row" style={{ alignItems: 'flex-end' }}>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={async () => {
                      try {
                        await call('customers.setCreditLimit', profile.id, limitInput);
                        await call('customers.setGroup', profile.id, groupInput || null);
                        await call('customers.setPriceLevel', profile.id, levelInput);
                        ui.success('সংরক্ষিত হয়েছে');
                        setProfile(null);
                        await load();
                      } catch (err) {
                        ui.error('সংরক্ষণ ব্যর্থ', (err as Error).message);
                      }
                    }}
                  >
                    সংরক্ষণ
                  </Button>
                </div>
              </div>
              {(profile.credit_limit_paisa ?? 0) > 0 ? (
                <div className="tiny muted" style={{ marginTop: 6 }}>
                  সীমা ব্যবহার: {money(Math.max(0, profile.balance_paisa))} / {money((profile.credit_limit_paisa ?? 0))}
                </div>
              ) : null}
            </Card>

            <Card>
              <CardHead
                title="লয়্যালটি"
                sub={
                  profileLoyalty?.enabled === false
                    ? 'লয়্যালটি সুবিধা সেটিংসে বন্ধ আছে'
                    : `পয়েন্ট ${profileLoyalty?.points ?? 0} • মূল্য ${money(profileLoyalty?.valuePaisa ?? 0)}`
                }
                actions={
                  can('loyalty.manage') ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        const points = Number(window.prompt('কত পয়েন্ট সমন্বয় করবেন? (মাইনাস দিলে কমবে)') || 0);
                        if (!points) return;
                        const reason = window.prompt('কারণ লিখুন:') || '';
                        if (!reason.trim()) {
                          ui.error('কারণ দরকার', 'সমন্বয়ের কারণ ছাড়া সংরক্ষণ হবে না।');
                          return;
                        }
                        try {
                          await call('loyalty.adjust', { customerId: profile.id, points, reason });
                          await openProfile(profile);
                          ui.success('পয়েন্ট সমন্বয় হয়েছে');
                        } catch (err) {
                          ui.error('সমন্বয় ব্যর্থ', (err as Error).message);
                        }
                      }}
                    >
                      পয়েন্ট সমন্বয়
                    </Button>
                  ) : null
                }
              />
              {profileHistory.length === 0 ? (
                <span className="small muted">এখনো কোনো পয়েন্ট লেনদেন নেই।</span>
              ) : (
                <DataTable
                  columns={[
                    { key: 'created_at', label: 'সময়', render: (r: any) => dateTime(r.created_at) },
                    {
                      key: 'type',
                      label: 'ধরন',
                      render: (r: any) => (
                        <Badge tone={r.points > 0 ? 'green' : 'amber'}>
                          {r.type === 'earn' ? 'অর্জিত' : r.type === 'redeem' ? 'রিডিম' : r.type === 'reverse' ? 'ফেরত' : r.type === 'expire' ? 'মেয়াদোত্তীর্ণ' : 'সমন্বয়'}
                        </Badge>
                      ),
                    },
                    { key: 'points', label: 'পয়েন্ট', align: 'right', render: (r: any) => <span className="num">{r.points > 0 ? `+${r.points}` : r.points}</span> },
                    { key: 'note', label: 'নোট', render: (r: any) => r.note || '—' },
                  ]}
                  rows={profileHistory}
                  empty="কোনো লেনদেন নেই"
                />
              )}
            </Card>
          </div>
        </Modal>
      ) : null}

      {statement ? (
        <Modal
          title={`স্টেটমেন্ট — ${statement.customer.name}`}
          sub={`${dateShort(from)} থেকে ${dateShort(to)} • সমাপনী বাকি ${money(statement.closing_balance)}`}
          size="xl"
          onClose={() => setStatement(null)}
          footer={<Button onClick={() => setStatement(null)}>বন্ধ</Button>}
        >
          <div className="row" style={{ gap: 8, marginBottom: 10 }}>
            <TextInput value={from} onChange={setFrom} type="date" />
            <TextInput value={to} onChange={setTo} type="date" />
            <Button size="sm" onClick={() => void call<any>('customers.statement', statement.customer.id, from, to).then(setStatement)}>
              রিফ্রেশ
            </Button>
            <span className="grow" />
            <Badge tone="blue">ডেবিট {money(statement.total_debit)}</Badge>
            <Badge tone="green">ক্রেডিট {money(statement.total_credit)}</Badge>
          </div>
          <DataTable
            compact
            maxHeight={400}
            rows={statement.rows}
            rowKey={(r: any, i) => `${r.reference}-${i}`}
            columns={[
              { key: 'date', label: 'তারিখ', render: (r: any) => dateShort(r.date) },
              { key: 'description', label: 'বিবরণ', render: (r: any) => <span className="small">{r.description}</span> },
              { key: 'reference', label: 'রেফারেন্স', render: (r: any) => <span className="mono tiny">{r.reference}</span> },
              { key: 'debit', label: 'ডেবিট', align: 'right', render: (r: any) => <span className="num">{r.debit ? money(r.debit) : '—'}</span> },
              { key: 'credit', label: 'ক্রেডিট', align: 'right', render: (r: any) => <span className="num">{r.credit ? money(r.credit) : '—'}</span> },
              { key: 'balance', label: 'ব্যালেন্স', align: 'right', render: (r: any) => <span className="num bold">{money(r.balance)}</span> },
            ]}
            empty={<EmptyState icon="file" title="এই সময়ে কোনো লেনদেন নেই" />}
          />
        </Modal>
      ) : null}

      {paying ? (
        <PaymentModal
          title="কাস্টমার বাকি আদায়"
          partyName={paying.name}
          currentBalance={paying.balance_paisa}
          methods={methods}
          onClose={() => setPaying(null)}
          onSubmit={async (amount, methodId, reference, note) => {
            const res = await call<{ newBalance: number }>('customers.receivePayment', {
              customerId: paying.id,
              amount,
              methodId,
              reference,
              note,
            });
            ui.success('আদায় সম্পন্ন', `নতুন বাকি ${money(res.newBalance)}`);
            setPaying(null);
            await load();
          }}
        />
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Suppliers                                                           */
/* ------------------------------------------------------------------ */

export function SuppliersPage({ can }: { can: (perm?: string) => boolean }) {
  const ui = useUI();
  const [rows, setRows] = useState<Supplier[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [onlyPayable, setOnlyPayable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<any | null>(null);
  const [statement, setStatement] = useState<any | null>(null);
  const [paying, setPaying] = useState<Supplier | null>(null);
  const [methods, setMethods] = useState<any[]>([]);

  const load = async () => {
    setLoading(true);
    try {
      const res = await call<{ rows: Supplier[]; total: number }>('suppliers.list', {
        search: search.trim() || undefined,
        onlyPayable,
        page,
        pageSize: PAGE,
        sort: 'payable',
        direction: 'desc',
      });
      setRows(res.rows);
      setTotal(res.total);
    } catch (err) {
      ui.error('সাপ্লায়ার লোড ব্যর্থ', (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, onlyPayable, page]);

  useEffect(() => {
    call<any[]>('settings.paymentMethods').then(setMethods).catch(() => setMethods([]));
  }, []);

  const save = async () => {
    if (!editing) return;
    try {
      const payload = {
        name: editing.name,
        company: editing.company || null,
        phone: editing.phone || null,
        email: editing.email || null,
        contactPerson: editing.contactPerson || null,
        address: editing.address || null,
        openingBalance: editing.openingBalance ?? 0,
        note: editing.note || null,
      };
      if (editing.id) await call('suppliers.update', editing.id, payload);
      else await call('suppliers.create', payload);
      ui.success('সংরক্ষিত হয়েছে', editing.name);
      setEditing(null);
      await load();
    } catch (err) {
      ui.error('সংরক্ষণ ব্যর্থ', (err as Error).message);
    }
  };

  const openStatement = async (row: Supplier) => {
    try {
      setStatement(await call<any>('suppliers.statement', row.id));
    } catch (err) {
      ui.error('স্টেটমেন্ট লোড ব্যর্থ', (err as Error).message);
    }
  };

  const payableTotal = rows.reduce((s, r) => s + Math.max(0, r.balance_paisa), 0);

  return (
    <>
      <PageHead
        title="সাপ্লায়ার"
        sub="মাল সরবরাহকারী, পাওনা ও পরিশোধ"
        actions={
          can('supplier.manage') ? (
            <Button
              variant="primary"
              icon="plus"
              onClick={() =>
                setEditing({ id: null, name: '', company: '', phone: '', email: '', contactPerson: '', address: '', openingBalance: 0, note: '' })
              }
            >
              নতুন সাপ্লায়ার
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
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="নাম, প্রতিষ্ঠান বা মোবাইল" />
          </div>
          <Switch checked={onlyPayable} onChange={(v) => { setOnlyPayable(v); setPage(1); }} label="শুধু পাওনা" />
          <span className="grow" />
          <span className="small muted">
            {total} জন • এই পাতায় পাওনা <span className="num bold">{money(payableTotal)}</span>
          </span>
        </div>

        {loading ? (
          <Loading />
        ) : (
          <>
            <DataTable
              rows={rows}
              rowKey={(r) => r.id}
              empty={<EmptyState icon="supplier" title="কোনো সাপ্লায়ার নেই" />}
              columns={[
                {
                  key: 'name',
                  label: 'সাপ্লায়ার',
                  render: (r) => (
                    <div>
                      <div className="bold">{r.name}</div>
                      <div className="tiny muted">{[r.company, r.contact_person].filter(Boolean).join(' • ') || '—'}</div>
                    </div>
                  ),
                },
                { key: 'phone', label: 'মোবাইল', render: (r) => <span className="mono">{r.phone || '—'}</span> },
                {
                  key: 'balance_paisa',
                  label: 'পাওনা',
                  align: 'right',
                  render: (r) => <span className={`num bold ${r.balance_paisa > 0 ? 'danger-text' : 'muted'}`}>{money(r.balance_paisa)}</span>,
                },
                {
                  key: 'act',
                  label: '',
                  align: 'right',
                  width: 150,
                  render: (r) => (
                    <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                      <IconButton icon="file" title="স্টেটমেন্ট" onClick={() => openStatement(r)} />
                      {can('supplier.manage') ? (
                        <>
                          <Button size="sm" variant="accent" onClick={() => setPaying(r)}>
                            পরিশোধ
                          </Button>
                          <IconButton
                            icon="edit"
                            title="সম্পাদনা"
                            onClick={() =>
                              setEditing({
                                id: r.id,
                                name: r.name,
                                company: r.company ?? '',
                                phone: r.phone ?? '',
                                email: r.email ?? '',
                                contactPerson: r.contact_person ?? '',
                                address: r.address ?? '',
                                openingBalance: r.opening_balance_paisa,
                                note: r.note ?? '',
                              })
                            }
                          />
                        </>
                      ) : null}
                    </div>
                  ),
                },
              ]}
            />
            <Pagination page={page} pageSize={PAGE} total={total} onPage={setPage} />
          </>
        )}
      </Card>

      {editing ? (
        <Modal
          title={editing.id ? 'সাপ্লায়ার সম্পাদনা' : 'নতুন সাপ্লায়ার'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button onClick={() => setEditing(null)}>বাতিল</Button>
              <Button variant="primary" onClick={save} icon="check">
                সংরক্ষণ
              </Button>
            </>
          }
        >
          <div className="form-grid">
            <Field label="নাম *" span={2}>
              <TextInput value={editing.name} onChange={(v) => setEditing({ ...editing, name: v })} autoFocus />
            </Field>
            <Field label="প্রতিষ্ঠান">
              <TextInput value={editing.company} onChange={(v) => setEditing({ ...editing, company: v })} />
            </Field>
            <Field label="যোগাযোগ ব্যক্তি">
              <TextInput value={editing.contactPerson} onChange={(v) => setEditing({ ...editing, contactPerson: v })} />
            </Field>
            <Field label="মোবাইল">
              <TextInput value={editing.phone} onChange={(v) => setEditing({ ...editing, phone: v })} />
            </Field>
            <Field label="ইমেইল">
              <TextInput value={editing.email} onChange={(v) => setEditing({ ...editing, email: v })} />
            </Field>
            <Field label="ওপেনিং পাওনা">
              <MoneyInput value={editing.openingBalance ?? 0} onChange={(v) => setEditing({ ...editing, openingBalance: v })} disabled={Boolean(editing.id)} />
            </Field>
            <Field label="ঠিকানা">
              <TextInput value={editing.address} onChange={(v) => setEditing({ ...editing, address: v })} />
            </Field>
          </div>
        </Modal>
      ) : null}

      {statement ? (
        <Modal
          title={`সাপ্লায়ার স্টেটমেন্ট — ${statement.supplier.name}`}
          sub={`কেনা ${money(statement.total_purchase)} • পরিশোধ ${money(statement.total_paid)} • বর্তমান পাওনা ${money(statement.closing_balance)}`}
          size="xl"
          onClose={() => setStatement(null)}
          footer={<Button onClick={() => setStatement(null)}>বন্ধ</Button>}
        >
          <DataTable
            compact
            maxHeight={430}
            rows={statement.rows}
            rowKey={(r: any, i) => `${r.reference}-${i}`}
            columns={[
              { key: 'date', label: 'তারিখ', render: (r: any) => dateShort(r.date) },
              { key: 'description', label: 'বিবরণ', render: (r: any) => <span className="small">{r.description}</span> },
              { key: 'reference', label: 'রেফারেন্স', render: (r: any) => <span className="mono tiny">{r.reference}</span> },
              { key: 'debit', label: 'পরিশোধ', align: 'right', render: (r: any) => <span className="num">{r.debit ? money(r.debit) : '—'}</span> },
              { key: 'credit', label: 'ক্রয়', align: 'right', render: (r: any) => <span className="num">{r.credit ? money(r.credit) : '—'}</span> },
              { key: 'balance', label: 'পাওনা', align: 'right', render: (r: any) => <span className="num bold">{money(r.balance)}</span> },
            ]}
            empty={<EmptyState icon="file" title="কোনো লেনদেন নেই" />}
          />
        </Modal>
      ) : null}

      {paying ? (
        <PaymentModal
          title="সাপ্লায়ারকে পরিশোধ"
          partyName={paying.name}
          currentBalance={paying.balance_paisa}
          methods={methods}
          onClose={() => setPaying(null)}
          onSubmit={async (amount, methodId, reference, note) => {
            const res = await call<{ newBalance: number }>('suppliers.pay', {
              supplierId: paying.id,
              amount,
              methodId,
              reference,
              note,
            });
            ui.success('পরিশোধ সম্পন্ন', `অবশিষ্ট পাওনা ${money(res.newBalance)}`);
            setPaying(null);
            await load();
          }}
        />
      ) : null}
    </>
  );
}

export function PaymentModal({
  title,
  partyName,
  currentBalance,
  methods,
  onClose,
  onSubmit,
}: {
  title: string;
  partyName: string;
  currentBalance: number;
  methods: { id: number; name: string }[];
  onClose: () => void;
  onSubmit: (amount: number, methodId: number, reference: string | null, note: string | null) => Promise<void>;
}) {
  const [amount, setAmount] = useState(Math.max(0, currentBalance));
  const [methodId, setMethodId] = useState<number | ''>(methods[0]?.id ?? '');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (amount <= 0) return setError('টাকার পরিমাণ দিন।');
    if (!methodId) return setError('পেমেন্ট মাধ্যম নির্বাচন করুন।');
    setBusy(true);
    try {
      await onSubmit(amount, Number(methodId), reference || null, note || null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      sub={`${partyName} • বর্তমান ${money(currentBalance)}`}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>বাতিল</Button>
          <Button variant="primary" loading={busy} onClick={submit} icon="check">
            নিশ্চিত করুন
          </Button>
        </>
      }
    >
      {error ? <Banner tone="danger" icon="warning">{error}</Banner> : null}
      <div className="form-grid">
        <Field label="টাকার পরিমাণ" span={2}>
          <MoneyInput value={amount} onChange={setAmount} autoFocus />
        </Field>
        <Field label="মাধ্যম" span={2}>
          <Select value={methodId} onChange={(v) => setMethodId(Number(v))} options={methods.map((m) => ({ value: m.id, label: m.name }))} />
        </Field>
        <Field label="রেফারেন্স" span={2}>
          <TextInput value={reference} onChange={setReference} placeholder="bKash/Nagad TrxID, চেক নম্বর" />
        </Field>
        <Field label="নোট" span={2}>
          <TextInput value={note} onChange={setNote} />
        </Field>
      </div>
    </Modal>
  );
}

export { Tabs, dateTime };
