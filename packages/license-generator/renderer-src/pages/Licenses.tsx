import { useCallback, useEffect, useState } from 'react';
import { call, copyText } from '../api.js';
import { useApp } from '../App.js';
import {
  Badge,
  Banner,
  Button,
  Card,
  Empty,
  Field,
  Input,
  KeyValue,
  Modal,
  PageHead,
  Segmented,
  Select,
  Table,
  TextArea,
  dt,
  dtTime,
  useDebounced,
  useUI,
} from '../ui.js';
import type { Customer, LicenseRecord, LicenseStateName } from '../types.js';

const stateLabel: Record<LicenseStateName, string> = {
  active: 'সক্রিয়',
  expired: 'মেয়াদোত্তীর্ণ',
  revoked: 'প্রত্যাহৃত',
  superseded: 'প্রতিস্থাপিত',
};

const stateTone: Record<LicenseStateName, 'green' | 'amber' | 'red' | 'plain'> = {
  active: 'green',
  expired: 'amber',
  revoked: 'red',
  superseded: 'plain',
};

export function LicensesPage({ initialQ, initialState }: { initialQ: string; initialState: string }) {
  const { navigate } = useApp();
  const ui = useUI();
  const [query, setQuery] = useState(initialQ);
  const debounced = useDebounced(query);
  const [state, setState] = useState<LicenseStateName | 'all'>((initialState as LicenseStateName) || 'all');
  const [edition, setEdition] = useState<'all' | LicenseRecord['edition']>('all');
  const [rows, setRows] = useState<LicenseRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<{ record: LicenseRecord & { state: LicenseStateName }; customer: Customer | null } | null>(null);
  const [verify, setVerify] = useState<{ ok: boolean; message: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await call<LicenseRecord[]>('licenses.list', { q: debounced, state, edition }));
    } catch (err) {
      ui.error('লোড ব্যর্থ', (err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [debounced, state, edition, ui]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = async (licenseId: string) => {
    setVerify(null);
    try {
      setDetail(await call('licenses.get', licenseId));
    } catch (err) {
      ui.error('বিস্তারিত লোড ব্যর্থ', (err as Error).message);
    }
  };

  const saveFile = async (record: LicenseRecord) => {
    try {
      const file = await call<string | null>('license.saveFile', record.license_id);
      if (file) {
        ui.success('ফাইল সংরক্ষিত', file);
        await load();
      }
    } catch (err) {
      ui.error('সংরক্ষণ ব্যর্থ', (err as Error).message);
    }
  };

  const verifyRecord = async (record: LicenseRecord) => {
    try {
      const res = await call<{ ok: boolean; message: string }>('licenses.verifyRecord', record.license_id);
      setVerify(res);
      if (res.ok) ui.success('স্বাক্ষর বৈধ', res.message);
      else ui.error('স্বাক্ষর যাচাই ব্যর্থ', res.message);
    } catch (err) {
      ui.error('যাচাই ব্যর্থ', (err as Error).message);
    }
  };

  const revoke = async (record: LicenseRecord) => {
    const res = await ui.confirm({
      title: 'লাইসেন্স প্রত্যাহার',
      message:
        'প্রত্যাহার শুধু এই মেশিনের রেকর্ড ও ভবিষ্যৎ রি-ইস্যু নিয়ন্ত্রণে কাজ করে — ইনস্টল করা অফলাইন কপি ইন্টারনেটে যায় না। কারণ লিখুন।',
      requireReason: true,
      reasonLabel: 'প্রত্যাহারের কারণ',
      danger: true,
      confirmLabel: 'প্রত্যাহার করুন',
    });
    if (!res.ok || !res.reason) return;
    try {
      await call('license.revoke', record.license_id, res.reason);
      ui.success('প্রত্যাহার রেকর্ড হয়েছে');
      setDetail(null);
      await load();
    } catch (err) {
      ui.error('প্রত্যাহার ব্যর্থ', (err as Error).message);
    }
  };

  const documentAction = async (kind: 'previewDoc' | 'pdf' | 'print', record: LicenseRecord) => {
    try {
      const res = await call(kind === 'previewDoc' ? 'license.previewDoc' : kind === 'pdf' ? 'license.pdf' : 'license.print', record.license_id);
      if (kind !== 'print') ui.success(kind === 'pdf' ? 'PDF সংরক্ষিত' : 'সার্টিফিকেট প্রিভিউ', String(res ?? ''));
      else ui.success((res as { message: string })?.message ?? 'প্রিন্ট হয়েছে');
    } catch (err) {
      ui.error('ডকুমেন্ট তৈরি ব্যর্থ', (err as Error).message);
    }
  };

  return (
    <>
      <PageHead
        title="লাইসেন্স তালিকা"
        sub="স্বাক্ষরিত পেলোড অপরিবর্তনযোগ্য — পরিবর্তন দরকার হলে রি-ইস্যু করুন"
        actions={
          <>
            <Button icon="refresh" onClick={() => void load()}>
              রিফ্রেশ
            </Button>
            <Button variant="primary" icon="plus" onClick={() => navigate('generate')}>
              নতুন লাইসেন্স
            </Button>
          </>
        }
      />

      <Card>
        <div className="toolbar">
          <Segmented
            value={state}
            onChange={(v) => setState(v)}
            options={[
              { value: 'all', label: 'সব' },
              { value: 'active', label: 'সক্রিয়' },
              { value: 'expired', label: 'মেয়াদোত্তীর্ণ' },
              { value: 'revoked', label: 'প্রত্যাহৃত' },
              { value: 'superseded', label: 'প্রতিস্থাপিত' },
            ]}
          />
          <div style={{ width: 150 }}>
            <Select
              value={edition}
              onChange={(v) => setEdition(v as never)}
              options={[
                { value: 'all', label: 'সব এডিশন' },
                { value: 'standard', label: 'Standard' },
                { value: 'pro', label: 'Pro' },
                { value: 'enterprise', label: 'Enterprise' },
              ]}
            />
          </div>
          <div style={{ width: 260 }}>
            <Input value={query} onChange={setQuery} placeholder="প্রতিষ্ঠান, লাইসেন্স আইডি, ফিঙ্গারপ্রিন্ট" />
          </div>
          <span className="grow" />
          <span className="small muted">{rows.length} টি</span>
        </div>

        <Table
          loading={loading}
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => void openDetail(r.license_id)}
          empty={<Empty icon="license" title="কোনো লাইসেন্স নেই" message="নতুন লাইসেন্স ইস্যু করে শুরু করুন।" />}
          columns={[
            {
              key: 'license_id',
              label: 'লাইসেন্স আইডি',
              render: (r) => (
                <>
                  <div className="mono small">{r.license_id}</div>
                  <div className="tiny muted">{r.key_id}</div>
                </>
              ),
            },
            { key: 'org', label: 'প্রতিষ্ঠান', render: (r) => <span className="bold small">{r.org}</span> },
            { key: 'edition', label: 'এডিশন', render: (r) => <Badge tone="teal">{r.edition}</Badge> },
            { key: 'issued_at', label: 'ইস্যু', render: (r) => <span className="small">{dt(r.issued_at)}</span> },
            {
              key: 'expires_at',
              label: 'মেয়াদ',
              render: (r) => (r.expires_at ? <span className="small">{dt(r.expires_at)}</span> : <span className="pill blue">লাইফটাইম</span>),
            },
            { key: 'max_devices', label: 'ডিভাইস', align: 'right' },
            { key: 'state', label: 'অবস্থা', render: (r) => <span className={`pill ${stateTone[r.state]}`}>{stateLabel[r.state]}</span> },
            {
              key: 'actions',
              label: '',
              align: 'right',
              width: 90,
              render: (r) => (
                <div className="row" style={{ justifyContent: 'flex-end' }} onClick={(e) => e.stopPropagation()}>
                  <Button size="sm" variant="ghost" icon="download" title="ফাইল সংরক্ষণ" onClick={() => void saveFile(r)} />
                  <Button size="sm" variant="ghost" icon="print" title="সার্টিফিকেট" onClick={() => void documentAction('previewDoc', r)} />
                </div>
              ),
            },
          ]}
        />
      </Card>

      {detail ? (
        <Modal
          title={detail.record.org}
          sub={`${detail.record.license_id} • ${stateLabel[detail.record.state]}`}
          size="lg"
          onClose={() => setDetail(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDetail(null)}>
                বন্ধ
              </Button>
              <Button icon="check" onClick={() => void verifyRecord(detail.record)}>
                স্বাক্ষর যাচাই
              </Button>
              <Button icon="download" onClick={() => void saveFile(detail.record)}>
                ফাইল
              </Button>
              {detail.record.state === 'active' ? (
                <Button variant="danger" icon="close" onClick={() => void revoke(detail.record)}>
                  প্রত্যাহার
                </Button>
              ) : null}
            </>
          }
        >
          {verify ? (
            <Banner tone={verify.ok ? 'success' : 'danger'}>
              {verify.ok ? 'স্বাক্ষর বৈধ — সাউদা মেইন অ্যাপ্লিকেশন এই লাইসেন্স গ্রহণ করবে।' : verify.message}
            </Banner>
          ) : null}

          <KeyValue
            items={[
              { label: 'লাইসেন্স আইডি', value: detail.record.license_id, mono: true },
              { label: 'কী আইডি', value: detail.record.key_id, mono: true },
              { label: 'এডিশন', value: detail.record.edition },
              { label: 'ডিভাইস সীমা', value: String(detail.record.max_devices) },
              { label: 'ইস্যু', value: dtTime(detail.record.issued_at) },
              { label: 'মেয়াদ', value: detail.record.expires_at ? dt(detail.record.expires_at) : 'লাইফটাইম' },
              { label: 'কাস্টমার', value: detail.customer?.name ?? '—' },
              { label: 'ফোন', value: detail.record.phone || '—' },
              { label: 'ডিভাইস ফিঙ্গারপ্রিন্ট', value: detail.record.fingerprint, mono: true },
              { label: 'ফাইল', value: detail.record.file_path ?? 'সংরক্ষিত হয়নি' },
            ]}
          />

          <h4 style={{ margin: '16px 0 8px' }}>ফিচার এনটাইটেলমেন্ট</h4>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {detail.record.features.map((f) => (
              <Badge key={f} tone="plain">
                {f}
              </Badge>
            ))}
          </div>

          {detail.record.replaces ? (
            <div className="small muted" style={{ marginTop: 12 }}>
              প্রতিস্থাপন করেছে: <span className="mono">{detail.record.replaces}</span>
            </div>
          ) : null}
          {detail.record.superseded_by ? (
            <div className="small muted" style={{ marginTop: 4 }}>
              প্রতিস্থাপিত হয়েছে: <span className="mono">{detail.record.superseded_by}</span>
            </div>
          ) : null}
          {detail.record.revoked_at ? (
            <Banner tone="danger">
              {dtTime(detail.record.revoked_at)} — {detail.record.revoke_reason}
            </Banner>
          ) : null}
          {detail.record.note ? <div className="small muted" style={{ marginTop: 10 }}>{detail.record.note}</div> : null}

          <div className="row" style={{ marginTop: 16, gap: 8, flexWrap: 'wrap' }}>
            <Button size="sm" icon="print" onClick={() => void documentAction('previewDoc', detail.record)}>
              সার্টিফিকেট প্রিভিউ
            </Button>
            <Button size="sm" icon="download" onClick={() => void documentAction('pdf', detail.record)}>
              PDF
            </Button>
            <Button size="sm" icon="print" onClick={() => void documentAction('print', detail.record)}>
              প্রিন্ট
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon="copy"
              onClick={() => void copyText(detail.record.license_id).then(() => ui.success('আইডি কপি হয়েছে'))}
            >
              আইডি কপি
            </Button>
            <Button size="sm" variant="ghost" icon="refresh" onClick={() => navigate('reissue', { licenseId: detail.record.license_id })}>
              রি-ইস্যু
            </Button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
