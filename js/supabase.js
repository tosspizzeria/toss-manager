// A small Supabase client built on fetch.
//
// Why not the official SDK: it would have to come from a CDN at runtime, and a
// bar tablet that cannot reach esm.sh would be a tablet that cannot count the
// safe. Everything here is plain REST against PostgREST and GoTrue, so the app
// has no external JavaScript at all and works from any static host.

const SESSION_KEY = 'toss.auth';
const PKCE_KEY = 'toss.pkce';

function randomString(len) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'[b % 66]).join('');
}

async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createRest(url, anonKey) {
  const base = url.replace(/\/+$/, '');
  let session = readSession();

  function readSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function writeSession(next) {
    session = next;
    if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    else localStorage.removeItem(SESSION_KEY);
  }

  async function tokenRequest(grant, body) {
    const res = await fetch(`${base}/auth/v1/token?grant_type=${grant}`, {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(json.error_description || json.msg || json.error || `Sign-in failed (${res.status})`);
    }
    writeSession({
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      // GoTrue returns seconds-until-expiry; keep an absolute deadline instead.
      expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
      email: json.user?.email ?? null,
    });
    return session;
  }

  /** Refresh a minute before expiry so a long shift never gets logged out. */
  async function freshToken() {
    if (!session) return null;
    if (Date.now() < session.expires_at - 60_000) return session.access_token;
    if (!session.refresh_token) { writeSession(null); return null; }
    try {
      await tokenRequest('refresh_token', { refresh_token: session.refresh_token });
      return session.access_token;
    } catch {
      writeSession(null);
      return null;
    }
  }

  async function rest(method, table, { params = '', body, prefer } = {}) {
    const token = await freshToken();
    if (!token) throw new Error('Not signed in — sign in with your Toss Google account.');
    const headers = {
      apikey: anonKey,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (prefer) headers.Prefer = prefer;

    const res = await fetch(`${base}/rest/v1/${table}${params ? `?${params}` : ''}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.status === 204) return [];
    const text = await res.text();
    const json = text ? JSON.parse(text) : [];
    if (!res.ok) {
      throw new Error(json.message || json.hint || json.error || `${table}: ${res.status} ${res.statusText}`);
    }
    return Array.isArray(json) ? json : [json];
  }

  return {
    get email() { return session?.email ?? null; },
    hasSession() { return Boolean(session?.refresh_token); },

    async signIn(email, password) { await tokenRequest('password', { email, password }); },

    /**
     * Send the browser to Google through Supabase Auth (PKCE flow). Google
     * sends it back to `redirectTo?code=…`, which finishOAuth() exchanges.
     * `hd` asks Google to show only accounts on that Workspace domain; the
     * database enforces the domain regardless.
     */
    async signInWithGoogle(redirectTo, { hd } = {}) {
      const verifier = randomString(64);
      localStorage.setItem(PKCE_KEY, verifier);
      const challenge = await pkceChallenge(verifier);
      const q = new URLSearchParams({
        provider: 'google',
        redirect_to: redirectTo,
        code_challenge: challenge,
        code_challenge_method: 's256',
        prompt: 'select_account',
      });
      if (hd) q.set('hd', hd);
      location.assign(`${base}/auth/v1/authorize?${q}`);
    },

    /** Trade the ?code= Google sent back for a session. */
    async finishOAuth(code) {
      const verifier = localStorage.getItem(PKCE_KEY);
      localStorage.removeItem(PKCE_KEY);
      if (!verifier) throw new Error('Sign-in expired — please try again.');
      await tokenRequest('pkce', { auth_code: code, code_verifier: verifier });
      return session;
    },

    async signOut() {
      const token = session?.access_token;
      writeSession(null);
      if (!token) return;
      // Best effort — the local session is already gone either way.
      try {
        await fetch(`${base}/auth/v1/logout`, {
          method: 'POST',
          headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
        });
      } catch { /* nothing to do */ }
    },

    /** Confirm the stored session still works, refreshing it if need be. */
    async verify() { return Boolean(await freshToken()); },

    select(table, params) { return rest('GET', table, { params }); },

    upsert(table, row, { onConflict } = {}) {
      const params = onConflict ? `on_conflict=${onConflict}` : '';
      return rest('POST', table, {
        params,
        body: row,
        prefer: 'resolution=merge-duplicates,return=representation',
      });
    },

    remove(table, params) { return rest('DELETE', table, { params }); },
  };
}
