'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import type { GmailAccount, MessageTemplate, Workspace } from '@/lib/types';

type AnyRow = Record<string, any>;

type Props = {
  workspace: Workspace;
  business: AnyRow;
  accounts: GmailAccount[];
  sentRows: AnyRow[];
  replyRows: AnyRow[];
  noInboxRows: AnyRow[];
  socialLinks: string[];
};

function text(value: unknown) {
  return String(value ?? '').trim();
}

function nice(value: unknown) {
  return text(value) || '-';
}

function formatDate(value: unknown) {
  const raw = text(value);
  if (!raw) return '-';
  try { return new Date(raw).toLocaleString(); } catch { return raw; }
}

function rowTime(row: AnyRow) {
  return text(row.sent_at || row.received_at || row.created_at || row.updated_at);
}

function classifyLabel(row: AnyRow) {
  if (row.kind) return row.kind;
  if (row.is_real_reply || row.reply_bucket === 'real_reply') return 'real_reply';
  if (row.is_auto_reply || row.reply_bucket === 'auto_reply' || row.classification === 'auto_reply') return 'auto_reply';
  if (row.is_limit_notice || row.classification === 'gmail_limit_notice') return 'limit_notice';
  if (row.is_delivery_failure || ['no_inbox', 'message_blocked', 'bounce_notice'].includes(String(row.classification || row.reply_bucket || ''))) return String(row.classification || row.reply_bucket || 'delivery_failure');
  if (row.reason) return String(row.reason);
  return String(row.classification || row.delivery_status || 'message');
}

function subjectFromRows(sentRows: AnyRow[], replyRows: AnyRow[], businessName: string) {
  const latestReply = replyRows.find((row) => text(row.subject));
  const latestSent = sentRows.find((row) => text(row.subject));
  const subject = text(latestReply?.subject || latestSent?.subject || businessName || 'Follow up');
  return subject.toLowerCase().startsWith('re:') ? subject : `Re: ${subject}`;
}

function latestThread(sentRows: AnyRow[], replyRows: AnyRow[]) {
  return text(replyRows.find((row) => text(row.gmail_thread_id))?.gmail_thread_id || sentRows.find((row) => text(row.gmail_thread_id))?.gmail_thread_id || '');
}

function splitSubjects(subject: string, variants?: string[] | null) {
  const all = [subject, ...(variants || [])]
    .flatMap((item) => String(item || '').split('\n'))
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set(all));
}

function domainFromBusiness(business: AnyRow) {
  if (business.domain) return String(business.domain);
  try {
    if (business.website) return new URL(String(business.website).startsWith('http') ? String(business.website) : `https://${business.website}`).hostname.replace(/^www\./, '');
  } catch {}
  return String(business.email || '').split('@')[1] || '';
}

function renderReplyTemplate(templateText: string, business: AnyRow, context: AnyRow) {
  const domain = domainFromBusiness(business);
  const values: Record<string, string> = {
    name: business.name || 'there',
    business: business.name || 'your business',
    company: business.name || 'your company',
    email: business.email || '',
    website: business.website || domain || '',
    domain,
    phone: business.phone || '',
    category: business.category || 'business',
    industry: business.category || 'business',
    location: business.location || 'your area',
    source: business.source || 'Scout',
    last_subject: context.lastSubject || business.name || 'your message',
    last_message: context.lastMessage || '',
    reply_snippet: context.replySnippet || '',
    reply_type: context.replyType || business.reply_state || ''
  };
  return String(templateText || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) => values[String(key).toLowerCase()] ?? '');
}

function formatError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

function fullMessage(row: AnyRow) {
  const raw = row.raw || {};
  const rawGmail = raw.gmail || {};
  return text(row.body)
    || text(row.snippet)
    || text(raw.body)
    || text(raw.text)
    || text(raw.message)
    || text(rawGmail.snippet)
    || 'No full message body was saved for this item.';
}

export default function BusinessConversationPanel({ workspace, business, accounts, sentRows, replyRows, noInboxRows, socialLinks }: Props) {
  const supabase = useMemo(() => createClient(), []);
  const connectedAccounts = accounts.filter((account) => ['connected', 'ready'].includes(String(account.status || '')));
  const lockedReplySenderId = text(sentRows.find((row) => text(row.gmail_account_id))?.gmail_account_id);
  const lockedReplySender = accounts.find((account) => account.id === lockedReplySenderId) || connectedAccounts[0];
  const [replyTemplates, setReplyTemplates] = useState<MessageTemplate[]>([]);
  const [selectedReplyTemplateId, setSelectedReplyTemplateId] = useState('');
  const [accountId, setAccountId] = useState(lockedReplySender?.id || '');
  const [toEmail, setToEmail] = useState(text(business.email));
  const [subject, setSubject] = useState(subjectFromRows(sentRows, replyRows, text(business.name)));
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [openedMessage, setOpenedMessage] = useState<AnyRow | null>(null);

  const timeline = useMemo(() => {
    const sent = sentRows.map((row) => ({ ...row, kind: row.delivery_status === 'manual_reply_sent' ? 'manual_reply_sent' : row.is_follow_up ? 'follow_up_sent' : 'sent', sortTime: rowTime(row) }));
    const replies = replyRows.map((row) => ({ ...row, kind: classifyLabel(row), sortTime: rowTime(row) }));
    const failures = noInboxRows.map((row) => ({ ...row, kind: classifyLabel(row), sortTime: rowTime(row), subject: row.subject, from_email: row.from_email, to_email: row.email || row.to_email }));
    return ([...sent, ...replies, ...failures] as AnyRow[]).sort((a, b) => new Date(rowTime(b)).getTime() - new Date(rowTime(a)).getTime());
  }, [sentRows, replyRows, noInboxRows]);

  const latestInbound = replyRows.find((row) => row.is_real_reply || row.is_auto_reply || row.reply_bucket === 'real_reply' || row.reply_bucket === 'auto_reply');
  const latestRealReply = replyRows.find((row) => row.is_real_reply || row.reply_bucket === 'real_reply');
  const latestAutoReply = replyRows.find((row) => row.is_auto_reply || row.reply_bucket === 'auto_reply');
  const lastSent = sentRows[0];
  const threadId = latestThread(sentRows, replyRows);
  const currentReplyTemplate = replyTemplates.find((template) => template.id === selectedReplyTemplateId);

  useEffect(() => {
    if (lockedReplySender?.id) setAccountId(lockedReplySender.id);
  }, [lockedReplySender?.id]);

  useEffect(() => {
    async function loadReplyTemplates() {
      const { data, error } = await supabase
        .from('templates')
        .select('*')
        .eq('workspace_id', workspace.id)
        .eq('active', true)
        .eq('template_type', 'reply')
        .order('created_at', { ascending: false });
      if (error) {
        setNotice(`Reply template load failed: ${error.message}`);
        return;
      }
      const rows = (data || []) as MessageTemplate[];
      setReplyTemplates(rows);
      if (!selectedReplyTemplateId && rows[0]?.id) setSelectedReplyTemplateId(rows[0].id);
    }
    loadReplyTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id]);

  function applyReplyTemplate(templateId: string) {
    setSelectedReplyTemplateId(templateId);
    const template = replyTemplates.find((row) => row.id === templateId);
    if (!template) return;
    const inbound = latestRealReply || latestAutoReply || latestInbound || {};
    const context = {
      lastSubject: text(inbound.subject || lastSent?.subject || business.name),
      lastMessage: text(lastSent?.body || ''),
      replySnippet: text(inbound.snippet || inbound.body || ''),
      replyType: classifyLabel(inbound)
    };
    const subjects = splitSubjects(template.subject, template.subject_variants);
    setSubject(renderReplyTemplate(subjects[0] || template.subject || subjectFromRows(sentRows, replyRows, text(business.name)), business, context));
    setBody(renderReplyTemplate(template.message, business, context));
  }

  async function sendReply() {
    setBusy(true);
    setNotice('');
    try {
      const response = await fetch('/api/gmail/reply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspace_id: workspace.id,
          business_id: business.id,
          gmail_account_id: accountId,
          template_id: selectedReplyTemplateId || undefined,
          to: toEmail,
          subject,
          body,
          gmail_thread_id: threadId || undefined
        })
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json?.success === false) throw new Error(json?.error || `Reply failed with HTTP ${response.status}`);
      setNotice('Reply sent and saved to this business conversation. Refresh this page to see it in the timeline.');
      setBody('');
    } catch (error) {
      setNotice(formatError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-2">
      <div className="card" style={{ padding: 18 }}>
        <h3>Conversation Timeline</h3>
        <p className="muted">Replies, delivery failures, blocked notices, and your manual replies are shown clearly so the business history is not mixed up.</p>
        <div className="grid grid-3" style={{ marginBottom: 12 }}>
          <div className="notice"><strong>Last sent:</strong><br />{lastSent ? `${formatDate(lastSent.sent_at)} · ${nice(lastSent.subject)}` : 'No sent message yet.'}</div>
          <div className="notice"><strong>Latest inbound:</strong><br />{latestInbound ? `${formatDate(latestInbound.received_at)} · ${classifyLabel(latestInbound)}` : 'No inbound reply yet.'}</div>
          <div className="notice"><strong>Current reply state:</strong><br />{nice(business.reply_state || business.last_reply_classification || business.status)}</div>
        </div>
        <div className="table-wrap"><table><thead><tr><th>Type</th><th>Email</th><th>Subject</th><th>When</th><th>Message</th></tr></thead><tbody>
          {timeline.slice(0, 100).map((row, index) => <tr key={`${row.kind}-${row.id || row.gmail_message_id || index}`}><td><span className={`status ${String(row.kind).replace(/_/g, '-')}`}>{String(row.kind).replace(/_/g, ' ')}</span></td><td>{nice(row.from_email || row.to_email || row.email)}</td><td>{nice(row.subject)}</td><td>{formatDate(rowTime(row))}</td><td><button className="btn secondary mini" type="button" onClick={() => setOpenedMessage(row)}>Read</button></td></tr>)}
          {!timeline.length ? <tr><td colSpan={5} className="muted">No conversation history yet.</td></tr> : null}
        </tbody></table></div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <h3>Reply From This Business</h3>
        <p className="muted">Reply templates appear here only. They cannot be selected for first outreach batches.</p>
        <label className="label">Reply template</label>
        <select className="select" value={selectedReplyTemplateId} onChange={(event) => applyReplyTemplate(event.target.value)}>
          <option value="">Write manually</option>
          {replyTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
        </select>
        {currentReplyTemplate?.purpose ? <div className="notice" style={{ marginTop: 8 }}>{currentReplyTemplate.purpose}</div> : null}
        <label className="label" style={{ marginTop: 12 }}>Sender Gmail</label>
        <div className="notice">
          <strong>{lockedReplySender?.email || 'No original sender found'}</strong><br />
          Scout locks replies to the Gmail account that sent the original message to this business.
        </div>
        <label className="label">To</label>
        <input className="input" value={toEmail} onChange={(event) => setToEmail(event.target.value)} placeholder="prospect@example.com" />
        <label className="label">Subject</label>
        <input className="input" value={subject} onChange={(event) => setSubject(event.target.value)} />
        <label className="label">Message</label>
        <textarea className="textarea" value={body} onChange={(event) => setBody(event.target.value)} placeholder="Write your reply here or choose a reply template..." style={{ minHeight: 170 }} />
        <div className="actions" style={{ marginTop: 12 }}>
          <button className="btn" type="button" disabled={busy || !accountId || !toEmail || !subject || !body} onClick={sendReply}>{busy ? 'Sending...' : 'Send reply'}</button>
        </div>
        {notice ? <div className={notice.toLowerCase().includes('failed') || notice.toLowerCase().includes('error') ? 'error' : 'success'} style={{ marginTop: 12 }}>{notice}</div> : null}
        {!connectedAccounts.length ? <div className="error" style={{ marginTop: 12 }}>No connected Gmail account is available. Connect Gmail in Settings first.</div> : null}

        <hr />
        <h3>Business Context</h3>
        <table><tbody>
          <tr><th>Reply state</th><td>{nice(business.reply_state || business.last_reply_classification)}</td></tr>
          <tr><th>Last inbound</th><td>{formatDate(business.last_inbound_at)}</td></tr>
          <tr><th>Last auto reply</th><td>{formatDate(business.last_auto_reply_at)}</td></tr>
          <tr><th>Last reply</th><td>{formatDate(business.last_real_reply_at)}</td></tr>
          <tr><th>Last manual reply</th><td>{formatDate(business.last_manual_reply_at)}</td></tr>
          <tr><th>Social/profile links</th><td>{socialLinks.length}</td></tr>
        </tbody></table>
        <h3 style={{ marginTop: 16 }}>Social / Profiles</h3>
        <div className="stack">
          {socialLinks.map((url) => <a key={url} href={url} target="_blank" rel="noreferrer">{url}</a>)}
          {!socialLinks.length ? <div className="muted">No social/profile links found in the imported raw data yet.</div> : null}
        </div>
      </div>

      {openedMessage ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setOpenedMessage(null)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="actions" style={{ justifyContent: 'space-between' }}>
              <div>
                <h3 style={{ margin: 0 }}>Exact message</h3>
                <p className="muted" style={{ margin: '6px 0 0' }}>{nice(openedMessage.from_email || openedMessage.to_email || openedMessage.email)} · {formatDate(rowTime(openedMessage))}</p>
              </div>
              <button className="btn secondary mini" type="button" onClick={() => setOpenedMessage(null)}>Close</button>
            </div>
            <div className="notice" style={{ marginTop: 12 }}><strong>Subject:</strong> {nice(openedMessage.subject)}</div>
            <pre className="message-body-view">{fullMessage(openedMessage)}</pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}
