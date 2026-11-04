import { useCallback, useEffect, useMemo, useState } from 'react';
import { call } from '../api.js';
import { useApp } from '../App.js';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardHead,
  Empty,
  Field,
  Input,
  KeyValue,
  Modal,
  PageHead,
  Select,
  Table,
  TextArea,
  addDaysInput,
  dt,
  useDebounced,
  useUI,
} from '../ui.js';
import type { DeviceRequest, LicenseRecord } from '../types.js';

export function ReissuePage({ presetLicenseId }: { presetLicenseId: string | null }) {
  const { keyStatus, refreshInfo } = useApp();
  const ui = useUI();
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query);
  const [rows, setRows] = useState<LicenseRecord[]>([]);
  const [selected, setSelected] = useState<LicenseRecord | null>(null);
  const [device, setDevice] = useState<DeviceRequest | null>(null);
  const [expiresAt, setExpiresAt] = useState('');
  const [lifetime, setLifetime] = useState(false);
  const [maxDevices, setMaxDevices] = useState(1);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ license_id: string; filePath: string | null } | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await call<LicenseRecord[]>('licenses.list', { q: debounced, state: 'all' });
      setRows(list.filter((l) => l.state !== 'superseded'));
    } catch (err) {
      ui.error('লোড ব্যর্থ', (err as Error).message);
    }
  }, [debounced, ui]);

  useEffect(() => {
    void load();
  }, [load]);

  const pick = async (record: LicenseRecord) => {
    setSelected(record);
    setLifetime(!record.expires_at);
    setExpiresAt(record.expires_at ? String(record.expires_at).slice(0, 10) : addDaysInput(365));
    setMaxDevices(record.max_devices);
    setNote('');
    setReason('');
    setDone(null);
    setDevice(null);
  };

  useEffect(() => {
    if (!presetLicenseId) return;
    void call<{ record: LicenseRecord }>('licenses.get', presetLicenseId)
      .then((res) => pick(res.record))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetLicenseId]);

  const importDevice = async () => {
    try {
      const req = await call<DeviceRequest | null>('device.import');
      if (req) {
        setDevice(req);
        ui.success('নতুন হার্ডওয়্যার লোড হয়েছে', req.fingerprint.slice(0, 16));
      }
    } catch (err) {
      ui.error('ডিভাইস ফাইল পড়া যায়নি', (err as Error).message);
    }
  };

  const submit = async () => {
    if (!selected || !device) return;
    setBusy(true);
    try {
      const res = await call<{ record: LicenseRecord; filePath: string | null }>('license.reissue', {
        device,
        previousLicenseId: selected.license_id,
        issue: {
          org: selected.org,
          owner: selected.owner ?? '',
          phone: selected.phone ?? '',
          email: selected.email ?? '',
          address: selected.address ?? '',
          edition: selected.edition,
          expiresAt: lifetime ? null : expiresAt,
          maxDevices,
          features: selected.features,
          note,
        },
        reason,
        save: true,
      });
      setDone({ license_id: res.record.license_id, filePath: res.filePath });
      await load();
      await refreshInfo();
      ui.success('রি-ইস্যু সম্পন্ন', res.record.license_id);
    } catch (err) {
      ui.error('রি-ইস্যু ব্যর্থ', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = useMemo(
    () => Boolean(selected && device && reason.trim() && keyStatus.loaded),
    [selected, device, reason, keyStatus.loaded],
  );

  return (
    <>
      <PageHead
        title="রি-ইস্যু"
        sub="হার্ডওয়্যার বদল, মেয়াদ বাড়ানো বা তথ্য সংশোধনের জন্য নতুন স্বাক্ষরিত লাইসেন্স"
        actions={
          <Button icon="refresh" onClick={() => void load()}>
            রিফ্রেশ
          </Button>
        }
      />

      {!keyStatus.loaded ? <Banner tone="warn">সাইনিং কী লোড নেই — রি-ইস্যু করা যাবে না।</Banner> : null}

      <Card>
        <CardHead title="১. যে লাইসেন্সটি প্রতিস্থাপন করবেন" sub="সক্রিয় বা মেয়াদোত্তীর্ণ লাইসেন্স বেছে নিন" />
        <div className="toolbar">
          <Input value={query} onChange={setQuery} placeholder="প্রতিষ্ঠান বা লাইসেন্স আইডি" />
          <span className="grow" />
        </div>
        <Table
          compact
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => void pick(r)}
          empty={<Empty icon="refresh" title="কোনো লাইসেন্স নেই" message="প্রথমে একটি লাইসেন্স ইস্যু করুন।" />}
          columns={[
            { key: 'license_id', label: 'লাইসেন্স', render: (r) => <span className="mono tiny">{r.license_id}</span> },
            { key: 'org', label: 'প্রতিষ্ঠান', render: (r) => <span className="bold small">{r.org}</span> },
            { key: 'edition', label: 'এডিশন' },
            { key: 'expires_at', label: 'মেয়াদ', render: (r) => (r.expires_at ? dt(r.expires_at) : 'লাইফটাইম') },
            {
              key: 'pick',
              label: '',
              align: 'right',
              render: (r) => (selected?.license_id === r.license_id ? <Badge tone="green">নির্বাচিত</Badge> : null),
            },
          ]}
        />
      </Card>

      {selected ? (
        <Card>
          <CardHead
            title="২. নতুন লাইসেন্সের তথ্য"
            sub={`${selected.org} • পুরোনো: ${selected.license_id}`}
          />
          <div className="card-body">
            <Banner tone="info">
              রি-ইস্যু করলে পুরোনো লাইসেন্সটি লেজারে “প্রত্যাহৃত (রি-ইস্যু)” হিসেবে বন্ধ হবে এবং নতুন লাইসেন্স
              <strong> প্রতিস্থাপক</strong> হিসেবে রেকর্ড হবে। হার্ডওয়্যার না বদলালে পুরোনোটিই আবার লোড করুন।
            </Banner>

            <div className="row" style={{ marginBottom: 12 }}>
              <Button icon="upload" onClick={() => void importDevice()}>
                নতুন হার্ডওয়্যার ফাইল
              </Button>
              {device ? (
                <span className="small muted">
                  ফিঙ্গারপ্রিন্ট: <span className="mono">{device.fingerprint}</span>
                </span>
              ) : (
                <span className="small muted">ডিভাইস রিকোয়েস্ট লোড হয়নি</span>
              )}
            </div>

            <div className="form-grid">
              <Field label="মেয়াদ">
                <Input value={lifetime ? 'লাইফটাইম' : expiresAt} onChange={setExpiresAt} type={lifetime ? 'text' : 'date'} disabled={lifetime} />
              </Field>
              <Field label="মেয়াদ নীতি">
                <Select
                  value={lifetime ? 'lifetime' : 'dated'}
                  onChange={(v) => setLifetime(v === 'lifetime')}
                  options={[
                    { value: 'dated', label: 'নির্দিষ্ট তারিখ' },
                    { value: 'lifetime', label: 'লাইফটাইম' },
                  ]}
                />
              </Field>
              <Field label="ডিভাইস সীমা">
                <Input value={maxDevices} onChange={(v) => setMaxDevices(Math.max(1, Math.min(100, Number(v.replace(/\D/g, '')) || 1)))} />
              </Field>
              <Field label="প্রশাসনিক নোট">
                <Input value={note} onChange={setNote} placeholder="ঐচ্ছিক" />
              </Field>
              <Field label="রি-ইস্যুর কারণ *" span={2} hint="অডিট লগে স্থায়ীভাবে সংরক্ষিত হবে">
                <TextArea value={reason} onChange={setReason} rows={2} placeholder="যেমন: মাদারবোর্ড পরিবর্তন" />
              </Field>
            </div>

            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <Button variant="primary" icon="shield" loading={busy} disabled={!canSubmit} onClick={() => void submit()}>
                রি-ইস্যু করুন
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      {done ? (
        <Modal
          title="রি-ইস্যু সম্পন্ন"
          onClose={() => setDone(null)}
          footer={
            <Button variant="primary" onClick={() => setDone(null)}>
              ঠিক আছে
            </Button>
          }
        >
          <Banner tone="success">নতুন লাইসেন্স স্বাক্ষরিত ও যাচাইকৃত।</Banner>
          <KeyValue
            items={[
              { label: 'নতুন লাইসেন্স আইডি', value: done.license_id, mono: true },
              { label: 'ফাইল', value: done.filePath ?? 'সংরক্ষণ করা হয়নি' },
            ]}
          />
        </Modal>
      ) : null}
    </>
  );
}
