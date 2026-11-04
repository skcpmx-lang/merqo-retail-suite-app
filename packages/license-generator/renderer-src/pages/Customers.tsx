import { useCallback, useEffect, useState } from 'react';
import { call } from '../api.js';
import { useApp } from '../App.js';
import {
  Banner,
  Button,
  Card,
  Empty,
  Field,
  Input,
  KeyValue,
  Modal,
  PageHead,
  Table,
  TextArea,
  dt,
  useDebounced,
  useUI,
} from '../ui.js';
import type { Customer, LicenseRecord } from '../types.js';

interface Form {
  name: string;
  owner: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  notes: string;
}

const emptyForm: Form = { name: '', owner: '', phone: '', email: '', address: '', city: '', notes: '' };

export function CustomersPage({ initialQ }: { initialQ: string }) {
  const { navigate } = useApp();
  const ui = useUI();
  const [query, setQuery] = useState(initialQ);
  const debounced = useDebounced(query);
  const [rows, setRows] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<Form | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<{ customer: Customer; licenses: LicenseRecord[] } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await call<Customer[]>('customers.list', { q: debounced, activeOnly: false }));
    } catch (err) {
      ui.error('কাস্টমার লোড ব্যর্থ', (err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [debounced, ui]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditingId(null);
    setForm({ ...emptyForm });
  };

  const openEdit = (customer: Customer) => {
    setEditingId(customer.id);
    setForm({
      name: customer.name,
      owner: customer.owner,
      phone: customer.phone,
      email: customer.email,
      address: customer.address,
      city: customer.city,
      notes: customer.notes,
    });
  };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      if (editingId) {
        await call('customers.update', editingId, form);
        ui.success('কাস্টমার হালনাগাদ হয়েছে');
      } else {
        await call('customers.create', form);
        ui.success('কাস্টমার যোগ হয়েছে');
      }
      setForm(null);
      setEditingId(null);
      await load();
    } catch (err) {
      ui.error('সংরক্ষণ ব্যর্থ', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const openDetail = async (customer: Customer) => {
    try {
      setDetail(await call('customers.get', customer.id));
    } catch (err) {
      ui.error('বিস্তারিত লোড ব্যর্থ', (err as Error).message);
    }
  };

  const toggleActive = async (customer: Customer) => {
    const res = await ui.confirm({
      title: customer.is_active ? 'কাস্টমার নিষ্ক্রিয় করবেন?' : 'কাস্টমার সক্রিয় করবেন?',
      message: customer.is_active
        ? 'নিষ্ক্রিয় করলে নতুন লাইসেন্স ইস্যুর তালিকায় দেখাবে না, পুরোনো লাইসেন্স অপরিবর্তিত থাকবে।'
        : 'আবার নতুন লাইসেন্স ইস্যু করা যাবে।',
      confirmLabel: customer.is_active ? 'নিষ্ক্রিয় করুন' : 'সক্রিয় করুন',
    });
    if (!res.ok) return;
    try {
      await call('customers.update', customer.id, { is_active: customer.is_active ? 0 : 1 });
      await load();
    } catch (err) {
      ui.error('ব্যর্থ', (err as Error).message);
    }
  };

  return (
    <>
      <PageHead
        title="কাস্টমার"
        sub="লাইসেন্সধারী প্রতিষ্ঠান — এক কাস্টমারের অধীনে একাধিক লাইসেন্স থাকতে পারে"
        actions={
          <>
            <Button icon="refresh" onClick={() => void load()}>
              রিফ্রেশ
            </Button>
            <Button variant="primary" icon="plus" onClick={openCreate}>
              নতুন কাস্টমার
            </Button>
          </>
        }
      />

      <Card>
        <div className="toolbar">
          <Input value={query} onChange={setQuery} placeholder="নাম, কোড, ফোন বা ইমেইল" />
          <span className="grow" />
          <span className="small muted">{rows.length} কাস্টমার</span>
        </div>
        <Table
          loading={loading}
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => void openDetail(r)}
          empty={
            <Empty
              icon="users"
              title="কোনো কাস্টমার নেই"
              message="প্রথমে প্রতিষ্ঠান নিবন্ধন করুন, তারপর লাইসেন্স ইস্যু করুন।"
              action={<Button variant="primary" icon="plus" onClick={openCreate}>নতুন কাস্টমার</Button>}
            />
          }
          columns={[
            { key: 'code', label: 'কোড', width: 110, render: (r) => <span className="mono">{r.code}</span> },
            {
              key: 'name',
              label: 'প্রতিষ্ঠান',
              render: (r) => (
                <>
                  <div className="bold">{r.name}</div>
                  <div className="tiny muted">{r.city || r.address || '—'}</div>
                </>
              ),
            },
            { key: 'owner', label: 'মালিক', render: (r) => r.owner || '—' },
            { key: 'phone', label: 'ফোন', render: (r) => r.phone || '—' },
            { key: 'license_count', label: 'লাইসেন্স', align: 'right', render: (r) => <span className="num">{r.license_count ?? 0}</span> },
            {
              key: 'active_count',
              label: 'সক্রিয়',
              align: 'right',
              render: (r) => <span className={`pill ${(r.active_count ?? 0) > 0 ? 'green' : 'plain'}`}>{r.active_count ?? 0}</span>,
            },
            {
              key: 'status',
              label: 'অবস্থা',
              render: (r) => <span className={`pill ${r.is_active ? 'green' : 'plain'}`}>{r.is_active ? 'সক্রিয়' : 'নিষ্ক্রিয়'}</span>,
            },
            {
              key: 'actions',
              label: '',
              align: 'right',
              width: 120,
              render: (r) => (
                <div className="row" onClick={(e) => e.stopPropagation()} style={{ justifyContent: 'flex-end' }}>
                  <Button size="sm" variant="ghost" icon="edit" onClick={() => openEdit(r)}>
                    এডিট
                  </Button>
                  <Button size="sm" variant="ghost" icon={r.is_active ? 'lock' : 'check'} onClick={() => void toggleActive(r)} />
                </div>
              ),
            },
          ]}
        />
      </Card>

      {form ? (
        <Modal
          title={editingId ? 'কাস্টমার সম্পাদনা' : 'নতুন কাস্টমার'}
          sub="প্রতিষ্ঠানের তথ্য পরে লাইসেন্সে স্বয়ংক্রিয়ভাবে বসবে"
          onClose={() => setForm(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setForm(null)}>
                বাতিল
              </Button>
              <Button variant="primary" icon="check" loading={saving} onClick={() => void save()}>
                সংরক্ষণ
              </Button>
            </>
          }
        >
          <div className="form-grid">
            <Field label="প্রতিষ্ঠানের নাম *" span={2}>
              <Input value={form.name} onChange={(v) => setForm({ ...form, name: v })} autoFocus placeholder="যেমন: রহিম স্টোর" />
            </Field>
            <Field label="মালিক / যোগাযোগ">
              <Input value={form.owner} onChange={(v) => setForm({ ...form, owner: v })} />
            </Field>
            <Field label="মোবাইল">
              <Input value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} placeholder="01XXXXXXXXX" />
            </Field>
            <Field label="ইমেইল">
              <Input value={form.email} onChange={(v) => setForm({ ...form, email: v })} placeholder="name@example.com" />
            </Field>
            <Field label="শহর">
              <Input value={form.city} onChange={(v) => setForm({ ...form, city: v })} />
            </Field>
            <Field label="ঠিকানা" span={2}>
              <Input value={form.address} onChange={(v) => setForm({ ...form, address: v })} />
            </Field>
            <Field label="প্রশাসনিক নোট" span={2} hint="শুধু আপনি দেখবেন — লাইসেন্সে যায় না">
              <TextArea value={form.notes} onChange={(v) => setForm({ ...form, notes: v })} rows={3} />
            </Field>
          </div>
        </Modal>
      ) : null}

      {detail ? (
        <Modal
          title={detail.customer.name}
          sub={`${detail.customer.code} • ${detail.customer.is_active ? 'সক্রিয়' : 'নিষ্ক্রিয়'}`}
          size="lg"
          onClose={() => setDetail(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDetail(null)}>
                বন্ধ
              </Button>
              <Button icon="edit" onClick={() => { openEdit(detail.customer); setDetail(null); }}>
                সম্পাদনা
              </Button>
              <Button variant="primary" icon="plus" onClick={() => navigate('generate', { customerId: detail.customer.id })}>
                নতুন লাইসেন্স
              </Button>
            </>
          }
        >
          <KeyValue
            items={[
              { label: 'মালিক', value: detail.customer.owner || '—' },
              { label: 'ফোন', value: detail.customer.phone || '—' },
              { label: 'ইমেইল', value: detail.customer.email || '—' },
              { label: 'শহর', value: detail.customer.city || '—' },
              { label: 'ঠিকানা', value: detail.customer.address || '—' },
              { label: 'নিবন্ধিত', value: dt(detail.customer.created_at) },
            ]}
          />
          {detail.customer.notes ? (
            <div style={{ marginTop: 12 }}>
              <Banner tone="info">{detail.customer.notes}</Banner>
            </div>
          ) : null}
          <h4 style={{ margin: '16px 0 8px' }}>লাইসেন্স ইতিহাস</h4>
          <Table
            compact
            rows={detail.licenses}
            rowKey={(r) => r.id}
            empty={<Empty icon="license" title="এই কাস্টমারের কোনো লাইসেন্স নেই" />}
            columns={[
              { key: 'license_id', label: 'লাইসেন্স', render: (r) => <span className="mono tiny">{r.license_id}</span> },
              { key: 'edition', label: 'এডিশন', render: (r) => r.edition },
              { key: 'issued_at', label: 'ইস্যু', render: (r) => dt(r.issued_at) },
              {
                key: 'state',
                label: 'অবস্থা',
                render: (r) => (
                  <span className={`pill ${r.revoked_at ? 'red' : r.superseded_by ? 'plain' : 'green'}`}>
                    {r.revoked_at ? 'প্রত্যাহৃত' : r.superseded_by ? 'প্রতিস্থাপিত' : 'সক্রিয়'}
                  </span>
                ),
              },
            ]}
          />
        </Modal>
      ) : null}
    </>
  );
}
