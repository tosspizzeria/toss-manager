// The day sheet. One page per business date, replacing one tab per day.
//
// Two things the spreadsheet could not do are load-bearing here:
//   * last night's closing safe count is fetched and compared automatically,
//     bill by bill, so nobody clicks back to yesterday's tab;
//   * every derived number recomputes as you type, and #DIV/0! is impossible.

import { el, clear, fmt, fmtSigned, longDate, shiftDate, todayISO, debounce, uuid, monthOf } from '../util.js';
import { blankSheet, store, NOTE_FIELDS } from '../store.js';
import { summarize, countBills, compareCounts, checklistProgress, num } from '../calc.js';
import { fetchWeather, describeWeather } from '../weather.js';
import { fetchGames, matchupLabel } from '../games.js';

export async function renderDay(ctx, date) {
  const root = clear(ctx.root);
  root.append(el('div.spinner'));

  const [existing, prev] = await Promise.all([
    store().getDay(date),
    store().previousDay(date),
  ]);

  const sheet = { ...blankSheet(date), ...(existing ?? {}) };
  // A brand new sheet inherits the manager on shift; the field stays editable.
  if (!existing && ctx.manager) {
    sheet.manager_id = ctx.manager.id;
    sheet.manager_name = ctx.manager.name;
  }

  const config = {
    denominations: ctx.settings.denominations,
    payoutLines: ctx.settings.payout_lines,
    tipMinimumHourly: ctx.settings.tip_minimum_hourly,
    cashPickupSuggestAt: ctx.settings.cash_pickup_suggest_at,
  };

  let saved = existing !== null;
  const refreshers = [];
  const refresh = () => refreshers.forEach((fn) => fn(summarize(sheet, config)));

  // -------------------------------------------------------------- persistence
  const status = el('span.status', 'Saved');
  const setStatus = (text, cls) => { status.textContent = text; status.className = `status ${cls ?? ''}`; };
  let dirty = false;

  async function save() {
    autosave.cancel();
    dirty = false;
    setStatus('Saving…');
    try {
      await store().saveDay(sheet);
      saved = true;
      setStatus('Saved', 'saved');
    } catch (err) {
      dirty = true;
      setStatus(`Not saved — ${err.message}`, 'error');
    }
  }

  const autosave = debounce(save, 1200);
  const touch = () => { dirty = true; setStatus('Unsaved changes', 'dirty'); autosave(); refresh(); };

  // Autosave is debounced, so tapping "Month view" a half-second after typing
  // would otherwise drop the edit. Flush on the way out, and take the
  // listeners with us so they don't pile up across navigations.
  const onBeforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  const teardown = () => {
    autosave.flush();
    window.removeEventListener('beforeunload', onBeforeUnload);
  };
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('hashchange', teardown, { once: true });

  // ------------------------------------------------------------------ helpers
  /** A bill-count table bound to one jsonb field on the sheet. */
  function billTable(field, opts = {}) {
    const rowNodes = new Map();
    const totalCell = el('td.total-val');
    const body = el('tbody');

    for (const denom of config.denominations) {
      const input = el('input', {
        type: 'number', min: '0', step: '1', inputMode: 'numeric',
        placeholder: '0',
        value: sheet[field]?.[denom] ?? sheet[field]?.[String(denom)] ?? '',
        'aria-label': `Number of $${denom} bills`,
      });
      const ext = el('td.ext', fmt(0));
      const row = el('tr.count-row', {}, el('td.denom', `$${denom}`), el('td', input), ext);
      input.addEventListener('input', () => {
        const qty = Math.max(0, Math.trunc(num(input.value)));
        if (input.value === '') delete sheet[field][denom];
        else sheet[field][denom] = qty;
        touch();
      });
      rowNodes.set(denom, { row, input, ext });
      body.append(row);
    }

    const node = el('table.count-table', {},
      el('thead', {}, el('tr', {},
        el('th', 'Bill'), el('th', 'Count'), el('th', 'Value'))),
      body,
      el('tfoot', {}, el('tr.count-total', {},
        el('td', { colSpan: 2 }, opts.totalLabel ?? 'Total'), totalCell)));

    refreshers.push(() => {
      const { rows, total } = countBills(sheet[field], config.denominations);
      for (const r of rows) {
        const ref = rowNodes.get(r.denom);
        ref.ext.textContent = fmt(r.value);
        ref.row.classList.toggle('mismatch', Boolean(opts.mismatchSet?.().has(r.denom)));
      }
      totalCell.textContent = fmt(total);
    });

    return {
      node,
      /** Overwrite the whole count, e.g. pulling last night's closing count in. */
      fill(counts) {
        sheet[field] = { ...counts };
        for (const [denom, ref] of rowNodes) {
          const qty = counts?.[denom] ?? counts?.[String(denom)] ?? '';
          ref.input.value = qty === '' || qty === 0 ? (qty === 0 ? 0 : '') : qty;
        }
        touch();
      },
    };
  }

  function moneyField(label, get, set, opts = {}) {
    const input = el('input', {
      type: 'number', step: '0.01', inputMode: 'decimal',
      placeholder: opts.placeholder ?? '0.00',
      value: get() ?? '',
      dataset: opts.role ? { role: opts.role } : undefined,
    });
    input.addEventListener('input', () => { set(input.value === '' ? null : num(input.value)); touch(); });
    return el('div.field.money', {}, el('label', label), input,
      opts.note ? el('p.hint', opts.note) : null);
  }

  function textField(label, get, set, tag = 'input') {
    const input = el(tag, { value: get() ?? '' });
    if (tag === 'textarea') input.value = get() ?? '';
    input.addEventListener('input', () => { set(input.value); touch(); });
    return el('div.field', {}, el('label', label), input);
  }

  function checklistCard(phase, title) {
    const items = ctx.checklist[phase];
    const marks = phase === 'open' ? sheet.open_checklist : sheet.close_checklist;
    const progress = el('span.progress');
    const list = el('ul.check-list');
    const paints = [];

    for (const item of items) {
      const btn = el('button.initial-btn', { type: 'button', title: 'Tap to initial' });
      const row = el('li.check-item', {}, el('span.label', item.label), btn);

      const paint = () => {
        const mark = (marks[item.id] ?? '').trim();
        btn.textContent = mark || 'initial';
        btn.classList.toggle('set', Boolean(mark));
        row.classList.toggle('done', Boolean(mark));
        const p = checklistProgress(items, marks);
        progress.textContent = `${p.done}/${p.total}`;
      };

      btn.addEventListener('click', () => {
        const initials = (ctx.manager?.initials ?? '').trim();
        if (marks[item.id]) delete marks[item.id];
        else if (initials) marks[item.id] = initials;
        else {
          const typed = prompt('Initials for this item:');
          if (!typed?.trim()) return;
          marks[item.id] = typed.trim().toLowerCase();
        }
        paint();
        touch();
      });

      paint();
      paints.push(paint);
      list.append(row);
    }

    const allBtn = el('button.btn.btn-sm.btn-ghost', { type: 'button' }, 'Initial all remaining');
    allBtn.addEventListener('click', () => {
      const initials = (ctx.manager?.initials ?? '').trim() || (prompt('Initials:') ?? '').trim().toLowerCase();
      if (!initials) return;
      for (const item of items) if (!marks[item.id]) marks[item.id] = initials;
      // Repaint in place — re-rendering the view would reload from the store
      // and throw away anything typed in the last second.
      paints.forEach((fn) => fn());
      touch();
    });

    return el('div.card', {},
      el('div.card-head', {}, el('h2', title), el('span.spacer'), progress, allBtn),
      el('div.card-body.tight', {}, items.length ? list
        : el('p.hint', { style: 'padding:16px' }, 'No checklist items yet — add them under Settings.')));
  }

  // --------------------------------------------------------------------- games
  // Collapsed by default. Most nights nobody needs it; on a Saturday in
  // October it answers "which TV gets which game" without leaving the sheet.
  function gamesPanel() {
    const wrap = el('div');
    const toggle = el('button.games-toggle', { type: 'button', 'aria-expanded': 'false' },
      el('span', '🏈'), el('span', 'Checking today’s games…'));
    const panel = el('div.card', { hidden: true });
    wrap.append(toggle, panel);

    let loaded = null;

    const paint = () => {
      clear(panel);
      if (loaded === null) {
        panel.append(el('div.card-body', {},
          el('p.hint', 'Could not reach the scoreboard. Check the TV schedule directly.')));
        return;
      }
      const body = el('div');
      for (const g of loaded) {
        body.append(el(`div.game-row${g.favorite ? '.fav' : ''}`, {},
          el('span.when', g.state === 'pre' ? g.kickoff : (g.detail || g.kickoff)),
          el('span.lg', g.league),
          el('span.who', matchupLabel(g)),
          el(`span.chan${g.channel ? '' : '.none'}`, g.channel || 'TBD')));
      }
      panel.append(
        el('div.card-head', {}, el('h2', 'On the TVs today'), el('span.spacer'),
          el('span.progress', `${loaded.filter((g) => g.favorite).length} home-team`)),
        el('div.card-body.tight', {}, body));
    };

    toggle.addEventListener('click', () => {
      const open = panel.hidden;
      panel.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
    });

    fetchGames(date, ctx.settings).then((games) => {
      loaded = games;
      if (games === null) {
        clear(toggle).append(el('span', '🏈'), el('span', 'Game schedule unavailable'));
        paint();
        return;
      }
      if (!games.length) {
        // Nothing worth flagging — take the row away rather than show a zero.
        wrap.remove();
        return;
      }
      const fav = games.filter((g) => g.favorite).length;
      clear(toggle).append(
        el('span', '🏈'),
        el('span', fav ? 'Longhorns / Cowboys / Texans and top 25 today' : 'Top 25 games today'),
        el('span.count', String(games.length)));
      paint();
    });

    return wrap;
  }

  // --------------------------------------------------------------- carry-over
  // Rebuilt on every edit: typing a bill count has to flip this between
  // "matches last night" and "off by ...", which is the whole reason the
  // spreadsheet made you click back to yesterday's tab.
  function carrySlot() {
    const slot = el('div');
    refreshers.push(() => { clear(slot).append(carryBanner()); });
    return slot;
  }

  function carryBanner() {
    const openEmpty = countBills(sheet.open_counts, config.denominations).total === 0;

    if (!prev) {
      return el('div.banner.banner-info', {},
        el('span', 'No earlier day on record, so there is nothing to check this morning’s count against.'));
    }

    const prevClose = countBills(prev.close_counts, config.denominations);
    const prevLabel = longDate(prev.business_date);

    if (prevClose.total === 0) {
      return el('div.banner.banner-info', {},
        el('span', `${prevLabel} was never closed out — no closing safe count to compare against.`),
        el('a', { href: `#/day/${prev.business_date}` }, 'Open that day'));
    }

    if (openEmpty) {
      const btn = el('button.btn.btn-sm.btn-primary', { type: 'button' },
        `Use last night’s count (${fmt(prevClose.total)})`);
      btn.addEventListener('click', () => openTable.fill(prev.close_counts));
      return el('div.banner.banner-info', {},
        el('span', `${prevLabel} closed with ${fmt(prevClose.total)} in the safe. Count it, then confirm it matches.`),
        btn);
    }

    const cmp = compareCounts(prev.close_counts, sheet.open_counts, config.denominations);
    if (cmp.matches) {
      return el('div.banner.banner-ok', {},
        el('span', `Matches ${prevLabel}’s closing count of ${fmt(prevClose.total)}.`));
    }
    const detail = cmp.mismatched
      .map((r) => `$${r.denom}: ${r.expected} → ${r.actual} (${r.diff > 0 ? '+' : ''}${r.diff})`)
      .join(', ');
    return el('div.banner.banner-bad', {},
      el('span', `Does not match ${prevLabel}’s close of ${fmt(prevClose.total)} — off by ${fmtSigned(cmp.valueDiff)}. ${detail}`));
  }

  // ----------------------------------------------------------------- payouts
  // Only cash that actually walks out of the safe. Tip figures live on the tip
  // pool card instead: they are payroll numbers, and taking them out here would
  // show the safe short by the whole tip share every night.
  function payoutsCard() {
    const body = el('div.card-body');
    const totalNode = el('span.progress');
    const safeLines = config.payoutLines.filter((l) => l.kind !== 'tip');

    const renderPayouts = () => {
      clear(body);
      for (const line of safeLines) {
        body.append(moneyField(line.label,
          () => sheet.payouts?.[line.key] ?? '',
          (v) => { sheet.payouts[line.key] = v ?? 0; },
          { note: line.note, role: `payout-${line.key}` }));
      }
      sheet.extra_payouts.forEach((line, i) => {
        const labelInput = el('input', { value: line.label ?? '', placeholder: 'What was it for' });
        const amountInput = el('input', { type: 'number', step: '0.01', inputMode: 'decimal', value: line.amount ?? '', placeholder: '0.00' });
        const del = el('button.row-del', { type: 'button', title: 'Remove line' }, '×');
        labelInput.addEventListener('input', () => { sheet.extra_payouts[i].label = labelInput.value; touch(); });
        amountInput.addEventListener('input', () => { sheet.extra_payouts[i].amount = num(amountInput.value); touch(); });
        del.addEventListener('click', () => { sheet.extra_payouts.splice(i, 1); renderPayouts(); touch(); });
        body.append(el('div.field', {},
          el('label', `Other payout ${i + 1}`),
          el('div.btn-row', {}, labelInput, amountInput, del)));
      });
      const add = el('button.btn.btn-sm.btn-ghost', { type: 'button' }, '+ Other payout');
      add.addEventListener('click', () => { sheet.extra_payouts.push({ label: '', amount: 0 }); renderPayouts(); touch(); });
      body.append(add);
    };
    renderPayouts();

    refreshers.push((calc) => { totalNode.textContent = fmt(calc.cash.payoutsTotal); });

    return el('div.card', {},
      el('div.card-head', {}, el('h2', 'Cash out of the safe'), el('span.spacer'), totalNode),
      body);
  }

  // ------------------------------------------------------------ reconciliation
  function reconcileCard() {
    const tiles = el('div.tiles');
    refreshers.push((calc) => {
      const c = calc.cash;
      const short = c.overShort < -0.005;
      const over = c.overShort > 0.005;
      clear(tiles);
      tiles.append(
        el('div.tile', {}, el('div.k', 'Open count'), el('div.v', fmt(c.openTotal)),
          c.cashInfusion ? el('div.n', `includes ${fmt(c.cashInfusion)} infusion`) : null),
        el('div.tile', {}, el('div.k', 'Cash in'), el('div.v', fmt(c.cashIn.total))),
        el('div.tile', {}, el('div.k', 'Payouts'), el('div.v', `−${fmt(c.payoutsTotal).slice(1)}`)),
        el('div.tile', { dataset: { role: 'expected-close' } },
          el('div.k', 'Should be in safe'), el('div.v', fmt(c.expectedClose))),
        el('div.tile', {}, el('div.k', 'Counted'), el('div.v', c.closeCounted ? fmt(c.close.total) : '—'),
          c.closeCounted ? null : el('div.n', 'not counted yet')),
        el(`div.tile.big.${!c.closeCounted ? 'warn' : short ? 'bad' : over ? 'warn' : 'ok'}`, { dataset: { role: 'over-short' } },
          el('div.k', !c.closeCounted ? 'Over / short' : short ? 'Short' : over ? 'Over' : 'Balanced'),
          el('div.v', c.closeCounted ? fmtSigned(c.overShort) : '—'),
          el('div.n', c.closeCounted
            ? (short || over ? 'counted minus expected' : 'safe balances')
            : 'enter the closing count')),
      );
    });
    const pickupNote = el('p.hint');
    refreshers.push((calc) => {
      pickupNote.hidden = !calc.pickupSuggested;
      pickupNote.textContent = calc.pickupSuggested
        ? `The safe is rolling up to ${fmt(calc.cash.expectedClose)}. Worth a cash pickup for deposit.`
        : '';
    });

    return el('div.card', {},
      el('div.card-head', {}, el('h2', 'Cash reconciliation'), el('span.spacer'),
        el('span.progress', 'open + cash in − payouts')),
      el('div.card-body.tight', {}, tiles),
      el('div.card-body', {}, pickupNote));
  }

  // --------------------------------------------------------------------- tips
  function tipsCard() {
    const body = el('tbody');
    const foot = el('tfoot');
    const summary = el('div.tiles');
    const poolStaff = ctx.staff.filter((s) => s.active && s.in_tip_pool);

    const renderRows = () => {
      clear(body);
      sheet.tip_rows.forEach((row, i) => {
        const select = el('select');
        select.append(el('option', { value: '' }, '— pick staff —'));
        for (const s of poolStaff) {
          select.append(el('option', { value: s.id, selected: s.id === row.staff_id }, `${s.name} · ${s.role}`));
        }
        if (row.name && !poolStaff.some((s) => s.id === row.staff_id)) {
          select.append(el('option', { value: `legacy:${row.name}`, selected: true }, `${row.name} (off roster)`));
        }
        select.addEventListener('change', () => {
          const s = poolStaff.find((x) => x.id === select.value);
          sheet.tip_rows[i] = { ...sheet.tip_rows[i], staff_id: s?.id ?? null, name: s?.name ?? row.name, role: s?.role ?? row.role };
          touch();
        });

        const hours = el('input', { type: 'number', step: '0.25', min: '0', inputMode: 'decimal', value: row.hours ?? '', placeholder: '0' });
        hours.addEventListener('input', () => { sheet.tip_rows[i].hours = num(hours.value); touch(); });

        const del = el('button.row-del', { type: 'button', title: 'Remove' }, '×');
        del.addEventListener('click', () => { sheet.tip_rows.splice(i, 1); renderRows(); touch(); });

        body.append(el('tr', { dataset: { row: String(i) } },
          el('td', select), el('td', hours),
          el('td.num.js-payout', '—'), el('td.num.js-rate', '—'),
          el('td.num.js-min', '—'), el('td.num.js-short', '—'),
          el('td.num.js-payroll', '—'),
          el('td', del)));
      });
      if (!sheet.tip_rows.length) {
        body.append(el('tr', {}, el('td', { colSpan: 8 },
          el('p.hint', poolStaff.length
            ? 'No one added yet — use "Add staff to pool".'
            : 'No staff on the roster yet. Add them under Staff, or they won’t appear here.'))));
      }
      refresh();
    };

    refreshers.push((calc) => {
      const t = calc.tips;
      t.rows.forEach((row, i) => {
        const tr = body.querySelector(`tr[data-row="${i}"]`);
        if (!tr) return;
        tr.querySelector('.js-payout').textContent = fmt(row.payout);
        tr.querySelector('.js-rate').textContent = `${fmt(row.perHour)}/hr`;
        tr.querySelector('.js-min').textContent = fmt(row.minimum);
        const short = tr.querySelector('.js-short');
        short.textContent = row.shortfall > 0 ? fmt(row.shortfall) : '—';
        short.classList.toggle('short', row.shortfall > 0);
        const payroll = tr.querySelector('.js-payroll');
        payroll.textContent = fmt(row.guaranteed);
        payroll.style.fontWeight = '800';
      });

      clear(foot).append(el('tr', {},
        el('td', 'Totals'),
        el('td.num', `${t.totalHours} hrs`),
        el('td.num', fmt(t.totalTips)),
        el('td.num', `${fmt(t.poolRate)}/hr`),
        el('td.num', fmt(t.minimumTotal)),
        el('td.num', t.houseTopUp > 0 ? fmt(t.houseTopUp) : '—'),
        el('td.num', fmt(t.guaranteedTotal)),
        el('td', '')));

      clear(summary).append(
        el('div.tile', {}, el('div.k', 'Total tips'), el('div.v', fmt(t.totalTips))),
        el('div.tile', {}, el('div.k', 'Pooled hours'), el('div.v', String(t.totalHours))),
        el('div.tile', {}, el('div.k', 'Pool rate'), el('div.v', `${fmt(t.poolRate)}/hr`),
          el('div.n', 'tips ÷ hours')),
        el(`div.tile.${t.houseTopUp > 0 ? 'warn' : 'ok'}`, {},
          el('div.k', `House top-up to ${fmt(t.minimumHourly)}/hr`),
          el('div.v', fmt(t.houseTopUp)),
          el('div.n', t.belowMinimum ? `${t.belowMinimum} below the floor` : 'everyone clears the floor')),
        el('div.tile', { dataset: { role: 'to-payroll' } },
          el('div.k', 'To payroll'), el('div.v', fmt(t.guaranteedTotal)),
          el('div.n', 'what the tip tracker shows')),
      );
    });

    const addBtn = el('button.btn.btn-sm.btn-ghost', { type: 'button' }, '+ Add row');
    addBtn.addEventListener('click', () => { sheet.tip_rows.push({ id: uuid(), staff_id: null, name: '', role: '', hours: 0 }); renderRows(); touch(); });

    const addAllBtn = el('button.btn.btn-sm.btn-ghost', { type: 'button' }, 'Add staff to pool');
    addAllBtn.addEventListener('click', () => {
      for (const s of poolStaff) {
        if (sheet.tip_rows.some((r) => r.staff_id === s.id)) continue;
        sheet.tip_rows.push({ id: uuid(), staff_id: s.id, name: s.name, role: s.role, hours: 0 });
      }
      renderRows();
      touch();
    });

    // The two components of the pool, entered right here rather than buried in
    // a payouts block — they are payroll figures, not cash leaving the safe.
    const tipLines = config.payoutLines.filter((l) => l.kind === 'tip');
    const tipInputs = el('div');
    const autoNodes = new Map();
    for (const line of tipLines) {
      if (line.auto === 'cash_in_total') {
        const value = el('input', { type: 'text', readOnly: true, tabIndex: -1, dataset: { role: `auto-${line.key}` } });
        value.style.fontFamily = 'var(--mono)';
        value.style.opacity = '.85';
        autoNodes.set(line.key, value);
        tipInputs.append(el('div.field.money', {},
          el('label', `${line.label} — from the cash-in count`), value,
          line.note ? el('p.hint', line.note) : null));
        continue;
      }
      tipInputs.append(moneyField(line.label,
        () => sheet.payouts?.[line.key] ?? '',
        (v) => { sheet.payouts[line.key] = v ?? 0; },
        { note: line.note, role: `payout-${line.key}` }));
    }

    const poolReadout = el('input', { type: 'text', readOnly: true, tabIndex: -1, dataset: { role: 'tip-pool-total' } });
    poolReadout.style.fontFamily = 'var(--mono)';
    poolReadout.style.fontSize = '19px';
    poolReadout.style.fontWeight = '700';

    const overrideInput = el('input', { type: 'number', step: '0.01', inputMode: 'decimal', value: sheet.total_tips ?? '', placeholder: 'leave blank to calculate' });
    overrideInput.addEventListener('input', () => {
      sheet.total_tips = overrideInput.value === '' ? null : num(overrideInput.value);
      touch();
    });
    const overrideField = el('div.field.money', {},
      el('label', 'Override the pool'), overrideInput,
      el('p.hint', 'Only if the POS report and the cash handed out disagree. Blank is normal.'));
    overrideField.hidden = sheet.total_tips === null || sheet.total_tips === undefined;

    const overrideToggle = el('button.btn.btn-sm.btn-ghost', { type: 'button' },
      overrideField.hidden ? 'Override' : 'Hide override');
    overrideToggle.addEventListener('click', () => {
      overrideField.hidden = !overrideField.hidden;
      overrideToggle.textContent = overrideField.hidden ? 'Override' : 'Hide override';
      if (overrideField.hidden && sheet.total_tips !== null) {
        sheet.total_tips = null;
        overrideInput.value = '';
        touch();
      }
    });

    refreshers.push((calc) => {
      for (const [key, node] of autoNodes) {
        node.value = fmt(calc.cash.namedPayouts.find((p) => p.key === key)?.amount ?? 0);
      }
      const pool = calc.tips.pool;
      const breakdown = pool.parts.map((p) => `${p.label} ${fmt(p.amount)}`).join('  +  ');
      poolReadout.value = pool.override !== null
        ? `${fmt(pool.total)}  (overridden)`
        : `${fmt(pool.total)}   =   ${breakdown}`;
    });

    renderRows();

    return el('div.card', {},
      el('div.card-head', {}, el('h2', 'Tip pool'), el('span.spacer'), overrideToggle, addAllBtn, addBtn),
      el('div.card-body', {},
        tipInputs,
        el('div.field.money', {}, el('label', 'Tip share tips net — the pool'), poolReadout,
          el('p.hint', 'Credit card tips off the POS report, plus the cash counted in from the bar drawer. Paid through payroll, so none of it comes out of the safe.')),
        overrideField,
        el('p.hint', `Split straight by hours: everyone in the pool earns the same rate. Then the ${fmt(ctx.settings.tip_minimum_hourly)}/hr guarantee is applied per person, so “to payroll” is whichever is higher — the share or the floor. Hours come off the Toast report.`)),
      el('div.card-body.tight', {}, summary),
      el('div.card-body.tight', {}, el('div.table-scroll', {},
        el('table.tip-table', {},
          el('thead', {}, el('tr', {},
            el('th', 'Staff'), el('th', 'Hours'), el('th', 'Payout'), el('th', '$ / hour'),
            el('th', `Min @ ${fmt(ctx.settings.tip_minimum_hourly)}`), el('th', 'Top-up'),
            el('th', 'To payroll'), el('th', ''))),
          body, foot))));
  }

  // -------------------------------------------------------------------- sales
  function salesCard() {
    const totalNode = el('span.progress');
    const laborInput = el('input', { type: 'number', step: '0.01', inputMode: 'decimal', value: sheet.labor_cost_pct ?? '', placeholder: '0.00' });
    laborInput.addEventListener('input', () => {
      sheet.labor_cost_pct = laborInput.value === '' ? null : num(laborInput.value);
      touch();
    });

    refreshers.push((calc) => {
      totalNode.textContent = calc.netSales === null ? 'not entered' : fmt(calc.netSales);
    });

    return el('div.card', {},
      el('div.card-head', {}, el('h2', 'Sales & labor from Toast'), el('span.spacer'), totalNode),
      el('div.card-body', {},
        moneyField('Net sales — in house', () => sheet.net_sales_house ?? '', (v) => { sheet.net_sales_house = v; }),
        moneyField('Net sales — delivery', () => sheet.net_sales_delivery ?? '', (v) => { sheet.net_sales_delivery = v; },
          { note: 'The two add up to the night\u2019s net sales, as on the sheet.' }),
        el('div.field.money', {}, el('label', 'Labor cost %'), laborInput)));
  }

  // -------------------------------------------------------------------- notes
  function notesCard() {
    const body = el('div.card-body.grid.grid-2');
    for (const f of NOTE_FIELDS) {
      body.append(textField(f.label, () => sheet.notes?.[f.key] ?? '', (v) => { sheet.notes[f.key] = v; }, 'textarea'));
    }
    return el('div.card', {}, el('div.card-head', {}, el('h2', 'Night notes')), body);
  }

  // ------------------------------------------------------------------- assemble
  const openTable = billTable('open_counts', { totalLabel: 'Counted' });
  const cashInTable = billTable('cash_in_counts');
  const closeTable = billTable('close_counts', { totalLabel: 'Counted' });

  // Weather, editable, but pre-filled from the zip so it is one less thing to
  // think about at open. Only auto-fetched on a sheet that has no weather yet.
  function weatherField() {
    const input = el('input', { value: sheet.weather ?? '', placeholder: 'Hot, storms after 8, patio dead…' });
    input.addEventListener('input', () => { sheet.weather = input.value; touch(); });

    const btn = el('button.btn.btn-sm.btn-ghost', { type: 'button' },
      `Look up ${ctx.settings.weather_zip ?? '78704'}`);
    const note = el('p.hint');

    const load = async (silent) => {
      btn.disabled = true;
      btn.textContent = 'Checking…';
      const w = await fetchWeather(date, ctx.settings);
      btn.disabled = false;
      btn.textContent = `Look up ${ctx.settings.weather_zip ?? '78704'}`;
      if (!w) { if (!silent) note.textContent = 'Could not reach the weather service — type it in.'; return; }
      const text = describeWeather(w);
      note.textContent = `${ctx.settings.weather_zip ?? '78704'} · ${text}`;
      if (silent && (sheet.weather ?? '').trim()) return;
      input.value = text;
      sheet.weather = text;
      touch();
    };

    btn.addEventListener('click', () => load(false));
    if (!(sheet.weather ?? '').trim()) load(true);

    return el('div.field', {},
      el('label', 'Weather'),
      el('div.btn-row', {}, input, btn),
      note);
  }

  // Free text, not a dropdown: the real sheets say things like "Mer,Ash,Sawyer"
  // when three people covered the shift. Pre-filled from whoever is on the PIN,
  // with the roster offered as suggestions.
  const managerList = el('datalist', { id: 'manager-names' });
  for (const m of ctx.managers.filter((m) => m.active)) {
    managerList.append(el('option', { value: m.name }));
  }
  const managerInput = el('input', {
    value: sheet.manager_name ?? '',
    placeholder: 'Who ran the shift',
    list: 'manager-names',
  });
  managerInput.setAttribute('list', 'manager-names');
  managerInput.addEventListener('input', () => {
    sheet.manager_name = managerInput.value;
    const hit = ctx.managers.find((m) => m.name === managerInput.value);
    sheet.manager_id = hit?.id ?? null;
    touch();
  });

  const statusPill = el('span', { class: sheet.status === 'closed' ? 'pill pill-closed' : 'pill pill-open' },
    sheet.status === 'closed' ? 'Closed out' : 'Open');

  const dateInput = el('input.date-input', { type: 'date', value: date });
  dateInput.addEventListener('change', () => { if (dateInput.value) location.hash = `#/day/${dateInput.value}`; });

  const navBtn = (label, target, title) => {
    const b = el('button.btn.btn-sm', { type: 'button', title }, label);
    b.addEventListener('click', () => { location.hash = `#/day/${target}`; });
    return b;
  };

  const closeOutBtn = el('button.btn', { type: 'button' },
    sheet.status === 'closed' ? 'Reopen day' : 'Mark closed out');
  closeOutBtn.addEventListener('click', async () => {
    sheet.status = sheet.status === 'closed' ? 'open' : 'closed';
    statusPill.textContent = sheet.status === 'closed' ? 'Closed out' : 'Open';
    statusPill.className = sheet.status === 'closed' ? 'pill pill-closed' : 'pill pill-open';
    closeOutBtn.textContent = sheet.status === 'closed' ? 'Reopen day' : 'Mark closed out';
    await save();
  });

  const saveBtn = el('button.btn.btn-primary', { type: 'button' }, 'Save now');
  saveBtn.addEventListener('click', save);

  clear(root);
  root.append(
    el('div.daybar', {},
      navBtn('←', shiftDate(date, -1), 'Previous day'),
      dateInput,
      navBtn('→', shiftDate(date, 1), 'Next day'),
      el('h1', longDate(date)),
      statusPill,
      el('span.spacer'),
      date === todayISO() ? null : navBtn('Today', todayISO(), 'Jump to today'),
      el('a.btn.btn-sm', { href: `#/month/${monthOf(date)}` }, 'Month view')),

    carrySlot(),
    gamesPanel(),

    el('div.grid.grid-2', {},
      el('div.card', {},
        el('div.card-head', {}, el('h2', 'Shift')),
        el('div.card-body', {},
          el('div.field', {}, el('label', 'Manager'), managerInput, managerList),
          weatherField(),
          textField('Events or special occasions', () => sheet.events, (v) => { sheet.events = v; }, 'textarea'))),
      el('div.card', {},
        el('div.card-head', {}, el('h2', 'Opening safe count'), el('span.spacer'),
          el('span.progress', 'last night’s close')),
        el('div.card-body.tight', {}, openTable.node),
        el('div.card-body', {},
          moneyField('Cash infusion', () => sheet.cash_infusion || '', (v) => { sheet.cash_infusion = v ?? 0; })))),

    checklistCard('open', 'Opening checklist'),

    el('div.grid.grid-2', {},
      payoutsCard(),
      el('div.card', {},
        el('div.card-head', {}, el('h2', 'Cash in from bar drawer'), el('span.spacer'),
          el('span.progress', `leave ${fmt(ctx.settings.bar_drawer_float)} in the drawer`)),
        el('div.card-body.tight', {}, cashInTable.node))),

    el('div.grid.grid-2', {},
      el('div.card', {},
        el('div.card-head', {}, el('h2', 'Closing safe count')),
        el('div.card-body.tight', {}, closeTable.node)),
      salesCard()),

    reconcileCard(),
    tipsCard(),
    checklistCard('close', 'Closing checklist'),
    notesCard(),

    el('div.savebar', {}, el('div.savebar-inner', {},
      status, closeOutBtn, saveBtn)),
  );

  setStatus(saved ? 'Saved' : 'Not started — changes save automatically', saved ? 'saved' : '');
  refresh();
}
