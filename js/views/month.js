// Month view: the calendar that replaces one file per month and one tab per
// day. Every cell shows the two numbers you actually scan for — net sales and
// over/short — plus a flag when a night was left unfinished.

import { el, clear, fmt, fmt0, fmtSigned, monthLabel, monthRange, shiftMonth, shiftDate, todayISO, monthOf } from '../util.js';
import { store } from '../store.js';
import { summarize, rollup, checklistProgress } from '../calc.js';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export async function renderMonth(ctx, ym) {
  const root = clear(ctx.root);
  root.append(el('div.spinner'));

  const { start, end, days, firstWeekday } = monthRange(ym);
  const sheets = await store().listDays(start, end);
  const byDate = new Map(sheets.map((s) => [s.business_date, s]));

  const config = {
    denominations: ctx.settings.denominations,
    payoutLines: ctx.settings.payout_lines,
    tipMinimumHourly: ctx.settings.tip_minimum_hourly,
  };
  const totals = rollup(sheets, config);

  const grid = el('div.cal-grid');
  for (const d of DOW) grid.append(el('div.cal-dow', d));
  for (let i = 0; i < firstWeekday; i++) grid.append(el('div.cal-cell.empty'));

  for (let day = 1; day <= days; day++) {
    const date = `${ym}-${String(day).padStart(2, '0')}`;
    const sheet = byDate.get(date);
    const cell = el(`a.cal-cell${date === todayISO() ? '.today' : ''}`, { href: `#/day/${date}` },
      el('div.dnum', String(day)));

    if (!sheet) {
      cell.append(el('div.nosheet', date <= todayISO() ? 'no sheet' : ''));
      grid.append(cell);
      continue;
    }

    const calc = summarize(sheet, config);
    cell.append(el('div.sales', calc.netSales === null ? '—' : fmt0(calc.netSales)));

    if (calc.cash.closeCounted) {
      const balanced = Math.abs(calc.cash.overShort) < 0.005;
      cell.append(el(`div.os.${balanced ? 'ok' : 'bad'}`,
        balanced ? 'balanced' : fmtSigned(calc.cash.overShort)));
    }

    const openLeft = checklistProgress(ctx.checklist.open, sheet.open_checklist);
    const closeLeft = checklistProgress(ctx.checklist.close, sheet.close_checklist);
    const flags = [];
    if (sheet.status !== 'closed') flags.push('open');
    if (!calc.cash.closeCounted) flags.push('no close count');
    else if (!openLeft.complete || !closeLeft.complete) flags.push('checklist');
    if (flags.length) cell.append(el('div.flag', flags.join(' · ')));

    grid.append(cell);
  }

  // Pad the final week so the grid ends on a clean row.
  const trailing = (7 - ((firstWeekday + days) % 7)) % 7;
  for (let i = 0; i < trailing; i++) grid.append(el('div.cal-cell.empty'));

  const navBtn = (label, target) => {
    const b = el('button.btn.btn-sm', { type: 'button' }, label);
    b.addEventListener('click', () => { location.hash = `#/month/${target}`; });
    return b;
  };

  const monthInput = el('input.date-input', { type: 'month', value: ym });
  monthInput.addEventListener('change', () => { if (monthInput.value) location.hash = `#/month/${monthInput.value}`; });

  const tile = (k, v, n, cls) => el(`div.tile${cls ? `.${cls}` : ''}`, {},
    el('div.k', k), el('div.v', v), n ? el('div.n', n) : null);

  clear(root);
  root.append(
    el('div.cal-head', {},
      navBtn('←', shiftMonth(ym, -1)),
      monthInput,
      navBtn('→', shiftMonth(ym, 1)),
      el('h1', monthLabel(ym)),
      el('span.spacer', { style: 'flex:1' }),
      ym === monthOf(todayISO()) ? null : navBtn('This month', monthOf(todayISO())),
      el('a.btn.btn-sm.btn-primary', { href: `#/day/${todayISO()}` }, 'Today’s sheet')),

    el('div.card', {},
      el('div.card-head', {}, el('h2', 'At a glance'), el('span.spacer'),
        el('span.progress', `${totals.dayCount} ${totals.dayCount === 1 ? 'sheet' : 'sheets'}`)),
      el('div.card-body.tight', {}, el('div.tiles', {},
        tile('Net sales', fmt0(totals.netSales),
          totals.netSalesDelivery > 0
            ? `${fmt0(totals.netSalesDelivery)} of it delivery`
            : `avg ${fmt0(totals.avgNetSales)} a day`),
        tile('Best day', totals.bestDay ? fmt0(totals.bestDay.calc.netSales) : '—',
          totals.bestDay ? totals.bestDay.sheet.business_date.slice(5).replace('-', '/') : null),
        tile('Tips to payroll', fmt0(totals.guaranteedTotal),
          totals.houseTopUp > 0
            ? `${fmt0(totals.totalTips)} pooled + ${fmt0(totals.houseTopUp)} top-up`
            : 'all from the pool'),
        tile('Cash to bank', fmt0(totals.totalPickups), 'pickups for deposit'),
        tile('Net over / short', totals.countedDays ? fmtSigned(totals.netOverShort) : '—',
          `${totals.shortDays} short · ${totals.overDays} over`,
          !totals.countedDays ? '' : Math.abs(totals.netOverShort) < 0.005 ? 'ok' : totals.netOverShort < 0 ? 'bad' : 'warn'),
        tile('Avg labor', totals.avgLaborPct === null ? '—' : `${totals.avgLaborPct}%`, 'from Toast')))),

    el('div.card', {},
      el('div.card-head', {}, el('h2', 'Calendar'), el('span.spacer'),
        el('span.progress', 'net sales · over/short')),
      el('div.card-body', {}, grid)),
  );
}

/** The "where do I even start" landing screen. */
export async function renderHome(ctx) {
  const root = clear(ctx.root);
  root.append(el('div.spinner'));

  const recent = await store().recentDays(10);
  const today = todayISO();
  const hasToday = recent.some((s) => s.business_date === today);

  const config = {
    denominations: ctx.settings.denominations,
    payoutLines: ctx.settings.payout_lines,
    tipMinimumHourly: ctx.settings.tip_minimum_hourly,
  };

  const list = el('ul.rowlist');
  for (const sheet of recent) {
    const calc = summarize(sheet, config);
    const balanced = Math.abs(calc.cash.overShort) < 0.005;
    list.append(el('li', {},
      el('a.grow', { href: `#/day/${sheet.business_date}`, style: 'text-decoration:none;color:inherit' },
        el('div.nm', sheet.business_date),
        el('div.meta', [
          sheet.manager_name || 'no manager',
          calc.netSales === null ? 'no sales entered' : `${fmt(calc.netSales)} net sales`,
          calc.cash.closeCounted ? (balanced ? 'balanced' : `${fmtSigned(calc.cash.overShort)}`) : 'no closing count',
        ].join(' · '))),
      el(`span.tag${sheet.status === 'closed' ? '' : '.admin'}`, sheet.status === 'closed' ? 'closed out' : 'open')));
  }
  if (!recent.length) {
    list.append(el('li', {}, el('p.hint', 'No sheets yet. Start with tonight.')));
  }

  clear(root);
  root.append(
    el('div.daybar', {},
      el('h1', hasToday ? 'Tonight’s sheet is started' : 'Nothing entered for today yet'),
      el('span.spacer'),
      el('a.btn.btn-primary', { href: `#/day/${today}` }, hasToday ? 'Open today’s sheet' : 'Start today’s sheet'),
      el('a.btn', { href: `#/day/${shiftDate(today, -1)}` }, 'Yesterday'),
      el('a.btn', { href: `#/month/${monthOf(today)}` }, 'Month view')),
    el('div.card', {},
      el('div.card-head', {}, el('h2', 'Recent nights')),
      el('div.card-body.tight', {}, list)),
  );
}
