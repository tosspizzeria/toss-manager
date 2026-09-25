// Every number the manager sheet derives lives in this file and nowhere else.
// Pure functions, no DOM, no network — so they can be unit tested (see
// ../test/calc.test.mjs) and so a formula correction is a one-line change.

export const DEFAULT_DENOMINATIONS = [100, 50, 20, 10, 5, 1];

/** Coerce anything the UI hands us into a finite number. */
export function num(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : parseFloat(String(value).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** Round to cents, killing float dust like 0.30000000000000004. */
export function money(value) {
  return Math.round((num(value) + Number.EPSILON) * 100) / 100;
}

/**
 * A bill count { "100": 12, "50": 6, ... } becomes rows with extended values
 * plus a total. Mirrors the $100/$50/$20/$10/$5/$1 ladder on the sheet.
 */
export function countBills(counts, denominations = DEFAULT_DENOMINATIONS) {
  const rows = denominations.map((denom) => {
    const qty = Math.max(0, Math.trunc(num(counts?.[denom] ?? counts?.[String(denom)])));
    return { denom, qty, value: money(qty * denom) };
  });
  return { rows, total: money(rows.reduce((sum, r) => sum + r.value, 0)) };
}

/** Per-denomination delta between two counts — how last night's close and
 *  this morning's open disagree, bill by bill. */
export function compareCounts(expected, actual, denominations = DEFAULT_DENOMINATIONS) {
  const rows = denominations.map((denom) => {
    const want = Math.trunc(num(expected?.[denom] ?? expected?.[String(denom)]));
    const got = Math.trunc(num(actual?.[denom] ?? actual?.[String(denom)]));
    return { denom, expected: want, actual: got, diff: got - want, value: money((got - want) * denom) };
  });
  const valueDiff = money(rows.reduce((sum, r) => sum + r.value, 0));
  return { rows, valueDiff, matches: rows.every((r) => r.diff === 0), mismatched: rows.filter((r) => r.diff !== 0) };
}

/**
 * The cash reconciliation, matching the sheet's Open Count / Cash In /
 * Payouts / Closing Count block (verified against all 21 filled-in nights of
 * August 2026):
 *
 *   openTotal      = sum(open bills) + cash infusion
 *   cashInTotal    = sum(cash-in bills)          -- pulled from the bar drawer
 *   payoutsTotal   = payout lines marked kind:'safe' + any ad-hoc lines
 *   expectedClose  = openTotal + cashInTotal - payoutsTotal
 *   overShort      = closeTotal - expectedClose      (negative = SHORT)
 *
 * Closing count is the physical recount of the safe *after* the cash-in money
 * has been put in it, which is why cash in is added before payouts come out.
 *
 * The distinction that matters: a payout line is either
 *
 *   kind: 'tip'  — a tip-pool component. It does NOT leave the safe. Tips are
 *                  paid through payroll, and the cash counted in from the
 *                  drawer physically stays in the safe. On 8/21/26 the tip
 *                  share was $760.34 while only $41 actually left the safe.
 *   kind: 'safe' — cash that really walks out: petty cash, kitchen beers, and
 *                  the pickup for the bank deposit.
 *
 * Nothing targets a fixed safe float: the balance rolls night to night until a
 * cash pickup takes money out. Across August it rolled 2,186 -> 4,346 before
 * the 3,140 pickup on the 22nd.
 */
export function reconcileCash(sheet, config = {}) {
  const denominations = config.denominations ?? DEFAULT_DENOMINATIONS;
  const payoutLines = config.payoutLines ?? [];

  const open = countBills(sheet.open_counts, denominations);
  const cashIn = countBills(sheet.cash_in_counts, denominations);
  const close = countBills(sheet.close_counts, denominations);

  const cashInfusion = money(sheet.cash_infusion);
  const openTotal = money(open.total + cashInfusion);

  const namedPayouts = payoutLines.map((line) => {
    const auto = line.auto === 'cash_in_total';
    return {
      key: line.key,
      label: line.label,
      note: line.note ?? null,
      kind: line.kind === 'tip' ? 'tip' : 'safe',
      auto: auto ? 'cash_in_total' : null,
      amount: auto ? cashIn.total : money(sheet.payouts?.[line.key]),
    };
  });
  const extraPayouts = (sheet.extra_payouts ?? []).map((line) => ({
    label: line.label ?? '',
    amount: money(line.amount),
    kind: 'safe',
  }));
  // Only 'safe' lines reduce the safe. Tip lines are payroll figures.
  const safeOutflows = [...namedPayouts.filter((p) => p.kind === 'safe'), ...extraPayouts];
  const tipLines = namedPayouts.filter((p) => p.kind === 'tip');
  const payoutsTotal = money(safeOutflows.reduce((s, p) => s + p.amount, 0));

  const expectedClose = money(openTotal + cashIn.total - payoutsTotal);
  const overShort = money(close.total - expectedClose);

  return {
    denominations,
    open,
    cashIn,
    close,
    cashInfusion,
    openTotal,
    namedPayouts,
    extraPayouts,
    safeOutflows,
    tipLines,
    payoutsTotal,
    expectedClose,
    overShort,
    // A closing count of all zeros means "not counted yet", not "we lost it all".
    closeCounted: close.total > 0 || Object.values(sheet.close_counts ?? {}).some((v) => num(v) > 0),
  };
}

/**
 * The tip pool — the sheet's "Tip Share Tips Net" cell (H22 = SUM(G22:G23)).
 *
 *   pool = Team Tip Share (credit card tips off the POS report)
 *        + Cash In Hand   (the cash-in count)
 *
 * Reproduces all 21 filled-in nights of August 2026 exactly. Which lines feed
 * the pool is the `kind: 'tip'` flag in settings, so the mix can change without
 * touching this file. `sheet.total_tips` is an optional manual override; null
 * (the normal case) means "derive it".
 */
export function tipPool(sheet, config = {}) {
  const cash = config.cash ?? reconcileCash(sheet, config);
  const parts = cash.tipLines;
  const derived = money(parts.reduce((s, p) => s + p.amount, 0));
  const raw = sheet.total_tips;
  const override = raw === null || raw === undefined || raw === '' ? null : money(raw);
  return { parts, derived, override, total: override ?? derived };
}

/**
 * Tip pool split straight by hours: everyone in the pool earns the same
 * dollars per hour.
 *
 *   totalHours  = sum(hours)
 *   payout_i    = pool * hours_i / totalHours
 *   perHour_i   = payout_i / hours_i            (= poolRate for everyone)
 *
 * The $20/hr guarantee is per person:
 *
 *   minimum_i    = hours_i * 20
 *   guaranteed_i = max(payout_i, minimum_i)     <- what payroll actually pays
 *   shortfall_i  = guaranteed_i - payout_i      <- what the house covers
 *
 * `guaranteed` is the number that matters at payroll time, and it is what the
 * old Tip Tracker tab held: all 83 staff-nights in August 2026 reproduce that
 * tab exactly (see test/tip-tracker-parity.test.mjs). `houseTopUp` is the
 * sheet's "Difference to meet minimum tipout pay".
 *
 * Cent-rounding remainder is handed to the largest-hours row so the payouts
 * always sum to exactly the pool.
 */
export function calcTips(sheet, config = {}) {
  const minimumHourly = num(config.tipMinimumHourly ?? 20);
  const pool = tipPool(sheet, config);
  const totalTips = pool.total;
  const rows = (sheet.tip_rows ?? [])
    .map((r) => ({ ...r, hours: Math.max(0, num(r.hours)) }));

  const totalHours = Math.round(rows.reduce((s, r) => s + r.hours, 0) * 100) / 100;
  const poolRate = totalHours > 0 ? totalTips / totalHours : 0;

  const withGuarantee = (r, payout) => {
    const minimum = money(r.hours * minimumHourly);
    const guaranteed = money(Math.max(payout, minimum));
    return {
      ...r,
      payout,
      perHour: r.hours > 0 ? money(payout / r.hours) : 0,
      minimum,
      guaranteed,
      guaranteedPerHour: r.hours > 0 ? money(guaranteed / r.hours) : 0,
      shortfall: money(guaranteed - payout),
    };
  };

  const computed = rows.map((r) =>
    withGuarantee(r, totalHours > 0 ? money(totalTips * (r.hours / totalHours)) : 0));

  // Push the rounding remainder onto the biggest row.
  const paid = money(computed.reduce((s, r) => s + r.payout, 0));
  const drift = money(totalTips - paid);
  if (drift !== 0 && computed.length && totalHours > 0) {
    const target = computed.reduce((a, b) => (b.hours > a.hours ? b : a));
    Object.assign(target, withGuarantee(target, money(target.payout + drift)));
  }

  return {
    rows: computed,
    pool,
    totalTips,
    totalHours,
    minimumHourly,
    poolRate: money(poolRate),
    minimumTotal: money(computed.reduce((s, r) => s + r.minimum, 0)),
    // What payroll pays out: the pool plus whatever the guarantee costs.
    guaranteedTotal: money(computed.reduce((s, r) => s + r.guaranteed, 0)),
    houseTopUp: money(computed.reduce((s, r) => s + r.shortfall, 0)),
    belowMinimum: computed.filter((r) => r.shortfall > 0).length,
  };
}

/** How much of the checklist is initialed. */
export function checklistProgress(items, marks) {
  const done = items.filter((item) => (marks?.[item.id] ?? '').trim().length > 0).length;
  return { done, total: items.length, complete: items.length > 0 && done === items.length };
}

/** Everything the day view and the reports both need, computed once. */
export function summarize(sheet, config = {}) {
  const cash = reconcileCash(sheet, config);
  const tips = calcTips(sheet, { ...config, cash });
  const suggestAt = num(config.cashPickupSuggestAt ?? 0);
  return {
    cash,
    tips,
    // The safe balance rolls until a pickup, so flag when it is getting fat.
    pickupSuggested: suggestAt > 0 && cash.expectedClose >= suggestAt,
    ...netSales(sheet),
    laborCostPct: sheet.labor_cost_pct === null || sheet.labor_cost_pct === undefined
      ? null
      : num(sheet.labor_cost_pct),
  };
}

/**
 * Net sales is two entries summed, as on the sheet (B32 = SUM(F22, F24)):
 * in-house alongside Team Tip Share, and delivery alongside Delivery. Returns
 * null for the total only when neither has been entered, so an untouched sheet
 * is "not filled in" rather than "a zero-sales night".
 */
export function netSales(sheet) {
  const blank = (v) => v === null || v === undefined || v === '';
  const house = blank(sheet.net_sales_house) ? null : money(sheet.net_sales_house);
  const delivery = blank(sheet.net_sales_delivery) ? null : money(sheet.net_sales_delivery);
  return {
    netSalesHouse: house,
    netSalesDelivery: delivery,
    netSales: house === null && delivery === null ? null : money((house ?? 0) + (delivery ?? 0)),
  };
}

/** Month rollup for the reports view. */
export function rollup(sheets, config) {
  const days = sheets.map((s) => ({ sheet: s, calc: summarize(s, config) }));
  const withSales = days.filter((d) => d.calc.netSales !== null);
  const withLabor = days.filter((d) => d.calc.laborCostPct !== null);
  const counted = days.filter((d) => d.calc.cash.closeCounted);

  const netSales = money(withSales.reduce((s, d) => s + d.calc.netSales, 0));
  return {
    days,
    dayCount: days.length,
    netSales,
    avgNetSales: withSales.length ? money(netSales / withSales.length) : 0,
    bestDay: withSales.length
      ? withSales.reduce((a, b) => (b.calc.netSales > a.calc.netSales ? b : a))
      : null,
    netSalesDelivery: money(days.reduce((s, d) => s + (d.calc.netSalesDelivery ?? 0), 0)),
    totalTips: money(days.reduce((s, d) => s + d.calc.tips.totalTips, 0)),
    guaranteedTotal: money(days.reduce((s, d) => s + d.calc.tips.guaranteedTotal, 0)),
    totalPayouts: money(days.reduce((s, d) => s + d.calc.cash.payoutsTotal, 0)),
    totalPickups: money(days.reduce((s, d) => {
      const line = d.calc.cash.namedPayouts.find((p) => p.key === 'cash_pickup');
      return s + (line ? line.amount : 0);
    }, 0)),
    netOverShort: money(counted.reduce((s, d) => s + d.calc.cash.overShort, 0)),
    shortDays: counted.filter((d) => d.calc.cash.overShort < -0.005).length,
    overDays: counted.filter((d) => d.calc.cash.overShort > 0.005).length,
    countedDays: counted.length,
    avgLaborPct: withLabor.length
      ? Math.round((withLabor.reduce((s, d) => s + d.calc.laborCostPct, 0) / withLabor.length) * 100) / 100
      : null,
    houseTopUp: money(days.reduce((s, d) => s + d.calc.tips.houseTopUp, 0)),
  };
}
