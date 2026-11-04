import { useState } from 'react';
import { call, copyText } from '../api.js';
import { useApp } from '../App.js';
import { Banner, Button, Card, CardHead, Field, Icon, KeyValue, PageHead, useUI } from '../ui.js';

export function SecurityPage() {
  const { keyStatus, refreshKey } = useApp();
  const ui = useUI();
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setBusy('load');
    try {
      const res = await call<{ keyId: string } | null>('key.load');
      if (res) {
        await refreshKey();
        ui.success('কী লোড হয়েছে', res.keyId);
      }
    } catch (err) {
      ui.error('কী লোড ব্যর্থ', (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    const res = await ui.confirm({
      title: 'কী সরাবেন?',
      message: 'কী সরালে লাইসেন্স ইস্যু/রি-ইস্যু বন্ধ থাকবে, কিন্তু পুরোনো রেকর্ড ও যাচাই অপরিবর্তিত থাকবে।',
      confirmLabel: 'সরান',
      danger: true,
    });
    if (!res.ok) return;
    try {
      await call('key.clear');
      await refreshKey();
      ui.success('কী সরানো হয়েছে');
    } catch (err) {
      ui.error('ব্যর্থ', (err as Error).message);
    }
  };

  return (
    <>
      <PageHead
        title="সিকিউরিটি ও কী"
        sub="স্বাক্ষর কী কখনো ডিস্কে বা রিপোর্টে সংরক্ষিত হয় না — শুধু ফাইলের পাথ মনে রাখা হয়"
        actions={
          <>
            <Button icon="upload" loading={busy === 'load'} onClick={() => void load()}>
              প্রাইভেট কী লোড
            </Button>
            <Button variant="ghost" icon="close" onClick={() => void clear()} disabled={!keyStatus.loaded}>
              কী সরান
            </Button>
          </>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16 }}>
        <Card>
          <CardHead title="কী স্ট্যাটাস" sub={keyStatus.loaded ? 'স্বাক্ষরের জন্য প্রস্তুত' : 'কী লোড করা নেই'} />
          <div className="card-body">
            {keyStatus.loaded ? (
              <>
                <Banner tone="success">Ed25519 কী লোড হয়েছে — লাইসেন্স স্বাক্ষর করা যাবে।</Banner>
                <KeyValue
                  items={[
                    { label: 'কী আইডি', value: keyStatus.keyId ?? '—', mono: true },
                    { label: 'অ্যালগরিদম', value: 'Ed25519 (PKCS#8)' },
                    { label: 'কী ফাইল', value: keyStatus.path ?? '—' },
                  ]}
                />
                <div style={{ marginTop: 12 }}>
                  <Field label="পাবলিক কী (মেইন অ্যাপে এমবেড থাকে)">
                    <div className="mono" style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 8, padding: 10, wordBreak: 'break-all', maxHeight: 120, overflow: 'auto' }}>
                      {keyStatus.publicKeyB64}
                    </div>
                  </Field>
                  <div className="row" style={{ marginTop: 8 }}>
                    <Button size="sm" icon="copy" onClick={() => void copyText(keyStatus.publicKeyB64 ?? '').then(() => ui.success('পাবলিক কী কপি হয়েছে'))}>
                      কপি
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <>
                <Banner tone="danger">সাইনিং কী নেই — কোনো লাইসেন্স স্বাক্ষর করা যাবে না।</Banner>
                <div className="small muted">
                  প্রোডাকশন কী সুরক্ষিত মিডিয়ায় রাখুন। কী কখনো রিপোজিটরি, ইনস্টলার বা ক্লায়েন্ট অ্যাপে রাখা যাবে না।
                </div>
              </>
            )}
          </div>
        </Card>

        <Card>
          <CardHead title="নীতিমালা" sub="যে নিয়মগুলো এই অ্যাপ নিজে মেনে চলে" />
          <div className="card-body small" style={{ display: 'grid', gap: 10 }}>
            {[
              'প্রাইভেট কী কখনো JSON স্টোরে, লেজারে বা রেন্ডারারে যায় না।',
              'প্রতিটি লাইসেন্স স্বাক্ষরের পরপরই পাবলিক কী দিয়ে যাচাই হয়; ব্যর্থ হলে ফাইল তৈরি হয় না।',
              'স্বাক্ষরিত পেলোড কখনো এডিট হয় না — বদল দরকার হলে রি-ইস্যু, পুরোনোটি প্রতিস্থাপিত হিসেবে বন্ধ।',
              'প্রত্যাহার শুধু স্থানীয় রেকর্ডে কাজ করে (অফলাইন পণ্য) — এটিই প্রকৃত সীমা, গোপন করা হয় না।',
              'প্রতিটি ইস্যু/রি-ইস্যু/প্রত্যাহার লেজারে অ্যাপেন্ড হয়, মুছে ফেলা যায় না।',
            ].map((line) => (
              <div key={line} className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
                <Icon name="check" size={14} />
                <span>{line}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card>
        <CardHead title="কী রোটেশন" sub="কী বদলালে কী করতে হবে" />
        <div className="card-body small muted" style={{ display: 'grid', gap: 8 }}>
          <div>১. নতুন Ed25519 কী তৈরি করুন এবং পুরোনোটি আর্কাইভে রাখুন (আইনগত প্রয়োজনে)।</div>
          <div>২. নতুন পাবলিক কী মেইন অ্যাপ্লিকেশন রিলিজে আপডেট করুন — পুরোনো পাবলিক কী দিয়ে স্বাক্ষরিত লাইসেন্স আর গ্রহণযোগ্য হবে না, তাই কেবল নতুন ইস্যুতে এটি করুন।</div>
          <div>৩. এই জেনারেটরে নতুন প্রাইভেট কী লোড করে পরবর্তী সব লাইসেন্স ইস্যু করুন; পুরোনো রেকর্ডের কী আইডি ইতিহাসে থাকবে।</div>
        </div>
      </Card>
    </>
  );
}
