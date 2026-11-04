import { useCallback, useEffect, useState } from 'react';
import { call } from '../api.js';
import { useApp } from '../App.js';
import { Banner, Button, Card, CardHead, Empty, Icon, PageHead, Stat, Table, dtTime, useUI } from '../ui.js';
import type { LedgerEntry, LicenseRecord, Summary } from '../types.js';

interface Payload {
  summary: Summary;
  recent: LedgerEntry[];
  keyLoaded: boolean;
}

export function DashboardPage() {
  const { navigate, keyStatus, info } = useApp();
  const ui = useUI();
  const [data, setData] = useState<Payload | null>(null);
  const [expiring, setExpiring] = useState<LicenseRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [summary, expiringList] = await Promise.all([
        call<Payload>('dashboard.summary'),
        call<LicenseRecord[]>('licenses.list', { state: 'active' }),
      ]);
      setData(summary);
      setExpiring(
        expiringList
          .filter((l) => l.expires_at)
          .sort((a, b) => String(a.expires_at).localeCompare(String(b.expires_at)))
          .slice(0, 6),
      );
    } catch (err) {
      ui.error('ওভারভিউ লোড ব্যর্থ', (err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [ui]);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = data?.summary;

  return (
    <>
      <PageHead
        title="ওভারভিউ"
        sub="লাইসেন্স ব্যবসার বর্তমান অবস্থা — সব সংখ্যা এই মেশিনের রেকর্ড থেকে"
        actions={
          <>
            <Button icon="refresh" onClick={() => void load()}>
              রিফ্রেশ
            </Button>
            <Button variant="primary" icon="plus" onClick={() => navigate('generate')}>
              নতুন লাইসেন্স
            </Button>
          </>
        }
      />

      {!keyStatus.loaded ? (
        <Banner tone="warn">
          সাইনিং প্রাইভেট কী লোড করা নেই। লাইসেন্স ইস্যু বা রি-ইস্যু করতে <strong>সিকিউরিটি ও কী</strong> থেকে কী ফাইল
          লোড করুন (কী কখনো এই অ্যাপের ভেতরে সংরক্ষিত হয় না)।
        </Banner>
      ) : null}

      <div className="stat-grid">
        <Stat label="সক্রিয় লাইসেন্স" value={summary?.active ?? 0} icon="check" tone="good" foot={`মোট ${summary?.licenses ?? 0} টির মধ্যে`} />
        <Stat label="কাস্টমার" value={summary?.customers ?? 0} icon="users" foot={`৩০ দিনে ইস্যু ${summary?.issued_30d ?? 0}`} />
        <Stat label="৩০ দিনে মেয়াদ শেষ" value={summary?.expiring_soon ?? 0} icon="clock" tone={summary?.expiring_soon ? 'warn' : undefined} foot="নবায়ন দরকার হতে পারে" />
        <Stat label="মেয়াদোত্তীর্ণ" value={summary?.expired ?? 0} icon="alert" tone={summary?.expired ? 'danger' : undefined} />
        <Stat label="প্রত্যাহৃত" value={summary?.revoked ?? 0} icon="close" foot={`প্রতিস্থাপিত ${summary?.superseded ?? 0}`} />
        <Stat label="লাইফটাইম" value={summary?.lifetime ?? 0} icon="license" foot="মেয়াদহীন লাইসেন্স" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)', gap: 16 }}>
        <Card>
          <CardHead
            title="সাম্প্রতিক অ্যাক্টিভিটি"
            sub="এই মেশিন থেকে ইস্যু, রি-ইস্যু ও প্রত্যাহার"
            actions={
              <Button size="sm" variant="ghost" onClick={() => navigate('activity')}>
                সব দেখুন
              </Button>
            }
          />
          <Table
            compact
            loading={loading}
            rows={data?.recent ?? []}
            rowKey={(r) => r.id}
            empty={<Empty icon="clock" title="এখনো কোনো লাইসেন্স ইস্যু হয়নি" message="নতুন লাইসেন্স দিয়ে শুরু করুন।" />}
            columns={[
              { key: 'at', label: 'সময়', render: (r) => <span className="small muted">{dtTime(r.at)}</span> },
              {
                key: 'action',
                label: 'কাজ',
                render: (r) => (
                  <span className={`pill ${r.action === 'issued' ? 'green' : r.action === 'reissued' ? 'amber' : 'red'}`}>
                    {r.action === 'issued' ? 'ইস্যু' : r.action === 'reissued' ? 'রি-ইস্যু' : 'প্রত্যাহার'}
                  </span>
                ),
              },
              { key: 'org', label: 'প্রতিষ্ঠান', render: (r) => <span className="bold small">{r.org}</span> },
              { key: 'license_id', label: 'লাইসেন্স', render: (r) => <span className="mono tiny">{r.license_id.slice(-10)}</span> },
            ]}
          />
        </Card>

        <Card>
          <CardHead
            title="শীঘ্রই মেয়াদ শেষ"
            sub="সক্রিয় ও মেয়াদযুক্ত লাইসেন্স"
            actions={
              <Button size="sm" variant="ghost" onClick={() => navigate('reports')}>
                রিপোর্ট
              </Button>
            }
          />
          <Table
            compact
            loading={loading}
            rows={expiring}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate('licenses', { q: r.license_id })}
            empty={<Empty icon="check" title="মেয়াদযুক্ত লাইসেন্স নেই" message="সব লাইসেন্স লাইফটাইম অথবা মেয়াদ এখনো দূরে।" />}
            columns={[
              { key: 'org', label: 'প্রতিষ্ঠান', render: (r) => <span className="bold small">{r.org}</span> },
              {
                key: 'expires_at',
                label: 'মেয়াদ',
                align: 'right',
                render: (r) => {
                  const days = Math.ceil((new Date(String(r.expires_at)).getTime() - Date.now()) / 86_400_000);
                  return (
                    <span className={`pill ${days <= 7 ? 'red' : days <= 30 ? 'amber' : 'plain'}`}>
                      {days} দিন
                    </span>
                  );
                },
              },
            ]}
          />
        </Card>
      </div>

      <Card>
        <CardHead title="দ্রুত কাজ" sub="প্রতিদিনের প্রশাসনিক ধাপ" />
        <div className="card-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
          {[
            { id: 'customers', label: 'কাস্টমার যোগ', icon: 'users' as const, note: 'নতুন প্রতিষ্ঠান নিবন্ধন' },
            { id: 'generate', label: 'লাইসেন্স ইস্যু', icon: 'plus' as const, note: '৯ ধাপের গাইড' },
            { id: 'verify', label: 'ফাইল যাচাই', icon: 'check' as const, note: 'স্বাক্ষর পরীক্ষা' },
            { id: 'reissue', label: 'রি-ইস্যু', icon: 'refresh' as const, note: 'হার্ডওয়্যার বদল' },
            { id: 'reports', label: 'রিপোর্ট', icon: 'chart' as const, note: 'রেজিস্টার ও তালিকা' },
            { id: 'security', label: 'কী স্ট্যাটাস', icon: 'shield' as const, note: 'স্বাক্ষর প্রস্তুতি' },
          ].map((item) => (
            <button
              key={item.id}
              className="nav-item"
              style={{ color: 'var(--ink-2)', background: 'var(--surface-2)', border: '1px solid var(--line)', flexDirection: 'column', alignItems: 'flex-start', gap: 2, padding: 12 }}
              onClick={() => navigate(item.id as never)}
            >
              <span className="row" style={{ gap: 7, color: 'var(--brand-600)', fontWeight: 700, fontSize: 13 }}>
                <Icon name={item.icon} size={15} />
                {item.label}
              </span>
              <span className="tiny muted">{item.note}</span>
            </button>
          ))}
        </div>
      </Card>

      <Card>
        <CardHead title="সিস্টেম" sub={info?.storePath} />
        <div className="card-body small muted">
          <div className="row" style={{ flexWrap: 'wrap', gap: 18 }}>
            <span>অ্যাপ: v{info?.appVersion}</span>
            <span>জেনারেটর: v{info?.generatorVersion}</span>
            <span>প্ল্যাটফর্ম: {info?.platform}</span>
            <span>লেজার: {info?.ledgerPath}</span>
          </div>
        </div>
      </Card>
    </>
  );
}
