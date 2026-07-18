import { cleanText, displayDomain, domainFromWebsite, normalizeWebsite } from './normalize';
import { findEmailCandidates, validateEmailCandidate, type EmailCandidateDecision } from './email-candidate-rules';

type BusinessLike = {
  name?: unknown;
  email?: unknown;
  website?: unknown;
  domain?: unknown;
  category?: unknown;
  location?: unknown;
  raw?: unknown;
};

type PageResult = {
  url: string;
  status: 'fetched' | 'failed' | 'skipped';
  httpStatus?: number;
  bytes?: number;
  title?: string;
  emails: Array<EmailCandidateDecision & { pageUrl: string; sourceText?: string }>;
  linksFound: number;
  reason?: string;
};

export type DeepWebsiteFinderResult = {
  success: boolean;
  method: 'deep_website_finder';
  website: string;
  domain: string;
  email: string;
  decision: EmailCandidateDecision;
  pagesChecked: number;
  pagesAttempted: number;
  pages: PageResult[];
  acceptedCandidates: Array<EmailCandidateDecision & { pageUrl: string; sourceText?: string }>;
  rejectedCandidates: Array<{ email: string; reason: string; pageUrl: string; sourceField: string }>;
  sourceUrl: string;
  sourceType: string;
  reason: string;
  errors: string[];
};

const CONTACT_KEYWORDS = [
  'contact', 'contact-us', 'contactus', 'contactez', 'nous-contacter', 'kontakt', 'kontaktieren', 'contacto', 'contatti',
  'about', 'about-us', 'team', 'staff', 'people', 'support', 'help', 'customer-service', 'customerservice', 'service',
  'impressum', 'imprint', 'privacy', 'legal', 'terms', 'locations', 'store', 'stores', 'booking', 'book', 'enquiry',
  'enquiries', 'inquiry', 'inquiries', 'wholesale', 'b2b', 'retailers', 'stockists', 'faq', 'shipping', 'returns', 'order'
];

const LOW_VALUE_LINK_RE = /\.(png|jpe?g|webp|gif|svg|pdf|zip|css|js|ico|woff2?|ttf|eot|mp4|mov|avi|webm)(\?|#|$)/i;

function rootDomain(value: string) {
  const host = domainFromWebsite(value).toLowerCase().replace(/^www\./, '');
  if (!host) return '';
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return host;
  // Keep common two-level public suffixes a little safer without shipping a huge PSL.
  const lastTwo = parts.slice(-2).join('.');
  const lastThree = parts.slice(-3).join('.');
  if (/\.(co|com|org|net|ac|gov)\.[a-z]{2}$/i.test(lastThree)) return lastThree;
  return lastTwo;
}

function sameSite(url: string, root: string) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return Boolean(root && (host === root || host.endsWith(`.${root}`)));
  } catch {
    return false;
  }
}

function cleanUrl(value: string, base?: string) {
  const raw = cleanText(value).replace(/^['"]|['"]$/g, '').trim();
  if (!raw || raw.startsWith('#') || /^(tel:|sms:|javascript:|data:)/i.test(raw)) return '';
  if (/^mailto:/i.test(raw)) return raw;
  try {
    const url = new URL(raw, base || undefined);
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function decodeEntities(input: string) {
  return input
    .replace(/\\u([0-9a-f]{4})/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&commat;/gi, '@')
    .replace(/&period;/gi, '.')
    .replace(/&dot;/gi, '.')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/gi, ' ');
}

function decodeCloudflareEmail(hex: string) {
  const clean = String(hex || '').replace(/[^a-f0-9]/gi, '');
  if (clean.length < 4 || clean.length % 2) return '';
  const key = parseInt(clean.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < clean.length; i += 2) {
    out += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16) ^ key);
  }
  return out.includes('@') ? out : '';
}

function extractCloudflareEmails(html: string) {
  const emails: string[] = [];
  const patterns = [
    /data-cfemail=["']([a-f0-9]+)["']/gi,
    /cdn-cgi\/l\/email-protection#([a-f0-9]+)/gi
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const decoded = decodeCloudflareEmail(match[1] || '');
      if (decoded) emails.push(decoded);
    }
  }
  return Array.from(new Set(emails.map((item) => item.toLowerCase())));
}

function extractTitle(html: string) {
  const match = html.match(/<title[^>]*>([\s\S]{0,180}?)<\/title>/i);
  return match ? decodeEntities(match[1] || '').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
}

function htmlToText(html: string) {
  const keepMailto = Array.from(html.matchAll(/mailto:([^"'<>\s?#]+)/gi)).map((m) => ` ${m[1]} `).join(' ');
  const cfEmails = extractCloudflareEmails(html).join(' ');
  const schemaOrgEmails = Array.from(html.matchAll(/"email"\s*:\s*"([^"]+@[^"]+)"/gi)).map((m) => ` ${m[1]} `).join(' ');
  const dataEmails = Array.from(html.matchAll(/data-[a-z0-9_-]*email=["']([^"']+@[^"']+)["']/gi)).map((m) => ` ${m[1]} `).join(' ');
  const noScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  const visible = noScripts
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<\/div\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(`${keepMailto} ${cfEmails} ${schemaOrgEmails} ${dataEmails} ${visible}`)
    .replace(/\s+/g, ' ')
    .slice(0, 260000);
}

function extractLinks(html: string, pageUrl: string, siteRoot: string) {
  const links = new Map<string, { url: string; label: string; score: number }>();
  const hrefRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(hrefRe)) {
    const href = decodeEntities(match[1] || '').trim();
    const label = decodeEntities(String(match[2] || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 120);
    const url = cleanUrl(href, pageUrl);
    if (!url) continue;
    if (/^mailto:/i.test(url)) {
      links.set(url, { url, label: label || 'mailto', score: 100 });
      continue;
    }
    if (!sameSite(url, siteRoot)) continue;
    if (LOW_VALUE_LINK_RE.test(url)) continue;
    const hay = `${url} ${label}`.toLowerCase();
    const keywordScore = CONTACT_KEYWORDS.reduce((score, key) => score + (hay.includes(key) ? 20 : 0), 0);
    const shortPathScore = (() => {
      try {
        const pathDepth = new URL(url).pathname.split('/').filter(Boolean).length;
        return pathDepth <= 2 ? 8 : 0;
      } catch { return 0; }
    })();
    const score = keywordScore + shortPathScore;
    if (score > 0 && !links.has(url)) links.set(url, { url, label, score });
  }
  return Array.from(links.values()).sort((a, b) => b.score - a.score).slice(0, 18);
}

function likelyContactUrlCandidates(homepage: string) {
  const paths = [
    '/contact', '/contact-us', '/contactus', '/contact-us/', '/contact/', '/kontakt', '/kontakt/', '/kontaktieren',
    '/contacto', '/contactez-nous', '/nous-contacter', '/contatti', '/about', '/about-us', '/about-us/', '/team', '/staff',
    '/support', '/help', '/customer-service', '/customerservice', '/service', '/services', '/impressum', '/impressum/',
    '/imprint', '/privacy', '/legal', '/terms', '/faq', '/shipping', '/returns', '/wholesale', '/b2b', '/retailers',
    '/pages/contact', '/pages/contact-us', '/pages/contact-us/', '/pages/about', '/pages/about-us', '/pages/customer-service',
    '/pages/support', '/pages/help', '/pages/faq', '/pages/wholesale', '/pages/stockists', '/a/contact', '/apps/contact-form',
    '/en/contact', '/en/contact-us', '/de/kontakt', '/de/impressum', '/fr/contact', '/fr/contactez-nous', '/es/contacto'
  ];
  try {
    const base = new URL(homepage);
    return paths.map((path) => new URL(path, base.origin).toString());
  } catch {
    return [];
  }
}

async function fetchText(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; ScoutAppEmailFinder/8.13; +https://scout-app-oyeola.vercel.app)',
        'accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.2'
      }
    });
    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();
    return { ok: response.ok && /text|html|xml|json|javascript/i.test(contentType || 'text/html'), status: response.status, text, contentType };
  } finally {
    clearTimeout(timer);
  }
}

function buildWebsite(business: BusinessLike) {
  const raw = cleanText(business.website || business.domain || '');
  if (!raw) return '';
  return normalizeWebsite(raw) || (/^[a-z0-9.-]+\.[a-z]{2,}/i.test(raw) ? `https://${raw}` : '');
}

function sourceTypeFromUrl(url: string) {
  const lower = url.toLowerCase();
  if (lower.startsWith('mailto:')) return 'mailto_link';
  if (lower.includes('contact')) return 'contact_page';
  if (lower.includes('impressum') || lower.includes('imprint')) return 'impressum_page';
  if (lower.includes('about') || lower.includes('team') || lower.includes('staff')) return 'about_team_page';
  if (lower.includes('privacy') || lower.includes('legal') || lower.includes('terms')) return 'legal_page';
  return 'website_page';
}


function contactPageScore(url: string) {
  const lower = String(url || '').toLowerCase();
  if (/mailto:/.test(lower)) return 60;
  if (/contact|kontakt|contacto|contactez|contatti|nous-contacter/.test(lower)) return 55;
  if (/customer-service|support|help|service|impressum|imprint/.test(lower)) return 42;
  if (/about|team|staff|people|wholesale|b2b/.test(lower)) return 28;
  return 0;
}

function roleMailboxScore(email: string) {
  const local = String(email || '').split('@')[0]?.toLowerCase() || '';
  if (/^(info|hello|contact|support|sales|service|customerservice|customer\.service|orders|order|care|help|team|office|admin|shop|store|b2b|wholesale)$/.test(local)) return 35;
  if (/^(marketing|press|media|business|partners|partnerships)$/.test(local)) return 18;
  return 0;
}

function bestMainInboxRank(item: EmailCandidateDecision & { pageUrl?: string; sourceText?: string }) {
  return item.score + contactPageScore(item.pageUrl || '') + roleMailboxScore(item.email) + (item.promote ? 100 : 0) + (item.sourceEvidence ? 25 : 0);
}

export async function findEmailsDeepFromWebsite(business: BusinessLike, options?: { maxPages?: number; timeoutMs?: number }): Promise<DeepWebsiteFinderResult> {
  const website = buildWebsite(business);
  const domain = rootDomain(cleanText(business.domain || displayDomain({ domain: business.domain, website: business.website, email: business.email }) || website));
  const maxPages = Math.max(1, Math.min(18, options?.maxPages || 10));
  const timeoutMs = Math.max(2500, Math.min(12000, options?.timeoutMs || 6500));
  const pages: PageResult[] = [];
  const errors: string[] = [];
  const acceptedCandidates: Array<EmailCandidateDecision & { pageUrl: string; sourceText?: string }> = [];
  const rejectedCandidates: Array<{ email: string; reason: string; pageUrl: string; sourceField: string }> = [];

  const emptyDecision: EmailCandidateDecision = {
    email: '', valid: false, promote: false, score: 0, quality: 'rejected', sourceEvidence: '', sourceField: '', reasons: ['No website/domain available for deep search.']
  };

  if (!website || !domain) {
    return { success: false, method: 'deep_website_finder', website, domain, email: '', decision: emptyDecision, pagesChecked: 0, pagesAttempted: 0, pages, acceptedCandidates, rejectedCandidates, sourceUrl: '', sourceType: '', reason: 'No website/domain available for deep search.', errors };
  }

  const queue = new Map<string, number>();
  queue.set(website, 100);
  try {
    const u = new URL(website);
    if (u.protocol === 'https:') { u.protocol = 'http:'; queue.set(u.toString(), 30); }
  } catch {}
  for (const candidate of likelyContactUrlCandidates(website)) queue.set(candidate, Math.max(queue.get(candidate) || 0, 50));

  const visited = new Set<string>();

  while (visited.size < maxPages && queue.size) {
    const next = Array.from(queue.entries()).sort((a, b) => b[1] - a[1])[0];
    if (!next) break;
    const [url] = next;
    queue.delete(url);
    if (visited.has(url) || LOW_VALUE_LINK_RE.test(url)) continue;
    visited.add(url);

    if (/^mailto:/i.test(url)) {
      const email = decodeEntities(url.replace(/^mailto:/i, '').split(/[?#]/)[0]);
      const decision = validateEmailCandidate({ email, sourceField: 'mailto', sourceText: url }, business, website, false);
      if (decision.valid) acceptedCandidates.push({ ...decision, pageUrl: website, sourceText: url });
      else rejectedCandidates.push({ email, reason: decision.reasons.join(' '), pageUrl: website, sourceField: 'mailto' });
      pages.push({ url, status: decision.valid ? 'fetched' : 'skipped', emails: decision.valid ? [{ ...decision, pageUrl: website, sourceText: url }] : [], linksFound: 0, reason: decision.reasons.join(' ') });
      continue;
    }

    try {
      const fetched = await fetchText(url, timeoutMs);
      if (!fetched.ok) {
        pages.push({ url, status: 'failed', httpStatus: fetched.status, emails: [], linksFound: 0, reason: `HTTP/content rejected: ${fetched.status}` });
        continue;
      }
      const html = fetched.text.slice(0, 700000);
      const pageText = htmlToText(html);
      const title = extractTitle(html);
      const links = extractLinks(html, url, domain);
      for (const link of links) {
        if (!visited.has(link.url)) queue.set(link.url, Math.max(queue.get(link.url) || 0, link.score));
      }

      const foundOnPage: Array<EmailCandidateDecision & { pageUrl: string; sourceText?: string }> = [];
      const candidates = findEmailCandidates({ pageUrl: url, title, text: pageText, cfEmails: extractCloudflareEmails(html) });
      for (const candidate of candidates) {
        const decision = validateEmailCandidate(candidate, business, url, false);
        if (decision.valid) {
          const row = { ...decision, pageUrl: url, sourceText: candidate.sourceText };
          foundOnPage.push(row);
          acceptedCandidates.push(row);
        } else {
          rejectedCandidates.push({ email: decision.email, reason: decision.reasons.join(' '), pageUrl: url, sourceField: decision.sourceField });
        }
      }

      pages.push({ url, status: 'fetched', httpStatus: fetched.status, bytes: html.length, title, emails: foundOnPage, linksFound: links.length });

      // If we already found a strong contact-page candidate, stop early to keep batches fast.
      const strong = acceptedCandidates.find((item) => item.promote && item.score >= 75 && /contact|impressum|imprint|about|team|mailto/i.test(item.pageUrl));
      if (strong && visited.size >= 2) break;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      errors.push(`${url}: ${reason}`);
      pages.push({ url, status: 'failed', emails: [], linksFound: 0, reason });
    }
  }

  const deduped = Array.from(new Map(acceptedCandidates.map((item) => [item.email, item])).values())
    .sort((a, b) => bestMainInboxRank(b) - bestMainInboxRank(a));
  const best = deduped[0] || { ...emptyDecision, reasons: ['No valid email found after checking website/contact pages.'] };
  const bestPage = 'pageUrl' in best ? String(best.pageUrl || '') : '';
  const reason = best.email
    ? `Deep finder found ${best.email} on ${bestPage || 'website'}; ${best.reasons.join(' ')}`
    : `No valid email found after ${visited.size} page(s).`;

  return {
    success: Boolean(best.email),
    method: 'deep_website_finder',
    website,
    domain,
    email: best.email,
    decision: best,
    pagesChecked: pages.filter((page) => page.status === 'fetched').length,
    pagesAttempted: visited.size,
    pages,
    acceptedCandidates: deduped.slice(0, 20),
    rejectedCandidates: rejectedCandidates.slice(0, 50),
    sourceUrl: bestPage,
    sourceType: sourceTypeFromUrl(bestPage),
    reason,
    errors
  };
}
