// Two layers, because a tablet behind the bar and a public static site want
// different things:
//
//   1. Google sign-in (cloud mode only). Each manager signs in with their own
//      @tosspizzeria.com Google Workspace account; the session is kept on the
//      device. Row level security refuses every request that does not carry a
//      Google session on that domain, so the anon key is harmless on its own,
//      Removing someone = suspend in Workspace + delete in Supabase Auth.
//   2. Manager PIN. Picks who is on shift so checklist initials and the
//      MANAGER field fill themselves in. Held for 14 hours, which covers the
//      longest double you'd ever work, then asks again.

import { store, sbClient, isCloud } from './store.js';
import { sha256, uuid } from './util.js';
import { ALLOWED_DOMAIN } from './config.js';

const SHIFT_KEY = 'toss.shift';
const SHIFT_TTL_MS = 14 * 60 * 60 * 1000;

const RETURN_KEY = 'toss.return';

/** Off to Google. Remembers the page so the manager lands back on it. */
export async function signInWithGoogle() {
  const rest = sbClient();
  if (!rest) throw new Error('No Supabase connection configured.');
  localStorage.setItem(RETURN_KEY, location.hash || '#/');
  await rest.signInWithGoogle(location.origin + location.pathname, { hd: ALLOWED_DOMAIN });
}

/**
 * Called at boot. If Google just sent us back with ?code= (or ?error=),
 * finish the sign-in, tidy the address bar, and report what happened.
 * Returns null when there was nothing to finish.
 */
export async function completeGoogleSignIn() {
  const q = new URLSearchParams(location.search);
  const code = q.get('code');
  const error = q.get('error_description') || q.get('error');
  if (!code && !error) return null;

  const back = localStorage.getItem(RETURN_KEY) || '#/';
  localStorage.removeItem(RETURN_KEY);
  history.replaceState(null, '', location.pathname + back);

  if (error) return { ok: false, message: error.replace(/\+/g, ' ') };
  const rest = sbClient();
  if (!rest) return { ok: false, message: 'No Supabase connection configured.' };
  try {
    const session = await rest.finishOAuth(code);
    if (!isAllowedEmail(session?.email)) {
      await rest.signOut();
      return { ok: false, message: `${session?.email ?? 'That account'} is not a ${ALLOWED_DOMAIN} account. Sign in with your Toss Google account.` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

export function isAllowedEmail(email) {
  return String(email ?? '').toLowerCase().endsWith(`@${ALLOWED_DOMAIN}`);
}

export async function signOutGoogle() {
  const rest = sbClient();
  if (rest) await rest.signOut();
  clearShift();
}

/** Is this device allowed to talk to the database at all? */
export async function isSignedIn() {
  if (!isCloud()) return true;
  return sbClient().verify();
}

export async function signedInAs() {
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
