// Data access. Two interchangeable adapters behind one interface:
//
//   cloud  — Supabase Postgres. Every manager on every device sees the same
//            data, which is the whole point of leaving Google Sheets.
//   local  — browser localStorage. Used until Supabase is configured so the
//            site is clickable the minute GitHub Pages goes live. Data stays
//            on that one device; the header says so plainly.
//
// The seeds below mirror docs/toss/schema.sql so both adapters start life
// with the same checklists and settings.

import { uuid } from './util.js';
import { createRest } from './supabase.js';
import { SUPABASE } from './config.js';

const CFG_KEY = 'toss.supabase';
const LOCAL_KEY = 'toss.local.v1';

// Verbatim from the Daily template tab. Wording is theirs, not tidied:
// a manager scanning the list should see the words they already know.
export const OPEN_CHECKLIST_SEED = [
  'Turn on all Lights/Fans or heaters if cold out',
  'Put Fly Bait In Trash Cans',
  'Set AC/Heat',
  'Put on Music',
  'Confirm patio unlocked',
  'Count Bar Drawer',
  'Count safe box',
  'Daily Pretzel Count entered into toast',
  'Place any liquor or beer orders that need to be put in today',
  'Check reservations in Opentable',
  'Confirm all staff has arrived',
  'Use Toast Now App to update 86\'d Items',
  'Confirm tv\'s are on appropriate channels based on sporting events',
  'Preshift Coaching Session',
  'Check Ranch/blue Cheese levels let kitchen know if needed made',
  'Check Opening Bar List',
  'Check Opening Server List',
  'Walk entire restaurant make sure ready to open',
];

export const CLOSE_CHECKLIST_SEED = [
  'Server Checklist Checked',
  'Bar Checklist Checked',
  'Kitchen Checklist Checked',
  'Prep list complete',
  'Misters/Heaters turned Off',
  'Move all empty propane tanks to cage',
  'AC/Heat Set to 75 cool on hot days, 68 heat on cold',
  'Attendance Sheet updated',
  'Check hours in toast',
  'Both phones on the charger',
  'Back/Patio Door Locked',
  'Kegs Locked',
  'All tablets Charging',
  'Warmer boxes turned off and ranch fridge closed',
  'Music Off',
];

export const SETTINGS_SEED = {
  location_name: 'South 1st',
  bar_drawer_float: 60,
  tip_minimum_hourly: 20,
  denominations: [100, 50, 20, 10, 5, 1],
  cash_pickup_suggest_at: 4000,
  weather_zip: '78704',
  weather_lat: 30.2459,
  weather_lon: -97.7674,
  weather_timezone: 'America/Chicago',
  favorite_teams: ['Texas Longhorns', 'Dallas Cowboys', 'Houston Texans'],
  show_top_25: true,
  payout_lines: [
    { key: 'team_tip_share', label: 'Team Tip Share', kind: 'tip',
      note: 'Credit card tips off the POS report. Feeds the tip pool for payroll; does not come out of the safe.' },
    { key: 'cash_in_hand', label: 'Cash In Hand', kind: 'tip', auto: 'cash_in_total',
      note: 'The cash-in count. Feeds the tip pool for payroll; the cash itself stays in the safe.' },
    { key: 'delivery', label: 'Delivery', kind: 'safe' },
    { key: 'kitchen_beers', label: 'Payouts / Kitchen Beers', kind: 'safe' },
    { key: 'cash_pickup', label: 'Cash Pickup for Deposit', kind: 'safe',
      note: 'Bank deposit. Normally the only thing that lowers the rolling safe balance.' },
  ],
};

// Row colours from the Tip Tracker tab, offered when adding staff.
export const STAFF_COLORS = [
  '#a855f7', '#f0a30a', '#ec4899', '#22c1d6', '#5aa64a',
  '#b81d3f', '#e0342a', '#3b82f6', '#0f766e', '#7c5c2e',
];

export const STAFF_ROLES = ['Server', 'Bartender', 'Host', 'Busser', 'Kitchen', 'Manager'];

export const NOTE_FIELDS = [
  { key: 'dine_in', label: 'Dine in business' },
  { key: 'accolades', label: 'Employee accolades / coachable moments' },
  { key: 'eighty_six', label: "86'd items" },
  { key: 'attendance', label: 'Attendance notes' },
  { key: 'kitchen_recap', label: 'Kitchen recap' },
  { key: 'urgent', label: 'Urgent needs or 911 info' },
  { key: 'staffing', label: 'Staffing' },
];

export function blankSheet(businessDate) {
  return {
    business_date: businessDate,
    manager_id: null,
    manager_name: '',
    weather: '',
    events: '',
    open_counts: {},
    cash_infusion: 0,
    payouts: {},
    extra_payouts: [],
    cash_in_counts: {},
    close_counts: {},
    net_sales_house: null,
    net_sales_delivery: null,
    labor_cost_pct: null,
    total_tips: null,   // null = derive the pool from the payout lines
    open_checklist: {},
    close_checklist: {},
    tip_rows: [],
    notes: {},
    status: 'open',
  };
}

// ---------------------------------------------------------------------------
// Supabase connection config, kept in localStorage so the repo never carries
// project keys and each device can be pointed at a project independently.
// ---------------------------------------------------------------------------
export function getConnection() {
  if (SUPABASE.url && SUPABASE.anonKey) {
    return { url: SUPABASE.url.replace(/\/+$/, ''), anonKey: SUPABASE.anonKey, builtIn: true };
  }
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw);
    return cfg?.url && cfg?.anonKey ? cfg : null;
  } catch { return null; }
}

export function setConnection(url, anonKey) {
  localStorage.setItem(CFG_KEY, JSON.stringify({ url: url.trim().replace(/\/+$/, ''), anonKey: anonKey.trim() }));
}

export function clearConnection() { localStorage.removeItem(CFG_KEY); }

// ---------------------------------------------------------------------------
// Local adapter
// ---------------------------------------------------------------------------
function readLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* fall through to a fresh seed */ }
  const db = {
    managers: [],
    staff: [],
    checklist_items: [
      ...OPEN_CHECKLIST_SEED.map((label, i) => ({ id: uuid(), phase: 'open', label, sort_order: i + 1, active: true })),
      ...CLOSE_CHECKLIST_SEED.map((label, i) => ({ id: uuid(), phase: 'close', label, sort_order: i + 1, active: true })),
    ],
    settings: { ...SETTINGS_SEED },
    day_sheets: {},
    payroll_weeks: {},
  };
  localStorage.setItem(LOCAL_KEY, JSON.stringify(db));
  return db;
}

function writeLocal(db) { localStorage.setItem(LOCAL_KEY, JSON.stringify(db)); }

const localAdapter = {
  kind: 'local',
  async listManagers() {
    return readLocal().managers.slice().sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  },
  async upsertManager(row) {
    const db = readLocal();
    const i = db.managers.findIndex((m) => m.id === row.id);
    if (i >= 0) db.managers[i] = { ...db.managers[i], ...row };
    else db.managers.push({ id: row.id ?? uuid(), sort_order: db.managers.length, active: true, is_admin: false, ...row });
    writeLocal(db);
  },
  async deleteManager(id) {
    const db = readLocal();
    db.managers = db.managers.filter((m) => m.id !== id);
    writeLocal(db);
  },
  async listStaff() {
    return readLocal().staff.slice().sort((a, b) => a.name.localeCompare(b.name));
  },
  async upsertStaff(row) {
    const db = readLocal();
    const i = db.staff.findIndex((s) => s.id === row.id);
    if (i >= 0) db.staff[i] = { ...db.staff[i], ...row };
    else db.staff.push({ id: row.id ?? uuid(), role: 'Server', in_tip_pool: true, active: true, color: '#c8352b', aliases: [], ...row });
    writeLocal(db);
  },
  async deleteStaff(id) {
    const db = readLocal();
    db.staff = db.staff.filter((s) => s.id !== id);
    writeLocal(db);
  },
  async listChecklist() {
    return readLocal().checklist_items
      .filter((i) => i.active)
      .sort((a, b) => a.phase.localeCompare(b.phase) || a.sort_order - b.sort_order);
  },
  async upsertChecklistItem(row) {
    const db = readLocal();
    const i = db.checklist_items.findIndex((c) => c.id === row.id);
    if (i >= 0) db.checklist_items[i] = { ...db.checklist_items[i], ...row };
    else db.checklist_items.push({ id: row.id ?? uuid(), active: true, sort_order: db.checklist_items.length, ...row });
    writeLocal(db);
  },
  async getSettings() { return { ...SETTINGS_SEED, ...readLocal().settings }; },
  async setSetting(key, value) {
    const db = readLocal();
    db.settings[key] = value;
    writeLocal(db);
  },
  async getDay(date) { return readLocal().day_sheets[date] ?? null; },
  async saveDay(sheet) {
    const db = readLocal();
    db.day_sheets[sheet.business_date] = { ...sheet, updated_at: new Date().toISOString() };
    writeLocal(db);
    return db.day_sheets[sheet.business_date];
  },
  async listDays(start, end) {
    return Object.values(readLocal().day_sheets)
      .filter((s) => s.business_date >= start && s.business_date <= end)
      .sort((a, b) => a.business_date.localeCompare(b.business_date));
  },
  /** The most recent sheet strictly before `date` — the tab you used to click
   *  back to in order to check last night's safe count. */
  async previousDay(date) {
    return Object.values(readLocal().day_sheets)
      .filter((s) => s.business_date < date)
      .sort((a, b) => b.business_date.localeCompare(a.business_date))[0] ?? null;
  },
  async recentDays(limit = 30) {
    return Object.values(readLocal().day_sheets)
      .sort((a, b) => b.business_date.localeCompare(a.business_date))
      .slice(0, limit);
  },
  async getPayrollWeek(weekStart) {
    return readLocal().payroll_weeks?.[weekStart] ?? null;
  },
  async savePayrollWeek(row) {
    const db = readLocal();
    db.payroll_weeks = db.payroll_weeks ?? {};
    db.payroll_weeks[row.week_start] = row;
    writeLocal(db);
  },
  async listPayrollWeeks(start, end) {
    return Object.values(readLocal().payroll_weeks ?? {})
      .filter((w) => w.week_start >= start && w.week_start <= end);
  },
};

// ---------------------------------------------------------------------------
// Cloud adapter
// ---------------------------------------------------------------------------
const SHEET_COLUMNS = [
  'business_date', 'manager_id', 'manager_name', 'weather', 'events',
  'open_counts', 'cash_infusion', 'payouts', 'extra_payouts', 'cash_in_counts',
  'close_counts', 'net_sales_house', 'net_sales_delivery', 'labor_cost_pct', 'total_tips',
  'open_checklist', 'close_checklist', 'tip_rows', 'notes', 'status',
];

function sheetPayload(sheet) {
  const out = {};
  for (const col of SHEET_COLUMNS) out[col] = sheet[col] ?? blankSheet(sheet.business_date)[col];
  return out;
}

function cloudAdapter(rest) {
  const one = (rows) => rows[0] ?? null;
  return {
    kind: 'cloud',
    rest,
    async listManagers() {
      return rest.select('managers', 'select=*&order=sort_order.asc,name.asc');
    },
    async upsertManager(row) { await rest.upsert('managers', row, { onConflict: 'id' }); },
    async deleteManager(id) { await rest.remove('managers', `id=eq.${id}`); },

    async listStaff() { return rest.select('staff', 'select=*&order=name.asc'); },
    async upsertStaff(row) { await rest.upsert('staff', row, { onConflict: 'id' }); },
    async deleteStaff(id) { await rest.remove('staff', `id=eq.${id}`); },

    async listChecklist() {
      return rest.select('checklist_items', 'select=*&active=is.true&order=phase.asc,sort_order.asc');
    },
    async upsertChecklistItem(row) { await rest.upsert('checklist_items', row, { onConflict: 'id' }); },

    async getSettings() {
      const rows = await rest.select('settings', 'select=key,value');
      return { ...SETTINGS_SEED, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
    },
    async setSetting(key, value) {
      await rest.upsert('settings', { key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    },

    async getDay(date) {
      return one(await rest.select('day_sheets', `select=*&business_date=eq.${date}&limit=1`));
    },
    async saveDay(sheet) {
      const rows = await rest.upsert('day_sheets', sheetPayload(sheet), { onConflict: 'business_date' });
      return rows[0] ?? sheet;
    },
    async listDays(start, end) {
      return rest.select('day_sheets',
        `select=*&business_date=gte.${start}&business_date=lte.${end}&order=business_date.asc`);
    },
    async previousDay(date) {
      return one(await rest.select('day_sheets',
        `select=*&business_date=lt.${date}&order=business_date.desc&limit=1`));
    },
    async recentDays(limit = 30) {
      return rest.select('day_sheets', `select=*&order=business_date.desc&limit=${limit}`);
    },

    async getPayrollWeek(weekStart) {
      return one(await rest.select('payroll_weeks', `select=*&week_start=eq.${weekStart}&limit=1`));
    },
    async savePayrollWeek(row) { await rest.upsert('payroll_weeks', row, { onConflict: 'week_start' }); },
    async listPayrollWeeks(start, end) {
      return rest.select('payroll_weeks', `select=*&week_start=gte.${start}&week_start=lte.${end}`);
    },
  };
}

// ---------------------------------------------------------------------------
let adapter = null;
let rest = null;

export async function initStore() {
  const cfg = getConnection();
  if (!cfg) { adapter = localAdapter; rest = null; return adapter; }
  rest = createRest(cfg.url, cfg.anonKey);
  adapter = cloudAdapter(rest);
  return adapter;
}

export function store() {
  if (!adapter) throw new Error('store not initialised');
  return adapter;
}

export function sbClient() { return rest; }
export function isCloud() { return adapter?.kind === 'cloud'; }
