// The Tip Tracker tab, rebuilt as a derived view.
//
// On the spreadsheet this was a second place to type numbers, which means a
// second place for them to be wrong. Here the grid is *read* out of the day
// sheets. Nothing to key in, nothing to reconcile. The only thing stored is the
// "Payroll Done" flag.
//
// The figure in each cell is the $20/hr guaranteed amount — max(pool share,
// hours x $20) — not the raw pool share, because that is what actually gets
// paid. On 63 of the 83 staff-nights in August 2026 those two differ. All 83
// reproduce the old Tip Tracker tab exactly; see test/tip-tracker-parity.test.mjs.

import { el, clear, fmt, fmt0, shortDate, longDate, mondayOf, weekDates, shiftDate, todayISO, WEEKDAY_NAMES } from '../util.js';
import { store } from '../store.js';
import { calcTips } from '../calc.js';
import { currentManager } from '../auth.js';

export async function renderPayroll(ctx, weekStartParam) {
  const root = clear(ctx.root);
  root.append(el('div.spinner'));

  const weekStart = mondayOf(weekStartParam || todayISO());
  const dates = weekDates(weekStart);

  const [sheets, week] = await Promise.all([
    store().listDays(dates[0], dates[6]),
    store().getPayrollWeek(weekStart),
  ]);

  const config = {
    denominations: ctx.settings.denominations,
    payoutLines: ctx.settings.payout_lines,
    tipMinimumHourly: ctx.settings.tip_minimum_hourly,
  };

  // date -> (staff key -> { payout, hours, name })
  const byDate = new Map();
  const seen = new Map();   // staff key -> display name
  for (const sheet of sheets) {
    const tips = calcTips(sheet, config);
    const row = new Map();
    for (const r of tips.rows) {
      const key = r.staff_id ?? `name:${(r.name ?? '').trim().toLowerCase()}`;
      if (!key || key === 'name:') continue;
      const prev = row.get(key);
      row.set(key, {
        payroll: (prev?.payroll ?? 0) + r.guaranteed,
        share: (prev?.share ?? 0) + r.payout,
        topUp: (prev?.topUp ?? 0) + r.shortfall,
        hours: (prev?.hours ?? 0) + r.hours,
        name: r.name || '(unnamed)',
      });
      seen.set(key, r.name || '(unnamed)');
    }
    byDate.set(sheet.business_date, row);
  }

  // Everyone on the pool roster shows every week, even at $0 — the tracker had
  // a zero row for anyone who did not work, and payroll wants to see it.
  const roster = ctx.staff.filter((s) => s.active && s.in_tip_pool);
  const rows = [
    ...roster.map((s) => ({ key: s.id, name: s.name, color: s.color ?? '#c8352b', onRoster: true })),
    ...[...seen.entries()]
      .filter(([key]) => !roster.some((s) => s.id === key))
      .map(([key, name]) => ({ key, name, color: '#8a8177', onRoster: false })),
  ].sort((a, b) => a.name.localeCompare(b.name));

  const cellFor = (key, date) => byDate.get(date)?.get(key) ?? null;
  const weekTotal = (key) => dates.reduce((sum, d) => sum + (cellFor(key, d)?.payroll ?? 0), 0);
  const weekTopUp = (key) => dates.reduce((sum, d) => sum + (cellFor(key, d)?.topUp ?? 0), 0);
  const weekHours = (key) => dates.reduce((sum, d) => sum + (cellFor(key, d)?.hours ?? 0), 0);
  const dayTotal = (date) => rows.reduce((sum, r) => sum + (cellFor(r.key, date)?.payroll ?? 0), 0);
  const grandTotal = rows.reduce((sum, r) => sum + weekTotal(r.key), 0);
  const grandTopUp = rows.reduce((sum, r) => sum + weekTopUp(r.key), 0);

  // ------------------------------------------------------------------- table
  const head = el('tr', {}, el('th', 'Staff'));
  for (let i = 0; i < 7; i++) {
    head.append(el('th', {},
      el('div', WEEKDAY_NAMES[i].slice(0, 3)),
      el('div', { style: 'font-weight:400;text-transform:none;letter-spacing:0' }, shortDate(dates[i]))));
  }
  head.append(el('th', 'Week total'), el('th', 'Hours'), el('th', 'Of which top-up'));

  const body = el('tbody');
  for (const r of rows) {
    const tr = el('tr', {},
      el('td', {},
        el('span', { style: `display:inline-block;width:10px;height:10px;border-radius:3px;background:${r.color};margin-right:8px` }),
        el('span', { style: 'font-weight:600' }, r.name),
        r.onRoster ? null : el('span.tag.off', { style: 'margin-left:8px' }, 'off roster')));
    for (const date of dates) {
      const cell = cellFor(r.key, date);
      tr.append(el('td.num', cell && cell.payroll > 0
        ? el('a', {
            href: `#/day/${date}`,
            style: 'color:inherit;text-decoration:none',
            title: cell.topUp > 0
              ? `${fmt(cell.share)} share + ${fmt(cell.topUp)} top-up to reach the guarantee`
              : `${fmt(cell.share)} pool share, already above the guarantee`,
          }, fmt0(cell.payroll))
        : el('span', { style: 'color:var(--text-faint)' }, '—')));
    }
    const total = weekTotal(r.key);
    const topUp = weekTopUp(r.key);
    tr.append(
      el('td.num', { style: 'font-weight:800' }, fmt(total)),
      el('td.num', { style: 'color:var(--text-dim)' }, weekHours(r.key) ? `${Math.round(weekHours(r.key) * 100) / 100}` : '—'),
      el(`td.num${topUp > 0 ? '.short' : ''}`, topUp > 0 ? fmt(topUp) : '—'));
    body.append(tr);
  }
  if (!rows.length) {
    body.append(el('tr', {}, el('td', { colSpan: 11 },
      el('p.hint', 'Nobody on the tip roster yet — add staff under Staff.'))));
  }

  const foot = el('tfoot', {}, el('tr', {},
    el('td', 'Daily totals'),
    ...dates.map((d) => el('td.num', dayTotal(d) ? fmt0(dayTotal(d)) : '—')),
    el('td.num', fmt(grandTotal)),
    el('td', ''),
    el('td.num', grandTopUp > 0 ? fmt(grandTopUp) : '—')));

  // --------------------------------------------------------- payroll done flag
  const doneState = { ...(week ?? { week_start: weekStart, done: false }) };
  const doneLabel = el('span.progress');
  const doneBtn = el('button.btn', { type: 'button' });

  const paintDone = () => {
    doneBtn.textContent = doneState.done ? 'Mark payroll not done' : 'Mark payroll done';
    doneBtn.className = doneState.done ? 'btn' : 'btn btn-primary';
    doneLabel.textContent = doneState.done
      ? `Payroll done${doneState.done_by ? ` by ${doneState.done_by}` : ''}${doneState.done_at ? ` · ${doneState.done_at.slice(0, 10)}` : ''}`
      : 'Payroll not entered yet';
  };

  doneBtn.addEventListener('click', async () => {
    const me = currentManager();
    doneState.done = !doneState.done;
    doneState.done_by = doneState.done ? (me?.name ?? null) : null;
    doneState.done_at = doneState.done ? new Date().toISOString() : null;
    doneBtn.disabled = true;
    try {
      await store().savePayrollWeek({
        week_start: weekStart,
        done: doneState.done,
        done_by: doneState.done_by,
        done_at: doneState.done_at,
        note: doneState.note ?? null,
      });
    } catch (err) {
      doneLabel.textContent = `Could not save — ${err.message}`;
    }
    doneBtn.disabled = false;
    paintDone();
  });
  paintDone();

  // --------------------------------------------------------------- csv export
  const csvBtn = el('button.btn.btn-sm', { type: 'button' }, 'Copy for payroll');
  const csvNote = el('span.progress');
  csvBtn.addEventListener('click', async () => {
    const lines = [['Staff', ...dates.map((d) => shortDate(d)), 'Week total', 'Hours', 'Of which top-up'].join(',')];
    for (const r of rows) {
      lines.push([
        `"${r.name.replace(/"/g, '""')}"`,
        ...dates.map((d) => (cellFor(r.key, d)?.payroll ?? 0).toFixed(2)),
        weekTotal(r.key).toFixed(2),
        (Math.round(weekHours(r.key) * 100) / 100).toString(),
        weekTopUp(r.key).toFixed(2),
      ].join(','));
    }
    const csv = lines.join('\n');
    try {
      await navigator.clipboard.writeText(csv);
      csvNote.textContent = 'Copied to the clipboard';
    } catch {
      csvNote.textContent = 'Clipboard blocked — select the table and copy';
    }
    setTimeout(() => { csvNote.textContent = ''; }, 4000);
  });

  const navBtn = (label, target) => {
    const b = el('button.btn.btn-sm', { type: 'button' }, label);
    b.addEventListener('click', () => { location.hash = `#/payroll/${target}`; });
    return b;
  };
  const weekInput = el('input.date-input', { type: 'date', value: weekStart });
  weekInput.addEventListener('change', () => {
    if (weekInput.value) location.hash = `#/payroll/${mondayOf(weekInput.value)}`;
  });

  const missing = dates.filter((d) => d <= todayISO() && !sheets.some((s) => s.business_date === d));

  clear(root);
  root.append(
    el('div.cal-head', {},
      navBtn('←', shiftDate(weekStart, -7)),
      weekInput,
      navBtn('→', shiftDate(weekStart, 7)),
      el('h1', `Week of ${longDate(weekStart)}`),
      el('span.spacer', { style: 'flex:1' }),
      weekStart === mondayOf(todayISO()) ? null : navBtn('This week', mondayOf(todayISO()))),

    missing.length
      ? el('div.banner.banner-info', {},
        el('span', `No sheet yet for ${missing.map(shortDate).join(', ')} — those nights count as $0 until they are filled in.`))
      : '',

    el('div.card', {},
      el('div.card-head', {}, el('h2', 'Tip tracker'), el('span.spacer'),
        csvNote, csvBtn, doneLabel, doneBtn),
      el('div.card-body', {},
        el('p.hint', `Read straight from the nightly sheets, so there is nothing to key in twice. Each figure is what payroll owes that night: the pool share, or the ${fmt(ctx.settings.tip_minimum_hourly)}/hr guarantee where the share fell below it. Hover a figure for the split; click it to open the night.`)),
      el('div.card-body.tight', {}, el('div.table-scroll', {},
        el('table.tip-table', {}, el('thead', {}, head), body, foot)))),
  );
}
