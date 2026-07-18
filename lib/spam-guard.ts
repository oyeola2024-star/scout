export type SpamGuardFinding = {
  severity: 'low' | 'medium' | 'high';
  label: string;
  detail: string;
};

export type SpamGuardReport = {
  score: number;
  level: 'Low' | 'Medium' | 'High';
  findings: SpamGuardFinding[];
};

const HIGH_RISK_PHRASES = [
  'guaranteed sales', '100% guaranteed', 'make money fast', 'risk-free', 'act now', 'limited time',
  'buy now', 'click here', 'winner', 'cash bonus', 'double your revenue', 'overnight results',
  'free free', 'no obligation', 'cheap price', 'lowest price', 'urgent response', 'crypto', 'loan approved'
];

const MEDIUM_RISK_PHRASES = [
  'free', 'guarantee', 'urgent', 'limited', 'discount', 'deal', 'offer', 'increase sales',
  'boost revenue', 'more traffic', 'get rich', 'save money', 'best price', 'exclusive', 'promotion'
];

export function analyzeSpamRisk(subject: string, body: string): SpamGuardReport {
  const combined = `${subject}\n${body}`;
  const lower = combined.toLowerCase();
  const findings: SpamGuardFinding[] = [];
  let score = 0;

  for (const phrase of HIGH_RISK_PHRASES) {
    if (lower.includes(phrase)) {
      score += 18;
      findings.push({ severity: 'high', label: phrase, detail: 'High-risk sales/spam phrase found.' });
    }
  }

  for (const phrase of MEDIUM_RISK_PHRASES) {
    const matches = lower.split(phrase).length - 1;
    if (matches > 0) {
      score += Math.min(12, matches * 4);
      findings.push({ severity: 'medium', label: phrase, detail: `${matches} use(s) of a phrase that can raise content risk.` });
    }
  }

  const exclamations = (combined.match(/!/g) || []).length;
  if (exclamations >= 3) {
    score += Math.min(18, exclamations * 3);
    findings.push({ severity: exclamations >= 6 ? 'high' : 'medium', label: 'Too many exclamation marks', detail: `${exclamations} exclamation marks found.` });
  }

  const links = (combined.match(/https?:\/\//gi) || []).length;
  if (links > 1) {
    score += links >= 3 ? 18 : 8;
    findings.push({ severity: links >= 3 ? 'high' : 'medium', label: 'Too many links', detail: `${links} links found. Cold outreach should usually use 0–1 link.` });
  }

  const capsWords = combined.split(/\s+/).filter((word) => word.length >= 5 && /^[A-Z0-9!?.]+$/.test(word)).length;
  if (capsWords >= 3) {
    score += Math.min(20, capsWords * 4);
    findings.push({ severity: capsWords >= 5 ? 'high' : 'medium', label: 'Too much ALL CAPS', detail: `${capsWords} all-caps words found.` });
  }

  if (!/[{](name|business|company|website|domain|category|location|source)[}]/i.test(combined)) {
    score += 12;
    findings.push({ severity: 'medium', label: 'No personalization shortcode', detail: 'Add {name}, {business}, {website}, {category}, or another business-specific signal.' });
  }

  if (body.length < 120) {
    score += 8;
    findings.push({ severity: 'low', label: 'Very short message', detail: 'Very short generic messages can look automated.' });
  }

  if (subject.length > 90) {
    score += 8;
    findings.push({ severity: 'low', label: 'Long subject', detail: 'Long subjects can look promotional and may be truncated.' });
  }

  if (!/unsubscribe|wrong person|not relevant|no worries|won't follow up|do not contact/i.test(body)) {
    score += 8;
    findings.push({ severity: 'low', label: 'No soft opt-out', detail: 'A simple opt-out line can reduce complaints.' });
  }

  const clamped = Math.max(0, Math.min(100, score));
  const level: SpamGuardReport['level'] = clamped >= 55 ? 'High' : clamped >= 25 ? 'Medium' : 'Low';
  return { score: clamped, level, findings };
}
