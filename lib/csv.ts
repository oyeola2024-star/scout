import Papa from 'papaparse';
import { CsvBusinessInput, CsvInvalidRow } from './types';
import { cleanText, displayDomain, extractEmail, makeNormalizedKey, normalizeEmail, normalizePhone, normalizeWebsite } from './normalize';

const FIELD_ALIASES = {
  name: ['business name', 'business', 'company', 'company name', 'name', 'title', 'place name', 'organization', 'organisation', 'store', 'shop', 'merchant', 'brand'],
  email: ['email', 'emails', 'email1', 'email2', 'email3', 'email 1', 'email 2', 'email 3', 'validatedemail1', 'validatedemail2', 'validatedemail3', 'validated email 1', 'validated email 2', 'validated email 3', 'email address', 'email addresses', 'e-mail', 'e-mail address', 'mail', 'contact email', 'contact emails', 'verified email', 'verified emails', 'found email', 'found emails', 'personal email', 'personal emails', 'business email', 'business emails', 'owner email', 'owner emails', 'primary email', 'primary emails', 'work email', 'work emails', 'inbox email', 'valid email'],
  phone: ['phone', 'phones', 'phone number', 'telephone', 'mobile', 'contact number', 'tel', 'whatsapp'],
  website: ['website', 'websites', 'site', 'url', 'web', 'domain url', 'business website', 'website url', 'store url', 'shop url', 'profile url'],
  domain: ['domain', 'domains', 'website domain', 'root domain'],
  category: ['category', 'industry', 'niche', 'type', 'business category', 'segment', 'vertical'],
  location: ['location', 'city', 'state', 'country', 'address', 'area', 'region'],
  source: ['source', 'platform', 'origin', 'directory']
} as const;

type FieldName = keyof typeof FIELD_ALIASES;
type RawRow = Record<string, unknown>;

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const URL_RE = /(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s,;)]*/i;
const BAD_EMAIL_HEADER_WORDS = ['status', 'valid', 'verification', 'mx', 'smtp', 'score', 'confidence', 'deliverability', 'domain'];

function cleanHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[_\-\/]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findField(headers: string[], field: FieldName): string | undefined {
  const normalizedHeaders = headers.map((h) => ({ raw: h, normalized: cleanHeader(h) }));
  const aliases = FIELD_ALIASES[field].map(cleanHeader);

  const exact = normalizedHeaders.find((h) => aliases.includes(h.normalized as never));
  if (exact) return exact.raw;

  const loose = normalizedHeaders.find((h) => {
    const matches = aliases.some((alias) => h.normalized === alias || h.normalized.startsWith(`${alias} `) || h.normalized.endsWith(` ${alias}`) || h.normalized.includes(` ${alias} `));
    if (!matches) return false;
    if (field === 'email' && /^(email|e mail|mail|validated email|verified email|found email|contact email|business email|personal email|owner email|primary email|work email)\s*\d*$/.test(h.normalized)) return true;
    if (field === 'email' && BAD_EMAIL_HEADER_WORDS.some((bad) => h.normalized.includes(bad) && !h.normalized.includes('email address') && !h.normalized.includes('validated email') && !h.normalized.includes('verified email'))) return false;
    return true;
  });
  return loose?.raw;
}

function get(row: RawRow, header: string | undefined): string {
  return header ? cleanText(row[header]) : '';
}

function allCellValues(row: RawRow): string[] {
  return Object.values(row).flatMap((value) => {
    const text = cleanText(value);
    return text ? [text] : [];
  });
}

function firstEmailFromRow(row: RawRow): string {
  for (const value of allCellValues(row)) {
    const direct = extractEmail(value);
    if (direct) return normalizeEmail(direct);
  }
  const joined = allCellValues(row).join(' ');
  const match = joined.match(EMAIL_RE);
  return match?.[0] ? normalizeEmail(match[0]) : '';
}

function firstWebsiteFromRow(row: RawRow): string {
  for (const value of allCellValues(row)) {
    const withoutEmails = value.replace(EMAIL_RE, ' ');
    const match = withoutEmails.match(URL_RE);
    if (match?.[0] && match[0].includes('.')) {
      const website = normalizeWebsite(match[0]);
      if (website) return website;
    }
  }
  return '';
}

function firstPhoneFromRow(row: RawRow): string {
  for (const value of allCellValues(row)) {
    if (extractEmail(value) || /https?:\/\//i.test(value)) continue;
    const phone = normalizePhone(value);
    if (phone) return phone;
  }
  return '';
}

function firstNameFromRow(row: RawRow, headers: string[]): string {
  const preferred = ['business', 'business name', 'company', 'company name', 'name', 'store', 'shop', 'title', 'merchant', 'brand'];
  for (const header of headers) {
    if (preferred.includes(cleanHeader(header))) {
      const value = cleanText(row[header]);
      if (value) return value;
    }
  }
  for (const value of allCellValues(row)) {
    if (extractEmail(value) || URL_RE.test(value)) continue;
    const digits = value.replace(/\D/g, '');
    if (digits.length >= 7) continue;
    if (value.length >= 2 && value.length <= 120) return value;
  }
  return '';
}

export function parseCsvText(text: string): Promise<{ rows: CsvBusinessInput[]; invalidRows: CsvInvalidRow[]; headers: string[]; errors: string[] }> {
  return new Promise((resolve) => {
    Papa.parse<RawRow>(text, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (header) => header.trim(),
      complete: (result) => {
        const headers = result.meta.fields || [];
        const nameField = findField(headers, 'name');
        const emailField = findField(headers, 'email');
        const phoneField = findField(headers, 'phone');
        const websiteField = findField(headers, 'website');
        const domainField = findField(headers, 'domain');
        const categoryField = findField(headers, 'category');
        const locationField = findField(headers, 'location');
        const sourceField = findField(headers, 'source');

        const rows: CsvBusinessInput[] = [];
        const invalidRows: CsvInvalidRow[] = [];

        result.data.forEach((row, index) => {
          const explicitEmail = normalizeEmail(get(row, emailField));
          const email = explicitEmail || firstEmailFromRow(row);
          const website = normalizeWebsite(get(row, websiteField)) || firstWebsiteFromRow(row);
          const domain = displayDomain({ domain: get(row, domainField), website, email });
          const name = get(row, nameField) || firstNameFromRow(row, headers);
          const phone = normalizePhone(get(row, phoneField)) || firstPhoneFromRow(row);
          const category = get(row, categoryField);
          const location = get(row, locationField);
          const source = get(row, sourceField) || 'csv_upload';
          const normalized_key = makeNormalizedKey({ email, domain, website, name, phone });
          const normalizedRow = { name, email, phone, website, domain, category, location, source, normalized_key, raw: row };
          if (normalized_key) rows.push(normalizedRow);
          else invalidRows.push({ rowNumber: index + 2, reason: 'No usable email, website/domain, phone, or business name found.', raw: row });
        });

        resolve({ rows, invalidRows, headers, errors: result.errors.map((error) => `${error.code}: ${error.message}`) });
      },
      error: (error: Error) => resolve({ rows: [], invalidRows: [], headers: [], errors: [error.message] })
    });
  });
}

export function csvColumnsLookDifferent(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return false;
  const clean = (cols: string[]) => new Set(cols.map(cleanHeader).filter(Boolean));
  const setA = clean(a);
  const setB = clean(b);
  const intersection = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union > 0 && intersection / union < 0.45;
}
