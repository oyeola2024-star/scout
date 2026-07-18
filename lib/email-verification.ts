import { promises as dns } from 'node:dns';

export type BasicEmailVerificationStatus = 'valid_domain' | 'invalid' | 'unknown';

export type BasicEmailVerificationResult = {
  email: string;
  status: BasicEmailVerificationStatus;
  syntaxValid: boolean;
  domain: string;
  domainHasMx: boolean;
  mxHosts: string[];
  roleInbox: boolean;
  roleLabel: string | null;
  disposable: boolean;
  reason: string;
  checkedAt: string;
  level: 'basic';
};

const ROLE_LABELS: Record<string, string> = {
  info: 'General information',
  hello: 'General contact',
  contact: 'General contact',
  support: 'Customer support',
  help: 'Customer support',
  sales: 'Sales',
  marketing: 'Marketing',
  partnerships: 'Partnerships',
  partner: 'Partnerships',
  billing: 'Billing',
  accounts: 'Accounts',
  privacy: 'Privacy/legal',
  legal: 'Legal',
  careers: 'Careers',
  jobs: 'Careers',
};

const DISPOSABLE_DOMAINS = new Set([
  '10minutemail.com',
  'guerrillamail.com',
  'mailinator.com',
  'tempmail.com',
  'temp-mail.org',
  'yopmail.com',
  'throwawaymail.com',
]);

export function normalizeEmailAddress(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

export function emailSyntaxValid(value: string) {
  if (!value || value.length > 254 || /\s/.test(value)) return false;
  const parts = value.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || local.length > 64 || !domain || domain.length > 253) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)) return false;
  if (!/^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)) return false;
  return true;
}

export async function verifyEmailBasic(input: unknown): Promise<BasicEmailVerificationResult> {
  const email = normalizeEmailAddress(input);
  const checkedAt = new Date().toISOString();
  const syntaxValid = emailSyntaxValid(email);
  const [local = '', domain = ''] = email.split('@');
  const roleLabel = ROLE_LABELS[local] || null;
  const disposable = DISPOSABLE_DOMAINS.has(domain);

  if (!syntaxValid) {
    return {
      email,
      status: 'invalid',
      syntaxValid: false,
      domain,
      domainHasMx: false,
      mxHosts: [],
      roleInbox: Boolean(roleLabel),
      roleLabel,
      disposable,
      reason: 'The email address format is invalid.',
      checkedAt,
      level: 'basic',
    };
  }

  try {
    const mx = await dns.resolveMx(domain);
    const mxHosts = mx
      .filter((row) => row.exchange)
      .sort((a, b) => a.priority - b.priority)
      .map((row) => row.exchange.toLowerCase());
    if (!mxHosts.length) {
      return {
        email,
        status: 'invalid',
        syntaxValid: true,
        domain,
        domainHasMx: false,
        mxHosts: [],
        roleInbox: Boolean(roleLabel),
        roleLabel,
        disposable,
        reason: 'The domain has no mail exchanger (MX) record.',
        checkedAt,
        level: 'basic',
      };
    }
    return {
      email,
      status: 'valid_domain',
      syntaxValid: true,
      domain,
      domainHasMx: true,
      mxHosts,
      roleInbox: Boolean(roleLabel),
      roleLabel,
      disposable,
      reason: roleLabel
        ? `The domain can receive email. This is a legitimate ${roleLabel.toLowerCase()} role inbox; role inboxes are not penalized.${disposable ? ' The domain is also identified as disposable; that label is informational and does not block sending.' : ''}`
        : `The address format is valid and the domain has working MX records.${disposable ? ' The domain is identified as disposable; that label is informational and does not block sending.' : ''}`,
      checkedAt,
      level: 'basic',
    };
  } catch (error: any) {
    const code = String(error?.code || '').toUpperCase();
    if (['ENOTFOUND', 'ENODATA', 'ENXDOMAIN'].includes(code)) {
      return {
        email,
        status: 'invalid',
        syntaxValid: true,
        domain,
        domainHasMx: false,
        mxHosts: [],
        roleInbox: Boolean(roleLabel),
        roleLabel,
        disposable,
        reason: 'The domain does not publish a usable mail exchanger (MX) record.',
        checkedAt,
        level: 'basic',
      };
    }
    return {
      email,
      status: 'unknown',
      syntaxValid: true,
      domain,
      domainHasMx: false,
      mxHosts: [],
      roleInbox: Boolean(roleLabel),
      roleLabel,
      disposable,
      reason: `The DNS check could not complete${code ? ` (${code})` : ''}. Scout will retry later.`,
      checkedAt,
      level: 'basic',
    };
  }
}
