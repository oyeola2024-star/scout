"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase-browser";
import { Business, Workspace } from "@/lib/types";

type TemplateRow = {
  id: string;
  workspace_id: string;
  name: string;
  subject: string;
  subject_variants?: string[] | null;
  message: string;
  category_id?: string | null;
  category_name?: string | null;
  active?: boolean | null;
  created_at: string;
};

type MessageCategory = {
  id: string;
  workspace_id: string;
  name: string;
  description?: string | null;
  active?: boolean | null;
  created_at?: string | null;
};

type GmailAccount = {
  id: string;
  workspace_id: string;
  email: string;
  display_name: string | null;
  status: string;
  access_token?: string | null;
  refresh_token?: string | null;
  client_id?: string | null;
  expires_at?: string | null;
  daily_limit?: number | null;
  sent_today?: number | null;
  paused_until?: string | null;
  is_paused?: boolean | null;
  pause_kind?: string | null;
  safety_override_until?: string | null;
  safety_override_warning?: string | null;
  last_error?: string | null;
  raw?: Record<string, unknown> | null;
  created_at: string;
};

type SendLogRow = {
  id: string;
  status?: string | null;
  to_email?: string | null;
  from_email?: string | null;
  subject?: string | null;
  sent_at?: string | null;
};

type ReplyRow = {
  id: string;
  is_real_reply?: boolean | null;
  template_id?: string | null;
  gmail_account_id?: string | null;
};

type DueFollowUp = {
  business_id: string;
  business_name: string | null;
  to_email: string;
  last_sent_at: string;
  last_subject: string | null;
  template_id: string | null;
  gmail_account_id: string | null;
};

type ScheduleRow = {
  id: string;
  type: string;
  status: string;
  category_id?: string | null;
  template_id?: string | null;
  target_count?: number | null;
  scheduled_for: string;
  raw?: Record<string, unknown> | null;
  created_at: string;
};

type SendResult = {
  id?: string;
  email?: string;
  status?: string;
  subject?: string;
  reason?: string;
  code?: string;
  stopBatch?: boolean;
  gmailMessageId?: string;
  gmailThreadId?: string;
  pausedUntil?: string;
  [key: string]: unknown;
};

type SendSummary = {
  requested: number;
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
  stopped: boolean;
};

const READY_PAGE_SIZE = 100;
const MAX_MESSAGE_BATCH_SIZE = 50000;
const DEFAULT_TEMPLATE_MESSAGE = `Hi {name},\n\nI came across {business} and wanted to ask a quick question about {category}.\n\nWould you like me to send a short, practical review of what I noticed for {business}?\n\nBest regards,\nOlalekan`;
const DEFAULT_FOLLOWUP_MESSAGE = `Hi {name},\n\nJust following up on my last message about {business}.\n\nIf improving {category} is relevant, I can send over the short review I mentioned.\n\nBest regards,\nOlalekan`;
const SHORTCODES = [
  "{name}",
  "{business}",
  "{company}",
  "{email}",
  "{website}",
  "{domain}",
  "{phone}",
  "{category}",
  "{industry}",
  "{location}",
  "{source}",
];
const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
].join(" ");

function formatError(error: unknown) {
  if (!error) return "Unknown error.";
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    const item = error as {
      message?: string;
      code?: string;
      details?: string;
      hint?: string;
      error?: string;
      reason?: string;
    };
    return (
      [
        item.message || item.error,
        item.reason,
        item.code ? `Code: ${item.code}` : "",
        item.details,
        item.hint,
      ]
        .filter(Boolean)
        .join(" | ") || JSON.stringify(error)
    );
  } catch {
    return String(error);
  }
}

function isMissingRpcFunction(error: unknown) {
  const text = formatError(error).toLowerCase();
  return (
    text.includes("pgrst202") ||
    text.includes("get_due_followups") ||
    text.includes("schema cache")
  );
}

function normalizeEmail(email: unknown) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function splitSubjects(subject: string, variants?: string[] | null) {
  const all = [subject, ...(variants || [])]
    .flatMap((item) => String(item || "").split("\n"))
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set(all));
}

function getDomain(business: Business) {
  if (business.domain) return business.domain;
  try {
    if (business.website)
      return new URL(
        business.website.startsWith("http")
          ? business.website
          : `https://${business.website}`,
      ).hostname.replace(/^www\./, "");
  } catch {}
  return String(business.email || "").split("@")[1] || "";
}

function renderTemplate(text: string, business: Business) {
  const domain = getDomain(business);
  const values: Record<string, string> = {
    name: business.name || "there",
    business: business.name || "your business",
    company: business.name || "your company",
    email: business.email || "",
    website: business.website || domain || "",
    domain,
    phone: business.phone || "",
    category: business.category || "business",
    industry: business.category || "business",
    location: business.location || "your area",
    source: business.source || "Scout",
  };
  return text.replace(
    /\{([a-zA-Z0-9_]+)\}/g,
    (_match, key) => values[String(key).toLowerCase()] ?? "",
  );
}

function csvEscape(value: unknown) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadCsv(name: string, rows: Array<Record<string, unknown>>) {
  if (!rows.length) return;
  const headers = Array.from(
    rows.reduce((set, row) => {
      Object.keys(row).forEach((key) => set.add(key));
      return set;
    }, new Set<string>()),
  );
  const lines = [headers.join(",")];
  for (const row of rows)
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function isPaused(account: GmailAccount) {
  if (account.safety_override_until && new Date(account.safety_override_until).getTime() > Date.now()) return false;
  const status = String(account.status || '').toLowerCase();
  if (account.is_paused === true || ['limit_hit', 'paused', 'blocked'].includes(status)) return true;
  if (!account.paused_until) return false;
  return new Date(account.paused_until).getTime() > Date.now();
}

function isLimitPayload(json: any, result?: SendResult) {
  const code = String(
    json?.code ||
      json?.reason ||
      json?.stopReason ||
      result?.code ||
      result?.reason ||
      "",
  ).toLowerCase();
  const message = String(
    json?.error || json?.message || result?.reason || "",
  ).toLowerCase();
  return (
    json?.forceStopped ||
    result?.stopBatch ||
    code.includes("limit") ||
    message.includes("limit reached") ||
    message.includes("sending limit")
  );
}

function toDateTomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(0, 5, 0, 0);
  return d.toISOString();
}

function getMessageRedirectUri() {
  if (typeof window === "undefined") return "/message";
  return `${window.location.origin}/message`;
}

function asLocalDateTimeValue(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function inHours(hours: number) {
  const d = new Date();
  d.setHours(d.getHours() + hours);
  return asLocalDateTimeValue(d);
}

export default function EmailScoutClient({
  workspace,
}: {
  workspace: Workspace;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [categories, setCategories] = useState<MessageCategory[]>([]);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [accounts, setAccounts] = useState<GmailAccount[]>([]);
  const [readyContacts, setReadyContacts] = useState<Business[]>([]);
  const [readyTotal, setReadyTotal] = useState(0);
  const [selectedContacts, setSelectedContacts] = useState<
    Record<string, boolean>
  >({});
  const [selectedAccounts, setSelectedAccounts] = useState<
    Record<string, boolean>
  >({});
  const [categoryId, setCategoryId] = useState("");
  const [newCategoryName, setNewCategoryName] = useState(
    "Shopify marketing scouting",
  );
  const [newCategoryDescription, setNewCategoryDescription] = useState(
    "Templates for this scouting angle.",
  );
  const [businessCategoryFilter, setBusinessCategoryFilter] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [templateName, setTemplateName] = useState("First message");
  const [subject, setSubject] = useState("{name}, quick question");
  const [subjectVariants, setSubjectVariants] = useState(
    "{business}, quick idea\nQuick idea for {name}",
  );
  const [message, setMessage] = useState(DEFAULT_TEMPLATE_MESSAGE);
  const [rotateTemplates, setRotateTemplates] = useState(true);
  const [googleClientId, setGoogleClientId] = useState("");
  const [manualEmail, setManualEmail] = useState("");
  const [manualAccessToken, setManualAccessToken] = useState("");
  const [manualRefreshToken, setManualRefreshToken] = useState("");
  const [manualClientId, setManualClientId] = useState("");
  const [showAdvancedTokens, setShowAdvancedTokens] = useState(false);
  const [sendLimit, setSendLimit] = useState(1000);
  const delayMs = 0; // Automatic pacing is enforced by Scout.
  const [dryRun, setDryRun] = useState(false);
  const [readySearch, setReadySearch] = useState("");
  const [scheduleType, setScheduleType] = useState<"initial" | "follow_up">(
    "initial",
  );
  const [scheduleFor, setScheduleFor] = useState(inHours(1));
  const [followUpFor, setFollowUpFor] = useState(inHours(2));
  const [scheduleCount, setScheduleCount] = useState(1000);
  const [dueFollowUps, setDueFollowUps] = useState<DueFollowUp[]>([]);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState(
    "Ready. Pick a library category, template, sender, and batch size.",
  );
  const [error, setError] = useState("");
  const [backendNote, setBackendNote] = useState("");
  const [lastResults, setLastResults] = useState<
    Array<Record<string, unknown>>
  >([]);
  const [recentSent, setRecentSent] = useState<SendLogRow[]>([]);
  const [replies, setReplies] = useState<ReplyRow[]>([]);
  const [summary, setSummary] = useState<SendSummary>({
    requested: 0,
    attempted: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    stopped: false,
  });

  const selectedContactIds = Object.keys(selectedContacts).filter(
    (id) => selectedContacts[id],
  );
  const selectedAccountIds = Object.keys(selectedAccounts).filter(
    (id) => selectedAccounts[id],
  );
  const categoryTemplates = templates.filter(
    (t) => !categoryId || t.category_id === categoryId,
  );
  const currentTemplate =
    templates.find((t) => t.id === templateId) ||
    categoryTemplates[0] ||
    templates[0];
  const previewBusiness =
    readyContacts.find((b) => selectedContacts[b.id]) || readyContacts[0];
  const previewSubject =
    previewBusiness && currentTemplate
      ? renderTemplate(
          splitSubjects(
            currentTemplate.subject,
            currentTemplate.subject_variants,
          )[0] || currentTemplate.subject,
          previewBusiness,
        )
      : "";
  const previewBody =
    previewBusiness && currentTemplate
      ? renderTemplate(currentTemplate.message, previewBusiness)
      : "";

  async function checkScoutServices() {
    try {
      const response = await fetch('/api/health');
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json?.success === false) throw new Error(json?.error || `Scout returned HTTP ${response.status}`);
      setBackendNote('Scout services ready');
    } catch (err) {
      setBackendNote(`Scout service check failed: ${formatError(err)}`);
    }
  }

  async function loadCategories() {
    const { data, error: loadError } = await supabase
      .from("message_categories")
      .select("*")
      .eq("workspace_id", workspace.id)
      .eq("active", true)
      .order("name", { ascending: true });
    if (loadError) throw loadError;
    const rows = (data || []) as MessageCategory[];
    setCategories(rows);
    if (!categoryId && rows[0]?.id) setCategoryId(rows[0].id);
  }

  async function loadTemplates() {
    const { data, error: loadError } = await supabase
      .from("templates")
      .select("*")
      .eq("workspace_id", workspace.id)
      .eq("active", true)
      .order("created_at", { ascending: false });
    if (loadError) throw loadError;
    const rows = (data || []) as TemplateRow[];
    setTemplates(rows);
    if (!templateId && rows[0]?.id) setTemplateId(rows[0].id);
  }

  async function loadAccounts() {
    const { data, error: loadError } = await supabase
      .from("gmail_accounts")
      .select("*")
      .eq("workspace_id", workspace.id)
      .order("created_at", { ascending: false });
    if (loadError) throw loadError;
    const rows = (data || []) as GmailAccount[];
    setAccounts(rows);
    setSelectedAccounts((current) => {
      const next: Record<string, boolean> = {};
      for (const account of rows)
        next[account.id] =
          current[account.id] ??
          (account.status === "connected" && !isPaused(account));
      return next;
    });
  }

  async function loadReadyContacts() {
    const cleanSearch = readySearch.trim().replace(/[%_]/g, "");
    const cleanCategory = businessCategoryFilter.trim().replace(/[%_]/g, "");
    const targetBusinessId =
      typeof window !== "undefined"
        ? new URL(window.location.href).searchParams.get("business")
        : "";
    let query = supabase
      .from("businesses")
      .select("*", { count: "exact" })
      .eq("workspace_id", workspace.id)
      .eq("status", "ready")
      .not("email", "is", null)
      .neq("email", "")
      .order("updated_at", { ascending: true })
      .limit(READY_PAGE_SIZE);
    if (cleanSearch)
      query = query.or(
        `name.ilike.%${cleanSearch}%,email.ilike.%${cleanSearch}%,domain.ilike.%${cleanSearch}%,website.ilike.%${cleanSearch}%`,
      );
    if (cleanCategory) query = query.ilike("category", `%${cleanCategory}%`);
    const { data, error: loadError, count } = await query;
    if (loadError) throw loadError;

    let rows = (data || []) as Business[];
    let selected: Record<string, boolean> = {};
    if (targetBusinessId) {
      const { data: target, error: targetError } = await supabase
        .from("businesses")
        .select("*")
        .eq("workspace_id", workspace.id)
        .eq("id", targetBusinessId)
        .maybeSingle();
      if (targetError) throw targetError;
      if (target?.email) {
        rows = [
          target as Business,
          ...rows.filter((b) => b.id !== target.id),
        ].slice(0, READY_PAGE_SIZE);
        selected = { [target.id]: true };
        setStatus(`Loaded selected business: ${target.name || target.email}.`);
      }
    }

    setReadyContacts(rows);
    setReadyTotal(count || rows.length);
    setSelectedContacts(selected);
  }

  async function loadPerformance() {
    const [{ data: sentRows }, { data: replyRows }] = await Promise.all([
      supabase
        .from("sent_messages")
        .select("id,status,to_email,from_email,subject,sent_at")
        .eq("workspace_id", workspace.id)
        .order("sent_at", { ascending: false })
        .limit(200),
      supabase
        .from("reply_history")
        .select("id,is_real_reply,template_id,gmail_account_id")
        .eq("workspace_id", workspace.id)
        .order("received_at", { ascending: false })
        .limit(500),
    ]);
    setRecentSent((sentRows || []) as SendLogRow[]);
    setReplies((replyRows || []) as ReplyRow[]);
  }

  async function loadDueFollowUps() {
    const { data, error: dueError } = await supabase.rpc("get_due_followups", {
      target_workspace: workspace.id,
      limit_rows: 100,
    });
    if (dueError) {
      if (isMissingRpcFunction(dueError)) {
        setDueFollowUps([]);
        setStatus(
          "Follow-up RPC is missing in Supabase. Run the v8.39 Supabase SQL once.",
        );
        return;
      }
      throw dueError;
    }
    setDueFollowUps((data || []) as DueFollowUp[]);
  }

  async function loadSchedules() {
    const { data, error: scheduleError } = await supabase
      .from("message_schedules")
      .select("*")
      .eq("workspace_id", workspace.id)
      .in("status", ["scheduled", "due", "running"])
      .order("scheduled_for", { ascending: true })
      .limit(50);
    if (scheduleError) throw scheduleError;
    setSchedules((data || []) as ScheduleRow[]);
  }

  async function refreshAll() {
    setLoading(true);
    setError("");
    try {
      await Promise.all([
        loadCategories(),
        loadTemplates(),
        loadAccounts(),
        loadReadyContacts(),
        loadPerformance(),
        loadDueFollowUps(),
        loadSchedules(),
        checkScoutServices(),
      ]);
      setStatus("Loaded Message workspace.");
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const savedClientId =
      localStorage.getItem("scout_v815_google_client_id") ||
      localStorage.getItem("scout_v814_google_client_id") ||
      "";
    setGoogleClientId(savedClientId);
    setManualClientId(savedClientId);
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id]);

  useEffect(() => {
    handleOauthReturn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleClientId]);

  useEffect(() => {
    if (
      categoryTemplates[0] &&
      !categoryTemplates.some((t) => t.id === templateId)
    ) {
      loadTemplateIntoEditor(categoryTemplates[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryId, templates.length]);

  async function handleOauthReturn() {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const connected = url.searchParams.get('gmail_connected');
    const oauthError = url.searchParams.get('gmail_error');
    if (connected) {
      setStatus(`Connected Gmail: ${connected}`);
      url.searchParams.delete('gmail_connected');
      window.history.replaceState({}, document.title, url.pathname + url.search);
      await loadAccounts();
    } else if (oauthError) {
      setError(`Gmail connection failed: ${oauthError}`);
      url.searchParams.delete('gmail_error');
      window.history.replaceState({}, document.title, url.pathname + url.search);
    }
  }

  async function saveGmailAccount(input: {
    email: string;
    access_token?: string;
    refresh_token?: string;
    client_id?: string;
    expires_in?: number;
    status?: string;
    raw?: Record<string, unknown>;
  }) {
    const email = normalizeEmail(input.email);
    if (!email) throw new Error("Gmail email is required.");
    const expiresAt = input.expires_in
      ? new Date(Date.now() + Number(input.expires_in) * 1000).toISOString()
      : null;
    const payload = {
      workspace_id: workspace.id,
      email,
      display_name: email,
      status: input.status || "connected",
      access_token: input.access_token || null,
      refresh_token: input.refresh_token || null,
      client_id: input.client_id || null,
      expires_at: expiresAt,
      raw: input.raw || {},
    };
    const { error: upsertError } = await supabase
      .from("gmail_accounts")
      .upsert(payload, { onConflict: "workspace_id,email" });
    if (upsertError) throw upsertError;
  }

  function startGmailOauth() {
    const params = new URLSearchParams({ workspace_id: workspace.id, return: '/email-scout' });
    window.location.href = `/api/gmail/oauth/start?${params.toString()}`;
  }

  async function addManualAccount() {
    setBusy(true);
    setError("");
    try {
      await saveGmailAccount({
        email: manualEmail,
        access_token: manualAccessToken || undefined,
        refresh_token: manualRefreshToken || undefined,
        client_id: manualClientId || googleClientId || undefined,
        status:
          manualAccessToken || manualRefreshToken ? "connected" : "needs_token",
        raw: { added_manually: true, added_at: new Date().toISOString() },
      });
      setManualEmail("");
      setManualAccessToken("");
      setManualRefreshToken("");
      setStatus("Sender saved.");
      await loadAccounts();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  async function verifySenderProfile(account: GmailAccount) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/gmail/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspace.id,
          gmail_account_id: account.id,
        }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json?.success === false)
        throw new Error(
          json?.error ||
            json?.message ||
            `Profile check failed with HTTP ${response.status}`,
        );
      const update: Record<string, unknown> = {
        status: "connected",
        email: normalizeEmail(json.email || account.email),
        display_name: normalizeEmail(json.email || account.email),
        last_error: null,
      };
      if (json.access_token) update.access_token = json.access_token;
      const { error: updateError } = await supabase
        .from("gmail_accounts")
        .update(update)
        .eq("workspace_id", workspace.id)
        .eq("id", account.id);
      if (updateError) throw updateError;
      setStatus(`Verified sender: ${json.email}`);
      await loadAccounts();
    } catch (err) {
      const msg = formatError(err);
      setError(msg);
      await supabase
        .from("gmail_accounts")
        .update({ status: "error", last_error: msg })
        .eq("workspace_id", workspace.id)
        .eq("id", account.id);
      await loadAccounts();
    } finally {
      setBusy(false);
    }
  }

  async function ensureCategory() {
    if (categoryId) return categories.find((c) => c.id === categoryId) || null;
    const name = newCategoryName.trim();
    if (!name) throw new Error("Create or select a message category first.");
    const { data, error: upsertError } = await supabase
      .from("message_categories")
      .upsert(
        {
          workspace_id: workspace.id,
          name,
          description: newCategoryDescription.trim() || null,
          active: true,
        },
        { onConflict: "workspace_id,name" },
      )
      .select("*")
      .single();
    if (upsertError) throw upsertError;
    await loadCategories();
    setCategoryId(data.id);
    return data as MessageCategory;
  }

  async function saveCategory() {
    setBusy(true);
    setError("");
    try {
      const cat = await ensureCategory();
      setStatus(`Library category ready: ${cat?.name}.`);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveTemplate() {
    setBusy(true);
    setError("");
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in.");
      const category = await ensureCategory();
      const payload = {
        workspace_id: workspace.id,
        category_id: category?.id || null,
        category_name: category?.name || newCategoryName.trim() || null,
        name: templateName.trim() || "Untitled template",
        subject: subject.trim(),
        subject_variants: subjectVariants
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        message: message.trim(),
        active: true,
        created_by: user.id,
      };
      if (!payload.subject || !payload.message)
        throw new Error("Subject and message are required.");
      const { data, error: insertError } = await supabase
        .from("templates")
        .insert(payload)
        .select("*")
        .single();
      if (insertError) throw insertError;
      await loadTemplates();
      if (data?.id) setTemplateId(data.id);
      setStatus("Template saved in the message library.");
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  async function updateTemplateFromEditor() {
    if (!currentTemplate) return;
    setBusy(true);
    setError("");
    try {
      const category = await ensureCategory();
      const { error: updateError } = await supabase
        .from("templates")
        .update({
          category_id: category?.id || null,
          category_name: category?.name || null,
          name: templateName.trim() || currentTemplate.name,
          subject: subject.trim(),
          subject_variants: subjectVariants
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
          message: message.trim(),
          updated_at: new Date().toISOString(),
        })
        .eq("workspace_id", workspace.id)
        .eq("id", currentTemplate.id);
      if (updateError) throw updateError;
      await loadTemplates();
      setStatus("Template updated.");
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  function loadTemplateIntoEditor(t: TemplateRow) {
    setTemplateId(t.id);
    if (t.category_id) setCategoryId(t.category_id);
    setTemplateName(t.name);
    setSubject(t.subject);
    setSubjectVariants((t.subject_variants || []).join("\n"));
    setMessage(t.message);
  }

  function useFollowUpTemplate() {
    setTemplateName("72-hour follow-up");
    setSubject("Following up, {name}");
    setSubjectVariants("Quick follow-up for {business}");
    setMessage(DEFAULT_FOLLOWUP_MESSAGE);
  }

  async function getContactsForSend(
    limitOverride?: number,
    contactsOverride?: Business[],
  ) {
    const selected =
      contactsOverride || readyContacts.filter((b) => selectedContacts[b.id]);
    const unique = new Map<string, Business>();
    const limit = Math.max(
      1,
      Math.min(
        MAX_MESSAGE_BATCH_SIZE,
        Number(limitOverride || sendLimit || 1000),
      ),
    );

    if (selected.length) {
      for (const business of selected) {
        const key = normalizeEmail(business.email);
        if (key && !unique.has(key)) unique.set(key, business);
      }
      return Array.from(unique.values()).slice(0, limit);
    }

    const cleanSearch = readySearch.trim().replace(/[%_]/g, "");
    const cleanCategory = businessCategoryFilter.trim().replace(/[%_]/g, "");
    let query = supabase
      .from("businesses")
      .select("*")
      .eq("workspace_id", workspace.id)
      .eq("status", "ready")
      .not("email", "is", null)
      .neq("email", "")
      .order("updated_at", { ascending: true })
      .limit(limit);
    if (cleanSearch)
      query = query.or(
        `name.ilike.%${cleanSearch}%,email.ilike.%${cleanSearch}%,domain.ilike.%${cleanSearch}%,website.ilike.%${cleanSearch}%`,
      );
    if (cleanCategory) query = query.ilike("category", `%${cleanCategory}%`);
    const { data, error: loadError } = await query;
    if (loadError) throw loadError;
    for (const business of (data || []) as Business[]) {
      const key = normalizeEmail(business.email);
      if (key && !unique.has(key)) unique.set(key, business);
    }
    return Array.from(unique.values()).slice(0, limit);
  }

  function templatesForSend() {
    const pool = rotateTemplates
      ? categoryTemplates.filter((t) => t.active !== false)
      : ([currentTemplate].filter(Boolean) as TemplateRow[]);
    return pool.length ? pool : templates.filter((t) => t.active !== false);
  }

  async function repairReadyContacts() {
    setBusy(true);
    setError("");
    try {
      const { data, error: repairError } = await supabase.rpc(
        "mark_ready_emails_and_pending_no_email",
        { target_workspace: workspace.id },
      );
      if (repairError) throw repairError;
      const row = Array.isArray(data) ? data[0] : data;
      setStatus(
        `Ready with email: ${Number(row?.ready_count || 0).toLocaleString()}. Pending without email: ${Number(row?.pending_count || 0).toLocaleString()}.`,
      );
      await loadReadyContacts();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  function buildContactPayload(
    business: Business,
    template: TemplateRow,
    index: number,
  ) {
    const subjects = splitSubjects(template.subject, template.subject_variants);
    return {
      id: business.id,
      businessId: business.id,
      name: business.name || "",
      businessName: business.name || "",
      email: normalizeEmail(business.email),
      subject: renderTemplate(
        subjects[index % Math.max(1, subjects.length)] || template.subject,
        business,
      ),
      message: renderTemplate(template.message, business),
      templateId: template.id,
      templateName: template.name,
      categoryId: template.category_id || "",
      categoryName: template.category_name || "",
      website: business.website || "",
      domain: business.domain || getDomain(business),
      source: business.source || "scout_v815",
    };
  }

  async function markSenderPaused(
    account: GmailAccount,
    reason: string,
    pausedUntil?: string,
  ) {
    const until = pausedUntil || toDateTomorrow();
    await supabase
      .from("gmail_accounts")
      .update({ status: "limit_hit", paused_until: until, last_error: reason })
      .eq("workspace_id", workspace.id)
      .eq("id", account.id);
  }

  async function logOutreachEvent(payload: Record<string, unknown>) {
    await supabase
      .from("outreach_events")
      .insert({ workspace_id: workspace.id, ...payload });
  }

  async function persistSendOutcome(params: {
    business: Business;
    template: TemplateRow;
    account: GmailAccount;
    result: SendResult;
    batchId: string;
    subject: string;
    body: string;
    dryRun: boolean;
    isFollowUp?: boolean;
  }) {
    const {
      business,
      template,
      account,
      result,
      batchId,
      subject: sentSubject,
      body,
      dryRun: isDryRun,
      isFollowUp,
    } = params;
    const statusText = String(result.status || "").toLowerCase();
    const isSent = statusText === "sent";
    const sentAt = new Date().toISOString();
    const row = {
      workspace_id: workspace.id,
      business_id: business.id,
      template_id: template.id,
      gmail_account_id: account.id,
      batch_id: batchId,
      to_email: normalizeEmail(business.email),
      from_email: normalizeEmail(account.email),
      subject: sentSubject,
      body,
      provider_message_id: result.gmailMessageId || null,
      gmail_thread_id: result.gmailThreadId || null,
      status: isDryRun ? "dry_run" : statusText || "unknown",
      is_follow_up: !!isFollowUp,
      raw: result,
      sent_at: sentAt,
    };
    const { error: insertError } = await supabase
      .from("sent_messages")
      .insert(row);
    if (insertError) throw insertError;

    if (isSent && !isDryRun) {
      const raw = {
        ...(business.raw || {}),
        last_send: {
          batch_id: batchId,
          template_id: template.id,
          gmail_account_id: account.id,
          from_email: account.email,
          subject: sentSubject,
          sent_at: sentAt,
          is_follow_up: !!isFollowUp,
        },
      };
      const { error: updateError } = await supabase
        .from("businesses")
        .update({ status: "contacted", raw })
        .eq("workspace_id", workspace.id)
        .eq("id", business.id);
      if (updateError) throw updateError;
      await supabase.from("scout_history").upsert(
        {
          workspace_id: workspace.id,
          normalized_key: business.normalized_key,
          email: normalizeEmail(business.email),
          domain: business.domain || getDomain(business),
          website: business.website,
          name: business.name,
          phone: business.phone,
          source: isFollowUp ? "gmail_follow_up" : "gmail_api_send",
          campaign: batchId,
          status: "contacted",
          raw: {
            template_id: template.id,
            gmail_account_id: account.id,
            is_follow_up: !!isFollowUp,
          },
        },
        { onConflict: "workspace_id,normalized_key" },
      );
    }
  }

  async function sendBatch(
    contactsOverride?: Business[],
    options?: { isFollowUp?: boolean; limit?: number },
  ) {
    setBusy(true);
    setError("");
    setProgress(0);
    setLastResults([]);
    setSummary({
      requested: 0,
      attempted: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      stopped: false,
    });
    try {
      const templatePool = templatesForSend();
      if (!templatePool.length)
        throw new Error("Create or select a message template first.");
      const contacts = await getContactsForSend(
        options?.limit,
        contactsOverride,
      );
      if (!contacts.length)
        throw new Error("No Ready contacts with email found.");
      let activeAccounts = accounts.filter(
        (a) =>
          selectedAccounts[a.id] &&
          a.status === "connected" &&
          !isPaused(a) &&
          (a.access_token || a.refresh_token),
      );
      if (!activeAccounts.length)
        throw new Error("Select at least one connected Gmail sender.");

      const batchId = `scout_v815_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const { error: batchError } = await supabase
        .from("outreach_batches")
        .insert({
          id: batchId,
          workspace_id: workspace.id,
          template_id: templatePool[0].id,
          requested_count: contacts.length,
          selected_sender_count: activeAccounts.length,
          status: dryRun ? "dry_run" : "running",
          raw: {
            selected_accounts: activeAccounts.map((a) => a.email),
            dryRun,
            delayMs,
            rotateTemplates,
            categoryId,
            businessCategoryFilter,
            isFollowUp: !!options?.isFollowUp,
          },
        });
      if (batchError) throw batchError;

      const rowsForDownload: Array<Record<string, unknown>> = [];
      let cursor = 0;
      let attempted = 0;
      let sent = 0;
      let failed = 0;
      let skipped = 0;
      let stopped = false;
      const requested = contacts.length;
      setStatus(`Sending ${requested.toLocaleString()} message(s).`);

      for (let i = 0; i < contacts.length; i++) {
        if (!activeAccounts.length) {
          stopped = true;
          skipped += contacts.length - i;
          setStatus(
            "All selected Gmail senders are paused/limited. Remaining contacts stayed Ready.",
          );
          break;
        }
        const business = contacts[i];
        const account = activeAccounts[cursor % activeAccounts.length];
        const template = templatePool[i % templatePool.length];
        cursor += 1;
        const payload = buildContactPayload(business, template, i);
        attempted += 1;
        setStatus(
          `${attempted.toLocaleString()} / ${requested.toLocaleString()} · ${account.email} → ${payload.email}`,
        );

        const response = await fetch(
          "/api/gmail/send",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              workspace_id: workspace.id,
              gmail_account_id: account.id,
              to: payload.email,
              subject: payload.subject,
              body: payload.message,
              dryRun,
            }),
          },
        );
        const json = await response.json().catch(() => ({}));
        const result = ((json?.results || [])[0] || {}) as SendResult;
        const statusText = String(
          result.status || (json?.success ? "sent" : "failed"),
        ).toLowerCase();
        const limitHit = isLimitPayload(json, result);

        if (json?.access_token) {
          await supabase
            .from("gmail_accounts")
            .update({ access_token: json.access_token })
            .eq("workspace_id", workspace.id)
            .eq("id", account.id);
          account.access_token = json.access_token;
        }

        if (!response.ok && limitHit) {
          const reason =
            json?.error ||
            result.reason ||
            `Gmail limit reached for ${account.email}`;
          await markSenderPaused(
            account,
            reason,
            String(json?.senderPausedUntil || result.pausedUntil || ""),
          );
          await logOutreachEvent({
            batch_id: batchId,
            business_id: business.id,
            gmail_account_id: account.id,
            template_id: template.id,
            type: "sender_limit",
            message: reason,
            raw: json,
          });
          rowsForDownload.push({
            business: business.name,
            email: business.email,
            sender: account.email,
            template: template.name,
            status: "not_sent_sender_limit",
            reason,
          });
          activeAccounts = activeAccounts.filter((a) => a.id !== account.id);
          failed += 1;
          i -= 1;
          if (!activeAccounts.length) {
            stopped = true;
            skipped += contacts.length - i - 1;
            break;
          }
          continue;
        }

        if (!response.ok || json?.success === false) {
          const reason =
            json?.error ||
            result.reason ||
            `Send failed with HTTP ${response.status}`;
          failed += 1;
          rowsForDownload.push({
            business: business.name,
            email: business.email,
            sender: account.email,
            template: template.name,
            status: "failed",
            reason,
          });
          await persistSendOutcome({
            business,
            template,
            account,
            result: { ...result, status: "failed", reason },
            batchId,
            subject: payload.subject,
            body: payload.message,
            dryRun,
            isFollowUp: options?.isFollowUp,
          });
          await logOutreachEvent({
            batch_id: batchId,
            business_id: business.id,
            gmail_account_id: account.id,
            template_id: template.id,
            type: "send_failed",
            message: reason,
            raw: json,
          });
        } else if (statusText === "sent" || statusText === "dry_run") {
          if (statusText === "sent") sent += 1;
          else skipped += 1;
          rowsForDownload.push({
            business: business.name,
            email: business.email,
            sender: account.email,
            template: template.name,
            status: statusText,
            subject: payload.subject,
            gmailMessageId: result.gmailMessageId || "",
          });
          await persistSendOutcome({
            business,
            template,
            account,
            result: { ...result, status: statusText },
            batchId,
            subject: payload.subject,
            body: payload.message,
            dryRun,
            isFollowUp: options?.isFollowUp,
          });
          await logOutreachEvent({
            batch_id: batchId,
            business_id: business.id,
            gmail_account_id: account.id,
            template_id: template.id,
            type: statusText,
            message: `${statusText}: ${payload.email}`,
            raw: result,
          });
        } else {
          skipped += 1;
          const reason = result.reason || statusText || "not_sent";
          rowsForDownload.push({
            business: business.name,
            email: business.email,
            sender: account.email,
            template: template.name,
            status: statusText,
            reason,
          });
          await persistSendOutcome({
            business,
            template,
            account,
            result: { ...result, status: statusText },
            batchId,
            subject: payload.subject,
            body: payload.message,
            dryRun,
            isFollowUp: options?.isFollowUp,
          });
        }

        setProgress(Math.round(((i + 1) / contacts.length) * 100));
        setSummary({ requested, attempted, sent, failed, skipped, stopped });
      }

      const finalStatus = stopped
        ? "stopped"
        : dryRun
          ? "dry_run_complete"
          : "complete";
      await supabase
        .from("outreach_batches")
        .update({
          status: finalStatus,
          attempted_count: attempted,
          sent_count: sent,
          failed_count: failed,
          skipped_count: skipped,
          finished_at: new Date().toISOString(),
        })
        .eq("workspace_id", workspace.id)
        .eq("id", batchId);
      setLastResults(rowsForDownload);
      setProgress(100);
      setSummary({ requested, attempted, sent, failed, skipped, stopped });
      setSelectedContacts({});
      setStatus(
        `Batch ${finalStatus}. Requested ${requested}, sent ${sent}, failed ${failed}, skipped/not sent ${skipped}.`,
      );
      await Promise.all([
        loadReadyContacts(),
        loadAccounts(),
        loadPerformance(),
        loadDueFollowUps(),
      ]);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveSchedule() {
    setBusy(true);
    setError("");
    try {
      const templatePool = templatesForSend();
      if (!templatePool.length)
        throw new Error("Create/select at least one template first.");
      const scheduledFor = new Date(scheduleFor).toISOString();
      const { error: insertError } = await supabase
        .from("message_schedules")
        .insert({
          workspace_id: workspace.id,
          type: scheduleType,
          category_id: categoryId || null,
          template_id: rotateTemplates ? null : currentTemplate?.id || null,
          target_count: Math.max(
            1,
            Math.min(
              MAX_MESSAGE_BATCH_SIZE,
              Number(scheduleCount || sendLimit || 1000),
            ),
          ),
          scheduled_for: scheduledFor,
          status: "scheduled",
          raw: {
            business_category_filter: businessCategoryFilter,
            rotate_templates: rotateTemplates,
            delay_ms: delayMs,
          },
        });
      if (insertError) throw insertError;
      setStatus(
        "Message schedule saved. Due schedules appear in the schedule list.",
      );
      await loadSchedules();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  async function scheduleFollowUpsForDue() {
    setBusy(true);
    setError("");
    try {
      if (!dueFollowUps.length) throw new Error("No due follow-ups found.");
      const { error: insertError } = await supabase
        .from("message_schedules")
        .insert({
          workspace_id: workspace.id,
          type: "follow_up",
          category_id: categoryId || null,
          template_id: rotateTemplates ? null : currentTemplate?.id || null,
          target_count: dueFollowUps.length,
          scheduled_for: new Date(followUpFor).toISOString(),
          status: "scheduled",
          raw: {
            due_mode: true,
            followup_after_hours: 72,
            due_business_ids: dueFollowUps.map((d) => d.business_id),
            rotate_templates: rotateTemplates,
          },
        });
      if (insertError) throw insertError;
      setStatus(
        `Scheduled ${dueFollowUps.length.toLocaleString()} due follow-up(s).`,
      );
      await loadSchedules();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  async function getDueFollowUpBusinesses(limit = 1000) {
    const rows = dueFollowUps.slice(0, limit);
    if (!rows.length) return [] as Business[];
    const { data, error: loadError } = await supabase
      .from("businesses")
      .select("*")
      .eq("workspace_id", workspace.id)
      .in(
        "id",
        rows.map((r) => r.business_id),
      );
    if (loadError) throw loadError;
    return (data || []) as Business[];
  }

  async function sendDueFollowUpsNow() {
    const contacts = await getDueFollowUpBusinesses(
      Math.min(Number(sendLimit || 1000), dueFollowUps.length || 1000),
    );
    await sendBatch(contacts, { isFollowUp: true, limit: contacts.length });
  }

  async function sendDueSchedulesNow() {
    const due = schedules.filter(
      (s) =>
        new Date(s.scheduled_for).getTime() <= Date.now() &&
        s.status === "scheduled",
    );
    if (!due.length) {
      setStatus("No due schedules yet.");
      return;
    }
    const first = due[0];
    setScheduleType(first.type === "follow_up" ? "follow_up" : "initial");
    const count = Number(first.target_count || sendLimit || 1000);
    if (first.type === "follow_up") {
      const contacts = await getDueFollowUpBusinesses(count);
      await sendBatch(contacts, { isFollowUp: true, limit: count });
    } else {
      await sendBatch(undefined, { limit: count });
    }
    await supabase
      .from("message_schedules")
      .update({ status: "sent", updated_at: new Date().toISOString() })
      .eq("workspace_id", workspace.id)
      .eq("id", first.id);
    await loadSchedules();
  }

  function toggleAllContacts(value: boolean) {
    if (!value) return setSelectedContacts({});
    setSelectedContacts(
      Object.fromEntries(readyContacts.map((b) => [b.id, true])),
    );
  }

  function selectCategory(value: string) {
    setCategoryId(value);
    const first = templates.find((t) => t.category_id === value);
    if (first) loadTemplateIntoEditor(first);
  }

  return (
    <div className="stack">
      {error ? <div className="error">{error}</div> : null}
      <div className="success">{status}</div>
      {backendNote ? <div className="notice">{backendNote}</div> : null}
      {busy || loading ? (
        <div className="progress-track">
          <div
            className="progress-fill"
            style={{ width: `${progress || (loading ? 30 : 0)}%` }}
          />
        </div>
      ) : null}

      <div className="grid grid-4">
        <div className="card kpi">
          <div className="title">Ready To Message</div>
          <div className="num">{readyTotal.toLocaleString()}</div>
        </div>
        <div className="card kpi">
          <div className="title">Selected Senders</div>
          <div className="num">{selectedAccountIds.length}</div>
        </div>
        <div className="card kpi">
          <div className="title">Templates In Category</div>
          <div className="num">{categoryTemplates.length}</div>
        </div>
        <div className="card kpi">
          <div className="title">Due Follow-ups</div>
          <div className="num">{dueFollowUps.length}</div>
        </div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <h3>Send Message</h3>
        <div className="grid grid-4">
          <div>
            <label className="label">Message category</label>
            <select
              className="select"
              value={categoryId}
              onChange={(e) => selectCategory(e.target.value)}
            >
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Business category filter</label>
            <input
              className="input"
              value={businessCategoryFilter}
              onChange={(e) => setBusinessCategoryFilter(e.target.value)}
              placeholder="Optional: Shopify, Airtable..."
            />
          </div>
          <div>
            <label className="label">Fixed number to send</label>
            <input
              className="input"
              type="number"
              min={1}
              max={MAX_MESSAGE_BATCH_SIZE}
              value={sendLimit}
              onChange={(e) => setSendLimit(Number(e.target.value || 1000))}
            />
          </div>
          <div>
            <label className="label">Sending delay</label>
            <div className="notice" style={{ margin: 0 }}>Automatic: 90–210 seconds for the same Gmail and 3–6 seconds between different Gmail accounts.</div>
          </div>
        </div>
        <div className="actions" style={{ marginTop: 12 }}>
          <label className="checkbox-row" style={{ margin: 0 }}>
            <input
              type="checkbox"
              checked={rotateTemplates}
              onChange={(e) => setRotateTemplates(e.target.checked)}
            />{" "}
            Rotate templates from selected category
          </label>
          <label className="checkbox-row" style={{ margin: 0 }}>
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
            />{" "}
            Dry run
          </label>
          <button
            className="btn"
            type="button"
            disabled={busy || loading}
            onClick={() => sendBatch()}
          >
            Start Batch
          </button>
          <button
            className="btn secondary"
            type="button"
            disabled={busy || loading}
            onClick={refreshAll}
          >
            Refresh
          </button>
          <button
            className="btn secondary"
            type="button"
            disabled={busy || loading}
            onClick={repairReadyContacts}
          >
            Repair Ready
          </button>
          <button
            className="btn secondary"
            type="button"
            disabled={!lastResults.length}
            onClick={() =>
              downloadCsv("scout-message-last-results.csv", lastResults)
            }
          >
            Download Results
          </button>
        </div>
        <div className="grid grid-4" style={{ marginTop: 14 }}>
          <div className="card kpi">
            <div className="title">Requested</div>
            <div className="num">{summary.requested}</div>
          </div>
          <div className="card kpi">
            <div className="title">Attempted</div>
            <div className="num">{summary.attempted}</div>
          </div>
          <div className="card kpi">
            <div className="title">Sent</div>
            <div className="num">{summary.sent}</div>
          </div>
          <div className="card kpi">
            <div className="title">Failed / Skipped</div>
            <div className="num">{summary.failed + summary.skipped}</div>
          </div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card" style={{ padding: 18 }}>
          <h3>Message Library</h3>
          <div className="notice">
            Shortcodes:{" "}
            {SHORTCODES.map((s) => (
              <code key={s}>{s}</code>
            ))}
          </div>
          <div className="grid grid-2" style={{ marginTop: 12 }}>
            <div>
              <label className="label">New / selected category name</label>
              <input
                className="input"
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Category note</label>
              <input
                className="input"
                value={newCategoryDescription}
                onChange={(e) => setNewCategoryDescription(e.target.value)}
              />
            </div>
          </div>
          <div className="actions" style={{ marginTop: 10 }}>
            <button
              className="btn secondary"
              type="button"
              onClick={saveCategory}
              disabled={busy}
            >
              Save Category
            </button>
            <button
              className="btn secondary"
              type="button"
              onClick={useFollowUpTemplate}
            >
              Use Follow-up Draft
            </button>
          </div>
          <div className="grid grid-2" style={{ marginTop: 12 }}>
            <div>
              <label className="label">Template</label>
              <select
                className="select"
                value={templateId}
                onChange={(e) => {
                  const t = templates.find((x) => x.id === e.target.value);
                  if (t) loadTemplateIntoEditor(t);
                  else setTemplateId(e.target.value);
                }}
              >
                <option value="">Select template</option>
                {categoryTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Template name</label>
              <input
                className="input"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
              />
            </div>
          </div>
          <label className="label" style={{ marginTop: 10 }}>
            Primary subject
          </label>
          <input
            className="input"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
          <label className="label" style={{ marginTop: 10 }}>
            Extra subject variants
          </label>
          <textarea
            className="textarea"
            style={{ minHeight: 70 }}
            value={subjectVariants}
            onChange={(e) => setSubjectVariants(e.target.value)}
          />
          <label className="label" style={{ marginTop: 10 }}>
            Message
          </label>
          <textarea
            className="textarea"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <div className="actions" style={{ marginTop: 12 }}>
            <button
              className="btn"
              type="button"
              onClick={saveTemplate}
              disabled={busy}
            >
              Save New Template
            </button>
            <button
              className="btn secondary"
              type="button"
              onClick={updateTemplateFromEditor}
              disabled={busy || !currentTemplate}
            >
              Update Selected
            </button>
          </div>
        </div>

        <div className="card" style={{ padding: 18 }}>
          <h3>Gmail Senders</h3>
          <div className="notice">Google OAuth is configured once for this independent deployment in Vercel. Signed-in users only click Connect Gmail.</div>
          <div className="actions" style={{ marginTop: 10 }}>
            <button className="btn" type="button" onClick={startGmailOauth}>Connect Gmail</button>
          </div>
          <div className="table-wrap" style={{ marginTop: 14 }}>
            <table>
              <thead>
                <tr>
                  <th>Use</th>
                  <th>Email</th>
                  <th>Status</th>
                  <th>Sent Today</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => (
                  <tr key={account.id}>
                    <td>
                      <input
                        type="checkbox"
                        disabled={
                          account.status !== "connected" || isPaused(account)
                        }
                        checked={!!selectedAccounts[account.id]}
                        onChange={(e) =>
                          setSelectedAccounts((cur) => ({
                            ...cur,
                            [account.id]: e.target.checked,
                          }))
                        }
                      />
                    </td>
                    <td>
                      <strong>{account.email}</strong>
                      <br />
                      <span className="muted">
                        {account.last_error ||
                          (account.paused_until
                            ? `Paused until ${new Date(account.paused_until).toLocaleString()}`
                            : "Ready")}
                      </span>
                    </td>
                    <td>
                      <span className={`status ${account.status}`}>
                        {isPaused(account) ? "paused" : account.status}
                      </span>
                    </td>
                    <td>{Number(account.sent_today || 0).toLocaleString()}</td>
                    <td>
                      <button
                        className="btn secondary"
                        type="button"
                        disabled={
                          busy ||
                          !(account.access_token || account.refresh_token)
                        }
                        onClick={() => verifySenderProfile(account)}
                      >
                        Verify
                      </button>
                    </td>
                  </tr>
                ))}
                {!accounts.length ? (
                  <tr>
                    <td colSpan={5} className="muted">
                      No senders connected.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card" style={{ padding: 18 }}>
          <div
            className="actions"
            style={{ justifyContent: "space-between", marginBottom: 12 }}
          >
            <h3 style={{ margin: 0 }}>Ready Contacts</h3>
            <div className="actions">
              <input
                className="input"
                style={{ width: 260 }}
                value={readySearch}
                onChange={(e) => setReadySearch(e.target.value)}
                placeholder="Search contacts"
                onKeyDown={(e) => {
                  if (e.key === "Enter") loadReadyContacts();
                }}
              />
              <button
                className="btn secondary"
                type="button"
                onClick={loadReadyContacts}
              >
                Search
              </button>
            </div>
          </div>
          <div className="actions" style={{ marginBottom: 12 }}>
            <label className="checkbox-row" style={{ margin: 0 }}>
              <input
                type="checkbox"
                checked={
                  readyContacts.length > 0 &&
                  selectedContactIds.length === readyContacts.length
                }
                onChange={(e) => toggleAllContacts(e.target.checked)}
              />{" "}
              Select preview page
            </label>
            <span className="badge">
              Showing {readyContacts.length.toLocaleString()} of{" "}
              {readyTotal.toLocaleString()}
            </span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Use</th>
                  <th>Business</th>
                  <th>Email</th>
                  <th>Category</th>
                </tr>
              </thead>
              <tbody>
                {readyContacts.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={!!selectedContacts[b.id]}
                        onChange={(e) =>
                          setSelectedContacts((cur) => ({
                            ...cur,
                            [b.id]: e.target.checked,
                          }))
                        }
                      />
                    </td>
                    <td>
                      <strong>{b.name || "-"}</strong>
                      <br />
                      <span className="muted">
                        {b.website || b.domain || ""}
                      </span>
                    </td>
                    <td>{b.email}</td>
                    <td>{b.category || "-"}</td>
                  </tr>
                ))}
                {!readyContacts.length ? (
                  <tr>
                    <td colSpan={4} className="muted">
                      No Ready contacts found.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card" style={{ padding: 18 }}>
          <h3>Preview</h3>
          {previewBusiness && currentTemplate ? (
            <>
              <p className="muted">
                {previewBusiness.name || previewBusiness.email}
              </p>
              <label className="label">Subject</label>
              <div className="notice">{previewSubject}</div>
              <label className="label" style={{ marginTop: 12 }}>
                Body
              </label>
              <div
                className="card"
                style={{ padding: 14, whiteSpace: "pre-wrap" }}
              >
                {previewBody}
              </div>
            </>
          ) : (
            <p className="muted">Select a template and load contacts.</p>
          )}
          <h3 style={{ marginTop: 18 }}>Recent Sent Logs</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>To</th>
                  <th>From</th>
                  <th>Status</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {recentSent.slice(0, 8).map((row) => (
                  <tr key={row.id}>
                    <td>{row.to_email}</td>
                    <td>{row.from_email}</td>
                    <td>{row.status}</td>
                    <td>
                      {row.sent_at
                        ? new Date(row.sent_at).toLocaleString()
                        : "-"}
                    </td>
                  </tr>
                ))}
                {!recentSent.length ? (
                  <tr>
                    <td colSpan={4} className="muted">
                      No sent logs yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card" style={{ padding: 18 }}>
          <h3>Follow-ups</h3>
          <p className="muted">
            Contacts become due 72 hours after a sent message when there is no
            reply and no no-inbox/bounce record.
          </p>
          <div className="grid grid-2">
            <div>
              <label className="label">Schedule due follow-ups for</label>
              <input
                className="input"
                type="datetime-local"
                value={followUpFor}
                onChange={(e) => setFollowUpFor(e.target.value)}
              />
            </div>
            <div style={{ display: "flex", alignItems: "end" }}>
              <button
                className="btn secondary"
                type="button"
                disabled={busy || !dueFollowUps.length}
                onClick={scheduleFollowUpsForDue}
              >
                Schedule Due Follow-ups
              </button>
            </div>
          </div>
          <div className="actions" style={{ marginTop: 12 }}>
            <button
              className="btn"
              type="button"
              disabled={busy || !dueFollowUps.length}
              onClick={sendDueFollowUpsNow}
            >
              Send Due Follow-ups Now
            </button>
            <button
              className="btn secondary"
              type="button"
              onClick={loadDueFollowUps}
            >
              Refresh Due
            </button>
          </div>
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr>
                  <th>Business</th>
                  <th>Email</th>
                  <th>Last Sent</th>
                  <th>Subject</th>
                </tr>
              </thead>
              <tbody>
                {dueFollowUps.map((row) => (
                  <tr key={`${row.business_id}-${row.last_sent_at}`}>
                    <td>{row.business_name || "-"}</td>
                    <td>{row.to_email}</td>
                    <td>{new Date(row.last_sent_at).toLocaleString()}</td>
                    <td>{row.last_subject || "-"}</td>
                  </tr>
                ))}
                {!dueFollowUps.length ? (
                  <tr>
                    <td colSpan={4} className="muted">
                      No follow-ups due.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card" style={{ padding: 18 }}>
          <h3>Schedules</h3>
          <div className="grid grid-3">
            <div>
              <label className="label">Type</label>
              <select
                className="select"
                value={scheduleType}
                onChange={(e) =>
                  setScheduleType(e.target.value as "initial" | "follow_up")
                }
              >
                <option value="initial">Initial batch</option>
                <option value="follow_up">Follow-up</option>
              </select>
            </div>
            <div>
              <label className="label">Date & time</label>
              <input
                className="input"
                type="datetime-local"
                value={scheduleFor}
                onChange={(e) => setScheduleFor(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Count</label>
              <input
                className="input"
                type="number"
                value={scheduleCount}
                onChange={(e) =>
                  setScheduleCount(Number(e.target.value || 1000))
                }
              />
            </div>
          </div>
          <div className="actions" style={{ marginTop: 12 }}>
            <button
              className="btn secondary"
              type="button"
              disabled={busy}
              onClick={saveSchedule}
            >
              Save Schedule
            </button>
            <button
              className="btn"
              type="button"
              disabled={busy}
              onClick={sendDueSchedulesNow}
            >
              Send Due Schedule Now
            </button>
          </div>
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>For</th>
                  <th>Count</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {schedules.map((s) => (
                  <tr key={s.id}>
                    <td>{s.type}</td>
                    <td>{new Date(s.scheduled_for).toLocaleString()}</td>
                    <td>{Number(s.target_count || 0).toLocaleString()}</td>
                    <td>{s.status}</td>
                  </tr>
                ))}
                {!schedules.length ? (
                  <tr>
                    <td colSpan={4} className="muted">
                      No schedules yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
