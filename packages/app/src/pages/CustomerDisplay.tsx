import { useEffect, useState } from 'react';
import { call, onEvent } from '../api.js';
import { money, setFormatPrefs } from '../format.js';
import { SaudaLogo } from '../icons.js';

interface DisplayItem {
  name: string;
  qtyMilli: number;
  amountPaisa: number;
}

interface DisplayState {
  phase: 'idle' | 'cart' | 'done';
  invoiceNo?: string | null;
  totalPaisa: number;
  changePaisa?: number;
  items?: DisplayItem[];
}

/**
 * Second-screen (customer facing) window. It never signs in and never shows
 * cost, margin or customer credit — only what the shopper is entitled to see.
 * Everything arrives from the main process, so no business call is made here.
 */
export function CustomerDisplayPage() {
  const [brand, setBrand] = useState<{ name: string; logo: string | null; footer: string }>({
    name: '',
    logo: null,
    footer: '',
  });
  const [state, setState] = useState<DisplayState>({ phase: 'idle', totalPaisa: 0, items: [] });
  const [clock, setClock] = useState(() => new Date());

  useEffect(() => {
    void (async () => {
      try {
        const settings = await call<any>('settings.get');
        setFormatPrefs({ symbol: settings.currency_symbol, bengaliDigits: settings.bengali_digits === 1 });
        const logo = await call<string | null>('settings.logoDataUrl').catch(() => null);
        setBrand({
          name: settings.business_name ?? '',
          logo,
          footer: settings.document_footer || settings.receipt_footer || '',
        });
      } catch {
        /* the display still works with the defaults */
      }
    })();
  }, []);

  useEffect(() => {
    return onEvent((evt) => {
      if (evt.type !== 'display' || !evt.message) return;
      try {
        const parsed = JSON.parse(evt.message) as DisplayState | null;
        setState(parsed ?? { phase: 'idle', totalPaisa: 0, items: [] });
      } catch {
        /* malformed payloads are ignored rather than breaking the screen */
      }
    });
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const time = clock.toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="display-shell">
      <header className="display-brand">
        {brand.logo ? <img src={brand.logo} alt="" className="brand-img" style={{ width: 42, height: 42 }} /> : <SaudaLogo size={34} />}
        <div>
          <div className="display-name">{brand.name || 'সাউদা রিটেইল'}</div>
          <div className="display-sub">স্বাগতম • {time}</div>
        </div>
        <div className="grow" />
        {state.invoiceNo ? <div className="display-invoice mono">{state.invoiceNo}</div> : null}
      </header>

      <main className="display-body">
        {state.phase === 'done' ? (
          <div className="display-thanks">
            <div className="display-done-icon">✓</div>
            <div className="display-done-title">ধন্যবাদ!</div>
            <div className="display-done-text">আবার আসবেন।</div>
            {(state.changePaisa ?? 0) > 0 ? (
              <div className="display-change">
                ফেরত <strong className="num">{money(state.changePaisa ?? 0)}</strong>
              </div>
            ) : null}
            <div className="display-total num">{money(state.totalPaisa)}</div>
          </div>
        ) : state.items && state.items.length > 0 ? (
          <div className="display-items">
            <div className="display-items-head">
              <span>পণ্য</span>
              <span className="right">পরিমাণ</span>
              <span className="right">মূল্য</span>
            </div>
            {state.items.map((item, i) => (
              <div key={`${item.name}-${i}`} className="display-line">
                <span className="nowrap">{item.name}</span>
                <span className="right num">{(item.qtyMilli / 1000).toFixed(item.qtyMilli % 1000 === 0 ? 0 : 3)}</span>
                <span className="right num">{money(item.amountPaisa)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="display-idle">
            <SaudaLogo size={72} />
            <div className="display-idle-text">আপনার পণ্য স্ক্যান করুন</div>
          </div>
        )}
      </main>

      <footer className="display-foot">
        <div className="display-total-row">
          <span>সর্বমোট</span>
          <span className="display-total num">{money(state.totalPaisa)}</span>
        </div>
        {brand.footer ? <div className="display-footer-text">{brand.footer}</div> : null}
      </footer>
    </div>
  );
}
