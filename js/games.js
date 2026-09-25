// The FOOTBALL tab, rebuilt.
//
// On the spreadsheet this was a hand-maintained grid of Longhorns / Cowboys /
// Texans kickoff times, typed in once a season. Here it is fetched per day from
// ESPN's public scoreboard feed, which carries the kickoff, the TV channel, and
// (for college) the AP ranking — so the "Confirm TVs are on appropriate
// channels" checklist line has the answer sitting next to it.
//
// It is deliberately collapsed behind a one-line toggle: on most nights this is
// not what the manager came here for.
//
// The three home teams and whether to include the top 25 are settings, so a
// season of Big 12 realignment does not need a code change.

const NFL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
// groups=80 limits college football to FBS; without it the feed is enormous.
const CFB = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard';

export const DEFAULT_FAVORITES = ['Texas Longhorns', 'Dallas Cowboys', 'Houston Texans'];

function compact(iso) { return iso.replace(/-/g, ''); }

function kickoffLabel(utcISO, tz) {
  if (!utcISO) return '';
  const d = new Date(utcISO);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: tz || 'America/Chicago',
  }).format(d);
}

/** ESPN puts the channel in a few different places depending on the feed. */
function channelOf(competition) {
  const geo = competition?.geoBroadcasts ?? [];
  for (const g of geo) {
    const name = g?.media?.shortName ?? g?.media?.callLetters;
    if (name) return name;
  }
  const names = (competition?.broadcasts ?? []).flatMap((b) => b?.names ?? []);
  return names[0] ?? '';
}

function rankOf(competitor) {
  const r = competitor?.curatedRank?.current;
  return typeof r === 'number' && r > 0 && r <= 25 ? r : null;
}

function parseEvent(event, league, tz, favorites) {
  const comp = event?.competitions?.[0];
  const competitors = comp?.competitors ?? [];
  const home = competitors.find((c) => c.homeAway === 'home') ?? competitors[0];
  const away = competitors.find((c) => c.homeAway === 'away') ?? competitors[1];
  const side = (c) => ({
    name: c?.team?.displayName ?? c?.team?.shortDisplayName ?? '',
    short: c?.team?.shortDisplayName ?? c?.team?.abbreviation ?? '',
    rank: rankOf(c),
    score: c?.score ?? null,
  });
  const h = side(home);
  const a = side(away);
  const favorite = favorites.some((f) => f === h.name || f === a.name);
  return {
    league,
    id: event?.id ?? `${league}-${a.short}-${h.short}`,
    away: a,
    home: h,
    kickoff: kickoffLabel(event?.date, tz),
    sortKey: event?.date ?? '',
    channel: channelOf(comp),
    state: comp?.status?.type?.state ?? event?.status?.type?.state ?? 'pre',
    detail: comp?.status?.type?.shortDetail ?? '',
    favorite,
    ranked: h.rank !== null || a.rank !== null,
  };
}

/**
 * Games worth putting on a TV for one date: anything involving the three home
 * teams, plus ranked college matchups. Returns null if the feed cannot be
 * reached, so the caller can say so rather than showing an empty night.
 */
export async function fetchGames(date, settings = {}) {
  const tz = settings.weather_timezone ?? 'America/Chicago';
  const favorites = settings.favorite_teams ?? DEFAULT_FAVORITES;
  const includeTop25 = settings.show_top_25 !== false;
  const day = compact(date);

  const pull = async (url) => {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const json = await res.json();
      return Array.isArray(json?.events) ? json.events : [];
    } catch { return null; }
  };

  const [nfl, cfb] = await Promise.all([
    pull(`${NFL}?dates=${day}`),
    pull(`${CFB}?dates=${day}&groups=80&limit=200`),
  ]);

  if (nfl === null && cfb === null) return null;

  const games = [
    ...(nfl ?? []).map((e) => parseEvent(e, 'NFL', tz, favorites)),
    ...(cfb ?? []).map((e) => parseEvent(e, 'NCAAF', tz, favorites)),
  ].filter((g) => g.favorite || (includeTop25 && g.ranked));

  // Home teams first, then earliest kickoff — the order you'd assign TVs in.
  games.sort((a, b) => (b.favorite - a.favorite) || a.sortKey.localeCompare(b.sortKey));
  return games;
}

/** "#7 Texas Longhorns at Oklahoma" */
export function matchupLabel(game) {
  const side = (s) => (s.rank ? `#${s.rank} ${s.name}` : s.name);
  return `${side(game.away)} at ${side(game.home)}`;
}
