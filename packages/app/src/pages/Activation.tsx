import { useEffect, useState } from 'react';
import { call } from '../api.js';
import { SaudaLogo, Icon } from '../icons.js';
import { Banner, Button, Field, TextInput } from '../ui.js';
import type { ActivationState } from '../types.js';

const REASON_TEXT: Record<string, string> = {
  not_activated: 'অ্যাপ্লিকেশনটি এখনো অ্যাক্টিভেট করা হয়নি।',
  signature_invalid: 'লাইসেন্স স্বাক্ষর সঠিক নয় — ফাইলটি পরিবর্তিত হয়েছে।',
  schema_invalid: 'লাইসেন্স ফাইলের কাঠামো সঠিক নয়।',
  expired: 'লাইসেন্সের মেয়াদ শেষ হয়েছে।',
  device_mismatch: 'এই লাইসেন্স অন্য কম্পিউটারের জন্য তৈরি করা হয়েছে।',
  org_mismatch: 'লাইসেন্সের প্রতিষ্ঠানের নাম মিলছে না।',
  clock_tamper: 'সিস্টেমের তারিখ পিছিয়ে দেওয়া হয়েছে।',
  error: 'লাইসেন্স যাচাই করতে সমস্যা হয়েছে।',
};

export function ActivationPage({ state, onActivated }: { state: ActivationState; onActivated: () => void }) {
  const [tab, setTab] = useState<'key' | 'file'>('key');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [device, setDevice] = useState<{ hash: string; components: any[]; platform: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    call<any>('license.fingerprint')
      .then(setDevice)
      .catch(() => setDevice(null));
  }, []);

  const activateKey = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await call<ActivationState>('license.activateKey', key.trim());
      if (!result.activated) setError(result.message);
      else onActivated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const activateFile = async () => {
    setBusy(true);
    setError(null);
    try {
      const picked = await call<{ path: string; content: string } | null>('license.pickFile');
      if (!picked) return;
      const result = await call<ActivationState>('license.activateFile', picked.content);
      if (!result.activated) setError(result.message);
      else onActivated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const exportRequest = async () => {
    try {
      const path = await call<string | null>('license.exportRequest');
      if (path) {
        setError(null);
        setNotice(`ডিভাইস রিকোয়েস্ট সংরক্ষিত হয়েছে: ${path}`);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const copyDeviceId = async () => {
    if (!device) return;
    const id = device.hash.slice(0, 16).toUpperCase().match(/.{1,4}/g)?.join('-') ?? device.hash;
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('কপি করা যায়নি। ডিভাইস আইডি হাতে লিখে নিন।');
    }
  };

  const badge = state.activated
    ? { tone: 'success' as const, text: 'সক্রিয়' }
    : { tone: 'danger' as const, text: 'নিষ্ক্রিয়' };

  return (
    <div className="gate-wrap">
      <div className="gate-card">
        <div className="gate-side">
          <SaudaLogo size={48} />
          <h2>সাউদা রিটেইল স্যুট</h2>
          <p>
            অফলাইন রিটেইল POS ও ব্যবসা ব্যবস্থাপনা সফটওয়্যার। লাইসেন্স অ্যাক্টিভেশন সম্পূর্ণ অফলাইনে
            কাজ করে — কোনো ইন্টারনেট সংযোগের প্রয়োজন নেই।
          </p>
          <div className="divider" style={{ background: 'rgba(255,255,255,.16)' }} />
          <div className="small" style={{ color: '#a9d5ca' }}>
            <div className="row" style={{ gap: 8 }}>
              <Icon name="shield" size={15} /> হার্ডওয়্যার-বাউন্ড লাইসেন্স
            </div>
            <div className="row" style={{ gap: 8, marginTop: 6 }}>
              <Icon name="lock" size={15} /> স্বাক্ষর যাচাই (Ed25519)
            </div>
            <div className="row" style={{ gap: 8, marginTop: 6 }}>
              <Icon name="backup" size={15} /> লাইফটাইম ব্যবহার, কোনো সাবস্ক্রিপশন নেই
            </div>
          </div>
          <div style={{ marginTop: 'auto', fontSize: 11, color: '#7fb3a6' }}>
            MERQO • merqoonline@gmail.com
          </div>
        </div>
        <div className="gate-main">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2>লাইসেন্স অ্যাক্টিভেশন</h2>
            <span className={`badge ${badge.tone === 'success' ? 'green' : 'red'}`}>{badge.text}</span>
          </div>
          <p className="muted small" style={{ marginTop: 4 }}>
            {REASON_TEXT[state.reason] ?? state.message}
          </p>

          <div className="seg" style={{ margin: '14px 0' }}>
            <button className={tab === 'key' ? 'active' : ''} onClick={() => setTab('key')}>
              লাইসেন্স কী
            </button>
            <button className={tab === 'file' ? 'active' : ''} onClick={() => setTab('file')}>
              লাইসেন্স ফাইল
            </button>
          </div>

          {error ? (
            <Banner tone="danger" icon="warning">
              {error}
            </Banner>
          ) : null}
          {notice ? (
            <Banner tone="success" icon="check">
              {notice}
            </Banner>
          ) : null}

          {tab === 'key' ? (
            <div className="col">
              <Field label="লাইসেন্স কী" hint="আপনার দেওয়া লম্বা কী-টি এখানে পেস্ট করুন (SAUDA1.… দিয়ে শুরু)">
                <textarea
                  className="input"
                  rows={4}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="SAUDA1.eyJ2IjoxLCJsaWNlbnNlX2lkIjoi..."
                  spellCheck={false}
                  style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5 }}
                />
              </Field>
              <Button variant="primary" block loading={busy} onClick={activateKey} icon="key">
                অ্যাক্টিভেট করুন
              </Button>
            </div>
          ) : (
            <div className="col">
              <p className="small muted" style={{ margin: 0 }}>
                সেলার আপনাকে যে <code>.sauda</code> বা <code>.sauda-license</code> ফাইল দিয়েছেন সেটি নির্বাচন করুন।
              </p>
              <Button variant="primary" block loading={busy} onClick={activateFile} icon="upload">
                লাইসেন্স ফাইল লোড করুন
              </Button>
            </div>
          )}

          <div className="divider" />
          <div className="section-title">এই কম্পিউটারের ডিভাইস আইডি</div>
          <div
            className="row"
            style={{
              background: 'var(--surface-2)',
              border: '1px solid var(--line)',
              borderRadius: 10,
              padding: '9px 11px',
              justifyContent: 'space-between',
            }}
          >
            <span className="mono" style={{ letterSpacing: 0.5 }}>
              {device
                ? (device.hash.slice(0, 16).toUpperCase().match(/.{1,4}/g) ?? []).join('-')
                : 'সংগ্রহ করা হচ্ছে…'}
            </span>
            <button className="btn sm" onClick={copyDeviceId} disabled={!device}>
              {copied ? 'কপি হয়েছে' : 'কপি'}
            </button>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <Button icon="download" size="sm" onClick={exportRequest}>
              ডিভাইস রিকোয়েস্ট ফাইল সংরক্ষণ
            </Button>
            <span className="tiny muted">এই ফাইলটি সেলারকে পাঠান — লাইসেন্স তৈরির জন্য এটিই যথেষ্ট।</span>
          </div>
          <p className="tiny muted" style={{ marginTop: 6 }}>
            Windows নতুন করে ইনস্টল করলেও ডিভাইস আইডি অপরিবর্তিত থাকে। ফাইলে শুধু হার্ডওয়্যারের হ্যাশ থাকে, কোনো ব্যক্তিগত তথ্য নয়।
          </p>
          {device ? (
            <details style={{ marginTop: 6 }}>
              <summary className="small muted" style={{ cursor: 'pointer' }}>
                হার্ডওয়্যার উপাদান দেখুন
              </summary>
              <div className="col" style={{ gap: 4, marginTop: 6 }}>
                {device.components.map((c) => (
                  <div key={c.key} className="row small" style={{ justifyContent: 'space-between' }}>
                    <span className="muted">{c.label}</span>
                    <span className={c.available ? '' : 'muted'} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>
                      {c.value}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  );
}
