import { useState } from 'react';
import { call } from '../api.js';
import { useApp } from '../App.js';
import { Banner, Button, Card, CardHead, Field, KeyValue, PageHead, TextArea, dt, useUI } from '../ui.js';
import type { VerifyOutcome } from '../types.js';

export function VerifyPage() {
  const { keyStatus, navigate } = useApp();
  const ui = useUI();
  const [outcome, setOutcome] = useState<VerifyOutcome | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const verifyFile = async () => {
    setBusy(true);
    try {
      const res = await call<VerifyOutcome | null>('license.check');
      if (res) setOutcome(res);
    } catch (err) {
      ui.error('যাচাই ব্যর্থ', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const verifyText = async () => {
    if (!text.trim()) {
      ui.error('ফাইলের বিষয়বস্তু দিন');
      return;
    }
    setBusy(true);
    try {
      setOutcome(await call<VerifyOutcome>('license.checkText', text));
    } catch (err) {
      ui.error('যাচাই ব্যর্থ', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead
        title="লাইসেন্স যাচাই"
        sub="ফাইলের স্বাক্ষর, কী আইডি ও এই মেশিনের প্রত্যাহার রেকর্ড যাচাই করে"
        actions={
          <Button variant="primary" icon="upload" loading={busy} onClick={() => void verifyFile()}>
            ফাইল খুলুন
          </Button>
        }
      />

      {!keyStatus.loaded ? (
        <Banner tone="warn">
          সাইনিং কী লোড নেই — যাচাই এখনো সম্ভব (পাবলিক কী লাইসেন্সের সাথে থাকে), তবে কী আইডি মেলানো যাবে না।
        </Banner>
      ) : null}

      <Card>
        <CardHead title="ফলাফল" sub={outcome?.file ?? 'এখনো কোনো ফাইল যাচাই হয়নি'} />
        <div className="card-body">
          {!outcome ? (
            <div className="muted small">উপরে “ফাইল খুলুন” চাপুন অথবা নিচে ফাইলের বিষয়বস্তু পেস্ট করে যাচাই করুন।</div>
          ) : (
            <>
              <Banner tone={outcome.ok && !outcome.revoked ? 'success' : outcome.ok ? 'warn' : 'danger'}>{outcome.message}</Banner>
              {outcome.payload ? (
                <KeyValue
                  items={[
                    { label: 'লাইসেন্স আইডি', value: outcome.payload.license_id, mono: true },
                    { label: 'প্রতিষ্ঠান', value: outcome.payload.org },
                    { label: 'এডিশন', value: outcome.payload.edition },
                    { label: 'মেয়াদ', value: outcome.payload.expires_at ? dt(outcome.payload.expires_at) : 'লাইফটাইম' },
                    { label: 'ডিভাইস সীমা', value: String(outcome.payload.max_devices) },
                    { label: 'ফিঙ্গারপ্রিন্ট', value: outcome.payload.fingerprint, mono: true },
                    { label: 'ইস্যু', value: dt(outcome.payload.issued_at) },
                    { label: 'প্রত্যাহৃত', value: outcome.revoked ? 'হ্যাঁ' : 'না' },
                  ]}
                />
              ) : null}
              {outcome.payload ? (
                <div className="row" style={{ marginTop: 12 }}>
                  <Button size="sm" icon="license" onClick={() => navigate('licenses', { q: outcome.payload?.license_id })}>
                    রেকর্ডে দেখুন
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </Card>

      <Card>
        <CardHead title="বিষয়বস্তু পেস্ট করে যাচাই" sub="সাপোর্টে গ্রাহক ফাইল পাঠালে ব্যবহার করুন" />
        <div className="card-body">
          <Field label="লাইসেন্স JSON">
            <TextArea value={text} onChange={setText} rows={8} placeholder='{"format":"sauda-license", …}' />
          </Field>
          <div className="row" style={{ marginTop: 10 }}>
            <Button icon="check" loading={busy} onClick={() => void verifyText()}>
              যাচাই করুন
            </Button>
            <Button variant="ghost" onClick={() => { setText(''); setOutcome(null); }}>
              পরিষ্কার
            </Button>
          </div>
        </div>
      </Card>
    </>
  );
}
