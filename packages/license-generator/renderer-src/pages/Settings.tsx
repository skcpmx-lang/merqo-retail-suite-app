import { useEffect, useState } from 'react';
import { call } from '../api.js';
import { useApp } from '../App.js';
import { Button, Card, CardHead, Field, Input, KeyValue, PageHead, Segmented, Select, TextArea, useUI } from '../ui.js';
import type { Edition } from '../types.js';

interface Diagnostics {
  appVersion: string;
  generatorVersion: string;
  electron: string;
  node: string;
  platform: string;
  userData: string;
  storePath: string;
  ledgerPath: string;
  keyPath: string;
  storeExists: boolean;
  ledgerExists: boolean;
  ledgerLines: number;
}

interface SettingsShape {
  theme: 'light' | 'dark';
  admin_name: string;
  default_edition: Edition;
  default_expiry_days: number;
  company_footer: string;
}

export function SettingsPage() {
  const { theme, setTheme, info } = useApp();
  const ui = useUI();
  const [settings, setSettings] = useState<SettingsShape | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void call<SettingsShape>('settings.get')
      .then(setSettings)
      .catch((err) => ui.error('সেটিংস লোড ব্যর্থ', (err as Error).message));
    void call<Diagnostics>('diagnostics.get')
      .then(setDiagnostics)
      .catch(() => setDiagnostics(null));
  }, [ui]);

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      await call('settings.update', settings);
      await setTheme(settings.theme);
      ui.success('সেটিংস সংরক্ষিত');
    } catch (err) {
      ui.error('সংরক্ষণ ব্যর্থ', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHead
        title="সেটিংস"
        sub="ডিফল্ট মান, নথির ফুটার ও অ্যাডমিন পরিচয়"
        actions={
          <Button variant="primary" icon="check" loading={saving} onClick={() => void save()} disabled={!settings}>
            সংরক্ষণ
          </Button>
        }
      />

      {settings ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)', gap: 16 }}>
          <Card>
            <CardHead title="পছন্দ" sub="শুধু এই মেশিনে প্রযোজ্য" />
            <div className="card-body form-grid">
              <Field label="থিম" span={2}>
                <Segmented
                  value={settings.theme}
                  onChange={(v) => setSettings({ ...settings, theme: v })}
                  options={[
                    { value: 'light', label: 'লাইট' },
                    { value: 'dark', label: 'ডার্ক' },
                  ]}
                />
              </Field>
              <Field label="অ্যাডমিনের নাম" span={2}>
                <Input value={settings.admin_name} onChange={(v) => setSettings({ ...settings, admin_name: v })} placeholder="যেমন: শোহান খান" />
              </Field>
              <Field label="ডিফল্ট এডিশন">
                <Select
                  value={settings.default_edition}
                  onChange={(v) => setSettings({ ...settings, default_edition: v as Edition })}
                  options={[
                    { value: 'standard', label: 'Standard' },
                    { value: 'pro', label: 'Pro' },
                    { value: 'enterprise', label: 'Enterprise' },
                  ]}
                />
              </Field>
              <Field label="ডিফল্ট মেয়াদ (দিন)" hint="০ = লাইফটাইম">
                <Input
                  value={settings.default_expiry_days}
                  onChange={(v) => setSettings({ ...settings, default_expiry_days: Math.max(0, Number(v.replace(/\D/g, '')) || 0) })}
                />
              </Field>
              <Field label="নথির ফুটার" span={2} hint="সার্টিফিকেট ও রিপোর্টের নিচে ছাপা হবে">
                <TextArea value={settings.company_footer} onChange={(v) => setSettings({ ...settings, company_footer: v })} rows={2} />
              </Field>
            </div>
          </Card>

          <Card>
            <CardHead title="সিস্টেম তথ্য" />
            <div className="card-body">
              <KeyValue
                items={[
                  { label: 'জেনারেটর', value: info?.generatorVersion ?? '—' },
                  { label: 'মেইন অ্যাপ সংস্করণ', value: info?.appVersion ?? '—' },
                  { label: 'প্ল্যাটফর্ম', value: info?.platform ?? '—' },
                  { label: 'স্টোর', value: info?.storePath ?? '—' },
                  { label: 'লেজার', value: info?.ledgerPath ?? '—' },
                ]}
              />
              <div className="small muted" style={{ marginTop: 12 }}>
                থিম বদলালে সাথে সাথে প্রযোজ্য হবে; বাকি মান নতুন লাইসেন্স ইস্যুর ডিফল্ট হিসেবে ব্যবহৃত হয়।
              </div>
            </div>
          </Card>
        </div>
      ) : (
        <div className="muted small">লোড হচ্ছে…</div>
      )}

      <Card>
        <CardHead title="ডায়াগনস্টিকস" sub="সাপোর্টের জন্য — কোনো গোপন কী এখানে দেখানো হয় না" />
        <div className="card-body">
          <KeyValue
            items={[
              { label: 'সংস্করণ', value: diagnostics ? `${diagnostics.generatorVersion} (কোর ${diagnostics.appVersion})` : '—' },
              { label: 'Electron / Node', value: diagnostics ? `${diagnostics.electron} / ${diagnostics.node}` : '—' },
              { label: 'ডেটা ফাইল', value: diagnostics ? (diagnostics.storeExists ? diagnostics.storePath : 'তৈরি হয়নি') : '—' },
              { label: 'লেজার', value: diagnostics ? `${diagnostics.ledgerLines} এন্ট্রি · ${diagnostics.ledgerExists ? 'পাওয়া গেছে' : 'নেই'}` : '—' },
              { label: 'কী ফাইল', value: diagnostics?.keyPath ?? '—' },
            ]}
          />
        </div>
      </Card>

      <Card>
        <CardHead title="এই অ্যাপ সম্পর্কে" />
        <div className="card-body small muted">
          Sauda License Generator — Sauda Retail Suite-এর জন্য অফলাইন লাইসেন্স প্রশাসন (Ed25519 স্বাক্ষর)। এখানে তৈরি প্রতিটি
          ফাইল সাউদা মেইন অ্যাপ্লিকেশন গ্রহণ করে; কোনো ইন্টারনেট বা ক্লাউড নির্ভরতা নেই।
        </div>
      </Card>
    </>
  );
}
