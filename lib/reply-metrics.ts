export type ReplyMetricRow = {
  id?: string | null;
  workspace_id?: string | null;
  business_id?: string | null;
  from_email?: string | null;
  to_email?: string | null;
  subject?: string | null;
  snippet?: string | null;
  body?: string | null;
  classification?: string | null;
  reply_bucket?: string | null;
  is_real_reply?: boolean | null;
  is_auto_reply?: boolean | null;
  is_delivery_failure?: boolean | null;
  is_blocked?: boolean | null;
  is_limit_notice?: boolean | null;
  gmail_message_id?: string | null;
  gmail_thread_id?: string | null;
  received_at?: string | null;
  raw?: unknown;
};

export type ReplyMetrics = {
  realReplies: number;
  autoReplies: number;
  deliveryFailures: number;
  limitNotices: number;
  totalInbound: number;
  recentRowsChecked: number;
};

export const REPLY_METRIC_SELECT = [
  'id',
  'business_id',
  'from_email',
  'to_email',
  'subject',
  'snippet',
  'body',
  'classification',
  'reply_bucket',
  'is_real_reply',
  'is_auto_reply',
  'is_delivery_failure',
  'is_blocked',
  'is_limit_notice',
  'gmail_message_id',
  'gmail_thread_id',
  'received_at',
  'template_id',
  'gmail_account_id'
].join(',');

export function metricText(row: ReplyMetricRow) {
  const rawText = typeof row.raw === 'string'
    ? row.raw
    : row.raw && typeof row.raw === 'object'
      ? (() => { try { return JSON.stringify(row.raw); } catch { return ''; } })()
      : '';
  return `${row.from_email || ''} ${row.to_email || ''} ${row.subject || ''} ${row.snippet || ''} ${row.body || ''} ${row.classification || ''} ${row.reply_bucket || ''} ${rawText}`.toLowerCase();
}

export function isDeliveryOrLimitSignal(row: ReplyMetricRow) {
  const bucket = String(row.reply_bucket || row.classification || '').toLowerCase();
  const text = metricText(row);
  return row.is_delivery_failure === true
    || row.is_blocked === true
    || row.is_limit_notice === true
    || ['no_inbox', 'message_blocked', 'bounce_notice', 'gmail_limit_notice', 'no_inbox_or_bounce'].includes(bucket)
    || text.includes('mailer-daemon')
    || text.includes('delivery status notification')
    || text.includes('undeliverable')
    || text.includes('message not delivered')
    || text.includes('address not found')
    || text.includes('recipient address rejected')
    || text.includes('no such user')
    || text.includes('user unknown')
    || text.includes('mailbox unavailable')
    || text.includes('sending limit')
    || text.includes('daily user sending quota exceeded')
    || text.includes('rate limit')
    || text.includes('quota exceeded');
}

export function hasHumanReplySignal(row: ReplyMetricRow) {
  const text = metricText(row);
  const subject = String(row.subject || '').toLowerCase();
  const reSubject = /^\s*(re|aw|sv|antw|ré|fw|fwd)\s*[:：]/i.test(String(row.subject || ''));
  const humanTerms = [
    'we don\'t need', 'we do not need', 'we dont need', 'not interested', 'not looking to', 'not looking for',
    'we are not looking', 'we\'re not looking', 'we appreciate your insight', 'appreciate your insight',
    'thank you for reaching out and sharing', 'thanks for sharing', 'thank you for sharing', 'we value thoughtful',
    'your email itself is', 'highly unprofessional', 'please send', 'can you send', 'could you send',
    'send more details', 'tell me more', 'book a call', 'schedule a call', 'let us talk', 'let\'s talk',
    'we would be interested', 'sounds interesting', 'we already have', 'we are happy with', 'this is not something',
    'no thank you', 'no thanks', 'remove me', 'unsubscribe me', 'stop emailing', 'wrong person', 'not the right person',
    'forwarded this to', 'i forwarded this', 'who are you', 'what do you offer', 'what is the cost', 'pricing',
    'send me', 'send us', 'call me', 'contact me', 'reach me', 'we might be interested', 'i am interested',
    'not for us', 'not a fit', 'no budget', 'we use another', 'we have someone', 'we have an agency',
    'dear sir or madam, the first thing i noticed', 'unprofessional', 'appreciate the insight regarding',
    'we appreciate the insight regarding', 'we don&#39;t need', 'we don’t need', 'we’re not looking'
  ];
  if (humanTerms.some((term) => text.includes(term))) return true;
  // A Re/AW subject is a weak human signal. It only counts when the body is not clearly an auto/ticket confirmation.
  return reSubject && !subject.includes('automatic') && !subject.includes('automatische antwort') && !subject.includes('request received') && !subject.includes('ticket');
}

export function hasAutoReplySignal(row: ReplyMetricRow) {
  const text = metricText(row);
  const from = String(row.from_email || '').toLowerCase();
  const terms = [
    'automatic reply', 'automatic response', 'automatische antwort', 'auto:', 'auto reply', 'auto-reply', 'autoreply',
    'out of office', 'out-of-office', 'ooo', 'vacation responder', 'away from the office', 'currently out of office',
    'i am currently away', 'limited access to email', 'this is an automated response', 'this is an automated reply',
    'this is an automatic response', 'automated notification', 'system generated', 'this mailbox is not monitored',
    'this inbox is not monitored', 'please do not reply', 'do-not-reply', 'donotreply', 'no-reply', 'noreply',
    'your request has been received', 'we have received your request', 'we received your request', 'received your request',
    'we have received your message', 'we received your message', 'received your message', 'support ticket has been created',
    'ticket has been created', 'ticket created', 'case created', 'request received', 'ticket received', 'case received',
    'thanks for contacting support', 'thank you for contacting us', 'thank you for getting in touch',
    'we will get back to you shortly', 'someone from our team will get back to you', 'we will be in touch',
    'we\'ll be in touch', 'we’ll be in touch', 'we will contact you shortly', 'within 24 hours', 'within 48 hours',
    'response time:', 'ticket number', 'ticket id', 'ticket-id', 'case number', 'case id', 'request #',
    'to add additional comments, reply to this email', 'please type your reply above this line', 'delivered by zendesk',
    'zendesk', 'reamaze', 'freshdesk', 'gorgias', 'confirmation of receipt', 'receipt of your email',
    'thank you for your recent email', 'feedback', 'teilen sie uns ihr feedback mit', 'zufriedenheit',
    'bearbeitung ihrer anfrage', 'bearbeitung deiner anfrage', 'how satisfied', 'rate our support',
    'automatisch erzeugte', 'automatisch verschickte', 'eingangsbestätigung', 'empfangsbestätigung',
    'anfrage eingegangen', 'anfrage ist bei uns eingegangen', 'ihre anfrage ist bei uns eingegangen',
    'deine anfrage ist bei uns eingegangen', 'ihre nachricht ist bei uns eingegangen',
    'deine nachricht ist bei uns eingegangen', 'vielen dank für ihre nachricht', 'vielen dank für deine nachricht',
    'danke für deine nachricht', 'wir haben deine nachricht erhalten', 'wir haben ihre nachricht erhalten',
    'wir haben ihre e-mail erhalten', 'anliegen wurde erstellt', 'wurde erstellt', 'ticketnummer', 'ticket-nummer',
    'wir melden uns', 'melden uns schnellstmöglich', 'schnellstmöglich bearbeiten', 'so schnell wie möglich beantworten',
    'wir kümmern uns schnellstmöglich', 'bearbeitungszeit', 'nous confirmons la réception', 'votre demande a été reçue',
    'merci de nous avoir contactés', 'hemos recibido', 'su solicitud ha sido recibida', 'abbiamo ricevuto',
    // v10.18 time-zone language additions: English/Canadian French/German/French/Spanish + Europe extras.
    'réponse automatique', 'reponse automatique', 'absence du bureau', 'accusé de réception', 'accuse de reception',
    'confirmation de réception', 'confirmation de reception', 'nous avons reçu votre message', 'nous avons reçu votre demande',
    'nous avons bien reçu votre message', 'votre message a été reçu', 'votre message a ete recu', 'demande reçue',
    'demande recue', 'ticket créé', 'ticket cree', 'numéro de ticket', 'numero de ticket', 'numéro de dossier',
    'numero de dossier', 'nous vous répondrons', 'nous vous repondrons', 'nous reviendrons vers vous',
    'dans les plus brefs délais', 'dans les plus brefs delais', 'dès que possible', 'des que possible',
    'merci de votre patience', 'merci de nous avoir contactes', 'merci pour votre message',
    'respuesta automática', 'respuesta automatica', 'fuera de la oficina', 'acuse de recibo',
    'confirmación de recepción', 'confirmacion de recepcion', 'hemos recibido su mensaje', 'hemos recibido tu mensaje',
    'hemos recibido su solicitud', 'hemos recibido tu solicitud', 'tu solicitud ha sido recibida', 'mensaje recibido',
    'solicitud recibida', 'ticket creado', 'caso creado', 'número de ticket', 'numero de ticket', 'número de caso',
    'numero de caso', 'nos pondremos en contacto', 'nos comunicaremos con usted', 'lo antes posible', 'a la brevedad',
    'dentro de 24 horas', 'dentro de 48 horas', 'gracias por contactarnos', 'gracias por su mensaje',
    'no responda a este correo', 'correo generado automáticamente', 'correo generado automaticamente',
    'risposta automatica', 'fuori ufficio', 'conferma di ricezione', 'abbiamo ricevuto il tuo messaggio',
    'abbiamo ricevuto il suo messaggio', 'abbiamo ricevuto la tua richiesta', 'abbiamo ricevuto la sua richiesta',
    'richiesta ricevuta', 'ticket creato', 'numero di ticket', 'servizio clienti', 'ti risponderemo', 'le risponderemo',
    'il prima possibile', 'entro 24 ore', 'entro 48 ore', 'la tua richiesta è stata ricevuta',
    'la sua richiesta è stata ricevuta', 'grazie per averci contattato',
    'automatisch antwoord', 'automatische reactie', 'afwezigheidsbericht', 'wij hebben uw bericht ontvangen',
    'we hebben uw bericht ontvangen', 'wij hebben je bericht ontvangen', 'we hebben je bericht ontvangen',
    'uw aanvraag is ontvangen', 'je aanvraag is ontvangen', 'ticket aangemaakt', 'zaaknummer',
    'wij nemen contact met u op', 'we nemen contact met je op', 'zo snel mogelijk', 'binnen 24 uur', 'binnen 48 uur',
    'bedankt voor uw bericht', 'bedankt voor je bericht'
  ];
  if (from.includes('noreply') || from.includes('no-reply') || from.includes('donotreply') || from.includes('do-not-reply')) return true;
  return terms.some((term) => text.includes(term));
}

export function isUnifiedRealReply(row: ReplyMetricRow) {
  if (isDeliveryOrLimitSignal(row)) return false;
  const bucket = String(row.reply_bucket || row.classification || '').toLowerCase();
  if (bucket === 'real_reply' && !hasAutoReplySignal(row)) return true;
  if (row.is_real_reply === true && row.is_auto_reply !== true && !hasAutoReplySignal(row)) return true;
  return hasHumanReplySignal(row) && !hasAutoReplySignal(row);
}

export function isUnifiedAutoReply(row: ReplyMetricRow) {
  if (isDeliveryOrLimitSignal(row)) return false;
  return row.is_auto_reply === true || ['auto_reply', 'auto_reply_ignored'].includes(String(row.reply_bucket || row.classification || '').toLowerCase()) || hasAutoReplySignal(row);
}

export function replyMetricKey(row: ReplyMetricRow) {
  const thread = String(row.gmail_thread_id || '').trim();
  const message = String(row.gmail_message_id || '').trim();
  const business = String(row.business_id || '').trim();
  const from = String(row.from_email || '').toLowerCase().trim();
  const subject = String(row.subject || '').replace(/^\s*(re|aw|sv|antw|ré|fw|fwd)\s*[:：]\s*/i, '').toLowerCase().trim();
  if (thread) return `thread:${thread}:${from}:${subject}`;
  if (message) return `message:${message}`;
  if (business && subject) return `business:${business}:${subject}`;
  return `fallback:${from}:${subject}:${String(row.snippet || '').slice(0, 120).toLowerCase()}`;
}

export function compactReplyRows<T extends ReplyMetricRow>(rows: T[]) {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const row of rows) {
    const key = replyMetricKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(row);
  }
  return output;
}

export function calculateReplyMetrics(rows: ReplyMetricRow[]): ReplyMetrics {
  const realRows = compactReplyRows(rows.filter(isUnifiedRealReply));
  const autoRows = compactReplyRows(rows.filter(isUnifiedAutoReply));
  const deliveryRows = rows.filter((row) => isDeliveryOrLimitSignal(row) && !row.is_limit_notice);
  const limitRows = rows.filter((row) => row.is_limit_notice === true || String(row.reply_bucket || row.classification || '').toLowerCase() === 'gmail_limit_notice');
  return {
    realReplies: realRows.length,
    autoReplies: autoRows.length,
    deliveryFailures: deliveryRows.length,
    limitNotices: limitRows.length,
    totalInbound: rows.length,
    recentRowsChecked: rows.length
  };
}

export async function fetchUnifiedReplyMetrics(supabase: any, workspaceId: string, options?: { start?: Date; end?: Date; limit?: number }) {
  const limit = Math.max(100, Math.min(Number(options?.limit || 10000), 20000));
  let query = supabase
    .from('reply_history')
    .select(REPLY_METRIC_SELECT)
    .eq('workspace_id', workspaceId)
    .order('received_at', { ascending: false })
    .limit(limit);
  if (options?.start) query = query.gte('received_at', options.start.toISOString());
  if (options?.end) query = query.lt('received_at', options.end.toISOString());
  const { data, error } = await query;
  if (error) throw error;
  return calculateReplyMetrics((data || []) as ReplyMetricRow[]);
}
