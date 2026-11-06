import { useCallback, useEffect, useState } from 'react';
import { call } from '../api.js';
import { dateTime, money } from '../format.js';
import {
  Badge,
  Banner,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Loading,
  Modal,
  PageHead,
  Select,
  StatCard,
  Switch,
  TextInput,
  useUI,
} from '../ui.js';
import type { AppSettings } from '../types.js';

export function BackupPage({ can }: { can: (perm?: string) => boolean }) {
  const ui = useUI();
  const [backups, setBackups] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [scan, setScan] = useState<any | null>(null);
  const [restoring, setRestoring] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, s] = await Promise.all([call<any[]>('backup.list'), call<AppSettings>('settings.get')]);
      setBackups(list);
      setSettings(s);
    } catch (err) {
      ui.error('ব্যাকআপ তালিকা লোড ব্যর্থ', (err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [ui]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setCreating(true);
    try {
      const res = await call<any>('backup.create');
      if (res) {
        ui.success('ব্যাকআপ তৈরি হয়েছে', res.filePath);
        await load();
      }
    } catch (err) {
      ui.error('ব্যাকআপ ব্যর্থ', (err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const pick = async () => {
    try {
      const res = await call<{ path: string; validation: any } | null>('backup.scan');
      if (res) setScan(res);
    } catch (err) {
      ui.error('ফাইল যাচাই ব্যর্থ', (err as Error).message);
    }
  };

  const restore = async () => {
    if (!scan) return;
    setRestoring(true);
    try {
      const res = await call<any>('backup.restore', scan.path);
      if (res) {
        ui.success('রিস্টোর সম্পন্ন', 'অ্যাপটি পুনরায় চালু করার পর সব তথ্য দেখা যাবে।');
        setScan(null);
        await load();
      }
    } catch (err) {
      ui.error('রিস্টোর ব্যর্থ', (err as Error).message);
    } finally {
      setRestoring(false);
    }
  };

  const saveSettings = async (patch: Partial<AppSettings>) => {
    if (!settings) return;
    try {
      const next = await call<AppSettings>('settings.update', patch);
      setSettings(next);
      ui.success('সেটিংস সংরক্ষিত');
    } catch (err) {
      ui.error('সংরক্ষণ ব্যর্থ', (err as Error).message);
    }
  };

  const totalSize = backups.reduce((s, b) => s + (b.size_bytes ?? 0), 0);
  const lastBackup = backups[0];

  if (loading) return <Loading label="ব্যাকআপ তথ্য লোড হচ্ছে…" />;

  return (
    <>
      <PageHead
        title="ব্যাকআপ ও রিস্টোর"
        sub="আপনার সব তথ্য একটিমাত্র ফাইলে — নিরাপদে সংরক্ষণ করুন"
        actions={
          can('backup.manage') ? (
            <>
              <Button icon="upload" onClick={pick}>
                রিস্টোর করব
              </Button>
              <Button variant="primary" icon="backup" loading={creating} onClick={create}>
                এখনই ব্যাকআপ নিন
              </Button>
            </>
          ) : null
        }
      />

      <div className="stat-grid" style={{ marginBottom: 14 }}>
        <StatCard label="মোট ব্যাকআপ" value={String(backups.length)} icon="backup" foot="সব ধরনের" />
        <StatCard label="মোট আকার" value={`${(totalSize / 1024 / 1024).toFixed(2)} MB`} icon="file" />
        <StatCard
          label="সর্বশেষ ব্যাকআপ"
          value={lastBackup ? dateTime(lastBackup.created_at) : 'এখনো নেই'}
          icon="clock"
          tone={lastBackup ? undefined : 'warn'}
        />
        <StatCard
          label="স্বয়ংক্রিয় ব্যাকআপ"
          value={settings?.auto_backup_enabled ? settings.auto_backup_interval : 'বন্ধ'}
          icon="refresh"
          tone={settings?.auto_backup_enabled ? 'accent' : 'warn'}
          foot={`${settings?.backup_keep_count ?? 10} টি পর্যন্ত রাখা হবে`}
        />
      </div>

      <Banner tone="info" icon="info">
        ব্যাকআপ ফাইল (<code>.saudabak</code>) সেটি একটি সম্পূর্ণ ডাটাবেজ কপি + যাচাই তথ্য। এটি অন্য কম্পিউটারে বা
        পেনড্রাইভে রাখুন। সফটওয়্যার আনইনস্টল করলেও আপনার ডেটা ও ব্যাকআপ মুছে যাবে না।
      </Banner>

      <div className="grid-2" style={{ marginTop: 14 }}>
        <Card>
          <div className="card-head">
            <div>
              <h3>স্বয়ংক্রিয় ব্যাকআপ</h3>
              <div className="sub">অ্যাপ চালু হলে নিজে থেকেই ব্যাকআপ নেবে</div>
            </div>
          </div>
          <div className="card-body">
            <div className="form-grid">
              <Field label="চালু / বন্ধ">
                <Switch
                  checked={settings?.auto_backup_enabled === 1}
                  onChange={(v) => void saveSettings({ auto_backup_enabled: v ? 1 : 0 })}
                  label="স্বয়ংক্রিয় ব্যাকআপ"
                />
              </Field>
              <Field label="কত ঘন ঘন">
                <Select
                  value={settings?.auto_backup_interval ?? 'off'}
                  onChange={(v) => void saveSettings({ auto_backup_interval: v as any })}
                  options={[
                    { value: 'off', label: 'বন্ধ' },
                    { value: 'daily', label: 'প্রতিদিন' },
                    { value: 'weekly', label: 'সাপ্তাহিক' },
                    { value: 'monthly', label: 'মাসিক' },
                  ]}
                />
              </Field>
              <Field label="রাখার সংখ্যা">
                <TextInput
                  value={settings?.backup_keep_count ?? 10}
                  onChange={(v) => void saveSettings({ backup_keep_count: Number(v.replace(/[^\d]/g, '')) || 10 })}
                />
              </Field>
              <Field label="ফোল্ডার" hint="খালি = অ্যাপের ডেটা ফোল্ডার">
                <TextInput value={settings?.auto_backup_dir ?? ''} onChange={(v) => void saveSettings({ auto_backup_dir: v })} />
              </Field>
            </div>
          </div>
        </Card>

        <Card>
          <div className="card-head">
            <div>
              <h3>ব্যাকআপের ইতিহাস</h3>
              <div className="sub">{backups.length} টি রেকর্ড</div>
            </div>
          </div>
          <div className="card-body tight">
            <DataTable
              rows={backups}
              rowKey={(r) => r.id ?? r.file_path}
              empty={<EmptyState icon="backup" title="এখনো কোনো ব্যাকআপ নেই" message="প্রথম ব্যাকআপ নিন — মাত্র কয়েক সেকেন্ড লাগবে।" />}
              columns={[
                {
                  key: 'created_at',
                  label: 'সময়',
                  render: (r: any) => (
                    <div>
                      <div className="small">{dateTime(r.created_at)}</div>
                      <div className="tiny muted">
                        {r.kind === 'manual' ? 'ম্যানুয়াল' : r.kind === 'auto' ? 'স্বয়ংক্রিয়' : r.kind === 'safety' ? 'নিরাপত্তা' : 'রিস্টোরের আগে'}
                      </div>
                    </div>
                  ),
                },
                {
                  key: 'file_path',
                  label: 'ফাইল',
                  render: (r: any) => (
                    <span className="small mono" title={r.file_path} style={{ display: 'inline-block', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {String(r.file_path).split(/[\\/]/).pop()}
                    </span>
                  ),
                },
                { key: 'size_bytes', label: 'আকার', align: 'right', render: (r: any) => <span className="num small">{((r.size_bytes ?? 0) / 1024 / 1024).toFixed(2)} MB</span> },
                { key: 'status', label: '', align: 'center', render: (r: any) => (r.status === 'ok' ? <Badge tone="green">ঠিক</Badge> : <Badge tone="red">ব্যর্থ</Badge>) },
              ]}
            />
          </div>
        </Card>
      </div>

      {scan ? (
        <Modal
          title="রিস্টোর যাচাই"
          sub={String(scan.path).split(/[\\/]/).pop()}
          onClose={() => setScan(null)}
          footer={
            <>
              <Button onClick={() => setScan(null)}>বাতিল</Button>
              <Button variant="danger" icon="warning" loading={restoring} disabled={!scan.validation?.ok} onClick={restore}>
                রিস্টোর করুন
              </Button>
            </>
          }
        >
          {scan.validation?.ok ? (
            <>
              <Banner tone="warn" icon="warning">
                রিস্টোর করলে বর্তমান সব তথ্য প্রতিস্থাপিত হবে। তার আগে বর্তমান তথ্যের একটি স্বয়ংক্রিয় ব্যাকআপ তৈরি হবে।
              </Banner>
              <div className="form-grid" style={{ marginTop: 10 }}>
                <Field label="ব্যবসার নাম">
                  <TextInput value={scan.validation.business_name || '—'} onChange={() => undefined} disabled />
                </Field>
                <Field label="ডাটাবেজ ভার্সন">
                  <TextInput value={String(scan.validation.db_version)} onChange={() => undefined} disabled />
                </Field>
                <div className="span-2">
                  <div className="section-title">ফাইলের তথ্য</div>
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    {Object.entries(scan.validation.counts ?? {}).map(([table, count]) => (
                      <Badge key={table} tone="plain">
                        {table}: {String(count)}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <Banner tone="danger" icon="warning">
              {scan.validation?.message ?? 'ফাইলটি যাচাই করা যায়নি।'}
            </Banner>
          )}
        </Modal>
      ) : null}
    </>
  );
}

export { money };
