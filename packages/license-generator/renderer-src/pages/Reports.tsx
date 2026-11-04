import { useCallback, useEffect, useState } from 'react';
import { call } from '../api.js';
import { useApp } from '../App.js';
import { Button, Card, CardHead, Empty, PageHead, Table, useUI } from '../ui.js';

interface Built {
  definition: { id: string; title: string; note: string; columns: { key: string; label: string; align?: 'left' | 'right' | 'center' }[] };
  rows: string[][];
  summary: { customers: number; licenses: number; active: number };
}

export function ReportsPage() {
  const { catalog } = useApp();
  const ui = useUI();
  const [activeId, setActiveId] = useState<string>('licenses');
  const [built, setBuilt] = useState<Built | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBuilt(await call<Built>('reports.build', activeId));
    } catch (err) {
      ui.error('রিপোর্ট লোড ব্যর্থ', (err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [activeId, ui]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (kind: 'reports.preview' | 'reports.pdf' | 'reports.print') => {
    setBusy(kind);
    try {
      const res = await call(kind, activeId);
      if (kind === 'reports.print') ui.success((res as { message: string })?.message ?? 'প্রিন্ট হয়েছে');
      else if (kind === 'reports.pdf') ui.success('PDF সংরক্ষিত', String(res ?? ''));
      else ui.success('প্রিভিউ খোলা হয়েছে');
    } catch (err) {
      ui.error('ডকুমেন্ট তৈরি ব্যর্থ', (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHead
        title="রিপোর্ট"
        sub="৮টি প্রশাসনিক রিপোর্ট — A4 PDF, প্রিন্ট ও প্রিভিউ"
        actions={
          <>
            <Button icon="eye" loading={busy === 'reports.preview'} onClick={() => void run('reports.preview')}>
              প্রিভিউ
            </Button>
            <Button icon="download" loading={busy === 'reports.pdf'} onClick={() => void run('reports.pdf')}>
              PDF
            </Button>
            <Button icon="print" loading={busy === 'reports.print'} onClick={() => void run('reports.print')}>
              প্রিন্ট
            </Button>
          </>
        }
      />

      <Card>
        <div className="toolbar" style={{ flexWrap: 'wrap' }}>
          {(catalog?.reports ?? []).map((r) => (
            <button
              key={r.id}
              className={`btn ${activeId === r.id ? 'primary' : ''} sm`}
              onClick={() => setActiveId(r.id)}
              title={r.note}
            >
              {r.title}
            </button>
          ))}
        </div>
        <CardHead title={built?.definition.title ?? 'রিপোর্ট'} sub={built?.definition.note} />
        <Table
          loading={loading}
          rows={(built?.rows ?? []).map((row, index) => ({ index, row }))}
          rowKey={(r) => r.index}
          compact
          empty={<Empty icon="chart" title="এই রিপোর্টে কোনো তথ্য নেই" />}
          columns={(built?.definition.columns ?? []).map((c, idx) => ({
            key: String(idx),
            label: c.label,
            align: c.align ?? 'left',
            render: (r: { row: string[] }) => <span className={idx === 0 ? 'mono tiny' : 'small'}>{r.row[idx] ?? '—'}</span>,
          }))}
        />
      </Card>
    </>
  );
}
