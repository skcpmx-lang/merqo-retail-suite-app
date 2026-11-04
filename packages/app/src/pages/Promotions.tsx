import { useCallback, useEffect, useState } from 'react';
import { call } from '../api.js';
import { useT } from '../i18n.js';
import { money, dateShort } from '../format.js';
import {
  Banner,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Loading,
  Modal,
  MoneyInput,
  PageHead,
  Segmented,
  Select,
  Switch,
  TextInput,
  useDebounced,
  useUI,
} from '../ui.js';

type Tab = 'coupons' | 'giftcards';

interface Coupon {
  id: number;
  code: string;
  label: string | null;
  kind: 'percent' | 'fixed';
  value: number;
  min_purchase_paisa: number;
  max_discount_paisa: number;
  starts_at: string | null;
  expires_at: string | null;
  usage_limit: number;
  used_count: number;
  note: string | null;
  per_customer_limit: number;
  is_active: number;
  redemptions?: number;
  discount_total_paisa?: number;
}

interface GiftCard {
  id: number;
  code: string;
  kind: 'gift_card' | 'voucher';
  initial_paisa: number;
  balance_paisa: number;
  customer_id: number | null;
  issued_at: string;
  expires_at: string | null;
  status: 'active' | 'used' | 'expired' | 'void';
  note: string | null;
}

export function PromotionsPage({ can }: { can: (p?: string) => boolean }) {
  const t = useT();
  const ui = useUI();
  const [tab, setTab] = useState<Tab>('coupons');
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [cards, setCards] = useState<GiftCard[]>([]);
  const [summary, setSummary] = useState<{ active: number; outstanding_paisa: number; issued_paisa: number; redeemed_paisa: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [couponForm, setCouponForm] = useState<Partial<Coupon> | null>(null);
  const [issueForm, setIssueForm] = useState(false);
  const [detail, setDetail] = useState<GiftCard | null>(null);
  const [tx, setTx] = useState<any[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, g, s] = await Promise.all([
        call<{ rows: Coupon[] }>('promotions.coupons', { q: debounced || undefined }),
        call<{ rows: GiftCard[] }>('promotions.giftCards', { q: debounced || undefined }),
        call<typeof summary>('promotions.giftCardSummary'),
      ]);
      setCoupons(c.rows ?? []);
      setCards(g.rows ?? []);
      setSummary(s);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [debounced]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCard = async (card: GiftCard) => {
    setDetail(card);
    try {
      setTx(await call<any[]>('promotions.giftCardTransactions', card.id));
    } catch {
      setTx([]);
    }
  };

  const saveCoupon = async () => {
    if (!couponForm) return;
    const payload: any = {
      code: couponForm.code ?? '',
      label: couponForm.label ?? null,
      kind: couponForm.kind ?? 'percent',
      value: couponForm.kind === 'fixed' ? Math.round(couponForm.value ?? 0) : Math.round(couponForm.value ?? 0),
      minPurchasePaisa: Math.round(couponForm.min_purchase_paisa ?? 0),
      maxDiscountPaisa: Math.round(couponForm.max_discount_paisa ?? 0),
      startsAt: couponForm.starts_at ?? null,
      expiresAt: couponForm.expires_at ?? null,
      usageLimit: Math.round(couponForm.usage_limit ?? 0),
      perCustomerLimit: Math.round(couponForm.per_customer_limit ?? 0),
      note: couponForm.note ?? null,
    };
    try {
      if (couponForm.id) {
        const { code: _code, ...patch } = payload;
        await call('promotions.couponUpdate', couponForm.id, { ...patch, isActive: couponForm.is_active === 1 });
        ui.success(t('common.saved'));
      } else {
        await call('promotions.couponCreate', payload);
        ui.success(t('common.saved'));
      }
      setCouponForm(null);
      await load();
    } catch (err) {
      ui.error((err as Error).message);
    }
  };

  const toggleCoupon = async (coupon: Coupon) => {
    try {
      await call('promotions.couponUpdate', coupon.id, {
        isActive: coupon.is_active !== 1,
      });
      await load();
    } catch (err) {
      ui.error((err as Error).message);
    }
  };

  const issue = async (input: { amountPaisa: number; kind: 'gift_card' | 'voucher'; methodId: number | null; note: string }) => {
    try {
      const card = await call<GiftCard>('promotions.giftCardIssue', {
        amountPaisa: input.amountPaisa,
        kind: input.kind,
        methodId: input.methodId,
        note: input.note || null,
      });
      ui.success(`${card.code} — ${money(card.balance_paisa)}`);
      setIssueForm(false);
      await load();
    } catch (err) {
      ui.error((err as Error).message);
    }
  };

  const voidCard = async (card: GiftCard) => {
    const res = await ui.confirm({
      title: `${t('promo.void')} — ${card.code}`,
      message: 'বাতিল করলে অবশিষ্ট ব্যালেন্স দায় থেকে সরবে। কারণ লিখুন।',
      requireReason: true,
      reasonLabel: 'কারণ',
      danger: true,
    });
    if (!res.ok || !res.reason) return;
    try {
      await call('promotions.giftCardVoid', card.id, res.reason);
      ui.success(t('common.saved'));
      setDetail(null);
      await load();
    } catch (err) {
      ui.error((err as Error).message);
    }
  };

  const adjustCard = async (card: GiftCard) => {
    const res = await ui.confirm({
      title: `${t('promo.adjust')} — ${card.code}`,
      message: 'সমন্বয়ের পরিমাণ ও কারণ লিখুন (বিয়োগের জন্য - চিহ্ন)।',
      requireReason: true,
      reasonLabel: 'যেমন: -5000 — ভুল ইস্যু',
    });
    if (!res.ok || !res.reason) return;
    const match = res.reason.match(/(-?\d+(?:\.\d+)?)/);
    if (!match) {
      ui.error('সমন্বয়ের পরিমাণ সংখ্যায় লিখুন।');
      return;
    }
    try {
      await call('promotions.giftCardAdjust', { cardId: card.id, deltaPaisa: Math.round(Number(match[1]) * 100), reason: res.reason });
      ui.success(t('common.saved'));
      setDetail(null);
      await load();
    } catch (err) {
      ui.error((err as Error).message);
    }
  };

  return (
    <>
      <PageHead
        title={t('promo.title')}
        sub={summary ? `${summary.active} • ${money(summary.outstanding_paisa)}` : undefined}
        actions={
          <>
            <Button icon="refresh" variant="ghost" onClick={() => void load()}>
              {t('common.refresh')}
            </Button>
            {tab === 'coupons' ? (
              <Button variant="primary" icon="plus" onClick={() => setCouponForm({ kind: 'percent', value: 1000, is_active: 1 })}>
                {t('common.add')}
              </Button>
            ) : can('settings.manage') ? (
              <Button variant="primary" icon="plus" onClick={() => setIssueForm(true)}>
                {t('promo.issue')}
              </Button>
            ) : null}
          </>
        }
      />

      {error ? <Banner tone="danger">{error}</Banner> : null}

      <div className="stat-grid" style={{ marginBottom: 16 }}>
        <div className="kpi">
          <div className="kpi-label">{t('promo.outstanding')}</div>
          <div className="kpi-value num">{money(summary?.outstanding_paisa ?? 0)}</div>
          <div className="kpi-foot">২১৫০ — দায় খাতের সমান</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">{t('promo.initial')}</div>
          <div className="kpi-value num">{money(summary?.issued_paisa ?? 0)}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">{t('promo.used')}</div>
          <div className="kpi-value num">{money(summary?.redeemed_paisa ?? 0)}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">{t('promo.coupons')}</div>
          <div className="kpi-value num">{coupons.length}</div>
        </div>
      </div>

      <Card>
        <div className="toolbar">
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'coupons', label: t('promo.coupons') },
              { value: 'giftcards', label: t('promo.giftCards') },
            ]}
          />
          <div className="grow" />
          <div style={{ width: 220 }}>
            <TextInput value={search} onChange={setSearch} placeholder={t('common.search')} />
          </div>
        </div>

        {loading ? (
          <Loading />
        ) : tab === 'coupons' ? (
          coupons.length === 0 ? (
            <EmptyState icon="tag" title={t('common.none')} message="কুপন দিয়ে শতকরা বা নির্দিষ্ট ছাড় দিন।" />
          ) : (
            <DataTable
              rows={coupons}
              rowKey={(r) => r.id}
              columns={[
                { key: 'code', label: t('promo.code'), render: (r) => <span className="mono bold">{r.code}</span> },
                { key: 'label', label: t('common.name'), render: (r) => r.label ?? '—' },
                {
                  key: 'value',
                  label: t('common.discount'),
                  align: 'right',
                  render: (r) => (r.kind === 'percent' ? `${(r.value / 100).toFixed(0)}%` : money(r.value)),
                },
                { key: 'min_purchase_paisa', label: t('promo.minPurchase'), money: true, align: 'right' },
                { key: 'used_count', label: t('promo.used'), align: 'right', render: (r) => `${r.used_count}${r.usage_limit ? ` / ${r.usage_limit}` : ''}` },
                { key: 'expires_at', label: t('promo.expiry'), render: (r) => (r.expires_at ? dateShort(r.expires_at) : '—') },
                {
                  key: 'is_active',
                  label: t('common.status'),
                  render: (r) => <span className={`pill ${r.is_active ? 'green' : 'plain'}`}>{r.is_active ? t('common.active') : t('common.inactive')}</span>,
                },
                {
                  key: 'actions',
                  label: t('common.actions'),
                  align: 'right',
                  render: (r) => (
                    <div className="row">
                      <Button size="sm" variant="ghost" icon="edit" onClick={() => setCouponForm(r)} />
                      <Button size="sm" variant="ghost" icon={r.is_active ? 'close' : 'check'} onClick={() => void toggleCoupon(r)} />
                    </div>
                  ),
                },
              ]}
            />
          )
        ) : cards.length === 0 ? (
          <EmptyState icon="wallet" title={t('common.none')} message="গিফট কার্ড বা ভাউচার ইস্যু করুন।" />
        ) : (
          <DataTable
            rows={cards}
            rowKey={(r) => r.id}
            onRowClick={(r) => void openCard(r)}
            columns={[
              { key: 'code', label: t('promo.code'), render: (r) => <span className="mono bold">{r.code}</span> },
              {
                key: 'kind',
                label: t('common.details'),
                render: (r) => <span className={`pill ${r.kind === 'voucher' ? 'blue' : 'teal'}`}>{r.kind === 'voucher' ? t('promo.voucher') : t('promo.giftCard')}</span>,
              },
              { key: 'initial_paisa', label: t('promo.initial'), money: true, align: 'right' },
              { key: 'balance_paisa', label: t('promo.balance'), money: true, align: 'right' },
              {
                key: 'status',
                label: t('common.status'),
                render: (r) => (
                  <span className={`pill ${r.status === 'active' ? 'green' : r.status === 'void' ? 'red' : 'plain'}`}>{r.status}</span>
                ),
              },
              { key: 'issued_at', label: t('common.date'), render: (r) => dateShort(r.issued_at) },
            ]}
          />
        )}
      </Card>

      {couponForm ? (
        <Modal
          title={couponForm.id ? `${t('common.edit')} — ${couponForm.code}` : t('common.add')}
          onClose={() => setCouponForm(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setCouponForm(null)}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" icon="check" onClick={() => void saveCoupon()}>
                {t('common.save')}
              </Button>
            </>
          }
        >
          <div className="form-grid">
            <Field label={t('promo.code')} hint="ইংরেজি বড় হাতের অক্ষর, সংখ্যা, - এবং _">
              <TextInput
                value={couponForm.code ?? ''}
                onChange={(v) => setCouponForm({ ...couponForm, code: v.toUpperCase() })}
                disabled={Boolean(couponForm.id)}
                placeholder="EID10"
              />
            </Field>
            <Field label={t('common.name')}>
              <TextInput value={couponForm.label ?? ''} onChange={(v) => setCouponForm({ ...couponForm, label: v })} placeholder="ঈদ অফার" />
            </Field>
            <Field label="ধরন">
              <Select
                value={couponForm.kind ?? 'percent'}
                onChange={(v) => setCouponForm({ ...couponForm, kind: v as 'percent' | 'fixed' })}
                options={[
                  { value: 'percent', label: t('promo.kind.percent') },
                  { value: 'fixed', label: t('promo.kind.fixed') },
                ]}
              />
            </Field>
            <Field label={couponForm.kind === 'fixed' ? `${t('common.discount')} (৳)` : `${t('common.discount')} (%)`}>
              {couponForm.kind === 'fixed' ? (
                <MoneyInput value={couponForm.value ?? 0} onChange={(v) => setCouponForm({ ...couponForm, value: v })} />
              ) : (
                <TextInput
                  value={((couponForm.value ?? 0) / 100).toString()}
                  onChange={(v) => setCouponForm({ ...couponForm, value: Math.round(Number(v || 0) * 100) })}
                />
              )}
            </Field>
            <Field label={t('promo.minPurchase')}>
              <MoneyInput value={couponForm.min_purchase_paisa ?? 0} onChange={(v) => setCouponForm({ ...couponForm, min_purchase_paisa: v })} />
            </Field>
            <Field label={t('promo.maxDiscount')}>
              <MoneyInput value={couponForm.max_discount_paisa ?? 0} onChange={(v) => setCouponForm({ ...couponForm, max_discount_paisa: v })} />
            </Field>
            <Field label={t('promo.usageLimit')} hint="০ = সীমা নেই">
              <TextInput value={couponForm.usage_limit ?? 0} onChange={(v) => setCouponForm({ ...couponForm, usage_limit: Number(v || 0) })} />
            </Field>
            <Field label={t('promo.expiry')}>
              <TextInput value={couponForm.expires_at ?? ''} onChange={(v) => setCouponForm({ ...couponForm, expires_at: v || null })} type="date" />
            </Field>
            {couponForm.id ? (
              <Field label={t('common.status')} span={2}>
                <Switch
                  checked={couponForm.is_active === 1}
                  onChange={(v) => setCouponForm({ ...couponForm, is_active: v ? 1 : 0 })}
                  label={t('common.active')}
                />
              </Field>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {issueForm ? <IssueDialog onClose={() => setIssueForm(false)} onIssue={issue} /> : null}

      {detail ? (
        <Modal
          title={detail.code}
          sub={`${detail.kind === 'voucher' ? t('promo.voucher') : t('promo.giftCard')} • ${dateShort(detail.issued_at)}`}
          onClose={() => setDetail(null)}
          size="md"
          footer={
            <>
              <Button variant="ghost" onClick={() => setDetail(null)}>
                {t('common.close')}
              </Button>
              {detail.status !== 'void' && can('settings.manage') ? (
                <>
                  <Button variant="warn" icon="edit" onClick={() => void adjustCard(detail)}>
                    {t('promo.adjust')}
                  </Button>
                  <Button variant="danger" icon="close" onClick={() => void voidCard(detail)}>
                    {t('promo.void')}
                  </Button>
                </>
              ) : null}
            </>
          }
        >
          <div className="stat-grid" style={{ marginBottom: 12 }}>
            <div className="kpi">
              <div className="kpi-label">{t('promo.initial')}</div>
              <div className="kpi-value num">{money(detail.initial_paisa)}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">{t('promo.balance')}</div>
              <div className="kpi-value num">{money(detail.balance_paisa)}</div>
            </div>
          </div>
          {tx.length === 0 ? (
            <div className="small muted">কোনো লেনদেন নেই।</div>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>{t('common.date')}</th>
                  <th>ধরন</th>
                  <th className="right">{t('common.amount')}</th>
                  <th className="right">{t('promo.balance')}</th>
                </tr>
              </thead>
              <tbody>
                {tx.map((row) => (
                  <tr key={row.id}>
                    <td className="small muted">{dateShort(row.created_at)}</td>
                    <td className="small">{row.type}</td>
                    <td className="right num">{money(row.amount_paisa)}</td>
                    <td className="right num">{money(row.balance_after_paisa)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Modal>
      ) : null}
    </>
  );
}

function IssueDialog({
  onClose,
  onIssue,
}: {
  onClose: () => void;
  onIssue: (input: { amountPaisa: number; kind: 'gift_card' | 'voucher'; methodId: number | null; note: string }) => Promise<void>;
}) {
  const t = useT();
  const [amount, setAmount] = useState(0);
  const [kind, setKind] = useState<'gift_card' | 'voucher'>('gift_card');
  const [methodId, setMethodId] = useState<number | ''>('');
  const [note, setNote] = useState('');
  const [methods, setMethods] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void call<any[]>('settings.paymentMethods')
      .then((list) => {
        setMethods((list ?? []).filter((m: any) => m.name !== 'গিফট কার্ড'));
        const cash = (list ?? []).find((m: any) => m.is_cash === 1);
        if (cash) setMethodId(cash.id);
      })
      .catch(() => undefined);
  }, []);

  const submit = async () => {
    setSaving(true);
    try {
      await onIssue({ amountPaisa: amount, kind, methodId: methodId === '' ? null : Number(methodId), note });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={t('promo.issue')}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" icon="check" loading={saving} disabled={amount <= 0} onClick={() => void submit()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Banner tone="info">
        টাকা নিয়ে ইস্যু করলে ক্যাশ বাড়বে ও দায় (২১৫০) বাড়বে। পেমেন্ট মেথড না দিলে এটি বিনামূল্যের ভাউচার হিসেবে
        ডিসকাউন্ট খাতে খরচ হবে।
      </Banner>
      <div className="form-grid" style={{ marginTop: 10 }}>
        <Field label="ধরন">
          <Select
            value={kind}
            onChange={(v) => setKind(v as 'gift_card' | 'voucher')}
            options={[
              { value: 'gift_card', label: t('promo.giftCard') },
              { value: 'voucher', label: t('promo.voucher') },
            ]}
          />
        </Field>
        <Field label={t('common.amount')}>
          <MoneyInput value={amount} onChange={setAmount} />
        </Field>
        <Field label={t('pos.payment')} hint="বিনামূল্যে ভাউচার হলে খালি রাখুন">
          <Select
            value={methodId}
            onChange={(v) => setMethodId(v === '' ? '' : Number(v))}
            placeholder="—"
            options={methods.map((m) => ({ value: m.id, label: m.name }))}
          />
        </Field>
        <Field label={t('common.notes')}>
          <TextInput value={note} onChange={setNote} placeholder="যেমন: ঈদ প্রোমো" />
        </Field>
      </div>
    </Modal>
  );
}
