import { useEffect, useState } from 'react';
import { call } from '../api.js';
import { useShopRefresh } from '../lib/use-shop-refresh.js';
import { money, dateTime, dateShort } from '../format.js';
import { Icon } from '../icons.js';
import {
  Badge,
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
  Pagination,
  StatCard,
  TextInput,
  useUI,
} from '../ui.js';
import type { CashMovement, CashSession } from '../types.js';

const PAGE = 20;

export function CashPage({ can }: { can: (perm?: string) => boolean }) {
  const ui = useUI();
  const [state, setState] = useState<{ session: CashSession | null; in_hand: number; totals: any } | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessions, setSessions] = useState<CashSession[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [movements, setMovements] = useState<CashMovement[]>([]);
  const [detail, setDetail] = useState<CashSession | null>(null);
  const [detailMoves, setDetailMoves] = useState<CashMovement[]>([]);
  const [detailTotals, setDetailTotals] = useState<any>(null);

  const [openModal, setOpenModal] = useState<null | 'open' | 'close'>(null);
  const [amount, setAmount] = useState(0);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  // Shop events from the Main PC invalidate this screen.
  useShopRefresh('cash', () => void load());

  const load = async () => {
    setLoading(true);
    try {
      const [current, list] = await Promise.all([
        call<any>('cash.current'),
        call<{ rows: CashSession[]; total: number }>('cash.sessions', { page, pageSize: PAGE }),
      ]);
      setState(current);
      setSessions(list.rows);
      setTotal(list.total);
      if (current.session) {
        setMovements(await call<CashMovement[]>('cash.movements', current.session.id));
      } else {
        setMovements([]);
      }
    } catch (err) {
      ui.error('ক্যাশ লোড ব্যর্থ', (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const submit = async () => {
    if (!openModal) return;
    setBusy(true);
    try {
      if (openModal === 'open') {
        await call('cash.open', amount, note || undefined);
        ui.success('ক্যাশ সেশন খোলা হয়েছে', `ওপেনিং ক্যাশ ${money(amount)}`);
      } else {
        const res = await call<any>('cash.close', amount, note || undefined);
        ui.success('সেশন বন্ধ হয়েছে', `পার্থক্য ${money(res?.difference_paisa ?? 0)}`);
      }
      setOpenModal(null);
      setAmount(0);
      setNote('');
      await load();
    } catch (err) {
      ui.error('ব্যর্থ', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const openDetail = async (session: CashSession) => {
    setDetail(session);
    try {
      const [mv, totals] = await Promise.all([
        call<CashMovement[]>('cash.movements', session.id),
        call<any>('cash.sessionTotals', session.id),
      ]);
      setDetailMoves(mv);
      setDetailTotals(totals);
    } catch (err) {
      ui.error('বিস্তারিত লোড ব্যর্থ', (err as Error).message);
    }
  };

  if (loading || !state) return <Loading label="ক্যাশ রেজিস্টার লোড হচ্ছে…" />;

  const session = state.session;
  const expected = session ? (session.opening_cash_paisa ?? 0) + (state.totals?.net ?? 0) : 0;

  return (
    <>
      <PageHead
        title="ক্যাশ রেজিস্টার"
        sub="প্রতিদিনের ক্যাশ সেশন, আদায়-পরিশোধ ও হাতে থাকা টাকা"
        actions={
          session ? (
            <Button
              variant="warn"
              icon="lock"
              onClick={() => {
                setOpenModal('close');
                setAmount(expected);
              }}
            >
              সেশন বন্ধ (ক্লোজিং)
            </Button>
          ) : (
            <Button variant="primary" icon="cash" onClick={() => setOpenModal('open')}>
              নতুন সেশন খুলুন
            </Button>
          )
        }
      />

      {!session ? (
        <Banner tone="warn" icon="warning">
          এই মুহূর্তে আপনার কোনো খোলা ক্যাশ সেশন নেই। বিক্রয় ও আদায় সেশন ছাড়াও সংরক্ষিত হবে, তবে দিনের শেষে
          মিলকরণের জন্য সেশন খোলা রাখা ভালো।
        </Banner>
      ) : null}

      <div className="stat-grid" style={{ marginBottom: 14 }}>
        <StatCard label="হাতে থাকা ক্যাশ" value={money(state.in_hand)} icon="cash" tone="accent" foot="সব খোলা সেশন মিলিয়ে" />
        <StatCard label="ওপেনিং ক্যাশ" value={money(session?.opening_cash_paisa ?? 0)} icon="wallet" foot={session ? dateTime(session.opened_at) : 'সেশন নেই'} />
        <StatCard label="বিক্রয় আদায় (নগদ)" value={money(state.totals?.cash_in ?? 0)} icon="pos" foot="চলমান সেশনে" delay={40} />
        <StatCard label="খরচ ও পরিশোধ (নগদ)" value={money(state.totals?.cash_out ?? 0)} icon="expense" tone="warn" foot="চলমান সেশনে" delay={80} />
      </div>

      <div className="grid-2">
        <Card>
          <div className="card-head">
            <div>
              <h3>চলমান সেশনের মুভমেন্ট</h3>
              <div className="sub">{movements.length} টি এন্ট্রি</div>
            </div>
            {session ? <Badge tone="green">চালু</Badge> : <Badge tone="plain">সেশন নেই</Badge>}
          </div>
          <div className="card-body tight">
            <DataTable
              compact
              maxHeight={380}
              rows={movements}
              rowKey={(r) => r.id}
              empty={<EmptyState icon="cash" title="কোনো মুভমেন্ট নেই" message="সেশন খুললে বিক্রয় ও খরচ এখানে দেখা যাবে।" />}
              columns={[
                { key: 'created_at', label: 'সময়', render: (r) => <span className="tiny">{dateTime(r.created_at)}</span> },
                { key: 'source', label: 'উৎস' },
                {
                  key: 'amount_paisa',
                  label: 'টাকা',
                  align: 'right',
                  render: (r) => (
                    <span className={`num bold ${r.direction === 'in' ? 'success-text' : 'danger-text'}`}>
                      {r.direction === 'in' ? '+' : '−'}
                      {money(r.amount_paisa)}
                    </span>
                  ),
                },
              ]}
            />
          </div>
        </Card>

        <Card>
          <div className="card-head">
            <div>
              <h3>সেশনের হিসাব</h3>
              <div className="sub">নগদ মিলকরণ</div>
            </div>
          </div>
          <div className="card-body">
            <div className="col" style={{ gap: 6 }}>
              <CalcRow label="ওপেনিং ক্যাশ" value={money(session?.opening_cash_paisa ?? 0)} />
              <CalcRow label="নগদ আদায়" value={money(state.totals?.cash_in ?? 0)} />
              <CalcRow label="নগদ পরিশোধ/খরচ" value={`−${money(state.totals?.cash_out ?? 0)}`} />
              <div className="divider" />
              <CalcRow label="প্রত্যাশিত ক্যাশ" value={money(expected)} strong />
              <CalcRow label="হাতে আছে (সিস্টেম)" value={money(state.in_hand)} />
            </div>
            <div style={{ marginTop: 12 }}>
              <Banner tone="info" icon="info">
                সেশন বন্ধ করার সময় প্রকৃত গণনা করা টাকা লিখুন — পার্থক্য অডিটসহ সংরক্ষিত হবে।
              </Banner>
            </div>
            {session ? (
              <div className="row" style={{ marginTop: 10, gap: 8 }}>
                <Button
                  variant="primary"
                  icon="lock"
                  onClick={() => {
                    setOpenModal('close');
                    setAmount(expected);
                  }}
                >
                  দিনের হিসাব মিলিয়ে সেশন বন্ধ
                </Button>
              </div>
            ) : null}
          </div>
        </Card>
      </div>

      <Card style={{ marginTop: 14 }}>
        <div className="card-head">
          <div>
            <h3>সেশন ইতিহাস</h3>
            <div className="sub">মোট {total} টি সেশন</div>
          </div>
        </div>
        <div className="card-body tight">
          <DataTable
            rows={sessions}
            rowKey={(r) => r.id}
            onRowClick={openDetail}
            empty={<EmptyState icon="cash" title="কোনো সেশন নেই" />}
            columns={[
              { key: 'opened_at', label: 'শুরু', render: (r) => dateTime(r.opened_at) },
              { key: 'closed_at', label: 'শেষ', render: (r) => (r.closed_at ? dateTime(r.closed_at) : '—') },
              { key: 'username', label: 'ইউজার', render: (r) => r.username ?? '—' },
              { key: 'opening_cash_paisa', label: 'ওপেনিং', align: 'right', render: (r) => <span className="num">{money(r.opening_cash_paisa)}</span> },
              {
                key: 'expected_cash_paisa',
                label: 'প্রত্যাশিত',
                align: 'right',
                render: (r) => <span className="num">{money(r.expected_cash_paisa ?? 0)}</span>,
              },
              {
                key: 'difference_paisa',
                label: 'পার্থক্য',
                align: 'right',
                render: (r) =>
                  r.difference_paisa === null ? (
                    <span className="muted">—</span>
                  ) : (
                    <span className={`num bold ${r.difference_paisa === 0 ? '' : r.difference_paisa > 0 ? 'success-text' : 'danger-text'}`}>
                      {money(r.difference_paisa)}
                    </span>
                  ),
              },
              {
                key: 'status',
                label: 'অবস্থা',
                render: (r) => (r.status === 'open' ? <Badge tone="green">চালু</Badge> : <Badge tone="plain">বন্ধ</Badge>),
              },
            ]}
          />
          <Pagination page={page} pageSize={PAGE} total={total} onPage={setPage} />
        </div>
      </Card>

      {openModal ? (
        <Modal
          title={openModal === 'open' ? 'ক্যাশ সেশন খুলুন' : 'সেশন বন্ধ করুন'}
          sub={openModal === 'open' ? 'দিনের শুরুতে ড্রয়ারে থাকা টাকা লিখুন' : 'প্রকৃত গণনা করা টাকা লিখুন'}
          size="sm"
          onClose={() => setOpenModal(null)}
          footer={
            <>
              <Button onClick={() => setOpenModal(null)}>বাতিল</Button>
              <Button variant="primary" loading={busy} onClick={submit} icon="check">
                নিশ্চিত করুন
              </Button>
            </>
          }
        >
          <div className="form-grid">
            <Field label={openModal === 'open' ? 'ওপেনিং ক্যাশ' : 'গণনা করা ক্যাশ'} span={2}>
              <MoneyInput value={amount} onChange={setAmount} autoFocus />
            </Field>
            <Field label="নোট" span={2}>
              <TextInput value={note} onChange={setNote} placeholder="যেমন: সকালের শিফট" />
            </Field>
          </div>
          {openModal === 'close' ? (
            <Banner tone="info" icon="info">
              প্রত্যাশিত ক্যাশ {money(expected)} — আপনি লিখেছেন {money(amount)}, পার্থক্য {money(amount - expected)}।
            </Banner>
          ) : null}
        </Modal>
      ) : null}

      {detail ? (
        <Modal
          title={`সেশন #${detail.id}`}
          sub={`${dateTime(detail.opened_at)} → ${detail.closed_at ? dateTime(detail.closed_at) : 'চলমান'}`}
          size="lg"
          onClose={() => setDetail(null)}
          footer={<Button onClick={() => setDetail(null)}>বন্ধ</Button>}
        >
          <div className="row" style={{ gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <Badge tone="blue">ওপেনিং {money(detail.opening_cash_paisa)}</Badge>
            <Badge tone="teal">প্রত্যাশিত {money(detail.expected_cash_paisa ?? 0)}</Badge>
            <Badge tone="amber">গণনা {money(detail.counted_cash_paisa ?? 0)}</Badge>
            {detail.difference_paisa !== null ? <Badge tone={detail.difference_paisa === 0 ? 'green' : 'red'}>পার্থক্য {money(detail.difference_paisa)}</Badge> : null}
          </div>
          <DataTable
            compact
            maxHeight={360}
            rows={detailMoves}
            rowKey={(r) => r.id}
            columns={[
              { key: 'created_at', label: 'সময়', render: (r) => <span className="tiny">{dateTime(r.created_at)}</span> },
              { key: 'source', label: 'উৎস' },
              { key: 'note', label: 'নোট', render: (r) => <span className="tiny muted">{r.note ?? '—'}</span> },
              {
                key: 'amount_paisa',
                label: 'টাকা',
                align: 'right',
                render: (r) => (
                  <span className={`num bold ${r.direction === 'in' ? 'success-text' : 'danger-text'}`}>
                    {r.direction === 'in' ? '+' : '−'}
                    {money(r.amount_paisa)}
                  </span>
                ),
              },
            ]}
            empty={<EmptyState icon="cash" title="মুভমেন্ট নেই" />}
          />
          {detailTotals ? (
            <div className="col" style={{ marginTop: 10, gap: 4 }}>
              <CalcRow label="নগদ আদায়" value={money(detailTotals.cash_in ?? 0)} />
              <CalcRow label="নগদ বাহির" value={`−${money(detailTotals.cash_out ?? 0)}`} />
              <CalcRow label="নেট" value={money(detailTotals.net ?? 0)} strong />
            </div>
          ) : null}
        </Modal>
      ) : null}
    </>
  );
}

function CalcRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="row" style={{ justifyContent: 'space-between' }}>
      <span className={strong ? 'bold' : 'muted small'}>{label}</span>
      <span className={`num ${strong ? 'bold' : ''}`}>{value}</span>
    </div>
  );
}

export { Icon, dateShort };
