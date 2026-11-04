import { useEffect, useState } from 'react';
import { call } from '../api.js';
import { useShopRefresh } from '../lib/use-shop-refresh.js';
import { money, qty as fmtQty, dateTime, today } from '../format.js';
import { Icon } from '../icons.js';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardHead,
  DataTable,
  EmptyState,
  Field,
  IconButton,
  Loading,
  Modal,
  PageHead,
  Select,
  Tabs,
  TextInput,
  useDebounced,
  useUI,
} from '../ui.js';

type Tab = 'locations' | 'transfers' | 'counts' | 'reorder' | 'valuation' | 'dead' | 'serials' | 'bundles';

interface Location {
  id: number;
  name: string;
  kind: string;
  address: string | null;
  is_default: number;
  is_active: number;
  qty_base_milli: number;
  sku_count: number;
}

const KIND_LABEL: Record<string, string> = { shop: 'দোকান', godown: 'গুদাম', warehouse: 'ওয়্যারহাউস' };

/** Small reusable product picker: search a product, then add it to a line list. */
function useProductSearch() {
  const [term, setTerm] = useState('');
  const debounced = useDebounced(term);
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await call<{ rows: any[] }>('products.list', {
          search: debounced.trim() || undefined,
          pageSize: 12,
          stockState: 'all',
        });
        if (alive) setRows(res.rows ?? []);
      } catch {
        if (alive) setRows([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [debounced]);
  return { term, setTerm, rows };
}

export function StockOpsPage({ can }: { can: (perm?: string) => boolean }) {
  const ui = useUI();
  const [tab, setTab] = useState<Tab>('locations');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [locations, setLocations] = useState<Location[]>([]);
  const [locationsReady, setLocationsReady] = useState(false);

  // locations
  const [locModal, setLocModal] = useState(false);
  const [locName, setLocName] = useState('');
  const [locKind, setLocKind] = useState<'shop' | 'godown' | 'warehouse'>('godown');
  const [locAddress, setLocAddress] = useState('');

  // transfers
  const [transfers, setTransfers] = useState<any[]>([]);
  const [transferTotal, setTransferTotal] = useState(0);
  const [transferOpen, setTransferOpen] = useState(false);
  const [fromLoc, setFromLoc] = useState<number | ''>('');
  const [toLoc, setToLoc] = useState<number | ''>('');
  const [transferNote, setTransferNote] = useState('');
  const [transferLines, setTransferLines] = useState<{ productId: number; name: string; qtyBaseMilli: number }[]>([]);
  const [transferDetail, setTransferDetail] = useState<{ transfer: any; items: any[] } | null>(null);

  // counts
  const [counts, setCounts] = useState<any[]>([]);
  const [countOpen, setCountOpen] = useState(false);
  const [countLoc, setCountLoc] = useState<number | ''>('');
  const [countNote, setCountNote] = useState('');
  const [countAll, setCountAll] = useState(false);
  const [sheet, setSheet] = useState<{ count: any; items: any[] } | null>(null);
  const [sheetEdits, setSheetEdits] = useState<Record<number, number>>({});

  // reorder / valuation / dead
  const [reorder, setReorder] = useState<any[]>([]);
  const [valuation, setValuation] = useState<any>(null);
  const [dead, setDead] = useState<any[]>([]);

  // serials
  const [serials, setSerials] = useState<any[]>([]);
  const [serialTotal, setSerialTotal] = useState(0);
  const [serialModal, setSerialModal] = useState(false);
  const [serialProduct, setSerialProduct] = useState<any | null>(null);
  const [serialText, setSerialText] = useState('');

  // bundles
  const [bundleParent, setBundleParent] = useState<any | null>(null);
  const [bundleLines, setBundleLines] = useState<{ childId: number; child_name: string; qty_base_milli: number }[]>([]);
  const [bundleInfo, setBundleInfo] = useState<{ lines: any[]; capacity: number } | null>(null);

  const productSearch = useProductSearch();
  const canTransfer = can('stock.transfer');
  const canCount = can('stock.count');

  const loadLocations = async () => {
    try {
      const rows = await call<Location[]>('locations.list');
      setLocations(rows);
      if (!fromLoc && rows.length) setFromLoc(rows.find((l) => l.is_default === 1)?.id ?? rows[0]!.id);
      if (!toLoc && rows.length > 1) setToLoc(rows.filter((l) => l.id !== (rows[0]!.id))[0]!.id);
      if (!countLoc && rows.length) setCountLoc(rows.find((l) => l.is_default === 1)?.id ?? rows[0]!.id);
      setLocationsReady(true);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    void loadLocations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stock, transfer or count changes from any PC reload the open tab.
  useShopRefresh('stock', () => void loadTab());

  const loadTab = async () => {
    setLoading(true);
    setError(null);
    try {
      if (tab === 'transfers') {
        const res = await call<{ rows: any[]; total: number }>('stock.transfers', { pageSize: 50 });
        setTransfers(res.rows);
        setTransferTotal(res.total);
      }
      if (tab === 'counts') {
        const res = await call<{ rows: any[] }>('stock.counts', { pageSize: 50 });
        setCounts(res.rows);
      }
      if (tab === 'reorder') setReorder(await call<any[]>('stock.reorder', { leadDays: 7 }));
      if (tab === 'valuation') setValuation(await call<any>('stock.valuation', { includeZero: false, pageSize: 200 }));
      if (tab === 'dead') setDead(await call<any[]>('stock.dead', 60));
      if (tab === 'serials') {
        const res = await call<{ rows: any[]; total: number }>('serials.list', { pageSize: 100 });
        setSerials(res.rows);
        setSerialTotal(res.total);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadTab();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  /* ---------------- actions ---------------- */

  const addLocation = async () => {
    try {
      await call('locations.create', { name: locName, kind: locKind, address: locAddress || null });
      setLocModal(false);
      setLocName('');
      setLocAddress('');
      await loadLocations();
      ui.success('লোকেশন যোগ হয়েছে');
    } catch (err) {
      ui.error('যোগ করা যায়নি', (err as Error).message);
    }
  };

  const submitTransfer = async () => {
    if (!fromLoc || !toLoc) return;
    try {
      await call('stock.transfer', {
        fromLocationId: Number(fromLoc),
        toLocationId: Number(toLoc),
        items: transferLines.map((l) => ({ productId: l.productId, qtyBaseMilli: l.qtyBaseMilli })),
        note: transferNote || null,
      });
      setTransferOpen(false);
      setTransferLines([]);
      setTransferNote('');
      await loadTab();
      ui.success('ট্রান্সফার সম্পন্ন');
    } catch (err) {
      ui.error('ট্রান্সফার ব্যর্থ', (err as Error).message);
    }
  };

  const createCount = async () => {
    try {
      const row = await call<any>('stock.countCreate', {
        locationId: Number(countLoc),
        note: countNote || null,
        all: countAll,
      });
      setCountOpen(false);
      setCountNote('');
      await loadTab();
      await openSheet(row.id);
      ui.success('গণনা শিট তৈরি হয়েছে', row.count_no);
    } catch (err) {
      ui.error('শিট তৈরি হয়নি', (err as Error).message);
    }
  };

  const openSheet = async (id: number) => {
    try {
      const items = await call<any[]>('stock.countItems', id);
      const count = (counts.find((c) => c.id === id) as any) ?? (await call<any>('stock.counts', { pageSize: 50 })).rows.find((c: any) => c.id === id);
      setSheet({ count, items });
      const edits: Record<number, number> = {};
      for (const it of items) edits[it.product_id] = it.counted_qty_milli;
      setSheetEdits(edits);
    } catch (err) {
      ui.error('শিট খোলা যায়নি', (err as Error).message);
    }
  };

  const saveSheetLine = async (productId: number, value: number) => {
    if (!sheet) return;
    setSheetEdits((prev) => ({ ...prev, [productId]: value }));
    try {
      await call('stock.countSetQty', sheet.count.id, productId, value);
    } catch (err) {
      ui.error('সংরক্ষণ ব্যর্থ', (err as Error).message);
    }
  };

  const postSheet = async () => {
    if (!sheet) return;
    const res = await ui.confirm({
      title: 'গণনা পোস্ট করুন',
      message: 'পার্থক্যগুলো স্টকে সমন্বয় হবে এবং হিসাবে পোস্ট হবে। পোস্টের পর আর বদলানো যাবে না।',
      confirmLabel: 'পোস্ট করুন',
    });
    if (!res.ok) return;
    try {
      const out = await call<{ adjusted: number }>('stock.countPost', sheet.count.id);
      ui.success('গণনা পোস্ট হয়েছে', `${out.adjusted} টি লাইনে সমন্বয়`);
      setSheet(null);
      await loadTab();
    } catch (err) {
      ui.error('পোস্ট হয়নি', (err as Error).message);
    }
  };

  const registerSerials = async () => {
    if (!serialProduct) return;
    try {
      const res = await call<{ added: number; skipped: string[] }>('serials.register', {
        productId: serialProduct.id,
        serials: serialText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
      });
      ui.success('সিরিয়াল যোগ হয়েছে', `${res.added} টি যোগ, ${res.skipped.length} টি বাদ (আগেই আছে)`);
      setSerialModal(false);
      setSerialText('');
      setSerialProduct(null);
      await loadTab();
    } catch (err) {
      ui.error('যোগ করা যায়নি', (err as Error).message);
    }
  };

  const loadBundle = async (parentId: number) => {
    try {
      setBundleInfo(await call<any>('bundles.get', parentId));
    } catch (err) {
      ui.error('বান্ডল লোড হয়নি', (err as Error).message);
    }
  };

  const saveBundle = async () => {
    if (!bundleParent) return;
    try {
      await call('bundles.set', bundleParent.id, bundleLines.map((l) => ({ childId: l.childId, qtyBaseMilli: l.qty_base_milli })));
      await loadBundle(bundleParent.id);
      ui.success('বান্ডল সংরক্ষিত');
    } catch (err) {
      ui.error('সংরক্ষণ ব্যর্থ', (err as Error).message);
    }
  };

  const assemble = async () => {
    if (!bundleParent) return;
    try {
      const res = await call<any>('bundles.assemble', { parentId: bundleParent.id, count: 1 });
      ui.success('বান্ডল তৈরি হয়েছে', `স্টক ${fmtQty(res.parentQtyMilli)}`);
      await loadBundle(bundleParent.id);
    } catch (err) {
      ui.error('তৈরি করা যায়নি', (err as Error).message);
    }
  };

  /* ---------------- render ---------------- */

  const body = () => {
    if (loading) return <Loading />;
    switch (tab) {
      case 'locations':
        return (
          <div className="stack" style={{ gap: 10 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="small muted">একাধিক দোকান/গুদাম রাখলে স্টক আলাদাভাবে দেখা যাবে; মোট স্টক একই থাকে।</span>
              {can('stock.adjust') ? (
                <Button icon="plus" onClick={() => setLocModal(true)}>
                  নতুন লোকেশন
                </Button>
              ) : null}
            </div>
            <DataTable
              columns={[
                { key: 'name', label: 'নাম' },
                { key: 'kind', label: 'ধরন', render: (r: Location) => KIND_LABEL[r.kind] ?? r.kind },
                { key: 'address', label: 'ঠিকানা', render: (r: Location) => r.address || '—' },
                { key: 'sku_count', label: 'পণ্য', align: 'right' },
                {
                  key: 'is_default',
                  label: 'প্রধান',
                  render: (r: Location) => (r.is_default ? <Badge tone="green">প্রধান</Badge> : '—'),
                },
              ]}
              rows={locations}
              empty="কোনো লোকেশন নেই"
            />
          </div>
        );
      case 'transfers':
        return (
          <div className="stack" style={{ gap: 10 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="small muted">মোট {transferTotal} টি ট্রান্সফার</span>
              {canTransfer ? (
                <Button icon="plus" onClick={() => setTransferOpen(true)} disabled={locations.length < 2}>
                  নতুন ট্রান্সফার
                </Button>
              ) : null}
            </div>
            {locations.length < 2 ? (
              <Banner tone="info">ট্রান্সফারের জন্য অন্তত দুটি লোকেশন দরকার — আগে “লোকেশন” ট্যাব থেকে একটি গুদাম যোগ করুন।</Banner>
            ) : null}
            <DataTable
              columns={[
                { key: 'transfer_no', label: 'নম্বর' },
                { key: 'transfer_date', label: 'তারিখ', render: (r: any) => dateTime(r.transfer_date) },
                { key: 'from_name', label: 'থেকে' },
                { key: 'to_name', label: 'গন্তব্য' },
                { key: 'item_count', label: 'আইটেম', align: 'right' },
                { key: 'total_qty', label: 'পরিমাণ', align: 'right', render: (r: any) => fmtQty(r.total_qty) },
              ]}
              rows={transfers}
              onRowClick={async (r: any) => {
                try {
                  const items = await call<any[]>('stock.transferItems', r.id);
                  setTransferDetail({ transfer: r, items });
                } catch (err) {
                  ui.error('বিস্তারিত পাওয়া যায়নি', (err as Error).message);
                }
              }}
              empty="এখনো কোনো ট্রান্সফার হয়নি"
            />
          </div>
        );
      case 'counts':
        return (
          <div className="stack" style={{ gap: 10 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="small muted">গণনা শিট তৈরি করে প্রাপ্ত সংখ্যা লিখুন, তারপর পোস্ট করুন।</span>
              {canCount ? (
                <Button icon="plus" onClick={() => setCountOpen(true)}>
                  নতুন গণনা
                </Button>
              ) : null}
            </div>
            <DataTable
              columns={[
                { key: 'count_no', label: 'নম্বর' },
                { key: 'location_name', label: 'লোকেশন' },
                { key: 'status', label: 'অবস্থা', render: (r: any) => <Badge tone={r.status === 'posted' ? 'green' : r.status === 'cancelled' ? 'red' : 'amber'}>{r.status === 'posted' ? 'পোস্ট' : r.status === 'cancelled' ? 'বাতিল' : 'খসড়া'}</Badge> },
                { key: 'item_count', label: 'লাইন', align: 'right' },
                { key: 'diff_count', label: 'পার্থক্য', align: 'right' },
                { key: 'created_at', label: 'তৈরি', render: (r: any) => dateTime(r.created_at) },
              ]}
              rows={counts}
              onRowClick={(r: any) => openSheet(r.id)}
              empty="এখনো কোনো গণনা হয়নি"
            />
          </div>
        );
      case 'reorder':
        return (
          <div className="stack" style={{ gap: 10 }}>
            <Banner tone="info">
              প্রস্তাবিত পরিমাণ গত ৩০ দিনের বিক্রয় ও ন্যূনতম স্টকের ভিত্তিতে হিসাব করা হয়েছে — কেন এই পরিমাণ, তা “কারণ” কলামে লেখা আছে।
            </Banner>
            <DataTable
              columns={[
                { key: 'name', label: 'পণ্য' },
                { key: 'stock_base_milli', label: 'বর্তমান স্টক', align: 'right', render: (r: any) => fmtQty(r.stock_base_milli) },
                { key: 'min_stock_base_milli', label: 'ন্যূনতম', align: 'right', render: (r: any) => fmtQty(r.min_stock_base_milli) },
                { key: 'sold_base_milli', label: '৩০ দিনে বিক্রি', align: 'right', render: (r: any) => fmtQty(r.sold_base_milli) },
                { key: 'suggested_base_milli', label: 'প্রস্তাবিত ক্রয়', align: 'right', render: (r: any) => fmtQty(r.suggested_base_milli) },
                { key: 'estimated_value_paisa', label: 'আনুমানিক খরচ', align: 'right', render: (r: any) => money(r.estimated_value_paisa) },
                { key: 'reason', label: 'কারণ' },
                { key: 'supplier_name', label: 'সর্বশেষ সাপ্লায়ার', render: (r: any) => r.supplier_name || '—' },
              ]}
              rows={reorder}
              empty="সব পণ্যের স্টক পর্যাপ্ত"
            />
          </div>
        );
      case 'valuation':
        return valuation ? (
          <div className="stack" style={{ gap: 10 }}>
            <div className="row" style={{ gap: 18 }}>
              <span className="small muted">পদ্ধতি: <b>{valuation.method}</b></span>
              <span className="small muted">মোট পণ্য: <b className="num">{valuation.totals.sku_count}</b></span>
              <span className="small muted">মোট পরিমাণ: <b className="num">{fmtQty(valuation.totals.qty_base_milli)}</b></span>
              <span className="small muted">স্টকের মূল্য: <b className="num">{money(valuation.totals.value_paisa)}</b></span>
            </div>
            <DataTable
              columns={[
                { key: 'name', label: 'পণ্য' },
                { key: 'sku', label: 'এসকেইউ', render: (r: any) => r.sku || '—' },
                { key: 'stock_base_milli', label: 'স্টক', align: 'right', render: (r: any) => fmtQty(r.stock_base_milli) },
                { key: 'value_paisa', label: 'ক্রয়মূল্যে মূল্য', align: 'right', render: (r: any) => money(r.value_paisa) },
                { key: 'retail_value_paisa', label: 'বিক্রয়মূল্যে মূল্য', align: 'right', render: (r: any) => money(r.retail_value_paisa) },
              ]}
              rows={valuation.rows}
              empty="স্টকে কোনো পণ্য নেই"
            />
          </div>
        ) : (
          <EmptyState title="মূল্যায়ন লোড হয়নি" />
        );
      case 'dead':
        return (
          <div className="stack" style={{ gap: 10 }}>
            <Banner tone="warn">৬০ দিনে একবারও বিক্রি হয়নি এমন পণ্য — এগুলোতে টাকা আটকে আছে। ডিসকাউন্ট বা রিটার্নের কথা ভাবুন।</Banner>
            <DataTable
              columns={[
                { key: 'name', label: 'পণ্য' },
                { key: 'stock_base_milli', label: 'স্টক', align: 'right', render: (r: any) => fmtQty(r.stock_base_milli) },
                { key: 'value_paisa', label: 'আটকে থাকা টাকা', align: 'right', render: (r: any) => money(r.value_paisa) },
                { key: 'last_sold_on', label: 'সর্বশেষ বিক্রি', render: (r: any) => r.last_sold_on || 'কখনো না' },
              ]}
              rows={dead}
              empty="কোনো মৃত স্টক নেই"
            />
          </div>
        );
      case 'serials':
        return (
          <div className="stack" style={{ gap: 10 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="small muted">মোট {serialTotal} টি সিরিয়াল/আইএমইআই নিবন্ধিত</span>
              {can('product.manage') ? (
                <Button icon="plus" onClick={() => setSerialModal(true)}>
                  সিরিয়াল যোগ করুন
                </Button>
              ) : null}
            </div>
            <DataTable
              columns={[
                { key: 'serial', label: 'সিরিয়াল' },
                { key: 'product_name', label: 'পণ্য' },
                {
                  key: 'status',
                  label: 'অবস্থা',
                  render: (r: any) => (
                    <Badge tone={r.status === 'in_stock' ? 'green' : r.status === 'sold' ? 'blue' : 'amber'}>
                      {r.status === 'in_stock' ? 'স্টকে' : r.status === 'sold' ? 'বিক্রি' : r.status}
                    </Badge>
                  ),
                },
                { key: 'location_name', label: 'লোকেশন', render: (r: any) => r.location_name || '—' },
                { key: 'invoice_no', label: 'ইনভয়েস', render: (r: any) => r.invoice_no || '—' },
                { key: 'updated_at', label: 'হালনাগাদ', render: (r: any) => dateTime(r.updated_at) },
              ]}
              rows={serials}
              empty="কোনো সিরিয়াল নেই"
            />
          </div>
        );
      case 'bundles':
        return (
          <div className="stack" style={{ gap: 12 }}>
            <Card>
              <CardHead title="বান্ডল / কম্বো প্যাক" sub="একটি প্যাকেটে কোন কোন পণ্য কত পরিমাণ থাকবে তা ঠিক করুন।" />
              <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <Field label="প্যাক/বান্ডল পণ্য">
                  <Select
                    value={bundleParent?.id ?? ''}
                    onChange={(v) => {
                      const id = Number(v);
                      const pick = productSearch.rows.find((p) => p.id === id) ?? null;
                      setBundleParent(pick);
                      setBundleLines([]);
                      setBundleInfo(null);
                      if (id) void loadBundle(id);
                    }}
                    options={productSearch.rows.map((p) => ({ value: p.id, label: p.name }))}
                    placeholder="পণ্য খুঁজুন"
                  />
                </Field>
                <Field label="পণ্য খুঁজুন">
                  <TextInput value={productSearch.term} onChange={productSearch.setTerm} placeholder="নাম বা কোড" />
                </Field>
              </div>
              {bundleParent ? (
                <div className="stack" style={{ gap: 8, marginTop: 10 }}>
                  {bundleInfo?.lines?.length ? (
                    <>
                      <span className="small muted">
                        বর্তমান সংজ্ঞা: {bundleInfo.lines.length} টি উপকরণ • এখন তৈরি করা যাবে {bundleInfo.capacity} টি
                      </span>
                      {bundleInfo.lines.map((l) => (
                        <div key={l.child_id} className="row" style={{ justifyContent: 'space-between' }}>
                          <span>{l.child_name}</span>
                          <span className="num small">
                            {fmtQty(l.qty_base_milli)} • স্টকে {fmtQty(l.available_base_milli)}
                          </span>
                        </div>
                      ))}
                    </>
                  ) : (
                    <span className="small muted">এখনো কোনো উপকরণ যোগ করা হয়নি।</span>
                  )}
                  <div className="row" style={{ gap: 6, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <Field label="উপকরণ যোগ করুন">
                      <Select
                        value=""
                        onChange={(v) => {
                          const pick = productSearch.rows.find((p) => p.id === Number(v));
                          if (!pick) return;
                          setBundleLines((prev) =>
                            prev.some((l) => l.childId === pick.id)
                              ? prev
                              : [...prev, { childId: pick.id, child_name: pick.name, qty_base_milli: 1000 }],
                          );
                        }}
                        options={productSearch.rows
                          .filter((p) => p.id !== bundleParent.id)
                          .map((p) => ({ value: p.id, label: p.name }))}
                        placeholder="পণ্য বাছুন"
                      />
                    </Field>
                    {bundleLines.map((l, idx) => (
                      <div key={l.childId} className="row" style={{ gap: 4, alignItems: 'flex-end' }}>
                        <span className="small">{l.child_name}</span>
                        <TextInput
                          value={l.qty_base_milli / 1000}
                          onChange={(v) => {
                            const n = Number(v.replace(/[^\d.]/g, ''));
                            setBundleLines((prev) =>
                              prev.map((x, i) => (i === idx ? { ...x, qty_base_milli: Math.round((Number.isFinite(n) ? n : 0) * 1000) } : x)),
                            );
                          }}
                        />
                        <IconButton icon="trash" danger onClick={() => setBundleLines((prev) => prev.filter((_, i) => i !== idx))} />
                      </div>
                    ))}
                  </div>
                  <div className="row" style={{ gap: 8 }}>
                    <Button variant="primary" icon="check" onClick={saveBundle} disabled={!bundleLines.length}>
                      সংজ্ঞা সংরক্ষণ
                    </Button>
                    <Button icon="box" onClick={assemble} disabled={!bundleInfo?.capacity}>
                      একটি বান্ডল তৈরি করুন
                    </Button>
                  </div>
                </div>
              ) : null}
            </Card>
          </div>
        );
      default:
        return <EmptyState title="কিছু নেই" />;
    }
  };

  return (
    <>
      <PageHead
        title="স্টক অপারেশন"
        sub="লোকেশন, ট্রান্সফার, ফিজিক্যাল কাউন্ট, রিঅর্ডার, মূল্যায়ন, সিরিয়াল ও বান্ডল — সব এক জায়গায়।"
      />
      <Tabs
        active={tab}
        onChange={(v) => setTab(v as Tab)}
        tabs={[
          { id: 'locations', label: 'লোকেশন' },
          { id: 'transfers', label: 'ট্রান্সফার' },
          { id: 'counts', label: 'স্টক গণনা' },
          { id: 'reorder', label: 'রিঅর্ডার' },
          { id: 'valuation', label: 'মূল্যায়ন' },
          { id: 'dead', label: 'মৃত স্টক' },
          { id: 'serials', label: 'সিরিয়াল/IMEI' },
          { id: 'bundles', label: 'বান্ডল' },
        ]}
      />
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {!locationsReady ? <Loading /> : body()}

      {/* new location */}
      {locModal ? (
        <Modal
          title="নতুন লোকেশন"
          size="sm"
          onClose={() => setLocModal(false)}
          footer={
            <>
              <Button onClick={() => setLocModal(false)}>বাতিল</Button>
              <Button variant="primary" onClick={addLocation} disabled={!locName.trim()}>
                সংরক্ষণ
              </Button>
            </>
          }
        >
          <div className="form-grid">
            <Field label="নাম" span={2}>
              <TextInput value={locName} onChange={setLocName} placeholder="যেমন: গুদাম-১" autoFocus />
            </Field>
            <Field label="ধরন">
              <Select
                value={locKind}
                onChange={(v) => setLocKind((v as any) || 'godown')}
                options={[
                  { value: 'shop', label: 'দোকান' },
                  { value: 'godown', label: 'গুদাম' },
                  { value: 'warehouse', label: 'ওয়্যারহাউস' },
                ]}
              />
            </Field>
            <Field label="ঠিকানা">
              <TextInput value={locAddress} onChange={setLocAddress} placeholder="ঐচ্ছিক" />
            </Field>
          </div>
        </Modal>
      ) : null}

      {/* transfer */}
      {transferOpen ? (
        <Modal
          title="স্টক ট্রান্সফার"
          sub="এক লোকেশন থেকে আরেকটিতে মাল পাঠান — মোট স্টক বদলাবে না"
          size="md"
          onClose={() => setTransferOpen(false)}
          footer={
            <>
              <Button onClick={() => setTransferOpen(false)}>বাতিল</Button>
              <Button variant="primary" onClick={submitTransfer} disabled={!transferLines.length || !fromLoc || !toLoc}>
                ট্রান্সফার করুন
              </Button>
            </>
          }
        >
          <div className="form-grid">
            <Field label="থেকে">
              <Select value={fromLoc} onChange={(v) => setFromLoc(v ? Number(v) : '')} options={locations.map((l) => ({ value: l.id, label: l.name }))} />
            </Field>
            <Field label="গন্তব্য">
              <Select value={toLoc} onChange={(v) => setToLoc(v ? Number(v) : '')} options={locations.filter((l) => l.id !== fromLoc).map((l) => ({ value: l.id, label: l.name }))} />
            </Field>
            <Field label="পণ্য খুঁজুন" span={2}>
              <TextInput value={productSearch.term} onChange={productSearch.setTerm} placeholder="নাম বা কোড" />
            </Field>
            <div className="span-2">
              <Select
                value=""
                onChange={(v) => {
                  const pick = productSearch.rows.find((p) => p.id === Number(v));
                  if (!pick) return;
                  setTransferLines((prev) =>
                    prev.some((l) => l.productId === pick.id) ? prev : [...prev, { productId: pick.id, name: pick.name, qtyBaseMilli: 1000 }],
                  );
                }}
                options={productSearch.rows.map((p) => ({ value: p.id, label: `${p.name} — স্টক ${fmtQty(p.stock_base_milli)}` }))}
                placeholder="পণ্য যোগ করুন"
              />
              {transferLines.map((l, idx) => (
                <div key={l.productId} className="row" style={{ gap: 6, marginTop: 6, alignItems: 'center' }}>
                  <span className="grow">{l.name}</span>
                  <TextInput
                    value={l.qtyBaseMilli / 1000}
                    onChange={(v) => {
                      const n = Number(v.replace(/[^\d.]/g, ''));
                      setTransferLines((prev) =>
                        prev.map((x, i) => (i === idx ? { ...x, qtyBaseMilli: Math.max(0, Math.round((Number.isFinite(n) ? n : 0) * 1000)) } : x)),
                      );
                    }}
                  />
                  <IconButton icon="trash" danger onClick={() => setTransferLines((prev) => prev.filter((_, i) => i !== idx))} />
                </div>
              ))}
            </div>
            <Field label="নোট" span={2}>
              <TextInput value={transferNote} onChange={setTransferNote} placeholder="ঐচ্ছিক" />
            </Field>
          </div>
        </Modal>
      ) : null}

      {transferDetail ? (
        <Modal title={`ট্রান্সফার ${transferDetail.transfer.transfer_no}`} size="md" onClose={() => setTransferDetail(null)} footer={<Button onClick={() => setTransferDetail(null)}>বন্ধ</Button>}>
          <div className="stack" style={{ gap: 4 }}>
            {transferDetail.items.map((it) => (
              <div key={it.id} className="row" style={{ justifyContent: 'space-between' }}>
                <span>{it.product_name}</span>
                <span className="num">{fmtQty(it.qty_base_milli)}</span>
              </div>
            ))}
          </div>
        </Modal>
      ) : null}

      {/* new count */}
      {countOpen ? (
        <Modal
          title="নতুন স্টক গণনা"
          size="sm"
          onClose={() => setCountOpen(false)}
          footer={
            <>
              <Button onClick={() => setCountOpen(false)}>বাতিল</Button>
              <Button variant="primary" onClick={createCount}>
                শিট তৈরি করুন
              </Button>
            </>
          }
        >
          <div className="form-grid">
            <Field label="লোকেশন">
              <Select value={countLoc} onChange={(v) => setCountLoc(v ? Number(v) : '')} options={locations.map((l) => ({ value: l.id, label: l.name }))} />
            </Field>
            <Field label="নোট">
              <TextInput value={countNote} onChange={setCountNote} placeholder="যেমন: মাসিক গণনা" />
            </Field>
            <label className="row span-2" style={{ gap: 6 }}>
              <input type="checkbox" checked={countAll} onChange={(e) => setCountAll(e.target.checked)} />
              <span className="small">স্টকে না থাকা পণ্যও শিটে রাখুন</span>
            </label>
          </div>
        </Modal>
      ) : null}

      {sheet ? (
        <Modal
          title={`গণনা ${sheet.count?.count_no ?? ''}`}
          sub="প্রাপ্ত সংখ্যা লিখুন — পার্থক্যগুলো পোস্টের সময় সমন্বয় হবে"
          size="lg"
          onClose={() => setSheet(null)}
          footer={
            <>
              <Button onClick={() => setSheet(null)}>বন্ধ</Button>
              {sheet.count?.status === 'draft' && canCount ? (
                <Button variant="primary" icon="check" onClick={postSheet}>
                  পোস্ট করুন
                </Button>
              ) : null}
            </>
          }
        >
          <DataTable
            columns={[
              { key: 'product_name', label: 'পণ্য' },
              { key: 'system_qty_milli', label: 'সিস্টেম', align: 'right', render: (r: any) => fmtQty(r.system_qty_milli) },
              {
                key: 'counted',
                label: 'গণনা',
                align: 'right',
                render: (r: any) => (
                  <input
                    className="cl-input num"
                    style={{ width: 90, textAlign: 'right' }}
                    value={(sheetEdits[r.product_id] ?? r.counted_qty_milli) / 1000}
                    disabled={sheet.count?.status !== 'draft'}
                    onChange={(e) => {
                      const n = Number(e.target.value.replace(/[^\d.]/g, ''));
                      void saveSheetLine(r.product_id, Math.max(0, Math.round((Number.isFinite(n) ? n : 0) * 1000)));
                    }}
                  />
                ),
              },
              {
                key: 'diff',
                label: 'পার্থক্য',
                align: 'right',
                render: (r: any) => {
                  const diff = (sheetEdits[r.product_id] ?? r.counted_qty_milli) - r.system_qty_milli;
                  return <span className={diff === 0 ? 'muted' : diff > 0 ? '' : 'warn-text'}>{fmtQty(diff)}</span>;
                },
              },
            ]}
            rows={sheet.items}
            empty="শিটে কোনো পণ্য নেই"
          />
        </Modal>
      ) : null}

      {/* serials */}
      {serialModal ? (
        <Modal
          title="সিরিয়াল / IMEI যোগ করুন"
          size="sm"
          onClose={() => setSerialModal(false)}
          footer={
            <>
              <Button onClick={() => setSerialModal(false)}>বাতিল</Button>
              <Button variant="primary" onClick={registerSerials} disabled={!serialProduct || !serialText.trim()}>
                যোগ করুন
              </Button>
            </>
          }
        >
          <div className="form-grid">
            <Field label="পণ্য" span={2}>
              <Select
                value={serialProduct?.id ?? ''}
                onChange={(v) => {
                  setSerialProduct(productSearch.rows.find((p) => p.id === Number(v)) ?? null);
                }}
                options={productSearch.rows.map((p) => ({ value: p.id, label: p.name }))}
                placeholder="পণ্য বাছুন"
              />
            </Field>
            <Field label="পণ্য খুঁজুন" span={2}>
              <TextInput value={productSearch.term} onChange={productSearch.setTerm} placeholder="নাম বা কোড" />
            </Field>
            <Field label="সিরিয়াল (প্রতি লাইনে একটি বা কমা দিয়ে আলাদা)" span={2}>
              <textarea className="cl-input" rows={5} value={serialText} onChange={(e) => setSerialText(e.target.value)} />
            </Field>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
