// App shell: hash router, the PIN gate, and the search box that replaces
// hunting for the right tab.
//
// Routes
//   #/                    recent nights
//   #/day/YYYY-MM-DD      one night's manager sheet
//   #/month/YYYY-MM       calendar + month rollup
//   #/payroll/YYYY-MM-DD  tip tracker for the week containing that date
//   #/reports             twelve-month trend
//   #/staff               roster
//   #/settings            managers, checklists, numbers, connection

import { el, clear, todayISO, monthOf, mondayOf, parseDateQuery } from './util.js';
import { initStore, store, isCloud, getConnection, clearConnection, SETTINGS_SEED } from './store.js';
import {
  currentManager, clearShift, signInManager, isSignedIn, createManager,
  signInWithGoogle, completeGoogleSignIn,
} from './auth.js';
import { ALLOWED_DOMAIN } from './config.js';

let signInProblem = null;   // shown on the Google gate after a failed return trip
import { renderDay } from './views/day.js';
import { renderMonth, renderHome } from './views/month.js';
import { renderPayroll } from './views/payroll.js';
import { renderReports } from './views/reports.js';
import { renderRoster } from './views/roster.js';
import { renderSettings } from './views/settings.js';

const shell = document.getElementById('shell');
const view = document.getElementById('view');

const ctx = {
  root: view,
  settings: { ...SETTINGS_SEED },
  staff: [],
  managers: [],
  checklist: { open: [], close: [] },
  manager: null,
  reloadRefs,
};

/** Reload the reference data every view leans on. */
async function reloadRefs() {
  const [settings, staff, managers, checklist] = await Promise.all([
    store().getSettings(),
    store().listStaff(),
    store().listManagers(),
    store().listChecklist(),
  ]);
  ctx.settings = { ...SETTINGS_SEED, ...settings };
  ctx.staff = staff;
  ctx.managers = managers;
  ctx.checklist = {
    open: checklist.filter((i) => i.phase === 'open'),
    close: checklist.filter((i) => i.phase === 'close'),
  };
  ctx.manager = currentManager();
  renderChrome();
}

// ---------------------------------------------------------------------- chrome
function renderChrome() {
  const bar = document.getElementById('topbar-inner');
  clear(bar);

  const hash = location.hash || '#/';
  const link = (href, label, match) => el('a', {
    href,
    class: hash === href || (match && hash.startsWith(match)) ? 'active' : '',
  }, label);

  const search = el('input', {
    type: 'search',
    placeholder: 'Jump to a date — 8/22, aug 22, yesterday',
    style: 'border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.08);color:#fff;border-radius:999px;padding:7px 14px;min-width:210px;font-size:14px',
  });
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const date = parseDateQuery(search.value);
    if (!date) {
      search.style.borderColor = '#ef7b6f';
      setTimeout(() => { search.style.borderColor = 'rgba(255,255,255,.22)'; }, 1200);
      return;
    }
    search.value = '';
    search.blur();
    location.hash = `#/day/${date}`;
  });

  bar.append(
    el('div.brand', {},
      el('span.brand-mark', 'TOSS'),
      el('span.brand-sub', `${ctx.settings.location_name ?? 'South 1st'} · Manager Sheet`)),
    el('nav.nav', {},
      link(`#/day/${todayISO()}`, 'Tonight', '#/day/'),
      link(`#/month/${monthOf(todayISO())}`, 'Calendar', '#/month/'),
      link(`#/payroll/${mondayOf(todayISO())}`, 'Tip Tracker', '#/payroll/'),
      link('#/reports', 'Reports'),
      link('#/staff', 'Staff'),
      link('#/settings', 'Settings')),
    search,
    el('div.whoami', {},
      ctx.manager ? el('span.chip', ctx.manager.initials) : null,
      ctx.manager ? el('span', ctx.manager.name) : el('span', 'not signed in'),
      (() => {
        const b = el('button', { type: 'button' }, ctx.manager ? 'Switch' : 'Sign in');
        b.addEventListener('click', () => { clearShift(); ctx.manager = null; route(); });
        return b;
      })()),
  );
}

// ------------------------------------------------------------------- PIN gate
function gate(title, body, hint) {
  clear(view).append(el('div.gate', {}, el('div.card', {},
    el('div.card-body', {}, el('h1', title), hint ? el('p', hint) : null, body))));
}

async function firstRunGate() {
  const name = el('input', { placeholder: 'Your full name' });
  const initials = el('input', { placeholder: 'initials', maxLength: 4, style: 'font-family:var(--mono)' });
  const pin = el('input', { class: 'pin-input', inputMode: 'numeric', maxLength: 4, placeholder: '····' });
  const err = el('p.err');
  const go = el('button.btn.btn-primary', { type: 'button', style: 'width:100%;margin-top:14px' }, 'Create my login');

  name.addEventListener('input', () => {
    if (!initials.dataset.touched) {
      initials.value = name.value.trim().split(/\s+/).map((w) => w[0] ?? '').join('').toLowerCase().slice(0, 3);
    }
  });
  initials.addEventListener('input', () => { initials.dataset.touched = '1'; });

  go.addEventListener('click', async () => {
    if (!name.value.trim()) { err.textContent = 'Name required.'; return; }
    if (!initials.value.trim()) { err.textContent = 'Initials required.'; return; }
    if (!/^\d{4}$/.test(pin.value.trim())) { err.textContent = 'PIN must be four digits.'; return; }
    go.disabled = true;
    try {
      const created = await createManager({
        name: name.value, initials: initials.value, pin: pin.value.trim(), isAdmin: true,
      });
      // Straight onto shift — no point asking for the PIN they just chose.
      await signInManager(created, pin.value.trim());
      await reloadRefs();
      route();
    } catch (e) { err.textContent = e.message; go.disabled = false; }
  });

  gate('Set up the first manager',
    el('div', {},
      el('div.field', {}, el('label', 'Name'), name),
      el('div.field', {}, el('label', 'Initials'), initials),
      el('div.field', {}, el('label', '4-digit PIN'), pin),
      err, go,
      el('p.hint', { style: 'margin-top:14px' }, 'You will be the admin — you can add the rest of the managers under Settings.')),
    'Nobody can sign in yet. Start with yourself.');
}

async function pinGate() {
  const active = ctx.managers.filter((m) => m.active);
  if (!active.length) return firstRunGate();

  const tiles = el('div.mgr-tiles');
  for (const m of active) {
    const t = el('div.mgr-tile', { role: 'button', tabIndex: 0 },
      el('div.nm', m.name), el('div.in', m.initials));
    const open = () => pinEntry(m);
    t.addEventListener('click', open);
    t.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    tiles.append(t);
  }
  gate('Who is on tonight?', tiles);
}

function pinEntry(manager) {
  const pin = el('input', { class: 'pin-input', inputMode: 'numeric', maxLength: 4, placeholder: '····', autofocus: true });
  const err = el('p.err');
  const back = el('button.btn', { type: 'button', style: 'margin-top:12px' }, '← Someone else');
  back.addEventListener('click', pinGate);

  const attempt = async () => {
    if (pin.value.length < 4) return;
    if (await signInManager(manager, pin.value)) {
      ctx.manager = currentManager();
      renderChrome();
      route();
    } else {
      err.textContent = 'That PIN does not match.';
      pin.value = '';
    }
  };
  pin.addEventListener('input', () => { err.textContent = ''; if (pin.value.length === 4) attempt(); });
  pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') attempt(); });

  gate(manager.name, el('div', {}, pin, err, back), 'Enter your 4-digit PIN.');
  pin.focus();
}

async function googleGate() {
  const err = el('p.err', signInProblem ?? '');
  const go = el('button.btn.btn-primary', { type: 'button', style: 'width:100%;margin-top:6px' }, 'Sign in with Google');
  go.addEventListener('click', async () => {
    go.disabled = true;
    try { await signInWithGoogle(); }
    catch (e) { err.textContent = e.message; go.disabled = false; }
  });
  // A connection typed in on this device (rather than built into the site)
  // could be wrong; give a way back out rather than a dead end.
  let escape = null;
  if (!getConnection()?.builtIn) {
    escape = el('button.btn.btn-sm', { type: 'button', style: 'margin-top:10px' }, 'Disconnect this device from the database');
    escape.addEventListener('click', () => {
      if (!confirm('Disconnect this device? Nothing in the database is deleted.')) return;
      clearConnection();
      location.reload();
    });
  }
  gate('Sign in',
    el('div', {}, go, err, escape,
      el('p.hint', { style: 'margin-top:14px' },
        `Use your @${ALLOWED_DOMAIN} Google account. You stay signed in on this device.`)),
    'Toss managers only.');
}

// ----------------------------------------------------------------------- router
async function route() {
  const hash = (location.hash || '#/').replace(/^#/, '');
  const [, section, param] = hash.split('/');

  renderChrome();

  const signedIn = !isCloud() || (await isSignedIn());
  if (!signedIn) return googleGate();

  // Settings stays reachable before a PIN — it is where the connection lives.
  if (section === 'settings') return renderSettings(ctx);
  if (!ctx.manager) return pinGate();

  try {
    switch (section) {
      case 'day':      return await renderDay(ctx, param || todayISO());
      case 'month':    return await renderMonth(ctx, param || monthOf(todayISO()));
      case 'payroll':  return await renderPayroll(ctx, param || todayISO());
      case 'reports':  return await renderReports(ctx);
      case 'staff':    return await renderRoster(ctx);
      default:         return await renderHome(ctx);
    }
  } catch (err) {
    clear(view).append(el('div.banner.banner-bad', {},
      el('span', `Could not load that: ${err.message}`)));
  }
}

// ------------------------------------------------------------------------- boot
(async function boot() {
  try {
    await initStore();
    const back = await completeGoogleSignIn();
    if (back && !back.ok) signInProblem = back.message;
    if (!isCloud() || (await isSignedIn())) await reloadRefs();
  } catch (err) {
    clear(view).append(el('div.banner.banner-bad', {},
      el('span', `Could not reach the database: ${err.message}`),
      el('a', { href: '#/settings' }, 'Check the connection')));
    renderChrome();
  }
  window.addEventListener('hashchange', route);
  route();
})();
