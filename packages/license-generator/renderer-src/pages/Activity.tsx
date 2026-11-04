import { useCallback, useEffect, useState } from 'react';
import { call } from '../api.js';
import { Badge, Button, Card, Empty, Input, PageHead, Select, Table, dtTime, useDebounced, useUI } from '../ui.js';
import type { LedgerEntry } from '../types.js';

export function ActivityPage() {
  const ui = useUI();
  const [rows, setRows] = useState<LedgerEntry[]>([]);
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query);
  const [action, setAction] = useState<'all' | LedgerEntry['action']>('all');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await call<LedgerEntry[]>('ledger.list', 500));
    } catch (err) {
      ui.error('অ্যাক্টিভিটি লোড ব্যর্থ', (err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [ui]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = rows
    .filter((r) => (action === 'all' ? true : r.action === action))
    .filter((r) =>
      debounced.trim()
        ? [r.org, r.license_id, r.key_id, r.reason ?? ''].some((v) => v.toLowerCase().includes(debounced.trim().toLowerCase()))
        : true,
    );

  return (
    <>
      <PageHead
        title="লাইসেন্স অ্যাক্টিভিটি"
        sub="অ্যাপেন্ড-ওনলি লেজার — প্রতিটি ঘটনা, কে কোন কী দিয়ে"
        actions={<Button icon="refresh" onClick={() => void load()}>রিফ্রেশ</Button>}
      />

      <Card>
        <div className="toolbar">
          <div style={{ width: 180 }}>
            <Select
              value={action}
              onChange={(v) => setAction(v as never)}
              options={[
                { value: 'all', label: 'সব ঘটনা' },
                { value: 'issued', label: 'ইস্যু' },
                { value: 'reissued', label: 'রি-ইস্যু' },
                { value: 'revoked', label: 'প্রত্যাহার' },
              ]}
            />
          </div>
          <Input value={query} onChange={setQuery} placeholder="প্রতিষ্ঠান, লাইসেন্স, কী আইডি" />
          <span className="grow" />
          <span className="small muted">{filtered.length} ঘটনা</span>
        </div>
        <Table
          loading={loading}
          rows={filtered}
          rowKey={(r) => r.id}
          empty={<Empty icon="clock" title="কোনো ঘটনা নেই" />}
          columns={[
            { key: 'at', label: 'সময়', width: 170, render: (r) => <span className="small muted">{dtTime(r.at)}</span> },
            {
              key: 'action',
              label: 'কাজ',
              width: 110,
              render: (r) => (
                <Badge tone={r.action === 'issued' ? 'green' : r.action === 'reissued' ? 'amber' : 'red'}>
                  {r.action === 'issued' ? 'ইস্যু' : r.action === 'reissued' ? 'রি-ইস্যু' : 'প্রত্যাহার'}
                </Badge>
              ),
            },
            { key: 'org', label: 'প্রতিষ্ঠান', render: (r) => <span className="bold small">{r.org}</span> },
            { key: 'license_id', label: 'লাইসেন্স', render: (r) => <span className="mono tiny">{r.license_id}</span> },
            { key: 'edition', label: 'এডিশন', render: (r) => <span className="small">{r.edition}</span> },
            { key: 'key_id', label: 'কী আইডি', render: (r) => <span className="mono tiny">{r.key_id}</span> },
            { key: 'reason', label: 'কারণ', render: (r) => <span className="small muted">{r.reason ?? '—'}</span> },
          ]}
        />
      </Card>
    </>
  );
}
