# Toss Manager Sheet — setup

Two stages. Stage one puts the tool online and it works immediately, storing
sheets in whatever browser you open it in. Stage two connects a free database
so every manager on every device sees the same sheets. Do stage two before
anyone relies on it.

---

## Stage 1 · Get it online (2 minutes)

The tool is plain HTML, CSS and JavaScript with no build step and no external
scripts, so GitHub Pages serves it as-is.

1. Go to the repo → **Settings** → **Pages**.
2. Source: **Deploy from a branch**. Branch: **main**. Folder: **/ (root)**. Save.
3. Custom domain: `manager.tosspizzeria.com` (the `CNAME` file sets this). In
   GoDaddy DNS for tosspizzeria.com there is a CNAME record `manager` →
   `tosspizzeria.github.io`.
4. Once the DNS check is green and the certificate is issued, tick
   **Enforce HTTPS**. It is live at:

   <https://manager.tosspizzeria.com/>

Open it, create yourself as the first manager, and it works. At this stage the
header says **this device only** — the sheets live in that one browser and
nobody else can see them. Fine for kicking the tyres, not for running the
restaurant.

---

## Stage 2 · Connect the database (about 10 minutes, free)

### 2.1 Make the project

1. Sign up at <https://supabase.com> (free tier is plenty — this is a few
   thousand rows a year).
2. **New project**. Name it `toss-manager`. Pick a strong database password and
   put it in your password manager. Region: whichever US one is closest.
3. Wait for it to finish provisioning.

### 2.2 Create the tables

1. In the project, open **SQL Editor** → **New query**.
2. Open `schema.sql` from this repo, copy the whole file, paste it in.
3. Hit **Run**. It creates the tables, turns on row level security, and seeds
   your opening and closing checklists exactly as they read on the August 2026
   sheet.

Re-running it later is safe — it will not duplicate or wipe anything.

### 2.3 Create the restaurant login

This is the one account each device signs in with once. Managers never type it
after setup; they use their PIN.

1. **Authentication** → **Users** → **Add user** → **Create new user**.
2. Email: something you control, e.g. `manager@tosspizzeria.com`.
   Password: long and random, saved in your password manager.
3. Tick **Auto Confirm User** so it works without an email round trip.

### 2.4 Point the tool at it

1. **Project Settings** → **API**. Copy:
   - **Project URL** (looks like `https://abcdefgh.supabase.co`)
   - **anon** / **public** key (the long one labelled `anon`, *not* `service_role`)
2. Open the tool → **Settings** → **Where the data lives**. Paste both, hit
   **Connect**. The page reloads.
3. Still in Settings, under **Pair this device**, sign in with the email and
   password from 2.3.
4. Add your managers (name, initials, 4-digit PIN) and your staff roster.

Repeat step 3 on each tablet or phone. Each device pairs once and stays paired.

> The anon key is designed to be public — it identifies the project, it does not
> grant access. Row level security is what protects the data: every table
> requires a signed-in user, so an unpaired device gets nothing back. Never put
> the **service_role** key anywhere near this app.

---

## What replaces what

| On the spreadsheet | In the tool |
| --- | --- |
| Copy the `Daily` tab, rename it to today's date | Open `#/day/2026-08-22`, or click **Tonight** |
| Click back to yesterday's tab to check the safe | The opening count is compared to last night automatically, bill by bill |
| One file per month | One calendar, searchable by date, with a month rollup |
| `Tip Tracker` tab, retyped weekly from the daily tabs | Generated from the nightly sheets — nothing keyed in twice |
| `FOOTBALL` tab, typed once a season | A collapsed panel per day: Longhorns / Cowboys / Texans plus the top 25, with the channel |
| `#DIV/0!` in the tip columns | Zero hours shows `$0` |
| `Payouts` as one typed total with no breakdown | Named lines, each either a tip-pool figure or cash out of the safe |
| Weather typed by hand | Looked up for zip 78704, still editable — and your wording is never overwritten |

## How the money actually works

Reconstructed from the August 2026 workbook and verified against all 21
filled-in nights. `js/calc.js` is the only place these live.

**The safe.**

```
open total     = counted bills + cash infusion
expected close = open total + cash in − cash out of the safe
over / short   = counted close − expected close
```

Cash in is the bar drawer count (leaving the drawer float behind); it goes
*into* the safe, which is why it is added before payouts come out. Nothing
targets a fixed float — the balance rolls night to night until a pickup. Across
August it rolled $2,186 up to $4,346 before the $3,140 run to the bank on the
22nd.

**Payout lines come in two kinds, and the difference matters.**

*Tip-pool lines* are payroll figures. They do **not** leave the safe:

```
tip pool ("Tip Share Tips Net") = Team Tip Share (credit card tips, typed)
                                + Cash In Hand   (the cash-in count, calculated)
```

On 8/21 the tip share was $760.34 while only $41 actually left the safe. Tips
reach staff through payroll, so subtracting them from the safe would show it
short by the whole tip share every night.

*Safe lines* are cash that really walks out: Delivery, Kitchen Beers, and the
Cash Pickup for Deposit.

**Tips.** Split straight by hours, then floored:

```
pool rate    = pool / total hours          (the same for everyone)
share_i      = pool × hours_i / total hours
minimum_i    = hours_i × $20
to payroll_i = max(share_i, minimum_i)     ← the Tip Tracker figure
house top-up = Σ (to payroll_i − share_i)
```

The last two lines are the part worth knowing: **the Tip Tracker tab was never
the raw pool share — it was the $20/hr guarantee.** On 63 of August's 83
staff-nights those two numbers differ, and the tool now shows the guaranteed
figure wherever payroll is the audience. All 83 cells reproduce the old tab
exactly.

**Net sales** is two entries summed — in house and delivery — as on the sheet
(`B32 = SUM(F22, F24)`).

## Two things the old sheet could not catch

Both fell out of importing the real month:

- **A $1 break between 8/6 and 8/7.** The 6th closed at $2,823.00 and the 7th
  opened at $2,824.00. Nothing in a spreadsheet compares two tabs, so it went
  unnoticed. The day sheet now says so before you finish counting.
- **A cash infusion never reaches the reconciliation.** The sheet totals it at
  `D20` but the expected close reads `D18`, the bill total alone, so adding cash
  to the safe would read as OVER by that amount. The field was never used in
  August, so nothing was actually wrong — but the tool includes it, which is the
  behaviour you want if you ever do use it.

## Importing August 2026

The August 2026 nights from the old workbook are **not** published with this
site, because the file holds staff names, hours and tip payouts and this repo
is public. Keep `august-2026.json` on a manager's device and use
`Settings → Import → Import a file`. Nights are keyed on date, so importing
twice updates rather than doubles.

The import file, the parity test suites and the original data live in the
private `justinadelacruz/personalprojects` repo under `docs/toss/`.

## Notes and limits

- **Weather** uses Open-Meteo and the **game panel** uses ESPN's public
  scoreboard feed. Neither needs a key or an account, and neither was exercised
  against the live service from the sandbox this was built in — that network
  blocks both hosts. The parsing and the failure paths are tested; the live
  calls need one look on first run. Both degrade to "type it in" / "schedule
  unavailable" rather than breaking the page.
- **The manager field is free text**, because the real sheets say things like
  "Mer,Ash,Sawyer" when three people covered a shift. The roster is offered as
  suggestions, not a constraint.
- **Bills only** — no coin rows, matching the sheet.
- **One location.** Everything is scoped to South 1st. Adding a second location
  later means a `location_id` on `day_sheets` and a picker in the header.
- **Deleting a staff member or checklist line** never rewrites history. Past
  sheets keep the names, numbers and initials already recorded on them.
