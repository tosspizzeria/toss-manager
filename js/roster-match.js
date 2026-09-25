// Matching a typed name to someone on the roster.
//
// The old daily tabs were typed in shorthand — "ASh", "Ry", "Mer", "Cindy" —
// while the Tip Tracker tab used full names. Reconciling those by hand every
// week is precisely the work the tracker existed to do. This does it instead.
//
// Order of attempts, stopping at the first that lands exactly one person:
//   1. the full name
//   2. an alias the roster records for them
//   3. their first name
//   4. a prefix of their first name  ("Mer" -> Mercedes)
//   5. a prefix of their full name
//
// Anything ambiguous returns null rather than guessing, so an import can report
// what it could not place instead of quietly crediting tips to the wrong person.

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');

function only(matches) {
  return matches.length === 1 ? matches[0] : null;
}

export function matchStaff(typed, roster) {
  const q = norm(typed);
  if (!q) return null;

  const exact = only(roster.filter((s) => norm(s.name) === q));
  if (exact) return exact;

  const aliased = only(roster.filter((s) => (s.aliases ?? []).some((a) => norm(a) === q)));
  if (aliased) return aliased;

  const first = only(roster.filter((s) => norm(s.name.split(/\s+/)[0]) === q));
  if (first) return first;

  const firstPrefix = only(roster.filter((s) => norm(s.name.split(/\s+/)[0]).startsWith(q)));
  if (firstPrefix) return firstPrefix;

  return only(roster.filter((s) => norm(s.name).startsWith(q)));
}

/** Split a list of typed names into resolved pairs and the ones left over. */
export function matchAll(names, roster) {
  const resolved = new Map();
  const unresolved = [];
  for (const name of names) {
    const hit = matchStaff(name, roster);
    if (hit) resolved.set(name, hit);
    else if (!unresolved.includes(name)) unresolved.push(name);
  }
  return { resolved, unresolved };
}
