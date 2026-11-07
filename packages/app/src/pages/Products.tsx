import { useCallback, useEffect, useMemo, useState } from 'react';
import { call } from '../api.js';
import { useShopRefresh } from '../lib/use-shop-refresh.js';
import { money, qty, dateTime } from '../format.js';
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
  PageHead,
  Pagination,
  QtyInput,
  Select,
  Switch,
  Tabs,
  TextInput,
  useDebounced,
  useUI,
} from '../ui.js';
import { baseToPrimaryMilli, primaryFactorOf, primaryToBaseMilli } from '../lib/qty-units.js';

/**
 * F-INV-01: the unit the product form's quantity fields are expressed in. Opening stock, minimum
 * stock, reorder quantity and variant stock are typed as primary units ("10 কেজি"), while the core
 * stores base-unit milli (10 000 000), so every one of them is converted here.
 */
const formPrimaryFactor = (
  editor: { primaryUnitId?: number | '' | null; unitId?: number | '' | null },
  units: ReadonlyArray<{ id: number; factor_milli?: number | null }>,
): number =>
  primaryFactorOf(
    units,
    typeof editor.primaryUnitId === 'number' ? editor.primaryUnitId : null,
    typeof editor.unitId === 'number' ? editor.unitId : null,
  );
import type { Category, ProductWithMeta, Unit } from '../types.js';

const PAGE_SIZE = 25;

interface EditorState {
  id: number | null;
  name: string;
  sku: string;
  productCode: string;
  categoryId: number | '';
  subcategoryId: number | '';
  brandId: number | '';
  unitId: number | '';
  primaryUnitId: number | '';
  purchasePrice: number;
  salePrice: number;
  wholesalePrice: number;
  retailPrice: number;
  discountType: 'none' | 'percent' | 'fixed';
  discountValue: number;
  minStockMilli: number;
  openingStockMilli: number;
  vatPercentX100: number;
  description: string;
  imagePath: string | null;
  barcodes: string;
  batchTracked: boolean;
  expiryTracked: boolean;
  isActive: boolean;
  isService: boolean;
  minSalePricePaisa: number;
  maxDiscountPercentX100: number | '';
  reorderQtyMilli: number;
}

const EMPTY_EDITOR: EditorState = {
  id: null,
  name: '',
  sku: '',
  productCode: '',
  categoryId: '',
  subcategoryId: '',
  brandId: '',
  unitId: '',
  primaryUnitId: '',
  purchasePrice: 0,
  salePrice: 0,
  wholesalePrice: 0,
  retailPrice: 0,
  discountType: 'none',
  discountValue: 0,
  minStockMilli: 0,
  openingStockMilli: 0,
  vatPercentX100: 0,
  description: '',
  imagePath: null,
  barcodes: '',
  batchTracked: false,
  expiryTracked: false,
  isActive: true,
  isService: false,
  minSalePricePaisa: 0,
  maxDiscountPercentX100: '',
  reorderQtyMilli: 0,
};

export function ProductsPage({ can }: { can: (perm?: string) => boolean }) {
  const ui = useUI();
  const [rows, setRows] = useState<ProductWithMeta[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);
  const [categoryId, setCategoryId] = useState<number | ''>('');
  const [stockState, setStockState] = useState<'all' | 'low' | 'out' | 'in'>('all');
  const [sort, setSort] = useState<'name' | 'stock' | 'sale_price' | 'created'>('name');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [loading, setLoading] = useState(true);

  const [categories, setCategories] = useState<Category[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [brands, setBrands] = useState<{ id: number; name: string }[]>([]);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<{ product: ProductWithMeta; rows: any[] } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importOpen, setImportOpen] = useState(false);

  const canManage = can('product.manage');

  // Products, prices and stock arriving from another PC/person reload this list.
  useShopRefresh('products', () => void load());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await call<{ rows: ProductWithMeta[]; total: number }>('products.list', {
        search: debounced.trim() || undefined,
        categoryId: categoryId || null,
        stockState,
        includeInactive,
        page,
        pageSize: PAGE_SIZE,
        sort,
        direction: sort === 'name' ? 'asc' : 'desc',
      });
      setRows(res.rows);
      setTotal(res.total);
    } catch (err) {
      ui.error('প্রোডাক্ট লোড ব্যর্থ', (err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [debounced, categoryId, stockState, includeInactive, page, sort, ui]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    (async () => {
      try {
        const [cats, us, bs] = await Promise.all([
          call<Category[]>('settings.categories', true),
          call<Unit[]>('settings.units', true),
          call<{ id: number; name: string }[]>('settings.brands'),
        ]);
        setCategories(cats);
        setUnits(us);
        setBrands(bs);
      } catch {
        /* non-fatal */
      }
    })();
  }, []);

  useEffect(() => setPage(1), [debounced, categoryId, stockState, includeInactive]);

  const openNew = () => {
    const defaultUnit = units.find((u) => u.is_active === 1);
    setEditor({
      ...EMPTY_EDITOR,
      unitId: defaultUnit?.id ?? '',
      primaryUnitId: defaultUnit?.id ?? '',
    });
  };

  const openEdit = async (row: ProductWithMeta) => {
    try {
      const full = await call<ProductWithMeta>('products.get', row.id);
      setEditor({
        id: full.id,
        name: full.name,
        sku: full.sku ?? '',
        productCode: full.product_code ?? '',
        categoryId: full.category_id ?? '',
        subcategoryId: full.subcategory_id ?? '',
        brandId: full.brand_id ?? '',
        unitId: full.unit_id,
        primaryUnitId: full.primary_unit_id ?? full.unit_id,
        purchasePrice: full.purchase_price,
        salePrice: full.sale_price,
        wholesalePrice: full.wholesale_price ?? 0,
        retailPrice: full.retail_price ?? 0,
        discountType: full.discount_type,
        discountValue: full.discount_value,
        // F-INV-01: the form works in primary units, the row stores base units.
        minStockMilli: baseToPrimaryMilli(full.min_stock_base_milli, full.unit_factor_milli),
        openingStockMilli: 0,
        vatPercentX100: full.vat_percent_x100,
        description: full.description ?? '',
        imagePath: full.image_path,
        barcodes: (full.barcodes ?? []).join(', '),
        batchTracked: full.batch_tracked === 1,
        expiryTracked: full.expiry_tracked === 1,
        isActive: full.is_active === 1,
        isService: (full as any).is_service === 1,
        minSalePricePaisa: (full as any).min_sale_price ?? 0,
        maxDiscountPercentX100:
          (full as any).max_discount_percent_x100 == null ? '' : Number((full as any).max_discount_percent_x100) / 100,
        reorderQtyMilli: (full as any).reorder_qty_base_milli ?? 0,
      });
    } catch (err) {
      ui.error('প্রোডাক্ট লোড ব্যর্থ', (err as Error).message);
    }
  };

  const save = async () => {
    if (!editor) return;
    if (!editor.name.trim()) {
      ui.error('নাম দিতে হবে', 'প্রোডাক্টের নাম ছাড়া সংরক্ষণ করা যাবে না।');
      return;
    }
    setSaving(true);
    try {
      const payload: any = {
        name: editor.name,
        sku: editor.sku || null,
        productCode: editor.productCode || null,
        categoryId: editor.categoryId || null,
        subcategoryId: editor.subcategoryId || null,
        brandId: editor.brandId || null,
        unitId: editor.unitId || null,
        primaryUnitId: editor.primaryUnitId || null,
        purchasePrice: editor.purchasePrice,
        salePrice: editor.salePrice,
        wholesalePrice: editor.wholesalePrice || null,
        retailPrice: editor.retailPrice || null,
        discountType: editor.discountType,
        discountValue: editor.discountValue,
        minStockMilli: primaryToBaseMilli(editor.minStockMilli, formPrimaryFactor(editor, units)),
        vatPercentX100: editor.vatPercentX100,
        description: editor.description || null,
        imagePath: editor.imagePath,
        batchTracked: editor.batchTracked,
        expiryTracked: editor.expiryTracked,
        isActive: editor.isActive,
        isService: editor.isService,
        reorderQtyMilli: editor.reorderQtyMilli,
        minSalePricePaisa: editor.minSalePricePaisa > 0 ? editor.minSalePricePaisa : null,
        maxDiscountPercentX100: editor.maxDiscountPercentX100 === '' ? null : Number(editor.maxDiscountPercentX100) * 100,
      };
      if (editor.id) {
        await call('products.update', editor.id, payload);
        ui.success('প্রোডাক্ট আপডেট হয়েছে', editor.name);
      } else {
        // F-INV-01: the form asks for the primary unit (label: "প্রাইমারি ইউনিট").
        payload.openingStockMilli = primaryToBaseMilli(editor.openingStockMilli, formPrimaryFactor(editor, units));
        payload.barcodes = editor.barcodes
          .split(',')
          .map((b) => b.trim())
          .filter(Boolean)
          .map((code) => ({ code }));
        await call('products.create', payload);
        ui.success('নতুন প্রোডাক্ট যোগ হয়েছে', editor.name);
      }
      setEditor(null);
      await load();
    } catch (err) {
      ui.error('সংরক্ষণ ব্যর্থ', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (row: ProductWithMeta) => {
    const res = await ui.confirm({
      title: row.is_active === 1 ? 'প্রোডাক্ট নিষ্ক্রিয় করুন' : 'প্রোডাক্ট সক্রিয় করুন',
      message:
        row.is_active === 1
          ? `"${row.name}" বিক্রয়ের তালিকায় দেখাবে না, তবে পুরোনো ইনভয়েস ও স্টক ইতিহাস অক্ষত থাকবে।`
          : `"${row.name}" আবার বিক্রয়ের তালিকায় ফিরে আসবে।`,
      confirmLabel: row.is_active === 1 ? 'নিষ্ক্রিয় করুন' : 'সক্রিয় করুন',
    });
    if (!res.ok) return;
    try {
      await call('products.archive', row.id, row.is_active !== 1);
      ui.success('আপডেট হয়েছে');
      await load();
    } catch (err) {
      ui.error('ব্যর্থ', (err as Error).message);
    }
  };

  const remove = async (row: ProductWithMeta) => {
    const res = await ui.confirm({
      title: 'প্রোডাক্ট ডিলিট',
      message: `"${row.name}" স্থায়ীভাবে ডিলিট করবেন?`,
      detail: 'যেসব প্রোডাক্টে বিক্রয় বা পারচেজ হয়েছে সেগুলো ডিলিট করা যাবে না — সেগুলো নিষ্ক্রিয় করুন।',
      danger: true,
      confirmLabel: 'ডিলিট করুন',
    });
    if (!res.ok) return;
    try {
      await call('products.delete', row.id);
      ui.success('ডিলিট হয়েছে');
      await load();
    } catch (err) {
      ui.error('ডিলিট করা যায়নি', (err as Error).message);
    }
  };

  const openHistory = async (row: ProductWithMeta) => {
    try {
      const rows = await call<any[]>('products.priceHistory', row.id);
      setHistory({ product: row, rows });
    } catch (err) {
      ui.error('দামের ইতিহাস পাওয়া যায়নি', (err as Error).message);
    }
  };

  const pickImage = async () => {
    try {
      const path = await call<string | null>('products.pickImage');
      if (path && editor) setEditor({ ...editor, imagePath: path });
    } catch (err) {
      ui.error('ছবি যোগ করা যায়নি', (err as Error).message);
    }
  };

  const printLabels = async () => {
    if (!selected.size) return;
    try {
      await call('print.labels', Array.from(selected), 1);
      ui.success('লেবেল প্রিন্ট পাঠানো হয়েছে');
    } catch (err) {
      ui.error('লেবেল প্রিন্ট ব্যর্থ', (err as Error).message);
    }
  };

  const parents = useMemo(() => categories.filter((c) => !c.parent_id), [categories]);
  const subs = useMemo(
    () => (editor?.categoryId ? categories.filter((c) => c.parent_id === editor.categoryId) : []),
    [categories, editor?.categoryId],
  );

  return (
    <>
      <PageHead
        title="প্রোডাক্ট"
        sub="সব পণ্যের তালিকা, মূল্য, স্টক ও বারকোড"
        actions={
          <>
            {can('product.manage') ? (
              <>
                <Button icon="upload" onClick={() => setImportOpen(true)}>
                  CSV ইমপোর্ট
                </Button>
                <Button variant="primary" icon="plus" onClick={openNew}>
                  নতুন প্রোডাক্ট
                </Button>
              </>
            ) : null}
          </>
        }
      />

      <Card>
        <div className="toolbar">
          <div className="global-search" style={{ maxWidth: 320 }}>
            <span className="search-icon">
              <Icon name="search" size={16} />
            </span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="নাম, SKU বা কোড" />
          </div>
          <Select
            value={categoryId}
            onChange={(v) => setCategoryId(v ? Number(v) : '')}
            options={parents.map((c) => ({ value: c.id, label: c.name }))}
            placeholder="সব ক্যাটাগরি"
            className="w-160"
          />
          <Select
            value={stockState}
            onChange={(v) => setStockState(v as any)}
            options={[
              { value: 'all', label: 'সব স্টক' },
              { value: 'in', label: 'স্টক আছে' },
              { value: 'low', label: 'কম স্টক' },
              { value: 'out', label: 'স্টক শেষ' },
            ]}
          />
          <Select
            value={sort}
            onChange={(v) => setSort(v as any)}
            options={[
              { value: 'name', label: 'নাম অনুযায়ী' },
              { value: 'stock', label: 'স্টক অনুযায়ী' },
              { value: 'sale_price', label: 'বিক্রয়মূল্য' },
              { value: 'created', label: 'নতুন আগে' },
            ]}
          />
          <Switch checked={includeInactive} onChange={setIncludeInactive} label="নিষ্ক্রিয় সহ" />
          <span className="grow" />
          {selected.size ? (
            <>
              <span className="small muted">{selected.size} টি নির্বাচিত</span>
              <Button size="sm" icon="print" onClick={printLabels}>
                লেবেল প্রিন্ট
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                বাতিল
              </Button>
            </>
          ) : (
            <span className="small muted">মোট {total} টি প্রোডাক্ট</span>
          )}
        </div>

        {loading ? (
          <Loading />
        ) : (
          <>
            <DataTable
              rows={rows}
              rowKey={(r) => r.id}
              empty={
                <EmptyState
                  icon="product"
                  title="কোনো প্রোডাক্ট নেই"
                  message="নতুন প্রোডাক্ট যোগ করে বিক্রয় শুরু করুন।"
                  action={
                    canManage ? (
                      <Button variant="primary" icon="plus" onClick={openNew}>
                        নতুন প্রোডাক্ট
                      </Button>
                    ) : undefined
                  }
                />
              }
              columns={[
                {
                  key: 'select',
                  label: '',
                  width: 34,
                  render: (r) => (
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        e.target.checked ? next.add(r.id) : next.delete(r.id);
                        setSelected(next);
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ),
                },
                {
                  key: 'name',
                  label: 'প্রোডাক্ট',
                  render: (r) => (
                    <div>
                      <div className="bold">{r.name}</div>
                      <div className="tiny muted">
                        {r.sku ? `SKU: ${r.sku}` : 'SKU নেই'}
                        {r.category_name ? ` • ${r.category_name}` : ''}
                        {r.is_active === 0 ? ' • নিষ্ক্রিয়' : ''}
                      </div>
                    </div>
                  ),
                },
                { key: 'unit_short_name', label: 'ইউনিট', render: (r) => r.primary_unit_short_name ?? '—' },
                { key: 'purchase_price', label: 'ক্রয়মূল্য', align: 'right', render: (r) => <span className="num">{money(r.purchase_price)}</span> },
                {
                  key: 'sale_price',
                  label: 'বিক্রয়মূল্য',
                  align: 'right',
                  render: (r) => (
                    <div className="num">
                      {r.offer_active ? (
                        <>
                          <span className="bold">{money(r.final_price_paisa ?? r.sale_price)}</span>
                          <div className="tiny muted" style={{ textDecoration: 'line-through' }}>
                            {money(r.base_price_paisa ?? r.sale_price)}
                          </div>
                        </>
                      ) : (
                        <span className="bold">{money(r.sale_price)}</span>
                      )}
                    </div>
                  ),
                },
                {
                  key: 'stock_base_milli',
                  label: 'স্টক',
                  align: 'right',
                  render: (r) => {
                    const out = r.stock_base_milli <= 0;
                    const low = !out && r.stock_base_milli <= r.min_stock_base_milli;
                    return (
                      <span className={`num ${out ? 'danger-text' : low ? 'warn-text' : ''}`}>
                        {qty(baseToPrimaryMilli(r.stock_base_milli, r.unit_factor_milli))}{' '}
                        {r.primary_unit_short_name ?? ''}
                      </span>
                    );
                  },
                },
                {
                  key: 'avg_cost_micro',
                  label: 'গড় ক্রয়',
                  align: 'right',
                  render: (r) => (
                    <span className="num tiny muted">
                      {r.avg_cost_micro > 0 ? money(Math.round(r.avg_cost_micro / 1000)) : '—'}
                    </span>
                  ),
                },
                {
                  key: 'actions',
                  label: '',
                  align: 'right',
                  width: 130,
                  render: (r) => (
                    <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                      <IconButton icon="clock" title="দামের ইতিহাস" onClick={() => openHistory(r)} />
                      {canManage ? <IconButton icon="edit" title="সম্পাদনা" onClick={() => openEdit(r)} /> : null}
                      {canManage ? (
                        <IconButton
                          icon={r.is_active === 1 ? 'eye' : 'refresh'}
                          title={r.is_active === 1 ? 'নিষ্ক্রিয় করুন' : 'সক্রিয় করুন'}
                          onClick={() => toggleActive(r)}
                        />
                      ) : null}
                      {can('product.delete') ? <IconButton icon="trash" title="ডিলিট" danger onClick={() => remove(r)} /> : null}
                    </div>
                  ),
                },
              ]}
            />
            <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPage={setPage} />
          </>
        )}
      </Card>

      {editor ? (
        <ProductEditor
          editor={editor}
          setEditor={setEditor}
          parents={parents}
          subs={subs}
          units={units}
          brands={brands}
          saving={saving}
          onSave={save}
          onClose={() => setEditor(null)}
          onPickImage={pickImage}
        />
      ) : null}

      {history ? (
        <Modal
          title={`দামের ইতিহাস — ${history.product.name}`}
          onClose={() => setHistory(null)}
          size="md"
          footer={<Button onClick={() => setHistory(null)}>বন্ধ</Button>}
        >
          <DataTable
            compact
            rows={history.rows}
            columns={[
              { key: 'created_at', label: 'সময়', render: (r) => dateTime(r.created_at) },
              { key: 'field', label: 'ক্ষেত্র', render: (r) => (r.field === 'sale_price' ? 'বিক্রয়মূল্য' : r.field === 'purchase_price' ? 'ক্রয়মূল্য' : r.field) },
              { key: 'old_value', label: 'আগে', align: 'right' },
              { key: 'new_value', label: 'পরে', align: 'right' },
            ]}
            empty={<EmptyState icon="clock" title="কোনো পরিবর্তন নেই" />}
          />
        </Modal>
      ) : null}

      {importOpen ? <ImportModal onClose={() => setImportOpen(false)} onDone={() => void load()} /> : null}
    </>
  );
}

function ProductEditor({
  editor,
  setEditor,
  parents,
  subs,
  units,
  brands,
  saving,
  onSave,
  onClose,
  onPickImage,
}: {
  editor: EditorState;
  setEditor: (v: EditorState) => void;
  parents: { id: number; name: string }[];
  subs: { id: number; name: string }[];
  units: Unit[];
  brands: { id: number; name: string }[];
  saving: boolean;
  onSave: () => void;
  onClose: () => void;
  onPickImage: () => void;
}) {
  const [tab, setTab] = useState<'basic' | 'price' | 'stock' | 'extra'>('basic');
  const set = (patch: Partial<EditorState>) => setEditor({ ...editor, ...patch });
  const [variants, setVariants] = useState<any[]>([]);
  const [variantOpen, setVariantOpen] = useState(false);
  const [variantName, setVariantName] = useState('');
  const [variantAttr, setVariantAttr] = useState('');
  const [variantPrice, setVariantPrice] = useState(0);
  const [variantStock, setVariantStock] = useState(0);

  const loadVariants = useCallback(async (id: number) => {
    try {
      setVariants(await call<any[]>('products.variants', id));
    } catch {
      setVariants([]);
    }
  }, []);

  useEffect(() => {
    if (editor.id) void loadVariants(editor.id);
  }, [editor.id, loadVariants]);
  const margin =
    editor.purchasePrice > 0 && editor.salePrice > 0
      ? ((editor.salePrice - editor.purchasePrice) / editor.salePrice) * 100
      : null;

  return (
    <Modal
      title={editor.id ? 'প্রোডাক্ট সম্পাদনা' : 'নতুন প্রোডাক্ট'}
      sub={editor.id ? editor.name : 'সব তথ্য পূরণ করে সংরক্ষণ করুন'}
      size="lg"
      onClose={onClose}
      footer={
        <>
          {editor.id ? (
            <Button icon="grid" onClick={() => setVariantOpen(true)}>
              ভ্যারিয়েন্ট ({variants.length})
            </Button>
          ) : null}
          <Button onClick={onClose}>বাতিল</Button>
          <Button variant="primary" loading={saving} onClick={onSave} icon="check">
            সংরক্ষণ
          </Button>
        </>
      }
    >
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'basic', label: 'মৌলিক তথ্য' },
          { id: 'price', label: 'মূল্য' },
          { id: 'stock', label: 'স্টক' },
          { id: 'extra', label: 'বারকোড ও অন্যান্য' },
        ]}
      />
      {tab === 'basic' ? (
        <div className="form-grid">
          <Field label="প্রোডাক্টের নাম *" span={2}>
            <TextInput value={editor.name} onChange={(v) => set({ name: v })} autoFocus placeholder="যেমন: মিনিকেট চাল ৫ কেজি" />
          </Field>
          <Field label="SKU">
            <TextInput value={editor.sku} onChange={(v) => set({ sku: v })} placeholder="MINIKET-5KG" />
          </Field>
          <Field label="প্রোডাক্ট কোড">
            <TextInput value={editor.productCode} onChange={(v) => set({ productCode: v })} />
          </Field>
          <Field label="ক্যাটাগরি">
            <Select
              value={editor.categoryId}
              onChange={(v) => set({ categoryId: v ? Number(v) : '', subcategoryId: '' })}
              options={parents.map((c) => ({ value: c.id, label: c.name }))}
              placeholder="ক্যাটাগরি নির্বাচন"
            />
          </Field>
          <Field label="সাব-ক্যাটাগরি">
            <Select
              value={editor.subcategoryId}
              onChange={(v) => set({ subcategoryId: v ? Number(v) : '' })}
              options={subs.map((c) => ({ value: c.id, label: c.name }))}
              placeholder={editor.categoryId ? 'সাব-ক্যাটাগরি' : 'আগে ক্যাটাগরি নির্বাচন করুন'}
              disabled={!editor.categoryId}
            />
          </Field>
          <Field label="ব্র্যান্ড">
            <Select
              value={editor.brandId}
              onChange={(v) => set({ brandId: v ? Number(v) : '' })}
              options={brands.map((b) => ({ value: b.id, label: b.name }))}
              placeholder="ব্র্যান্ড নেই"
            />
          </Field>
          <Field label="বিক্রয় ইউনিট" hint="কাউন্টারে যে ইউনিটে বিক্রি হবে">
            <Select
              value={editor.unitId}
              onChange={(v) => set({ unitId: v ? Number(v) : '', primaryUnitId: editor.primaryUnitId || Number(v) })}
              options={units.map((u) => ({ value: u.id, label: `${u.name} (${u.short_name})` }))}
            />
          </Field>
          <Field label="প্রাইমারি ইউনিট" hint="মূল্য ও স্টক এই ইউনিটে হিসাব হয়">
            <Select
              value={editor.primaryUnitId}
              onChange={(v) => set({ primaryUnitId: v ? Number(v) : '' })}
              options={units.map((u) => ({ value: u.id, label: `${u.name} (${u.short_name})` }))}
            />
          </Field>
          <Field label="বিবরণ" span={2}>
            <textarea className="input" rows={2} value={editor.description} onChange={(e) => set({ description: e.target.value })} />
          </Field>
        </div>
      ) : null}

      {tab === 'price' ? (
        <div className="form-grid">
          <Field label="ক্রয়মূল্য (টাকা)">
            <MoneyInput value={editor.purchasePrice} onChange={(v) => set({ purchasePrice: v })} />
          </Field>
          <Field label="বিক্রয়মূল্য (টাকা)">
            <MoneyInput value={editor.salePrice} onChange={(v) => set({ salePrice: v })} />
          </Field>
          <Field label="পাইকারি মূল্য">
            <MoneyInput value={editor.wholesalePrice} onChange={(v) => set({ wholesalePrice: v })} />
          </Field>
          <Field label="খুচরা মূল্য">
            <MoneyInput value={editor.retailPrice} onChange={(v) => set({ retailPrice: v })} />
          </Field>
          <Field label="ডিসকাউন্ট ধরণ">
            <Select
              value={editor.discountType}
              onChange={(v) => set({ discountType: v as any })}
              options={[
                { value: 'none', label: 'ডিসকাউন্ট নেই' },
                { value: 'percent', label: 'শতাংশ (%)' },
                { value: 'fixed', label: 'নির্দিষ্ট টাকা' },
              ]}
            />
          </Field>
          <Field label={editor.discountType === 'percent' ? 'ডিসকাউন্ট (%)' : 'ডিসকাউন্ট (টাকা)'}>
            {editor.discountType === 'percent' ? (
              <TextInput
                value={editor.discountValue / 100}
                onChange={(v) => {
                  const n = Number(v.replace(/[^\d.]/g, ''));
                  set({ discountValue: Number.isFinite(n) ? Math.round(n * 100) : 0 });
                }}
                placeholder="0"
              />
            ) : (
              <MoneyInput value={editor.discountValue} onChange={(v) => set({ discountValue: v })} disabled={editor.discountType === 'none'} />
            )}
          </Field>
          <Field label="ভ্যাট (%)">
            <TextInput
              value={editor.vatPercentX100 / 100}
              onChange={(v) => {
                const n = Number(v.replace(/[^\d.]/g, ''));
                set({ vatPercentX100: Number.isFinite(n) ? Math.round(n * 100) : 0 });
              }}
            />
          </Field>
          <div className="span-2">
            {margin !== null ? (
              <Banner tone={margin < 0 ? 'danger' : margin < 5 ? 'warn' : 'success'} icon="chart">
                প্রতিটি বিক্রয়ে সম্ভাব্য মার্জিন {(editor.salePrice - editor.purchasePrice) / 100} টাকা ({margin.toFixed(1)}%)
              </Banner>
            ) : (
              <Banner tone="info" icon="info">
                ক্রয়মূল্য ও বিক্রয়মূল্য দুইটাই দিলে মার্জিন দেখানো হবে।
              </Banner>
            )}
          </div>
        </div>
      ) : null}

      {tab === 'stock' ? (
        <div className="form-grid">
          {!editor.id ? (
            <Field label="ওপেনিং স্টক" hint="বর্তমানে হাতে থাকা পরিমাণ (প্রাইমারি ইউনিট)">
              <QtyInput value={editor.openingStockMilli} onChange={(v) => set({ openingStockMilli: v })} />
            </Field>
          ) : (
            <div className="span-1">
              <Banner tone="info" icon="info">
                স্টক পরিবর্তন করতে ইনভেন্টরি পেজের “সমন্বয়” ব্যবহার করুন — প্রতিটি পরিবর্তন অডিট লগে থাকবে।
              </Banner>
            </div>
          )}
          <Field label="সর্বনিম্ন স্টক (অ্যালার্ট)">
            <QtyInput value={editor.minStockMilli} onChange={(v) => set({ minStockMilli: v })} />
          </Field>
          <Field label="রিঅর্ডার পরিমাণ" hint="স্টক কমলে কত কিনতে হবে (প্রাইমারি ইউনিট)">
            <QtyInput value={editor.reorderQtyMilli} onChange={(v) => set({ reorderQtyMilli: v })} />
          </Field>
          <div className="span-2">
            <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
              <Switch checked={editor.batchTracked} onChange={(v) => set({ batchTracked: v })} label="ব্যাচ ট্র্যাকিং" />
              <Switch checked={editor.expiryTracked} onChange={(v) => set({ expiryTracked: v })} label="মেয়াদ ট্র্যাকিং" />
              <Switch checked={editor.isService} onChange={(v) => set({ isService: v })} label="সেবা / নন-স্টক" />
              <Switch checked={editor.isActive} onChange={(v) => set({ isActive: v })} label="সক্রিয়" />
            </div>
            {editor.isService ? (
              <div className="tiny muted" style={{ marginTop: 4 }}>
                সেবার ক্ষেত্রে স্টক গণনা হবে না — যেমন ডেলিভারি চার্জ, সার্ভিসিং ফি।
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {variantOpen && editor.id ? (
        <Modal
          title={`ভ্যারিয়েন্ট — ${editor.name}`}
          sub="সাইজ/কালার/প্যাক অনুযায়ী আলাদা স্টক ও দাম"
          size="md"
          onClose={() => setVariantOpen(false)}
          footer={<Button onClick={() => setVariantOpen(false)}>বন্ধ</Button>}
        >
          <div className="stack" style={{ gap: 10 }}>
            {variants.length === 0 ? (
              <span className="small muted">এই প্রোডাক্টের কোনো ভ্যারিয়েন্ট নেই।</span>
            ) : (
              variants.map((v) => (
                <div key={v.id} className="row" style={{ justifyContent: 'space-between' }}>
                  <span>{v.name}</span>
                  <span className="num small">
                    {money(v.sale_price)} • স্টক {qty(baseToPrimaryMilli(v.stock_base_milli, v.unit_factor_milli ?? formPrimaryFactor(editor, units)))}
                  </span>
                </div>
              ))
            )}
            <div className="form-grid">
              <Field label="ভ্যারিয়েন্ট নাম" span={2}>
                <TextInput value={variantName} onChange={setVariantName} placeholder="যেমন: টি-শার্ট (L)" />
              </Field>
              <Field label="অ্যাট্রিবিউট" span={2}>
                <TextInput value={variantAttr} onChange={setVariantAttr} placeholder="যেমন: সাইজ=L, কালার=নীল" />
              </Field>
              <Field label="বিক্রয়মূল্য">
                <MoneyInput value={variantPrice} onChange={setVariantPrice} />
              </Field>
              <Field label="ওপেনিং স্টক">
                <QtyInput value={variantStock} onChange={setVariantStock} />
              </Field>
              <div className="span-2">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!variantName.trim()}
                  onClick={async () => {
                    try {
                      const attributes: Record<string, string> = {};
                      variantAttr
                        .split(',')
                        .map((x) => x.trim())
                        .filter(Boolean)
                        .forEach((pair) => {
                          const [k, ...rest] = pair.split('=');
                          if (k && rest.length) attributes[k.trim()] = rest.join('=').trim();
                        });
                      await call('products.createVariant', editor.id, {
                        name: variantName.trim(),
                        attributes,
                        salePrice: variantPrice || editor.salePrice,
                        openingStockMilli: primaryToBaseMilli(variantStock, formPrimaryFactor(editor, units)),
                        openingCostMicro: editor.purchasePrice,
                      });
                      setVariantName('');
                      setVariantAttr('');
                      setVariantPrice(0);
                      setVariantStock(0);
                      await loadVariants(editor.id!);
                    } catch (err) {
                      window.alert((err as Error).message);
                    }
                  }}
                >
                  ভ্যারিয়েন্ট যোগ করুন
                </Button>
              </div>
            </div>
          </div>
        </Modal>
      ) : null}

      {tab === 'extra' ? (
        <div className="form-grid">
          <Field label="সর্বনিম্ন বিক্রয়মূল্য" hint="এর কম দামে বিক্রি করতে অনুমতি লাগবে (০ = সীমা নেই)">
            <MoneyInput value={editor.minSalePricePaisa} onChange={(v) => set({ minSalePricePaisa: v })} />
          </Field>
          <Field label="সর্বোচ্চ ডিসকাউন্ট (%)" hint="খালি রাখলে কোনো সীমা নেই">
            <TextInput
              value={editor.maxDiscountPercentX100}
              onChange={(v) => {
                const n = Number(v.replace(/[^\d.]/g, ''));
                set({ maxDiscountPercentX100: v === '' ? '' : Number.isFinite(n) ? n : '' });
              }}
              placeholder="যেমন: 10"
            />
          </Field>
          <Field label="বারকোড (কমা দিয়ে একাধিক)" span={2} hint="স্ক্যানারে ব্যবহারযোগ্য কোড">
            <TextInput value={editor.barcodes} onChange={(v) => set({ barcodes: v })} placeholder="8901234567890, 123456" />
          </Field>
          <Field label="প্রোডাক্টের ছবি" span={2}>
            <div className="row" style={{ gap: 10 }}>
              {editor.imagePath ? (
                <span className="small mono" style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {editor.imagePath.split(/[\\/]/).pop()}
                </span>
              ) : (
                <span className="small muted">কোনো ছবি নেই</span>
              )}
              <Button size="sm" icon="upload" onClick={onPickImage}>
                ছবি নির্বাচন
              </Button>
              {editor.imagePath ? (
                <Button size="sm" variant="ghost" onClick={() => set({ imagePath: null })}>
                  সরান
                </Button>
              ) : null}
            </div>
          </Field>
        </div>
      ) : null}
    </Modal>
  );
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const ui = useUI();
  const [kind, setKind] = useState<'products' | 'customers' | 'suppliers'>('products');
  const [preview, setPreview] = useState<any | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = async () => {
    setBusy(true);
    try {
      const res = await call<{ file: string; preview: any } | null>('imports.preview', kind);
      if (res) {
        setFile(res.file);
        setPreview(res.preview);
      }
    } catch (err) {
      ui.error('ফাইল পড়া যায়নি', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const content = await call<string>('imports.readFile', file);
      const mapping = preview?.mapping;
      const result = await call<any>('imports.commit', kind, content, { mapping, skipDuplicates: true, createMissing: true });
      ui.success(
        'ইমপোর্ট সম্পন্ন',
        `যোগ: ${result.created}, আপডেট: ${result.updated}, বাদ: ${result.skipped}, ভুল: ${result.errors.length}`,
      );
      onDone();
      onClose();
    } catch (err) {
      ui.error('ইমপোর্ট ব্যর্থ', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="CSV ইমপোর্ট"
      sub="প্রোডাক্ট, কাস্টমার বা সাপ্লায়ার একসাথে যোগ করুন"
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>বাতিল</Button>
          <Button icon="download" onClick={() => void call('imports.template', kind).then((p) => p && ui.success('টেমপ্লেট সংরক্ষিত'))}>
            টেমপ্লেট
          </Button>
          <Button variant="primary" icon="upload" loading={busy} onClick={pick}>
            CSV নির্বাচন
          </Button>
          {preview ? (
            <Button
              variant="primary"
              icon="check"
              loading={busy}
              disabled={preview.valid_count === 0}
              onClick={commit}
            >
              ইমপোর্ট করুন ({preview.valid_count})
            </Button>
          ) : null}
        </>
      }
    >
      <Field label="কী ইমপোর্ট করবেন">
        <Select
          value={kind}
          onChange={(v) => {
            setKind(v as any);
            setPreview(null);
            setFile(null);
          }}
          options={[
            { value: 'products', label: 'প্রোডাক্ট' },
            { value: 'customers', label: 'কাস্টমার' },
            { value: 'suppliers', label: 'সাপ্লায়ার' },
          ]}
        />
      </Field>
      {preview ? (
        <>
          <div className="row" style={{ gap: 8, margin: '10px 0', flexWrap: 'wrap' }}>
            <Badge tone="green">সঠিক: {preview.valid_count}</Badge>
            <Badge tone="amber">ডুপ্লিকেট: {preview.duplicate_count}</Badge>
            <Badge tone="red">ভুল: {preview.error_count}</Badge>
            <span className="tiny muted">{file?.split(/[\\/]/).pop()}</span>
          </div>
          <div style={{ maxHeight: 320, overflow: 'auto' }}>
            <DataTable
              compact
              rows={preview.rows.slice(0, 60)}
              columns={[
                { key: 'line', label: 'লাইন', width: 60 },
                {
                  key: 'values',
                  label: 'তথ্য',
                  render: (r: any) => (
                    <span className="small">
                      {Object.entries(r.values)
                        .filter(([, v]) => v)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(' • ')}
                    </span>
                  ),
                },
                {
                  key: 'status',
                  label: 'অবস্থা',
                  render: (r: any) =>
                    r.errors.length ? (
                      <span className="danger-text small">{r.errors.join(', ')}</span>
                    ) : r.duplicate ? (
                      <span className="warn-text small">আগেই আছে</span>
                    ) : (
                      <span className="success-text small">নতুন</span>
                    ),
                },
              ]}
            />
          </div>
        </>
      ) : (
        <Banner tone="info" icon="info">
          CSV ফাইলের প্রথম লাইনে কলামের নাম থাকতে হবে। টেমপ্লেট ডাউনলোড করে সেটি পূরণ করা সবচেয়ে সহজ।
        </Banner>
      )}
    </Modal>
  );
}
