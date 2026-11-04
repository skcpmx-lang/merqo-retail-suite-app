import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import './theme.css';
import './design-v110.css';

// The renderer only ever talks to the main process through the preload bridge.
// If the bridge is missing (e.g. opened in a plain browser) we show a friendly
// message instead of a stack trace.
const root = document.getElementById('root');
if (!root) throw new Error('root element missing');

if (!window.sauda) {
  root.innerHTML = `
    <div style="display:grid;place-items:center;height:100vh;font-family:'Nirmala UI','Noto Sans Bengali',sans-serif;background:#f3f6f6;color:#344054;text-align:center;padding:24px">
      <div>
        <h1 style="font-size:20px;margin:0 0 8px">সাউদা চালু করা যাচ্ছে না</h1>
        <p style="margin:0;color:#667085">এই উইন্ডোটি অ্যাপ্লিকেশনের বাইরে খোলা হয়েছে। অনুগ্রহ করে ডেস্কটপ অ্যাপটি চালু করুন।</p>
      </div>
    </div>`;
} else {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
