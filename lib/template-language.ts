import type { Business, MessageTemplate } from './types';
import { extractBusinessCountries, resolveBusinessCountry } from './country-location';

export const TEMPLATE_LANGUAGES = [
  { code: 'en', label: 'English', locale: 'en' },
  { code: 'de', label: 'German', locale: 'de-DE' },
  { code: 'es', label: 'Spanish', locale: 'es-ES' },
  { code: 'fr', label: 'French', locale: 'fr-FR' },
  { code: 'it', label: 'Italian', locale: 'it-IT' },
  { code: 'pt-PT', label: 'Portuguese (Portugal)', locale: 'pt-PT' }
] as const;

export type TemplateLanguageCode = (typeof TEMPLATE_LANGUAGES)[number]['code'];

export type TemplateTranslation = {
  subject: string;
  subject_variants?: string[] | null;
  message: string;
  countries?: string[] | null;
};

export type TemplateTranslations = Partial<Record<TemplateLanguageCode, TemplateTranslation>>;
export type TemplateCountryAssignments = Partial<Record<TemplateLanguageCode, string[]>>;

export type BusinessLanguageResolution = {
  code: TemplateLanguageCode;
  label: string;
  source: 'template_country' | 'uploaded' | 'country' | 'domain' | 'default' | 'unsupported';
  sourceLabel: string;
  detectedValue?: string;
  countries: string[];
};

export type ResolvedTemplateContent = {
  language: TemplateLanguageCode;
  languageLabel: string;
  detectedLanguage: BusinessLanguageResolution;
  usedFallback: boolean;
  subject: string;
  subjectVariants: string[];
  message: string;
};

type AnyRecord = Record<string, unknown>;

const LANGUAGE_FIELD_KEYS = new Set([
  'language', 'languages', 'languagecode', 'preferredlanguage', 'preferredlocale',
  'locale', 'lang', 'websitelanguage', 'sitelanguage', 'htmllang', 'contentlanguage'
]);

const LANGUAGE_ALIASES: Record<string, TemplateLanguageCode> = {
  en: 'en', eng: 'en', english: 'en', 'en-us': 'en', 'en-gb': 'en', 'en-ca': 'en',
  de: 'de', deu: 'de', ger: 'de', german: 'de', deutsch: 'de', 'de-de': 'de', 'de-at': 'de',
  es: 'es', spa: 'es', spanish: 'es', espanol: 'es', 'es-es': 'es',
  fr: 'fr', fra: 'fr', fre: 'fr', french: 'fr', francais: 'fr', 'fr-fr': 'fr', 'fr-ca': 'fr',
  it: 'it', ita: 'it', italian: 'it', italiano: 'it', 'it-it': 'it',
  pt: 'pt-PT', por: 'pt-PT', portuguese: 'pt-PT', portugues: 'pt-PT', 'pt-pt': 'pt-PT', 'pt_pt': 'pt-PT'
};

const COUNTRY_LANGUAGE: Record<string, TemplateLanguageCode> = {
  Germany: 'de', Austria: 'de', Spain: 'es', France: 'fr', Italy: 'it', Portugal: 'pt-PT',
  'United Kingdom': 'en', Ireland: 'en', 'United States': 'en', Canada: 'en', Australia: 'en', 'New Zealand': 'en'
};

const TLD_LANGUAGE: Record<string, TemplateLanguageCode> = {
  de: 'de', at: 'de', es: 'es', fr: 'fr', it: 'it', pt: 'pt-PT', uk: 'en', ie: 'en', us: 'en', ca: 'en', au: 'en', nz: 'en'
};

function normalizeKey(value: unknown) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '').toLowerCase();
}

function normalizeLanguageValue(value: unknown) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/_/g, '-');
}

function languageLabel(code: TemplateLanguageCode) {
  return TEMPLATE_LANGUAGES.find((item) => item.code === code)?.label || 'English';
}

function asRecord(value: unknown): AnyRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as AnyRecord;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as AnyRecord : {};
    } catch { return {}; }
  }
  return {};
}

function normalizeSupportedLanguage(value: unknown): TemplateLanguageCode | null {
  const cleaned = normalizeLanguageValue(value);
  if (!cleaned) return null;
  const direct = LANGUAGE_ALIASES[cleaned];
  if (direct) return direct;
  const base = cleaned.split(/[-,;/\s]+/)[0];
  return LANGUAGE_ALIASES[base] || null;
}

function findLanguageInValue(value: unknown, depth = 0): string {
  if (depth > 3 || !value) return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findLanguageInValue(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  const record = value as AnyRecord;
  for (const [key, item] of Object.entries(record)) {
    if (!LANGUAGE_FIELD_KEYS.has(normalizeKey(key))) continue;
    if (Array.isArray(item)) {
      const first = item.map((entry) => String(entry || '').trim()).find(Boolean);
      if (first) return first;
    } else {
      const text = String(item || '').trim();
      if (text) return text;
    }
  }
  for (const item of Object.values(record)) {
    const found = findLanguageInValue(item, depth + 1);
    if (found) return found;
  }
  return '';
}

function findUploadedLanguage(business: Partial<Business> & AnyRecord) {
  const directCandidates = [business.language, business.language_code, business.preferred_language, business.locale];
  for (const value of directCandidates) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return findLanguageInValue(asRecord(business.raw));
}

function businessDomain(business: Partial<Business> & AnyRecord) {
  const domain = String(business.domain || '').trim().toLowerCase().replace(/^www\./, '');
  if (domain) return domain.split('/')[0];
  try {
    const website = String(business.website || '').trim();
    if (website) return new URL(website.startsWith('http') ? website : `https://${website}`).hostname.replace(/^www\./, '').toLowerCase();
  } catch {}
  const email = String(business.email || '');
  return email.includes('@') ? email.split('@').pop()!.toLowerCase() : '';
}

export function readTemplateCountryAssignments(template: Partial<MessageTemplate> & AnyRecord): TemplateCountryAssignments {
  const raw = asRecord(template.raw);
  const direct = asRecord(raw.country_assignments);
  const translations = asRecord(raw.translations);
  const result: TemplateCountryAssignments = {};

  for (const language of TEMPLATE_LANGUAGES) {
    const directCountries = Array.isArray(direct[language.code]) ? direct[language.code] as unknown[] : [];
    const translationRow = asRecord(translations[language.code]);
    const nestedCountries = Array.isArray(translationRow.countries) ? translationRow.countries as unknown[] : [];
    const countries = [...directCountries, ...nestedCountries]
      .map((item) => String(item || '').trim())
      .filter(Boolean);
    if (countries.length) result[language.code] = Array.from(new Set(countries)).sort();
  }

  return result;
}

export function cleanTemplateCountryAssignments(assignments: TemplateCountryAssignments): TemplateCountryAssignments {
  const result: TemplateCountryAssignments = {};
  for (const language of TEMPLATE_LANGUAGES) {
    const countries = (assignments[language.code] || []).map((item) => String(item || '').trim()).filter(Boolean);
    if (countries.length) result[language.code] = Array.from(new Set(countries)).sort();
  }
  return result;
}

export function resolveBusinessLanguage(
  business: Partial<Business> & AnyRecord,
  template?: Partial<MessageTemplate> & AnyRecord
): BusinessLanguageResolution {
  const countries = extractBusinessCountries(business);
  const canonicalCountry = resolveBusinessCountry(business);

  if (template && canonicalCountry) {
    const assignments = readTemplateCountryAssignments(template);
    for (const language of TEMPLATE_LANGUAGES) {
      if ((assignments[language.code] || []).includes(canonicalCountry)) {
        return {
          code: language.code,
          label: languageLabel(language.code),
          source: 'template_country',
          sourceLabel: `${canonicalCountry} assigned in this template`,
          detectedValue: canonicalCountry,
          countries
        };
      }
    }
  }

  const uploadedValue = findUploadedLanguage(business);
  if (uploadedValue) {
    const supported = normalizeSupportedLanguage(uploadedValue);
    if (supported) {
      return { code: supported, label: languageLabel(supported), source: 'uploaded', sourceLabel: 'uploaded language', detectedValue: uploadedValue, countries };
    }
    return { code: 'en', label: languageLabel('en'), source: 'unsupported', sourceLabel: `unsupported uploaded language: ${uploadedValue}`, detectedValue: uploadedValue, countries };
  }

  const mappedCountries = Array.from(new Set(countries.map((country) => COUNTRY_LANGUAGE[country]).filter(Boolean)));
  if (mappedCountries.length === 1) {
    const code = mappedCountries[0];
    return { code, label: languageLabel(code), source: 'country', sourceLabel: countries.join(', '), countries };
  }

  const domain = businessDomain(business);
  const tld = domain.includes('.') ? domain.split('.').pop() || '' : '';
  const domainCode = TLD_LANGUAGE[tld];
  if (domainCode) {
    return { code: domainCode, label: languageLabel(domainCode), source: 'domain', sourceLabel: `.${tld} domain`, countries };
  }

  return {
    code: 'en', label: languageLabel('en'), source: 'default',
    sourceLabel: countries.length ? `no assigned or safe single-language rule for ${countries.join(', ')}` : 'no country or language data',
    countries
  };
}

export function readTemplateTranslations(template: Partial<MessageTemplate> & AnyRecord): TemplateTranslations {
  const raw = asRecord(template.raw);
  const translations = asRecord(raw.translations);
  const assignments = readTemplateCountryAssignments(template);
  const result: TemplateTranslations = {};
  for (const language of TEMPLATE_LANGUAGES) {
    if (language.code === 'en') continue;
    const row = asRecord(translations[language.code]);
    const subject = String(row.subject || '').trim();
    const message = String(row.message || row.body || '').trim();
    const subjectVariants = Array.isArray(row.subject_variants)
      ? row.subject_variants.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const countries = assignments[language.code] || [];
    if (subject || message || subjectVariants.length || countries.length) {
      result[language.code] = { subject, message, subject_variants: subjectVariants, countries };
    }
  }
  return result;
}

export function cleanTemplateTranslations(translations: TemplateTranslations): TemplateTranslations {
  const result: TemplateTranslations = {};
  for (const language of TEMPLATE_LANGUAGES) {
    if (language.code === 'en') continue;
    const row = translations[language.code];
    if (!row) continue;
    const subject = String(row.subject || '').trim();
    const message = String(row.message || '').trim();
    const subjectVariants = (row.subject_variants || []).map((item) => String(item || '').trim()).filter(Boolean);
    if (!subject && !message && !subjectVariants.length) continue;
    result[language.code] = { subject, message, subject_variants: subjectVariants };
  }
  return result;
}

export function templateHasCompleteTranslation(template: Partial<MessageTemplate> & AnyRecord, code: TemplateLanguageCode) {
  if (code === 'en') return Boolean(String(template.subject || '').trim() && String(template.message || '').trim());
  const translation = readTemplateTranslations(template)[code];
  return Boolean(translation?.subject?.trim() && translation?.message?.trim());
}

export function resolveTemplateContent(
  template: Partial<MessageTemplate> & AnyRecord,
  business: Partial<Business> & AnyRecord
): ResolvedTemplateContent {
  const detectedLanguage = resolveBusinessLanguage(business, template);
  const translations = readTemplateTranslations(template);
  const translation = detectedLanguage.code === 'en' ? null : translations[detectedLanguage.code];
  const completeTranslation = Boolean(translation?.subject?.trim() && translation?.message?.trim());
  const usedLanguage: TemplateLanguageCode = completeTranslation ? detectedLanguage.code : 'en';
  const subjectVariants = completeTranslation ? (translation?.subject_variants || []) : (template.subject_variants || []);

  return {
    language: usedLanguage,
    languageLabel: languageLabel(usedLanguage),
    detectedLanguage,
    usedFallback: detectedLanguage.code !== 'en' && !completeTranslation,
    subject: completeTranslation ? String(translation?.subject || '') : String(template.subject || ''),
    subjectVariants: subjectVariants.map((item) => String(item || '').trim()).filter(Boolean),
    message: completeTranslation ? String(translation?.message || '') : String(template.message || '')
  };
}

export function emptyTemplateTranslations(): TemplateTranslations {
  return Object.fromEntries(
    TEMPLATE_LANGUAGES.filter((item) => item.code !== 'en').map((item) => [
      item.code,
      { subject: '', subject_variants: [], message: '', countries: [] }
    ])
  ) as TemplateTranslations;
}

export function emptyTemplateCountryAssignments(): TemplateCountryAssignments {
  return Object.fromEntries(TEMPLATE_LANGUAGES.map((item) => [item.code, []])) as TemplateCountryAssignments;
}
