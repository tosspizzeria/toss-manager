// Two layers, because a tablet behind the bar and a public static site want
// different things:
//
//   1. Device pairing (cloud mode only). One Supabase Auth user for the
//      restaurant, signed in once per device. Row level security refuses every
//      request without it, so the anon key in this repo is harmless on its own.
//   2. Manager PIN. Picks who is on shift so checklist initials and the
//      MANAGER field fill themselves in. Held for 14 hours, which covers the
//      longest double you'd ever work, then asks again.

import { store, sbClient, isCloud } from './store.js';
import { sha256, uuid } from './util.js';

const SHIFT_KEY = 'toss.shift';
const SHIFT_TTL_MS = 14 * 60 * 60 * 1000;

export async function pairDevice(email, password) {
  const rest = sbClient();
  if (!rest) throw new Error('No Supabase connection configured.');
  await rest.signIn(email.trim(), password);
}

export async function unpairDevice() {
  const rest = sbClient();
  if (rest) await rest.signOut();
  clearShift();
}

/** Is this device allowed to talk to the database at all? */
export async function isPaired() {
  if (!isCloud()) return true;
  return sbClient().verify();
}

export async function pairedAs() {
  if (!isCloud()) return null;
  return sbClient().email;
}

// ---------------------------------------------------------------------------
export function currentManager() {
  try {
    const raw = localStorage.getItem(SHIFT_KEY);
    if (!raw) return null;
    const shift = JSON.parse(raw);
    if (!shift?.id || Date.now() - shift.at > SHIFT_TTL_MS) { clearShift(); return null; }
    return shift;
  } catch { return null; }
}

export function clearShift() { localStorage.removeItem(SHIFT_KEY); }

function setShift(manager) {
  localStorage.setItem(SHIFT_KEY, JSON.stringify({
    id: manager.id, name: manager.name, initials: manager.initials, at: Date.now(),
  }));
}

/** Verify a PIN against the stored hash and start the shift. */
export async function signInManager(manager, pin) {
  const hash = await sha256(String(pin));
  if (hash !== manager.pin_hash) return false;
  setShift(manager);
  return true;
}

/** Returns the created manager so the caller can sign them straight in. */
export async function createManager({ name, initials, pin, isAdmin = false }) {
  const existing = await store().listManagers();
  const row = {
    id: uuid(),
    name: name.trim(),
    initials: initials.trim().toLowerCase(),
    pin_hash: await sha256(String(pin)),
    is_admin: isAdmin || existing.length === 0,
    active: true,
    sort_order: existing.length,
  };
  await store().upsertManager(row);
  return row;
}

export async function setManagerPin(manager, pin) {
  await store().upsertManager({ ...manager, pin_hash: await sha256(String(pin)) });
}
