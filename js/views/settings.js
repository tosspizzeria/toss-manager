// Settings: everything that used to be baked into the spreadsheet's cells —
// checklist wording, the bar drawer float, the tip guarantee — plus who can
// sign in and where the data lives.

import { el, clear, uuid } from '../util.js';
import { DEFAULT_FAVORITES } from '../games.js';
import { matchStaff } from '../roster-match.js';
import { store, isCloud, getConnection, setConnection, clearConnection, SETTINGS_SEED } from '../store.js';
import { createManager, setManagerPin, signOutGoogle, signedInAs } from '../auth.js';
import { ALLOWED_DOMAIN, OWNER_EMAIL, SITE_URL } from '../config.js';

function randomPin() {
  return String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0');
}

export async function renderSettings(ctx) {
  const root = clear(ctx.root);
  root.append(el('div.spinner'));

  const [managers, checklist] = await Promise.all([store().listManagers(), store().listChecklist()]);
  const conn = getConnection();
  const signedInEmail = await signedInAs();
  // Inviting is the owner's alone. Signed in with Google, that means the
  // owner's account; on a device-only install (no database) an admin PIN.
  const isOwner = isCloud()
    ? String(signedInEmail ?? '').toLowerCase() === OWNER_EMAIL
    : Boolean(ctx.manager && managers.find((m) => m.id === ctx.manager.id)?.is_admin);
  const rerender = () => renderSettings(ctx);

  // ---------------------------------------------------------------- connection
  function connectionCard() {
    const urlInput = el('input', { value: conn?.url ?? '', placeholder: 'https://xxxxxxxx.supabase.co' });
    const keyInput = el('input', { value: conn?.anonKey ?? '', placeholder: 'the anon / public key' });
    const note = el('p.hint');
    const saveBtn = el('button.btn.btn-primary', { type: 'button' }, conn ? 'Update connection' : 'Connect');
    saveBtn.addEventListener('click', () => {
      if (!urlInput.value.trim() || !keyInput.value.trim()) { note.textContent = 'Both fields are required.'; return; }
      setConnection(urlInput.value, keyInput.value);
      location.reload();
    });
    const dropBtn = el('button.btn.btn-danger', { type: 'button' }, 'Disconnect this device');
    dropBtn.addEventListener('click', () => {
      if (!confirm('Disconnect from Supabase on this device? Nothing in the database is deleted.')) return;
      clearConnection();
      location.reload();
    });

    const body = conn?.builtIn
      ? el('div.card-body', {},
        el('p.hint', 'Connected to the Toss database. Every signed-in manager on every device sees the same sheets.'))
      : el('div.card-body', {},
        el('p.hint', isCloud()
          ? 'Connected to Supabase. Every device pointed at this project sees the same sheets.'
          : 'Running on this device only — sheets are kept in this browser and nobody else can see them. Paste a Supabase URL and anon key to share them across devices. Setup steps are in SETUP.md.'),
        el('div.field', {}, el('label', 'Supabase project URL'), urlInput),
        el('div.field', {}, el('label', 'Supabase anon key'), keyInput),
        note,
        el('div.btn-row', {}, saveBtn, conn ? dropBtn : null));

    // Google account — who this device is signed in as.
    if (isCloud()) {
      const outBtn = el('button.btn.btn-danger', { type: 'button' }, 'Sign out of Google on this device');
      outBtn.addEventListener('click', async () => {
        if (!confirm('Sign out on this device? You will need your Google account to get back in.')) return;
        await signOutGoogle();
        location.reload();
      });
      body.append(
        el('hr', { style: 'border:0;border-top:1px solid var(--border);margin:18px 0' }),
        el('p.hint', `Signed in with Google as ${signedInEmail ?? 'unknown'}. Anyone with a tosspizzeria.com Google account can sign in. To remove someone, suspend them in Google Workspace and delete them under Supabase → Authentication → Users.`),
        el('div.btn-row', {}, outBtn));
    }

    return el('div.card', {},
      el('div.card-head', {}, el('h2', 'Where the data lives'), el('span.spacer'),
        el('span', { class: isCloud() ? 'tag pool' : 'tag admin' }, isCloud() ? 'Supabase' : 'this device only')),
      body);
  }

  // ------------------------------------------------------------------ managers
  function managersCard() {
    const list = el('ul.rowlist');
    for (const m of managers) {
      const pinBtn = el('button.btn.btn-sm', { type: 'button' }, 'Reset PIN');
      const activeBtn = el('button.btn.btn-sm', { type: 'button' }, m.active ? 'Deactivate' : 'Reactivate');
      const delBtn = el('button.btn.btn-sm.btn-danger', { type: 'button' }, 'Remove');
      const note = el('span.progress');

      pinBtn.addEventListener('click', async () => {
        const pin = prompt(`New 4-digit PIN for ${m.name}:`);
        if (!pin) return;
        if (!/^\d{4}$/.test(pin.trim())) { note.textContent = 'Four digits.'; return; }
        await setManagerPin(m, pin.trim());
        note.textContent = 'PIN changed';
        setTimeout(() => { note.textContent = ''; }, 2500);
      });
      activeBtn.addEventListener('click', async () => {
        await store().upsertManager({ ...m, active: !m.active });
        ctx.reloadRefs();
        rerender();
      });
      delBtn.addEventListener('click', async () => {
        if (!confirm(`Remove ${m.name}? Their initials stay on past checklists.`)) return;
        await store().deleteManager(m.id);
        ctx.reloadRefs();
        rerender();
      });

      list.append(el('li', {},
        el('div.grow', {},
          el('div.nm', m.name),
          el('div.meta', `initials ${m.initials}`)),
        m.is_admin ? el('span.tag.admin', 'admin') : null,
        m.active ? null : el('span.tag.off', 'inactive'),
        note, pinBtn, activeBtn, delBtn));
    }
    if (!managers.length) list.append(el('li', {}, el('p.hint', 'No managers yet.')));

    return el('div.card', {},
      el('div.card-head', {}, el('h2', 'Managers')),
      el('div.card-body', {},
        el('p.hint', 'A manager taps their name and types a PIN at the start of a shift. Their initials then fill in the checklists with one tap.')),
      el('div.card-body.tight', {}, list),
      el('div.card-body', {}, isOwner
        ? inviteForm()
        : el('p.hint', `New managers are invited by ${OWNER_EMAIL}.`)));
  }

  // -------------------------------------------------------------------- invite
  // Owner only. Adds the manager with a PIN, then hands back a ready-to-send
  // email (Gmail compose, or the device's mail app) with the link and PIN.
  function inviteForm() {
    const nName = el('input', { placeholder: 'Full name' });
    const nInit = el('input', { placeholder: 'initials', maxLength: 4, style: 'max-width:110px;font-family:var(--mono)' });
    const nEmail = el('input', { type: 'email', placeholder: `name@${ALLOWED_DOMAIN}` });
    const nPin = el('input', { value: randomPin(), inputMode: 'numeric', maxLength: 4, style: 'max-width:110px;font-family:var(--mono)' });
    const nAdmin = el('input', { type: 'checkbox' });
    const go = el('button.btn.btn-primary', { type: 'button' }, 'Invite manager');
    const note = el('span.progress');
    const result = el('div');

    nName.addEventListener('input', () => {
      if (!nInit.dataset.touched) {
        nInit.value = nName.value.trim().split(/\s+/).map((w) => w[0] ?? '').join('').toLowerCase().slice(0, 3);
      }
    });
    nInit.addEventListener('input', () => { nInit.dataset.touched = '1'; });

    go.addEventListener('click', async () => {
      const name = nName.value.trim();
      const email = nEmail.value.trim().toLowerCase();
      const pin = nPin.value.trim();
      if (!name) { note.textContent = 'Name required'; return; }
      if (!nInit.value.trim()) { note.textContent = 'Initials required'; return; }
      if (!email.endsWith(`@${ALLOWED_DOMAIN}`)) { note.textContent = `Needs an @${ALLOWED_DOMAIN} email — they sign in with it`; return; }
      if (!/^\d{4}$/.test(pin)) { note.textContent = 'PIN must be four digits'; return; }
      if (managers.some((m) => m.name.toLowerCase() === name.toLowerCase())) { note.textContent = `${name} is already a manager`; return; }

      go.disabled = true;
      note.textContent = 'Adding…';
      try {
        await createManager({ name, initials: nInit.value, pin, isAdmin: nAdmin.checked });
      } catch (err) { note.textContent = err.message; go.disabled = false; return; }
      note.textContent = '';
      ctx.reloadRefs();

      const first = name.split(/\s+/)[0];
      const subject = 'You\'re invited to the Toss manager sheet';
      const body = [
        `Hi ${first},`,
        '',
        'You now have access to the Toss manager sheet — safe counts, checklists and tips all live there now.',
        '',
        `1. Open ${SITE_URL} on your phone (add it to your home screen while you're there).`,
        `2. Tap "Sign in with Google" and choose your ${email} account.`,
        `3. Tap your name and enter your PIN: ${pin}`,
        '',
        'It remembers you on that phone after the first time. Keep the PIN to yourself — it is what puts your initials on the checklists.',
        '',
        'Justin',
      ].join('\n');
      const gmail = `https://mail.google.com/mail/?authuser=${encodeURIComponent(OWNER_EMAIL)}&view=cm&fs=1`
        + `&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      const mailto = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

      const copyBtn = el('button.btn', { type: 'button' }, 'Copy message');
      copyBtn.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(body); copyBtn.textContent = 'Copied'; }
        catch { copyBtn.textContent = 'Copy failed — select the text above'; }
      });
      const doneBtn = el('button.btn', { type: 'button' }, 'Done');
      doneBtn.addEventListener('click', rerender);

      clear(result).append(el('div.banner', { style: 'margin-top:14px;display:block' },
        el('p', { style: 'margin:0 0 8px' }, `${name} is added. Send the invite:`),
        el('pre', { style: 'white-space:pre-wrap;font-size:13px;margin:0 0 10px' }, body),
        el('div.btn-row', {},
          el('a.btn.btn-primary', { href: gmail, target: '_blank', rel: 'noopener', style: 'text-decoration:none' }, 'Open in Gmail'),
          el('a.btn', { href: mailto, style: 'text-decoration:none' }, 'Mail app'),
          copyBtn, doneBtn)));
      nName.value = ''; nInit.value = ''; delete nInit.dataset.touched;
      nEmail.value = ''; nPin.value = randomPin(); nAdmin.checked = false;
      go.disabled = false;
    });

    return el('div', {},
      el('h3', { style: 'margin:0 0 8px;font-size:15px' }, 'Invite a manager'),
      el('p.hint', `They sign in with their @${ALLOWED_DOMAIN} Google account, then tap their name and enter this PIN. The PIN is filled in for you; change it if you like.`),
      el('div.btn-row', {},
        nName, nInit, nEmail, nPin,
        el('label', { style: 'display:flex;gap:6px;align-items:center;font-size:13px' }, nAdmin, 'Admin'),
        go, note),
      result);
  }

  // ---------------------------------------------------------------- checklists
  function checklistCard(phase, title) {
    const items = checklist.filter((i) => i.phase === phase);
    const list = el('ul.rowlist');

    for (const item of items) {
      const label = el('input', { value: item.label, class: 'grow' });
      const order = el('input', { type: 'number', value: item.sort_order, style: 'max-width:74px;font-family:var(--mono)' });
      const saveBtn = el('button.btn.btn-sm', { type: 'button' }, 'Save');
      const delBtn = el('button.btn.btn-sm.btn-danger', { type: 'button' }, 'Retire');
      const note = el('span.progress');

      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        try {
          await store().upsertChecklistItem({ ...item, label: label.value.trim() || item.label, sort_order: Number(order.value) || item.sort_order });
          ctx.reloadRefs();
          note.textContent = 'Saved';
          setTimeout(() => { note.textContent = ''; }, 2000);
        } catch (err) { note.textContent = err.message; }
        saveBtn.disabled = false;
      });
      delBtn.addEventListener('click', async () => {
        if (!confirm(`Retire “${item.label}”? Past sheets keep the initials already on it.`)) return;
        await store().upsertChecklistItem({ ...item, active: false });
        ctx.reloadRefs();
        rerender();
      });

      list.append(el('li', {}, order, el('div.grow', {}, label), note, saveBtn, delBtn));
    }
    if (!items.length) list.append(el('li', {}, el('p.hint', 'No items yet.')));

    const newLabel = el('input', { placeholder: 'New checklist line', class: 'grow' });
    const addBtn = el('button.btn.btn-primary', { type: 'button' }, 'Add');
    addBtn.addEventListener('click', async () => {
      if (!newLabel.value.trim()) return;
      addBtn.disabled = true;
      await store().upsertChecklistItem({
        id: uuid(), phase, label: newLabel.value.trim(), active: true,
        sort_order: (items.at(-1)?.sort_order ?? 0) + 1,
      });
      ctx.reloadRefs();
      rerender();
    });

    return el('div.card', {},
      el('div.card-head', {}, el('h2', title), el('span.spacer'),
        el('span.progress', `${items.length} items`)),
      el('div.card-body.tight', {}, list),
      el('div.card-body', {}, el('div.btn-row', {}, newLabel, addBtn)));
  }

  // -------------------------------------------------------------------- numbers
  function numbersCard() {
    const fields = [
      { key: 'bar_drawer_float', label: 'Cash left in the bar drawer', hint: 'Shown on the cash-in count as a reminder.', money: true },
      { key: 'tip_minimum_hourly', label: 'Guaranteed hourly tip rate', hint: 'Each person’s tips are checked against this; the top-up column is the gap.', money: true },
      { key: 'cash_pickup_suggest_at', label: 'Suggest a pickup when the safe reaches', hint: 'The safe balance rolls until a pickup. Set 0 to turn the nudge off.', money: true },
      { key: 'weather_zip', label: 'Weather zip code', hint: 'Shown on the lookup button.' },
      { key: 'weather_lat', label: 'Weather latitude' },
      { key: 'weather_lon', label: 'Weather longitude', hint: 'Zip 78704 is 30.2459, −97.7674. Change both if the location moves.' },
    ];

    const body = el('div.card-body.grid.grid-2');
    const inputs = new Map();
    for (const f of fields) {
      const current = ctx.settings[f.key] ?? SETTINGS_SEED[f.key];
      const input = el('input', {
        value: current ?? '',
        type: typeof current === 'number' ? 'number' : 'text',
        step: f.money ? '0.01' : 'any',
        inputMode: typeof current === 'number' ? 'decimal' : 'text',
      });
      inputs.set(f.key, { input, numeric: typeof current === 'number' });
      body.append(el('div.field', {}, el('label', f.label), input, f.hint ? el('p.hint', f.hint) : null));
    }

    const note = el('span.progress');
    const saveBtn = el('button.btn.btn-primary', { type: 'button' }, 'Save numbers');
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      note.textContent = 'Saving…';
      try {
        for (const [key, { input, numeric }] of inputs) {
          const value = numeric ? Number(input.value) : input.value.trim();
          if (numeric && Number.isNaN(value)) throw new Error(`${key} must be a number`);
          await store().setSetting(key, value);
        }
        await ctx.reloadRefs();
        note.textContent = 'Saved';
      } catch (err) { note.textContent = err.message; }
      saveBtn.disabled = false;
    });

    return el('div.card', {},
      el('div.card-head', {}, el('h2', 'Numbers')),
      body,
      el('div.card-body', {}, el('div.btn-row', {}, saveBtn, note)));
  }

  // --------------------------------------------------------------- payout lines
  function payoutLinesCard() {
    const lines = ctx.settings.payout_lines ?? SETTINGS_SEED.payout_lines;
    const list = el('ul.rowlist');
    const labels = new Map();
    const kinds = new Map();

    for (const line of lines) {
      const label = el('input', { class: 'grow' , value: line.label });
      const kind = el('select', { style: 'max-width:230px' });
      kind.append(
        el('option', { value: 'tip', selected: line.kind === 'tip' }, 'Feeds the tip pool'),
        el('option', { value: 'safe', selected: line.kind !== 'tip' }, 'Cash out of the safe'));
      labels.set(line.key, label);
      kinds.set(line.key, kind);
      list.append(el('li', {},
        el('div.grow', {}, label,
          el('div.meta', [
            line.auto === 'cash_in_total' ? 'calculated from the cash-in count' : 'typed in',
            line.note ?? null,
          ].filter(Boolean).join(' — '))),
        kind));
    }

    const note = el('span.progress');
    const saveBtn = el('button.btn.btn-primary', { type: 'button' }, 'Save payout lines');
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        await store().setSetting('payout_lines', lines.map((l) => ({
          ...l,
          label: labels.get(l.key).value.trim() || l.label,
          kind: kinds.get(l.key).value,
        })));
        await ctx.reloadRefs();
        note.textContent = 'Saved';
      } catch (err) { note.textContent = err.message; }
      saveBtn.disabled = false;
    });

    return el('div.card', {},
      el('div.card-head', {}, el('h2', 'Payout lines')),
      el('div.card-body', {},
        el('p.hint', 'Two kinds of line, and the difference matters. “Feeds the tip pool” lines are payroll figures — Team Tip Share and Cash In Hand add up to the sheet’s Tip Share Tips Net, and none of that money leaves the safe. “Cash out of the safe” lines are cash that really walks out: petty cash, kitchen beers, the run to the bank.')),
      el('div.card-body.tight', {}, list),
      el('div.card-body', {}, el('div.btn-row', {}, saveBtn, note)));
  }

  // -------------------------------------------------------------------- games
  function gamesCard() {
    const teams = el('input', {
      value: (ctx.settings.favorite_teams ?? DEFAULT_FAVORITES).join(', '),
      placeholder: 'Texas Longhorns, Dallas Cowboys, Houston Texans',
    });
    const top25 = el('input', { type: 'checkbox', checked: ctx.settings.show_top_25 !== false });
    const note = el('span.progress');
    const saveBtn = el('button.btn.btn-primary', { type: 'button' }, 'Save teams');
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        await store().setSetting('favorite_teams',
          teams.value.split(',').map((t) => t.trim()).filter(Boolean));
        await store().setSetting('show_top_25', top25.checked);
        await ctx.reloadRefs();
        note.textContent = 'Saved';
      } catch (err) { note.textContent = err.message; }
      saveBtn.disabled = false;
    });

    return el('div.card', {},
      el('div.card-head', {}, el('h2', 'Game day')),
      el('div.card-body', {},
        el('p.hint', 'The day sheet carries a collapsed panel of what is on the TVs, with these teams pulled to the top. Use full ESPN team names, comma separated.'),
        el('div.field', {}, el('label', 'Teams to highlight'), teams),
        el('label', { style: 'display:flex;gap:8px;align-items:center;font-size:14px;margin-bottom:12px' },
          top25, 'Also show ranked college matchups (top 25)'),
        el('div.btn-row', {}, saveBtn, note)));
  }

  // -------------------------------------------------------------------- import
  // Brings in the August 2026 import file, or any JSON this tool exported. Day sheets
  // are matched on business date, so re-importing updates rather than doubles.
  function importCard() {
    const note = el('p.hint');
    const file = el('input', { type: 'file', accept: 'application/json', style: 'display:none' });
    const fileBtn = el('button.btn.btn-primary', { type: 'button' }, 'Import a file');

    async function applyImport(payload, label) {
      const checklist = await store().listChecklist();
      // Punctuation-insensitive, so a comma added to a checklist line later
      // does not orphan the initials already recorded against it.
      const key = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const byLabel = new Map(checklist.map((i) => [key(i.label), i]));

      // Roster first, so tip rows can be tied to real staff ids.
      const existing = await store().listStaff();
      let addedStaff = 0;
      for (const person of payload.staff ?? []) {
        if (existing.some((s) => s.name.toLowerCase() === person.name.toLowerCase())) continue;
        await store().upsertStaff({ id: uuid(), ...person });
        addedStaff++;
      }
      const roster = await store().listStaff();
      const unplaced = new Set();

      let days = 0;
      for (const day of payload.day_sheets ?? []) {
        const resolve = (map) => Object.fromEntries(
          Object.entries(map ?? {})
            .map(([label, initials]) => [byLabel.get(key(label))?.id, initials])
            .filter(([id]) => id));

        const sheet = {
          ...day,
          open_checklist: day.open_checklist ?? resolve(day.open_checklist_by_label),
          close_checklist: day.close_checklist ?? resolve(day.close_checklist_by_label),
          // Nicknames off the old tabs get matched to the roster here.
          tip_rows: (day.tip_rows ?? []).map((r) => {
            const hit = matchStaff(r.name, roster);
            if (!hit && r.name) unplaced.add(r.name);
            return {
              id: uuid(),
              staff_id: hit?.id ?? null,
              name: hit?.name ?? r.name,
              role: hit?.role ?? '',
              hours: r.hours,
            };
          }),
        };
        delete sheet.open_checklist_by_label;
        delete sheet.close_checklist_by_label;
        delete sheet.source_tab;
        await store().saveDay(sheet);
        days++;
      }
      await ctx.reloadRefs();
      note.textContent = `${label}: ${days} night${days === 1 ? '' : 's'} imported`
        + (addedStaff ? `, ${addedStaff} added to the roster` : '')
        + (unplaced.size
          ? `. Could not place ${[...unplaced].join(', ')} — add them under Staff and import again.`
          : '.');
    }

    fileBtn.addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const chosen = file.files?.[0];
      if (!chosen) return;
      note.textContent = 'Reading…';
      try {
        await applyImport(JSON.parse(await chosen.text()), chosen.name);
      } catch (err) { note.textContent = `Import failed — ${err.message}`; }
      file.value = '';
    });

    return el('div.card', {},
      el('div.card-head', {}, el('h2', 'Import')),
      el('div.card-body', {},
        el('p.hint', 'Bring in the August 2026 file from the old sheet (august-2026.json) or a backup this tool downloaded. Staff pay data is kept out of the website itself, so the file is picked from your device. Nights are matched on date, so importing twice is safe.'),
        el('div.btn-row', {}, fileBtn),
        file,
        note));
  }

  // -------------------------------------------------------------------- backup
  function backupCard() {
    const note = el('span.progress');
    const exportBtn = el('button.btn', { type: 'button' }, 'Download a JSON backup');
    exportBtn.addEventListener('click', async () => {
      note.textContent = 'Gathering…';
      const days = await store().recentDays(2000);
      const payload = {
        exported_at: new Date().toISOString(),
        settings: ctx.settings,
        staff: ctx.staff,
        managers: (await store().listManagers()).map(({ pin_hash, ...rest }) => rest),
        checklist: await store().listChecklist(),
        day_sheets: days,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = el('a', { href: URL.createObjectURL(blob), download: `toss-manager-sheets-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      note.textContent = `${days.length} sheets exported`;
    });

    return el('div.card', {},
      el('div.card-head', {}, el('h2', 'Backup')),
      el('div.card-body', {},
        el('p.hint', 'Every sheet, plus the roster and settings, in one file. PINs are left out.'),
        el('div.btn-row', {}, exportBtn, note)));
  }

  clear(root);
  root.append(
    el('div.cal-head', {}, el('h1', 'Settings')),
    connectionCard(),
    managersCard(),
    el('div.grid.grid-2', {},
      checklistCard('open', 'Opening checklist'),
      checklistCard('close', 'Closing checklist')),
    numbersCard(),
    payoutLinesCard(),
    gamesCard(),
    importCard(),
    backupCard(),
  );
}
