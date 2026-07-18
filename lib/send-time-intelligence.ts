export type SendWindowStatus = 'best' | 'good' | 'wait' | 'avoid';

export type SendMarket = {
  id: string;
  label: string;
  timezone: string;
  note?: string;
};

export type SendWindowRecommendation = {
  status: SendWindowStatus;
  label: string;
  tone: 'ok' | 'good' | 'wait' | 'avoid';
  marketTimezone: string;
  marketLocalTime: string;
  userTimezone: string;
  nextBestAt: string | null;
  nextBestUserTime: string | null;
  reason: string;
};

export const DASHBOARD_SEND_MARKETS: SendMarket[] = [
  { id: 'us-east', label: 'US East', timezone: 'America/New_York' },
  { id: 'us-west', label: 'US West', timezone: 'America/Los_Angeles' },
  { id: 'canada', label: 'Canada', timezone: 'America/Toronto', note: 'Default: Toronto' },
  { id: 'germany', label: 'Germany', timezone: 'Europe/Berlin' },
  { id: 'france', label: 'France', timezone: 'Europe/Paris' },
  { id: 'spain', label: 'Spain', timezone: 'Europe/Madrid' }
];

const BEST_WINDOWS = [
  [7 * 60 + 30, 9 * 60 + 30],
  [10 * 60, 11 * 60 + 30]
];

const GOOD_WINDOWS = [
  [13 * 60 + 30, 15 * 60 + 30],
  [17 * 60, 18 * 60 + 30],
  [19 * 60 + 30, 21 * 60]
];

const ALL_GOOD_WINDOWS = [...BEST_WINDOWS, ...GOOD_WINDOWS].sort((a, b) => a[0] - b[0]);

function safeTimezone(timezone?: string | null) {
  const value = String(timezone || '').trim();
  if (!value) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return value;
  } catch {
    return 'UTC';
  }
}

export function userTimezoneFallback(timezone?: string | null) {
  return safeTimezone(timezone || 'UTC');
}

function minutesInZone(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTimezone(timezone),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);
  return hour * 60 + minute;
}

function inWindow(minute: number, windows: number[][]) {
  return windows.some(([start, end]) => minute >= start && minute <= end);
}

function classifyMinute(minute: number) {
  if (inWindow(minute, BEST_WINDOWS)) return { status: 'best' as const, label: 'Best now', tone: 'ok' as const, reason: 'Buyer is inside a high-response local inbox window.' };
  if (inWindow(minute, GOOD_WINDOWS)) return { status: 'good' as const, label: 'Good now', tone: 'good' as const, reason: 'Buyer is inside an acceptable local check-email window.' };
  if (minute < 6 * 60 + 30 || minute > 21 * 60 + 30) return { status: 'avoid' as const, label: 'Avoid', tone: 'avoid' as const, reason: 'Buyer is probably asleep or offline.' };
  return { status: 'wait' as const, label: 'Wait', tone: 'wait' as const, reason: 'A better buyer-local inbox window is coming soon.' };
}

export function formatInTimezone(date: Date, timezone: string, options?: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: safeTimezone(timezone),
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    ...options
  }).format(date);
}

function findNextGoodInstant(now: Date, marketTimezone: string) {
  const startMs = now.getTime();
  const stepMs = 15 * 60 * 1000;
  for (let offset = stepMs; offset <= 48 * 60 * 60 * 1000; offset += stepMs) {
    const candidate = new Date(startMs + offset);
    const m = minutesInZone(candidate, marketTimezone);
    if (inWindow(m, ALL_GOOD_WINDOWS)) return candidate;
  }
  return null;
}

export function recommendSendWindow(params: { marketTimezone: string; userTimezone?: string | null; now?: Date }): SendWindowRecommendation {
  const now = params.now || new Date();
  const marketTimezone = safeTimezone(params.marketTimezone);
  const userTimezone = userTimezoneFallback(params.userTimezone || undefined);
  const marketMinute = minutesInZone(now, marketTimezone);
  const c = classifyMinute(marketMinute);
  const next = c.status === 'best' || c.status === 'good' ? null : findNextGoodInstant(now, marketTimezone);
  return {
    status: c.status,
    label: c.label,
    tone: c.tone,
    marketTimezone,
    marketLocalTime: formatInTimezone(now, marketTimezone),
    userTimezone,
    nextBestAt: next ? next.toISOString() : null,
    nextBestUserTime: next ? formatInTimezone(next, userTimezone, { weekday: 'short', month: 'short', day: 'numeric' }) : null,
    reason: c.reason
  };
}

export function guessBuyerTimezone(input: { country?: string | null; location?: string | null; state?: string | null; province?: string | null; timezone?: string | null }) {
  const explicit = String(input.timezone || '').trim();
  if (explicit) return safeTimezone(explicit);
  const text = `${input.country || ''} ${input.location || ''} ${input.state || ''} ${input.province || ''}`.toLowerCase();

  if (/canary|tenerife|gran canaria|las palmas|santa cruz de tenerife/.test(text)) return 'Atlantic/Canary';
  if (/spain|madrid|barcelona|valencia|sevilla|malaga|bilbao|zaragoza/.test(text)) return 'Europe/Madrid';
  if (/germany|berlin|hamburg|munich|münchen|cologne|frankfurt|stuttgart|dusseldorf|düsseldorf/.test(text)) return 'Europe/Berlin';
  if (/france|paris|lyon|marseille|toulouse|nice|nantes|bordeaux|lille/.test(text)) return 'Europe/Paris';

  if (/british columbia|vancouver|victoria/.test(text)) return 'America/Vancouver';
  if (/alberta|calgary|edmonton/.test(text)) return 'America/Edmonton';
  if (/manitoba|winnipeg|saskatchewan|regina|saskatoon/.test(text)) return 'America/Winnipeg';
  if (/nova scotia|new brunswick|halifax|moncton/.test(text)) return 'America/Halifax';
  if (/newfoundland|st john/.test(text)) return 'America/St_Johns';
  if (/canada|toronto|ontario|ottawa|montreal|quebec/.test(text)) return 'America/Toronto';

  if (/california|los angeles|san francisco|san diego|seattle|washington|oregon|portland|nevada|las vegas/.test(text)) return 'America/Los_Angeles';
  if (/colorado|denver|arizona|phoenix|utah|salt lake|idaho|montana|wyoming|new mexico/.test(text)) return 'America/Denver';
  if (/texas|chicago|illinois|dallas|houston|austin|minnesota|wisconsin|missouri|tennessee|alabama|oklahoma|louisiana/.test(text)) return 'America/Chicago';
  if (/alaska|anchorage/.test(text)) return 'America/Anchorage';
  if (/hawaii|honolulu/.test(text)) return 'Pacific/Honolulu';
  if (/united states|usa|new york|florida|miami|atlanta|georgia|boston|massachusetts|washington dc|virginia|north carolina|pennsylvania|philadelphia|new jersey/.test(text)) return 'America/New_York';

  return null;
}

export function recommendForBuyer(input: { country?: string | null; location?: string | null; state?: string | null; province?: string | null; timezone?: string | null; userTimezone?: string | null; now?: Date }) {
  const marketTimezone = guessBuyerTimezone(input);
  if (!marketTimezone) return null;
  return recommendSendWindow({ marketTimezone, userTimezone: input.userTimezone, now: input.now });
}

export function isSendWindowAllowed(input: { country?: string | null; location?: string | null; state?: string | null; province?: string | null; timezone?: string | null; userTimezone?: string | null; now?: Date }) {
  const recommendation = recommendForBuyer(input);
  if (!recommendation) return { allowed: true, recommendation: null };
  return { allowed: recommendation.status === 'best' || recommendation.status === 'good', recommendation };
}
