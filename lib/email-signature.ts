export type SignatureIdentity = {
  signature_enabled?: boolean | null;
  signature_text?: string | null;
  signature_html?: string | null;
  signature_logo_url?: string | null;
  raw?: Record<string, any> | null;
};

export type EmailAttachment = {
  filename: string;
  mimeType?: string | null;
  contentBase64: string;
  sizeBytes?: number | null;
};

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function normalizeNewlines(value: string) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function htmlToText(html: string) {
  return normalizeNewlines(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'")
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

export function textToHtml(text: string) {
  return escapeHtml(normalizeNewlines(text).trim()).replace(/\n/g, '<br />');
}

function rawIdentity(identity: SignatureIdentity) {
  const raw = identity.raw || {};
  const direct = (raw as any).email_identity || (raw as any).signature || {};
  return direct && typeof direct === 'object' ? direct as Record<string, any> : {};
}


function logoUrl(identity: SignatureIdentity) {
  const fallback = rawIdentity(identity);
  const url = String(identity.signature_logo_url || fallback.signature_logo_url || fallback.logo_url || '').trim();
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function logoHtml(identity: SignatureIdentity) {
  const url = logoUrl(identity);
  if (!url) return '';
  return `<br /><br /><img src="${escapeHtml(url)}" alt="Logo" width="160" style="display:block;max-width:160px;height:auto;border:0;outline:none;text-decoration:none;" />`;
}

function unescapeHtmlAttribute(value: string) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function normalizeUrlForCompare(value: string) {
  const raw = unescapeHtmlAttribute(value).trim();
  if (!raw) return '';
  try {
    return new URL(raw).toString();
  } catch {
    return raw;
  }
}

function imageSrcFromTag(tag: string) {
  const match = tag.match(/\bsrc\s*=\s*(["'])(.*?)\1/i) || tag.match(/\bsrc\s*=\s*([^\s>]+)/i);
  return match ? normalizeUrlForCompare(match[2] || match[1] || '') : '';
}

function hasAnyImage(html: string) {
  return /<img\b/i.test(String(html || ''));
}

function hasImageWithSrc(html: string, url: string) {
  const target = normalizeUrlForCompare(url);
  if (!target) return false;
  const tags = String(html || '').match(/<img\b[^>]*>/gi) || [];
  return tags.some((tag) => imageSrcFromTag(tag) === target);
}

function dedupeImageTags(html: string) {
  const seen = new Set<string>();
  return String(html || '').replace(/<img\b[^>]*>/gi, (tag) => {
    const src = imageSrcFromTag(tag);
    if (!src) return tag;
    if (seen.has(src)) return '';
    seen.add(src);
    return tag;
  });
}

export function signatureText(identity: SignatureIdentity) {
  const fallback = rawIdentity(identity);
  const rawText = String(identity.signature_text || fallback.signature_text || '').trim();
  if (rawText) return rawText;
  return htmlToText(String(identity.signature_html || fallback.signature_html || ''));
}

export function signatureHtml(identity: SignatureIdentity) {
  const fallback = rawIdentity(identity);
  const rawHtml = String(identity.signature_html || fallback.signature_html || '').trim();
  const logo = logoHtml(identity);
  const url = logoUrl(identity);
  if (rawHtml) {
    const cleanHtml = dedupeImageTags(rawHtml).trim();
    // If the saved HTML already contains the logo image, do not append it again.
    // If it contains any image at all, treat that as the signature logo and avoid a second logo.
    if (!logo || hasImageWithSrc(cleanHtml, url) || hasAnyImage(cleanHtml)) return cleanHtml;
    return `${cleanHtml}${logo}`;
  }
  const text = signatureText(identity);
  return text ? `${textToHtml(text)}${logo}` : logo.replace(/^<br \/><br \/>/, '');
}

export function shouldAppendSignature(identity: SignatureIdentity) {
  const fallback = rawIdentity(identity);
  const enabled = identity.signature_enabled !== undefined && identity.signature_enabled !== null ? identity.signature_enabled : fallback.signature_enabled;
  return enabled !== false && Boolean(signatureText(identity) || signatureHtml(identity) || logoUrl(identity));
}

export function appendSignatureToText(body: string, identity: SignatureIdentity) {
  const cleanBody = normalizeNewlines(body).trim();
  if (!shouldAppendSignature(identity)) return cleanBody;
  const sig = signatureText(identity);
  if (!sig) return cleanBody;
  if (cleanBody.includes(sig)) return cleanBody;
  return `${cleanBody}\n\n${sig}`.trim();
}

function compactSignatureText(value: string) {
  return normalizeNewlines(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

export function buildHtmlBody(body: string, identity: SignatureIdentity) {
  const bodyHtml = textToHtml(body);
  if (!shouldAppendSignature(identity)) return bodyHtml;
  const sig = signatureHtml(identity);
  if (!sig) return bodyHtml;

  // Signature application must be idempotent. The scheduled sender used to
  // pass a body that already contained the plain signature, then this HTML
  // builder appended it again. Gmail normally displays the HTML part, which
  // made recipients see the signature twice.
  const existingText = compactSignatureText(htmlToText(bodyHtml));
  const savedSignatureText = compactSignatureText(signatureText(identity));
  if (savedSignatureText && existingText.includes(savedSignatureText)) return bodyHtml;

  return `${bodyHtml}<br /><br />${sig}`;
}

function safeHeaderValue(value: string) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function safeAttachmentFilename(value: string) {
  return safeHeaderValue(value || 'attachment').replace(/["\\]/g, '').slice(0, 180) || 'attachment';
}

function wrapBase64(value: string) {
  return String(value || '').replace(/\s+/g, '').replace(/(.{76})/g, '$1\r\n');
}

export function buildMimeMessage(input: { from: string; to: string; subject: string; body: string; identity?: SignatureIdentity | null; replyTo?: string | null; attachments?: EmailAttachment[] | null }) {
  const identity = input.identity || {};
  const altBoundary = `scout_alt_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const mixedBoundary = `scout_mixed_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const attachments = (input.attachments || []).filter((item) => item && item.filename && item.contentBase64);
  const textBody = appendSignatureToText(input.body, identity);
  const htmlBody = buildHtmlBody(input.body, identity);
  const headers = [
    `From: ${safeHeaderValue(input.from)}`,
    `To: ${safeHeaderValue(input.to)}`,
    ...(input.replyTo ? [`Reply-To: ${safeHeaderValue(input.replyTo)}`] : []),
    `Subject: ${safeHeaderValue(input.subject)}`,
    'MIME-Version: 1.0',
    attachments.length
      ? `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`
      : `Content-Type: multipart/alternative; boundary="${altBoundary}"`
  ];
  const alternativeParts = [
    `--${altBoundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    textBody,
    `--${altBoundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    htmlBody,
    `--${altBoundary}--`,
    ''
  ];
  if (!attachments.length) return { raw: [...headers, '', ...alternativeParts].join('\r\n'), textBody, htmlBody };

  const mixedParts = [
    `--${mixedBoundary}`,
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    '',
    ...alternativeParts,
  ];
  for (const attachment of attachments) {
    const filename = safeAttachmentFilename(attachment.filename);
    const mimeType = safeHeaderValue(attachment.mimeType || 'application/octet-stream') || 'application/octet-stream';
    mixedParts.push(
      `--${mixedBoundary}`,
      `Content-Type: ${mimeType}; name="${filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${filename}"`,
      '',
      wrapBase64(attachment.contentBase64),
      ''
    );
  }
  mixedParts.push(`--${mixedBoundary}--`, '');
  return { raw: [...headers, '', ...mixedParts].join('\r\n'), textBody, htmlBody };
}
