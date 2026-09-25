// Weather for the day, pulled from Open-Meteo. No API key, no account, CORS
// open, and it serves both history and forecast — so a sheet backfilled three
// weeks late still gets the real weather for that night.
//
// The result is written into the sheet's editable weather field, never locked:
// "Hot · 99°/76° · Clear" is a starting point a manager can overwrite with
// whatever actually mattered ("storm rolled in at 8, patio dead").

const CODES = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Freezing fog', 51: 'Light drizzle', 53: 'Drizzle',
  55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Rain showers', 81: 'Rain showers', 82: 'Violent rain showers',
  85: 'Snow showers', 86: 'Snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with hail',
};

/** The plain-language bucket the sheet's WEATHER row used: Hot, Nice, Cold… */
function feel(high) {
  if (high === null) return '';
  if (high >= 95) return 'Hot';
  if (high >= 85) return 'Warm';
  if (high >= 70) return 'Nice';
  if (high >= 55) return 'Cool';
  if (high >= 40) return 'Cold';
  return 'Freezing';
}

/**
 * Fetch one day. Tries the forecast endpoint (which covers roughly the last
 * three months plus the week ahead) and falls back to the archive for older
 * dates. Returns null rather than throwing, so a dead network never blocks
 * someone from opening the safe.
 */
export async function fetchWeather(date, settings = {}) {
  const lat = settings.weather_lat ?? 30.2459;
  const lon = settings.weather_lon ?? -97.7674;
  const tz = settings.weather_timezone ?? 'America/Chicago';
  const query = `latitude=${lat}&longitude=${lon}`
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum'
    + `&temperature_unit=fahrenheit&precipitation_unit=inch&timezone=${encodeURIComponent(tz)}`
    + `&start_date=${date}&end_date=${date}`;

  for (const host of ['https://api.open-meteo.com/v1/forecast', 'https://archive-api.open-meteo.com/v1/archive']) {
    try {
      const res = await fetch(`${host}?${query}`);
      if (!res.ok) continue;
      const json = await res.json();
      const d = json?.daily;
      const high = d?.temperature_2m_max?.[0];
      if (high === null || high === undefined) continue;
      const low = d?.temperature_2m_min?.[0];
      const code = d?.weather_code?.[0];
      const rain = d?.precipitation_sum?.[0];
      return {
        high: Math.round(high),
        low: low === null || low === undefined ? null : Math.round(low),
        condition: CODES[code] ?? 'Unknown',
        precipitation: rain ?? 0,
        feel: feel(Math.round(high)),
      };
    } catch { /* try the next endpoint */ }
  }
  return null;
}

export function describeWeather(w) {
  if (!w) return '';
  const parts = [w.feel, w.low === null ? `${w.high}°` : `${w.high}°/${w.low}°`, w.condition];
  if (w.precipitation >= 0.05) parts.push(`${w.precipitation.toFixed(2)}" rain`);
  return parts.filter(Boolean).join(' · ');
}
