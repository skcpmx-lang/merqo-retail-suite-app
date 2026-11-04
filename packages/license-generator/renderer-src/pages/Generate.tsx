import { useCallback, useEffect, useMemo, useState } from 'react';
import { call, copyText } from '../api.js';
import { useApp } from '../App.js';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardHead,
  Empty,
  Field,
  Icon,
  Input,
  KeyValue,
  Modal,
  PageHead,
  Select,
  Steps,
  Switch,
  Table,
  TextArea,
  addDaysInput,
  bnNum,
  dt,
  todayInput,
  useDebounced,
  useUI,
} from '../ui.js';
import type { Customer, DeviceRequest, Edition, IssueDraft, LicenseRecord } from '../types.js';
import { emptyDraft } from '../types.js';

const STEP_LABELS = [
  { id: 1, label: 'কাস্টমার' },
  { id: 2, label: 'প্রতিষ্ঠান' },
  { id: 3, label: 'ধরন' },
  { id: 4, label: 'হার্ডওয়্যার' },
  { id: 5, label: 'ফিচার' },
  { id: 6, label: 'কনফিগারেশন' },
  { id: 7, label: 'পর্যালোচনা' },
  { id: 8, label: 'স্বাক্ষর' },
  { id: 9, label: 'যাচাই ও রপ্তানি' },
];

interface IssueResult {
  record: LicenseRecord;
  payload: { license_id: string; expires_at: string | null; max_devices: number; features: string[]; fingerprint: string; edition: string };
  licenseKey: string;
  filePath: string | null;
  check: { activated: boolean; message: string };
}

export function GeneratePage({ presetCustomerId }: { presetCustomerId: string | null }) {
  const { catalog, keyStatus, navigate, refreshInfo } = useApp();
  const ui = useUI();

  const [step, setStep] = useState(1);
  const [maxStep, setMaxStep] = useState(1);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerQuery, setCustomerQuery] = useState('');
  const debouncedQuery = useDebounced(customerQuery);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [newCustomer, setNewCustomer] = useState<{ name: string; owner: string; phone: string; email: string; address: string; city: string } | null>(null);
  const [device, setDevice] = useState<DeviceRequest | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [draft, setDraft] = useState<IssueDraft>(emptyDraft());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<IssueResult | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);

  const loadCustomers = useCallback(async () => {
    try {
      setCustomers(await call<Customer[]>('customers.list', { q: debouncedQuery, activeOnly: true }));
    } catch (err) {
      ui.error('কাস্টমার লোড ব্যর্থ', (err as Error).message);
    }
  }, [debouncedQuery, ui]);

  useEffect(() => {
    void loadCustomers();
  }, [loadCustomers]);

  useEffect(() => {
    if (!presetCustomerId) return;
    void call<{ customer: Customer }>('customers.get', presetCustomerId)
      .then((res) => {
        setCustomerId(res.customer.id);
        setCustomer(res.customer);
        setDraft((prev) => ({ ...prev, org: res.customer.name, owner: res.customer.owner, phone: res.customer.phone, email: res.customer.email, address: res.customer.address }));
        setMaxStep((prev) => Math.max(prev, 1));
      })
      .catch(() => undefined);
  }, [presetCustomerId]);

  const editionFeatures = useMemo(
    () => (catalog?.features ?? []).filter((f) => f.editions.includes(draft.edition)),
    [catalog, draft.edition],
  );

  const set = (patch: Partial<IssueDraft>) => setDraft((prev) => ({ ...prev, ...patch }));

  /* ---------------- per-step validation ---------------- */
  const stepError = (target: number): string | null => {
    if (target >= 1 && !customerId) return 'একটি কাস্টমার নির্বাচন করুন (অথবা নতুন কাস্টমার তৈরি করুন)।';
    if (target >= 2) {
      if (draft.org.trim().length < 2) return 'প্রতিষ্ঠানের নাম কমপক্ষে ২ অক্ষরের হতে হবে।';
      if (draft.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(draft.email.trim())) return 'ইমেইল ঠিকানাটি সঠিক নয়।';
      const digits = draft.phone.replace(/\D/g, '');
      if (draft.phone && (digits.length < 8 || digits.length > 15)) return 'ফোন নম্বর ৮–১৫ ডিজিটের হতে হবে।';
    }
    if (target >= 3) {
      if (!['standard', 'pro', 'enterprise'].includes(draft.edition)) return 'এডিশন নির্বাচন করুন।';
      if (!draft.lifetime && !draft.expiresAt) return 'মেয়াদ শেষের তারিখ দিন, অথবা লাইফটাইম বেছে নিন।';
      if (!draft.lifetime && new Date(`${draft.expiresAt}T23:59:59`) <= new Date()) return 'মেয়াদ শেষের তারিখ ভবিষ্যতে হতে হবে।';
    }
    if (target >= 4 && !device) return 'ডিভাইস রিকোয়েস্ট ফাইল লোড করুন — হার্ডওয়্যার ছাড়া লাইসেন্স বাঁধা যাবে না।';
    if (target >= 5 && draft.features.length === 0) return 'অন্তত একটি ফিচার নির্বাচন করুন।';
    if (target >= 6) {
      if (draft.maxDevices < 1 || draft.maxDevices > 100) return 'ডিভাইস সংখ্যা ১–১০০ এর মধ্যে হতে হবে।';
    }
    return null;
  };

  const goNext = () => {
    const err = stepError(step);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    const next = Math.min(9, step + 1);
    setStep(next);
    setMaxStep((prev) => Math.max(prev, next));
  };

  const goBack = () => {
    setError(null);
    setStep((prev) => Math.max(1, prev - 1));
  };

  /* ---------------- device import ---------------- */
  const importDevice = async () => {
    try {
      const req = await call<DeviceRequest | null>('device.import');
      if (!req) return;
      setDevice(req);
      if (req.business_name && !draft.org) set({ org: req.business_name });
      ui.success('ডিভাইস রিকোয়েস্ট লোড হয়েছে', req.fingerprint.slice(0, 16));
    } catch (err) {
      ui.error('ডিভাইস ফাইল পড়া যায়নি', (err as Error).message);
    }
  };

  const applyPaste = async () => {
    try {
      const req = await call<DeviceRequest>('device.parse', pasteText);
      setDevice(req);
      setPasteOpen(false);
      setPasteText('');
      ui.success('ডিভাইস রিকোয়েস্ট গৃহীত');
    } catch (err) {
      ui.error('ডিভাইস ফাইল অবৈধ', (err as Error).message);
    }
  };

  /* ---------------- customer creation ---------------- */
  const createCustomer = async () => {
    if (!newCustomer) return;
    try {
      const created = await call<Customer>('customers.create', newCustomer);
      setCustomerId(created.id);
      setCustomer(created);
      setNewCustomer(null);
      setDraft((prev) => ({ ...prev, org: created.name, owner: created.owner, phone: created.phone, email: created.email, address: created.address }));
      await loadCustomers();
      ui.success('কাস্টমার তৈরি হয়েছে', created.code);
    } catch (err) {
      ui.error('কাস্টমার তৈরি ব্যর্থ', (err as Error).message);
    }
  };

  const selectCustomer = async (id: string) => {
    setCustomerId(id);
    try {
      const res = await call<{ customer: Customer }>('customers.get', id);
      setCustomer(res.customer);
      setDraft((prev) => ({
        ...prev,
        org: res.customer.name,
        owner: res.customer.owner,
        phone: res.customer.phone,
        email: res.customer.email,
        address: res.customer.address,
      }));
    } catch {
      /* the row is still selectable even if the extra fetch failed */
    }
  };

  /* ---------------- signing ---------------- */
  const sign = async () => {
    if (!device || !customerId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await call<IssueResult>('license.issue', {
        device,
        customerId,
        issue: {
          org: draft.org,
          owner: draft.owner,
          phone: draft.phone,
          email: draft.email,
          address: draft.address,
          edition: draft.edition,
          expiresAt: draft.lifetime ? null : draft.expiresAt,
          maxDevices: draft.maxDevices,
          features: draft.features,
          note: draft.note,
        },
        save: true,
      });
      if (!res.check?.activated) throw new Error(res.check?.message ?? 'স্বাক্ষর যাচাই ব্যর্থ');
      setResult(res.record ? res : res);
      setStep(9);
      setMaxStep(9);
      await refreshInfo();
      ui.success('লাইসেন্স স্বাক্ষরিত ও রেকর্ডভুক্ত');
    } catch (err) {
      setError((err as Error).message);
      ui.error('লাইসেন্স ইস্যু ব্যর্থ', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const restart = () => {
    setStep(1);
    setMaxStep(1);
    setResult(null);
    setDevice(null);
    setCustomerId(null);
    setCustomer(null);
    setDraft(emptyDraft());
    setError(null);
  };

  const expiresPreview = draft.lifetime ? null : draft.expiresAt;

  return (
    <>
      <PageHead
        title="নতুন লাইসেন্স"
        sub="৯ ধাপের গাইডেড ইস্যু — ৮ নম্বর ধাপে স্বাক্ষর হয়, ৯ নম্বরে যাচাই করে রপ্তানি"
        actions={
          <Button variant="ghost" icon="refresh" onClick={restart}>
            নতুন করে শুরু
          </Button>
        }
      />

      <Steps steps={STEP_LABELS} active={step} maxReached={maxStep} onSelect={(id) => setStep(id)} />

      {error ? <Banner tone="danger">{error}</Banner> : null}
      {!keyStatus.loaded ? (
        <Banner tone="warn">
          সাইনিং কী লোড নেই — ৮ নম্বর ধাপে যেতে <button className="btn ghost sm" onClick={() => navigate('security')}>সিকিউরিটি ও কী</button> থেকে কী লোড করুন।
        </Banner>
      ) : null}

      <Card>
        <CardHead
          title={`ধাপ ${bnNum(step)} — ${STEP_LABELS[step - 1].label}`}
          sub={
            step === 1
              ? 'লাইসেন্স কার নামে যাবে'
              : step === 2
                ? 'প্রতিষ্ঠানের তথ্য লাইসেন্স পেলোডে স্বাক্ষরিত হবে'
                : step === 3
                  ? 'এডিশন ও মেয়াদ'
                  : step === 4
                    ? 'গ্রাহক অ্যাপ থেকে পাওয়া ডিভাইস রিকোয়েস্ট'
                    : step === 5
                      ? 'এই এডিশনে অনুমোদিত ফিচার'
                      : step === 6
                        ? 'ডিভাইস সীমা, তারিখ ও নোট'
                        : step === 7
                          ? 'স্বাক্ষরের আগে পূর্ণ পর্যালোচনা'
                          : step === 8
                            ? 'স্বাক্ষর ও রেকর্ড'
                            : 'ফলাফল যাচাই ও ফাইল রপ্তানি'
          }
        />
        <div className="card-body wizard-body">
          {step === 1 ? (
            <>
              <div className="row" style={{ marginBottom: 10 }}>
                <Input value={customerQuery} onChange={setCustomerQuery} placeholder="প্রতিষ্ঠান / কোড / ফোন" />
                <Button icon="plus" onClick={() => setNewCustomer({ name: '', owner: '', phone: '', email: '', address: '', city: '' })}>
                  নতুন কাস্টমার
                </Button>
              </div>
              <Table
                compact
                rows={customers}
                rowKey={(r) => r.id}
                onRowClick={(r) => void selectCustomer(r.id)}
                empty={<Empty icon="users" title="কোনো কাস্টমার নেই" message="নতুন কাস্টমার তৈরি করে শুরু করুন।" />}
                columns={[
                  { key: 'code', label: 'কোড', width: 100, render: (r) => <span className="mono tiny">{r.code}</span> },
                  { key: 'name', label: 'প্রতিষ্ঠান', render: (r) => <span className="bold small">{r.name}</span> },
                  { key: 'owner', label: 'মালিক', render: (r) => r.owner || '—' },
                  { key: 'phone', label: 'ফোন', render: (r) => r.phone || '—' },
                  {
                    key: 'pick',
                    label: '',
                    align: 'right',
                    render: (r) =>
                      customerId === r.id ? <Badge tone="green">নির্বাচিত</Badge> : <Button size="sm" variant="ghost">নির্বাচন</Button>,
                  },
                ]}
              />
              {customer ? (
                <div className="small muted" style={{ marginTop: 10 }}>
                  নির্বাচিত: <strong>{customer.name}</strong> ({customer.code})
                </div>
              ) : null}
            </>
          ) : null}

          {step === 2 ? (
            <div className="form-grid">
              <Field label="প্রতিষ্ঠানের নাম *" span={2}>
                <Input value={draft.org} onChange={(v) => set({ org: v })} autoFocus />
              </Field>
              <Field label="মালিক / যোগাযোগ">
                <Input value={draft.owner} onChange={(v) => set({ owner: v })} />
              </Field>
              <Field label="মোবাইল">
                <Input value={draft.phone} onChange={(v) => set({ phone: v })} />
              </Field>
              <Field label="ইমেইল">
                <Input value={draft.email} onChange={(v) => set({ email: v })} />
              </Field>
              <Field label="ঠিকানা">
                <Input value={draft.address} onChange={(v) => set({ address: v })} />
              </Field>
            </div>
          ) : null}

          {step === 3 ? (
            <>
              <div className="form-grid">
                <Field label="এডিশন" span={2}>
                  <div className="check-list">
                    {(catalog?.editions ?? []).map((e) => (
                      <label key={e.id} className={`check-row ${draft.edition === e.id ? 'on' : ''}`}>
                        <input
                          type="radio"
                          name="edition"
                          checked={draft.edition === e.id}
                          onChange={() => {
                            const allowed = (catalog?.features ?? []).filter((f) => f.editions.includes(e.id)).map((f) => f.id);
                            set({ edition: e.id as Edition, features: allowed });
                          }}
                        />
                        <span>
                          <span className="check-title">{e.label}</span>
                          <span className="check-note">{e.note}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </Field>
                <Field label="মেয়াদ" span={2}>
                  <div className="row" style={{ gap: 10 }}>
                    <Switch
                      checked={draft.lifetime}
                      onChange={(v) => set({ lifetime: v, expiresAt: v ? '' : draft.expiresAt || addDaysInput(365) })}
                      label="লাইফটাইম (মেয়াদ নেই)"
                    />
                    {!draft.lifetime ? (
                      <>
                        <Input type="date" value={draft.expiresAt} onChange={(v) => set({ expiresAt: v })} />
                        <button className="btn sm" onClick={() => set({ expiresAt: addDaysInput(30) })}>৩০ দিন</button>
                        <button className="btn sm" onClick={() => set({ expiresAt: addDaysInput(90) })}>৯০ দিন</button>
                        <button className="btn sm" onClick={() => set({ expiresAt: addDaysInput(365) })}>১ বছর</button>
                      </>
                    ) : null}
                  </div>
                </Field>
              </div>
              <Banner tone="info">
                লাইসেন্স ফরম্যাট v1 — সাউদা ১.০.x ও ১.১.x উভয়ই এই ফরম্যাট গ্রহণ করে। পুরোনো গ্রাহকের লাইসেন্স অপরিবর্তিত
                থাকবে।
              </Banner>
            </>
          ) : null}

          {step === 4 ? (
            <>
              {!device ? (
                <Empty
                  icon="key"
                  title="ডিভাইস রিকোয়েস্ট প্রয়োজন"
                  message="গ্রাহক অ্যাপের অ্যাক্টিভেশন স্ক্রিন থেকে .sauda-device ফাইল পাঠান, অথবা ফাইলের বিষয়বস্তু পেস্ট করুন।"
                  action={
                    <div className="row">
                      <Button variant="primary" icon="upload" onClick={() => void importDevice()}>
                        ফাইল খুলুন
                      </Button>
                      <Button icon="copy" onClick={() => setPasteOpen(true)}>
                        পেস্ট করুন
                      </Button>
                    </div>
                  }
                />
              ) : (
                <>
                  <Banner tone="success">
                    হার্ডওয়্যার ফিঙ্গারপ্রিন্ট বৈধ — <span className="mono">{device.fingerprint}</span>
                  </Banner>
                  <KeyValue
                    items={[
                      { label: 'সংস্করণ', value: `v${device.v}` },
                      { label: 'প্ল্যাটফর্ম', value: device.platform ?? '—' },
                      { label: 'অ্যাপ সংস্করণ', value: device.app_version ?? '—' },
                      { label: 'রিকোয়েস্ট তৈরি', value: device.created_at ? dt(device.created_at) : '—' },
                    ]}
                  />
                  <div style={{ marginTop: 12 }}>
                    <div className="small bold" style={{ marginBottom: 6 }}>
                      হার্ডওয়্যার কম্পোনেন্ট ({device.components.length})
                    </div>
                    <Table
                      compact
                      rows={device.components}
                      rowKey={(r) => r.key}
                      columns={[
                        { key: 'key', label: 'কম্পোনেন্ট', render: (r) => <span className="small">{r.key}</span> },
                        { key: 'hash', label: 'হ্যাশ', render: (r) => <span className="mono tiny">{r.hash.slice(0, 24)}…</span> },
                        { key: 'weight', label: 'ওজন', align: 'right' },
                      ]}
                    />
                  </div>
                  <div className="row" style={{ marginTop: 12 }}>
                    <Button icon="refresh" onClick={() => void importDevice()}>
                      অন্য ফাইল
                    </Button>
                    <Button variant="ghost" icon="close" onClick={() => setDevice(null)}>
                      সরান
                    </Button>
                  </div>
                </>
              )}
            </>
          ) : null}

          {step === 5 ? (
            <>
              <div className="row" style={{ marginBottom: 8 }}>
                <span className="small muted">
                  {draft.edition} এডিশনে {editionFeatures.length} টি ফিচার অনুমোদিত
                </span>
                <span className="grow" />
                <Button size="sm" variant="ghost" onClick={() => set({ features: editionFeatures.map((f) => f.id) })}>
                  সব নির্বাচন
                </Button>
                <Button size="sm" variant="ghost" onClick={() => set({ features: [] })}>
                  সব বাদ
                </Button>
              </div>
              <div className="check-list">
                {(catalog?.features ?? []).map((f) => {
                  const allowed = f.editions.includes(draft.edition);
                  const checked = draft.features.includes(f.id);
                  return (
                    <label key={f.id} className={`check-row ${checked ? 'on' : ''} ${allowed ? '' : 'disabled'}`}>
                      <input
                        type="checkbox"
                        disabled={!allowed}
                        checked={checked}
                        onChange={(e) =>
                          set({
                            features: e.target.checked ? [...draft.features, f.id] : draft.features.filter((x) => x !== f.id),
                          })
                        }
                      />
                      <span>
                        <span className="check-title">{f.label}</span>
                        <span className="check-note">
                          {f.id} • {f.note} {allowed ? '' : '— এই এডিশনে নেই'}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </>
          ) : null}

          {step === 6 ? (
            <div className="form-grid">
              <Field label="ডিভাইস সীমা" hint="একই লাইসেন্স সর্বোচ্চ কত ডিভাইসে">
                <Input
                  value={draft.maxDevices}
                  onChange={(v) => set({ maxDevices: Math.max(1, Math.min(100, Number(v.replace(/\D/g, '')) || 1)) })}
                />
              </Field>
              <Field label="ইস্যু তারিখ" hint="আজকের তারিখ স্বয়ংক্রিয়ভাবে বসবে">
                <Input value={todayInput()} disabled />
              </Field>
              <Field label="মেয়াদ" >
                <Input value={expiresPreview ? dt(`${expiresPreview}T00:00:00`) : 'লাইফটাইম'} disabled />
              </Field>
              <Field label="লাইসেন্স আইডি" hint="স্বাক্ষরের সময় একবার তৈরি হবে (নকল হবে না)">
                <Input value="স্বাক্ষরের সময় নির্ধারিত" disabled />
              </Field>
              <Field label="প্রশাসনিক নোট" span={2} hint="লাইসেন্স পেলোডে যায়, রেজিস্টারে দেখা যাবে">
                <TextArea value={draft.note} onChange={(v) => set({ note: v })} rows={3} />
              </Field>
            </div>
          ) : null}

          {step === 7 ? (
            <div style={{ display: 'grid', gap: 12 }}>
              <div className="review-box">
                <h4>স্বাক্ষরিত হবে (অপরিবর্তনযোগ্য)</h4>
                <KeyValue
                  items={[
                    { label: 'প্রতিষ্ঠান', value: draft.org },
                    { label: 'মালিক', value: draft.owner || '—' },
                    { label: 'এডিশন', value: draft.edition },
                    { label: 'মেয়াদ', value: draft.lifetime ? 'লাইফটাইম' : dt(`${draft.expiresAt}T00:00:00`) },
                    { label: 'ডিভাইস সীমা', value: String(draft.maxDevices) },
                    { label: 'ডিভাইস ফিঙ্গারপ্রিন্ট', value: device?.fingerprint ?? '——', mono: true },
                    { label: 'ফিচার', value: draft.features.join(', ') },
                    { label: 'ফোন / ইমেইল', value: `${draft.phone || '—'} • ${draft.email || '—'}` },
                  ]}
                />
              </div>
              <div className="review-box">
                <h4>প্রশাসনিক (পরে পরোক্ষভাবে বদলানো যায়)</h4>
                <KeyValue
                  items={[
                    { label: 'কাস্টমার', value: customer ? `${customer.name} (${customer.code})` : '—' },
                    { label: 'নোট', value: draft.note || '—' },
                    { label: 'স্বাক্ষর কী', value: keyStatus.loaded ? keyStatus.keyId ?? '—' : 'লোড হয়নি' },
                  ]}
                />
              </div>
              <Banner tone="warn">
                স্বাক্ষরের পর প্রতিষ্ঠানের নাম, মেয়াদ, ফিচার বা হার্ডওয়্যার বদলাতে হলে <strong>রি-ইস্যু</strong> করতে হবে —
                পুরোনো লাইসেন্স প্রতিস্থাপিত হিসেবে বন্ধ হবে।
              </Banner>
            </div>
          ) : null}

          {step === 8 ? (
            <div style={{ display: 'grid', gap: 12 }}>
              {!keyStatus.loaded ? (
                <Banner tone="danger">
                  সাইনিং কী নেই — ইস্যু করা যাবে না। <button className="btn sm" onClick={() => navigate('security')}>কী লোড করুন</button>
                </Banner>
              ) : (
                <Banner tone="info">
                  Ed25519 প্রাইভেট কী <span className="mono">{keyStatus.keyId}</span> দিয়ে স্বাক্ষর হবে। স্বাক্ষরের পরপরই
                  পাবলিক কী দিয়ে যাচাই করা হবে — ব্যর্থ হলে কোনো ফাইল তৈরি হবে না।
                </Banner>
              )}
              <div className="row">
                <Button
                  variant="primary"
                  size="lg"
                  icon="shield"
                  loading={busy}
                  disabled={!keyStatus.loaded || !device || !customerId}
                  onClick={() => void sign()}
                >
                  স্বাক্ষর করে লাইসেন্স তৈরি করুন
                </Button>
                <Button variant="ghost" onClick={() => setStep(7)}>
                  পর্যালোচনায় ফিরুন
                </Button>
              </div>
            </div>
          ) : null}

          {step === 9 && result ? (
            <div style={{ display: 'grid', gap: 12 }}>
              <Banner tone="success">
                লাইসেন্স স্বাক্ষরিত, পাবলিক কী দিয়ে যাচাই সম্পন্ন এবং রেকর্ডে সংরক্ষিত — সাউদা মেইন অ্যাপ্লিকেশন এখান থেকে
                তৈরি ফাইল গ্রহণ করবে।
              </Banner>
              <KeyValue
                items={[
                  { label: 'লাইসেন্স আইডি', value: result.record.license_id, mono: true },
                  { label: 'কী আইডি', value: result.record.key_id, mono: true },
                  { label: 'এডিশন', value: result.record.edition },
                  { label: 'মেয়াদ', value: result.record.expires_at ? dt(result.record.expires_at) : 'লাইফটাইম' },
                  { label: 'ফাইল', value: result.filePath ?? 'সংরক্ষণ করা হয়নি — তালিকা থেকে রপ্তানি করুন' },
                  { label: 'যাচাই', value: result.check?.message ?? '—' },
                ]}
              />
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <Button icon="download" onClick={() => void call<string | null>('license.saveFile', result.record.license_id).then((f) => f && ui.success('সংরক্ষিত', f)).catch((e) => ui.error('ব্যর্থ', (e as Error).message))}>
                  ফাইল আবার সংরক্ষণ
                </Button>
                <Button icon="copy" onClick={() => void copyText(result.licenseKey).then(() => ui.success('লাইসেন্স কী কপি হয়েছে'))}>
                  লাইসেন্স কী কপি
                </Button>
                <Button icon="print" onClick={() => void call('license.previewDoc', result.record.license_id).then(() => ui.success('সার্টিফিকেট প্রিভিউ'))}>
                  সার্টিফিকেট
                </Button>
                <Button icon="file" onClick={() => navigate('licenses', { q: result.record.license_id })}>
                  তালিকায় দেখুন
                </Button>
                <Button variant="primary" icon="plus" onClick={restart}>
                  আরেকটি লাইসেন্স
                </Button>
              </div>
              <div className="small muted">
                ফাইলটি গ্রাহককে পাঠান। গ্রাহক অ্যাপের অ্যাক্টিভেশন স্ক্রিনে ফাইলটি নির্বাচন করলে লাইসেন্স সক্রিয় হবে।
              </div>
            </div>
          ) : null}
        </div>

        <div className="card-body wizard-foot">
          <Button variant="ghost" icon="chevron" onClick={goBack} disabled={step === 1 || step === 8 || step === 9}>
            পূর্ববর্তী
          </Button>
          <span className="small muted">
            ধাপ {step} / 9 {customer ? `• ${customer.name}` : ''}
          </span>
          {step < 8 ? (
            <Button variant="primary" onClick={goNext}>
              পরবর্তী
            </Button>
          ) : step === 8 ? (
            <span />
          ) : (
            <Button variant="primary" icon="check" onClick={restart}>
              শেষ করুন
            </Button>
          )}
        </div>
      </Card>

      {newCustomer ? (
        <Modal
          title="নতুন কাস্টমার"
          onClose={() => setNewCustomer(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setNewCustomer(null)}>
                বাতিল
              </Button>
              <Button variant="primary" icon="check" onClick={() => void createCustomer()}>
                তৈরি করুন
              </Button>
            </>
          }
        >
          <div className="form-grid">
            <Field label="প্রতিষ্ঠানের নাম *" span={2}>
              <Input value={newCustomer.name} onChange={(v) => setNewCustomer({ ...newCustomer, name: v })} autoFocus />
            </Field>
            <Field label="মালিক">
              <Input value={newCustomer.owner} onChange={(v) => setNewCustomer({ ...newCustomer, owner: v })} />
            </Field>
            <Field label="মোবাইল">
              <Input value={newCustomer.phone} onChange={(v) => setNewCustomer({ ...newCustomer, phone: v })} />
            </Field>
            <Field label="ইমেইল">
              <Input value={newCustomer.email} onChange={(v) => setNewCustomer({ ...newCustomer, email: v })} />
            </Field>
            <Field label="শহর">
              <Input value={newCustomer.city} onChange={(v) => setNewCustomer({ ...newCustomer, city: v })} />
            </Field>
            <Field label="ঠিকানা" span={2}>
              <Input value={newCustomer.address} onChange={(v) => setNewCustomer({ ...newCustomer, address: v })} />
            </Field>
          </div>
        </Modal>
      ) : null}

      {pasteOpen ? (
        <Modal
          title="ডিভাইস রিকোয়েস্ট পেস্ট করুন"
          sub=".sauda-device ফাইলের বিষয়বস্তু এখানে দিন"
          onClose={() => setPasteOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setPasteOpen(false)}>
                বাতিল
              </Button>
              <Button variant="primary" icon="check" onClick={() => void applyPaste()}>
                গ্রহণ করুন
              </Button>
            </>
          }
        >
          <TextArea value={pasteText} onChange={setPasteText} rows={10} placeholder='{"kind":"sauda-device-request", …}' />
        </Modal>
      ) : null}
    </>
  );
}
