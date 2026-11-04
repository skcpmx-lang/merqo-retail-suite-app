import { useEffect, useState } from 'react';
import { call } from '../api.js';
import { money, dateShort, today, addDays } from '../format.js';
import { Icon } from '../icons.js';
import {
  Badge,
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
  Select,
  TextInput,
  useUI,
} from '../ui.js';
import type { Expense } from '../types.js';

const PAGE = 25;

export function ExpensesPage({ can }: { can: (perm?: string) => boolean }) {
  const ui = useUI();
  const [rows, setRows] = useState<Expense[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [from, setFrom] = useState(addDays(today(), -30));
  const [to, setTo] = useState(today());
  const [categoryId, setCategoryId] = useState<number | ''>('');
  const [status, setStatus] = useState<'active' | 'voided' | 'all'>('active');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [sum, setSum] = useState(0);

  const [categories, setCategories] = useState<any[]>([]);
  const [methods, setMethods] = useState<any[]>([]);
  const [editor, setEditor] = useState<any | null>(null);
  const [newCategory, setNewCategory] = useState('');

  const canManage = can('expense.manage');

  const load = async () => {
    setLoading(true);
    try {
      const [res, totalAmount] = await Promise.all([
        call<{ rows: Expense[]; total: number }>('expenses.list', {
          from,
          to,
          categoryId: categoryId || null,
          search: search.trim() || undefined,
          status,
          page,
          pageSize: PAGE,
        }),
        call<number>('expenses.total', from, to),
      ]);
      setRows(res.rows);
      setTotal(res.total);
      setSum(totalAmount);
    } catch (err) {
      ui.error('এক্সপেন্স লোড ব্যর্থ', (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, categoryId, status, search, page]);

  useEffect(() => {
    (async () => {
      try {
        const [cats, met] = await Promise.all([
          call<any[]>('settings.expenseCategories', true),
          call<any[]>('settings.paymentMethods'),
        ]);
        setCategories(cats);
        setMethods(met);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  const save = async () => {
    if (!editor) return;
    if (!editor.description.trim()) {
      ui.error('বিবরণ দিতে হবে', 'এক্সপেন্সের বিবরণ ছাড়া সংরক্ষণ করা যাবে না।');
      return;
    }
    if (!editor.amount || editor.amount <= 0) {
      ui.error('পরিমাণ দিন', 'এক্সপেন্সের পরিমাণ ০ এর বেশি হতে হবে।');
      return;
    }
    try {
      const payload = {
        categoryId: editor.categoryId || null,
        amountPaisa: editor.amount,
        methodId: editor.methodId,
        description: editor.description,
        reference: editor.reference || null,
        note: editor.note || null,
        expenseDate: editor.expenseDate || undefined,
      };
      if (editor.id) await call('expenses.update', editor.id, payload);
      else await call('expenses.create', payload);
      ui.success('সংরক্ষিত হয়েছে');
      setEditor(null);
      await load();
    } catch (err) {
      ui.error('সংরক্ষণ ব্যর্থ', (err as Error).message);
    }
  };

  const voidExpense = async (row: Expense) => {
    const res = await ui.confirm({
      title: 'এক্সপেন্স বাতিল',
      message: `${row.description} — ${money(row.amount_paisa)} বাতিল করবেন?`,
      detail: 'এন্ট্রিটি মুছে যাবে না, বাতিল হিসাবে সংরক্ষিত থাকবে এবং ক্যাশ হিসাব থেকে বাদ যাবে।',
      danger: true,
      requireReason: true,
      confirmLabel: 'বাতিল করুন',
    });
    if (!res.ok) return;
    try {
      await call('expenses.void', row.id, res.reason);
      ui.success('বাতিল হয়েছে');
      await load();
    } catch (err) {
      ui.error('বাতিল ব্যর্থ', (err as Error).message);
    }
  };

  const addCategory = async () => {
    if (!newCategory.trim()) return;
    try {
      const created = await call<any>('catalog.createExpenseCategory', newCategory.trim());
      setCategories((prev) => [...prev, created]);
      setNewCategory('');
      ui.success('ক্যাটাগরি যোগ হয়েছে', created.name);
    } catch (err) {
      ui.error('ক্যাটাগরি যোগ ব্যর্থ', (err as Error).message);
    }
  };

  return (
    <>
      <PageHead
        title="এক্সপেন্স"
        sub="দোকানের সব খরচ — বিদ্যুৎ, বেতন, ভাড়া, পরিবহন"
        actions={
          canManage ? (
            <Button
              variant="primary"
              icon="plus"
              onClick={() =>
                setEditor({
                  id: null,
                  categoryId: categories[0]?.id ?? '',
                  amount: 0,
                  methodId: methods[0]?.id ?? '',
                  description: '',
                  reference: '',
                  note: '',
                  expenseDate: today(),
                })
              }
            >
              নতুন এক্সপেন্স
            </Button>
          ) : null
        }
      />

      <Card>
        <div className="toolbar">
          <TextInput value={from} onChange={setFrom} type="date" />
          <TextInput value={to} onChange={setTo} type="date" />
          <Select
            value={categoryId}
            onChange={(v) => setCategoryId(v ? Number(v) : '')}
            options={categories.map((c) => ({ value: c.id, label: c.name }))}
            placeholder="সব ক্যাটাগরি"
          />
          <div className="global-search" style={{ maxWidth: 220 }}>
            <span className="search-icon">
              <Icon name="search" size={16} />
            </span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="বিবরণ" />
          </div>
          <Select
            value={status}
            onChange={(v) => setStatus(v as any)}
            options={[
              { value: 'active', label: 'সক্রিয়' },
              { value: 'voided', label: 'বাতিল' },
              { value: 'all', label: 'সব' },
            ]}
          />
          <span className="grow" />
          <Badge tone="amber">এই সময়ের মোট {money(sum)}</Badge>
        </div>

        {loading ? (
          <Loading />
        ) : (
          <>
            <DataTable
              rows={rows}
              rowKey={(r) => r.id}
              empty={<EmptyState icon="expense" title="কোনো এক্সপেন্স নেই" message="নির্বাচিত সময়ে কোনো খরচ লেখা হয়নি।" />}
              columns={[
                { key: 'expense_date', label: 'তারিখ', render: (r) => dateShort(r.expense_date) },
                { key: 'category_name', label: 'ক্যাটাগরি', render: (r) => r.category_name || '—' },
                { key: 'description', label: 'বিবরণ', render: (r) => <span>{r.description}</span> },
                { key: 'method_name', label: 'মাধ্যম', render: (r) => <span className="small muted">{r.method_name || '—'}</span> },
                {
                  key: 'amount_paisa',
                  label: 'টাকা',
                  align: 'right',
                  render: (r) => (
                    <span className={`num bold ${r.status === 'voided' ? 'muted' : ''}`} style={r.status === 'voided' ? { textDecoration: 'line-through' } : undefined}>
                      {money(r.amount_paisa)}
                    </span>
                  ),
                },
                { key: 'username', label: 'ইউজার', render: (r) => <span className="tiny muted">{r.username ?? ''}</span> },
                {
                  key: 'act',
                  label: '',
                  align: 'right',
                  width: 90,
                  render: (r) =>
                    r.status === 'active' && canManage ? (
                      <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                        <IconButton icon="edit" title="সম্পাদনা" onClick={() => setEditor({ ...r, amount: r.amount_paisa, expenseDate: r.expense_date.slice(0, 10) })} />
                        <IconButton icon="trash" title="বাতিল" danger onClick={() => voidExpense(r)} />
                      </div>
                    ) : (
                      <Badge tone="red">বাতিল</Badge>
                    ),
                },
              ]}
            />
            <Pagination page={page} pageSize={PAGE} total={total} onPage={setPage} />
          </>
        )}
      </Card>

      {editor ? (
        <Modal
          title={editor.id ? 'এক্সপেন্স সম্পাদনা' : 'নতুন এক্সপেন্স'}
          onClose={() => setEditor(null)}
          footer={
            <>
              <Button onClick={() => setEditor(null)}>বাতিল</Button>
              <Button variant="primary" onClick={save} icon="check">
                সংরক্ষণ
              </Button>
            </>
          }
        >
          <div className="form-grid">
            <Field label="বিবরণ *" span={2}>
              <TextInput value={editor.description} onChange={(v) => setEditor({ ...editor, description: v })} autoFocus placeholder="যেমন: দোকানের বিদ্যুৎ বিল" />
            </Field>
            <Field label="পরিমাণ *">
              <MoneyInput value={editor.amount ?? 0} onChange={(v) => setEditor({ ...editor, amount: v })} />
            </Field>
            <Field label="তারিখ">
              <TextInput value={editor.expenseDate ?? today()} onChange={(v) => setEditor({ ...editor, expenseDate: v })} type="date" />
            </Field>
            <Field label="ক্যাটাগরি">
              <Select
                value={editor.categoryId ?? ''}
                onChange={(v) => setEditor({ ...editor, categoryId: v ? Number(v) : '' })}
                options={categories.filter((c) => c.is_active !== 0).map((c) => ({ value: c.id, label: c.name }))}
                placeholder="ক্যাটাগরি নেই"
              />
            </Field>
            <Field label="পরিশোধ মাধ্যম">
              <Select
                value={editor.methodId ?? ''}
                onChange={(v) => setEditor({ ...editor, methodId: Number(v) })}
                options={methods.map((m) => ({ value: m.id, label: m.name }))}
              />
            </Field>
            <Field label="রেফারেন্স">
              <TextInput value={editor.reference ?? ''} onChange={(v) => setEditor({ ...editor, reference: v })} />
            </Field>
            <Field label="নোট">
              <TextInput value={editor.note ?? ''} onChange={(v) => setEditor({ ...editor, note: v })} />
            </Field>
            {!editor.id ? (
              <div className="span-2">
                <div className="row" style={{ gap: 6 }}>
                  <TextInput value={newCategory} onChange={setNewCategory} placeholder="নতুন ক্যাটাগরি যোগ করুন" />
                  <Button size="sm" icon="plus" onClick={addCategory}>
                    যোগ
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </>
  );
}
