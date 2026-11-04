/* Sauda License Generator — renderer (vanilla JS, no build step). */
'use strict';

const FEATURES = [
  ['pos', 'বিক্রয় (POS)'],
  ['inventory', 'ইনভেন্টরি'],
  ['purchases', 'পারচেজ'],
  ['customers', 'কাস্টমার ও বাকি'],
  ['suppliers', 'সাপ্লায়ার'],
  ['expenses', 'এক্সপেন্স'],
  ['cash', 'ক্যাশ রেজিস্টার'],
  ['returns', 'রিটার্ন ও রিফান্ড'],
  ['reports', 'রিপোর্ট ও এক্সপোর্ট'],
  ['printing', 'থার্মাল প্রিন্ট'],
  ['backup', 'ব্যাকআপ ও রিস্টোর'],
  ['multi_user', 'একাধিক ইউজার'],
  ['variants', 'ভ্যারিয়েন্ট'],
  ['batch_expiry', 'ব্যাচ ও মেয়াদ'],
];

const api = {
  async call(method, ...args) {
    return window.licgen.invoke(method, ...args);
  },
};

let deviceRequest = null;
let issued = null;

const $ = (id) => document.getElementById(id);
const show = (id, visible = true) => $(id).classList.toggle('hidden', !visible);

function toast(message, kind = '') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), kind === 'err' ? 9000 : 4500);
}

function fmtDate(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString('en-GB');
  } catch {
    return value;
  }
}

/* ------------------------------- boot ------------------------------- */

async function boot() {
  // features
  $('features').innerHTML = FEATURES.map(
    ([key, label]) => `<label><input type="checkbox" value="${key}" checked /> ${label}</label>`,
  ).join('');

  try {
    const info = await api.call('app.info');
    $('version').textContent = `v${info.generatorVersion}`;
  } catch {
    /* ignore */
  }

  const status = await api.call('key.status').catch(() => ({ loaded: false }));
  applyKey(status);
}

function applyKey(status) {
  const loaded = Boolean(status && status.loaded);
  $('key-pill').textContent = loaded ? `কী প্রস্তুত • ${status.keyId}` : 'কী লোড হয়নি';
  $('key-pill').className = `pill ${loaded ? 'ok' : 'warn'}`;
  $('key-id').textContent = loaded ? status.keyId : '';
  show('pubkey-wrap', loaded);
  if (loaded) $('pubkey').textContent = status.publicKeyB64;
  $('btn-issue').disabled = !loaded || !deviceRequest;
}

/* ------------------------------- actions ---------------------------- */

$('btn-load-key').addEventListener('click', async () => {
  try {
    const status = await api.call('key.load');
    if (!status) return;
    applyKey(status);
    toast('সাইনিং কী লোড হয়েছে।', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('btn-clear-key').addEventListener('click', async () => {
  await api.call('key.clear');
  applyKey({ loaded: false });
  toast('কী সরানো হয়েছে।');
});

$('btn-copy-pub').addEventListener('click', async () => {
  await api.call('copy', $('pubkey').textContent);
  toast('পাবলিক কী কপি হয়েছে।', 'ok');
});

$('btn-import-device').addEventListener('click', async () => {
  try {
    const request = await api.call('device.import');
    if (!request) return;
    deviceRequest = request;
    show('device-info', true);
    $('dev-business').textContent = request.business_name || '—';
    $('dev-fp').textContent = request.fingerprint || '—';
    $('dev-platform').textContent = request.platform || '—';
    $('dev-created').textContent = fmtDate(request.created_at);
    $('dev-components').innerHTML = request.components
      .map(
        (c) =>
          `<div class="component"><span>${c.key}</span><b>${String(c.hash).slice(0, 16)}…</b><span class="w">${c.weight}</span></div>`,
      )
      .join('');
    if (request.business_name && !$('f-org').value) $('f-org').value = request.business_name;
    if (request.fingerprint) $('f-note').value = '';
    applyKey(await api.call('key.status'));
    toast('ডিভাইস রিকোয়েস্ট লোড হয়েছে।', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
});

function formValues() {
  const features = [...document.querySelectorAll('#features input:checked')].map((el) => el.value);
  return {
    org: $('f-org').value.trim(),
    owner: $('f-owner').value.trim(),
    phone: $('f-phone').value.trim(),
    email: $('f-email').value.trim(),
    address: $('f-address').value.trim(),
    edition: $('f-edition').value,
    expiresAt: $('f-expires').value || null,
    maxDevices: Number($('f-devices').value) || 1,
    features,
    note: $('f-note').value.trim(),
  };
}

$('btn-issue').addEventListener('click', async () => {
  const values = formValues();
  if (!values.org) return toast('প্রতিষ্ঠানের নাম দিতে হবে।', 'err');
  if (!deviceRequest) return toast('আগে ডিভাইস রিকোয়েস্ট ফাইল লোড করুন।', 'err');
  $('btn-issue').disabled = true;
  $('issue-status').textContent = 'স্বাক্ষর করা হচ্ছে…';
  try {
    issued = await api.call('license.issue', deviceRequest, values);
    $('license-key').value = issued.key;
    $('payload').textContent = JSON.stringify(issued.payload, null, 2);
    $('issue-status').textContent = `তৈরি হয়েছে • ${issued.payload.license_id}`;
    $('btn-save').disabled = false;
    $('btn-copy-key').disabled = false;
    toast('লাইসেন্স তৈরি হয়েছে (নিজস্ব যাচাই সম্পন্ন)।', 'ok');
  } catch (err) {
    $('issue-status').textContent = '';
    toast(err.message, 'err');
  } finally {
    $('btn-issue').disabled = !deviceRequest;
  }
});

$('btn-save').addEventListener('click', async () => {
  if (!issued) return;
  try {
    const target = await api.call('license.save', issued.payload, issued.key, deviceRequest?.fingerprint ?? '');
    if (target) {
      toast(`সংরক্ষিত: ${target}`, 'ok');
      await api.call('reveal', target);
    }
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('btn-copy-key').addEventListener('click', async () => {
  if (!issued) return;
  await api.call('copy', issued.key);
  toast('লাইসেন্স কী কপি হয়েছে।', 'ok');
});

$('btn-check-license').addEventListener('click', async () => {
  try {
    const result = await api.call('license.check');
    if (!result) return;
    if (result.ok) {
      toast(`স্বাক্ষর ঠিক আছে — ${result.payload ? result.payload.org : ''} (${result.message})`, 'ok');
      if (result.keyText) $('license-key').value = result.keyText;
      if (result.payload) $('payload').textContent = JSON.stringify(result.payload, null, 2);
    } else {
      toast(`যাচাই ব্যর্থ: ${result.message}`, 'err');
    }
  } catch (err) {
    toast(err.message, 'err');
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') $('btn-issue').click();
});

boot();
