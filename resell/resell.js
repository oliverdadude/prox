// Resell Profit Checker: works out Amazon UK profit for items bought in shops.
// All fees are estimates and can be overridden per product.
(() => {
  'use strict';

  // ---------- Reference data ----------
  // Amazon UK referral fees (approximate). `low` applies when price <= lowUpTo.
  const CATEGORIES = [
    { id: 'grocery', name: 'Grocery & Gourmet', low: 8, lowUpTo: 10, pct: 15, vat: 0, gated: true },
    { id: 'beauty', name: 'Beauty', low: 8, lowUpTo: 10, pct: 15, vat: 0.2, gated: false },
    { id: 'health', name: 'Health & Personal Care / Household', low: 8, lowUpTo: 10, pct: 15, vat: 0.2, gated: false },
    { id: 'baby', name: 'Baby Products', low: 8, lowUpTo: 10, pct: 15, vat: 0.2, gated: false },
    { id: 'pet', name: 'Pet Supplies', pct: 15, vat: 0.2, gated: false },
    { id: 'home', name: 'Home & Kitchen', pct: 15, vat: 0.2, gated: false },
    { id: 'toys', name: 'Toys & Games', pct: 15, vat: 0.2, gated: false },
    { id: 'office', name: 'Stationery & Office', pct: 15, vat: 0.2, gated: false },
    { id: 'electronics', name: 'Consumer Electronics', pct: 7, vat: 0.2, gated: false },
    { id: 'books', name: 'Books', pct: 15, vat: 0, gated: false },
    { id: 'other', name: 'Everything else', pct: 15, vat: 0.2, gated: false },
  ];
  const REFERRAL_MIN = 0.25;

  // Amazon UK FBA fulfilment fee estimates by packed size/weight.
  const TIERS = [
    { id: 'env-light', name: 'Light envelope (≤100 g, slim)', fee: 1.83 },
    { id: 'env-std', name: 'Standard envelope (≤210 g)', fee: 2.04 },
    { id: 'env-large', name: 'Large envelope (≤460 g)', fee: 2.30 },
    { id: 'env-xl', name: 'Extra-large envelope (≤960 g)', fee: 2.70 },
    { id: 'parcel-400', name: 'Small parcel (≤400 g)', fee: 2.94 },
    { id: 'parcel-900', name: 'Small parcel (≤900 g)', fee: 3.30 },
    { id: 'parcel-1400', name: 'Parcel (≤1.4 kg)', fee: 3.70 },
    { id: 'parcel-1900', name: 'Parcel (≤1.9 kg)', fee: 4.10 },
    { id: 'parcel-3900', name: 'Parcel (≤3.9 kg)', fee: 5.20 },
    { id: 'parcel-big', name: 'Large parcel (over 3.9 kg)', fee: 7.00 },
  ];

  const STORES = [
    { id: 'sainsburys', name: "Sainsbury's", search: q => `https://www.sainsburys.co.uk/gol-ui/SearchResults/${encodeURIComponent(q)}` },
    { id: 'tesco', name: 'Tesco', search: q => `https://www.tesco.com/groceries/en-GB/search?query=${encodeURIComponent(q)}` },
    { id: 'asda', name: 'Asda', search: q => `https://www.asda.com/groceries/search/${encodeURIComponent(q)}` },
    { id: 'morrisons', name: 'Morrisons', search: q => `https://groceries.morrisons.com/search?entry=${encodeURIComponent(q)}` },
    { id: 'argos', name: 'Argos', search: q => `https://www.argos.co.uk/search/${encodeURIComponent(q)}/` },
    { id: 'boots', name: 'Boots' },
    { id: 'superdrug', name: 'Superdrug' },
    { id: 'bm', name: 'B&M' },
    { id: 'homebargains', name: 'Home Bargains' },
    { id: 'aldi', name: 'Aldi' },
    { id: 'lidl', name: 'Lidl' },
    { id: 'other', name: 'Other' },
  ];

  const STATUSES = ['idea', 'bought', 'listed', 'sold'];
  const STATUS_LABEL = { idea: 'Idea', bought: 'Bought', listed: 'Listed', sold: 'Sold' };

  const DEFAULT_SETTINGS = {
    vatRegistered: false, fulfil: 'FBA', targetRoi: 30, minProfit: 1.5,
    postage: 3.2, storage: 0.1, plan: 25,
  };

  // ---------- Storage (browser only) ----------
  const KEY_ITEMS = 'resell.items.v1';
  const KEY_SETTINGS = 'resell.settings.v1';
  const load = (k, fallback) => {
    try { const v = JSON.parse(localStorage.getItem(k)); return v ?? fallback; } catch { return fallback; }
  };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } };

  let settings = { ...DEFAULT_SETTINGS, ...load(KEY_SETTINGS, {}) };
  let items = load(KEY_ITEMS, []);
  if (!Array.isArray(items)) items = [];
  let editingId = null;
  let sort = { key: 'roi', dir: -1 };

  // ---------- Maths ----------
  const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
  const money = v => (v < 0 ? '−£' : '£') + Math.abs(v).toFixed(2);
  const pct = v => Number.isFinite(v) ? `${Math.round(v * 100)}%` : '–';
  const catById = id => CATEGORIES.find(c => c.id === id) || CATEGORIES[CATEGORIES.length - 1];
  const tierById = id => TIERS.find(t => t.id === id) || TIERS[0];
  const storeById = id => STORES.find(s => s.id === id) || STORES[STORES.length - 1];

  function referralPct(item, price) {
    if (item.refOverride !== '' && item.refOverride != null) return num(item.refOverride) / 100;
    const c = catById(item.cat);
    return (c.low != null && price <= c.lowUpTo ? c.low : c.pct) / 100;
  }

  // Returns a full per-unit breakdown for a product at a given selling price.
  function calc(item, priceOverride) {
    const price = priceOverride ?? num(item.sell);
    const buy = num(item.buy);
    const vatRate = num(item.vat);
    const reg = settings.vatRegistered;
    const fba = item.fulfil !== 'FBM';
    const hasFulfilOverride = item.fulfilOverride !== '' && item.fulfilOverride != null;

    const referral = price > 0 ? Math.max(REFERRAL_MIN, price * referralPct(item, price)) : 0;
    // Amazon's own fees (referral + FBA + storage). Postage you pay yourself for FBM isn't an Amazon fee.
    const fulfilFee = hasFulfilOverride ? num(item.fulfilOverride) : (fba ? tierById(item.tier).fee : num(settings.postage));
    const amazonFulfil = fba ? fulfilFee + num(settings.storage) : 0;
    const ownPostage = fba ? 0 : fulfilFee;

    const amazonFeesNet = referral + amazonFulfil;
    // Non-VAT-registered sellers pay 20% VAT on Amazon fees and can't reclaim it.
    const amazonFees = reg ? amazonFeesNet : amazonFeesNet * 1.2;
    const outputVat = reg ? price * vatRate / (1 + vatRate) : 0;
    const buyCost = reg ? buy / (1 + vatRate) : buy;
    const extras = num(item.inbound) + num(item.prep) + ownPostage;

    const profit = price - outputVat - amazonFees - buyCost - extras;
    const invested = buyCost + num(item.inbound) + num(item.prep);
    const roi = invested > 0 ? profit / invested : NaN;
    const margin = price > 0 ? profit / price : NaN;

    return { price, referral, amazonFees, amazonFulfil, ownPostage, outputVat, buyCost, extras, profit, invested, roi, margin, fba, reg };
  }

  // Lowest selling price that breaks even (profit rises with price, so bisect).
  function breakEven(item) {
    let lo = 0, hi = 1000;
    if (calc(item, hi).profit < 0) return NaN;
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (calc(item, mid).profit >= 0) hi = mid; else lo = mid;
    }
    return hi;
  }

  // Highest shop price you can pay and still hit the target ROI at the current Amazon price.
  function maxBuy(item) {
    const t = num(settings.targetRoi) / 100;
    const k = settings.vatRegistered ? 1 / (1 + num(item.vat)) : 1;
    const base = calc({ ...item, buy: 0 });
    const other = num(item.inbound) + num(item.prep);
    const b = (base.profit - t * other) / (k * (1 + t));
    return b;
  }

  function verdict(r) {
    if (!(r.price > 0)) return { cls: '', label: '' };
    if (r.profit >= num(settings.minProfit) && r.roi >= num(settings.targetRoi) / 100) return { cls: 'good', label: '✅ Worth buying', key: 'buy' };
    if (r.profit > 0) return { cls: 'warn', label: '⚠️ Small profit', key: 'thin' };
    return { cls: 'bad', label: '❌ You\'d lose money', key: 'loss' };
  }

  // ---------- DOM ----------
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const FIELDS = ['name', 'store', 'buy', 'qty', 'sell', 'cat', 'vat', 'fulfil', 'tier', 'inbound', 'prep', 'refOverride', 'fulfilOverride', 'notes'];

  const fillSelect = (el, list) => { el.innerHTML = list.map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join(''); };
  fillSelect($('store'), STORES);
  fillSelect($('cat'), CATEGORIES.map(c => ({ ...c, name: c.name + (c.gated ? ' (needs approval)' : '') })));
  fillSelect($('tier'), TIERS.map(t => ({ ...t, name: `${t.name}, ~£${t.fee.toFixed(2)}` })));

  function readForm() {
    const o = {};
    FIELDS.forEach(f => { o[f] = $(f).value; });
    o.name = o.name.trim();
    o.notes = o.notes.trim();
    return o;
  }

  function writeForm(o) {
    FIELDS.forEach(f => { if (o[f] != null) $(f).value = o[f]; });
    syncFulfil();
  }

  function resetForm() {
    $('form').reset();
    $('qty').value = 1; $('inbound').value = '0.30'; $('prep').value = '0.10';
    $('fulfil').value = settings.fulfil;
    $('cat').value = 'grocery';
    $('vat').value = '0';
    editingId = null;
    $('formTitle').textContent = 'Check a product';
    $('saveBtn').textContent = '＋ Save to my list';
    $('cancelEdit').classList.add('hidden');
    renderCalc();
  }

  function syncFulfil() {
    const fba = $('fulfil').value !== 'FBM';
    $('tierWrap').classList.toggle('hidden', !fba);
    $('inbound').closest('label').classList.toggle('hidden', !fba);
  }

  function renderLinks(item) {
    const q = item.name;
    if (!q) { $('links').innerHTML = ''; return; }
    const store = storeById(item.store);
    const links = [
      ['🔎 Amazon UK', `https://www.amazon.co.uk/s?k=${encodeURIComponent(q)}`],
      ['📈 Keepa (sales & price history)', `https://keepa.com/#!search/2-${encodeURIComponent(q)}`],
    ];
    if (store.search) links.push([`🛒 ${store.name}`, store.search(q)]);
    $('links').innerHTML = links.map(([t, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a>`).join('');
  }

  function renderCalc() {
    const item = readForm();
    renderLinks(item);
    const box = $('result');
    if (!(num(item.sell) > 0) || item.buy === '') {
      box.className = 'result';
      box.innerHTML = '<p class="muted">Fill in the buy price and the Amazon price to see your profit.</p>';
      return;
    }
    const r = calc(item);
    const v = verdict(r);
    const qty = Math.max(1, Math.round(num(item.qty, 1)));
    const be = breakEven(item);
    const mb = maxBuy(item);
    const cat = catById(item.cat);
    const vatNote = r.reg ? '' : ' (incl. 20% VAT)';

    const warnings = [];
    if (cat.gated) warnings.push(`${cat.name} is gated on Amazon UK. Check you're approved before buying.`);
    if (r.roi > 2) warnings.push('Over 200% ROI is unusual. Check the Amazon listing is the same size and pack count, and that the price isn\'t a short spike.');
    if (!r.reg && num(item.vat) > 0 && r.price > 0) warnings.push('Once your sales pass the VAT threshold (£90,000 a year), you\'ll owe VAT on items like this, which cuts the profit.');
    if (r.fba && r.price <= 10) warnings.push('Cheap items have thin margins on FBA. Amazon\'s low-price FBA rates may lower the fee; check the Revenue Calculator.');

    const rows = [
      ['Amazon sale price', r.price],
      r.reg && r.outputVat ? ['VAT you pay HMRC', -r.outputVat] : null,
      [`Referral fee${vatNote}`, -(r.reg ? r.referral : r.referral * 1.2)],
      r.fba ? [`FBA fee + storage${vatNote}`, -(r.reg ? r.amazonFulfil : r.amazonFulfil * 1.2)] : ['Your postage to customer', -r.ownPostage],
      [`Buy price${r.reg && num(item.vat) ? ' (ex VAT)' : ''}`, -r.buyCost],
      [r.fba ? 'Postage to Amazon + prep' : 'Prep', -(num(item.inbound) * (r.fba ? 1 : 0) + num(item.prep))],
    ].filter(Boolean);

    box.className = `result ${v.cls}`;
    box.innerHTML = `
      <p class="verdict">${v.label}</p>
      <div class="kpis">
        <div class="kpi"><span>Profit each</span><b class="${r.profit >= 0 ? 'pos' : 'neg'}">${money(r.profit)}</b></div>
        <div class="kpi"><span>ROI</span><b>${pct(r.roi)}</b></div>
        <div class="kpi"><span>Margin</span><b>${pct(r.margin)}</b></div>
        <div class="kpi"><span>Profit on ${qty}</span><b class="${r.profit >= 0 ? 'pos' : 'neg'}">${money(r.profit * qty)}</b></div>
        <div class="kpi"><span>You'd spend</span><b>${money(num(item.buy) * qty)}</b></div>
        <div class="kpi"><span>Break-even Amazon price</span><b>${Number.isFinite(be) ? money(be) : '–'}</b></div>
        <div class="kpi"><span>Max to pay for ${settings.targetRoi}% ROI</span><b>${mb > 0 ? money(mb) : 'n/a'}</b></div>
      </div>
      <table class="breakdown">
        ${rows.map(([l, a]) => `<tr><td>${esc(l)}</td><td>${money(a)}</td></tr>`).join('')}
        <tr class="total"><td>Profit per unit</td><td>${money(r.profit)}</td></tr>
      </table>
      ${warnings.length ? `<ul class="warnings">${warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}`;
  }

  function sortValue(it, key) {
    const r = calc(it);
    switch (key) {
      case 'name': return it.name.toLowerCase();
      case 'buy': return num(it.buy);
      case 'sell': return num(it.sell);
      case 'profit': return r.profit;
      case 'roi': return Number.isFinite(r.roi) ? r.roi : -Infinity;
      case 'total': return r.profit * Math.max(1, num(it.qty, 1));
      default: return 0;
    }
  }

  function renderList() {
    const filter = $('filter').value;
    const rows = items
      .filter(it => filter === 'all' || (filter === 'buy' ? verdict(calc(it)).key === 'buy' : it.status === filter))
      .sort((a, b) => {
        const x = sortValue(a, sort.key), y = sortValue(b, sort.key);
        return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
      });

    $('tbody').innerHTML = rows.map(it => {
      const r = calc(it);
      const v = verdict(r);
      const qty = Math.max(1, Math.round(num(it.qty, 1)));
      const cls = v.key === 'buy' ? 'pos' : v.key === 'thin' ? 'mid' : 'neg';
      return `<tr data-id="${esc(it.id)}">
        <td>${esc(it.name)}<small>${esc(storeById(it.store).name)} · ×${qty}${it.notes ? ' · ' + esc(it.notes) : ''}</small></td>
        <td class="num">${money(num(it.buy))}</td>
        <td class="num">${money(num(it.sell))}</td>
        <td class="num ${cls}">${money(r.profit)}</td>
        <td class="num ${cls}">${pct(r.roi)}</td>
        <td class="num ${cls}">${money(r.profit * qty)}</td>
        <td><select data-act="status">${STATUSES.map(s => `<option value="${s}"${s === it.status ? ' selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select></td>
        <td class="acts"><button data-act="edit" title="Edit">✏️</button><button data-act="dup" title="Duplicate">⧉</button><button data-act="del" title="Delete">🗑</button></td>
      </tr>`;
    }).join('');
    $('empty').classList.toggle('hidden', items.length > 0);
    $('table').classList.toggle('hidden', items.length === 0);
    document.querySelectorAll('#table th[data-sort]').forEach(th => {
      th.textContent = th.textContent.replace(/ [▲▼]$/, '') + (th.dataset.sort === sort.key ? (sort.dir > 0 ? ' ▲' : ' ▼') : '');
    });
    renderStats();
  }

  function renderStats() {
    if (!items.length) { $('stats').innerHTML = ''; return; }
    let spend = 0, profit = 0, invested = 0, good = 0, soldProfit = 0, active = 0;
    items.forEach(it => {
      const r = calc(it);
      const q = Math.max(1, Math.round(num(it.qty, 1)));
      if (verdict(r).key === 'buy') good++;
      if (it.status === 'sold') { soldProfit += r.profit * q; return; }
      active++;
      spend += num(it.buy) * q;
      profit += r.profit * q;
      invested += r.invested * q;
    });
    const plan = num(settings.plan) * (settings.vatRegistered ? 1 : 1.2);
    $('stats').innerHTML = `
      <div class="kpi"><span>Worth buying</span><b>${good} of ${items.length}</b></div>
      <div class="kpi"><span>Stock cost (not sold)</span><b>${money(spend)}</b></div>
      <div class="kpi"><span>Expected profit (not sold)</span><b class="${profit >= 0 ? 'pos' : 'neg'}">${money(profit)}</b></div>
      <div class="kpi"><span>Overall ROI</span><b>${active && invested > 0 ? pct(profit / invested) : '–'}</b></div>
      <div class="kpi"><span>Profit from sold</span><b class="${soldProfit >= 0 ? 'pos' : 'neg'}">${money(soldProfit)}</b></div>
      <div class="kpi"><span>Seller plan per month</span><b>${money(plan)}</b></div>`;
  }

  function persist() { save(KEY_ITEMS, items); renderList(); }

  // ---------- Events ----------
  $('form').addEventListener('input', renderCalc);
  $('form').addEventListener('change', e => {
    if (e.target.id === 'cat') $('vat').value = String(catById($('cat').value).vat);
    if (e.target.id === 'fulfil') syncFulfil();
    renderCalc();
  });
  $('clearBtn').addEventListener('click', e => { e.preventDefault(); resetForm(); });
  $('cancelEdit').addEventListener('click', resetForm);

  $('form').addEventListener('submit', e => {
    e.preventDefault();
    const data = readForm();
    if (!data.name) return;
    if (editingId) {
      const i = items.findIndex(x => x.id === editingId);
      if (i >= 0) items[i] = { ...items[i], ...data };
    } else {
      items.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), status: 'idea', ...data });
    }
    persist();
    resetForm();
  });

  $('tbody').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    const it = items.find(x => x.id === id);
    if (!it) return;
    if (btn.dataset.act === 'del') {
      if (confirm(`Delete "${it.name}"?`)) { items = items.filter(x => x.id !== id); persist(); }
    } else if (btn.dataset.act === 'dup') {
      items.push({ ...it, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), status: 'idea' });
      persist();
    } else if (btn.dataset.act === 'edit') {
      writeForm(it);
      editingId = id;
      $('formTitle').textContent = 'Edit product';
      $('saveBtn').textContent = '💾 Save changes';
      $('cancelEdit').classList.remove('hidden');
      renderCalc();
      $('form').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
  $('tbody').addEventListener('change', e => {
    if (e.target.dataset.act !== 'status') return;
    const it = items.find(x => x.id === e.target.closest('tr').dataset.id);
    if (it) { it.status = e.target.value; persist(); }
  });

  $('filter').addEventListener('change', renderList);
  document.querySelectorAll('#table th[data-sort]').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    sort = sort.key === k ? { key: k, dir: -sort.dir } : { key: k, dir: k === 'name' ? 1 : -1 };
    renderList();
  }));

  // Settings
  const SETTING_INPUTS = { setVat: 'vatRegistered', setFulfil: 'fulfil', setRoi: 'targetRoi', setMinProfit: 'minProfit', setPostage: 'postage', setStorage: 'storage', setPlan: 'plan' };
  Object.entries(SETTING_INPUTS).forEach(([id, key]) => {
    const el = $(id);
    if (el.type === 'checkbox') el.checked = !!settings[key]; else el.value = settings[key];
    el.addEventListener('input', () => {
      settings[key] = el.type === 'checkbox' ? el.checked : (el.tagName === 'SELECT' ? el.value : num(el.value));
      save(KEY_SETTINGS, settings);
      renderCalc();
      renderList();
    });
  });
  $('settingsBtn').addEventListener('click', () => $('settingsCard').classList.toggle('hidden'));

  // ---------- CSV ----------
  const CSV_COLS = ['name', 'store', 'buy', 'qty', 'sell', 'cat', 'vat', 'fulfil', 'tier', 'inbound', 'prep', 'refOverride', 'fulfilOverride', 'status', 'notes'];
  const csvCell = v => {
    let s = String(v ?? '');
    if (/^[=+\-@]/.test(s) && isNaN(Number(s))) s = "'" + s; // stop spreadsheet formula injection
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  $('exportBtn').addEventListener('click', () => {
    const head = [...CSV_COLS, 'profit_each', 'roi_pct'];
    const lines = [head.join(',')].concat(items.map(it => {
      const r = calc(it);
      return [...CSV_COLS.map(c => csvCell(it[c])), r.profit.toFixed(2), Number.isFinite(r.roi) ? Math.round(r.roi * 100) : ''].join(',');
    }));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `resell-products-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  function parseCsv(text) {
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') q = false;
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(x => x.trim() !== ''));
  }

  $('importFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const rows = parseCsv(await file.text());
    if (rows.length < 2) { alert('That CSV has no products in it.'); return; }
    const head = rows[0].map(h => h.trim());
    if (!head.includes('name')) { alert('The CSV needs a "name" column. Export one from here to see the format.'); return; }
    let added = 0;
    rows.slice(1).forEach(r => {
      const o = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), status: 'idea', store: 'other', cat: 'other', vat: '0.2', fulfil: settings.fulfil, tier: 'parcel-400', qty: '1', inbound: '0.30', prep: '0.10', refOverride: '', fulfilOverride: '', notes: '' };
      head.forEach((h, i) => { if (CSV_COLS.includes(h)) o[h] = (r[i] ?? '').replace(/^'(?=[=+\-@])/, ''); });
      if (!STATUSES.includes(o.status)) o.status = 'idea';
      if (o.name && o.name.trim()) { items.push(o); added++; }
    });
    persist();
    alert(`Imported ${added} product${added === 1 ? '' : 's'}.`);
  });

  // ---------- Start ----------
  resetForm();
  renderList();
})();
