import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call } from '../api.js';
import { money, qty as fmtQty, dateTime } from '../format.js';
import { Icon } from '../icons.js';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  IconButton,
  Loading,
  Modal,
  MoneyInput,
  QtyInput,
  Select,
  Spinner,
  TextInput,
  useUI,
} from '../ui.js';
import type { AppSettings, Customer, ProductWithMeta, Sale, Unit } from '../types.js';
import type { PageId } from '../App.js';

interface CartLine {
  key: string;
  productId: number;
  name: string;
  unitId: number;
  unitLabel: string;
  factorMilli: number;
  qtyMilli: number;
  basePricePaisa: number;
  unitPricePaisa: number;
  priceEdited: boolean;
  discountPaisa: number;
  stockBaseMilli: number;
  minStockMilli: number;
}

interface Computation {
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  costTotal: number;
  profit: number;
  paid: number;
  due: number;
  change: number;
  lines: { productId: number; unitPrice: number; lineTotal: number; qtyMilli: number; qtyBaseMilli: number }[];
}

let lineSeq = 1;

export function POSPage({
  settings,
  can,
  navigate,
  onSettingsChanged,
}: {
  settings: AppSettings | null;
  can: (perm?: string) => boolean;
  navigate: (p: PageId) => void;
  onSettingsChanged: () => Promise<void>;
}) {
  const ui = useUI();
  const [products, setProducts] = useState<ProductWithMeta[]>([]);
  const [productTotal, setProductTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [categories, setCategories] = useState<{ id: number; name: string }[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [methods, setMethods] = useState<{ id: number; name: string; is_cash: 0 | 1 }[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [page, setPage] = useState(1);

  const [lines, setLines] = useState<CartLine[]>([]);
  const [customerId, setCustomerId] = useState<number | ''>('');
  const [discountType, setDiscountType] = useState<'none' | 'percent' | 'fixed'>('none');
  const [discountValue, setDiscountValue] = useState(0);
  const [taxPercentX100, setTaxPercentX100] = useState(settings?.vat_percent_x100 ?? 0);
  const [note, setNote] = useState('');
  const [computation, setComputation] = useState<Computation | null>(null);
  const [computing, setComputing] = useState(false);
  const [computeError, setComputeError] = useState<string | null>(null);

  const [payOpen, setPayOpen] = useState(false);
  const [paidPaisa, setPaidPaisa] = useState(0);
  const [methodId, setMethodId] = useState<number | ''>('');
  const [reference, setReference] = useState('');
  const [saving, setSaving] = useState(false);

  const [receiptHtml, setReceiptHtml] = useState<string | null>(null);
  const [lastSale, setLastSale] = useState<Sale | null>(null);
  const [printers, setPrinters] = useState<{ name: string; displayName: string; isDefault: boolean }[]>([]);
  const [session, setSession] = useState<{ session: any; in_hand: number } | null>(null);

  const searchRef = useRef<HTMLInputElement | null>(null);
  const barcodeRef = useRef<HTMLInputElement | null>(null);

  /* ---------------- reference data ---------------- */
  useEffect(() => {
    (async () => {
      try {
        const [cats, us, custs, mets, sess] = await Promise.all([
          call<any[]>('settings.categories'),
          call<Unit[]>('settings.units'),
          call<{ rows: Customer[] }>('customers.list', { pageSize: 500, includeInactive: false }),
          call<any[]>('settings.paymentMethods'),
          call<any>('cash.current').catch(() => null),
        ]);
        setCategories(cats);
        setUnits(us);
        setCustomers(custs.rows);
        setMethods(mets);
        setSession(sess);
        const cash = mets.find((m: any) => m.is_cash === 1) ?? mets[0];
        if (cash) setMethodId(cash.id);
        const walkIn = custs.rows.find((c) => c.is_walkin === 1);
        const preferred = settings?.default_customer_id ?? walkIn?.id;
        if (preferred) setCustomerId(preferred);
      } catch (err) {
        ui.error('তথ্য লোড ব্যর্থ', (err as Error).message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- product list ---------------- */
  useEffect(() => {
    let alive = true;
    setLoadingProducts(true);
    const timer = window.setTimeout(async () => {
      try {
        const res = await call<{ rows: ProductWithMeta[]; total: number }>('products.list', {
          search: search.trim() || undefined,
          categoryId,
          page,
          pageSize: 60,
          sort: 'name',
          direction: 'asc',
        });
        if (alive) {
          setProducts(res.rows);
          setProductTotal(res.total);
        }
      } catch (err) {
        if (alive) ui.error('প্রোডাক্ট লোড ব্যর্থ', (err as Error).message);
      } finally {
        if (alive) setLoadingProducts(false);
      }
    }, search ? 220 : 0);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, categoryId, page]);

  useEffect(() => setPage(1), [search, categoryId]);

  /* ---------------- units helper ---------------- */
  const unitsFor = useCallback(
    (product: ProductWithMeta): Unit[] => {
      const primaryId = product.primary_unit_id ?? product.unit_id;
      const family: Unit[] = [];
      const primary = units.find((u) => u.id === product.unit_id);
      if (primary) family.push(primary);
      // include the base unit and any units sharing the same base
      const baseId = primary?.base_unit_id ?? primary?.id ?? primaryId;
      for (const u of units) {
        if (u.id === primary?.id) continue;
        if (u.id === baseId || u.base_unit_id === baseId) family.push(u);
      }
      return family.sort((a, b) => b.factor_milli - a.factor_milli);
    },
    [units],
  );

  const unitLabel = (unitId: number) => units.find((u) => u.id === unitId)?.short_name ?? '';

  /* ---------------- cart operations ---------------- */
  const addProduct = useCallback(
    (product: ProductWithMeta, qtyMilli?: number) => {
      const unitId = product.unit_id;
      const unit = units.find((u) => u.id === unitId);
      const amount = qtyMilli ?? (settings?.scan_increment_qty === 1 ? 1000 : 1000);
      setLines((prev) => {
        const idx = prev.findIndex((l) => l.productId === product.id && l.unitId === unitId);
        if (idx >= 0) {
          const copy = [...prev];
          copy[idx] = { ...copy[idx]!, qtyMilli: copy[idx]!.qtyMilli + amount };
          return copy;
        }
        return [
          ...prev,
          {
            key: `l${lineSeq++}`,
            productId: product.id,
            name: product.name,
            unitId,
            unitLabel: unit?.short_name ?? '',
            factorMilli: unit?.factor_milli ?? 1000,
            qtyMilli: amount,
            basePricePaisa: product.unit_price_paisa ?? product.sale_price,
            unitPricePaisa: product.unit_price_paisa ?? product.sale_price,
            priceEdited: false,
            discountPaisa: 0,
            stockBaseMilli: product.stock_base_milli,
            minStockMilli: product.min_stock_base_milli,
          },
        ];
      });
    },
    [units, settings],
  );

  const patchLine = (key: string, patch: Partial<CartLine>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const removeLine = (key: string) => setLines((prev) => prev.filter((l) => l.key !== key));

  const clearCart = () => {
    setLines([]);
    setDiscountType('none');
    setDiscountValue(0);
    setNote('');
    setComputation(null);
    setComputeError(null);
  };

  /* ---------------- live computation ---------------- */
  useEffect(() => {
    if (!lines.length) {
      setComputation(null);
      setComputeError(null);
      return;
    }
    let alive = true;
    setComputing(true);
    const timer = window.setTimeout(async () => {
      try {
        const result = await call<Computation>('pos.compute', {
          customerId: customerId || null,
          lines: lines.map((l) => ({
            productId: l.productId,
            unitId: l.unitId,
            qtyMilli: l.qtyMilli,
            unitPricePaisa: l.priceEdited ? l.unitPricePaisa : null,
            discountPaisa: l.discountPaisa || null,
          })),
          orderDiscountType: discountType,
          orderDiscountValue: discountValue,
          taxPercentX100,
          paidPaisa: 0,
          actor: { id: 0, username: 'ui' },
        });
        if (alive) {
          setComputation(result);
          setComputeError(null);
        }
      } catch (err) {
        if (alive) {
          setComputation(null);
          setComputeError((err as Error).message);
        }
      } finally {
        if (alive) setComputing(false);
      }
    }, 180);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [lines, customerId, discountType, discountValue, taxPercentX100]);

  /* ---------------- barcode ---------------- */
  const scan = async (code: string) => {
    const term = code.trim();
    if (!term) return;
    try {
      const product = await call<ProductWithMeta | null>('products.byCode', term);
      if (!product) {
        ui.error('প্রোডাক্ট পাওয়া যায়নি', `"${term}" কোডের কোনো প্রোডাক্ট নেই।`);
        return;
      }
      addProduct(product);
      ui.success('যোগ হয়েছে', product.name);
    } catch (err) {
      ui.error('স্ক্যান ব্যর্থ', (err as Error).message);
    }
  };

  /* ---------------- keyboard ---------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F2') {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === 'F8' && lines.length) {
        e.preventDefault();
        openPayment();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines.length, computation]);

  /* ---------------- payment ---------------- */
  const openPayment = () => {
    if (!lines.length || !computation) return;
    if (computeError) {
      ui.error('বিক্রয় সম্পন্ন করা যাবে না', computeError);
      return;
    }
    setPaidPaisa(computation.total);
    setPayOpen(true);
    setReference('');
  };

  const selectedCustomer = customers.find((c) => c.id === customerId) ?? null;
  const changePaisa = Math.max(0, paidPaisa - (computation?.total ?? 0));
  const duePaisa = Math.max(0, (computation?.total ?? 0) - paidPaisa);

  const submitSale = async () => {
    if (!computation) return;
    setSaving(true);
    try {
      const result = await call<{ saleId: number; invoiceNo: string; sale: Sale }>('pos.createSale', {
        customerId: customerId || null,
        lines: lines.map((l) => ({
          productId: l.productId,
          unitId: l.unitId,
          qtyMilli: l.qtyMilli,
          unitPricePaisa: l.priceEdited ? l.unitPricePaisa : null,
          discountPaisa: l.discountPaisa || null,
        })),
        orderDiscountType: discountType,
        orderDiscountValue: discountValue,
        taxPercentX100,
        paidPaisa,
        defaultMethodId: methodId || null,
        payments: paidPaisa > 0 && methodId ? [{ methodId: Number(methodId), amount: paidPaisa, reference: reference || null }] : [],
        note: note || null,
      });
      setPayOpen(false);
      setLastSale(result.sale);
      clearCart();
      const html = await call<string>('print.receiptHtml', result.saleId);
      setReceiptHtml(html);
      if (settings?.print_after_sale === 1) {
        try {
          await call('print.print', result.saleId);
          ui.success('রিসিট প্রিন্ট হয়েছে', `ইনভয়েস ${result.invoiceNo}`);
        } catch (err) {
          ui.error('প্রিন্ট ব্যর্থ', (err as Error).message);
        }
      } else {
        ui.success('বিক্রয় সম্পন্ন', `ইনভয়েস ${result.invoiceNo}`);
      }
      const sess = await call<any>('cash.current').catch(() => null);
      setSession(sess);
    } catch (err) {
      ui.error('বিক্রয় সম্পন্ন হয়নি', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const openCash = async () => {
    const res = await ui.confirm({
      title: 'ক্যাশ সেশন খুলুন',
      message: 'আজকের ক্যাশ দিয়ে সেশন শুরু করুন।',
      confirmLabel: 'সেশন খুলুন',
    });
    if (!res.ok) return;
    try {
      await call('cash.open', 0, 'POS থেকে খোলা হয়েছে');
      const sess = await call<any>('cash.current');
      setSession(sess);
      ui.success('ক্যাশ সেশন চালু');
    } catch (err) {
      ui.error('সেশন খোলা যায়নি', (err as Error).message);
    }
  };

  const loadPrinters = async () => {
    try {
      setPrinters(await call<any[]>('print.printers'));
    } catch (err) {
      ui.error('প্রিন্টার তালিকা পাওয়া যায়নি', (err as Error).message);
    }
  };

  const totals = computation;
  const lineCount = lines.length;
  const unitCount = lines.reduce((s, l) => s + Math.round((l.qtyMilli * l.factorMilli) / 1000), 0);

  return (
    <>
      <div className="pos-layout">
        <div className="pos-left">
          <div className="pos-search">
            <div className="global-search" style={{ maxWidth: 'none' }}>
              <span className="search-icon">
                <Icon name="search" size={16} />
              </span>
              <input
                ref={searchRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="প্রোডাক্টের নাম, এসকেইউ বা বারকোড (F2)"
                onKeyDown={async (e) => {
                  if (e.key === 'Enter' && search.trim()) {
                    const exact = products.find((p) => p.sku === search.trim());
                    if (exact) {
                      addProduct(exact);
                      setSearch('');
                    } else if (products.length === 1) {
                      addProduct(products[0]!);
                      setSearch('');
                    }
                  }
                }}
              />
            </div>
            <div className="global-search" style={{ maxWidth: 210 }}>
              <span className="search-icon">
                <Icon name="scan" size={16} />
              </span>
              <input
                ref={barcodeRef}
                placeholder="বারকোড স্ক্যান"
                onKeyDown={async (e) => {
                  if (e.key === 'Enter') {
                    const value = (e.target as HTMLInputElement).value;
                    (e.target as HTMLInputElement).value = '';
                    await scan(value);
                  }
                }}
              />
            </div>
          </div>

          <div className="chip-row">
            <button className={`chip ${categoryId === null ? 'active' : ''}`} onClick={() => setCategoryId(null)}>
              সব
            </button>
            {categories.map((c) => (
              <button
                key={c.id}
                className={`chip ${categoryId === c.id ? 'active' : ''}`}
                onClick={() => setCategoryId(c.id)}
              >
                {c.name}
              </button>
            ))}
          </div>

          {loadingProducts ? (
            <Loading label="প্রোডাক্ট লোড হচ্ছে…" />
          ) : products.length === 0 ? (
            <EmptyState
              icon="product"
              title="কোনো প্রোডাক্ট পাওয়া যায়নি"
              message={search ? 'অন্য নাম বা কোড দিয়ে খুঁজুন।' : 'প্রোডাক্ট পেজ থেকে নতুন প্রোডাক্ট যোগ করুন।'}
              action={
                <Button icon="product" onClick={() => navigate('products')}>
                  প্রোডাক্ট পেজে যান
                </Button>
              }
            />
          ) : (
            <>
              <div className="pos-products">
                {products.map((p) => {
                  const out = p.stock_base_milli <= 0;
                  const low = !out && p.stock_base_milli <= p.min_stock_base_milli;
                  return (
                    <button
                      key={p.id}
                      className={`product-tile ${out ? 'out' : ''}`}
                      onClick={() => addProduct(p)}
                      title={p.name}
                    >
                      <div className="pt-name">{p.name}</div>
                      <div className="pt-price">{money(p.unit_price_paisa ?? p.sale_price)}</div>
                      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                        <span className={`pt-stock ${low ? 'warn-text' : ''}`}>
                          স্টক {fmtQty(p.stock_base_milli)}
                        </span>
                        {p.unit_short_name ? <span className="pt-stock">{p.unit_short_name}</span> : null}
                      </div>
                      {out ? <span className="pt-badge">স্টক শেষ</span> : low ? <span className="pt-badge">কম</span> : null}
                    </button>
                  );
                })}
              </div>
              {productTotal > 60 ? (
                <div className="row" style={{ justifyContent: 'center', gap: 8, marginTop: 10 }}>
                  <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                    আগের
                  </Button>
                  <span className="small muted num">
                    {page} / {Math.ceil(productTotal / 60)}
                  </span>
                  <Button size="sm" disabled={page >= Math.ceil(productTotal / 60)} onClick={() => setPage((p) => p + 1)}>
                    পরের
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>

        <aside className="pos-cart">
          <div className="cart-head">
            <div>
              <div className="row" style={{ gap: 7 }}>
                <Icon name="pos" size={17} style={{ color: 'var(--brand-600)' }} />
                <strong>বর্তমান বিক্রয়</strong>
              </div>
              <div className="tiny muted">
                {lineCount} টি আইটেম • মোট ইউনিট {fmtQty(unitCount * 1000)}
              </div>
            </div>
            {lines.length ? (
              <Button size="sm" variant="ghost" onClick={() => ui.confirm({ title: 'কার্ট খালি করুন', message: 'সব আইটেম মুছে ফেলবেন?', danger: true, confirmLabel: 'খালি করুন' }).then((r) => r.ok && clearCart())}>
                খালি
              </Button>
            ) : null}
          </div>

          <div className="cart-body">
            <div className="cart-customer">
              <Select
                value={customerId}
                onChange={(v) => setCustomerId(v ? Number(v) : '')}
                options={customers.map((c) => ({
                  value: c.id,
                  label: `${c.name}${c.balance_paisa > 0 ? ` (বাকি ${money(c.balance_paisa)})` : ''}`,
                }))}
                placeholder="কাস্টমার নির্বাচন করুন"
              />
              {selectedCustomer ? (
                <div className="row tiny" style={{ justifyContent: 'space-between', marginTop: 4 }}>
                  <span className="muted">{selectedCustomer.phone || 'মোবাইল নেই'}</span>
                  <span className={`${selectedCustomer.balance_paisa > 0 ? 'warn-text' : 'muted'}`}>
                    বাকি: {money(selectedCustomer.balance_paisa)}
                  </span>
                </div>
              ) : null}
            </div>

            <div className="cart-lines">
              {lines.length === 0 ? (
                <div className="cart-empty">
                  <Icon name="cart" size={26} style={{ color: 'var(--line-strong)' }} />
                  <div className="small muted">প্রোডাক্ট সিলেক্ট করে বিক্রয় শুরু করুন</div>
                  <div className="tiny muted">বা বারকোড স্ক্যানার ব্যবহার করুন</div>
                </div>
              ) : (
                lines.map((line) => {
                  const family = units.filter(
                    (u) =>
                      u.id === line.unitId ||
                      u.base_unit_id === line.unitId ||
                      (units.find((x) => x.id === line.unitId)?.base_unit_id ?? 0) === u.id,
                  );
                  const lineTotal = Math.round((line.unitPricePaisa * line.qtyMilli) / 1000) - line.discountPaisa;
                  const baseForLine = Math.round((line.qtyMilli * line.factorMilli) / 1000);
                  const exceeds = baseForLine > line.stockBaseMilli;
                  return (
                    <div key={line.key} className="cart-line">
                      <div className="cl-main">
                        <div className="cl-name" title={line.name}>
                          {line.name}
                        </div>
                        <div className="cl-sub">
                          {line.factorMilli !== 1000 ? `১ ${line.unitLabel} = ${line.factorMilli / 1000} বেস` : line.unitLabel}
                          {exceeds ? <span className="warn-text"> • স্টকের বেশি</span> : null}
                        </div>
                      </div>
                      <div className="cl-qty">
                        <button
                          className="qty-btn"
                          onClick={() => {
                            const step = line.factorMilli === 1000 ? 1000 : 1000;
                            if (line.qtyMilli - step <= 0) removeLine(line.key);
                            else patchLine(line.key, { qtyMilli: line.qtyMilli - step });
                          }}
                        >
                          −
                        </button>
                        <input
                          className="cl-input num"
                          value={line.qtyMilli / 1000}
                          onChange={(e) => {
                            const n = Number(e.target.value.replace(/[^\d.]/g, ''));
                            patchLine(line.key, { qtyMilli: Number.isFinite(n) ? Math.round(n * 1000) : 0 });
                          }}
                        />
                        <button className="qty-btn" onClick={() => patchLine(line.key, { qtyMilli: line.qtyMilli + (line.factorMilli === 1000 ? 1000 : 1000) })}>
                          +
                        </button>
                      </div>
                      <div className="cl-price">
                        {can('pos.price_edit') ? (
                          <input
                            className="cl-input num"
                            value={(line.unitPricePaisa / 100).toFixed(2)}
                            onChange={(e) => {
                              const n = Number(e.target.value.replace(/[^\d.]/g, ''));
                              patchLine(line.key, {
                                unitPricePaisa: Number.isFinite(n) ? Math.round(n * 100) : 0,
                                priceEdited: true,
                              });
                            }}
                          />
                        ) : (
                          <span className="num small">{money(line.unitPricePaisa)}</span>
                        )}
                      </div>
                      <div className="cl-total num">{money(lineTotal)}</div>
                      <div className="cl-actions">
                        {family.length > 1 ? (
                          <select
                            className="cl-unit"
                            value={line.unitId}
                            onChange={(e) => {
                              const nextId = Number(e.target.value);
                              const next = units.find((u) => u.id === nextId);
                              if (!next) return;
                              // keep the same physical quantity in the new unit
                              const baseMilli = (line.qtyMilli * line.factorMilli) / 1000;
                              patchLine(line.key, {
                                unitId: nextId,
                                unitLabel: next.short_name,
                                factorMilli: next.factor_milli,
                                qtyMilli: Math.round((baseMilli * 1000) / next.factor_milli),
                                unitPricePaisa: line.priceEdited
                                  ? line.unitPricePaisa
                                  : Math.round((line.basePricePaisa * line.factorMilli) / next.factor_milli),
                              });
                            }}
                          >
                            {family.map((u) => (
                              <option key={u.id} value={u.id}>
                                {u.short_name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="tiny muted">{line.unitLabel}</span>
                        )}
                        <IconButton icon="trash" size={15} danger title="বাদ দিন" onClick={() => removeLine(line.key)} />
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div className="cart-totals">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="muted small">সাবটোটাল</span>
                <span className="num">{money(totals?.subtotal ?? 0)}</span>
              </div>
              {can('pos.discount') ? (
                <div className="row" style={{ gap: 6, marginTop: 4 }}>
                  <select
                    className="cl-unit"
                    value={discountType}
                    onChange={(e) => setDiscountType(e.target.value as any)}
                    style={{ width: 92 }}
                  >
                    <option value="none">ডিসকাউন্ট</option>
                    <option value="percent">শতাংশ</option>
                    <option value="fixed">টাকা</option>
                  </select>
                  {discountType !== 'none' ? (
                    discountType === 'percent' ? (
                      <input
                        className="cl-input num"
                        value={discountValue / 100}
                        onChange={(e) => {
                          const n = Number(e.target.value.replace(/[^\d.]/g, ''));
                          setDiscountValue(Number.isFinite(n) ? Math.round(n * 100) : 0);
                        }}
                        placeholder="%"
                      />
                    ) : (
                      <MoneyInput value={discountValue} onChange={setDiscountValue} />
                    )
                  ) : null}
                  <span className="grow" />
                  <span className="num small">−{money(totals?.discount ?? 0)}</span>
                </div>
              ) : totals?.discount ? (
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="muted small">ডিসকাউন্ট</span>
                  <span className="num">−{money(totals.discount)}</span>
                </div>
              ) : null}
              {totals && totals.tax > 0 ? (
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="muted small">ভ্যাট</span>
                  <span className="num">{money(totals.tax)}</span>
                </div>
              ) : null}
              <div className="cart-total-row">
                <span>সর্বমোট</span>
                <span className="num">{money(totals?.total ?? 0)}</span>
              </div>
              {computeError ? <div className="error-text">{computeError}</div> : null}
              {computing ? <div className="tiny muted">হিসাব হচ্ছে…</div> : null}
            </div>
          </div>

          <div className="cart-foot">
            <Button
              variant="primary"
              size="lg"
              block
              disabled={!lines.length || !totals}
              onClick={openPayment}
              icon="wallet"
            >
              পেমেন্ট ({money(totals?.total ?? 0)}) — F8
            </Button>
            {!session?.session ? (
              <button className="link-btn" onClick={openCash}>
                ক্যাশ সেশন এখনো খোলা হয়নি — খুলুন
              </button>
            ) : (
              <div className="tiny muted" style={{ textAlign: 'center' }}>
                ক্যাশ সেশন চালু • হাতে {money(session.in_hand)}
              </div>
            )}
          </div>
        </aside>
      </div>

      {payOpen && computation ? (
        <Modal
          title="পেমেন্ট নিন"
          sub={`মোট বিল ${money(computation.total)} • ${lineCount} টি আইটেম`}
          size="md"
          onClose={() => setPayOpen(false)}
          footer={
            <>
              <Button onClick={() => setPayOpen(false)}>বাতিল</Button>
              <Button variant="primary" loading={saving} onClick={submitSale} icon="check">
                বিক্রয় সম্পন্ন করুন
              </Button>
            </>
          }
        >
          <div className="form-grid">
            <Field label="পেমেন্ট মাধ্যম">
              <Select
                value={methodId}
                onChange={(v) => setMethodId(v ? Number(v) : '')}
                options={methods.map((m) => ({ value: m.id, label: m.name }))}
              />
            </Field>
            <Field label="প্রাপ্ত টাকা">
              <MoneyInput value={paidPaisa} onChange={setPaidPaisa} autoFocus />
            </Field>
            <div className="span-2">
              <div className="row" style={{ gap: 7, flexWrap: 'wrap' }}>
                {[computation.total, Math.ceil(computation.total / 10000) * 10000, Math.ceil(computation.total / 50000) * 50000].map(
                  (amount, i) => (
                    <Button key={i} size="sm" onClick={() => setPaidPaisa(amount)}>
                      {money(amount)}
                    </Button>
                  ),
                )}
                <Button size="sm" onClick={() => setPaidPaisa(0)}>
                  পুরো বাকি
                </Button>
              </div>
            </div>
            <div className="span-2">
              <div className="pay-summary">
                <div>
                  <span className="tiny muted">বিল</span>
                  <div className="num bold">{money(computation.total)}</div>
                </div>
                <div>
                  <span className="tiny muted">প্রাপ্ত</span>
                  <div className="num bold">{money(paidPaisa)}</div>
                </div>
                <div>
                  <span className="tiny muted">{duePaisa > 0 ? 'বাকি থাকবে' : 'ফেরত দিতে হবে'}</span>
                  <div className={`num bold ${duePaisa > 0 ? 'warn-text' : ''}`}>
                    {money(duePaisa > 0 ? duePaisa : changePaisa)}
                  </div>
                </div>
              </div>
            </div>
            {duePaisa > 0 ? (
              <div className="span-2">
                <div className={`banner ${selectedCustomer && selectedCustomer.is_walkin !== 1 ? 'info' : 'warn'}`}>
                  <Icon name="warning" size={16} style={{ marginTop: 2, flex: 'none' }} />
                  <div>
                    {!selectedCustomer
                      ? 'বাকি বিক্রয়ের জন্য কাস্টমার নির্বাচন করতে হবে।'
                      : selectedCustomer.is_walkin === 1
                        ? 'ওয়াক-ইন কাস্টমারের নামে বাকি বিক্রয় করা যাবে না।'
                        : `${selectedCustomer.name} এর বাকিতে ${money(duePaisa)} যোগ হবে (বর্তমান বাকি ${money(selectedCustomer.balance_paisa)})।`}
                  </div>
                </div>
              </div>
            ) : null}
            {paidPaisa > 0 ? (
              <Field label="রেফারেন্স / নোট (ঐচ্ছিক)" span={2}>
                <TextInput value={reference} onChange={setReference} placeholder="যেমন: bKash TrxID" />
              </Field>
            ) : null}
            <Field label="বিক্রয়ের নোট (ঐচ্ছিক)" span={2}>
              <TextInput value={note} onChange={setNote} placeholder="যেমন: দোকানে ডেলিভারি" />
            </Field>
          </div>
        </Modal>
      ) : null}

      {receiptHtml ? (
        <Modal
          title="রিসিট প্রিভিউ"
          sub={lastSale ? `ইনভয়েস ${lastSale.invoice_no} • ${dateTime(lastSale.sale_date)}` : undefined}
          size="lg"
          onClose={() => setReceiptHtml(null)}
          footer={
            <>
              <Button
                icon="list"
                onClick={async () => {
                  setReceiptHtml(null);
                  await onSettingsChanged();
                  navigate('sales');
                }}
              >
                ইনভয়েস দেখুন
              </Button>
              <Button
                icon="print"
                onClick={async () => {
                  if (!lastSale) return;
                  try {
                    const res = await call<any>('print.print', lastSale.id);
                    ui.success('প্রিন্ট হয়েছে', res?.printer);
                  } catch (err) {
                    ui.error('প্রিন্ট ব্যর্থ', (err as Error).message);
                  }
                }}
              >
                প্রিন্ট
              </Button>
              <Button variant="primary" icon="check" onClick={() => setReceiptHtml(null)}>
                নতুন বিক্রয়
              </Button>
            </>
          }
        >
          <div className="receipt-frame">
            <iframe title="রিসিট" srcDoc={receiptHtml} />
          </div>
          <div className="row" style={{ marginTop: 8, gap: 8 }}>
            <Button
              size="sm"
              icon="print"
              onClick={async () => {
                await loadPrinters();
                if (!printers.length) ui.error('প্রিন্টার পাওয়া যায়নি', 'Windows এ থার্মাল প্রিন্টার ইনস্টল ও চালু আছে কিনা দেখুন।');
                else ui.toast('info', 'প্রিন্টার পাওয়া গেছে', printers.map((p) => p.displayName).join(', '));
              }}
            >
              প্রিন্টার যাচাই
            </Button>
            {printers.length ? (
              <span className="small muted">
                ডিফল্ট: {printers.find((p) => p.isDefault)?.displayName ?? printers[0]?.displayName}
              </span>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </>
  );
}

export { Spinner, Badge, QtyInput };
