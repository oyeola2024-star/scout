'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { GmailAccount, MessageCategory, SeedInboxTest, Workspace } from '@/lib/types';

function formatError(error: unknown) {
  if (!error) return 'Unknown error.';
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    const value = error as { message?: string; code?: string; details?: string; hint?: string; error?: string; reason?: string };
    return [value.message || value.error, value.reason, value.code ? `Code: ${value.code}` : '', value.details, value.hint].filter(Boolean).join(' | ') || JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function normalizeEmail(email: unknown) {
  return String(email || '').trim().toLowerCase();
}

function hasActiveSafetyOverride(account: GmailAccount) {
  return Boolean(account.safety_override_active);
}

function hasActiveHardRestriction(account: GmailAccount) {
  if (!account.hard_restriction_active) return false;
  if (!account.hard_restricted_until) return true;
  return new Date(account.hard_restricted_until).getTime() > Date.now();
}

function isPaused(account: GmailAccount) {
  if (hasActiveHardRestriction(account)) return true;
  if (hasActiveSafetyOverride(account)) return false;
  if (account.is_paused === true) return true;
  if (["paused", "limit_hit", "blocked"].includes(String(account.status || "").toLowerCase())) return true;
  if (!account.paused_until) return false;
  return new Date(account.paused_until).getTime() > Date.now();
}

function humanStage(value: unknown) {
  return String(value || 'assessment').replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function readableDate(value: unknown) {
  if (!value) return '';
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

function isAutomaticSafetyPause(account: GmailAccount) {
  return Boolean(account.pause_kind && String(account.pause_kind) !== 'manual');
}

function senderSystemDailyMax(account: GmailAccount) {
  const deployment = Math.max(1, Number(account.deployment_cap || 250));
  const health = Math.max(0, Number(account.health_cap ?? deployment));
  return Math.max(0, Math.floor(Math.min(deployment, health)));
}

function senderSystemRunMax(account: GmailAccount) {
  const systemDaily = senderSystemDailyMax(account);
  const deploymentRun = Math.max(1, Number(account.deployment_run_cap || Math.min(Number(account.deployment_cap || 250), 50)));
  return Math.max(0, Math.floor(Math.min(systemDaily, deploymentRun)));
}

type IdentityDraft = {
  signature_enabled: boolean;
  signature_text: string;
  signature_html: string;
  signature_logo_url: string;
};

type HealthRow = {
  name: string;
  status: "Good" | "Warning" | "Fix needed";
  detail: string;
};

function shortenSignature(account: GmailAccount) {
  const text = String(account.signature_text || account.signature_html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return 'No signature';
  return text.length > 64 ? `${text.slice(0, 64)}…` : text;
}


export default function SettingsClient({ workspace }: { workspace: Workspace }) {
  const supabase = useMemo(() => createClient(), []);
  const identityLoadedRef = useRef(false);
  const [appUrl, setAppUrl] = useState(workspace.app_url || '');
  const [categories, setCategories] = useState<MessageCategory[]>([]);
  const [defaultAudienceCategoryId, setDefaultAudienceCategoryId] = useState(workspace.default_audience_category_id || '');
  const [defaultAudienceCategoryName, setDefaultAudienceCategoryName] = useState(workspace.default_audience_category_name || '');
  const [accounts, setAccounts] = useState<GmailAccount[]>([]);
  const [sentTotalByEmail, setSentTotalByEmail] = useState<Record<string, number>>({});
  const [seedTests, setSeedTests] = useState<SeedInboxTest[]>([]);
  const [limitDrafts, setLimitDrafts] = useState<Record<string, { daily_limit: string; default_run_limit: string; account_type: string; seed_inbox_enabled: boolean; seed_test_address: string }>>({});
  const [identityDraft, setIdentityDraft] = useState<IdentityDraft>({ signature_enabled: true, signature_text: workspace.email_signature_text || '', signature_html: workspace.email_signature_html || '', signature_logo_url: workspace.email_logo_url || '' });
  const [logoUploadBusy, setLogoUploadBusy] = useState(false);
  const [logoMessage, setLogoMessage] = useState('');
  const [manualEmail, setManualEmail] = useState('');
  const [manualAccessToken, setManualAccessToken] = useState('');
  const [manualRefreshToken, setManualRefreshToken] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [status, setStatus] = useState('Connect Gmail here. Message uses only connected senders from this page.');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [oauthReady, setOauthReady] = useState<boolean | null>(null);
  const [healthRows, setHealthRows] = useState<HealthRow[]>([]);
  const [healthBusy, setHealthBusy] = useState(false);

  async function loadAccounts() {
    const { data, error: loadError } = await supabase
      .from('gmail_accounts')
      .select('*')
      .eq('workspace_id', workspace.id)
      .order('created_at', { ascending: false });
    if (loadError) throw loadError;
    const rows = (data || []) as GmailAccount[];
    setAccounts(rows);

    try {
      const counts: Record<string, number> = {};
      for (const account of rows) {
        const email = normalizeEmail(account.email);
        if (!email) continue;
        const { count, error: countError } = await supabase
          .from('sent_messages')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspace.id)
          .eq('status', 'sent')
          .eq('from_email', email);
        if (!countError) counts[email] = count || 0;
      }
      setSentTotalByEmail(counts);
    } catch {
      setSentTotalByEmail({});
    }
    if (!identityLoadedRef.current && rows.length) {
      const source = rows.find((account) => account.signature_text || account.signature_html || (account.raw as any)?.email_identity?.signature_logo_url) || rows[0];
      const rawIdentity = ((source.raw as any)?.email_identity || {}) as Record<string, any>;
      setIdentityDraft({
        signature_enabled: source.signature_enabled !== false,
        signature_text: String(source.signature_text || rawIdentity.signature_text || ''),
        signature_html: String(source.signature_html || rawIdentity.signature_html || ''),
        signature_logo_url: String((source as any).signature_logo_url || rawIdentity.signature_logo_url || rawIdentity.logo_url || workspace.email_logo_url || '')
      });
      identityLoadedRef.current = true;
    }
    setLimitDrafts((current) => {
      const next: Record<string, { daily_limit: string; default_run_limit: string; account_type: string; seed_inbox_enabled: boolean; seed_test_address: string }> = {};
      for (const account of rows) {
        const existing = current[account.id];
        next[account.id] = existing || {
          daily_limit: String(Math.min(Number(account.daily_limit || account.deployment_cap || 250), senderSystemDailyMax(account) || Number(account.deployment_cap || 250))),
          default_run_limit: String(Math.min(Number(account.default_run_limit || account.deployment_run_cap || 50), senderSystemRunMax(account) || Number(account.deployment_run_cap || 50))),
          account_type: String(account.account_type || 'gmail'),
          seed_inbox_enabled: Boolean(account.seed_inbox_enabled),
          seed_test_address: String(account.seed_test_address || account.email || '')
        };
      }
      return next;
    });
  }

  async function loadSeedTests() {
    const { data, error: loadError } = await supabase
      .from('seed_inbox_tests')
      .select('*')
      .eq('workspace_id', workspace.id)
      .order('created_at', { ascending: false })
      .limit(20);
    if (loadError) {
      if (String(loadError.message || '').includes('seed_inbox_tests')) return;
      throw loadError;
    }
    setSeedTests((data || []) as SeedInboxTest[]);
  }

  async function checkGmailOauth() {
    try {
      const response = await fetch('/api/gmail/oauth/status');
      const json = await response.json().catch(() => ({}));
      setOauthReady(Boolean(json?.success));
      if (json?.success) {
        setStatus('Gmail OAuth is ready. Connect Gmail should work from this page.');
      } else {
        setStatus('Gmail OAuth is not ready yet. Check the project environment setup, then redeploy.');
      }
    } catch (err) {
      setOauthReady(false);
      setStatus(`OAuth setup check failed: ${formatError(err)}`);
    }
  }

  async function checkScoutServices() {
    try {
      const response = await fetch('/api/health');
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json?.success === false) throw new Error(json?.error || `Scout health check returned HTTP ${response.status}`);
      setStatus('Scout services are ready. Gmail sending and Supabase background jobs use this Vercel deployment.');
    } catch (err) {
      setStatus(`Scout service check failed: ${formatError(err)}`);
    }
  }

  async function saveGmailAccount(input: { email: string; access_token?: string; refresh_token?: string; status?: string; raw?: Record<string, unknown> }) {
    const email = normalizeEmail(input.email);
    if (!email) throw new Error('Gmail email is required.');
    const payload = {
      workspace_id: workspace.id,
      email,
      display_name: email,
      status: input.status || 'connected',
      access_token: input.access_token || null,
      refresh_token: input.refresh_token || null,
      client_id: null,
      expires_at: null,
      raw: input.raw || {}
    };
    const { error: upsertError } = await supabase.from('gmail_accounts').upsert(payload, { onConflict: 'workspace_id,email' });
    if (upsertError) throw upsertError;
  }

  function handleReturnNotice() {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const connected = url.searchParams.get('gmail_connected');
    const oauthError = url.searchParams.get('gmail_error');
    if (connected) {
      setStatus(`Connected Gmail: ${connected}. It should now appear in the sender list below.`);
      url.searchParams.delete('gmail_connected');
      window.history.replaceState({}, document.title, url.pathname + url.search);
      loadAccounts().catch((err) => setError(formatError(err)));
    loadSeedTests().catch(() => undefined);
    }
    if (oauthError) {
      setError(oauthError);
      url.searchParams.delete('gmail_error');
      window.history.replaceState({}, document.title, url.pathname + url.search);
    }
  }

  function connectGmail() {
    setError('');
    window.location.href = `/api/gmail/oauth/start?workspace_id=${encodeURIComponent(workspace.id)}&return=${encodeURIComponent('/settings')}`;
  }

  async function addManualAccount() {
    setBusy(true);
    setError('');
    try {
      await saveGmailAccount({
        email: manualEmail,
        access_token: manualAccessToken || undefined,
        refresh_token: manualRefreshToken || undefined,
        status: manualAccessToken || manualRefreshToken ? 'connected' : 'needs_token',
        raw: { added_manually: true, added_at: new Date().toISOString() }
      });
      setManualEmail('');
      setManualAccessToken('');
      setManualRefreshToken('');
      setStatus('Manual sender saved. OAuth connection is preferred.');
      await loadAccounts();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  async function verifySenderProfile(account: GmailAccount) {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/gmail/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspace.id, gmail_account_id: account.id })
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json?.success === false) throw new Error(json?.error || json?.message || `Profile check failed with HTTP ${response.status}`);
      setStatus(`Gmail connection verified for ${json.email || account.email}.`);
      await loadAccounts();
    } catch (err) {
      const msg = formatError(err);
      setError(msg);
      await supabase.from('gmail_accounts').update({ connection_status: 'error', connection_error: msg, last_error: msg }).eq('workspace_id', workspace.id).eq('id', account.id);
      await loadAccounts();
    } finally {
      setBusy(false);
    }
  }

  function senderSettingsPatch(account: GmailAccount) {
    const draft = limitDrafts[account.id];
    const dailyMaximum = Math.max(1, Number(account.deployment_cap || 250));
    const runMaximum = Math.max(1, Math.min(dailyMaximum, Number(account.deployment_run_cap || dailyMaximum)));
    const dailyLimit = Math.max(1, Math.min(dailyMaximum, Number(draft?.daily_limit || account.daily_limit || dailyMaximum)));
    const defaultRunLimit = Math.max(1, Math.min(runMaximum, dailyLimit, Number(draft?.default_run_limit || account.default_run_limit || runMaximum)));
    return {
      account_type: draft?.account_type || account.account_type || 'gmail',
      daily_limit: dailyLimit,
      default_run_limit: defaultRunLimit,
      seed_inbox_enabled: Boolean(draft?.seed_inbox_enabled),
      seed_test_address: normalizeEmail(draft?.seed_test_address || account.seed_test_address || account.email),
      updated_at: new Date().toISOString()
    };
  }

  async function saveSenderSettings(account: GmailAccount, quiet = false) {
    if (!quiet) {
      setBusy(true);
      setError('');
    }
    try {
      const { error: updateError } = await supabase
        .from('gmail_accounts')
        .update(senderSettingsPatch(account))
        .eq('workspace_id', workspace.id)
        .eq('id', account.id);
      if (updateError) throw updateError;
      if (!quiet) {
        setStatus(`Saved sender settings for ${account.email}.`);
        await loadAccounts();
      }
    } catch (err) {
      if (!quiet) setError(formatError(err));
      throw err;
    } finally {
      if (!quiet) setBusy(false);
    }
  }

  async function saveAllSenderDrafts() {
    const rows = accounts.filter((account) => limitDrafts[account.id]);
    for (const account of rows) await saveSenderSettings(account, true);
  }


  async function uploadSignatureLogo(file: File | null) {
    if (!file) return;
    setLogoUploadBusy(true);
    setLogoMessage('Uploading logo…');
    setError('');
    try {
      const form = new FormData();
      form.append('workspace_id', workspace.id);
      form.append('logo', file);
      const response = await fetch('/api/assets/logo-upload', {
        method: 'POST',
        body: form
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json?.success === false) throw new Error(json?.error || `Logo upload failed with HTTP ${response.status}`);
      const logoUrl = String(json.publicUrl || json.logoUrl || json.public_url || json.url || '').trim();
      if (!logoUrl) throw new Error('Logo uploaded but no public URL was returned.');
      setIdentityDraft((draft) => ({ ...draft, signature_logo_url: logoUrl }));
      setLogoMessage('Logo uploaded and saved as the workspace default. The public URL is now shown below. Click Save signature & logo to apply it to sender accounts.');
      setStatus('Logo uploaded. Public URL is visible in the Logo URL box. Click Save signature & logo to apply it to Scout emails.');
    } catch (err) {
      const message = formatError(err);
      setLogoMessage(`Logo upload failed: ${message}`);
      setError(message);
    } finally {
      setLogoUploadBusy(false);
    }
  }

  async function copyLogoUrl() {
    const url = identityDraft.signature_logo_url.trim();
    if (!url) {
      setLogoMessage('No logo URL to copy yet. Upload a logo first.');
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setLogoMessage('Logo URL copied.');
    } catch {
      setLogoMessage('Could not copy automatically. Select the URL and copy it manually.');
    }
  }

  async function applyEmailIdentity(syncToGmail = false) {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/gmail/signature', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspace_id: workspace.id,
          apply_all: true,
          sync_to_gmail: syncToGmail,
          signature_enabled: identityDraft.signature_enabled,
          signature_text: identityDraft.signature_text,
          signature_html: identityDraft.signature_html,
          signature_logo_url: identityDraft.signature_logo_url
        })
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json?.success === false) throw new Error(json?.error || `Signature save failed with HTTP ${response.status}`);
      const failed = (json?.results || []).filter((row: Record<string, unknown>) => row.sync_status === 'failed');
      setStatus(syncToGmail
        ? failed.length
          ? `Saved signature in Scout for all senders. Gmail sync failed for ${failed.length} sender(s); reconnect after this version if Google asks for the Gmail settings permission.`
          : `Saved in Scout and synced to Gmail for ${Number(json.updated || 0).toLocaleString()} sender(s).`
        : Number(json.updated || 0) > 0 ? `Saved Scout signature and logo for ${Number(json.updated || 0).toLocaleString()} sender(s).` : 'Saved workspace signature and logo. Connect Gmail to apply it to sender accounts.');
      await loadAccounts();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleSeedInbox(account: GmailAccount, enabled: boolean) {
    const draft = limitDrafts[account.id] || {
      daily_limit: String(Math.min(Number(account.daily_limit || account.deployment_cap || 250), senderSystemDailyMax(account) || Number(account.deployment_cap || 250))),
      default_run_limit: String(Math.min(Number(account.default_run_limit || account.deployment_run_cap || 50), senderSystemRunMax(account) || Number(account.deployment_run_cap || 50))),
      account_type: String(account.account_type || 'gmail'),
      seed_inbox_enabled: Boolean(account.seed_inbox_enabled),
      seed_test_address: String(account.seed_test_address || account.email || '')
    };
    setLimitDrafts((cur) => ({ ...cur, [account.id]: { ...draft, seed_inbox_enabled: enabled } }));
    setStatus(enabled ? `Seed receiver enabled for ${account.email}. Click Run inbox-placement test to check placement.` : `Seed receiver disabled for ${account.email}.`);
    try {
      const { error: updateError } = await supabase
        .from('gmail_accounts')
        .update({
          seed_inbox_enabled: enabled,
          seed_test_address: normalizeEmail(draft.seed_test_address || account.email),
          updated_at: new Date().toISOString()
        })
        .eq('workspace_id', workspace.id)
        .eq('id', account.id);
      if (updateError) throw updateError;
      await loadAccounts();
    } catch (err) {
      setError(formatError(err));
    }
  }

  async function runSeedTestNow() {
    setBusy(true);
    setError('');
    try {
      setStatus('Saving sender/seed settings, then running seed inbox test...');
      await saveAllSenderDrafts();
      await loadAccounts();
      const response = await fetch('/api/gmail/seed-test/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspace.id, mode: 'send_and_check' })
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json?.success === false) throw new Error(json?.error || `Seed test failed with HTTP ${response.status}`);
      setStatus(`Seed test complete. Sent ${Number(json.sent || 0)} test(s). Inbox ${Number(json.inbox || 0)}, spam ${Number(json.spam || 0)}, promotions ${Number(json.promotions || 0)}, not found/pending ${Number(json.not_found || 0)}. If a result says not found, run the check again after a minute.`);
      await Promise.all([loadAccounts(), loadSeedTests()]);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  async function pauseOrResume(account: GmailAccount) {
    setBusy(true);
    setError('');
    try {
      const paused = isPaused(account) || account.status === 'paused' || account.status === 'limit_hit';
      let action = paused ? 'resume' : 'pause';
      if (paused && hasActiveHardRestriction(account)) {
        const until = readableDate(account.hard_restricted_until);
        throw new Error(`${account.email} is hard-restricted${until ? ` until ${until}` : ' until the required corrective action is completed'}. ${account.hard_restriction_reason || account.paused_reason || ''}`.trim());
      }
      if (paused && isAutomaticSafetyPause(account)) {
        const reason = String(account.paused_reason || account.health_reason || account.last_error || 'Scout paused this Gmail account for safety.');
        const issueCount = Number(account.pause_issue_count || 1);
        const confirmed = window.confirm(`${account.email} was automatically paused.

Reason: ${reason}

Occurrence: ${issueCount} of 3 during the current 14-day issue window.

Scout will resume it in Recovering stage with a maximum of 50 messages per rolling 24 hours. The warning remains visible. If the same issue happens again, Scout will pause it again. After the third occurrence, the Gmail will be hard-restricted for the safety period shown by Scout.

Resume this Gmail with warning?`);
        if (!confirmed) return;
        action = 'temporary_resume';
      }
      const response = await fetch('/api/gmail/sender-control', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspace.id, gmail_account_id: account.id, action }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json?.success === false) throw new Error(json?.error || `Sender update failed with HTTP ${response.status}`);
      setStatus(json?.resumedWithWarning
        ? `${account.email} resumed at the Recovering limit of ${Number(json.currentCap || 50)} messages/day. Warning: ${json.warning || account.paused_reason || account.health_reason || 'The original safety reason still applies.'}`
        : action === 'pause'
          ? `${account.email} was paused.`
          : `${account.email} was resumed.`);
      await loadAccounts();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeAccount(account: GmailAccount) {
    if (!window.confirm(`Remove ${account.email} from Scout senders?`)) return;
    setBusy(true);
    try {
      const { error: deleteError } = await supabase.from('gmail_accounts').delete().eq('workspace_id', workspace.id).eq('id', account.id);
      if (deleteError) throw deleteError;
      await loadAccounts();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  async function loadCategories() {
    const { data, error: categoryError } = await supabase
      .from('message_categories')
      .select('*')
      .eq('workspace_id', workspace.id)
      .eq('active', true)
      .order('name', { ascending: true });
    if (categoryError) throw categoryError;
    setCategories((data || []) as MessageCategory[]);
  }

  async function loadWorkspaceSettings() {
    try {
      const response = await fetch(`/api/workspace/settings?workspaceId=${encodeURIComponent(workspace.id)}`);
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json?.success === false) throw new Error(json?.error || 'Could not load workspace settings.');
      const row = json.workspace || {};
      setAppUrl(row.app_url || (typeof window !== 'undefined' ? window.location.origin : ''));
      setDefaultAudienceCategoryId(row.default_audience_category_id || '');
      setDefaultAudienceCategoryName(row.default_audience_category_name || '');
    } catch (err) {
      setStatus(`Workspace setup load note: ${formatError(err)}`);
    }
  }

  async function saveWorkspaceSettings() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/workspace/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: workspace.id,
          appUrl: appUrl || (typeof window !== 'undefined' ? window.location.origin : ''),
          defaultAudienceCategoryId,
          defaultAudienceCategoryName
        })
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json?.success === false) throw new Error(json?.error || 'Could not save workspace settings.');
      setStatus('Workspace setup saved. Your team can now use Settings → Connect Gmail and the extension can read the saved Scout app URL.');
      await Promise.all([loadWorkspaceSettings(), loadCategories()]);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  function healthStatus(ok: boolean, warn: boolean = false): "Good" | "Warning" | "Fix needed" {
    if (ok) return "Good";
    return warn ? "Warning" : "Fix needed";
  }

  async function runAppHealthCheck() {
    setHealthBusy(true);
    setError('');
    try {
      const since72 = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
      const [readyCount, emailCount, templateRows, connectedSenderCount, dueScheduleCount, researchQueueCount, signatureCheck] = await Promise.all([
        supabase
          .from('businesses')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspace.id)
          .in('status', ['ready', 'found', 'connected'])
          .not('email', 'is', null)
          .neq('email', ''),
        supabase
          .from('businesses')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspace.id)
          .not('email', 'is', null)
          .neq('email', ''),
        supabase
          .from('templates')
          .select('id,name,template_type,active')
          .eq('workspace_id', workspace.id)
          .eq('active', true)
          .limit(200),
        supabase
          .from('gmail_accounts')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspace.id)
          .in('status', ['connected', 'ready']),
        supabase
          .from('message_schedules')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspace.id)
          .in('status', ['scheduled', 'due', 'running']),
        supabase
          .from('email_research_jobs')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspace.id)
          .in('status', ['queued', 'running']),
        supabase
          .from('workspaces')
          .select('email_signature_text,email_signature_html,email_logo_url,app_url')
          .eq('id', workspace.id)
          .maybeSingle(),
      ]);

      let dueFollowupDetail = 'RPC not checked.';
      let dueFollowupOk = true;
      try {
        const { data: dueData, error: dueError } = await supabase.rpc('get_due_followups', {
          target_workspace: workspace.id,
          limit_rows: 1,
          followup_segment: 'all_unanswered'
        });
        if (dueError) throw dueError;
        dueFollowupDetail = `${Array.isArray(dueData) ? dueData.length : 0} due sample loaded. RPC is available.`;
      } catch (err) {
        dueFollowupOk = false;
        dueFollowupDetail = `Follow-up RPC problem: ${formatError(err)}`;
      }

      const templates = (templateRows.data || []) as Array<{ template_type?: string | null }>;
      const initialTemplates = templates.filter((t) => String(t.template_type || 'initial') === 'initial').length;
      const followupTemplates = templates.filter((t) => String(t.template_type || '') === 'follow_up').length;
      const sig = (signatureCheck.data || {}) as Record<string, any>;
      const rows: HealthRow[] = [
        {
          name: 'Contactable leads',
          status: healthStatus(Number(readyCount.count || 0) > 0, Number(emailCount.count || 0) > 0),
          detail: `${Number(readyCount.count || 0).toLocaleString()} ready/found/connected with email. ${Number(emailCount.count || 0).toLocaleString()} total leads have email.`
        },
        {
          name: 'Gmail senders',
          status: healthStatus(Number(connectedSenderCount.count || 0) > 0),
          detail: `${Number(connectedSenderCount.count || 0).toLocaleString()} connected sender(s).`
        },
        {
          name: 'Templates',
          status: healthStatus(initialTemplates > 0, followupTemplates === 0),
          detail: `${initialTemplates} initial template(s), ${followupTemplates} follow-up template(s).`
        },
        {
          name: 'Open-app schedules',
          status: 'Good',
          detail: `${Number(dueScheduleCount.count || 0).toLocaleString()} active saved schedule(s). Global open-app runner checks due schedules while Scout is open.`
        },
        {
          name: 'Due follow-ups',
          status: dueFollowupOk ? 'Good' : 'Fix needed',
          detail: dueFollowupDetail
        },
        {
          name: 'Auto Scout queue',
          status: 'Good',
          detail: `${Number(researchQueueCount.count || 0).toLocaleString()} queued/running research job(s). Auto Scout runs when you start it from the app.`
        },
        {
          name: 'Signature/logo',
          status: healthStatus(Boolean(sig.email_signature_text || sig.email_signature_html || sig.email_logo_url), true),
          detail: `${sig.email_logo_url ? 'Logo saved.' : 'No logo saved.'} ${sig.email_signature_text || sig.email_signature_html ? 'Signature saved.' : 'No signature text/html saved.'}`
        },
        {
          name: 'Speed mode',
          status: 'Good',
          detail: 'Cron routes are not part of the normal flow. Polling is throttled, sender counts use one grouped read, and lists load in small pages.'
        },
      ];
      setHealthRows(rows);
      setStatus('Health check complete. Fix anything marked Fix needed before a large campaign.');
    } catch (err) {
      setError(formatError(err));
    } finally {
      setHealthBusy(false);
    }
  }


  useEffect(() => {
    if (!appUrl && typeof window !== 'undefined') setAppUrl(window.location.origin);
    loadWorkspaceSettings();
    loadCategories().catch((err) => setError(formatError(err)));
    loadAccounts().catch((err) => setError(formatError(err)));
    loadSeedTests().catch(() => undefined);
    checkGmailOauth();
    checkScoutServices();
    handleReturnNotice();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id]);

  return (
    <div className="stack">
      {error ? <div className="error">{error}</div> : null}
      <div className="success">{status}</div>

      <div className="grid grid-3">
        <div className="card kpi"><div className="title">Connected Senders</div><div className="num">{accounts.filter((a) => a.status === 'connected' && !isPaused(a)).length}</div></div>
        <div className="card kpi"><div className="title">Paused / Limited</div><div className="num">{accounts.filter((a) => a.status !== 'connected' || isPaused(a)).length}</div></div>
        <div className="card kpi"><div className="title">OAuth</div><div className="num">{oauthReady === null ? '…' : oauthReady ? 'Ready' : 'Fix'}</div></div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <h3>App Health Check</h3>
        <p className="muted">Quick check before sending: leads, senders, templates, follow-ups, schedules, Auto Scout, signature, and speed mode.</p>
        <div className="actions" style={{ marginTop: 12 }}>
          <button className="btn" type="button" disabled={healthBusy} onClick={runAppHealthCheck}>{healthBusy ? 'Checking…' : 'Run health check'}</button>
        </div>
        {healthRows.length ? <div className="table-wrap" style={{ marginTop: 12 }}><table><thead><tr><th>Area</th><th>Status</th><th>Detail</th></tr></thead><tbody>
          {healthRows.map((row) => <tr key={row.name}><td>{row.name}</td><td><span className={`status ${row.status === 'Good' ? 'connected' : row.status === 'Warning' ? 'paused' : 'error'}`}>{row.status}</span></td><td>{row.detail}</td></tr>)}
        </tbody></table></div> : <div className="notice" style={{ marginTop: 12 }}>Run this after deployment. It gives a clear reason if sending, follow-ups, logo, or Auto Scout will fail.</div>}
      </div>

      <div className="card" style={{ padding: 18 }}>
        <h3>Gmail Senders</h3>
        <p className="muted">Connect Gmail once here. Message will use these connected senders for selected or rotated sending.</p>
        <div className="actions" style={{ marginTop: 14 }}>
          <button className="btn" type="button" disabled={busy} onClick={connectGmail}>Connect Gmail</button>
          <button className="btn secondary" type="button" disabled={busy} onClick={checkGmailOauth}>Check OAuth setup</button>
          <button className="btn secondary" type="button" disabled={busy} onClick={loadAccounts}>Refresh senders</button>
        </div>


        <div className="table-wrap" style={{ marginTop: 14 }}><table><thead><tr><th>Gmail</th><th>Connection and sending health</th><th>Limits</th><th>Seed receiver</th><th>Total sent</th><th>Actions</th></tr></thead><tbody>
          {accounts.map((account) => {
            const deploymentCap = Math.max(1, Number(account.deployment_cap || 250));
            const deploymentRunCap = Math.max(1, Math.min(deploymentCap, Number(account.deployment_run_cap || deploymentCap)));
            const draft = limitDrafts[account.id] || { daily_limit: String(Math.min(Number(account.daily_limit || deploymentCap), deploymentCap)), default_run_limit: String(Math.min(Number(account.default_run_limit || deploymentRunCap), deploymentRunCap)), account_type: String(account.account_type || 'gmail'), seed_inbox_enabled: Boolean(account.seed_inbox_enabled), seed_test_address: String(account.seed_test_address || account.email || '') };
            const hardRestricted = hasActiveHardRestriction(account);
            const warningResume = hasActiveSafetyOverride(account);
            const paused = isPaused(account);
            const connection = String(account.connection_status || ((account.access_token || account.refresh_token) ? 'not checked' : 'needs reconnect'));
            const sendingState = hardRestricted ? 'Hard restricted' : paused ? 'Paused' : warningResume ? 'Resumed with warning' : 'Active';
            const reason = account.hard_restriction_reason || account.paused_reason || account.health_reason || 'Checkpoint-controlled sender health.';
            const issueCount = Number(account.pause_issue_count || 0);
            return <tr key={account.id}>
              <td><strong>{account.email}</strong><br /><span className="muted">Type: {draft.account_type}</span></td>
              <td>
                <div><strong>Connection:</strong> <span className={`status ${connection === 'verified' ? 'connected' : connection === 'error' ? 'error' : 'paused'}`}>{connection}</span></div>
                {account.connection_verified_at ? <div className="muted">Last checked: {readableDate(account.connection_verified_at)}</div> : <div className="muted">Click Check Gmail connection to verify Google access.</div>}
                {account.connection_error ? <div className="error" style={{ marginTop: 6 }}>{account.connection_error}</div> : null}
                <div style={{ marginTop: 8 }}><strong>Sending state:</strong> <span className={`status ${hardRestricted || paused ? 'paused' : 'connected'}`}>{sendingState}</span></div>
                <div><strong>Health stage:</strong> {humanStage(account.health_stage)}</div>
                <div className="muted" style={{ marginTop: 6 }}><strong>Reason:</strong> {reason}</div>
                {issueCount > 0 ? <div className="muted"><strong>Same-issue occurrences:</strong> {issueCount} of 3{account.pause_issue_window_ends_at ? ` · window ends ${readableDate(account.pause_issue_window_ends_at)}` : ''}</div> : null}
                {hardRestricted ? <div className="warning" style={{ marginTop: 8 }}><strong>Resume unavailable</strong><br />{account.hard_restricted_until ? `Available again after ${readableDate(account.hard_restricted_until)}.` : 'This restriction remains until the required corrective action is completed.'}</div> : null}
                {warningResume ? <div className="warning" style={{ marginTop: 8 }}><strong>Resumed with warning</strong><br />{account.safety_override_warning || reason}<br />If the same issue happens again, Scout will pause this Gmail again.</div> : null}
                <select className="select" style={{ marginTop: 8 }} value={draft.account_type} onChange={(e) => setLimitDrafts((cur) => ({ ...cur, [account.id]: { ...draft, account_type: e.target.value } }))}><option value="gmail">Gmail</option><option value="workspace">Workspace</option><option value="other">Other</option></select>
              </td>
              <td className="sender-limits-cell"><div className="sender-limits-grid"><div><label className="label">Preferred daily maximum</label><input className="input sender-limit-input" type="number" inputMode="numeric" min={1} max={deploymentCap} value={draft.daily_limit} placeholder={String(deploymentCap)} required aria-label={`Preferred daily maximum for ${account.email}`} onBlur={(e) => { if (!e.target.value.trim()) setLimitDrafts((cur) => ({ ...cur, [account.id]: { ...draft, daily_limit: String(deploymentCap) } })); }} onChange={(e) => setLimitDrafts((cur) => ({ ...cur, [account.id]: { ...draft, daily_limit: e.target.value } }))} /><span className="muted sender-limit-hint">Current system allowance: {senderSystemDailyMax(account).toLocaleString()}/24h · deployment ceiling {deploymentCap.toLocaleString()}</span></div><div><label className="label">Preferred maximum per run</label><input className="input sender-limit-input" type="number" inputMode="numeric" min={1} max={deploymentRunCap} value={draft.default_run_limit} placeholder={String(deploymentRunCap)} required aria-label={`Preferred maximum per run for ${account.email}`} onBlur={(e) => { if (!e.target.value.trim()) setLimitDrafts((cur) => ({ ...cur, [account.id]: { ...draft, default_run_limit: String(deploymentRunCap) } })); }} onChange={(e) => setLimitDrafts((cur) => ({ ...cur, [account.id]: { ...draft, default_run_limit: e.target.value } }))} /><span className="muted sender-limit-hint">Current system run allowance: {senderSystemRunMax(account).toLocaleString()} · server enforcement cannot be bypassed</span></div></div></td>
              <td><label className="checkbox-row"><input type="checkbox" checked={draft.seed_inbox_enabled} onChange={(e) => toggleSeedInbox(account, e.target.checked)} /> Use as seed receiver</label><span className="muted" style={{ display: 'block', fontSize: 12 }}>Receives controlled placement tests. It does not send outreach unless selected as a sender.</span><input className="input" value={draft.seed_test_address} onChange={(e) => setLimitDrafts((cur) => ({ ...cur, [account.id]: { ...draft, seed_test_address: e.target.value } }))} placeholder="seed inbox email" /></td>
              <td><strong>{Number(sentTotalByEmail[normalizeEmail(account.email)] ?? account.sent_today ?? 0).toLocaleString()}</strong><br /><span className="muted">total sent</span><br /><span className="muted">Signature: {account.signature_enabled === false ? 'off' : account.signature_text || account.signature_html || account.signature_logo_url ? 'on' : 'empty'}</span></td>
              <td><button className="btn secondary" type="button" disabled={busy} onClick={() => saveSenderSettings(account)}>Save limits & test settings</button> <button className="btn secondary" type="button" disabled={busy || !(account.access_token || account.refresh_token)} onClick={() => verifySenderProfile(account)}>Check Gmail connection</button> <button className="btn secondary" type="button" disabled={busy || hardRestricted} onClick={() => pauseOrResume(account)}>{paused ? (isAutomaticSafetyPause(account) ? 'Resume with warning' : 'Resume Gmail') : 'Pause Gmail'}</button> <button className="btn secondary" type="button" disabled={busy} onClick={() => removeAccount(account)}>Disconnect from Scout</button></td>
            </tr>;
          })}
          {!accounts.length ? <tr><td colSpan={6} className="muted">No Gmail accounts connected. Click Connect Gmail and approve the requested permissions.</td></tr> : null}
        </tbody></table></div>
        <div className="actions" style={{ marginTop: 12 }}><button className="btn secondary" type="button" disabled={busy} onClick={runSeedTestNow}>Run inbox-placement test</button><span className="muted">Connect at least two Gmail accounts so one sender can test another seed receiver.</span></div>
        <div className="table-wrap" style={{ marginTop: 12 }}><table><thead><tr><th>Sender</th><th>Seed receiver</th><th>Placement</th><th>Checked</th></tr></thead><tbody>
          {seedTests.map((row) => <tr key={row.id}><td>{row.sender_email}</td><td>{row.seed_email}</td><td><span className={`status ${row.placement || 'pending'}`}>{row.placement || 'pending'}</span></td><td>{row.checked_at || row.created_at ? new Date(row.checked_at || row.created_at || '').toLocaleString() : '-'}</td></tr>)}
          {!seedTests.length ? <tr><td colSpan={4} className="muted">No seed inbox tests yet. Turn on Use as seed receiver for one account, then click Run seed inbox test now. You need at least 2 connected Gmail accounts for cross-account testing.</td></tr> : null}
        </tbody></table></div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <h3>Email Identity & Signatures</h3>
        <p className="muted">Use one shared signature across all connected sender accounts. Scout automatically appends the signature to initial messages, follow-ups, and manual replies.</p>
        <label className="checkbox-row" style={{ marginTop: 10 }}><input type="checkbox" checked={identityDraft.signature_enabled} onChange={(event) => setIdentityDraft((draft) => ({ ...draft, signature_enabled: event.target.checked }))} /> Add this signature to Scout-sent emails</label>
        <label className="label" style={{ marginTop: 12 }}>Plain signature</label>
        <textarea className="textarea" value={identityDraft.signature_text} onChange={(event) => setIdentityDraft((draft) => ({ ...draft, signature_text: event.target.value }))} placeholder={"Best regards,\nOlalekan\nWebsite: https://example.com"} style={{ minHeight: 110 }} />
        <label className="label" style={{ marginTop: 12 }}>HTML signature, optional</label>
        <textarea className="textarea" value={identityDraft.signature_html} onChange={(event) => setIdentityDraft((draft) => ({ ...draft, signature_html: event.target.value }))} placeholder={'<strong>Olalekan</strong><br />Founder, Elevate Scout<br /><a href="https://example.com">example.com</a>'} style={{ minHeight: 110 }} />
        <label className="label" style={{ marginTop: 12 }}>Logo after signature</label>
        <div className="grid grid-2">
          <div>
            <input
              className="input"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              disabled={logoUploadBusy || busy}
              onChange={(event) => uploadSignatureLogo(event.target.files?.[0] || null)}
            />
            <p className="muted" style={{ marginTop: 6 }}>Upload PNG/JPG/WebP. Recommended 320×120 px, transparent PNG, under 2 MB.</p>
            {logoMessage ? <p className={logoMessage.toLowerCase().includes('failed') ? 'error' : 'success'} style={{ marginTop: 6 }}>{logoMessage}</p> : null}
          </div>
          <div>
            <label className="label">Public logo URL</label>
            <input className="input" value={identityDraft.signature_logo_url} onChange={(event) => setIdentityDraft((draft) => ({ ...draft, signature_logo_url: event.target.value }))} placeholder="Logo URL appears here after upload" />
            <div className="actions" style={{ marginTop: 8 }}>
              <button className="btn secondary" type="button" disabled={!identityDraft.signature_logo_url.trim()} onClick={copyLogoUrl}>Copy URL</button>
              <button className="btn" type="button" disabled={busy} onClick={() => applyEmailIdentity(false)}>Save signature & logo</button>
            </div>
            <p className="muted" style={{ marginTop: 6 }}>{logoUploadBusy ? 'Uploading logo…' : 'After upload, the URL stays here. Save signature & logo applies it to Scout-sent emails.'}</p>
          </div>
        </div>
        {identityDraft.signature_logo_url ? <div style={{ marginTop: 10 }}><img src={identityDraft.signature_logo_url} alt="Signature logo preview" style={{ maxWidth: 160, height: 'auto', borderRadius: 8 }} /></div> : null}
        <div className="notice" style={{ marginTop: 10 }}>
          A bucket is just a storage folder in Supabase. Scout uses the public <code>email-assets</code> bucket to host signature logos so Gmail and recipients can see the image.
        </div>
        <div className="actions" style={{ marginTop: 12 }}>
          <button className="btn" type="button" disabled={busy} onClick={() => applyEmailIdentity(false)}>Save signature & logo</button>
          <button className="btn secondary" type="button" disabled={busy || !accounts.length} onClick={() => applyEmailIdentity(true)}>Save + sync to Gmail</button>
        </div>
        <div className="table-wrap" style={{ marginTop: 12 }}><table><thead><tr><th>Sender</th><th>Signature</th><th>Gmail sync</th></tr></thead><tbody>
          {accounts.map((account) => <tr key={`identity-${account.id}`}><td>{account.email}</td><td>{account.signature_enabled === false ? 'Disabled' : shortenSignature(account)}</td><td>{account.gmail_signature_sync_error ? <span className="error">Failed: {account.gmail_signature_sync_error}</span> : account.gmail_signature_synced_at ? `Synced ${new Date(account.gmail_signature_synced_at).toLocaleString()}` : 'Not synced'}</td></tr>)}
          {!accounts.length ? <tr><td colSpan={3} className="muted">Connect Gmail first, then save the shared signature.</td></tr> : null}
        </tbody></table></div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <h3>App and Extension Setup</h3>
        <p className="muted">This deployment is independent. Any signed-in user can save settings for their own private workspace.</p>
        <div className="grid grid-2">
          <div><label className="label">Scout App URL / Vercel URL</label><input className="input" value={appUrl} onChange={(e) => setAppUrl(e.target.value)} placeholder="https://your-scout-app.vercel.app" /></div>
          <div><label className="label">Background processing</label><input className="input" value="Supabase Cron → this Vercel app" readOnly /></div>
        </div>
        <div className="grid grid-2" style={{ marginTop: 12 }}>
          <div><label className="label">Default audience category</label><select className="select" value={defaultAudienceCategoryId} onChange={(e) => { setDefaultAudienceCategoryId(e.target.value); const cat = categories.find((c) => c.id === e.target.value); if (cat) setDefaultAudienceCategoryName(cat.name); }}><option value="">None / create below</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
          <div><label className="label">New default category name</label><input className="input" value={defaultAudienceCategoryName} onChange={(e) => { setDefaultAudienceCategoryName(e.target.value); if (defaultAudienceCategoryId) setDefaultAudienceCategoryId(''); }} placeholder="Shopify audit, Marketing, Website design" /></div>
        </div>
        <div className="notice" style={{ marginTop: 12 }}>Extension ingest URL: <code>{(appUrl || (typeof window !== 'undefined' ? window.location.origin : '')).replace(/\/$/, '')}/api/extension/ingest</code></div>
        <label className="label" style={{ marginTop: 12 }}>Extension workspace key</label>
        <input className="input" readOnly value={workspace.api_key || 'No API key found. Re-run the fresh database installation SQL.'} />
        <div className="actions" style={{ marginTop: 12 }}>
          <button className="btn" type="button" disabled={busy} onClick={saveWorkspaceSettings}>Save setup</button>
          <button className="btn secondary" type="button" onClick={checkScoutServices}>Check Scout services</button>
        </div>
      </div>

    </div>
  );
}
