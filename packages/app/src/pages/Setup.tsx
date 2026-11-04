import { useState } from 'react';
import { call } from '../api.js';
import { SaudaLogo } from '../icons.js';
import { Banner, Button, Field, Select, TextInput } from '../ui.js';

export function SetupPage({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    businessName: '',
    businessAddress: '',
    businessPhone: '',
    businessEmail: '',
    adminFullName: '',
    adminUsername: 'admin',
    adminPassword: '',
    adminPassword2: '',
    receiptWidth: '80',
    invoicePrefix: 'INV',
    currencySymbol: '৳',
    loginLockEnabled: true,
    language: 'bn' as 'bn' | 'en',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<typeof form>) => setForm((prev) => ({ ...prev, ...patch }));

  const submit = async () => {
    setError(null);
    if (!form.businessName.trim()) {
      setError('দোকান বা প্রতিষ্ঠানের নাম দিতে হবে।');
      setStep(0);
      return;
    }
    if (!form.adminFullName.trim()) {
      setError('অ্যাডমিনের পুরো নাম দিতে হবে।');
      setStep(1);
      return;
    }
    if (form.adminPassword.length < 6) {
      setError('পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে।');
      setStep(1);
      return;
    }
    if (form.adminPassword !== form.adminPassword2) {
      setError('দুটি পাসওয়ার্ড মিলছে না।');
      setStep(1);
      return;
    }
    setBusy(true);
    try {
      await call('setup.initialize', {
        businessName: form.businessName,
        businessAddress: form.businessAddress,
        businessPhone: form.businessPhone,
        businessEmail: form.businessEmail,
        adminFullName: form.adminFullName,
        adminUsername: form.adminUsername,
        adminPassword: form.adminPassword,
        receiptWidth: Number(form.receiptWidth) as 58 | 80,
        invoicePrefix: form.invoicePrefix,
        currencySymbol: form.currencySymbol,
        loginLockEnabled: form.loginLockEnabled,
        language: form.language,
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate-wrap">
      <div className="login-card" style={{ width: 'min(560px,100%)' }}>
        <div className="row" style={{ gap: 12, marginBottom: 12 }}>
          <SaudaLogo size={44} />
          <div>
            <h1 style={{ fontSize: 19 }}>সাউদা সেটআপ</h1>
            <p className="muted small" style={{ margin: 0 }}>
              প্রথমবার চালু হচ্ছে — দোকানের তথ্য ও অ্যাডমিন অ্যাকাউন্ট তৈরি করুন।
            </p>
          </div>
        </div>

        <div className="row" style={{ gap: 6, marginBottom: 16 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="progress grow">
              <i style={{ width: i <= step ? '100%' : '0%' }} />
            </div>
          ))}
        </div>

        {error ? (
          <Banner tone="danger" icon="warning">
            {error}
          </Banner>
        ) : null}

        {step === 0 ? (
          <div className="form-grid">
            <Field label="দোকান / প্রতিষ্ঠানের নাম *" span={2}>
              <TextInput
                value={form.businessName}
                onChange={(v) => set({ businessName: v })}
                placeholder="যেমন: করিম জেনারেল স্টোর"
                autoFocus
              />
            </Field>
            <Field label="ঠিকানা" span={2}>
              <TextInput
                value={form.businessAddress}
                onChange={(v) => set({ businessAddress: v })}
                placeholder="যেমন: বাজার রোড, টাঙ্গাইল"
              />
            </Field>
            <Field label="মোবাইল নম্বর">
              <TextInput value={form.businessPhone} onChange={(v) => set({ businessPhone: v })} placeholder="01XXXXXXXXX" />
            </Field>
            <Field label="ইমেইল">
              <TextInput value={form.businessEmail} onChange={(v) => set({ businessEmail: v })} placeholder="shop@example.com" />
            </Field>
          </div>
        ) : null}

        {step === 1 ? (
          <div className="form-grid">
            <Field label="অ্যাডমিনের পুরো নাম *" span={2}>
              <TextInput value={form.adminFullName} onChange={(v) => set({ adminFullName: v })} placeholder="যেমন: মোঃ করিম" autoFocus />
            </Field>
            <Field label="ইউজারনেম *" hint="ছোট হাতের ইংরেজি অক্ষর ও সংখ্যা">
              <TextInput value={form.adminUsername} onChange={(v) => set({ adminUsername: v.toLowerCase() })} />
            </Field>
            <Field label="পাসওয়ার্ড *" hint="কমপক্ষে ৬ অক্ষর">
              <TextInput type="password" value={form.adminPassword} onChange={(v) => set({ adminPassword: v })} />
            </Field>
            <Field label="পাসওয়ার্ড আবার লিখুন *" span={2}>
              <TextInput type="password" value={form.adminPassword2} onChange={(v) => set({ adminPassword2: v })} />
            </Field>
            <Field label="সফটওয়্যার লক" span={2} hint="একক ব্যবহারকারীর দোকানে বন্ধ রাখতে পারেন — পরে সেটিংস থেকে চালু করা যাবে">
              <div className="seg-toggle" role="group" aria-label="সফটওয়্যার লক">
                <button className={form.loginLockEnabled ? 'on' : ''} onClick={() => set({ loginLockEnabled: true })}>
                  পাসওয়ার্ড চাইব
                </button>
                <button className={!form.loginLockEnabled ? 'on' : ''} onClick={() => set({ loginLockEnabled: false })}>
                  লক বন্ধ
                </button>
              </div>
            </Field>
            <Field label="ভাষা" span={2}>
              <div className="seg-toggle" role="group" aria-label="ভাষা">
                <button className={form.language === 'bn' ? 'on' : ''} onClick={() => set({ language: 'bn' })}>
                  বাংলা
                </button>
                <button className={form.language === 'en' ? 'on' : ''} onClick={() => set({ language: 'en' })}>
                  English
                </button>
              </div>
            </Field>
            <div className="span-2">
              <Banner tone="info" icon="shield">
                {form.loginLockEnabled
                  ? 'অ্যাডমিন সব ধরনের কাজ করতে পারবেন। পরে সেটিংস থেকে ক্যাশিয়ার অ্যাকাউন্ট তৈরি করা যাবে।'
                  : 'লক বন্ধ থাকলেও অ্যাডমিন পাসওয়ার্ড সংরক্ষিত থাকবে — পরে লক চালু করলেই কাজে লাগবে। অনুমতি ও লাইসেন্স অপরিবর্তিত থাকবে।'}
              </Banner>
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="form-grid">
            <Field label="রিসিট প্রস্থ">
              <Select
                value={form.receiptWidth}
                onChange={(v) => set({ receiptWidth: v })}
                options={[
                  { value: '58', label: '৫৮ মিমি থার্মাল' },
                  { value: '80', label: '৮০ মিমি থার্মাল' },
                ]}
              />
            </Field>
            <Field label="ইনভয়েস প্রিফিক্স">
              <TextInput value={form.invoicePrefix} onChange={(v) => set({ invoicePrefix: v.toUpperCase() })} />
            </Field>
            <Field label="মুদ্রা চিহ্ন" span={2}>
              <TextInput value={form.currencySymbol} onChange={(v) => set({ currencySymbol: v })} maxLength={3} />
            </Field>
            <div className="span-2">
              <Banner tone="success" icon="check">
                সব তথ্য প্রস্তুত। “শুরু করুন” চাপলে দোকানের অ্যাকাউন্ট তৈরি হবে — এটি কোনো ডেমো ডেটা যোগ করবে না।
              </Banner>
            </div>
          </div>
        ) : null}

        <div className="row" style={{ justifyContent: 'space-between', marginTop: 18 }}>
          <Button variant="ghost" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>
            পূর্ববর্তী
          </Button>
          {step < 2 ? (
            <Button variant="primary" onClick={() => setStep((s) => s + 1)} icon="chevronRight">
              পরবর্তী
            </Button>
          ) : (
            <Button variant="primary" loading={busy} onClick={submit} icon="check">
              শুরু করুন
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
