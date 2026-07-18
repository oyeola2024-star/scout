import { buildSourceScoutDorks, parseSourceScoutText, searchUrl, type SourceScoutMode } from './source-scout';
import { cleanText, displayDomain, normalizeWebsite } from './normalize';

export type AutoSourceScoutInput = {
  niche?: string;
  location?: string;
  country?: string;
  sourceMode?: SourceScoutMode;
  startUrls?: string[];
  maxSearchQueries?: number;
  maxPages?: number;
  fetchTimeoutMs?: number;
  signals?: string[] | string;
};

export type AutoFetchedPage = {
  url: string;
  finalUrl: string;
  ok: boolean;
  status: number;
  title: string;
  emails: string[];
  websites: string[];
  error?: string;
};

export type AutoSourceScoutResult = {
  success: boolean;
  fetchedPages: AutoFetchedPage[];
  sourceText: string;
  parsed: ReturnType<typeof parseSourceScoutText>;
  errors: string[];
};

const EMAIL_RE = /[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/gi;
const HREF_RE = /href\s*=\s*["']([^"']+)["']/gi;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const BAD_HOST_RE = /(^|\.)(google|bing|microsoft|yahoo|facebook|instagram|linkedin|youtube|twitter|x|tiktok|pinterest|doubleclick|gstatic|googleusercontent|googletagmanager|schema|w3|cloudflare|recaptcha|hcaptcha|sentry|hotjar|aboutads|privacychoices|forbes|wikipedia|medium|reddit|quora|crunchbase|bloomberg|reuters|nytimes|bbc|cnn|cnbc|github|npmjs|themeforest)\./i;
const ASSET_RE = /\.(?:png|jpe?g|webp|gif|svg|pdf|zip|css|js|ico|woff2?|ttf|eot|mp4|mov|avi|webm|xml)(?:[?#].*)?$/i;

function uniq<T>(items: T[]) {
  return Array.from(new Set(items));
}

function stripTags(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p\s*>|<\/div\s*>|<\/li\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&commat;/gi, '@')
    .replace(/&period;|&dot;/gi, '.')
    .replace(/&#64;/g, '@')
    .replace(/&#46;/g, '.')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function deobfuscateEmailText(value: string) {
  return value
    .replace(/\s*(?:\[at\]|\(at\)|\{at\}|\sat\s)\s*/gi, '@')
    .replace(/\s*(?:\[dot\]|\(dot\)|\{dot\}|\sdot\s)\s*/gi, '.')
    .replace(/\s+@\s+/g, '@')
    .replace(/\s+\.\s+/g, '.');
}

function htmlTitle(html: string) {
  const match = html.match(TITLE_RE)?.[1] || '';
  return stripTags(match).slice(0, 90);
}

function asAbsoluteUrl(href: string, base: string) {
  const raw = cleanText(href);
  if (!raw || raw.startsWith('#') || raw.toLowerCase().startsWith('mailto:') || raw.toLowerCase().startsWith('tel:')) return '';
  try {
    return new URL(raw, base).toString();
  } catch {
    return '';
  }
}

function decodeMaybeBingRedirect(url: string) {
  try {
    const parsed = new URL(url);
    const u = parsed.searchParams.get('u');
    if (u?.startsWith('a1')) {
      const encoded = u.slice(2).replace(/_/g, '/').replace(/-/g, '+');
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      if (/^https?:\/\//i.test(decoded)) return decoded;
    }
    const direct = parsed.searchParams.get('url') || parsed.searchParams.get('q');
    if (direct && /^https?:\/\//i.test(direct)) return direct;
  } catch {}
  return url;
}

function isUsefulUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/i.test(parsed.protocol)) return false;
    const host = parsed.hostname.replace(/^www\./, '');
    if (BAD_HOST_RE.test(host)) return false;
    if (ASSET_RE.test(parsed.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

function extractLinks(html: string, baseUrl: string, limit = 80) {
  const links: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = HREF_RE.exec(html))) {
    const absolute = decodeMaybeBingRedirect(asAbsoluteUrl(match[1], baseUrl));
    if (absolute && isUsefulUrl(absolute)) links.push(absolute.split('#')[0]);
    if (links.length >= limit * 3) break;
  }
  return uniq(links).slice(0, limit);
}

function extractEmailsFromText(value: string) {
  return uniq((deobfuscateEmailText(value).match(EMAIL_RE) || [])
    .map((email) => email.toLowerCase().replace(/[),.;:]+$/, ''))
    .filter((email) => !/(example|sentry|schema|w3|cloudflare|recaptcha|hcaptcha)/i.test(email))
  ).slice(0, 50);
}

function extractWebsitesFromText(value: string) {
  const urlRe = /(?:https?:\/\/|www\.)[^\s<>'"\])}]+|\b[a-z0-9][a-z0-9\-]{1,62}(?:\.[a-z0-9][a-z0-9\-]{1,62})+\b(?:\/[^\s<>'"\])}]*)?/gi;
  return uniq((value.match(urlRe) || [])
    .map((item) => normalizeWebsite(item))
    .filter((url) => url && isUsefulUrl(url))
  ).slice(0, 100);
}

async function fetchWithTimeout(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 ScoutApp/8.27 (+https://scout-app-oyeola.vercel.app)',
        'accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.7'
      }
    });
    const contentType = res.headers.get('content-type') || '';
    const text = contentType.includes('text') || contentType.includes('html') || !contentType ? await res.text() : '';
    return { res, text };
  } finally {
    clearTimeout(timer);
  }
}

function pageToSourceLine(page: AutoFetchedPage) {
  const domain = displayDomain({ website: page.finalUrl || page.url });
  const name = page.title || domain || 'Auto scouted page';
  const parts = [name, page.finalUrl || page.url, ...page.emails, ...page.websites.slice(0, 8)].filter(Boolean);
  return parts.join(' | ');
}

export async function runAutoSourceScout(input: AutoSourceScoutInput): Promise<AutoSourceScoutResult> {
  const sourceMode = input.sourceMode || 'bing_dork';
  const maxPages = Math.max(1, Math.min(Number(input.maxPages || 20), 60));
  const maxSearchQueries = Math.max(0, Math.min(Number(input.maxSearchQueries ?? 3), 8));
  const timeoutMs = Math.max(2500, Math.min(Number(input.fetchTimeoutMs || 9000), 20000));
  const errors: string[] = [];
  const fetchedPages: AutoFetchedPage[] = [];

  const dorks = buildSourceScoutDorks({ niche: input.niche, location: input.location, country: input.country, sourceMode, signals: input.signals });
  const seeds = uniq([
    ...(input.startUrls || []).map((url) => normalizeWebsite(url)).filter(Boolean),
    ...dorks.slice(0, maxSearchQueries).map((dork) => searchUrl(sourceMode === 'google_dork' ? 'google' : 'bing', dork))
  ]);

  const queue = [...seeds];
  const seen = new Set<string>();

  while (queue.length && fetchedPages.length < maxPages) {
    const current = queue.shift() || '';
    const url = normalizeWebsite(current) || current;
    if (!url || seen.has(url)) continue;
    seen.add(url);

    try {
      const { res, text: html } = await fetchWithTimeout(url, timeoutMs);
      const finalUrl = res.url || url;
      const title = htmlTitle(html) || displayDomain({ website: finalUrl });
      const plain = stripTags(html);
      const emails = extractEmailsFromText(`${html}\n${plain}`);
      const links = extractLinks(html, finalUrl, 100);
      const websites = uniq([...links, ...extractWebsitesFromText(plain)]).filter((link) => isUsefulUrl(link)).slice(0, 40);
      fetchedPages.push({ url, finalUrl, ok: res.ok, status: res.status, title, emails, websites });

      const isSearchOrDirectory = /(^|\.)(bing|google)\.|search|directory|directories|yelp|clutch|yellowpages|mapquest|hotfrog|trustpilot|opencorporates|europages|kompass/i.test(finalUrl);
      if (isSearchOrDirectory) {
        for (const link of websites.slice(0, 25)) {
          if (!seen.has(link) && queue.length + fetchedPages.length < maxPages + 25) queue.push(link);
        }
      }
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      fetchedPages.push({ url, finalUrl: url, ok: false, status: 0, title: '', emails: [], websites: [], error: error instanceof Error ? error.message : String(error) });
    }
  }

  const sourceText = fetchedPages
    .flatMap((page) => [pageToSourceLine(page), ...page.websites.slice(0, 10).map((site) => `${page.title || displayDomain({ website: site })} | ${site}`)])
    .join('\n');

  const parsed = parseSourceScoutText({
    text: sourceText,
    niche: input.niche,
    location: input.location,
    country: input.country,
    sourceMode
  });

  return { success: true, fetchedPages, sourceText, parsed, errors };
}
