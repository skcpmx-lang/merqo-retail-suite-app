import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import './theme.css';

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');

if (!window.licgen) {
  root.innerHTML = `
    <div style="display:grid;place-items:center;height:100vh;font-family:'Nirmala UI','Noto Sans Bengali',sans-serif;background:#0d1116;color:#e8edf3;text-align:center;padding:24px">
      <div>
        <h1 style="font-size:19px;margin:0 0 8px">সাউদা লাইসেন্স জেনারেটর চালু করা যাচ্ছে না</h1>
        <p style="margin:0;color:#8b97a6">এই উইন্ডোটি অ্যাপ্লিকেশনের বাইরে খোলা হয়েছে। অনুগ্রহ করে ডেস্কটপ অ্যাপটি চালু করুন।</p>
      </div>
    </div>`;
} else {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
