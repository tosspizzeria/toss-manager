// Twelve-month trend. The spreadsheet made this impossible — each month was a
// separate file — so this is the one view with no counterpart on the old sheet.

import { el, clear, fmt0, fmtSigned, monthLabel, monthRange, shiftMonth, monthOf, todayISO } from '../util.js';
import { store } from '../store.js';
import { rollup } from '../calc.js';

export async function renderReports(ctx) {
  const root = clear(ctx.root);
  root.append(el('div.spinner'));

  const thisMonth = monthOf(todayISO());
  const months = Array.from({ length: 12 }, (_, i) => shiftMonth(thisMonth, -(11 - i)));
  const start = monthRange(months[0]).start;
  const end = monthRange(months[11]).end;

  const sheets = await store().listDays(start, end);
  const config = {
    denominations: ctx.settings.denominations,
    payoutLines: ctx.settings.payout_lines,
    tipMinimumHourly: ctx.settings.tip_minimum_hourly,
  };

  const rows = months.map((ym) => ({
    ym,
    totals: rollup(sheets.filter((s) => s.business_date.startsWith(ym)), config),
  })).filter((r) => r.totals.dayCount > 0);

  const overall = rollup(sheets, config);
  const peak = Math.max(1, ...rows.map((r) => r.totals.netSales));

  const body = el('tbody');
  for (const { ym, totals } of rows) {
    const balanced = Math.abs(totals.netOverShort) < 0.005;
    body.append(el('tr', {},
      el('td', el('a', { href: `#/month/${ym}`, style: 'color:inherit;font-weight:600' }, monthLabel(ym))),
      el('td.num', String(totals.dayCount)),
      el('td', {},
        el('div', { style: 'display:flex;align-items:center;gap:8px' },
          el('div', { style: `height:9px;border-radius:3px;background:var(--tomato);width:${Math.round((totals.netSales / peak) * 100)}%;min-width:2px` }),
          el('span', { style: 'font-family:var(--mono);white-space:nowrap' }, fmt0(totals.netSales)))),
      el('td.num', fmt0(totals.avgNetSales)),
      el('td.num', totals.avgLaborPct === null ? '—' : `${totals.avgLaborPct}%`),
      el('td.num', fmt0(totals.guaranteedTotal)),
      el('td.num', totals.houseTopUp > 0 ? fmt0(totals.houseTopUp) : '—'),
      el('td.num', fmt0(totals.totalPickups)),
      el(`td.num${balanced ? '' : '.short'}`, totals.countedDays ? fmtSigned(totals.netOverShort) : '—')));
  }
  if (!rows.length) {
    body.append(el('tr', {}, el('td', { colSpan: 9 },
      el('p.hint', 'Nothing to report yet — sheets will show up here as they are filled in.'))));
  }

  const tile = (k, v, n, cls) => el(`div.tile${cls ? `.${cls}` : ''}`, {},
    el('div.k', k), el('div.v', v), n ? el('div.n', n) : null);

  clear(root);
  root.append(
    el('div.cal-head', {}, el('h1', 'Last 12 months')),
    el('div.card', {},
      el('div.card-head', {}, el('h2', 'Totals across every sheet on record'), el('span.spacer'),
        el('span.progress', `${overall.dayCount} nights`)),
      el('div.card-body.tight', {}, el('div.tiles', {},
        tile('Net sales', fmt0(overall.netSales), `avg ${fmt0(overall.avgNetSales)} a night`),
        tile('Tips to payroll', fmt0(overall.guaranteedTotal),
          overall.houseTopUp > 0
            ? `${fmt0(overall.totalTips)} pooled + ${fmt0(overall.houseTopUp)} top-up`
            : 'all from the pool'),
        tile('To the bank', fmt0(overall.totalPickups), 'cash pickups'),
        tile('Net over / short', overall.countedDays ? fmtSigned(overall.netOverShort) : '—',
          `${overall.shortDays} short · ${overall.overDays} over`,
          !overall.countedDays ? '' : Math.abs(overall.netOverShort) < 0.005 ? 'ok' : overall.netOverShort < 0 ? 'bad' : 'warn'),
        tile('Avg labor', overall.avgLaborPct === null ? '—' : `${overall.avgLaborPct}%`, 'from Toast')))),
    el('div.card', {},
      el('div.card-head', {}, el('h2', 'By month')),
      el('div.card-body.tight', {}, el('div.table-scroll', {},
        el('table.tip-table', {},
          el('thead', {}, el('tr', {},
            el('th', 'Month'), el('th', 'Nights'), el('th', 'Net sales'), el('th', 'Avg / night'),
            el('th', 'Avg labor'), el('th', 'Tips'), el('th', 'Top-up'), el('th', 'To bank'), el('th', 'Over / short'))),
          body)))),
  );
}
