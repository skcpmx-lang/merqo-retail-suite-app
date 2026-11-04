import { useState } from 'react';
import { call } from '../api.js';
import { SaudaLogo, Icon } from '../icons.js';
import { Banner, Button, Field, TextInput } from '../ui.js';
import type { User } from '../types.js';

export function LoginPage({
  businessName,
  licenseOrg,
  onLogin,
}: {
  businessName: string;
  licenseOrg: string;
  onLogin: (user: User) => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError(null);
    if (!username.trim() || !password) {
      setError('ইউজারনেম ও পাসওয়ার্ড দুটোই দিন।');
      return;
    }
    setBusy(true);
    try {
      const user = await call<User>('auth.login', username.trim(), password);
      onLogin(user);
    } catch (err) {
      setError((err as Error).message);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brand-mark">
          <SaudaLogo size={44} />
        </div>
        <h1 style={{ fontSize: 20 }}>{businessName}</h1>
        <p className="muted small" style={{ marginTop: 2, marginBottom: 18 }}>
          {licenseOrg ? `${licenseOrg} • ` : ''}লগইন করে কাজ শুরু করুন
        </p>

        {error ? (
          <Banner tone="danger" icon="warning">
            {error}
          </Banner>
        ) : null}

        <div className="col">
          <Field label="ইউজারনেম">
            <TextInput value={username} onChange={setUsername} autoFocus placeholder="admin" />
          </Field>
          <Field label="পাসওয়ার্ড">
            <div style={{ position: 'relative' }}>
              <TextInput
                value={password}
                onChange={setPassword}
                type={show ? 'text' : 'password'}
                placeholder="••••••"
              />
              <button
                type="button"
                className="icon-btn"
                style={{ position: 'absolute', right: 4, top: 3 }}
                onClick={() => setShow((s) => !s)}
                title={show ? 'পাসওয়ার্ড লুকান' : 'পাসওয়ার্ড দেখুন'}
              >
                <Icon name="eye" size={16} />
              </button>
            </div>
          </Field>
          <Button variant="primary" block size="lg" type="submit" loading={busy} icon="lock">
            লগইন করুন
          </Button>
        </div>

        <div className="divider" />
        <div className="tiny muted" style={{ textAlign: 'center', lineHeight: 1.7 }}>
          সব তথ্য এই কম্পিউটারেই সংরক্ষিত থাকে। কোনো তথ্য ইন্টারনেটে পাঠানো হয় না।
          <br />
          পাসওয়ার্ড ভুলে গেলে অ্যাডমিনের সাথে যোগাযোগ করুন।
        </div>
      </form>
    </div>
  );
}
