import { domainFromWebsite } from './normalize';

const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'zoho.com', 'gmx.com', 'mail.com'
]);

const SHARED_PLATFORM_DOMAINS = [
  'hcaptcha', 'recaptcha', 'captcha', 'cloudflare', 'shopifycdn', 'cdn', 'assets', 'asset', 'static',
  'tracking', 'analytics', 'pixel', 'sentry', 'datadog', 'newrelic', 'google-analytics', 'doubleclick'
];

export type BusinessRootInput = {
  id?: string | null;
  name?: string | null;
  email?: string | null;
  website?: string | null;
  domain?: string | null;
  raw?: Record<string, unknown> | null;
};

export function emailDomain(email: string) {
  return String(email || '').toLowerCase().split('@')[1]?.trim() || '';
}

export function rootDomain(value: string) {
  const host = domainFromWebsite(value).toLowerCase().replace(/^www\./, '');
  if (!host) return '';
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return host;
  return parts.slice(-2).join('.');
}

export function businessRoot(business: BusinessRootInput) {
  return rootDomain(String(business.domain || business.website || ''));
}

export function emailRoot(email: string) {
  return rootDomain(emailDomain(email));
}

export function emailMatchesBusiness(email: string, business: BusinessRootInput) {
  const eRoot = emailRoot(email);
  const bRoot = businessRoot(business);
  return Boolean(eRoot && bRoot && eRoot === bRoot);
}

export function isSharedOrInfrastructureEmail(email: string) {
  const domain = emailDomain(email);
  const eRoot = rootDomain(domain);
  return SHARED_PLATFORM_DOMAINS.some((token) => domain.includes(token) || eRoot.includes(token));
}

export function isFreeMailbox(email: string) {
  return FREE_MAIL_DOMAINS.has(emailDomain(email));
}

export function duplicateEmailRisk(email: string, currentBusiness: BusinessRootInput, otherBusinesses: BusinessRootInput[]) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const currentRoot = businessRoot(currentBusiness);
  const eRoot = emailRoot(normalizedEmail);
  const otherRoots = Array.from(new Set(otherBusinesses.map(businessRoot).filter(Boolean)));
  const unrelatedRoots = otherRoots.filter((root) => root && root !== currentRoot);
  const repeatedAcrossUnrelatedBusinesses = unrelatedRoots.length >= 2;
  const repeatedOnceUnrelatedInfrastructure = unrelatedRoots.length >= 1 && isSharedOrInfrastructureEmail(normalizedEmail);
  const repeatedSuspiciousNonMatching = unrelatedRoots.length >= 2 && eRoot !== currentRoot && !isFreeMailbox(normalizedEmail);

  const risky = Boolean(repeatedAcrossUnrelatedBusinesses || repeatedOnceUnrelatedInfrastructure || repeatedSuspiciousNonMatching);
  const reason = risky
    ? `Same email appears on ${otherBusinesses.length + 1} business record(s) across ${unrelatedRoots.length + 1} unrelated domain group(s). This is likely scraped from shared code/widget text, not a unique business inbox.`
    : '';

  return {
    risky,
    reason,
    email: normalizedEmail,
    emailRoot: eRoot,
    currentRoot,
    otherRoots,
    totalMatches: otherBusinesses.length + 1
  };
}
