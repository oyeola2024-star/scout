import { cleanText, displayDomain, makeNormalizedKey, normalizeEmail, normalizePhone, normalizeWebsite } from './normalize';

export type SourceScoutMode = 'google_dork' | 'bing_dork' | 'directory' | 'extension' | 'mixed';

export type SourceScoutLead = {
  name: string;
  email: string;
  website: string;
  domain: string;
  phone: string;
  category: string;
  location: string;
  source: string;
  normalized_key: string;
  confidence: number;
  reason: string;
  raw: Record<string, unknown>;
};

export type SourceScoutParseResult = {
  leads: SourceScoutLead[];
  directEmailCount: number;
  websiteOnlyCount: number;
  rejected: Array<{ value: string; reason: string }>;
  dorks: string[];
};

const EMAIL_GLOBAL_RE = /[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/gi;
const URL_GLOBAL_RE = /(?:https?:\/\/|www\.)[^\s<>'"\])}]+|\b[a-z0-9][a-z0-9\-]{1,62}(?:\.[a-z0-9][a-z0-9\-]{1,62})+\b(?:\/[^\s<>'"\])}]*)?/gi;
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/;
const BAD_DOMAIN_RE = /\b(?:google|bing|yahoo|facebook|instagram|linkedin|youtube|twitter|x|tiktok|pinterest|schema|w3|gstatic|doubleclick|googletagmanager|googleusercontent|cloudflare|sentry|hotjar|recaptcha|hcaptcha|example|forbes|wikipedia|medium|reddit|quora|crunchbase|bloomberg|reuters|nytimes|bbc|cnn|cnbc|shopify\.com|apps\.shopify|themeforest|github|npmjs|wordpress\.org)\./i;
const FILE_OR_ASSET_RE = /\.(?:png|jpe?g|webp|gif|svg|pdf|zip|css|js|ico|woff2?|ttf|eot|mp4|mov|avi|webm)(?:[?#].*)?$/i;
const SOURCE_AGGREGATOR_DOMAINS = new Set([
  'forbes.com','wikipedia.org','medium.com','reddit.com','quora.com','crunchbase.com','bloomberg.com','reuters.com','nytimes.com','bbc.com','cnn.com','cnbc.com','yelp.com','trustpilot.com','yellowpages.com','clutch.co','g2.com','github.com','npmjs.com','shopify.com','apps.shopify.com','themeforest.net','wordpress.org','facebook.com','instagram.com','linkedin.com','youtube.com','tiktok.com','x.com','twitter.com','pinterest.com'
]);

function rootDomainForFilter(value: string) {
  const host = displayDomain({ website: value, domain: value }).toLowerCase().replace(/^www\./, '');
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return host;
  return parts.slice(-2).join('.');
}

function isBlockedSourceDomain(value: string) {
  const root = rootDomainForFilter(value);
  if (!root) return false;
  return SOURCE_AGGREGATOR_DOMAINS.has(root) || Array.from(SOURCE_AGGREGATOR_DOMAINS).some((blocked) => root === blocked || root.endsWith(`.${blocked}`));
}

function lineLooksLikeAggregator(line: string) {
  const lower = line.toLowerCase();
  return /\b(forbes|wikipedia|medium|reddit|quora|crunchbase|bloomberg|reuters|nytimes|bbc|cnn|cnbc|github|npm|themeforest|shopify app store)\b/.test(lower);
}

function usableBusinessEvidence(line: string, website: string, email: string) {
  if (website && isBlockedSourceDomain(website)) return false;
  if (email && isBlockedSourceDomain(email.split('@')[1] || '')) return false;
  if (lineLooksLikeAggregator(line) && !website) return false;
  return true;
}


export function buildSourceScoutDorks(input: { niche?: string; location?: string; country?: string; sourceMode?: SourceScoutMode; signals?: string[] | string }) {
  const niche = cleanText(input.niche || 'business').replace(/["<>]/g, '').trim();
  const location = cleanText([input.location, input.country].filter(Boolean).join(' ')).replace(/["<>]/g, '').trim();
  const place = location || 'near me';
  const q = (value: string) => value.replace(/\s+/g, ' ').trim();
  const signals = Array.isArray(input.signals) ? input.signals : String(input.signals || '').split(/\n|,/);
  const cleanSignals = signals.map((s) => cleanText(s).replace(/["<>]/g, '').trim()).filter(Boolean).slice(0, 8);
  const signalDorks = cleanSignals.flatMap((signal) => [
    q(`"${niche}" "${place}" "${signal}" "contact"`),
    q(`"${niche}" "${place}" "${signal}" "@" -forbes -wikipedia -medium -reddit -quora`)
  ]);
  return [
    ...signalDorks,
    q(`"${niche}" "${place}" "contact" email`),
    q(`"${niche}" "${place}" "@" -facebook -instagram -linkedin`),
    q(`"${niche}" "${place}" "official website"`),
    q(`intitle:"${niche}" "${place}" "contact"`),
    q(`"${niche}" "${place}" "website" "phone"`),
    q(`"${niche}" "${place}" "mailto:"`),
    q(`"${niche}" "${place}" "impressum" email`),
    q(`"${niche}" "${place}" "directory" "website"`)
  ];
}

export function searchUrl(engine: 'google' | 'bing', query: string) {
  const encoded = encodeURIComponent(query);
  return engine === 'google' ? `https://www.google.com/search?q=${encoded}` : `https://www.bing.com/search?q=${encoded}`;
}

function stripHtml(input: string) {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<\/div\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&commat;/gi, '@')
    .replace(/&period;|&dot;/gi, '.')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s*(?:\[at\]|\(at\)|\{at\}|\sat\s)\s*/gi, '@')
    .replace(/\s*(?:\[dot\]|\(dot\)|\{dot\}|\sdot\s)\s*/gi, '.')
    .replace(/\s+/g, ' ');
}

function safeWebsite(raw: string) {
  const website = normalizeWebsite(raw);
  if (!website) return '';
  if (BAD_DOMAIN_RE.test(website)) return '';
  if (isBlockedSourceDomain(website)) return '';
  if (FILE_OR_ASSET_RE.test(website)) return '';
  return website;
}

function domainFromEmail(email: string) {
  return email.includes('@') ? email.split('@')[1].toLowerCase() : '';
}

function inferName(line: string, email: string, website: string, fallbackNiche: string) {
  const domain = displayDomain({ website, email });
  const withoutEmail = line.replace(email, ' ').replace(/https?:\/\/\S+|www\.\S+/gi, ' ');
  const cleaned = withoutEmail
    .replace(/[|•·,:;\-–—]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned && cleaned.length >= 3 && cleaned.length <= 80 && !/^(contact|email|phone|website)$/i.test(cleaned)) return cleaned;
  if (domain) return domain.replace(/^www\./, '').split('.')[0].replace(/[\-_]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
  return fallbackNiche || 'Scouted business';
}

function uniqueKey(lead: SourceScoutLead) {
  return lead.normalized_key || [lead.email, lead.website, lead.name].filter(Boolean).join('|').toLowerCase();
}

export function parseSourceScoutText(input: {
  text: string;
  niche?: string;
  location?: string;
  country?: string;
  sourceMode?: SourceScoutMode;
}): SourceScoutParseResult {
  const rawText = String(input.text || '');
  const text = stripHtml(rawText).slice(0, 900000);
  const niche = cleanText(input.niche || '');
  const location = cleanText([input.location, input.country].filter(Boolean).join(' '));
  const sourceMode = input.sourceMode || 'mixed';
  const lines = text
    .split(/\n|\r|(?<=\.)\s{2,}|(?<=\|)\s+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 12000);

  const leads: SourceScoutLead[] = [];
  const rejected: Array<{ value: string; reason: string }> = [];

  function pushLead(partial: Partial<SourceScoutLead> & { rawLine: string; reason: string; confidence: number }) {
    const email = normalizeEmail(partial.email || '');
    const website = safeWebsite(String(partial.website || ''));
    const phone = normalizePhone(partial.phone || '');
    const domain = displayDomain({ domain: partial.domain, website, email });
    const name = cleanText(partial.name || inferName(partial.rawLine, email, website, niche));
    const normalized_key = makeNormalizedKey({ email, domain, website, name, phone });
    if (!normalized_key) {
      rejected.push({ value: partial.rawLine.slice(0, 160), reason: 'No stable email, website, phone, or name key found.' });
      return;
    }
    if (!usableBusinessEvidence(partial.rawLine, website, email)) {
      rejected.push({ value: partial.rawLine.slice(0, 160), reason: 'Skipped aggregator/news/platform result. Scout only imports businesses or direct contact pages.' });
      return;
    }
    leads.push({
      name,
      email,
      website,
      domain,
      phone,
      category: niche,
      location,
      source: `source_scout_${sourceMode}`,
      normalized_key,
      confidence: partial.confidence,
      reason: partial.reason,
      raw: {
        sourceMode,
        rawLine: partial.rawLine,
        sourceScout: true,
        reason: partial.reason,
        confidence: partial.confidence
      }
    });
  }

  for (const line of lines) {
    const emails = Array.from(new Set((line.match(EMAIL_GLOBAL_RE) || []).map((e) => normalizeEmail(e)).filter(Boolean)));
    const websites = Array.from(new Set((line.match(URL_GLOBAL_RE) || []).map((u) => safeWebsite(u)).filter(Boolean)));
    const phone = line.match(PHONE_RE)?.[0] || '';

    if (emails.length) {
      for (const email of emails.slice(0, 6)) {
        const sameDomainWebsite = websites.find((site) => displayDomain({ website: site }) === domainFromEmail(email)) || websites[0] || '';
        pushLead({
          email,
          website: sameDomainWebsite,
          phone,
          rawLine: line,
          reason: sameDomainWebsite ? 'Direct email found with website evidence in the pasted source.' : 'Direct email found in Google/Bing/directory source text.',
          confidence: sameDomainWebsite ? 88 : 74
        });
      }
    }

    if (websites.length) {
      for (const website of websites.slice(0, 10)) {
        const alreadyHasEmailForSite = emails.some((email) => displayDomain({ email }) === displayDomain({ website }));
        if (alreadyHasEmailForSite) continue;
        pushLead({
          website,
          phone,
          rawLine: line,
          reason: 'Website discovered from Google/Bing/directory source and should be sent to Auto Scout for deep email search.',
          confidence: 64
        });
      }
    }
  }

  // Fallback over whole pasted text catches URLs/emails if a copied search result has no clean line breaks.
  const allEmails = Array.from(new Set((text.match(EMAIL_GLOBAL_RE) || []).map((e) => normalizeEmail(e)).filter(Boolean)));
  for (const email of allEmails.slice(0, 2000)) {
    if (!leads.some((lead) => lead.email === email)) {
      pushLead({ email, rawLine: email, reason: 'Direct email found in pasted source text.', confidence: 70 });
    }
  }

  const allWebsites = Array.from(new Set((text.match(URL_GLOBAL_RE) || []).map((u) => safeWebsite(u)).filter(Boolean)));
  for (const website of allWebsites.slice(0, 4000)) {
    const domain = displayDomain({ website });
    if (!leads.some((lead) => lead.website === website || (domain && lead.domain === domain))) {
      pushLead({ website, rawLine: website, reason: 'Website discovered in pasted source text.', confidence: 58 });
    }
  }

  const deduped = Array.from(new Map(leads.map((lead) => [uniqueKey(lead), lead])).values())
    .sort((a, b) => Number(Boolean(b.email)) - Number(Boolean(a.email)) || b.confidence - a.confidence)
    .slice(0, 5000);

  return {
    leads: deduped,
    directEmailCount: deduped.filter((lead) => lead.email).length,
    websiteOnlyCount: deduped.filter((lead) => !lead.email && lead.website).length,
    rejected: rejected.slice(0, 50),
    dorks: buildSourceScoutDorks({ niche, location, country: input.country, sourceMode })
  };
}
