import { useEffect, useState } from 'react';
import { call } from '../api.js';
import { SaudaLogo, Icon } from '../icons.js';
import { Badge, Button, Card, KV, Loading, PageHead, useUI } from '../ui.js';
import type { ActivationState, AppInfo, User } from '../types.js';

const FEATURES = [
  { icon: 'pos', title: 'দ্রুত বিক্রয় (POS)', text: 'বারকোড স্ক্যান, একাধিক ইউনিট, ডিসকাউন্ট ও বাকি বিক্রয়' },
  { icon: 'product', title: 'প্রোডাক্ট ও স্টক', text: 'ক্যাটাগরি, ইউনিট রূপান্তর, লো স্টক অ্যালার্ট, ব্যাচ ট্র্যাকিং' },
  { icon: 'purchase', title: 'পারচেজ ও সাপ্লায়ার', text: 'ক্রয়, পাওনা, পরিশোধ ও রিটার্ন — সব হিসাব নিজে থেকেই' },
  { icon: 'report', title: '২৭+ রিপোর্ট', text: 'প্রফিট, স্টক ভ্যালুয়েশন, বাকি খাতা, ক্যাশ — CSV/Excel/PDF' },
  { icon: 'cash', title: 'ক্যাশ রেজিস্টার', text: 'দিনের সেশন, নগদ মিলকরণ ও পার্থক্যের অডিট' },
  { icon: 'print', title: 'থার্মাল রিসিট', text: '৫৮ মিমি ও ৮০ মিমি প্রিন্টার, বাংলা ফন্ট, ডুপ্লিকেট কপি' },
  { icon: 'backup', title: 'ব্যাকআপ ও রিস্টোর', text: 'এক ক্লিকে সম্পূর্ণ ব্যাকআপ, যাচাইসহ রিস্টোর' },
  { icon: 'shield', title: 'অফলাইন লাইসেন্স', text: 'ইন্টারনেট ছাড়াই কাজ করে; ডেটা কখনো অনলাইনে যায় না' },
];

export function AboutPage({ user }: { user: User }) {
  const ui = useUI();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [license, setLicense] = useState<ActivationState | null>(null);
  const [checks, setChecks] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [i, l] = await Promise.all([call<AppInfo>('app.info'), call<ActivationState>('license.state')]);
        setInfo(i);
        setLicense(l);
      } catch (err) {
        ui.error('তথ্য লোড ব্যর্থ', (err as Error).message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runCheck = async () => {
    setBusy(true);
    try {
      setChecks(await call<any>('app.integrity'));
    } catch (err) {
      ui.error('যাচাই ব্যর্থ', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!info) return <Loading label="তথ্য লোড হচ্ছে…" />;

  return (
    <>
      <PageHead title="সফটওয়্যার সম্পর্কে" sub={`${info.name} • সংস্করণ ${info.version} (${info.build})`} />

      <Card>
        <div className="card-body">
          <div className="row" style={{ gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <SaudaLogo size={62} />
            <div style={{ flex: 1, minWidth: 240 }}>
              <h2 style={{ margin: 0, fontSize: 20 }}>
                {info.name} <span className="badge teal">v{info.version}</span>
              </h2>
              <p className="muted small" style={{ marginTop: 4 }}>
                বাংলাদেশের দোকান ও ছোট ব্যবসার জন্য সম্পূর্ণ অফলাইন রিটেইল POS ও ব্যবসা ব্যবস্থাপনা সফটওয়্যার।
                সব হিসাব এই কম্পিউটারেই থাকে — ইন্টারনেটের প্রয়োজন নেই।
              </p>
              <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <Badge tone="green">অফলাইন</Badge>
                <Badge tone="blue">বাংলা ইন্টারফেস</Badge>
                <Badge tone="teal">৳ বাংলাদেশি টাকা</Badge>
                <Badge tone="plain">SQLite ডাটাবেজ</Badge>
              </div>
            </div>
            <div style={{ minWidth: 250 }}>
              <KV label="নির্মাতা" value={info.company} />
              <KV label="প্রতিষ্ঠাতা" value={info.founder} />
              <KV label="সহায়তা" value={info.email} />
              <KV label="লাইসেন্স" value={license?.license?.org ?? '—'} />
            </div>
          </div>
        </div>
      </Card>

      <div className="grid-2" style={{ marginTop: 14 }}>
        <Card>
          <div className="card-head">
            <div>
              <h3>মূল বৈশিষ্ট্য</h3>
              <div className="sub">দৈনন্দিন ব্যবসার প্রতিটি কাজ</div>
            </div>
          </div>
          <div className="card-body">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 10 }}>
              {FEATURES.map((f) => (
                <div key={f.title} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px' }}>
                  <div className="row" style={{ gap: 7 }}>
                    <Icon name={f.icon as any} size={16} style={{ color: 'var(--brand-600)' }} />
                    <strong className="small">{f.title}</strong>
                  </div>
                  <div className="tiny muted" style={{ marginTop: 3, lineHeight: 1.5 }}>
                    {f.text}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Card>

        <div className="col">
          <Card>
            <div className="card-head">
              <div>
                <h3>সিস্টেম তথ্য</h3>
                <div className="sub">সহায়তার জন্য প্রয়োজন হতে পারে</div>
              </div>
            </div>
            <div className="card-body">
              <KV label="সংস্করণ" value={`${info.version} (${info.build})`} />
              <KV label="চ্যানেল" value={info.channel} />
              <KV label="ডাটাবেজ ভার্সন" value={String(info.db_version)} />
              <KV label="Electron" value={info.electron || '—'} />
              <KV label="Chromium" value={info.chrome || '—'} />
              <KV label="Node" value={info.node || '—'} />
              <KV label="লগইন" value={`${user.full_name} (${user.role})`} />
              <div className="divider" />
              <div className="tiny muted" style={{ wordBreak: 'break-all', lineHeight: 1.7 }}>
                <div>ডেটা: {info.data_dir}</div>
                <div>ডাটাবেজ: {info.db_path}</div>
                <div>লগ: {info.logs_dir}</div>
              </div>
              <div className="row" style={{ gap: 8, marginTop: 10 }}>
                <Button size="sm" icon="backup" onClick={() => call('app.openDataFolder')}>
                  ডেটা ফোল্ডার
                </Button>
                <Button size="sm" icon="shield" loading={busy} onClick={runCheck}>
                  ডাটাবেজ যাচাই
                </Button>
              </div>
              {checks ? (
                <div style={{ marginTop: 8 }} className={checks.ok ? 'success-text' : 'danger-text'}>
                  <span className="small bold">{checks.ok ? 'ডাটাবেজ ঠিক আছে' : checks.message}</span>
                  {checks.repaired ? <div className="tiny muted">পুনর্গঠন সম্পন্ন হয়েছে।</div> : null}
                </div>
              ) : null}
            </div>
          </Card>

          <Card>
            <div className="card-body">
              <div className="tiny muted" style={{ lineHeight: 1.8 }}>
                <strong>{info.copyright}</strong>
                <br />
                এই সফটওয়্যারটি লাইসেন্সকৃত। অননুমোদিত কপি, বিতরণ বা রিভার্স ইঞ্জিনিয়ারিং নিষিদ্ধ। আপনার ডেটা
                আপনারই — কোনো তথ্য কোথাও পাঠানো হয় না।
              </div>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
