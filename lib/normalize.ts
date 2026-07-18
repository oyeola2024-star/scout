const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

export function cleanText(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => cleanText(item)).filter(Boolean).join(' ');
  if (value && typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value ?? '').replace(/\u00a0/g, ' ').trim();
}

export function extractEmail(value: unknown): string {
  const raw = cleanText(value).toLowerCase();
  if (!raw) return '';
  const decoded = raw
    .replace(/^mailto:/, '')
    .replace(/\s*(\[at\]|\(at\)|\sat\s)\s*/g, '@')
    .replace(/\s*(\[dot\]|\(dot\)|\sdot\s)\s*/g, '.')
    .replace(/\s*@\s*/g, '@')
    .replace(/\s*\.\s*/g, '.');
  const match = decoded.match(EMAIL_RE);
  return match?.[0] || '';
}

export function normalizeEmail(value: unknown): string {
  return extractEmail(value);
}

export function normalizeWebsite(value: unknown): string {
  const raw = cleanText(value).toLowerCase();
  if (!raw) return '';
  const noMailto = raw.replace(/^mailto:/, '');
  if (extractEmail(noMailto) && !/https?:\/\//i.test(noMailto) && !/^www\./i.test(noMailto)) return '';
  const domainLike = noMailto.match(/(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^^\s,;)]*)?/i)?.[0] || '';
  if (!domainLike) return '';
  if (/^https?:\/\//i.test(domainLike)) return domainLike;
  return `https://${domainLike}`;
}

export function domainFromWebsite(value: unknown): string {
  const raw = cleanText(value).toLowerCase();
  if (!raw) return '';
  if (extractEmail(raw) && !/https?:\/\//i.test(raw) && !/^www\./i.test(raw)) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return raw.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].replace(/[^a-z0-9.-]/g, '');
  }
}

export function normalizePhone(value: unknown): string {
  const raw = cleanText(value);
  const phone = raw.replace(/[^+0-9]/g, '');
  return phone.replace(/\D/g, '').length >= 7 ? phone : '';
}

export function makeNormalizedKey(input: {
  email?: unknown;
  domain?: unknown;
  website?: unknown;
  name?: unknown;
  phone?: unknown;
}): string {
  const email = normalizeEmail(input.email);
  if (email) return `email:${email}`;

  const domain = domainFromWebsite(input.domain || input.website);
  if (domain) return `domain:${domain}`;

  const phone = normalizePhone(input.phone);
  if (phone) return `phone:${phone}`;

  const name = cleanText(input.name).toLowerCase().replace(/\s+/g, ' ');
  if (name) return `name:${name}`;

  return '';
}

export function displayDomain(input: { domain?: unknown; website?: unknown; email?: unknown }): string {
  const direct = domainFromWebsite(input.domain || input.website);
  if (direct) return direct;
  const email = normalizeEmail(input.email);
  return email.includes('@') ? email.split('@')[1] : '';
}

const NON_UNIQUE_BUSINESS_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'icloud.com', 'aol.com', 'proton.me', 'protonmail.com',
  'google.com', 'facebook.com', 'instagram.com', 'linkedin.com', 'youtube.com', 'youtu.be',
  'tiktok.com', 'x.com', 'twitter.com', 'pinterest.com', 'reddit.com', 'wikipedia.org',
  'yelp.com', 'trustpilot.com', 'yellowpages.com', 'clutch.co', 'g2.com', 'github.com',
  'shopify.com', 'apps.shopify.com', 'wordpress.org', 'medium.com', 'quora.com'
]);

function isNonUniqueBusinessDomain(domain: string): boolean {
  const normalized = String(domain || '').trim().toLowerCase().replace(/^www\./, '');
  if (!normalized) return true;
  for (const blocked of NON_UNIQUE_BUSINESS_DOMAINS) {
    if (normalized === blocked || normalized.endsWith(`.${blocked}`)) return true;
  }
  return false;
}

/**
 * Returns every stable identity that can prove two records are the same lead.
 * Email, genuine business domain and phone are checked independently. The
 * existing normalized key is retained for backwards compatibility and name
 * is used only when no stronger identity exists.
 */
export function businessIdentityKeys(input: {
  email?: unknown;
  domain?: unknown;
  website?: unknown;
  phone?: unknown;
  name?: unknown;
  normalized_key?: unknown;
}): string[] {
  const keys = new Set<string>();
  const email = normalizeEmail(input.email);
  const domain = domainFromWebsite(input.domain || input.website);
  const phone = normalizePhone(input.phone);
  const supplied = cleanText(input.normalized_key).toLowerCase();

  if (email) keys.add(`email:${email}`);
  if (domain && !isNonUniqueBusinessDomain(domain)) keys.add(`domain:${domain}`);
  if (phone) keys.add(`phone:${phone}`);

  if (supplied) {
    const [kind, ...rest] = supplied.split(':');
    const value = rest.join(':');
    if (kind !== 'domain' || (value && !isNonUniqueBusinessDomain(value))) keys.add(supplied);
  }

  if (!keys.size) {
    const name = cleanText(input.name).toLowerCase().replace(/\s+/g, ' ');
    if (name) keys.add(`name:${name}`);
  }

  return Array.from(keys).sort();
}
