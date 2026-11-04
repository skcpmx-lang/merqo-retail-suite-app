import { useState } from 'react';
import { call } from '../api.js';
import { useApp } from '../App.js';
import { Banner, Button, Card, CardHead, KeyValue, PageHead, dt, useUI } from '../ui.js';

export function BackupPage() {
  const { info } = useApp();
  const ui = useUI();
  const [busy, setBusy] = useState<string | null>(null);
  const [inspect, setInspect] = useState<{ file: string; created_at: string; customers: number; licenses: number; ledger: number } | null>(null);
  const [lastExport, setLastExport] = useState<{ file: string; customers: number; licenses: number } | null>(null);

  const exportBackup = async () => {
    setBusy('export');
    try {
      const res = await call<{ file: string; customers: number; licenses: number } | null>('backup.export');
      if (res) {
        setLastExport(res);
        ui.success('ব্যাকআপ সংরক্ষিত', res.file);
      }
    } catch (err) {
      ui.error('ব্যাকআপ ব্যর্থ', (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const pickBackup = async () => {
    setBusy('inspect');
    try {
      const res = await call<typeof inspect>('backup.inspect');
      if (res) setInspect(res);
    } catch (err) {
      ui.error('ব্যাকআপ পড়া যায়নি', (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const restore = async () => {
    if (!inspect) return;
    const res = await ui.confirm({
      title: 'ব্যাকআপ থেকে রিস্টোর',
      message:
        'বর্তমান কাস্টমার ও লাইসেন্স রেকর্ড সরিয়ে ব্যাকআপের ডেটা বসবে। বর্তমান ফাইলটি পাশে .before-restore নামে সংরক্ষিত থাকবে।',
      confirmLabel: 'রিস্টোর করুন',
      danger: true,
    });
    if (!res.ok) return;
    setBusy('restore');
    try {
      const out = await call<{ restored: { customers: number; licenses: number }; previous: string }>('backup.restore', inspect.file);
      ui.success('রিস্টোর সম্পন্ন', `${out.restored.customers} কাস্টমার • ${out.restored.licenses} লাইসেন্স`);
      setInspect(null);
    } catch (err) {
      ui.error('রিস্টোর ব্যর্থ', (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHead
        title="ব্যাকআপ ও রিকভারি"
        sub="কাস্টমার, লাইসেন্স রেকর্ড ও লেজার এক JSON ফাইলে — সরাসরি রিস্টোরযোগ্য"
        actions={
          <>
            <Button icon="database" onClick={() => void call('backup.reveal').catch((e) => ui.error('ব্যর্থ', (e as Error).message))}>
              ডেটা ফোল্ডার
            </Button>
            <Button variant="primary" icon="download" loading={busy === 'export'} onClick={() => void exportBackup()}>
              ব্যাকআপ নিন
            </Button>
          </>
        }
      />

      <Banner tone="warn">
        প্রাইভেট সাইনিং কী কখনো ব্যাকআপে থাকে না। এটি আলাদা করে সুরক্ষিত মিডিয়ায় রাখুন — কী হারালে নতুন কী দিয়ে সব লাইসেন্স
        পুনরায় ইস্যু করতে হবে।
      </Banner>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16 }}>
        <Card>
          <CardHead title="বর্তমান ডেটা" sub="এই মেশিনে সংরক্ষিত" />
          <div className="card-body">
            <KeyValue
              items={[
                { label: 'স্টোর ফাইল', value: info?.storePath ?? '—' },
                { label: 'লেজার ফাইল', value: info?.ledgerPath ?? '—' },
                { label: 'সর্বশেষ রপ্তানি', value: lastExport ? lastExport.file : '—' },
                { label: 'রপ্তানিকৃত', value: lastExport ? `${lastExport.customers} কাস্টমার • ${lastExport.licenses} লাইসেন্স` : '—' },
              ]}
            />
          </div>
        </Card>

        <Card>
          <CardHead
            title="ব্যাকআপ থেকে রিস্টোর"
            sub="আগে ফাইল পরিদর্শন করুন"
            actions={<Button size="sm" icon="upload" loading={busy === 'inspect'} onClick={() => void pickBackup()}>ফাইল বাছুন</Button>}
          />
          <div className="card-body">
            {!inspect ? (
              <div className="small muted">ব্যাকআপ ফাইল নির্বাচন করলে তার সারাংশ দেখা যাবে, তারপর রিস্টোর নিশ্চিত করতে হবে।</div>
            ) : (
              <>
                <KeyValue
                  items={[
                    { label: 'ফাইল', value: inspect.file },
                    { label: 'তৈরি', value: dt(inspect.created_at) },
                    { label: 'কাস্টমার', value: String(inspect.customers) },
                    { label: 'লাইসেন্স', value: String(inspect.licenses) },
                    { label: 'লেজার এন্ট্রি', value: String(inspect.ledger) },
                  ]}
                />
                <div className="row" style={{ marginTop: 12 }}>
                  <Button variant="danger" icon="database" loading={busy === 'restore'} onClick={() => void restore()}>
                    রিস্টোর করুন
                  </Button>
                  <Button variant="ghost" onClick={() => setInspect(null)}>
                    বাতিল
                  </Button>
                </div>
              </>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
