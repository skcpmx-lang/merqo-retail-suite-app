import { useCallback, useEffect, useState } from 'react';
import { call } from '../api.js';
import { useT } from '../i18n.js';
import { dateShort, dateTime } from '../format.js';
import { Banner, Button, Card, CardHead, DataTable, Field, Loading, Modal, PageHead, TextInput, useUI } from '../ui.js';

interface Row {
  id: number;
  user_id: number;
  user_name: string;
  clock_in: string;
  clock_out: string | null;
  minutes: number | null;
  note: string | null;
}

export function TeamPage({ can, user }: { can: (p?: string) => boolean; user: { id: number; full_name: string; username: string } }) {
  const t = useT();
  const ui = useUI();
  const [rows, setRows] = useState<Row[]>([]);
  const [onFloor, setOnFloor] = useState<Row[]>([]);
  const [summary, setSummary] = useState<{ present: number; on_floor: number; total_minutes: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [correct, setCorrect] = useState<Row | null>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [target, setTarget] = useState<number | 'self'>('self');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, open, sum] = await Promise.all([
        call<Row[]>('attendance.list', { from: from || undefined, to: to || undefined }),
        call<Row[]>('attendance.open'),
        call<any>('attendance.summary'),
      ]);
      setRows(list ?? []);
      setOnFloor(open ?? []);
      setSummary(sum);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!can('user.manage')) return;
    void call<any[]>('users.list')
      .then((list) => setUsers(list ?? []))
      .catch(() => undefined);
  }, [can]);

  const punch = async (kind: 'in' | 'out') => {
    try {
      const userId = target === 'self' ? null : Number(target);
      await call(kind === 'in' ? 'attendance.clockIn' : 'attendance.clockOut', { userId, note: null });
      ui.success(kind === 'in' ? t('team.clockIn') : t('team.clockOut'));
      await load();
    } catch (err) {
      ui.error((err as Error).message);
    }
  };

  const saveCorrection = async (row: Row, clockIn: string, clockOut: string) => {
    try {
      await call('attendance.correct', {
        id: row.id,
        clockIn: clockIn || undefined,
        clockOut: clockOut || null,
        note: row.note ?? null,
      });
      ui.success(t('common.saved'));
      setCorrect(null);
      await load();
    } catch (err) {
      ui.error((err as Error).message);
    }
  };

  return (
    <>
      <PageHead
        title={t('team.title')}
        sub={summary ? `${t('team.present')}: ${summary.present} • ${t('team.onFloor')}: ${summary.on_floor}` : undefined}
        actions={
          <>
            <Button icon="refresh" variant="ghost" onClick={() => void load()}>
              {t('common.refresh')}
            </Button>
            <Button variant="primary" icon="clock" onClick={() => void punch('in')}>
              {t('team.clockIn')}
            </Button>
            <Button variant="warn" icon="logout" onClick={() => void punch('out')}>
              {t('team.clockOut')}
            </Button>
          </>
        }
      />

      {error ? <Banner tone="danger">{error}</Banner> : null}

      <div className="stat-grid" style={{ marginBottom: 16 }}>
        <div className="kpi">
          <div className="kpi-label">{t('team.present')}</div>
          <div className="kpi-value num">{summary?.present ?? 0}</div>
          <div className="kpi-foot">{t('common.today')}</div>
        </div>
        <div className="kpi good">
          <div className="kpi-label">{t('team.onFloor')}</div>
          <div className="kpi-value num">{summary?.on_floor ?? 0}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">{t('team.hours')}</div>
          <div className="kpi-value num">{Math.round(((summary?.total_minutes ?? 0) / 60) * 10) / 10}</div>
        </div>
      </div>

      {can('user.manage') && users.length > 0 ? (
        <Card style={{ marginBottom: 16 }}>
          <div className="toolbar" style={{ padding: 12 }}>
            <span className="small muted">পাঞ্চ কার জন্য:</span>
            <select className="select" value={String(target)} onChange={(e) => setTarget(e.target.value === 'self' ? 'self' : Number(e.target.value))}>
              <option value="self">{user.full_name || user.username} (আমি)</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name || u.username} — {u.username}
                </option>
              ))}
            </select>
            <span className="tiny muted">অন্য কর্মীর হয়ে পাঞ্চ করলে অডিট লগে আপনার নাম থাকবে।</span>
          </div>
        </Card>
      ) : null}

      {onFloor.length > 0 ? (
        <Card style={{ marginBottom: 16 }}>
          <CardHead title={t('team.onFloor')} sub={`${onFloor.length}`} />
          <div style={{ padding: 12 }} className="chip-row">
            {onFloor.map((r) => (
              <span key={r.id} className="pill teal">
                {r.user_name} • {dateTime(r.clock_in).slice(-5)}
              </span>
            ))}
          </div>
        </Card>
      ) : null}

      <Card>
        <div className="toolbar">
          <div style={{ width: 170 }}>
            <TextInput value={from} onChange={setFrom} type="date" />
          </div>
          <div style={{ width: 170 }}>
            <TextInput value={to} onChange={setTo} type="date" />
          </div>
          <div className="grow" />
          <span className="small muted">{rows.length}</span>
        </div>
        {loading ? (
          <Loading />
        ) : (
          <DataTable
            rows={rows}
            rowKey={(r) => r.id}
            columns={[
              { key: 'user_name', label: t('common.name'), render: (r) => <span className="bold small">{r.user_name}</span> },
              { key: 'clock_in', label: t('team.clockIn'), render: (r) => dateTime(r.clock_in) },
              { key: 'clock_out', label: t('team.clockOut'), render: (r) => (r.clock_out ? dateTime(r.clock_out) : <span className="pill amber">চলছে</span>) },
              {
                key: 'minutes',
                label: t('team.hours'),
                align: 'right',
                render: (r) => (r.minutes == null ? '—' : `${Math.floor(r.minutes / 60)}:${String(r.minutes % 60).padStart(2, '0')}`),
              },
              { key: 'note', label: t('common.notes'), render: (r) => <span className="small muted">{r.note ?? '—'}</span> },
              {
                key: 'actions',
                label: t('common.actions'),
                align: 'right',
                render: (r) =>
                  can('user.manage') ? (
                    <Button size="sm" variant="ghost" icon="edit" onClick={() => setCorrect(r)} />
                  ) : null,
              },
            ]}
          />
        )}
      </Card>

      {correct ? <CorrectionDialog row={correct} onClose={() => setCorrect(null)} onSave={saveCorrection} /> : null}
    </>
  );
}

function CorrectionDialog({ row, onClose, onSave }: { row: Row; onClose: () => void; onSave: (row: Row, ci: string, co: string) => Promise<void> }) {
  const t = useT();
  const [clockIn, setClockIn] = useState(row.clock_in.slice(0, 19).replace(' ', 'T'));
  const [clockOut, setClockOut] = useState(row.clock_out ? row.clock_out.slice(0, 19).replace(' ', 'T') : '');
  return (
    <Modal
      title={`${t('common.edit')} — ${row.user_name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" icon="check" onClick={() => void onSave(row, clockIn.replace('T', ' '), clockOut.replace('T', ' '))}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Banner tone="warn">সংশোধন অডিট লগে আগের ও পরের সময়সহ সংরক্ষিত হবে।</Banner>
      <div className="form-grid" style={{ marginTop: 10 }}>
        <Field label={t('team.clockIn')}>
          <TextInput value={clockIn} onChange={setClockIn} type="datetime-local" />
        </Field>
        <Field label={t('team.clockOut')}>
          <TextInput value={clockOut} onChange={setClockOut} type="datetime-local" />
        </Field>
      </div>
      <div className="tiny muted" style={{ marginTop: 8 }}>
        মূল রেকর্ড: {dateShort(row.clock_in)} • {row.clock_in.slice(11, 19)}
        {row.clock_out ? ` → ${row.clock_out.slice(11, 19)}` : ''}
      </div>
    </Modal>
  );
}
