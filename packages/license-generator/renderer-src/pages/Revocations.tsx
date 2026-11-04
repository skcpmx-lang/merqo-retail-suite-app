import { useCallback, useEffect, useState } from 'react';
import { call } from '../api.js';
import { useApp } from '../App.js';
import { Banner, Button, Card, Empty, Input, PageHead, Table, dtTime, useDebounced, useUI } from '../ui.js';
import type { LicenseRecord } from '../types.js';

export function RevocationsPage() {
  const { navigate } = useApp();
  const ui = useUI();
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query);
  const [rows, setRows] = useState<LicenseRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await call<LicenseRecord[]>('licenses.list', { q: debounced, state: 'revoked' }));
    } catch (err) {
      ui.error('লোড ব্যর্থ', (err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [debounced, ui]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHead
        title="প্রত্যাহার রেকর্ড"
        sub="প্রত্যাহার করা লাইসেন্স ও কারণ — অফলাইন মডেলে এগুলো নতুন ইস্যু নিয়ন্ত্রণ করে"
        actions={<Button icon="refresh" onClick={() => void load()}>রিফ্রেশ</Button>}
      />

      <Banner tone="warn">
        অফলাইন পণ্য হওয়ায় প্রত্যাহার ইনস্টল করা কপিতে পৌঁছায় না। প্রত্যাহার মানে — এই মেশিন আর ওই লাইসেন্স নবায়ন/রি-ইস্যু
        করবে না, এবং যাচাইয়ে “প্রত্যাহৃত” দেখাবে। চুক্তিভঙ্গে গ্রাহককে জানিয়ে নতুন লাইসেন্স না দেওয়াই কার্যকর ব্যবস্থা।
      </Banner>

      <Card>
        <div className="toolbar">
          <Input value={query} onChange={setQuery} placeholder="প্রতিষ্ঠান বা লাইসেন্স" />
          <span className="grow" />
          <span className="small muted">{rows.length} প্রত্যাহার</span>
        </div>
        <Table
          loading={loading}
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate('licenses', { q: r.license_id })}
          empty={<Empty icon="check" title="কোনো প্রত্যাহার নেই" message="সব লাইসেন্স সক্রিয় বা প্রতিস্থাপিত।" />}
          columns={[
            { key: 'license_id', label: 'লাইসেন্স', render: (r) => <span className="mono small">{r.license_id}</span> },
            { key: 'org', label: 'প্রতিষ্ঠান', render: (r) => <span className="bold small">{r.org}</span> },
            { key: 'revoked_at', label: 'প্রত্যাহারের সময়', render: (r) => <span className="small">{dtTime(r.revoked_at)}</span> },
            { key: 'revoke_reason', label: 'কারণ', render: (r) => <span className="small muted">{r.revoke_reason ?? '—'}</span> },
          ]}
        />
      </Card>
    </>
  );
}
