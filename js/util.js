// Small shared helpers: dates as plain YYYY-MM-DD strings (never Date objects
// crossing a timezone and landing on the wrong business day), money display,
// and terse DOM construction.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pad(n) { return String(n).padStart(2, '0'); }

/** Parse YYYY-MM-DD into local calendar parts without timezone drift. */
export function parts(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return { y, m, d, weekday: new Date(y, m - 1, d).getDay() };
}

export function shiftDate(iso, days) {
  const { y, m, d } = parts(iso);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

export function ordinal(n) {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** "Saturday August 22nd 2026" — the same phrasing the sheet's DATE row used. */
export function longDate(iso) {
  const { y, m, d, weekday } = parts(iso);
  return `${DAYS[weekday]} ${MONTHS[m - 1]} ${ordinal(d)} ${y}`;
}

export function shortDate(iso) {
  const { m, d } = parts(iso);
  return `${m}.${d}`;
}

export function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

export function monthOf(iso) { return iso.slice(0, 7); }

export function shiftMonth(ym, months) {
  const [y, m] = ym.split('-').map(Number);
  const dt = new Date(y, m - 1 + months, 1);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}`;
}

export function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return { start: `${ym}-01`, end: `${ym}-${pad(last)}`, days: last, firstWeekday: new Date(y, m - 1, 1).getDay() };
}

/** Monday of the week containing `iso` — the Tip Tracker's week boundary. */
export function mondayOf(iso) {
  const { weekday } = parts(iso);
  return shiftDate(iso, weekday === 0 ? -6 : 1 - weekday);
}

export function weekDates(mondayISO) {
  return Array.from({ length: 7 }, (_, i) => shiftDate(mondayISO, i));
}

export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * Turn whatever a manager types in the search box into a date. Accepts
 * 2026-08-22, 8/22, 8/22/26, 8.22, "aug 22", "yesterday", "today". Returns
 * null if it cannot tell, so the caller can say so instead of guessing.
 */
export function parseDateQuery(text, today = todayISO()) {
  const q = String(text ?? '').trim().toLowerCase();
  if (!q) return null;
  if (q === 'today') return today;
  if (q === 'yesterday') return shiftDate(today, -1);
  if (q === 'tomorrow') return shiftDate(today, 1);

  const iso = q.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return `${iso[1]}-${pad(+iso[2])}-${pad(+iso[3])}`;

  const slash = q.match(/^(\d{1,2})[/.\-](\d{1,2})(?:[/.\-](\d{2,4}))?$/);
  if (slash) {
    const year = slash[3] ? (slash[3].length === 2 ? 2000 + +slash[3] : +slash[3]) : parts(today).y;
    return `${year}-${pad(+slash[1])}-${pad(+slash[2])}`;
  }

  const named = q.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:\w{0,2})?(?:,?\s*(\d{4}))?$/);
  if (named) {
    const idx = MONTHS.findIndex((m) => m.toLowerCase().startsWith(named[1].slice(0, 3)));
    if (idx >= 0) return `${named[3] ? +named[3] : parts(today).y}-${pad(idx + 1)}-${pad(+named[2])}`;
  }
  return null;
}

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function fmt(value) { return USD.format(Number(value) || 0); }
export function fmt0(value) { return USD0.format(Number(value) || 0); }
export function fmtSigned(value) {
  const n = Number(value) || 0;
  return `${n < 0 ? '−' : n > 0 ? '+' : ''}${USD.format(Math.abs(n))}`;
}

/** el('div.card', { onclick }, 'text', childNode) */
export function el(spec, attrs, ...children) {
  const [tag, ...classes] = String(spec).split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node)) {
    children.unshift(attrs);
  } else if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'class') node.className += ` ${v}`;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k in node && k !== 'list' && k !== 'form') node[k] = v;
      else node.setAttribute(k, v);
    }
  }
  for (const child of children.flat(3)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

/** SHA-256 hex — used for manager PINs so a raw PIN never hits the database. */
export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function debounce(fn, ms) {
  let timer = null;
  let lastArgs = [];
  const wrapped = (...args) => {
    lastArgs = args;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...lastArgs); }, ms);
  };
  /** Run the pending call now. Returns false when there was nothing waiting. */
  wrapped.flush = () => {
    if (timer === null) return false;
    clearTimeout(timer);
    timer = null;
    fn(...lastArgs);
    return true;
  };
  wrapped.cancel = () => { clearTimeout(timer); timer = null; };
  wrapped.pending = () => timer !== null;
  return wrapped;
}

export function uuid() {
  return crypto.randomUUID ? crypto.randomUUID()
    : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
