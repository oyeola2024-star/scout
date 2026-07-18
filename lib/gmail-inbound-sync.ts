import type { SupabaseClient } from '@supabase/supabase-js';
import { createAppNotification, notificationTitleForInbound } from './notifications';

type AnyRecord = Record<string, any>;

type NormalizedInbound = {
  gmailMessageId: string;
  gmailThreadId: string;
  fromEmail: string;
  fromRaw: string;
  toEmail: string;
  toRaw: string;
  subject: string;
  snippet: string;
  body: string;
  receivedAt: string;
  labelIds: string[];
  candidateEmails: string[];
  raw: AnyRecord;
};

type Classification = {
  classification: string;
  replyBucket: 'real_reply' | 'auto_reply' | 'no_inbox' | 'blocked' | 'bounce_notice' | 'limit_notice' | 'temporary_failure' | 'unmatched' | 'ignored';
  isRealReply: boolean;
  isAutoReply: boolean;
  deliveryFailure: boolean;
  noInbox: boolean;
  blocked: boolean;
  limitNotice: boolean;
  temporary: boolean;
  ignored: boolean;
  businessStatus?: 'responded' | 'no_inbox' | 'bounced';
};

type SyncMode = 'replies' | 'bounces';

type SyncParams = {
  supabase: SupabaseClient<any, any, any>;
  workspaceId: string;
  accountId: string;
  maxResults?: number;
  mode: SyncMode;
  days?: number;
  /** When true, Scout lists recent Gmail message ids first and only fetches messages not already saved. */
  newOnly?: boolean;
  /** Safety guard for automatic app-open checks so Vercel does not hit 504. */
  deadlineMs?: number;
};

type InboundStats = {
  success: true;
  scanned: number;
  saved: number;
  matched: number;
  realReplies: number;
  autoReplies: number;
  noInbox: number;
  blocked: number;
  bounced: number;
  limitNotices: number;
  temporary: number;
  ignored: number;
  unmatched: number;
  accountEmail: string;
};

const SENT_COLUMNS = 'id,business_id,to_email,from_email,subject,template_id,gmail_account_id,batch_id,provider_message_id,gmail_thread_id,sent_at';

export function formatInboundError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

function normalizeEmail(value: unknown) {
  const raw = String(value || '').toLowerCase().replace(/<([^>]+)>/g, ' $1 ');
  const match = raw.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return match?.[0] || '';
}

function extractEmails(value: unknown) {
  const text = String(value || '').toLowerCase().replace(/<([^>]+)>/g, ' $1 ');
  const matches = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
  const bad = ['mailer-daemon', 'postmaster', 'noreply', 'no-reply', 'donotreply', 'do-not-reply'];
  return Array.from(new Set(matches.map((m) => m.toLowerCase()).filter((email) => !bad.some((term) => email.includes(term)))));
}

function header(headers: Array<{ name?: string; value?: string }> | undefined, name: string) {
  return (headers || []).find((h) => String(h.name || '').toLowerCase() === name.toLowerCase())?.value || '';
}

function decodeBody(data?: string) {
  if (!data) return '';
  try {
    const padded = data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function stripHtml(input: string) {
  return input
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectBodyParts(part: AnyRecord | undefined, out: { plain: string[]; html: string[] }) {
  if (!part) return;
  const mime = String(part.mimeType || '').toLowerCase();
  const data = part.body?.data ? decodeBody(String(part.body.data)) : '';
  if (data && mime.includes('text/plain')) out.plain.push(data);
  if (data && mime.includes('text/html')) out.html.push(stripHtml(data));
  const parts = Array.isArray(part.parts) ? part.parts : [];
  for (const child of parts) collectBodyParts(child, out);
}

async function refreshAccessToken(refreshToken: string) {
  const clientId = process.env.GOOGLE_CLIENT_ID || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) throw new Error('GOOGLE_CLIENT_ID/NEXT_PUBLIC_GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in Vercel.');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    signal: AbortSignal.timeout(12000),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' })
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json?.error_description || json?.error || `Token refresh failed with HTTP ${response.status}`);
  return { access_token: String(json.access_token || ''), expires_in: Number(json.expires_in || 3600) };
}

async function gmailJson(accessToken: string, url: string) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(12000)
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json?.error?.message || json?.error || `Gmail request failed with HTTP ${response.status}`);
  return json;
}

async function ensureAccessToken(supabase: SupabaseClient<any, any, any>, workspaceId: string, account: AnyRecord) {
  let accessToken = String(account.access_token || '');
  const expiresAt = account.expires_at ? new Date(account.expires_at).getTime() : 0;
  if (!accessToken || expiresAt < Date.now() + 60_000) {
    if (!account.refresh_token) throw new Error('Access token expired and no refresh token is stored. Reconnect Gmail in Settings.');
    const refreshed = await refreshAccessToken(String(account.refresh_token));
    accessToken = refreshed.access_token;
    await supabase.from('gmail_accounts').update({
      access_token: accessToken,
      expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
      last_error: null,
      updated_at: new Date().toISOString()
    }).eq('workspace_id', workspaceId).eq('id', account.id);
  }
  return accessToken;
}

function normalizeGmailMessage(msg: AnyRecord): NormalizedInbound {
  const headers = msg.payload?.headers || [];
  const fromRaw = header(headers, 'From');
  const toRaw = header(headers, 'To');
  const subject = header(headers, 'Subject');
  const parts = { plain: [] as string[], html: [] as string[] };
  collectBodyParts(msg.payload, parts);
  const body = (parts.plain.join('\n') || parts.html.join('\n') || String(msg.snippet || '')).trim();
  const snippet = String(msg.snippet || '').trim();
  const textForEmails = `${fromRaw}\n${toRaw}\n${subject}\n${snippet}\n${body}`;
  return {
    gmailMessageId: String(msg.id || ''),
    gmailThreadId: String(msg.threadId || ''),
    fromEmail: normalizeEmail(fromRaw),
    fromRaw,
    toEmail: normalizeEmail(toRaw),
    toRaw,
    subject,
    snippet,
    body,
    receivedAt: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : new Date().toISOString(),
    labelIds: Array.isArray(msg.labelIds) ? msg.labelIds : [],
    candidateEmails: extractEmails(textForEmails),
    raw: { source: 'native_gmail_inbound_sync', gmail: msg, fromRaw, toRaw, subject, snippet }
  };
}

function classifyInbound(message: NormalizedInbound, sentMatch: AnyRecord | null, accountEmail: string): Classification {
  const text = `${message.fromRaw} ${message.fromEmail} ${message.subject} ${message.snippet} ${message.body}`.toLowerCase();
  const isSelf = message.fromEmail && message.fromEmail === accountEmail.toLowerCase();
  const noInboxTerms = [
    'address not found', 'user unknown', 'no such user', 'mailbox unavailable', 'mailbox not found',
    'recipient address rejected', 'does not exist', 'doesn\'t exist', '550 5.1.1', '5.1.1',
    'recipient not found', 'unknown recipient', 'invalid recipient', 'delivery to the following recipient failed permanently',
    'the email account that you tried to reach does not exist', 'unable to receive mail', 'no such recipient'
  ];
  const blockedTerms = [
    'message blocked', 'blocked', 'rejected due to security', 'rejected by our system', 'policy reason',
    'spam content', 'looks like spam', 'similar to messages that were identified as spam', 'unsolicited mail',
    'not accepted due to spam', 'rejected as spam', 'policy violation', 'our system has detected that this message is suspicious'
  ];
  const bounceTerms = [
    'mailer-daemon', 'mail delivery subsystem', 'postmaster', 'delivery status notification', 'undeliverable',
    'message not delivered', 'delivery incomplete', 'delivery failed', 'permanent failure', 'failure notice',
    'returned mail', 'delivery has failed'
  ];
  const limitTerms = ['sending limit', 'rate limit', 'quota exceeded', 'daily user sending quota exceeded', 'too many messages', 'user-rate limit', 'mail sending limit exceeded'];
  const autoHeaders = Array.isArray((message.raw as AnyRecord)?.gmail?.payload?.headers)
    ? ((message.raw as AnyRecord).gmail.payload.headers as AnyRecord[])
    : [];
  const autoHeaderText = autoHeaders
    .map((h) => `${String(h.name || '').toLowerCase()}: ${String(h.value || '').toLowerCase()}`)
    .join('\n');
  const autoHeaderTerms = [
    'auto-submitted: auto-replied',
    'auto-submitted: auto-generated',
    'auto-submitted: auto-notified',
    'x-autoreply:',
    'x-autorespond:',
    'x-auto-response-suppress:',
    'x-ms-exchange-inbox-rules-loop:',
    'x-loop:',
    'precedence: auto_reply',
    'precedence: bulk',
    'precedence: junk',
    'submitted: auto-replied',
    'submitted: auto-generated'
  ];
  const autoTerms = [
    'out of office', 'out-of-office', 'ooo', 'o.o.o', 'automatic reply', 'automatic response',
    'auto-reply', 'auto reply', 'autoreply', 'auto responder', 'autoresponder', 'vacation responder',
    'vacation reply', 'away message', 'absence message', 'away from the office', 'currently away',
    'i am away', 'i’m away', 'i am currently away', 'i’m currently away', 'i am out of the office',
    'i’m out of the office', 'out of the office until', 'away until', 'returning on', 'back on',
    'annual leave', 'on leave', 'maternity leave', 'paternity leave', 'sick leave', 'holiday leave',
    'limited access to email', 'limited access to my email', 'limited email access', 'not checking email',
    'not monitoring email', 'currently unavailable', 'i am unavailable', 'i’m unavailable',
    'thank you for your email. i am away', 'thank you for your message. i am away',
    'this is an automated response', 'this is an automated reply', 'this is an automated message',
    'this is an automatic response', 'this is an automatic reply', 'this is an automatic message',
    'this response was automatically generated', 'this reply was automatically generated',
    'this message was generated automatically', 'this email was generated automatically',
    'system generated message', 'system-generated message', 'automated notification', 'automatic notification',
    'this is a notification only', 'this mailbox is not monitored', 'this inbox is not monitored',
    'please do not reply to this email', 'please do not respond to this email', 'do not reply to this email',
    'do not respond to this message', 'do-not-reply', 'donotreply', 'no-reply', 'noreply',
    'your request has been received', 'we have received your request', 'we have received your message',
    'we received your email', 'support ticket has been created', 'ticket has been created',
    'case has been created', 'your ticket number', 'your case number', 'thanks for contacting support',
    'thank you for contacting us', 'we will get back to you shortly', 'we will respond as soon as possible',
    'someone from our team will get back to you', 'we aim to respond within', 'we aim to reply within',
    'this is an automated acknowledgement', 'automated acknowledgement', 'automatic acknowledgement',
    'acknowledgement of receipt', 'receipt confirmation', 'confirmation of receipt', 'message received',
    'email received', 'inquiry received', 'enquiry received',
    'we’ve received your message', "we\'ve received your message", 'we’ve received your request', "we\'ve received your request",
    'we received your message', 'we received your request', 'received your message', 'received your request',
    'request received', 'ticket received', 'case received', 'ticket created', 'case created',
    'request has been received and is being reviewed', 'has been received and is being reviewed',
    'being reviewed by our support staff', 'our support team is already looking', 'our team is already looking',
    'we will be in touch', 'we’ll be in touch', "we\'ll be in touch", 'we will contact you shortly',
    'we will respond within', 'we respond within', 'within 24 hours', 'within 48 hours',
    'response time:', 'ticket number:', 'ticket id', 'ticket-id', 'case number:', 'case id',
    'to add additional comments, reply to this email', 'please type your reply above this line',
    'delivered by zendesk', 'zendesk', 'reamaze', 'freshdesk', 'gorgias',
    'we confirm the receipt', 'we confirm receipt', 'confirmation of receipt', 'receipt of your email',
    'thank you for your recent email', 'thanks for your recent email', 'thank you for getting in touch',
    'we have created a support ticket', 'created a support ticket', 'assigned you case number',
    'your inquiry has been received', 'your enquiry has been received', 'your inquiry was received',
    'your email has been received', 'your message has been received', 'your request was received',
    'we are currently experiencing a high volume', 'due to high volume', 'due to an unusually high',
    'do not open multiple tickets', 'support staff', 'customer service team',
    'automatische antwort', 'automatische antwort:', 'automatisch erzeugte', 'automatisch verschickte',
    'eingangsbestätigung', 'empfangsbestätigung', 'anfrage eingegangen', 'anfrage ist bei uns eingegangen',
    'ihre anfrage ist bei uns eingegangen', 'deine anfrage ist bei uns eingegangen',
    'ihre nachricht ist bei uns eingegangen', 'deine nachricht ist bei uns eingegangen',
    'vielen dank für ihre nachricht', 'vielen dank für deine nachricht', 'danke für deine nachricht',
    'wir haben deine nachricht erhalten', 'wir haben ihre nachricht erhalten', 'wir haben ihre e-mail erhalten',
    'anliegen wurde erstellt', 'wurde erstellt', 'ticketnummer', 'ticket-nummer', 'ticket id:',
    'teilen sie uns ihr feedback mit', 'zufriedenheit', 'bearbeitung ihrer anfrage', 'bearbeitung deiner anfrage',
    'wir melden uns', 'melden uns schnellstmöglich', 'schnellstmöglich bearbeiten', 'so schnell wie möglich beantworten',
    'wir kümmern uns schnellstmöglich', 'eingegangen und wird', 'bearbeitungszeit',
    'wir haben deine anfrage erhalten', 'wir haben ihre anfrage erhalten', 'wir haben deine e-mail erhalten',
    'wir haben ihre e-mail erhalten', 'wir haben diese erhalten', 'deine nachricht ist gut angekommen',
    'ihre nachricht ist gut angekommen', 'deine nachricht hat uns erreicht', 'ihre nachricht hat uns erreicht',
    'vielen dank für die nachricht', 'vielen dank für ihre e-mail', 'vielen dank für deine e-mail',
    'danke für ihre e-mail', 'danke für deine e-mail', 'wir bearbeiten deine anfrage', 'wir bearbeiten ihre anfrage',
    'wird nun von unserem team bearbeitet', 'wird von unserem team bearbeitet', 'wird bearbeitet',
    'du liest gerade eine automatisch verschickte email', 'automatisch verschickte email', 'automatisch erzeugte bestätigung',
    'automatisch erzeugte bestaetigung', 'automatische bestätigung', 'automatische bestaetigung',
    'dies ist eine automatisch erzeugte', 'dies ist eine automatische', 'bitte antworten sie nicht', 'bitte nicht antworten',
    'nicht beantwortet', 'keine antwort', 'no reply', 'noreply:', 'ticket empfangen', 'ticket received',
    'ticket wurde erstellt', 'ticket erstellt', 'anliegen erstellt', 'fallnummer', 'vorgangsnummer', 'referenznummer',
    'bearbeitungsnummer', 'case id', 'request id', 'kundenservice', 'support-team', 'support team',
    'aktuell ein erhöhtes aufkommen', 'erhöhtes aufkommen', 'hohes aufkommen', 'hohe anzahl', 'bitten um geduld',
    'bitten wir um geduld', 'bitte haben sie geduld', 'bitte habe geduld', 'bitte etwas geduld',
    'innerhalb von 24 stunden', 'innerhalb von 48 stunden', 'innerhalb 24 stunden', 'innerhalb 48 stunden',
    'innerhalb der nächsten', 'innerhalb der naechsten', 'wir melden uns in kürze', 'wir melden uns in kuerze',
    'wir melden uns schnellstmöglich', 'wir melden uns schnellstmoeglich', 'wir werden uns schnellstmöglich',
    'wir werden uns schnellstmoeglich', 'wird schnellstmöglich bearbeitet', 'wird schnellstmoeglich bearbeitet',
    'feedback mit', 'bewerten sie', 'bewerte uns', 'zufriedenheitsumfrage', 'kundenzufriedenheit',
    // French auto/ticket/receipt patterns for France + Canada.
    'réponse automatique', 'reponse automatique', 'message automatique', 'absence du bureau',
    'accusé de réception', 'accuse de reception', 'confirmation de réception', 'confirmation de reception',
    'nous confirmons la réception', 'nous confirmons la reception', 'nous avons reçu votre demande',
    'nous avons reçu votre message', 'nous avons bien reçu votre message', 'votre demande a été reçue',
    'votre demande a ete recue', 'votre message a été reçu', 'votre message a ete recu',
    'demande reçue', 'demande recue', 'ticket créé', 'ticket cree', 'numéro de ticket', 'numero de ticket',
    'numéro de dossier', 'numero de dossier', 'service client', 'support client', 'nous vous répondrons',
    'nous vous repondrons', 'nous reviendrons vers vous', 'dans les plus brefs délais',
    'dans les plus brefs delais', 'dès que possible', 'des que possible', 'merci de votre patience',
    'merci de nous avoir contactés', 'merci de nous avoir contactes', 'merci pour votre message',
    // Spanish auto/ticket/receipt patterns for Spain and Spanish-speaking targets.
    'respuesta automática', 'respuesta automatica', 'respuesta auto', 'fuera de la oficina',
    'acuse de recibo', 'confirmación de recepción', 'confirmacion de recepcion',
    'hemos recibido su mensaje', 'hemos recibido tu mensaje', 'hemos recibido su solicitud',
    'hemos recibido tu solicitud', 'su solicitud ha sido recibida', 'tu solicitud ha sido recibida',
    'mensaje recibido', 'solicitud recibida', 'ticket creado', 'caso creado', 'número de ticket',
    'numero de ticket', 'número de caso', 'numero de caso', 'nos pondremos en contacto',
    'nos comunicaremos con usted', 'lo antes posible', 'a la brevedad', 'dentro de 24 horas',
    'dentro de 48 horas', 'gracias por contactarnos', 'gracias por su mensaje', 'no responda a este correo',
    'correo generado automáticamente', 'correo generado automaticamente',
    // Italian auto/ticket/receipt patterns.
    'risposta automatica', 'fuori ufficio', 'conferma di ricezione', 'abbiamo ricevuto il tuo messaggio',
    'abbiamo ricevuto il suo messaggio', 'abbiamo ricevuto la tua richiesta', 'abbiamo ricevuto la sua richiesta',
    'richiesta ricevuta', 'ticket creato', 'numero di ticket', 'servizio clienti', 'ti risponderemo',
    'le risponderemo', 'il prima possibile', 'entro 24 ore', 'entro 48 ore',
    'abbiamo ricevuto', 'la tua richiesta è stata ricevuta', 'la sua richiesta è stata ricevuta',
    'grazie per averci contattato', 'grazie per il tuo messaggio', 'grazie per il suo messaggio',
    // Dutch auto/ticket/receipt patterns.
    'automatisch antwoord', 'automatische reactie', 'afwezigheidsbericht', 'wij hebben uw bericht ontvangen',
    'we hebben uw bericht ontvangen', 'wij hebben je bericht ontvangen', 'we hebben je bericht ontvangen',
    'uw aanvraag is ontvangen', 'je aanvraag is ontvangen', 'ticket aangemaakt', 'ticketnummer',
    'zaaknummer', 'klantenservice', 'wij nemen contact met u op', 'we nemen contact met je op',
    'zo snel mogelijk', 'binnen 24 uur', 'binnen 48 uur', 'bedankt voor uw bericht', 'bedankt voor je bericht'
  ];
  const temporaryTerms = ['temporary failure', 'try again later', 'deferred', '4.2.0', '4.4.1', '4.7.0', 'temporarily unavailable', 'greylisted'];

  if (limitTerms.some((term) => text.includes(term))) return { classification: 'gmail_limit_notice', replyBucket: 'limit_notice', isRealReply: false, isAutoReply: false, deliveryFailure: false, noInbox: false, blocked: false, limitNotice: true, temporary: false, ignored: false };
  if (noInboxTerms.some((term) => text.includes(term))) return { classification: 'no_inbox', replyBucket: 'no_inbox', isRealReply: false, isAutoReply: false, deliveryFailure: true, noInbox: true, blocked: false, limitNotice: false, temporary: false, ignored: false, businessStatus: 'no_inbox' };
  if (blockedTerms.some((term) => text.includes(term))) return { classification: 'message_blocked', replyBucket: 'blocked', isRealReply: false, isAutoReply: false, deliveryFailure: true, noInbox: false, blocked: true, limitNotice: false, temporary: false, ignored: false, businessStatus: 'bounced' };
  if (bounceTerms.some((term) => text.includes(term))) return { classification: 'bounce_notice', replyBucket: 'bounce_notice', isRealReply: false, isAutoReply: false, deliveryFailure: true, noInbox: false, blocked: false, limitNotice: false, temporary: false, ignored: false, businessStatus: 'bounced' };
  if (temporaryTerms.some((term) => text.includes(term))) return { classification: 'temporary_failure', replyBucket: 'temporary_failure', isRealReply: false, isAutoReply: false, deliveryFailure: false, noInbox: false, blocked: false, limitNotice: false, temporary: true, ignored: false };
  const humanReplyTerms = [
    // English human intent. These count even when the subject starts with Re/Fw.
    'we don\'t need', 'we do not need', 'we are not interested', 'not interested', 'not looking to', 'not looking for',
    'we are not looking', 'we\'re not looking', 'we appreciate your', 'appreciate your insight', 'appreciate the insight',
    'thanks for sharing', 'thank you for sharing', 'thank you for reaching out and sharing', 'we value thoughtful',
    'your email itself is', 'highly unprofessional', 'please send', 'can you send', 'could you send', 'send more details',
    'tell me more', 'book a call', 'schedule a call', 'let us talk', 'let\'s talk', 'we would be interested', 'sounds interesting',
    'we already have', 'we are happy with', 'this is not something', 'no thank you', 'no thanks', 'unsubscribe us',
    'remove us', 'remove me', 'please remove', 'stop emailing', 'stop contacting', 'we will pass', 'we are passing',
    // German human intent. These are translated intent patterns, not just German language.
    'kein interesse', 'nicht interessiert', 'haben kein interesse', 'wir haben kein interesse', 'kein bedarf',
    'wir haben keinen bedarf', 'brauchen wir nicht', 'benötigen wir nicht', 'wir brauchen das nicht',
    'wir benötigen das nicht', 'nicht auf der suche', 'wir sind nicht auf der suche', 'kommt für uns nicht in frage',
    'bitte senden sie', 'bitte schick', 'schicken sie', 'senden sie', 'können sie uns', 'könnt ihr uns',
    'bitte um weitere informationen', 'weitere informationen', 'mehr informationen', 'angebot senden',
    'termin vereinbaren', 'telefonat', 'rufen sie', 'lass uns sprechen', 'lassen sie uns sprechen',
    'unprofessionell', 'ihre e-mail', 'deine e-mail', 'vorschlag', 'nicht relevant', 'entfernen sie uns',
    // French human intent.
    'pas intéressé', 'pas interessee', 'pas interesse', 'nous ne sommes pas intéressés', 'nous ne sommes pas interesses',
    'nous n’avons pas besoin', "nous n'avons pas besoin", "ce n'est pas nécessaire", 'pas pour nous',
    'envoyez', 'pouvez-vous envoyer', 'pouvez vous envoyer', 'plus de détails', 'plus de details',
    'prendre rendez-vous', 'appel téléphonique', 'appel telephonique', 'nous sommes intéressés',
    'nous sommes interesses', 'quel est le prix', 'tarif', 'merci pour votre proposition',
    // Spanish/Italian/Dutch human intent.
    'no estamos interesados', 'no nos interesa', 'no necesitamos', 'no es para nosotros',
    'puede enviar', 'puedes enviar', 'más detalles', 'mas detalles', 'cuál es el precio', 'cual es el precio',
    'agendar una llamada', 'programar una llamada', 'nos interesa', 'estamos interesados',
    'non siamo interessati', 'non ci interessa', 'non ne abbiamo bisogno', 'non fa per noi',
    'può inviare', 'puoi inviare', 'maggiori dettagli', 'qual è il prezzo', 'fissare una chiamata',
    'niet geïnteresseerd', 'niet geinteresseerd', 'geen interesse', 'niet nodig', 'niet voor ons',
    'kunt u sturen', 'kan je sturen', 'meer informatie', 'wat kost het', 'belafspraak'
  ];
  const hasHumanReplySignal = Boolean(sentMatch) && humanReplyTerms.some((term) => text.includes(term));
  const hasAutoHeaderSignal = autoHeaderTerms.some((term) => autoHeaderText.includes(term));
  const hasAutoBodySignal = autoTerms.some((term) => text.includes(term));
  const hasReplySubjectSignal = /^\s*(re|aw|sv|antw|ré|fw|fwd)\s*[:：]/i.test(String(message.subject || ''));
  if (isSelf) return { classification: 'self_message_ignored', replyBucket: 'ignored', isRealReply: false, isAutoReply: false, deliveryFailure: false, noInbox: false, blocked: false, limitNotice: false, temporary: false, ignored: true };
  if (!sentMatch) return { classification: 'unmatched_inbound', replyBucket: 'unmatched', isRealReply: false, isAutoReply: false, deliveryFailure: false, noInbox: false, blocked: false, limitNotice: false, temporary: false, ignored: true };
  if (hasHumanReplySignal) return { classification: 'real_reply', replyBucket: 'real_reply', isRealReply: true, isAutoReply: false, deliveryFailure: false, noInbox: false, blocked: false, limitNotice: false, temporary: false, ignored: false, businessStatus: 'responded' };
  if (hasAutoHeaderSignal || hasAutoBodySignal) return { classification: 'auto_reply', replyBucket: 'auto_reply', isRealReply: false, isAutoReply: true, deliveryFailure: false, noInbox: false, blocked: false, limitNotice: false, temporary: false, ignored: false };
  // v10.16: matched inbound messages that are not bounces and not clear auto replies count as real.
  // Re/AW/FW subjects are a useful signal, but Scout also accepts clean matched inbound messages without them.
  return { classification: hasReplySubjectSignal ? 'real_reply' : 'real_reply', replyBucket: 'real_reply', isRealReply: true, isAutoReply: false, deliveryFailure: false, noInbox: false, blocked: false, limitNotice: false, temporary: false, ignored: false, businessStatus: 'responded' };
}
async function findSentMatch(supabase: SupabaseClient<any, any, any>, workspaceId: string, message: NormalizedInbound) {
  if (message.gmailThreadId) {
    const { data, error } = await supabase
      .from('sent_messages')
      .select(SENT_COLUMNS)
      .eq('workspace_id', workspaceId)
      .eq('gmail_thread_id', message.gmailThreadId)
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data) return data as AnyRecord;
  }

  const candidates = Array.from(new Set([message.fromEmail, ...message.candidateEmails].filter(Boolean))).slice(0, 12);
  for (const email of candidates) {
    const { data, error } = await supabase
      .from('sent_messages')
      .select(SENT_COLUMNS)
      .eq('workspace_id', workspaceId)
      .ilike('to_email', email)
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data) return data as AnyRecord;
  }
  return null;
}

async function saveReplyHistory(supabase: SupabaseClient<any, any, any>, payload: AnyRecord): Promise<'inserted' | 'updated'> {
  const { data, error } = await supabase
    .from('reply_history')
    .select('id')
    .eq('workspace_id', payload.workspace_id)
    .eq('gmail_message_id', payload.gmail_message_id)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (data?.id) {
    const { error: updateError } = await supabase.from('reply_history').update(payload).eq('id', data.id);
    if (updateError) throw updateError;
    return 'updated';
  }
  const { error: insertError } = await supabase.from('reply_history').insert(payload);
  if (insertError) throw insertError;
  return 'inserted';
}

async function existingInboundMessageIds(supabase: SupabaseClient<any, any, any>, workspaceId: string, ids: string[]) {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (!unique.length) return new Set<string>();
  const found = new Set<string>();
  const chunkSize = 100;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from('reply_history')
      .select('gmail_message_id')
      .eq('workspace_id', workspaceId)
      .in('gmail_message_id', chunk);
    if (error) throw error;
    for (const row of data || []) {
      const id = String((row as AnyRecord).gmail_message_id || '');
      if (id) found.add(id);
    }
  }
  return found;
}

async function saveNoInboxRecord(supabase: SupabaseClient<any, any, any>, payload: AnyRecord) {
  const { data, error } = await supabase
    .from('no_inbox_records')
    .select('id')
    .eq('workspace_id', payload.workspace_id)
    .eq('gmail_message_id', payload.gmail_message_id)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (data?.id) {
    const { error: updateError } = await supabase.from('no_inbox_records').update(payload).eq('id', data.id);
    if (updateError) throw updateError;
    return 'updated';
  }
  const { error: insertError } = await supabase.from('no_inbox_records').insert(payload);
  if (insertError) throw insertError;
  return 'inserted';
}


function isUsableFailureTarget(email: string | null | undefined, accountEmail: string, message: NormalizedInbound, sentMatch: AnyRecord | null) {
  const value = normalizeEmail(email || '');
  if (!value) return false;
  const selfEmails = new Set([
    normalizeEmail(accountEmail),
    normalizeEmail(message.toEmail),
    normalizeEmail(sentMatch?.from_email),
    normalizeEmail(sentMatch?.sender_email),
    normalizeEmail(sentMatch?.reply_to_email)
  ].filter(Boolean));
  if (selfEmails.has(value)) return false;
  if (value.includes('mailer-daemon') || value.includes('postmaster')) return false;
  if (value.endsWith('@googlemail.com') || value.endsWith('@gmail.com') && value === normalizeEmail(accountEmail)) return false;
  return true;
}

function findFailureTargetEmail(message: NormalizedInbound, sentMatch: AnyRecord | null, accountEmail: string) {
  const sentTo = normalizeEmail(sentMatch?.to_email || '');
  if (isUsableFailureTarget(sentTo, accountEmail, message, sentMatch)) return sentTo;
  for (const email of message.candidateEmails) {
    if (isUsableFailureTarget(email, accountEmail, message, sentMatch)) return email;
  }
  return null;
}

async function applyClassificationUpdates(supabase: SupabaseClient<any, any, any>, workspaceId: string, message: NormalizedInbound, sentMatch: AnyRecord | null, classification: Classification, accountId: string, accountEmail: string) {
  const targetEmail = classification.noInbox || classification.blocked || classification.classification === 'bounce_notice'
    ? findFailureTargetEmail(message, sentMatch, accountEmail)
    : (sentMatch?.to_email || message.fromEmail || null);
  const saveStatus = await saveReplyHistory(supabase, {
    workspace_id: workspaceId,
    business_id: sentMatch?.business_id || null,
    sent_message_id: sentMatch?.id || null,
    template_id: sentMatch?.template_id || null,
    gmail_account_id: sentMatch?.gmail_account_id || accountId,
    batch_id: sentMatch?.batch_id || null,
    from_email: message.fromEmail || message.fromRaw,
    to_email: message.toEmail || targetEmail,
    subject: message.subject,
    snippet: message.snippet || message.body.slice(0, 240),
    body: message.body,
    classification: classification.classification,
    reply_bucket: classification.replyBucket,
    is_real_reply: classification.isRealReply,
    is_auto_reply: classification.isAutoReply,
    is_delivery_failure: classification.deliveryFailure,
    is_blocked: classification.blocked,
    is_limit_notice: classification.limitNotice,
    is_temporary: classification.temporary,
    received_at: message.receivedAt,
    gmail_message_id: message.gmailMessageId,
    gmail_thread_id: message.gmailThreadId || sentMatch?.gmail_thread_id || null,
    matched_status: sentMatch ? 'matched' : 'unmatched',
    raw: { ...message.raw, classification, sent_match_id: sentMatch?.id || null, candidateEmails: message.candidateEmails }
  });

  if (sentMatch?.id) {
    const deliveryStatus = classification.isRealReply ? 'replied' : classification.isAutoReply ? 'auto_replied' : classification.classification;
    await supabase.from('sent_messages').update({
      delivery_status: deliveryStatus,
      error_code: classification.isRealReply || classification.isAutoReply ? null : classification.classification,
      last_reply_at: classification.isRealReply || classification.isAutoReply ? message.receivedAt : sentMatch.last_reply_at || null
    }).eq('workspace_id', workspaceId).eq('id', sentMatch.id);
  }

  if (sentMatch?.business_id) {
    const businessPatch: AnyRecord = {
      reply_state: classification.replyBucket,
      last_reply_classification: classification.classification,
      last_inbound_at: message.receivedAt,
      updated_at: new Date().toISOString()
    };
    if (classification.isRealReply) {
      businessPatch.status = 'responded';
      businessPatch.reply_state = 'real_reply';
      businessPatch.last_real_reply_at = message.receivedAt;
    } else if (classification.isAutoReply) {
      businessPatch.reply_state = 'auto_reply';
      businessPatch.last_auto_reply_at = message.receivedAt;
    } else if (classification.businessStatus) {
      businessPatch.status = classification.businessStatus;
    }
    await supabase.from('businesses').update(businessPatch).eq('workspace_id', workspaceId).eq('id', sentMatch.business_id);
  }


  // Bell notifications are only created for newly saved inbound messages.
  // This keeps refresh/open checks from re-alerting old replies that were already synced.
  const shouldNotify = saveStatus === 'inserted' && (classification.isRealReply || classification.deliveryFailure || classification.limitNotice || classification.noInbox || classification.blocked || classification.classification === 'bounce_notice');
  if (shouldNotify) {
    const title = notificationTitleForInbound(classification.classification, message.fromEmail || targetEmail || '', null);
    const shortMessage = [message.subject, message.snippet || message.body.slice(0, 180)].filter(Boolean).join(' - ').slice(0, 320);
    await createAppNotification(supabase, {
      workspaceId,
      type: classification.isRealReply ? 'real_reply' : classification.limitNotice ? 'gmail_limit_notice' : classification.classification,
      title,
      message: shortMessage || classification.classification,
      entityType: 'gmail_message',
      entityId: message.gmailMessageId,
      businessId: sentMatch?.business_id || null,
      raw: {
        classification,
        from: message.fromEmail || message.fromRaw,
        to: targetEmail || message.toEmail,
        subject: message.subject,
        sent_message_id: sentMatch?.id || null,
        gmail_thread_id: message.gmailThreadId || sentMatch?.gmail_thread_id || null
      }
    });
  }

  if (classification.limitNotice) {
    await supabase.from('gmail_accounts').update({
      status: 'limit_hit',
      paused_until: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      last_error: message.subject || 'Gmail sending limit notice detected',
      updated_at: new Date().toISOString()
    }).eq('workspace_id', workspaceId).eq('id', accountId);
  }

  if ((classification.noInbox || classification.blocked || classification.classification === 'bounce_notice') && targetEmail) {
    await saveNoInboxRecord(supabase, {
      workspace_id: workspaceId,
      business_id: sentMatch?.business_id || null,
      sent_message_id: sentMatch?.id || null,
      gmail_account_id: sentMatch?.gmail_account_id || accountId,
      template_id: sentMatch?.template_id || null,
      email: targetEmail,
      reason: classification.classification,
      status: classification.noInbox ? 'no_inbox' : classification.blocked ? 'message_blocked' : 'bounce_notice',
      type: classification.replyBucket,
      bounce_type: classification.classification,
      from_email: message.fromEmail || message.fromRaw || null,
      to_email: message.toEmail || targetEmail,
      subject: message.subject,
      snippet: message.snippet || message.body.slice(0, 240),
      gmail_message_id: message.gmailMessageId,
      gmail_thread_id: message.gmailThreadId || sentMatch?.gmail_thread_id || null,
      raw: { ...message.raw, classification, sent_match_id: sentMatch?.id || null, candidateEmails: message.candidateEmails }
    });
  }
}

async function recentScoutSentRows(
  supabase: SupabaseClient<any, any, any>,
  workspaceId: string,
  accountId: string,
  days: number,
  limit: number,
) {
  const since = new Date(Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('sent_messages')
    .select(SENT_COLUMNS)
    .eq('workspace_id', workspaceId)
    .eq('gmail_account_id', accountId)
    .eq('status', 'sent')
    .gte('sent_at', since)
    .order('sent_at', { ascending: false })
    .limit(Math.max(1, Math.min(limit, 2000)));
  if (error) throw error;
  return (data || []) as AnyRecord[];
}

function addStats(stats: InboundStats, classification: Classification) {
  if (classification.isRealReply) stats.realReplies += 1;
  else if (classification.isAutoReply) stats.autoReplies += 1;
  else if (classification.noInbox) stats.noInbox += 1;
  else if (classification.blocked) stats.blocked += 1;
  else if (classification.classification === 'bounce_notice') stats.bounced += 1;
  else if (classification.limitNotice) stats.limitNotices += 1;
  else if (classification.temporary) stats.temporary += 1;
  else if (classification.classification === 'unmatched_inbound') stats.unmatched += 1;
  else stats.ignored += 1;
}

async function processScopedMessage(
  supabase: SupabaseClient<any, any, any>,
  workspaceId: string,
  accountId: string,
  accountEmail: string,
  gmailMessage: AnyRecord,
  mode: SyncMode,
  stats: InboundStats,
) {
  const normalized = normalizeGmailMessage(gmailMessage);
  const sentMatch = await findSentMatch(supabase, workspaceId, normalized);
  if (!sentMatch || String(sentMatch.gmail_account_id || '') !== accountId) {
    stats.ignored += 1;
    return;
  }
  stats.matched += 1;
  const classification = classifyInbound(normalized, sentMatch, accountEmail);
  if (classification.ignored || classification.classification === 'unmatched_inbound') {
    stats.ignored += 1;
    return;
  }
  if (mode === 'bounces' && !classification.noInbox && !classification.blocked && classification.classification !== 'bounce_notice' && !classification.temporary) {
    stats.ignored += 1;
    return;
  }
  await applyClassificationUpdates(supabase, workspaceId, normalized, sentMatch, classification, accountId, accountEmail);
  stats.saved += 1;
  addStats(stats, classification);
}

function bounceSearchQuery(days: number, recipients: string[]) {
  const recipientTerms = recipients.map((email) => `"${email.replace(/"/g, '')}"`).join(' ');
  return `newer_than:${days}d (from:mailer-daemon OR from:postmaster OR from:"Mail Delivery Subsystem" OR subject:Undelivered OR subject:"Delivery Status Notification" OR subject:"Message blocked") {${recipientTerms}}`;
}

export async function syncGmailInbound({ supabase, workspaceId, accountId, maxResults = 100, mode, days = 30, newOnly = false, deadlineMs }: SyncParams): Promise<InboundStats> {
  if (!workspaceId || !accountId) throw new Error('workspace_id and gmail_account_id are required.');
  const startedAt = Date.now();
  const limit = Math.max(1, Math.min(Number(maxResults || 100), newOnly ? 50 : 500));
  const { data: account, error: accountError } = await supabase.from('gmail_accounts').select('*').eq('workspace_id', workspaceId).eq('id', accountId).single();
  if (accountError || !account) throw new Error(accountError?.message || 'Gmail account not found.');

  const accessToken = await ensureAccessToken(supabase, workspaceId, account as AnyRecord);
  const accountEmail = String((account as AnyRecord).email || '').toLowerCase();
  const sentRows = await recentScoutSentRows(supabase, workspaceId, accountId, Math.max(1, Math.min(Number(days || 30), 90)), 2000);
  const stats: InboundStats = { success: true, scanned: 0, saved: 0, matched: 0, realReplies: 0, autoReplies: 0, noInbox: 0, blocked: 0, bounced: 0, limitNotices: 0, temporary: 0, ignored: 0, unmatched: 0, accountEmail };

  if (!sentRows.length) {
    await supabase.from('gmail_accounts').update({ last_error: null, updated_at: new Date().toISOString() }).eq('workspace_id', workspaceId).eq('id', accountId);
    return stats;
  }

  const processedMessageIds = new Set<string>();
  const knownOutboundIds = new Set(sentRows.map((row) => String(row.provider_message_id || '')).filter(Boolean));

  if (mode === 'replies') {
    const threadIds = Array.from(new Set(sentRows.map((row) => String(row.gmail_thread_id || '')).filter(Boolean))).slice(0, limit);
    for (const threadId of threadIds) {
      if (deadlineMs && Date.now() - startedAt > deadlineMs) break;
      const thread = await gmailJson(accessToken, `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=full`);
      const threadMessages = Array.isArray(thread.messages) ? thread.messages : [];
      const candidateIds = threadMessages
        .map((message: AnyRecord) => String(message.id || ''))
        .filter((id: string) => id && !knownOutboundIds.has(id));
      const existingIds = newOnly && candidateIds.length
        ? await existingInboundMessageIds(supabase, workspaceId, candidateIds)
        : new Set<string>();
      for (const gmailMessage of threadMessages) {
        if (deadlineMs && Date.now() - startedAt > deadlineMs) break;
        const id = String(gmailMessage.id || '');
        if (!id || knownOutboundIds.has(id) || processedMessageIds.has(id) || existingIds.has(id)) continue;
        processedMessageIds.add(id);
        stats.scanned += 1;
        await processScopedMessage(supabase, workspaceId, accountId, accountEmail, gmailMessage, mode, stats);
      }
    }
  } else {
    const recipients = Array.from(new Set(sentRows.map((row) => normalizeEmail(row.to_email)).filter(Boolean))).slice(0, 200);
    for (let index = 0; index < recipients.length && stats.scanned < limit; index += 20) {
      if (deadlineMs && Date.now() - startedAt > deadlineMs) break;
      const chunk = recipients.slice(index, index + 20);
      const query = encodeURIComponent(bounceSearchQuery(Math.max(1, Math.min(Number(days || 30), 90)), chunk));
      const list = await gmailJson(accessToken, `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=${Math.min(50, limit - stats.scanned)}&includeSpamTrash=true`);
      const messageRefs: Array<{ id: string }> = Array.isArray(list.messages) ? list.messages : [];
      const ids = messageRefs.map((item) => String(item.id || '')).filter(Boolean);
      const existingIds = newOnly && ids.length ? await existingInboundMessageIds(supabase, workspaceId, ids) : new Set<string>();
      for (const item of messageRefs) {
        if (deadlineMs && Date.now() - startedAt > deadlineMs) break;
        const id = String(item.id || '');
        if (!id || processedMessageIds.has(id) || existingIds.has(id)) continue;
        processedMessageIds.add(id);
        const gmailMessage = await gmailJson(accessToken, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`);
        stats.scanned += 1;
        await processScopedMessage(supabase, workspaceId, accountId, accountEmail, gmailMessage, mode, stats);
        if (stats.scanned >= limit) break;
      }
    }
  }

  await supabase.from('gmail_accounts').update({ last_error: null, updated_at: new Date().toISOString() }).eq('workspace_id', workspaceId).eq('id', accountId);
  return stats;
}
