import { useEffect, useState } from 'react';
import { call } from '../api.js';
import { money, dateTime } from '../format.js';
import { Icon } from '../icons.js';
import {
  Badge,
  Banner,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  IconButton,
  Loading,
  Modal,
  MoneyInput,
  QtyInput,
  Select,
  Switch,
  Tabs,
  TextInput,
  useUI,
} from '../ui.js';
import type { ActivationState, AppSettings, User } from '../types.js';

type Section =
  | 'business'
  | 'receipt'
  | 'stock'
  | 'catalog'
  | 'users'
  | 'appearance'
  | 'network'
  | 'license'
  | 'diagnostics';

const PERM_LABELS: Record<string, string> = {
  'pos.sell': 'বিক্রয় (POS)',
  'pos.discount': 'ডিসকাউন্ট প্রয়োগ',
  'pos.price_edit': 'বিক্রয়ের সময় দাম পরিবর্তন',
  'product.view': 'প্রোডাক্ট দেখা',
  'product.manage': 'প্রোডাক্ট যোগ/সম্পাদনা',
  'product.delete': 'প্রোডাক্ট ডিলিট',
  'stock.adjust': 'স্টক সমন্বয়',
  'purchase.manage': 'পারচেজ',
  'customer.manage': 'কাস্টমার',
  'supplier.manage': 'সাপ্লায়ার',
  'expense.manage': 'এক্সপেন্স',
  'cash.manage': 'ক্যাশ রেজিস্টার',
  'return.manage': 'রিটার্ন',
  'report.view': 'রিপোর্ট',
  'settings.manage': 'সেটিংস',
  'user.manage': 'ইউজার ব্যবস্থাপনা',
  'backup.manage': 'ব্যাকআপ',
  'license.manage': 'লাইসেন্স',
  'audit.view': 'অডিট লগ',
};

export function SettingsPage({
  user,
  onChanged,
  onLicenseChanged,
}: {
  user: User;
  onChanged: () => Promise<void>;
  onLicenseChanged: () => Promise<void>;
}) {
  const ui = useUI();
  const [section, setSection] = useState<Section>('business');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      setSettings(await call<AppSettings>('settings.get'));
    } catch (err) {
      ui.error('সেটিংস লোড ব্যর্থ', (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patch = (p: Partial<AppSettings>) => setSettings((prev) => (prev ? { ...prev, ...p } : prev));

  const save = async (p: Partial<AppSettings>) => {
    setSaving(true);
    try {
      const next = await call<AppSettings>('settings.update', p);
      setSettings(next);
      await onChanged();
      ui.success('সেটিংস সংরক্ষিত হয়েছে');
    } catch (err) {
      ui.error('সংরক্ষণ ব্যর্থ', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading || !settings) return <Loading label="সেটিংস লোড হচ্ছে…" />;

  const isAdmin = user.role === 'admin';

  return (
    <>
      <div className="page-head">
        <div>
          <h1>সেটিংস</h1>
          <p>দোকানের তথ্য, রিসিট, স্টক নিয়ম, ইউজার ও লাইসেন্স — সব এক জায়গায়</p>
        </div>
      </div>

      <Card>
        <div className="toolbar">
          <Tabs
            active={section}
            onChange={setSection}
            tabs={[
              { id: 'business', label: 'ব্যবসা ও রিসিট' },
              { id: 'receipt', label: 'প্রিন্টার' },
              { id: 'stock', label: 'বিক্রয় ও স্টক নিয়ম' },
              { id: 'catalog', label: 'ক্যাটালগ' },
              { id: 'users', label: 'ইউজার' },
              { id: 'appearance', label: 'রূপ ও ভাষা' },
              { id: 'network', label: 'নেটওয়ার্ক ও ডিসপ্লে' },
              { id: 'license', label: 'লাইসেন্স' },
              { id: 'diagnostics', label: 'ডায়াগনস্টিক' },
            ]}
          />
        </div>

        {section === 'business' ? (
          <BusinessForm settings={settings} patch={patch} save={save} saving={saving} />
        ) : null}
        {section === 'receipt' ? (
          <ReceiptForm settings={settings} patch={patch} save={save} saving={saving} />
        ) : null}
        {section === 'stock' ? (
          <StockForm settings={settings} patch={patch} save={save} saving={saving} />
        ) : null}
        {section === 'catalog' ? <CatalogSection /> : null}
        {section === 'users' ? <UsersSection currentUser={user} /> : null}
        {section === 'appearance' ? (
          <AppearanceForm settings={settings} patch={patch} save={save} saving={saving} />
        ) : null}
        {section === 'network' ? <NetworkForm settings={settings} patch={patch} save={save} saving={saving} /> : null}
        {section === 'license' ? <LicenseSection onChanged={onLicenseChanged} isAdmin={isAdmin} /> : null}
        {section === 'diagnostics' ? <DiagnosticsSection /> : null}
      </Card>
    </>
  );
}

/* ------------------------------------------------------------------ */

function BusinessForm({
  settings,
  patch,
  save,
  saving,
}: {
  settings: AppSettings;
  patch: (p: Partial<AppSettings>) => void;
  save: (p: Partial<AppSettings>) => Promise<void>;
  saving: boolean;
}) {
  const ui = useUI();
  const [categories, setCategories] = useState<any[]>([]);
  const [units, setUnits] = useState<any[]>([]);
  const [methods, setMethods] = useState<any[]>([]);

  useEffect(() => {
    (async () => {
      const [c, u, m] = await Promise.all([
        call<any[]>('settings.categories'),
        call<any[]>('settings.units'),
        call<any[]>('settings.paymentMethods'),
      ]);
      setCategories(c);
      setUnits(u);
      setMethods(m);
    })().catch(() => undefined);
  }, []);

  const pickLogo = async () => {
    try {
      const path = await call<string | null>('settings.pickLogo');
      if (path) patch({ business_logo: path });
    } catch (err) {
      ui.error('লোগো যোগ ব্যর্থ', (err as Error).message);
    }
  };

  return (
    <div className="card-body">
      <div className="form-grid">
        <Field label="দোকান / প্রতিষ্ঠানের নাম" span={2}>
          <TextInput value={settings.business_name} onChange={(v) => patch({ business_name: v })} />
        </Field>
        <Field label="ঠিকানা" span={2}>
          <TextInput value={settings.business_address} onChange={(v) => patch({ business_address: v })} />
        </Field>
        <Field label="মোবাইল">
          <TextInput value={settings.business_phone} onChange={(v) => patch({ business_phone: v })} />
        </Field>
        <Field label="ইমেইল">
          <TextInput value={settings.business_email} onChange={(v) => patch({ business_email: v })} />
        </Field>
        <Field label="ওয়েবসাইট">
          <TextInput value={settings.business_website} onChange={(v) => patch({ business_website: v })} placeholder="www.example.com" />
        </Field>
        <Field label="প্রতিষ্ঠানের ধরন" hint="রিসিট ও রিপোর্টে ব্যবহৃত হয়">
          <TextInput value={settings.business_type} onChange={(v) => patch({ business_type: v })} placeholder="খুচরা দোকান" />
        </Field>
        <Field label="ডকুমেন্ট ফুটার" span={2} hint="A4 ইনভয়েস ও স্টেটমেন্টের নিচে ছাপা হবে">
          <TextInput value={settings.document_footer} onChange={(v) => patch({ document_footer: v })} />
        </Field>
        <Field label="মুদ্রা চিহ্ন">
          <TextInput value={settings.currency_symbol} onChange={(v) => patch({ currency_symbol: v })} maxLength={3} />
        </Field>
        <Field label="বাংলা সংখ্যা" hint="ইন্টারফেসে ০-৯ দেখাবে">
          <Switch checked={settings.bengali_digits === 1} onChange={(v) => patch({ bengali_digits: v ? 1 : 0 })} label="বাংলা অঙ্ক চালু" />
        </Field>
        <Field label="লোগো" span={2}>
          <div className="row" style={{ gap: 8 }}>
            <span className="small muted" style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {settings.business_logo ?? 'কোনো লোগো নেই'}
            </span>
            <Button size="sm" icon="upload" onClick={pickLogo}>
              লোগো নির্বাচন
            </Button>
            {settings.business_logo ? (
              <Button size="sm" variant="ghost" onClick={() => patch({ business_logo: null })}>
                সরান
              </Button>
            ) : null}
          </div>
        </Field>
      </div>

      <div className="section-title" style={{ marginTop: 16 }}>
        ইনভয়েস ও ডিফল্ট
      </div>
      <div className="form-grid">
        <Field label="ইনভয়েস প্রিফিক্স">
          <TextInput value={settings.invoice_prefix} onChange={(v) => patch({ invoice_prefix: v.toUpperCase() })} />
        </Field>
        <Field label="ইনভয়েস ফরম্যাট">
          <TextInput value={settings.invoice_format} onChange={(v) => patch({ invoice_format: v })} />
        </Field>
        <Field label="পারচেজ প্রিফিক্স">
          <TextInput value={settings.purchase_prefix} onChange={(v) => patch({ purchase_prefix: v.toUpperCase() })} />
        </Field>
        <Field label="রিটার্ন প্রিফিক্স">
          <TextInput value={settings.return_prefix} onChange={(v) => patch({ return_prefix: v.toUpperCase() })} />
        </Field>
        <Field label="ডিফল্ট ক্যাটাগরি">
          <Select
            value={settings.default_category_id ?? ''}
            onChange={(v) => patch({ default_category_id: v ? Number(v) : null })}
            options={categories.map((c) => ({ value: c.id, label: c.name }))}
            placeholder="নেই"
          />
        </Field>
        <Field label="ডিফল্ট ইউনিট">
          <Select
            value={settings.default_unit_id ?? ''}
            onChange={(v) => patch({ default_unit_id: v ? Number(v) : null })}
            options={units.map((u) => ({ value: u.id, label: u.name }))}
            placeholder="নেই"
          />
        </Field>
        <Field label="ডিফল্ট পেমেন্ট মাধ্যম">
          <Select
            value={settings.default_payment_method_id ?? ''}
            onChange={(v) => patch({ default_payment_method_id: v ? Number(v) : null })}
            options={methods.map((m) => ({ value: m.id, label: m.name }))}
            placeholder="নেই"
          />
        </Field>
      </div>

      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
        <Button variant="primary" loading={saving} icon="check" onClick={() => void save(settings)}>
          সংরক্ষণ করুন
        </Button>
      </div>
    </div>
  );
}

function ReceiptForm({
  settings,
  patch,
  save,
  saving,
}: {
  settings: AppSettings;
  patch: (p: Partial<AppSettings>) => void;
  save: (p: Partial<AppSettings>) => Promise<void>;
  saving: boolean;
}) {
  const ui = useUI();
  const [printers, setPrinters] = useState<any[]>([]);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    call<any[]>('print.printers')
      .then(setPrinters)
      .catch(() => setPrinters([]));
  }, []);

  const test = async () => {
    setTesting(true);
    try {
      const res = await call<any>('print.test');
      ui.success('টেস্ট রিসিট পাঠানো হয়েছে', res?.printer);
    } catch (err) {
      ui.error('প্রিন্ট ব্যর্থ', (err as Error).message);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="card-body">
      {printers.length === 0 ? (
        <Banner tone="warn" icon="warning">
          কোনো প্রিন্টার পাওয়া যায়নি। Windows এর Settings → Printers এ থার্মাল প্রিন্টার যোগ করে আবার এই পাতা খুলুন।
        </Banner>
      ) : null}
      <div className="form-grid">
        <Field label="রিসিট প্রস্থ">
          <Select
            value={String(settings.receipt_width)}
            onChange={(v) => patch({ receipt_width: Number(v) as 58 | 80 })}
            options={[
              { value: '58', label: '৫৮ মিমি' },
              { value: '80', label: '৮০ মিমি' },
            ]}
          />
        </Field>
        <Field label="ফন্ট সাইজ (px)">
          <TextInput
            value={settings.receipt_font_size}
            onChange={(v) => patch({ receipt_font_size: Number(v.replace(/[^\d]/g, '')) || 10 })}
          />
        </Field>
        <Field label="প্রিন্টার" span={2} hint="খালি রাখলে Windows এর ডিফল্ট প্রিন্টার ব্যবহার হবে">
          <Select
            value={settings.printer_name ?? ''}
            onChange={(v) => patch({ printer_name: v })}
            options={printers.map((p) => ({ value: p.name, label: `${p.displayName}${p.isDefault ? ' (ডিফল্ট)' : ''}` }))}
            placeholder="সিস্টেম ডিফল্ট"
          />
        </Field>
        <Field label="রিসিট হেডার" span={2}>
          <TextInput value={settings.receipt_header} onChange={(v) => patch({ receipt_header: v })} placeholder="যেমন: ধন্যবাদ, আবার আসবেন" />
        </Field>
        <Field label="রিসিট ফুটার" span={2}>
          <TextInput value={settings.receipt_footer} onChange={(v) => patch({ receipt_footer: v })} placeholder="যেমন: মোবাইল ০১৭XXXXXXXX" />
        </Field>
        <Field label="রিসিটে লোগো">
          <Switch checked={settings.receipt_show_logo === 1} onChange={(v) => patch({ receipt_show_logo: v ? 1 : 0 })} label="লোগো ছাপাবে" />
        </Field>
        <Field label="বিক্রয়ের পর স্বয়ংক্রিয় প্রিন্ট">
          <Switch checked={settings.print_after_sale === 1} onChange={(v) => patch({ print_after_sale: v ? 1 : 0 })} label="প্রিন্ট করুন" />
        </Field>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <Button icon="print" loading={testing} onClick={test}>
          টেস্ট প্রিন্ট
        </Button>
        <Button variant="primary" loading={saving} icon="check" onClick={() => void save(settings)}>
          সংরক্ষণ করুন
        </Button>
      </div>
    </div>
  );
}

function StockForm({
  settings,
  patch,
  save,
  saving,
}: {
  settings: AppSettings;
  patch: (p: Partial<AppSettings>) => void;
  save: (p: Partial<AppSettings>) => Promise<void>;
  saving: boolean;
}) {
  return (
    <div className="card-body">
      <div className="form-grid">
        <Field label="ঋণাত্মক স্টকে বিক্রয়">
          <Switch
            checked={settings.allow_negative_stock === 1}
            onChange={(v) => patch({ allow_negative_stock: v ? 1 : 0 })}
            label="অনুমতি দিন"
          />
        </Field>
        <Field label="বাকিতে বিক্রয়">
          <Switch checked={settings.allow_due_sale === 1} onChange={(v) => patch({ allow_due_sale: v ? 1 : 0 })} label="অনুমতি দিন" />
        </Field>
        <Field label="সর্বোচ্চ ডিসকাউন্ট (%)" hint="ক্যাশিয়ার এই সীমার বেশি ছাড় দিতে পারবে না">
          <TextInput
            value={settings.max_discount_percent_x100 / 100}
            onChange={(v) => patch({ max_discount_percent_x100: Math.round((Number(v.replace(/[^\d.]/g, '')) || 0) * 100) })}
          />
        </Field>
        <Field label="ডিফল্ট ভ্যাট (%)">
          <TextInput
            value={settings.vat_percent_x100 / 100}
            onChange={(v) => patch({ vat_percent_x100: Math.round((Number(v.replace(/[^\d.]/g, '')) || 0) * 100) })}
          />
        </Field>
        <Field label="স্টক অ্যালার্ট থ্রেশহোল্ড">
          <QtyInput value={settings.stock_alert_threshold_milli} onChange={(v) => patch({ stock_alert_threshold_milli: v })} />
        </Field>
        <Field label="স্ক্যানে পরিমাণ বাড়ানো">
          <Switch checked={settings.scan_increment_qty === 1} onChange={(v) => patch({ scan_increment_qty: v ? 1 : 0 })} label="বারকোড স্ক্যানে ১ যোগ হবে" />
        </Field>
        <Field label="সেশন টাইমআউট (মিনিট)" hint="০ = কখনো নয়">
          <TextInput
            value={settings.session_timeout_minutes}
            onChange={(v) => patch({ session_timeout_minutes: Number(v.replace(/[^\d]/g, '')) || 0 })}
          />
        </Field>
        <Field label="কম মার্জিন সতর্কতা (%)">
          <TextInput
            value={settings.low_margin_warn_percent_x100 / 100}
            onChange={(v) => patch({ low_margin_warn_percent_x100: Math.round((Number(v.replace(/[^\d.]/g, '')) || 0) * 100) })}
          />
        </Field>
      </div>

      <div className="section-title" style={{ marginTop: 16 }}>
        স্বয়ংক্রিয় ব্যাকআপ
      </div>
      <div className="form-grid">
        <Field label="স্বয়ংক্রিয় ব্যাকআপ">
          <Switch checked={settings.auto_backup_enabled === 1} onChange={(v) => patch({ auto_backup_enabled: v ? 1 : 0 })} label="চালু" />
        </Field>
        <Field label="কত ঘন ঘন">
          <Select
            value={settings.auto_backup_interval}
            onChange={(v) => patch({ auto_backup_interval: v as any })}
            options={[
              { value: 'off', label: 'বন্ধ' },
              { value: 'daily', label: 'প্রতিদিন' },
              { value: 'weekly', label: 'সাপ্তাহিক' },
              { value: 'monthly', label: 'মাসিক' },
            ]}
          />
        </Field>
        <Field label="কতটি ব্যাকআপ রাখবেন">
          <TextInput
            value={settings.backup_keep_count}
            onChange={(v) => patch({ backup_keep_count: Number(v.replace(/[^\d]/g, '')) || 10 })}
          />
        </Field>
        <Field label="ব্যাকআপ ফোল্ডার" hint="খালি রাখলে অ্যাপের ডেটা ফোল্ডার ব্যবহার হবে" span={2}>
          <TextInput value={settings.auto_backup_dir} onChange={(v) => patch({ auto_backup_dir: v })} />
        </Field>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
        <Button variant="primary" loading={saving} icon="check" onClick={() => void save(settings)}>
          সংরক্ষণ করুন
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function CatalogSection() {
  const ui = useUI();
  const [tab, setTab] = useState<'units' | 'categories' | 'methods'>('units');
  const [units, setUnits] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [methods, setMethods] = useState<any[]>([]);
  const [form, setForm] = useState<any>({});

  const load = async () => {
    try {
      const [u, c, m] = await Promise.all([
        call<any[]>('settings.units', true),
        call<any[]>('settings.categories', true),
        call<any[]>('settings.paymentMethods', true),
      ]);
      setUnits(u);
      setCategories(c);
      setMethods(m);
    } catch (err) {
      ui.error('ক্যাটালগ লোড ব্যর্থ', (err as Error).message);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const add = async () => {
    try {
      if (tab === 'units') {
        if (!form.name || !form.shortName) return ui.error('ইউনিটের নাম ও সংক্ষিপ্ত রূপ দিন');
        await call('catalog.createUnit', {
          name: form.name,
          shortName: form.shortName,
          baseUnitId: form.baseUnitId ? Number(form.baseUnitId) : null,
          factorMilli: Math.round((Number(form.factor ?? 1) || 1) * 1000),
        });
      } else if (tab === 'categories') {
        if (!form.name) return ui.error('ক্যাটাগরির নাম দিন');
        await call('catalog.createCategory', form.name, form.parentId ? Number(form.parentId) : null);
      } else {
        if (!form.name) return ui.error('পেমেন্ট মাধ্যমের নাম দিন');
        await call('catalog.createPaymentMethod', form.name, Boolean(form.isCash));
      }
      setForm({});
      await load();
      ui.success('যোগ হয়েছে');
    } catch (err) {
      ui.error('যোগ ব্যর্থ', (err as Error).message);
    }
  };

  return (
    <div className="card-body">
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'units', label: 'ইউনিট' },
          { id: 'categories', label: 'ক্যাটাগরি' },
          { id: 'methods', label: 'পেমেন্ট মাধ্যম' },
        ]}
      />
      <div className="form-grid" style={{ marginTop: 10 }}>
        {tab === 'units' ? (
          <>
            <Field label="নাম">
              <TextInput value={form.name ?? ''} onChange={(v) => setForm({ ...form, name: v })} placeholder="যেমন: কেজি" />
            </Field>
            <Field label="সংক্ষিপ্ত রূপ">
              <TextInput value={form.shortName ?? ''} onChange={(v) => setForm({ ...form, shortName: v })} placeholder="kg" />
            </Field>
            <Field label="বেস ইউনিট">
              <Select
                value={form.baseUnitId ?? ''}
                onChange={(v) => setForm({ ...form, baseUnitId: v })}
                options={units.filter((u) => !u.base_unit_id).map((u) => ({ value: u.id, label: u.name }))}
                placeholder="নিজেই বেস"
              />
            </Field>
            <Field label="রূপান্তর (১ এই ইউনিট = ? বেস)">
              <TextInput value={form.factor ?? '1'} onChange={(v) => setForm({ ...form, factor: v })} />
            </Field>
          </>
        ) : null}
        {tab === 'categories' ? (
          <>
            <Field label="নাম">
              <TextInput value={form.name ?? ''} onChange={(v) => setForm({ ...form, name: v })} placeholder="যেমন: মুদি" />
            </Field>
            <Field label="প্যারেন্ট">
              <Select
                value={form.parentId ?? ''}
                onChange={(v) => setForm({ ...form, parentId: v })}
                options={categories.filter((c) => !c.parent_id).map((c) => ({ value: c.id, label: c.name }))}
                placeholder="মূল ক্যাটাগরি"
              />
            </Field>
          </>
        ) : null}
        {tab === 'methods' ? (
          <>
            <Field label="নাম">
              <TextInput value={form.name ?? ''} onChange={(v) => setForm({ ...form, name: v })} placeholder="যেমন: নগদ" />
            </Field>
            <Field label="ক্যাশ হিসেবে গণ্য হবে?">
              <Switch checked={Boolean(form.isCash)} onChange={(v) => setForm({ ...form, isCash: v })} label="নগদ" />
            </Field>
          </>
        ) : null}
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Button variant="primary" icon="plus" onClick={add}>
            যোগ করুন
          </Button>
        </div>
      </div>

      <div className="divider" />
      {tab === 'units' ? (
        <DataTable
          compact
          rows={units}
          rowKey={(r: any) => r.id}
          columns={[
            { key: 'name', label: 'নাম' },
            { key: 'short_name', label: 'সংক্ষিপ্ত' },
            {
              key: 'family',
              label: 'বেস',
              render: (r: any) => units.find((u) => u.id === r.base_unit_id)?.name ?? 'বেস ইউনিট',
            },
            { key: 'factor_milli', label: 'ফ্যাক্টর', align: 'right', render: (r: any) => <span className="num">{r.factor_milli / 1000}</span> },
            { key: 'is_system', label: 'সিস্টেম', align: 'center', render: (r: any) => (r.is_system ? 'হ্যাঁ' : 'না') },
          ]}
        />
      ) : tab === 'categories' ? (
        <DataTable
          compact
          rows={categories}
          rowKey={(r: any) => r.id}
          columns={[
            { key: 'name', label: 'নাম' },
            { key: 'parent_id', label: 'প্যারেন্ট', render: (r: any) => categories.find((c) => c.id === r.parent_id)?.name ?? '—' },
            { key: 'is_active', label: 'সক্রিয়', align: 'center', render: (r: any) => (r.is_active ? 'হ্যাঁ' : 'না') },
          ]}
        />
      ) : (
        <DataTable
          compact
          rows={methods}
          rowKey={(r: any) => r.id}
          columns={[
            { key: 'name', label: 'নাম' },
            { key: 'is_cash', label: 'ক্যাশ', align: 'center', render: (r: any) => (r.is_cash ? 'হ্যাঁ' : 'না') },
            { key: 'is_active', label: 'সক্রিয়', align: 'center', render: (r: any) => (r.is_active ? 'হ্যাঁ' : 'না') },
          ]}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function UsersSection({ currentUser }: { currentUser: User }) {
  const ui = useUI();
  const [users, setUsers] = useState<User[]>([]);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [editing, setEditing] = useState<any | null>(null);
  const [passwordFor, setPasswordFor] = useState<User | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [ownPassword, setOwnPassword] = useState({ open: false, old: '', next: '', confirm: '' });

  const load = async () => {
    try {
      const [u, p] = await Promise.all([call<User[]>('users.list'), call<string[]>('users.permissions')]);
      setUsers(u);
      setPermissions(p);
    } catch (err) {
      ui.error('ইউজার লোড ব্যর্থ', (err as Error).message);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    if (!editing) return;
    try {
      if (editing.id) {
        await call('users.update', editing.id, {
          fullName: editing.full_name,
          role: editing.role,
          permissions: editing.permissions,
          isActive: editing.is_active === 1,
        });
        ui.success('ইউজার আপডেট হয়েছে');
      } else {
        await call('users.create', {
          username: editing.username,
          fullName: editing.full_name,
          password: editing.password,
          role: editing.role,
          permissions: editing.role === 'admin' ? undefined : editing.permissions,
        });
        ui.success('নতুন ইউজার তৈরি হয়েছে', editing.username);
      }
      setEditing(null);
      await load();
    } catch (err) {
      ui.error('সংরক্ষণ ব্যর্থ', (err as Error).message);
    }
  };

  const resetPassword = async () => {
    if (!passwordFor) return;
    try {
      await call('users.resetPassword', passwordFor.id, newPassword);
      ui.success('পাসওয়ার্ড পরিবর্তন হয়েছে', passwordFor.username);
      setPasswordFor(null);
      setNewPassword('');
    } catch (err) {
      ui.error('ব্যর্থ', (err as Error).message);
    }
  };

  const changeOwn = async () => {
    if (ownPassword.next !== ownPassword.confirm) {
      ui.error('পাসওয়ার্ড মিলছে না');
      return;
    }
    try {
      await call('auth.changePassword', ownPassword.old, ownPassword.next);
      ui.success('আপনার পাসওয়ার্ড পরিবর্তন হয়েছে');
      setOwnPassword({ open: false, old: '', next: '', confirm: '' });
    } catch (err) {
      ui.error('ব্যর্থ', (err as Error).message);
    }
  };

  return (
    <div className="card-body">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <Banner tone="info" icon="shield">
          অ্যাডমিন সব কাজ করতে পারেন। ক্যাশিয়ারকে শুধু প্রয়োজনীয় অনুমতি দিন — বিক্রয়, কাস্টমার ও রিপোর্ট।
        </Banner>
      </div>
      <div className="row" style={{ gap: 8, marginBottom: 10 }}>
        <Button
          variant="primary"
          icon="plus"
          onClick={() =>
            setEditing({
              id: null,
              username: '',
              full_name: '',
              password: '',
              role: 'cashier',
              permissions: ['pos.sell', 'product.view', 'customer.manage', 'report.view'],
              is_active: 1,
            })
          }
        >
          নতুন ইউজার
        </Button>
        <Button icon="key" onClick={() => setOwnPassword({ ...ownPassword, open: true })}>
          নিজের পাসওয়ার্ড
        </Button>
      </div>
      <DataTable
        rows={users}
        rowKey={(r) => r.id}
        columns={[
          {
            key: 'full_name',
            label: 'ইউজার',
            render: (r) => (
              <div>
                <div className="bold">
                  {r.full_name} {r.id === currentUser.id ? <Badge tone="teal">আপনি</Badge> : null}
                </div>
                <div className="tiny muted mono">{r.username}</div>
              </div>
            ),
          },
          {
            key: 'role',
            label: 'রোল',
            render: (r) => (
              <Badge tone={r.role === 'admin' ? 'green' : r.role === 'manager' ? 'blue' : 'plain'}>
                {r.role === 'admin' ? 'অ্যাডমিন' : r.role === 'manager' ? 'ম্যানেজার' : 'ক্যাশিয়ার'}
              </Badge>
            ),
          },
          {
            key: 'permissions',
            label: 'অনুমতি',
            render: (r) => (r.role === 'admin' ? <span className="small muted">সব</span> : <span className="small muted">{r.permissions.length} টি</span>),
          },
          { key: 'is_active', label: 'অবস্থা', render: (r) => (r.is_active ? <Badge tone="green">সক্রিয়</Badge> : <Badge tone="red">নিষ্ক্রিয়</Badge>) },
          { key: 'last_login_at', label: 'শেষ লগইন', render: (r) => <span className="tiny muted">{r.last_login_at ? dateTime(r.last_login_at) : '—'}</span> },
          {
            key: 'act',
            label: '',
            align: 'right',
            width: 90,
            render: (r) => (
              <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                <IconButton icon="edit" title="সম্পাদনা" onClick={() => setEditing({ ...r, permissions: [...r.permissions] })} />
                <IconButton icon="key" title="পাসওয়ার্ড রিসেট" onClick={() => setPasswordFor(r)} />
              </div>
            ),
          },
        ]}
      />

      {editing ? (
        <Modal
          title={editing.id ? 'ইউজার সম্পাদনা' : 'নতুন ইউজার'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button onClick={() => setEditing(null)}>বাতিল</Button>
              <Button variant="primary" icon="check" onClick={save}>
                সংরক্ষণ
              </Button>
            </>
          }
        >
          <div className="form-grid">
            {!editing.id ? (
              <Field label="ইউজারনেম *" hint="a-z, 0-9, . _ - (৩–৩২ অক্ষর)">
                <TextInput value={editing.username} onChange={(v) => setEditing({ ...editing, username: v.toLowerCase() })} autoFocus />
              </Field>
            ) : null}
            <Field label="পুরো নাম *">
              <TextInput value={editing.full_name} onChange={(v) => setEditing({ ...editing, full_name: v })} />
            </Field>
            {!editing.id ? (
              <Field label="পাসওয়ার্ড *">
                <TextInput type="password" value={editing.password} onChange={(v) => setEditing({ ...editing, password: v })} />
              </Field>
            ) : null}
            <Field label="রোল">
              <Select
                value={editing.role}
                onChange={(v) => setEditing({ ...editing, role: v })}
                options={[
                  { value: 'admin', label: 'অ্যাডমিন' },
                  { value: 'manager', label: 'ম্যানেজার' },
                  { value: 'cashier', label: 'ক্যাশিয়ার' },
                ]}
              />
            </Field>
            {editing.id ? (
              <Field label="সক্রিয়">
                <Switch
                  checked={editing.is_active === 1}
                  onChange={(v) => setEditing({ ...editing, is_active: v ? 1 : 0 })}
                  label={editing.is_active === 1 ? 'সক্রিয়' : 'নিষ্ক্রিয়'}
                />
              </Field>
            ) : null}
            {editing.role !== 'admin' ? (
              <div className="span-2">
                <div className="section-title">অনুমতি</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 6 }}>
                  {permissions.map((p) => (
                    <label key={p} className="row small" style={{ gap: 6 }}>
                      <input
                        type="checkbox"
                        checked={editing.permissions.includes(p)}
                        onChange={(e) => {
                          const next = new Set<string>(editing.permissions);
                          e.target.checked ? next.add(p) : next.delete(p);
                          setEditing({ ...editing, permissions: [...next] });
                        }}
                      />
                      {PERM_LABELS[p] ?? p}
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {passwordFor ? (
        <Modal
          title={`পাসওয়ার্ড রিসেট — ${passwordFor.username}`}
          size="sm"
          onClose={() => setPasswordFor(null)}
          footer={
            <>
              <Button onClick={() => setPasswordFor(null)}>বাতিল</Button>
              <Button variant="primary" onClick={resetPassword} icon="check">
                পরিবর্তন করুন
              </Button>
            </>
          }
        >
          <Field label="নতুন পাসওয়ার্ড (কমপক্ষে ৬ অক্ষর)">
            <TextInput type="password" value={newPassword} onChange={setNewPassword} autoFocus />
          </Field>
        </Modal>
      ) : null}

      {ownPassword.open ? (
        <Modal
          title="নিজের পাসওয়ার্ড পরিবর্তন"
          size="sm"
          onClose={() => setOwnPassword({ open: false, old: '', next: '', confirm: '' })}
          footer={
            <>
              <Button onClick={() => setOwnPassword({ open: false, old: '', next: '', confirm: '' })}>বাতিল</Button>
              <Button variant="primary" onClick={changeOwn} icon="check">
                পরিবর্তন করুন
              </Button>
            </>
          }
        >
          <div className="form-grid">
            <Field label="বর্তমান পাসওয়ার্ড" span={2}>
              <TextInput type="password" value={ownPassword.old} onChange={(v) => setOwnPassword({ ...ownPassword, old: v })} autoFocus />
            </Field>
            <Field label="নতুন পাসওয়ার্ড" span={2}>
              <TextInput type="password" value={ownPassword.next} onChange={(v) => setOwnPassword({ ...ownPassword, next: v })} />
            </Field>
            <Field label="নতুন পাসওয়ার্ড আবার" span={2}>
              <TextInput type="password" value={ownPassword.confirm} onChange={(v) => setOwnPassword({ ...ownPassword, confirm: v })} />
            </Field>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function AppearanceForm({
  settings,
  patch,
  save,
  saving,
}: {
  settings: AppSettings;
  patch: (p: Partial<AppSettings>) => void;
  save: (p: Partial<AppSettings>) => Promise<void>;
  saving: boolean;
}) {
  return (
    <div className="card-body">
      <div className="form-grid">
        <Field label="থিম" hint="সিস্টেম নির্বাচন করলে উইন্ডোজের সেটিং অনুসরণ করবে" span={2}>
          <div className="seg-toggle" role="group" aria-label="থিম">
            {(['light', 'dark', 'system'] as const).map((value) => (
              <button key={value} className={settings.theme === value ? 'on' : ''} onClick={() => patch({ theme: value })}>
                {value === 'light' ? 'লাইট' : value === 'dark' ? 'ডার্ক' : 'সিস্টেম'}
              </button>
            ))}
          </div>
        </Field>
        <Field label="ভাষা" hint="ইন্টারফেস ও নতুন রিপোর্টে প্রযোজ্য" span={2}>
          <div className="seg-toggle" role="group" aria-label="ভাষা">
            <button className={settings.language === 'bn' ? 'on' : ''} onClick={() => patch({ language: 'bn' })}>
              বাংলা
            </button>
            <button className={settings.language === 'en' ? 'on' : ''} onClick={() => patch({ language: 'en' })}>
              English
            </button>
          </div>
        </Field>
        <Field label="বাংলা সংখ্যা" hint="ইন্টারফেসে ০-৯ দেখাবে">
          <Switch
            checked={settings.bengali_digits === 1}
            onChange={(v) => patch({ bengali_digits: v ? 1 : 0 })}
            label="বাংলা অঙ্ক"
          />
        </Field>
      </div>

      <div className="section-title" style={{ marginTop: 16 }}>
        সফটওয়্যার লক
      </div>
      <Banner tone="info">
        লক বন্ধ করলে অ্যাপ খুললেই প্রাথমিক অ্যাডমিন হিসেবে ঢুকে যাবে — অনুমতি, অডিট লগ ও লাইসেন্স যা আছে ঠিকই থাকবে।
        এটি উইন্ডোজের পাসওয়ার্ড বা ডিস্ক এনক্রিপশনের বিকল্প নয়।
      </Banner>
      <div className="form-grid" style={{ marginTop: 10 }}>
        <Field label="লগইন পাসওয়ার্ড চাইবে" span={2}>
          <Switch
            checked={settings.login_lock_enabled === 1}
            onChange={(v) => patch({ login_lock_enabled: v ? 1 : 0 })}
            label="লগইন লক চালু"
          />
        </Field>
        <Field label="নিষ্ক্রিয়তার পর লগআউট (মিনিট)" hint="০ = কখনো নয়">
          <TextInput
            value={settings.session_timeout_minutes}
            onChange={(v) => patch({ session_timeout_minutes: Math.max(0, Number(v.replace(/[^\d]/g, '')) || 0) })}
          />
        </Field>
      </div>

      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
        <Button variant="primary" loading={saving} icon="check" onClick={() => void save(settings)}>
          সংরক্ষণ করুন
        </Button>
      </div>
    </div>
  );
}


interface DeviceRow {
  device_id: string;
  device_name: string;
  role: string;
  status: 'pending' | 'approved' | 'rejected' | 'revoked';
  last_seen: string | null;
  requested_at: string;
  license_id: string | null;
}

const DEVICE_STATUS_LABEL: Record<DeviceRow['status'], string> = {
  pending: 'অনুমোদনের অপেক্ষায়',
  approved: 'অনুমোদিত',
  rejected: 'প্রত্যাখ্যাত',
  revoked: 'বাতিল',
};

/**
 * Device administration (Phase 3, Milestone E).
 *
 * Approving a PC is an explicit administrator decision — nothing here is automatic,
 * and the capacity guard comes from the licence, not from this screen. The pairing
 * code is single-use and expires; the QR payload carries only the address, the code
 * and the certificate pin (never a shop token or a password).
 */
function DeviceAdminPanel() {
  const ui = useUI();
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [capacity, setCapacity] = useState<{ licensed: number; approved: number; available: number } | null>(null);
  const [identity, setIdentity] = useState<{ store_id: string; server_id: string; short_fingerprint: string | null } | null>(null);
  const [pairing, setPairing] = useState<{ code: string; expires_at: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const [list, cap, id] = await Promise.all([
        call('devices.list'),
        call('devices.capacity'),
        call('devices.identity'),
      ]);
      setDevices(Array.isArray(list) ? (list as DeviceRow[]) : []);
      setCapacity(cap as typeof capacity);
      setIdentity(id as typeof identity);
    } catch {
      // Not signed in as an administrator, or this build has no device layer yet.
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const act = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      await fn();
      ui.success(message);
      await load();
    } catch (err) {
      ui.error('ব্যর্থ', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pending = devices.filter((d) => d.status === 'pending');

  return (
    <div style={{ marginTop: 20 }}>
      <div className="section-title">ডিভাইস ব্যবস্থাপনা</div>
      {capacity ? (
        <div className="small muted">
          লাইসেন্সে {capacity.licensed}টি ডিভাইস · অনুমোদিত {capacity.approved}টি · খালি {capacity.available}টি
          {identity?.short_fingerprint ? ` · সার্টিফিকেট পিন ${identity.short_fingerprint}` : ''}
        </div>
      ) : null}

      <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <Button
          size="sm"
          variant="ghost"
          icon="plus"
          loading={busy}
          onClick={() =>
            void act(async () => {
              const result = (await call('devices.pairingCode', { ttlMs: 10 * 60 * 1000 })) as {
                code: string;
                expires_at: string;
              };
              setPairing({ code: result.code, expires_at: result.expires_at });
            }, 'পেয়ারিং কোড তৈরি হয়েছে (১০ মিনিট)')
          }
        >
          পেয়ারিং কোড
        </Button>
        <Button size="sm" variant="ghost" icon="refresh" onClick={() => void load()}>
          রিফ্রেশ
        </Button>
      </div>

      {pairing ? (
        <div className="card" style={{ marginTop: 10, padding: 12 }}>
          <div className="small muted">একবার ব্যবহারযোগ্য কোড — {dateTime(pairing.expires_at)} পর্যন্ত</div>
          <code style={{ fontSize: 16, wordBreak: 'break-all' }}>{pairing.code}</code>
        </div>
      ) : null}

      {pending.length ? (
        <div style={{ marginTop: 12 }}>
          <strong className="small">অনুমোদনের অপেক্ষায় ({pending.length})</strong>
          {pending.map((device) => (
            <div key={device.device_id} className="row" style={{ gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
              <span>{device.device_name}</span>
              <span className="small muted">{device.device_id}</span>
              <Button
                size="sm"
                icon="check"
                disabled={busy}
                onClick={() => void act(() => call('devices.approve', device.device_id), 'ডিভাইস অনুমোদিত হয়েছে')}
              >
                অনুমোদন
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon="close"
                disabled={busy}
                onClick={() => void act(() => call('devices.reject', device.device_id, 'প্রশাসক প্রত্যাখ্যান করেছেন'), 'ডিভাইস প্রত্যাখ্যাত')}
              >
                প্রত্যাখ্যান
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <div className="small muted" style={{ marginTop: 10 }}>
          অনুমোদনের অপেক্ষায় কোনো ডিভাইস নেই।
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        {devices.map((device) => (
          <div key={device.device_id} className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', padding: '4px 0' }}>
            <span>
              {device.device_name} <span className="small muted">{device.device_id}</span>
            </span>
            <span className="row" style={{ gap: 8 }}>
              <span className="badge" data-tone={device.status === 'approved' ? 'success' : device.status === 'revoked' ? 'danger' : 'warning'}>
                {DEVICE_STATUS_LABEL[device.status]}
              </span>
              <span className="small muted">{device.last_seen ? dateTime(device.last_seen) : 'কখনো সংযুক্ত হয়নি'}</span>
              {device.status === 'approved' || device.status === 'pending' ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="close"
                  disabled={busy}
                  onClick={() => void act(() => call('devices.revoke', device.device_id, 'প্রশাসক বাতিল করেছেন'), 'ডিভাইস বাতিল হয়েছে')}
                >
                  বাতিল
                </Button>
              ) : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function NetworkForm({
  settings,
  patch,
  save,
  saving,
}: {
  settings: AppSettings;
  patch: (p: Partial<AppSettings>) => void;
  save: (p: Partial<AppSettings>) => Promise<void>;
  saving: boolean;
}) {
  const ui = useUI();
  const [status, setStatus] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      setStatus(await call<any>('server.status'));
    } catch {
      setStatus(null);
    }
  };

  useEffect(() => {
    void refresh();
    // Live-ish status without hammering the server: two polls a minute.
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, []);

  const run = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      await fn();
      ui.success(message);
      await refresh();
    } catch (err) {
      ui.error('কাজটি ব্যর্থ হয়েছে', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card-body">
      <div className="section-title">মাল্টি-টার্মিনাল (LAN)</div>
      <Banner tone="info">
        একটি কম্পিউটার হোস্ট হিসেবে ডাটাবেস ধরে রাখে; অন্য কম্পিউটার টার্মিনাল হিসেবে একই দোকানের ডেটা ব্যবহার করে।
        একই নেটওয়ার্কে থাকা আবশ্যক। বাইরের ইন্টারনেটে পোর্ট খুলবেন না।
      </Banner>
      <div className="form-grid" style={{ marginTop: 10 }}>
        <Field label="মোড" hint="পরিবর্তনের পর অ্যাপ রিস্টার্ট করুন">
          <Select
            value={settings.lan_mode}
            onChange={(v) => patch({ lan_mode: v as AppSettings['lan_mode'] })}
            options={[
              { value: 'off', label: 'বন্ধ (শুধু এই পিসি)' },
              { value: 'host', label: 'হোস্ট (এই পিসি ডেটা রাখবে)' },
              { value: 'terminal', label: 'টার্মিনাল (হোস্টে যুক্ত হবে)' },
            ]}
          />
        </Field>
        <Field label="পোর্ট">
          <TextInput
            value={settings.lan_port}
            onChange={(v) => patch({ lan_port: Math.max(1024, Math.min(65535, Number(v.replace(/[^\d]/g, '')) || 8787)) })}
          />
        </Field>
        <Field label="হোস্ট ঠিকানা" span={2} hint="যেমন: http://192.168.0.10:8787">
          <TextInput value={settings.lan_host_url} onChange={(v) => patch({ lan_host_url: v.trim() })} />
        </Field>
      </div>
      <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <Button size="sm" loading={busy} icon="check" onClick={() => void save(settings)}>
          সেটিংস সংরক্ষণ
        </Button>
        <Button size="sm" variant="ghost" icon="shield" onClick={() => void run(() => call('lan.startHost'), 'সার্ভার চালু হয়েছে')}>
          সার্ভার চালু
        </Button>
        <Button size="sm" variant="ghost" icon="refresh" onClick={() => void run(() => call('server.restart'), 'সার্ভার রিস্টার্ট হয়েছে')}>
          রিস্টার্ট
        </Button>
        <Button size="sm" variant="ghost" icon="close" onClick={() => void run(() => call('server.stop'), 'সার্ভার বন্ধ হয়েছে')}>
          সার্ভার বন্ধ
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="refresh"
          onClick={() => void run(() => call('lan.regenerateToken'), 'নতুন টোকেন তৈরি হয়েছে — সব টার্মিনাল আবার যুক্ত করুন')}
        >
          টোকেন নবায়ন
        </Button>
      </div>

      <div className="form-grid" style={{ marginTop: 12 }}>
        <Field label="উইন্ডো বন্ধ করলেও সার্ভার চালু থাকবে" hint="ট্রে থেকে নিয়ন্ত্রণ করা যায়">
          <Switch
            checked={settings.server_keep_running === 1}
            onChange={(v) => void run(() => call('server.setKeepRunning', v), v ? 'সার্ভার চালু থাকবে' : 'উইন্ডো বন্ধে সার্ভারও বন্ধ হবে')}
            label={settings.server_keep_running === 1 ? 'চালু' : 'বন্ধ'}
          />
        </Field>
        <Field label="উইন্ডোজ চালু হলে সার্ভার নিজেই শুরু হবে" hint="শুধু হোস্ট মোডে">
          <Switch
            checked={settings.server_autostart === 1}
            onChange={(v) => void run(() => call('server.setAutostart', v), v ? 'অটো-স্টার্ট চালু' : 'অটো-স্টার্ট বন্ধ')}
            label={settings.server_autostart === 1 ? 'চালু' : 'বন্ধ'}
          />
        </Field>
      </div>

      {status?.health ? (
        <div className="card" style={{ marginTop: 12, padding: 12 }}>
          <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <strong>সার্ভার অবস্থা</strong>
            <span
              className="badge"
              data-tone={status.health.state === 'running' ? 'success' : status.health.state === 'error' ? 'danger' : 'warning'}
            >
              {status.health.state === 'running'
                ? 'চালু'
                : status.health.state === 'starting'
                  ? 'চালু হচ্ছে'
                  : status.health.state === 'stopping'
                    ? 'বন্ধ হচ্ছে'
                    : status.health.state === 'error'
                      ? 'ত্রুটি'
                      : 'বন্ধ'}
            </span>
          </div>
          <div className="small muted" style={{ marginTop: 6 }}>
            পোর্ট: {status.health.port ?? '—'} • ক্লায়েন্ট: {status.health.clients ?? 0} • রিস্টার্ট:{' '}
            {status.health.restarts ?? 0} • ডেটাবেজ: {status.health.db_ok ? 'ঠিক আছে' : 'সমস্যা'} • শেষ ব্যাকআপ:{' '}
            {status.health.last_backup_at || '—'}
          </div>
          {status.health.last_error ? (
            <div className="small" style={{ marginTop: 6, color: 'var(--danger, #b3261e)' }}>
              {status.health.last_error}
            </div>
          ) : null}
          {status.health.addresses?.length ? (
            <div className="small muted" style={{ marginTop: 6 }}>
              ঠিকানা: {status.health.addresses.join(' · ')}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="small muted" style={{ marginTop: 10 }}>
          সার্ভার তথ্য পাওয়া যায়নি — অ্যাপ রিস্টার্ট করুন।
        </div>
      )}

      <DeviceAdminPanel />

      <div className="section-title" style={{ marginTop: 20 }}>
        কাস্টমার ডিসপ্লে
      </div>
      <div className="form-grid">
        <Field label="দ্বিতীয় স্ক্রিন চালু" span={2}>
          <Switch
            checked={settings.customer_display_enabled === 1}
            onChange={(v) => patch({ customer_display_enabled: v ? 1 : 0 })}
            label="কাস্টমার ডিসপ্লে"
          />
        </Field>
        <Field label="গিফট কার্ডের মেয়াদ (দিন)" hint="০ = মেয়াদ নেই">
          <TextInput
            value={settings.gift_card_expiry_days}
            onChange={(v) => patch({ gift_card_expiry_days: Math.max(0, Number(v.replace(/[^\d]/g, '')) || 0) })}
          />
        </Field>
        <Field label="বিক্রয়ের পর">
          <Switch checked={settings.print_after_sale === 1} onChange={(v) => patch({ print_after_sale: v ? 1 : 0 })} label="স্বয়ংক্রিয় প্রিন্ট" />
        </Field>
      </div>

      <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <Button size="sm" icon="pos" onClick={() => void call('display.open').then(() => ui.success('ডিসপ্লে খোলা হয়েছে')).catch((e) => ui.error('ব্যর্থ', (e as Error).message))}>
          ডিসপ্লে খুলুন
        </Button>
        <Button size="sm" variant="ghost" icon="close" onClick={() => void call('display.close').then(() => ui.success('ডিসপ্লে বন্ধ হয়েছে')).catch(() => undefined)}>
          ডিসপ্লে বন্ধ
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="print"
          onClick={() =>
            void call('print.document', 'labels', { size: 'thermal' })
              .then((html) => call('print.render', html, {}))
              .then(() => ui.success('প্রিন্ট প্রিভিউ খোলা হয়েছে'))
              .catch((e) => ui.error('প্রিন্ট ব্যর্থ', (e as Error).message))
          }
        >
          প্রিন্টার পরীক্ষা
        </Button>
      </div>

      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
        <Button variant="primary" loading={saving} icon="check" onClick={() => void save(settings)}>
          সংরক্ষণ করুন
        </Button>
      </div>
    </div>
  );
}

function LicenseSection({ onChanged, isAdmin }: { onChanged: () => Promise<void>; isAdmin: boolean }) {
  const ui = useUI();
  const [state, setState] = useState<ActivationState | null>(null);

  useEffect(() => {
    call<ActivationState>('license.state').then(setState).catch(() => setState(null));
  }, []);

  const deactivate = async () => {
    const res = await ui.confirm({
      title: 'লাইসেন্স নিষ্ক্রিয় করুন',
      message: 'এই কম্পিউটার থেকে লাইসেন্স সরিয়ে ফেলবেন?',
      detail: 'ডেটা অক্ষত থাকবে। আবার চালু করতে লাইসেন্স কী লাগবে।',
      danger: true,
      requireReason: true,
      confirmLabel: 'নিষ্ক্রিয় করুন',
    });
    if (!res.ok) return;
    try {
      await call('license.deactivate');
      ui.success('লাইসেন্স নিষ্ক্রিয় হয়েছে');
      await onChanged();
    } catch (err) {
      ui.error('ব্যর্থ', (err as Error).message);
    }
  };

  if (!state) return <Loading />;
  const payload = state.license;
  return (
    <div className="card-body">
      <div className="row" style={{ gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <Badge tone={state.activated ? 'green' : 'red'}>{state.activated ? 'সক্রিয়' : 'নিষ্ক্রিয়'}</Badge>
        {payload ? <Badge tone="teal">{payload.edition === 'pro' ? 'প্রো' : payload.edition === 'enterprise' ? 'এন্টারপ্রাইজ' : 'স্ট্যান্ডার্ড'}</Badge> : null}
        {payload?.expires_at ? <Badge tone="amber">মেয়াদ {payload.expires_at.slice(0, 10)}</Badge> : <Badge tone="plain">লাইফটাইম</Badge>}
      </div>
      {payload ? (
        <div className="form-grid">
          <Field label="প্রতিষ্ঠান">
            <TextInput value={payload.org} onChange={() => undefined} disabled />
          </Field>
          <Field label="মালিক">
            <TextInput value={payload.owner ?? '—'} onChange={() => undefined} disabled />
          </Field>
          <Field label="লাইসেন্স আইডি">
            <TextInput value={payload.license_id} onChange={() => undefined} disabled />
          </Field>
          <Field label="ইস্যু">
            <TextInput value={payload.issued_at?.slice(0, 10) ?? '—'} onChange={() => undefined} disabled />
          </Field>
        </div>
      ) : (
        <Banner tone="warn" icon="warning">
          কোনো লাইসেন্স তথ্য পাওয়া যায়নি।
        </Banner>
      )}
      <div className="row" style={{ gap: 8, marginTop: 14 }}>
        <Button onClick={() => call<ActivationState>('license.state').then(setState)} icon="refresh">
          রিফ্রেশ
        </Button>
        {isAdmin && state.activated ? (
          <Button variant="danger" icon="lock" onClick={deactivate}>
            লাইসেন্স সরান
          </Button>
        ) : null}
      </div>
      <p className="tiny muted" style={{ marginTop: 10 }}>
        লাইসেন্স সম্পূর্ণ অফলাইনে যাচাই হয়। নতুন কম্পিউটারে চালাতে হলে সেলারের কাছ থেকে নতুন লাইসেন্স নিতে হবে।
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function DiagnosticsSection() {
  const ui = useUI();
  const [check, setCheck] = useState<any | null>(null);
  const [logs, setLogs] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const runCheck = async () => {
    setBusy(true);
    try {
      const res = await call<any>('app.integrity');
      setCheck(res);
      if (res.ok) ui.success('ডাটাবেজ ঠিক আছে');
      else ui.error('ডাটাবেজে সমস্যা', res.message);
    } catch (err) {
      ui.error('চেক ব্যর্থ', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card-body">
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Button icon="shield" loading={busy} onClick={runCheck}>
          ডাটাবেজ যাচাই (Integrity Check)
        </Button>
        <Button icon="file" onClick={() => call<string>('app.logs').then(setLogs)}>
          লগ দেখুন
        </Button>
        <Button icon="backup" onClick={() => call('app.openDataFolder').then(() => ui.success('ফোল্ডার খোলা হয়েছে'))}>
          ডেটা ফোল্ডার খুলুন
        </Button>
      </div>
      {check ? (
        <div className="col" style={{ gap: 4, marginTop: 12 }}>
          <div className="row small" style={{ justifyContent: 'space-between' }}>
            <span className="muted">অবস্থা</span>
            <span className={check.ok ? 'success-text bold' : 'danger-text bold'}>{check.ok ? 'সব ঠিক আছে' : check.message}</span>
          </div>
          {check.repaired ? <Banner tone="success" icon="check">ডাটাবেজ পুনর্গঠন (VACUUM + REINDEX) সম্পন্ন হয়েছে।</Banner> : null}
        </div>
      ) : null}
      {logs !== null ? (
        <>
          <div className="section-title" style={{ marginTop: 14 }}>
            সাম্প্রতিক লগ
          </div>
          <pre className="log-view">{logs || 'কোনো লগ নেই'}</pre>
        </>
      ) : null}
    </div>
  );
}

export { MoneyInput, EmptyState };
