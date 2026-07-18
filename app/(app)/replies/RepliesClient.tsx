'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { GmailAccount, MessageTemplate, Workspace } from '@/lib/types';
import { compactReplyRows as compactUnifiedReplyRows, isUnifiedAutoReply, isUnifiedRealReply } from '@/lib/reply-metrics';



type ReplyRow = {
  id: string;
  business_id?: string | null;
  from_email?: string | null;
  to_email?: string | null;
  subject?: string | null;
  snippet?: string | null;
  body?: string | null;
  classification?: string | null;
  is_real_reply?: boolean | null;
  is_auto_reply?: boolean | null;
  is_delivery_failure?: boolean | null;
  is_blocked?: boolean | null;
  is_limit_notice?: boolean | null;
  is_temporary?: boolean | null;
  reply_bucket?: string | null;
  received_at?: string | null;
  template_id?: string | null;
  gmail_account_id?: string | null;
  batch_id?: string | null;
  gmail_message_id?: string | null;
  gmail_thread_id?: string | null;
  raw?: Record<string, unknown> | null;
};

type SentRow = {
  id: string;
  business_id?: string | null;
  to_email?: string | null;
  from_email?: string | null;
  subject?: string | null;
  template_id?: string | null;
  gmail_account_id?: string | null;
  batch_id?: string | null;
  provider_message_id?: string | null;
  gmail_thread_id?: string | null;
  delivery_status?: string | null;
  sent_at?: string | null;
};

type NoInboxRow = {
  id: string;
  business_id?: string | null;
  email?: string | null;
  reason?: string | null;
  created_at?: string | null;
  raw?: Record<string, unknown> | null;
};

type NormalizedMessage = {
  gmailMessageId: string;
  gmailThreadId: string;
  fromEmail: string;
  toEmail: string;
  subject: string;
  snippet: string;
  body: string;
  receivedAt: string;
  raw: Record<string, unknown>;
};

type TrackingCounts = {
  sentTracked: number;
  realReplies: number;
  autoReplies: number;
  noInboxBlocked: number;
};

type SyncStats = {
  scanned: number;
  realReplies: number;
  autoReplies: number;
  noInbox: number;
  blocked: number;
  bounced: number;
  limitNotices: number;
  ignored: number;
  inserted: number;
  errors: string[];
};

function formatError(error: unknown) {
  if (!error) return 'Unknown error.';
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    const item = error as { message?: string; code?: string; details?: string; hint?: string; error?: string; reason?: string };
    return [item.message || item.error, item.reason, item.code ? `Code: ${item.code}` : '', item.details, item.hint].filter(Boolean).join(' | ') || JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function normalizeEmail(value: unknown) {
  const raw = String(value || '').toLowerCase().replace(/<([^>]+)>/g, ' $1 ');
  const match = raw.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return match?.[0] || '';
}

function asText(value: unknown): string {
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(' ');
  if (value && typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value || '').trim();
}

function extractArray(json: any): any[] {
  const candidates = [json?.replies, json?.messages, json?.results, json?.items, json?.data, json?.emails, json?.threads];
  for (const item of candidates) if (Array.isArray(item)) return item;
  if (Array.isArray(json)) return json;
  return [];
}

function normalizeMessage(input: any, account: GmailAccount): NormalizedMessage {
  const raw = (input && typeof input === 'object' ? input : { value: input }) as Record<string, unknown>;
  const headers = (raw.headers || {}) as Record<string, unknown>;
  const from = normalizeEmail(raw.from_email || raw.from || headers.from || raw.sender || raw.replyFrom);
  const to = normalizeEmail(raw.to_email || raw.to || headers.to || raw.recipient || account.email);
  const subject = asText(raw.subject || headers.subject || raw.title || '');
  const snippet = asText(raw.snippet || raw.preview || raw.textSnippet || raw.summary || '');
  const body = asText(raw.body || raw.text || raw.html || raw.message || raw.payload || '');
  const receivedAt = asText(raw.received_at || raw.receivedAt || raw.date || raw.internalDate || raw.created_at) || new Date().toISOString();
  const gmailMessageId = asText(raw.gmail_message_id || raw.gmailMessageId || raw.message_id || raw.messageId || raw.id) || `${from}-${subject}-${receivedAt}`;
  const gmailThreadId = asText(raw.gmail_thread_id || raw.gmailThreadId || raw.thread_id || raw.threadId || raw.thread || '');
  return { gmailMessageId, gmailThreadId, fromEmail: from, toEmail: to, subject, snippet, body, receivedAt, raw };
}

function classify(message: NormalizedMessage) {
  const text = `${message.fromEmail} ${message.subject} ${message.snippet} ${message.body}`.toLowerCase();
  const bounceTerms = [
    'mailer-daemon', 'mail delivery subsystem', 'delivery status notification', 'undeliverable', 'message not delivered',
    'delivery incomplete', 'address not found', 'recipient address rejected', 'no such user', 'user unknown',
    'mailbox unavailable', 'mailbox full', 'over quota', '550 ', '5.1.1', '5.2.2', 'permanent failure', 'delivery failed'
  ];
  const limitTerms = ['sending limit', 'rate limit', 'quota exceeded', 'daily user sending quota exceeded', 'too many messages', 'user-rate limit'];
  const autoTerms = [
    'out of office', 'out-of-office', 'ooo', 'automatic reply', 'automatic response',
    'auto-reply', 'auto reply', 'autoreply', 'auto responder', 'autoresponder', 'vacation responder',
    'away from the office', 'i am currently away', 'i’m currently away', 'i am out of the office',
    'limited access to email', 'currently unavailable', 'this is an automated response',
    'this is an automated reply', 'this is an automated message', 'this is an automatic response',
    'this message was generated automatically', 'system generated message', 'automated notification',
    'this mailbox is not monitored', 'this inbox is not monitored', 'please do not reply',
    'do-not-reply', 'donotreply', 'no-reply', 'noreply', 'your request has been received',
    'we have received your request', 'support ticket has been created', 'ticket has been created',
    'thanks for contacting support', 'thank you for contacting us', 'we will get back to you shortly',
    'someone from our team will get back to you', 'automated acknowledgement', 'automatic acknowledgement',
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
    'nous confirmons la réception', 'nous avons reçu votre demande', 'votre demande a été reçue',
    'merci de nous avoir contactés', 'merci pour votre message',
    'hemos recibido', 'su solicitud ha sido recibida', 'gracias por contactarnos',
    'abbiamo ricevuto', 'la tua richiesta è stata ricevuta', 'grazie per averci contattato'
  ];
  const humanReplyTerms = [
    'we don\'t need', 'we do not need', 'we are not interested', 'not interested', 'not looking to', 'not looking for',
    'we are not looking', 'we\'re not looking', 'we appreciate your', 'appreciate your insight', 'appreciate the insight',
    'thanks for sharing', 'thank you for sharing', 'thank you for reaching out and sharing', 'we value thoughtful',
    'your email itself is', 'highly unprofessional', 'please send', 'can you send', 'could you send', 'send more details',
    'tell me more', 'book a call', 'schedule a call', 'let us talk', 'let\'s talk', 'we would be interested', 'sounds interesting',
    'we already have', 'we are happy with', 'this is not something', 'no thank you', 'no thanks'
  ];
  if (limitTerms.some((term) => text.includes(term))) return { classification: 'gmail_limit_notice', isReal: false, noInbox: false };
  if (bounceTerms.some((term) => text.includes(term))) return { classification: 'no_inbox_or_bounce', isReal: false, noInbox: true };
  // v10.15: do not risk hiding useful replies. Everything inbound that is not a bounce/limit notice counts as a reply.
  return { classification: 'real_reply', isReal: true, noInbox: false };
}

function csvEscape(value: unknown) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}



function looksAutoLikeReply(row: ReplyRow) {
  const text = `${row.from_email || ''} ${row.subject || ''} ${row.snippet || ''} ${asText(row.raw || '')}`.toLowerCase();
  const humanTerms = [
    'we don\'t need', 'we do not need', 'not interested', 'not looking to', 'not looking for', 'we are not looking',
    'we\'re not looking', 'we appreciate your', 'appreciate your insight', 'appreciate the insight', 'thanks for sharing',
    'thank you for sharing', 'thank you for reaching out and sharing', 'your email itself is', 'highly unprofessional',
    'please send', 'can you send', 'could you send', 'send more details', 'tell me more', 'book a call', 'schedule a call',
    'no thank you', 'no thanks'
  ];
  if (humanTerms.some((term) => text.includes(term))) return false;
  const terms = [
    'automatic reply', 'automatic response', 'automatische antwort', 'auto:', 'auto reply', 'auto-reply', 'autoreply',
    'out of office', 'out-of-office', 'ooo', 'vacation responder', 'away from the office', 'currently out of office',
    'we have received your message', 'we received your message', 'we’ve received your message', "we've received your message",
    'we have received your request', 'we received your request', 'we’ve received your request', "we've received your request",
    'your request has been received', 'request received', 'ticket received', 'case has been created', 'ticket has been created',
    'ticket number', 'ticket id', 'case number', 'request #', 'request (', 'support ticket',
    'being reviewed by our support staff', 'delivered by zendesk', 'please type your reply above this line',
    'confirmation of receipt', 'thank you for your recent email', 'thank you for contacting', 'thanks for contacting',
    'we will be in touch', 'we’ll be in touch', "we'll be in touch", 'we will contact you shortly', 'within 24 hours', 'within 48 hours',
    'eingangsbestätigung', 'empfangsbestätigung', 'anfrage eingegangen', 'anfrage ist bei uns eingegangen',
    'ihre anfrage ist bei uns eingegangen', 'deine anfrage ist bei uns eingegangen', 'wir haben deine nachricht erhalten',
    'wir haben ihre nachricht erhalten', 'vielen dank für ihre nachricht', 'vielen dank für deine nachricht', 'danke für deine nachricht',
    'ticketnummer', 'ticket-nummer', 'anliegen wurde erstellt', 'teilen sie uns ihr feedback mit', 'zufriedenheit',
    'bearbeitung ihrer anfrage', 'bearbeitung deiner anfrage', 'bearbeitungszeit', 'wir melden uns', 'schnellstmöglich'
  ];
  return terms.some((term) => text.includes(term));
}

function fullReplyText(row: ReplyRow) {
  const raw = row.raw || {};
  const rawGmail = (raw as any).gmail || {};
  return asText(row.body)
    || asText(row.snippet)
    || asText((raw as any).body)
    || asText((raw as any).text)
    || asText((raw as any).message)
    || asText(rawGmail.snippet)
    || 'No full message body was saved for this reply.';
}

function compactReplyRows(rows: ReplyRow[]) {
  const seen = new Set<string>();
  const output: ReplyRow[] = [];
  for (const row of rows) {
    const thread = String(row.gmail_thread_id || '').trim();
    const from = normalizeEmail(row.from_email);
    const subject = String(row.subject || '').replace(/^\s*(re|fw):\s*/i, '').trim().toLowerCase();
    const snippet = String(row.snippet || '').slice(0, 80).replace(/\s+/g, ' ').trim().toLowerCase();
    const minuteBucket = row.received_at ? Math.floor(new Date(row.received_at).getTime() / 60000 / 10) : 0;
    const key = thread ? `${thread}|${from}|${subject}|${minuteBucket}` : `${from}|${subject}|${snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(row);
  }
  return output;
}

function downloadCsv(name: string, rows: Array<Record<string, unknown>>) {
  if (!rows.length) return;
  const headers = Array.from(rows.reduce((set, row) => {
    Object.keys(row).forEach((key) => set.add(key));
    return set;
  }, new Set<string>()));
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function RepliesClient({ workspace }: { workspace: Workspace }) {
  const supabase = useMemo(() => createClient(), []);
  const [accounts, setAccounts] = useState<GmailAccount[]>([]);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [sentRows, setSentRows] = useState<SentRow[]>([]);
  const [replyRows, setReplyRows] = useState<ReplyRow[]>([]);
  const [noInboxRows, setNoInboxRows] = useState<NoInboxRow[]>([]);
  const [trackingCounts, setTrackingCounts] = useState<TrackingCounts>({ sentTracked: 0, realReplies: 0, autoReplies: 0, noInboxBlocked: 0 });
  const [selectedAccounts, setSelectedAccounts] = useState<Record<string, boolean>>({});
  const [syncLimit, setSyncLimit] = useState(500);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Reply sync is ready. Scout will save every non-bounce inbound message as a reply so you do not miss anything.');
  const [error, setError] = useState('');
  const [lastStats, setLastStats] = useState<SyncStats>({ scanned: 0, realReplies: 0, autoReplies: 0, noInbox: 0, blocked: 0, bounced: 0, limitNotices: 0, ignored: 0, inserted: 0, errors: [] });
  const [openedReply, setOpenedReply] = useState<ReplyRow | null>(null);

  async function loadAll() {
    setError('');
    const [acct, tmpl, sent, replies, noInbox, sentCount, realReplyCount, autoReplyCount, noInboxCount, unifiedMetrics] = await Promise.all([
      supabase.from('gmail_accounts').select('*').eq('workspace_id', workspace.id).order('created_at', { ascending: false }),
      supabase.from('templates').select('*').eq('workspace_id', workspace.id).order('created_at', { ascending: false }),
      supabase.from('sent_messages').select('id,business_id,to_email,from_email,subject,template_id,gmail_account_id,batch_id,provider_message_id,gmail_thread_id,delivery_status,sent_at').eq('workspace_id', workspace.id).eq('status', 'sent').order('sent_at', { ascending: false }).limit(1000),
      supabase.from('reply_history').select('id,business_id,from_email,to_email,subject,snippet,body,classification,is_real_reply,is_auto_reply,is_delivery_failure,is_blocked,is_limit_notice,is_temporary,reply_bucket,received_at,template_id,gmail_account_id,batch_id,gmail_message_id,gmail_thread_id').eq('workspace_id', workspace.id).order('received_at', { ascending: false }).limit(150),
      supabase.from('no_inbox_records').select('*').eq('workspace_id', workspace.id).order('created_at', { ascending: false }).limit(500),
      supabase.from('sent_messages').select('*', { count: 'exact', head: true }).eq('workspace_id', workspace.id).eq('status', 'sent'),
      supabase.from('reply_history').select('*', { count: 'exact', head: true }).eq('workspace_id', workspace.id).eq('is_real_reply', true),
      supabase.from('reply_history').select('*', { count: 'exact', head: true }).eq('workspace_id', workspace.id).or('is_auto_reply.eq.true,reply_bucket.eq.auto_reply,classification.eq.auto_reply'),
      supabase.from('no_inbox_records').select('*', { count: 'exact', head: true }).eq('workspace_id', workspace.id),
      fetch(`/api/replies/metrics?workspaceId=${encodeURIComponent(workspace.id)}`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
    ]);
    const firstError = acct.error || tmpl.error || sent.error || replies.error || noInbox.error || sentCount.error || realReplyCount.error || autoReplyCount.error || noInboxCount.error;
    if (firstError) throw firstError;
    const nextAccounts = (acct.data || []) as GmailAccount[];
    setAccounts(nextAccounts);
    setTemplates((tmpl.data || []) as MessageTemplate[]);
    setSentRows((sent.data || []) as SentRow[]);
    setReplyRows((replies.data || []) as ReplyRow[]);
    setNoInboxRows((noInbox.data || []) as NoInboxRow[]);
    setTrackingCounts({
      sentTracked: sentCount.count || 0,
      realReplies: Number(unifiedMetrics?.realReplies ?? realReplyCount.count ?? 0),
      autoReplies: Number(unifiedMetrics?.autoReplies ?? autoReplyCount.count ?? 0),
      noInboxBlocked: noInboxCount.count || 0
    });
    setSelectedAccounts((current) => {
      const next: Record<string, boolean> = {};
      for (const account of nextAccounts) next[account.id] = current[account.id] ?? account.status === 'connected';
      return next;
    });
  }

  useEffect(() => {
    loadAll().catch((err) => setError(formatError(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id]);

  function matchSent(message: NormalizedMessage): SentRow | undefined {
    if (message.gmailThreadId) {
      const byThread = sentRows.find((row) => row.gmail_thread_id && row.gmail_thread_id === message.gmailThreadId);
      if (byThread) return byThread;
    }
    const from = normalizeEmail(message.fromEmail);
    return sentRows.find((row) => normalizeEmail(row.to_email) === from) || sentRows.find((row) => normalizeEmail(row.to_email) && message.body.toLowerCase().includes(String(row.to_email).toLowerCase()));
  }


  async function saveMessage(account: GmailAccount, message: NormalizedMessage, sentMatch?: SentRow) {
    const c = classify(message);
    const replyPayload = {
      workspace_id: workspace.id,
      business_id: sentMatch?.business_id || null,
      sent_message_id: sentMatch?.id || null,
      template_id: sentMatch?.template_id || null,
      gmail_account_id: sentMatch?.gmail_account_id || account.id,
      batch_id: sentMatch?.batch_id || null,
      from_email: message.fromEmail,
      to_email: message.toEmail || account.email,
      subject: message.subject,
      snippet: message.snippet || message.body.slice(0, 240),
      body: message.body,
      classification: c.classification,
      is_real_reply: c.isReal,
      received_at: message.receivedAt,
      gmail_message_id: message.gmailMessageId,
      gmail_thread_id: message.gmailThreadId || sentMatch?.gmail_thread_id || null,
      raw: message.raw
    };

    const { error: replyError } = await supabase
      .from('reply_history')
      .upsert(replyPayload, { onConflict: 'workspace_id,gmail_message_id' });
    if (replyError) throw replyError;

    if (sentMatch?.id) {
      await supabase.from('sent_messages').update({ delivery_status: c.noInbox ? 'no_inbox' : c.isReal ? 'replied' : c.classification }).eq('workspace_id', workspace.id).eq('id', sentMatch.id);
    }

    if (c.isReal && sentMatch?.business_id) {
      await supabase.from('businesses').update({ status: 'responded' }).eq('workspace_id', workspace.id).eq('id', sentMatch.business_id);
    }

    if (c.noInbox) {
      await supabase.from('no_inbox_records').insert({
        workspace_id: workspace.id,
        business_id: sentMatch?.business_id || null,
        email: message.fromEmail || sentMatch?.to_email || null,
        reason: c.classification,
        raw: message.raw
      });
      if (sentMatch?.business_id) await supabase.from('businesses').update({ status: 'no_inbox' }).eq('workspace_id', workspace.id).eq('id', sentMatch.business_id);
    }

    return c;
  }

  async function syncReplies() {
    const selected = accounts.filter((account) => selectedAccounts[account.id] && ['connected', 'ready'].includes(String(account.status || '')));
    if (!selected.length) {
      setError('Select at least one connected Gmail account first.');
      return;
    }
    setBusy(true);
    setError('');
    const stats: SyncStats = { scanned: 0, realReplies: 0, autoReplies: 0, noInbox: 0, blocked: 0, bounced: 0, limitNotices: 0, ignored: 0, inserted: 0, errors: [] };
    try {
      setStatus(`Syncing replies, bounces, no-inbox, and blocked notices from ${selected.length} Gmail account(s)...`);
      for (const account of selected) {
        try {
          setStatus(`Native Gmail sync: checking ${account.email}...`);
          const response = await fetch('/api/gmail/sync-replies', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspace_id: workspace.id, gmail_account_id: account.id, max_results: Math.max(1, Math.min(500, syncLimit)), days: 30 })
          });
          const json = await response.json().catch(() => ({}));
          if (!response.ok || json?.success === false) throw new Error(json?.error || `Native Gmail sync failed with HTTP ${response.status}`);
          stats.scanned += Number(json.scanned || 0);
          stats.realReplies += Number(json.realReplies || 0);
          stats.autoReplies += Number(json.autoReplies || 0);
          stats.noInbox += Number(json.noInbox || 0);
          stats.blocked += Number(json.blocked || 0);
          stats.bounced += Number(json.bounced || 0);
          stats.limitNotices += Number(json.limitNotices || 0);
          stats.ignored += Number(json.ignored || 0) + Number(json.temporary || 0) + Number(json.unmatched || 0);
          stats.inserted += Number(json.saved || 0);
        } catch (err) {
          stats.errors.push(`${account.email}: ${formatError(err)}`);
        }
      }
      setLastStats(stats);
      setStatus(`Reply sync finished. Scanned ${stats.scanned}, saved ${stats.inserted}, real replies ${stats.realReplies}, auto messages ${stats.autoReplies}, no-inbox ${stats.noInbox}, blocked ${stats.blocked}, bounces ${stats.bounced}, Gmail limit notices ${stats.limitNotices}.`);
      if (stats.errors.length) setError(stats.errors.join('\n'));
      await loadAll();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  function templatePerformance() {
    return templates.map((template) => {
      const sent = sentRows.filter((row) => row.template_id === template.id).length;
      const realReplies = replyRows.filter((row) => row.template_id === template.id && row.is_real_reply === true).length;
      const auto = replyRows.filter((row) => row.template_id === template.id && (row.is_auto_reply === true || row.reply_bucket === 'auto_reply')).length;
      const failures = replyRows.filter((row) => row.template_id === template.id && (row.is_delivery_failure === true || row.is_limit_notice === true)).length;
      return { template, sent, realReplies, auto, failures, perReply: realReplies ? (sent / realReplies).toFixed(1) : '-' };
    });
  }

  function senderPerformance() {
    return accounts.map((account) => {
      const sent = sentRows.filter((row) => row.gmail_account_id === account.id).length;
      const realReplies = replyRows.filter((row) => row.gmail_account_id === account.id && row.is_real_reply === true).length;
      const auto = replyRows.filter((row) => row.gmail_account_id === account.id && (row.is_auto_reply === true || row.reply_bucket === 'auto_reply')).length;
      const noInbox = noInboxRows.filter((row) => normalizeEmail(row.email) && sentRows.some((sent) => sent.gmail_account_id === account.id && normalizeEmail(sent.to_email) === normalizeEmail(row.email))).length;
      return { account, sent, realReplies, auto, noInbox, perReply: realReplies ? (sent / realReplies).toFixed(1) : '-' };
    });
  }

  const realReplies = compactUnifiedReplyRows(replyRows.filter(isUnifiedRealReply));
  const autoReplies = compactUnifiedReplyRows(replyRows.filter(isUnifiedAutoReply));
  const deliverySignals = replyRows.filter((row) => row.is_delivery_failure === true || ['no_inbox', 'message_blocked', 'bounce_notice'].includes(String(row.classification || row.reply_bucket || '')));
  const limitSignals = replyRows.filter((row) => row.is_limit_notice === true || row.classification === 'gmail_limit_notice');
  const ignoredReplies = replyRows.filter((row) => row.is_real_reply !== true && row.is_auto_reply !== true && row.is_delivery_failure !== true && row.is_limit_notice !== true && !['real_reply','auto_reply','no_inbox','message_blocked','bounce_notice','gmail_limit_notice'].includes(String(row.classification || row.reply_bucket || '')));
  const sentCount = trackingCounts.sentTracked || sentRows.length;

  return (
    <div className="stack">
      <div className="grid grid-3">
        <div className="card kpi"><div className="title">Sent Tracked</div><div className="num">{sentCount.toLocaleString()}</div><p className="muted">Messages Scout knows were accepted by Gmail.</p></div>
        <div className="card kpi"><div className="title">Real Replies</div><div className="num">{trackingCounts.realReplies.toLocaleString()}</div><p className="muted">Human-looking replies only. Auto tickets and receipt messages are not counted here.</p></div>
        <div className="card kpi"><div className="title">Inbox Problems</div><div className="num">{trackingCounts.noInboxBlocked.toLocaleString()}</div><p className="muted">Bounced, address-not-found, and blocked notices.</p></div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <div className="actions" style={{ justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ margin: 0 }}>Reply Sync</h3>
            <p className="muted" style={{ marginBottom: 0 }}>Click sync to check Gmail. Scout saves every non-bounce inbound message as a reply, so useful messages are not hidden by strict classification.</p>
          </div>
          <button className="btn secondary" onClick={() => loadAll().catch((err) => setError(formatError(err)))} disabled={busy}>Refresh</button>
        </div>
        <div className="grid grid-2" style={{ marginTop: 12 }}>
          <div>
            <label className="label">Gmail accounts to check</label>
            <div className="stack">
              {accounts.map((account) => (
                <label className="checkbox-row" key={account.id}>
                  <input type="checkbox" checked={!!selectedAccounts[account.id]} onChange={(event) => setSelectedAccounts((current) => ({ ...current, [account.id]: event.target.checked }))} />
                  {account.email} · {account.status}
                </label>
              ))}
              {!accounts.length ? <div className="muted">No Gmail accounts saved yet. Add senders from Message first.</div> : null}
            </div>
          </div>
          <div>
            <label className="label">Max Gmail messages to scan per account now</label>
            <input className="input" type="number" min={1} max={500} value={syncLimit} onChange={(event) => setSyncLimit(Number(event.target.value || 100))} />
            <div className="actions" style={{ marginTop: 12 }}>
              <button className="btn" disabled={busy} onClick={syncReplies}>{busy ? 'Syncing...' : 'Sync replies + bounces'}</button>
              {replyRows.length ? <button className="btn secondary" type="button" onClick={() => downloadCsv('scout-replies.csv', realReplies as unknown as Array<Record<string, unknown>>)}>Export replies</button> : null}
              {noInboxRows.length ? <button className="btn secondary" type="button" onClick={() => downloadCsv('scout-no-inbox.csv', noInboxRows as unknown as Array<Record<string, unknown>>)}>Export no inbox</button> : null}
            </div>
          </div>
        </div>
        <div className={error ? 'error' : 'notice'} style={{ whiteSpace: 'pre-wrap' }}>{error || status}</div>
      </div>

      <div className="grid grid-4">
        <div className="card kpi"><div className="title">Last Sync Scanned</div><div className="num">{lastStats.scanned.toLocaleString()}</div></div>
        <div className="card kpi"><div className="title">Last Sync Real Replies</div><div className="num">{lastStats.realReplies.toLocaleString()}</div></div>
        <div className="card kpi"><div className="title">Last Sync Auto Messages</div><div className="num">{lastStats.autoReplies.toLocaleString()}</div></div>
        <div className="card kpi"><div className="title">Failures / Limits</div><div className="num">{(lastStats.noInbox + lastStats.blocked + lastStats.bounced + lastStats.limitNotices).toLocaleString()}</div></div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <h3>Template Reply Tracking</h3>
        <div className="table-wrap"><table><thead><tr><th>Template</th><th>Sent</th><th>Real Replies</th><th>Auto Messages</th><th>Failures</th><th>Emails Per Reply</th></tr></thead><tbody>
          {templatePerformance().map((row) => <tr key={row.template.id}><td>{row.template.name}</td><td>{row.sent}</td><td>{row.realReplies}</td><td>{row.auto}</td><td>{row.failures}</td><td>{row.perReply}</td></tr>)}
          {!templates.length ? <tr><td colSpan={6} className="muted">No templates yet.</td></tr> : null}
        </tbody></table></div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <h3>Sender Reply Tracking</h3>
        <div className="table-wrap"><table><thead><tr><th>Sender</th><th>Status</th><th>Sent</th><th>Real Replies</th><th>Auto Messages</th><th>No Inbox</th><th>Emails Per Reply</th></tr></thead><tbody>
          {senderPerformance().map((row) => <tr key={row.account.id}><td>{row.account.email}</td><td>{row.account.status}</td><td>{row.sent}</td><td>{row.realReplies}</td><td>{row.auto}</td><td>{row.noInbox}</td><td>{row.perReply}</td></tr>)}
          {!accounts.length ? <tr><td colSpan={7} className="muted">No senders yet.</td></tr> : null}
        </tbody></table></div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <h3>Real Replies</h3>
        <p className="muted">Showing {realReplies.length.toLocaleString()} recent human-looking replies on this page. Official total: {trackingCounts.realReplies.toLocaleString()}.</p>
        <p className="muted">Click Read to see the exact message the prospect sent. Click Open to reply from the business page.</p>
        <div className="table-wrap"><table><thead><tr><th>Business</th><th>From</th><th>Subject</th><th>Snippet</th><th>Template</th><th>Received</th><th>Message</th></tr></thead><tbody>
          {realReplies.slice(0, 100).map((r) => <tr key={r.id}><td>{r.business_id ? <Link href={`/businesses/${r.business_id}`}>Open</Link> : '-'}</td><td>{r.from_email || '-'}</td><td>{r.subject || '-'}</td><td>{r.snippet || '-'}</td><td>{templates.find((t) => t.id === r.template_id)?.name || '-'}</td><td>{r.received_at ? new Date(r.received_at).toLocaleString() : '-'}</td><td><button className="btn secondary mini" type="button" onClick={() => setOpenedReply(r)}>Read</button></td></tr>)}
          {!realReplies.length ? <tr><td colSpan={7} className="muted">No replies yet.</td></tr> : null}
        </tbody></table></div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <h3>Auto Messages</h3>
        <p className="muted">These messages look automated, like ticket receipts, feedback requests, or out-of-office replies. They do not count as Real Replies.</p>
        <div className="table-wrap"><table><thead><tr><th>Business</th><th>From</th><th>Subject</th><th>Snippet</th><th>Received</th></tr></thead><tbody>
          {autoReplies.slice(0, 100).map((r) => <tr key={r.id}><td>{r.business_id ? <Link href={`/businesses/${r.business_id}`}>Open</Link> : '-'}</td><td>{r.from_email || '-'}</td><td>{r.subject || '-'}</td><td>{r.snippet || '-'}</td><td>{r.received_at ? new Date(r.received_at).toLocaleString() : '-'}</td></tr>)}
          {!autoReplies.length ? <tr><td colSpan={5} className="muted">No auto-like messages yet.</td></tr> : null}
        </tbody></table></div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <h3>Delivery / Limit Signals</h3>
        <p className="muted">No-inbox, bounces, message-blocked, and limit notices are not counted as replies.</p>
        <div className="table-wrap"><table><thead><tr><th>Business</th><th>From</th><th>Subject</th><th>Classification</th><th>Received</th></tr></thead><tbody>
          {[...deliverySignals, ...limitSignals].slice(0, 100).map((r) => <tr key={r.id}><td>{r.business_id ? <Link href={`/businesses/${r.business_id}`}>Open</Link> : '-'}</td><td>{r.from_email || '-'}</td><td>{r.subject || '-'}</td><td>{r.classification || r.reply_bucket || '-'}</td><td>{r.received_at ? new Date(r.received_at).toLocaleString() : '-'}</td></tr>)}
          {![...deliverySignals, ...limitSignals].length ? <tr><td colSpan={5} className="muted">No delivery or limit signals yet.</td></tr> : null}
        </tbody></table></div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <h3>Other Ignored / Unmatched Signals</h3>
        <div className="table-wrap"><table><thead><tr><th>From</th><th>Subject</th><th>Classification</th><th>Counts as Response?</th><th>Received</th></tr></thead><tbody>
          {ignoredReplies.slice(0, 100).map((r) => <tr key={r.id}><td>{r.from_email || '-'}</td><td>{r.subject || '-'}</td><td>{r.classification || r.reply_bucket || '-'}</td><td>No</td><td>{r.received_at ? new Date(r.received_at).toLocaleString() : '-'}</td></tr>)}
          {!ignoredReplies.length ? <tr><td colSpan={5} className="muted">No ignored/bounce records yet.</td></tr> : null}
        </tbody></table></div>
      </div>

      {openedReply ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setOpenedReply(null)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="actions" style={{ justifyContent: 'space-between' }}>
              <div>
                <h3 style={{ margin: 0 }}>Exact prospect message</h3>
                <p className="muted" style={{ margin: '6px 0 0' }}>{openedReply.from_email || '-'} · {openedReply.received_at ? new Date(openedReply.received_at).toLocaleString() : '-'}</p>
              </div>
              <button className="btn secondary mini" type="button" onClick={() => setOpenedReply(null)}>Close</button>
            </div>
            <div className="notice" style={{ marginTop: 12 }}><strong>Subject:</strong> {openedReply.subject || '-'}</div>
            <pre className="message-body-view">{fullReplyText(openedReply)}</pre>
            {openedReply.business_id ? <Link className="btn" href={`/businesses/${openedReply.business_id}`}>Open business and reply</Link> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
