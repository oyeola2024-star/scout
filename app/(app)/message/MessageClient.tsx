"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase-browser";
import { analyzeSpamRisk } from "@/lib/spam-guard";
import { emitLiveActivity } from "@/lib/live-activity-client";
import { applyCountryFilter, businessMatchesCountry, extractBusinessCountries } from "@/lib/country-location";
import { resolveBusinessLanguage, resolveTemplateContent } from "@/lib/template-language";
import { businessIdentityKeys } from "@/lib/normalize";
import {
  Business,
  GmailAccount,
  MessageCategory,
  MessageSchedule,
  MessageTemplate,
  Workspace,
} from "@/lib/types";

type SendLogRow = {
  id: string;
  status?: string | null;
  to_email?: string | null;
  from_email?: string | null;
  subject?: string | null;
  sent_at?: string | null;
};

type DueFollowUp = {
  business_id: string;
  business_name: string | null;
  to_email: string;
  last_sent_at: string;
  last_subject: string | null;
  template_id: string | null;
  gmail_account_id: string | null;
  followup_segment?: string | null;
  segment?: string | null;
  reply_state?: string | null;
  last_auto_reply_at?: string | null;
};

type LocationOption = {
  value: string;
  label: string;
  count: number;
  totalCount: number;
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

type Summary = {
  requested: number;
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
  stopped: boolean;
};
type TemplateMode = "specific" | "rotate";
type SenderMode = "specific" | "rotate";
type MessageKind = "initial" | "follow_up";

const CONTACTABLE_BUSINESS_STATUSES = ["ready", "found", "connected"];
const LOCATION_RAW_KEYS = [
  "location",
  "country",
  "country_name",
  "countryName",
  "market",
  "city",
  "region",
  "state",
  "province",
  "address",
  "business_location",
  "businessLocation",
  "hq_location",
  "headquarters",
  "territory",
];

const READY_PAGE_SIZE = 100;
const LOCATION_SCAN_PAGE_SIZE = 1000;
const COUNTRY_SCAN_PAGE_SIZE = 1000;
const SCHEDULE_RUNNER_INTERVAL_MS = 1000;
const MESSAGE_REQUEST_TIMEOUT_MS = 90000;
const MAX_MESSAGE_BATCH_SIZE = 50000;
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

async function fetchJsonWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = MESSAGE_REQUEST_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const json = await response.json().catch(() => ({}));
    return { response, json };
  } finally {
    window.clearTimeout(timer);
  }
}

function normalizeEmail(email: unknown) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function cleanLocationValue(value: unknown) {
  const cleaned = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  if (cleaned.length > 90) return "";
  const lower = cleaned.toLowerCase();
  if (lower.includes("@")) return "";
  if (lower.startsWith("http")) return "";
  if (lower.includes("www.")) return "";
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(cleaned)) return "";
  return cleaned;
}

function addLocationCandidate(target: Set<string>, value: unknown) {
  const cleaned = cleanLocationValue(value);
  if (!cleaned) return;
  const parts = cleaned
    .split(/[|;\n]/g)
    .map((item) => cleanLocationValue(item))
    .filter(Boolean);
  if (parts.length > 1) {
    parts.forEach((part) => target.add(part));
    return;
  }
  target.add(cleaned);
}

function extractBusinessLocations(business: Partial<Business>) {
  return extractBusinessCountries(business);
}

function businessMatchesLocation(business: Business, selectedLocation: string) {
  return businessMatchesCountry(business, selectedLocation);
}

function applyLocationFilter(rows: Business[], selectedLocation: string) {
  return applyCountryFilter(rows, selectedLocation);
}

function contactableStatusQuery(query: any) {
  return query.in("status", CONTACTABLE_BUSINESS_STATUSES);
}

function isMissingReadyContactIssue(error: unknown) {
  const text = formatError(error).toLowerCase();
  return text.includes("no ready to contact") || text.includes("ready to contact with email");
}

function isMissingRpcFunction(error: unknown) {
  const text = formatError(error).toLowerCase();
  return (
    text.includes("pgrst202") ||
    text.includes("get_due_followups") ||
    text.includes("schema cache")
  );
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

function hasActiveSafetyOverride(account: GmailAccount) {
  return Boolean(account.safety_override_until && new Date(account.safety_override_until).getTime() > Date.now());
}

function isPaused(account: GmailAccount) {
  if (hasActiveSafetyOverride(account)) return false;
  const status = String(account.status || "").toLowerCase();
  if ((account as any).is_paused === true || ["limit_hit", "paused", "blocked"].includes(status)) return true;
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
    message.includes("sending limit") ||
    message.includes("quota") ||
    message.includes("user-rate") ||
    message.includes("rate limit") ||
    message.includes("too many")
  );
}

function isBlockedPayload(json: any, result?: SendResult) {
  const text = [
    json?.error,
    json?.message,
    json?.code,
    result?.status,
    result?.reason,
    result?.code,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return (
    text.includes("message blocked") ||
    text.includes("blocked") ||
    text.includes("policy") ||
    text.includes("spam") ||
    text.includes("rejected")
  );
}

function toDateTomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(0, 5, 0, 0);
  return d.toISOString();
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


function safeIcsText(value: unknown) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function toIcsDate(value: string | Date) {
  const d = value instanceof Date ? value : new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function scheduleLabel(schedule: Pick<MessageSchedule, "type" | "target_count" | "scheduled_for">) {
  const type = schedule.type === "follow_up" ? "follow-ups" : "emails";
  const count = Number(schedule.target_count || 0);
  return `${count ? count.toLocaleString() : ""} ${type}`.trim();
}

export default function MessageClient({ workspace }: { workspace: Workspace }) {
  const supabase = useMemo(() => createClient(), []);
  const [categories, setCategories] = useState<MessageCategory[]>([]);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [accounts, setAccounts] = useState<GmailAccount[]>([]);
  const [readyContacts, setReadyContacts] = useState<Business[]>([]);
  const [readyTotal, setReadyTotal] = useState(0);
  const [recentSent, setRecentSent] = useState<SendLogRow[]>([]);
  const [dueFollowUps, setDueFollowUps] = useState<DueFollowUp[]>([]);
  const [schedules, setSchedules] = useState<MessageSchedule[]>([]);
  const [locationOptions, setLocationOptions] = useState<LocationOption[]>([]);

  const [selectedContacts, setSelectedContacts] = useState<
    Record<string, boolean>
  >({});
  const [selectedAccounts, setSelectedAccounts] = useState<
    Record<string, boolean>
  >({});
  const [senderRunLimits, setSenderRunLimits] = useState<
    Record<string, string>
  >({});
  const [senderLast24h, setSenderLast24h] = useState<Record<string, number>>(
    {},
  );
  const [specificSenderId, setSpecificSenderId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [followUpTemplateId, setFollowUpTemplateId] = useState("");
  const [templateMode, setTemplateMode] = useState<TemplateMode>("specific");
  const [senderMode, setSenderMode] = useState<SenderMode>("rotate");
  const [businessCategoryFilter, setBusinessCategoryFilter] = useState("");
  const [countryFilter, setCountryFilter] = useState("");
  const [audienceCategoryId, setAudienceCategoryId] = useState(
    workspace.default_audience_category_id || "",
  );
  const [readySearch, setReadySearch] = useState("");
  const [sendLimit, setSendLimit] = useState(1000);
  const delayMs = 0; // Scout controls pacing automatically: 90–210s per Gmail and 3–6s across different Gmail accounts.
  const [dryRun, setDryRun] = useState(false);
  const [allowHighRiskSend, setAllowHighRiskSend] = useState(false);
  const [scheduleType, setScheduleType] = useState<"initial" | "follow_up">(
    "initial",
  );
  const [scheduleFor, setScheduleFor] = useState(inHours(1));
  const [scheduleCount, setScheduleCount] = useState(1000);
  const [followUpFor, setFollowUpFor] = useState(inHours(2));
  const [followUpSegment, setFollowUpSegment] = useState<
    "all_unanswered" | "no_reply" | "auto_reply"
  >("all_unanswered");

  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [stopBusyId, setStopBusyId] = useState("");
  const [autoRunSchedules, setAutoRunSchedules] = useState(true);
  const [scheduleRunnerBusy, setScheduleRunnerBusy] = useState(false);
  const scheduleRunnerRef = useRef(false);
  const refreshInFlightRef = useRef(false);
  const locationsRequestRef = useRef(0);
  const readyContactsRequestRef = useRef(0);
  const [scheduleReminderEnabled, setScheduleReminderEnabled] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<string>("unsupported");
  const [showMoreOptions, setShowMoreOptions] = useState(false);
  const [showReadyLeads, setShowReadyLeads] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [showSavedSends, setShowSavedSends] = useState(false);
  const [showDueList, setShowDueList] = useState(false);
  const [lastSavedSchedule, setLastSavedSchedule] = useState<MessageSchedule | null>(null);
  const dueReminderRef = useRef<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [lastResults, setLastResults] = useState<
    Array<Record<string, unknown>>
  >([]);
  const [summary, setSummary] = useState<Summary>({
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
  const sendableTemplates = templates.filter(
    (t) => (t.template_type || "initial") === "initial" && t.active !== false,
  );
  const categoryTemplates = sendableTemplates.filter(
    (t) => !categoryId || t.category_id === categoryId,
  );
  const followUpTemplates = templates.filter(
    (t) => (t.template_type || "initial") === "follow_up" && t.active !== false && (!categoryId || t.category_id === categoryId),
  );
  const allFollowUpTemplates = templates.filter(
    (t) => (t.template_type || "initial") === "follow_up" && t.active !== false,
  );
  const currentTemplate =
    sendableTemplates.find((t) => t.id === templateId) ||
    categoryTemplates[0] ||
    sendableTemplates[0];
  const currentFollowUpTemplate =
    allFollowUpTemplates.find((t) => t.id === followUpTemplateId) ||
    followUpTemplates[0] ||
    allFollowUpTemplates[0];
  const selectedAudienceCategory =
    categories.find((c) => c.id === audienceCategoryId) || null;
  function senderDailyLimit(account: GmailAccount) {
    const deployment = Math.max(1, Number(account.deployment_cap || 250));
    const health = Math.max(0, Number(account.health_cap ?? deployment));
    const user = Math.max(1, Number(account.daily_limit || deployment));
    return Math.max(0, Math.floor(Math.min(deployment, health, user)));
  }
  function senderRemainingToday(account: GmailAccount) {
    const daily = senderDailyLimit(account);
    if (!Number.isFinite(daily)) return Number.POSITIVE_INFINITY;
    const used = Number(senderLast24h[account.id] || account.sent_today || 0);
    return Math.max(0, daily - Math.max(0, used));
  }
  function senderAvailable(account: GmailAccount) {
    return ["connected", "ready"].includes(String(account.status || "")) &&
      !isPaused(account) &&
      Boolean(account.access_token || account.refresh_token) &&
      senderRemainingToday(account) > 0;
  }
  const connectedAccounts = accounts.filter(senderAvailable);
  const dueSchedules = schedules.filter((schedule) => {
    const statusText = String(schedule.status || "");
    if (!["scheduled", "due"].includes(statusText)) return false;
    const scheduledTime = new Date(schedule.scheduled_for).getTime();
    return Number.isFinite(scheduledTime) && scheduledTime <= Date.now();
  });
  const previewBusiness =
    readyContacts.find((b) => selectedContacts[b.id]) || readyContacts[0];
  const previewLocalized = previewBusiness && currentTemplate
    ? resolveTemplateContent(currentTemplate, previewBusiness)
    : null;
  const previewSubject =
    previewBusiness && previewLocalized
      ? renderTemplate(
          splitSubjects(
            previewLocalized.subject,
            previewLocalized.subjectVariants,
          )[0] || previewLocalized.subject,
          previewBusiness,
        )
      : "";
  const previewBody =
    previewBusiness && previewLocalized
      ? renderTemplate(previewLocalized.message, previewBusiness)
      : "";
  const spamReport = analyzeSpamRisk(previewSubject, previewBody);

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
    const rows = ((data || []) as MessageTemplate[]).filter(
      (t) => (t.template_type || "initial") !== "reply",
    );
    setTemplates(rows);
    const firstInitial = rows.find((t) => (t.template_type || "initial") === "initial" && t.active !== false);
    const firstFollowUp = rows.find((t) => (t.template_type || "initial") === "follow_up" && t.active !== false);
    if (!templateId && firstInitial?.id) setTemplateId(firstInitial.id);
    if (!followUpTemplateId && firstFollowUp?.id) setFollowUpTemplateId(firstFollowUp.id);
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
        next[account.id] = current[account.id] ??
          (["connected", "ready"].includes(String(account.status || "")) && !isPaused(account));
      return next;
    });
    if (!specificSenderId && rows[0]?.id) setSpecificSenderId(rows[0].id);

    const counts: Record<string, number> = {};
    for (const account of rows) counts[account.id] = Math.max(0, Number(account.sent_today || 0));
    setSenderLast24h(counts);
  }

  async function loadAvailableLocations() {
    const requestId = ++locationsRequestRef.current;
    const counts = new Map<string, { total: number; sendable: number }>();
    const cleanCategory = businessCategoryFilter.trim().replace(/[%_]/g, "");

    // Scan the complete workspace in small pages. The Businesses page shows the
    // full workspace, so the Send filter must not silently stop at 10,000 rows
    // or hide countries merely because some leads still need an email.
    for (let offset = 0; ; offset += LOCATION_SCAN_PAGE_SIZE) {
      let query = supabase
        .from("businesses")
        .select("id,location,raw,domain,website,email,status,category,category_id,updated_at")
        .eq("workspace_id", workspace.id)
        .order("updated_at", { ascending: false })
        .range(offset, offset + LOCATION_SCAN_PAGE_SIZE - 1);
      if (audienceCategoryId) query = query.eq("category_id", audienceCategoryId);
      else if (cleanCategory) query = query.ilike("category", `%${cleanCategory}%`);
      const { data, error: locationError } = await query;
      if (locationError) throw locationError;
      if (requestId !== locationsRequestRef.current) return;
      const rows = (data || []) as Business[];
      for (const row of rows) {
        const isSendable = Boolean(
          row.email && CONTACTABLE_BUSINESS_STATUSES.includes(String(row.status || "")),
        );
        for (const value of extractBusinessLocations(row)) {
          const current = counts.get(value) || { total: 0, sendable: 0 };
          current.total += 1;
          if (isSendable) current.sendable += 1;
          counts.set(value, current);
        }
      }
      if (rows.length < LOCATION_SCAN_PAGE_SIZE) break;
    }
    if (requestId !== locationsRequestRef.current) return;
    const options = Array.from(counts.entries())
      .map(([value, totals]) => ({
        value,
        count: totals.sendable,
        totalCount: totals.total,
        label: `${value} (${totals.sendable.toLocaleString()} ready / ${totals.total.toLocaleString()} total)`,
      }))
      .sort((a, b) => a.value.localeCompare(b.value));
    setLocationOptions(options);
    setCountryFilter((current) =>
      current && !options.some((option) => option.value === current) ? "" : current,
    );
  }

  async function loadReadyContacts() {
    const requestId = ++readyContactsRequestRef.current;
    const cleanSearch = readySearch.trim().replace(/[%_]/g, "");
    const cleanCategory = businessCategoryFilter.trim().replace(/[%_]/g, "");
    const cleanCountry = countryFilter.trim().replace(/[%_]/g, "");
    const targetBusinessId = typeof window !== "undefined" ? new URL(window.location.href).searchParams.get("business") : "";
    let rows: Business[] = [];
    let total = 0;
    if (!cleanCountry) {
      let query = contactableStatusQuery(
        supabase.from("businesses").select("*", { count: "exact" })
          .eq("workspace_id", workspace.id).not("email", "is", null).neq("email", "")
          .order("updated_at", { ascending: true }).limit(READY_PAGE_SIZE),
      );
      if (cleanSearch) query = query.or(`name.ilike.%${cleanSearch}%,email.ilike.%${cleanSearch}%,domain.ilike.%${cleanSearch}%,website.ilike.%${cleanSearch}%`);
      if (audienceCategoryId) query = query.eq("category_id", audienceCategoryId);
      else if (cleanCategory) query = query.ilike("category", `%${cleanCategory}%`);
      const { data, error: loadError, count } = await query;
      if (loadError) throw loadError;
      rows = (data || []) as Business[];
      total = Number(count || rows.length);
    } else {
      const matched: Business[] = [];
      for (let offset = 0; ; offset += COUNTRY_SCAN_PAGE_SIZE) {
        let query = contactableStatusQuery(
          supabase.from("businesses").select("*")
            .eq("workspace_id", workspace.id).not("email", "is", null).neq("email", "")
            .order("updated_at", { ascending: true }).range(offset, offset + COUNTRY_SCAN_PAGE_SIZE - 1),
        );
        if (cleanSearch) query = query.or(`name.ilike.%${cleanSearch}%,email.ilike.%${cleanSearch}%,domain.ilike.%${cleanSearch}%,website.ilike.%${cleanSearch}%`);
        if (audienceCategoryId) query = query.eq("category_id", audienceCategoryId);
        else if (cleanCategory) query = query.ilike("category", `%${cleanCategory}%`);
        const { data, error: loadError } = await query;
        if (loadError) throw loadError;
        if (requestId !== readyContactsRequestRef.current) return;
        const pageRows = (data || []) as Business[];
        const pageMatches = applyLocationFilter(pageRows, cleanCountry);
        total += pageMatches.length;
        for (const row of pageMatches) {
          if (matched.length < READY_PAGE_SIZE) matched.push(row);
        }
        if (pageRows.length < COUNTRY_SCAN_PAGE_SIZE) break;
      }
      rows = matched;
    }
    if (requestId !== readyContactsRequestRef.current) return;
    let selected: Record<string, boolean> = {};
    if (targetBusinessId) {
      const { data: target, error: targetError } = await supabase.from("businesses").select("*")
        .eq("workspace_id", workspace.id).eq("id", targetBusinessId).maybeSingle();
      if (targetError) throw targetError;
      if (target?.email) {
        rows = [target as Business, ...rows.filter((business) => business.id !== target.id)].slice(0, READY_PAGE_SIZE);
        selected = { [target.id]: true };
        setStatus(`Loaded selected business: ${target.name || target.email}.`);
      }
    }
    if (requestId !== readyContactsRequestRef.current) return;
    setReadyContacts(rows); setReadyTotal(total || rows.length); setSelectedContacts(selected);
    if (!rows.length && cleanCountry) setStatus(`No contactable emails matched ${cleanCountry}. Try All countries or run Repair Ready Contacts.`);
  }

  async function loadRecentSent() {
    const { data } = await supabase
      .from("sent_messages")
      .select("id,status,to_email,from_email,subject,sent_at")
      .eq("workspace_id", workspace.id)
      .order("sent_at", { ascending: false })
      .limit(80);
    setRecentSent((data || []) as SendLogRow[]);
  }

  async function fetchDueFollowUps(limitRows = 1000) {
    const { data, error: dueError } = await supabase.rpc("get_due_followups", {
      target_workspace: workspace.id,
      limit_rows: limitRows,
      followup_segment: followUpSegment,
    });
    if (dueError) {
      if (isMissingRpcFunction(dueError)) {
        setStatus(
          "Follow-up RPC is missing in Supabase. Run the v8.39 Supabase SQL once; the rest of Message page will still load.",
        );
        return [];
      }
      throw dueError;
    }
    return (data || []) as DueFollowUp[];
  }

  async function loadDueFollowUps() {
    setDueFollowUps(await fetchDueFollowUps(1000));
  }

  async function loadSchedules() {
    const { data, error: scheduleError } = await supabase
      .from("message_schedules")
      .select("*")
      .eq("workspace_id", workspace.id)
      .in("status", ["scheduled", "due", "running", "sent", "stopped", "cancelled", "failed", "complete", "completed"])
      .order("updated_at", { ascending: false })
      .limit(80);
    if (scheduleError) throw scheduleError;
    const rows = (data || []) as MessageSchedule[];
    setSchedules(rows);

    const latestJob = rows.find((row) => {
      const raw = (row.raw || {}) as Record<string, unknown>;
      return raw.durable_job === true || row.run_kind === "manual_now";
    });
    if (latestJob) {
      const requested = Math.max(0, Number(latestJob.target_count || 0));
      const attempted = Math.max(0, Number(latestJob.processed_count || 0));
      const sent = Math.max(0, Number(latestJob.sent_count || 0));
      const failed = Math.max(0, Number(latestJob.failed_count || 0));
      const skipped = Math.max(0, Number(latestJob.skipped_count || 0));
      setSummary({
        requested,
        attempted,
        sent,
        failed,
        skipped,
        stopped: ["stopped", "cancelled", "failed"].includes(String(latestJob.status || "")),
      });
      setProgress(requested > 0 ? Math.min(100, Math.round((attempted / requested) * 100)) : 0);
    }
  }

  async function refreshAll() {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setLoading(true); setError("");
    try {
      const critical = await Promise.allSettled([loadCategories(), loadTemplates(), loadAccounts()]);
      const secondary = await Promise.allSettled([loadReadyContacts(), loadRecentSent(), loadDueFollowUps(), loadSchedules()]);
      const failures = [...critical, ...secondary]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => formatError(result.reason));
      if (failures.length) {
        setStatus(`Message page loaded with ${failures.length} temporary data warning${failures.length === 1 ? "" : "s"}. Sending controls remain available.`);
        setError(failures.slice(0, 2).join(" | "));
      } else setStatus("Loaded Message workspace.");
    } finally { refreshInFlightRef.current = false; setLoading(false); }
  }

  useEffect(() => {
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id]);

  useEffect(() => {
    if (!workspace.id) return;
    const timer = window.setTimeout(() => loadAvailableLocations().catch((err) => setError(formatError(err))), 350);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, audienceCategoryId, businessCategoryFilter]);

  useEffect(() => {
    const first =
      templates.find((t) => t.category_id === categoryId) || templates[0];
    if (
      first &&
      !templates.some(
        (t) =>
          t.id === templateId && (!categoryId || t.category_id === categoryId),
      )
    )
      setTemplateId(first.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryId, templates.length]);

  useEffect(() => {
    if (!workspace.id) return;
    loadDueFollowUps().catch((err) => setError(formatError(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followUpSegment]);

  useEffect(() => {
    if (!workspace.id) return;
    let accountTick = 0;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || busy || loading) return;
      void Promise.allSettled([loadSchedules(), loadRecentSent()]);
      accountTick += 1;
      if (accountTick >= 4) { accountTick = 0; loadAccounts().catch(() => undefined); }
    }, 30000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, busy, loading]);

  useEffect(() => {
    if (!workspace.id || !autoRunSchedules) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (busy || loading || scheduleRunnerBusy || scheduleRunnerRef.current) return;
      const now = Date.now();
      const hasDueSchedule = schedules.some(
        (schedule) =>
          String(schedule.status || "") === "scheduled" &&
          new Date(schedule.scheduled_for).getTime() <= now,
      );
      if (hasDueSchedule) runDueSchedulesFromApp({ silent: true }).catch(() => undefined);
    }, SCHEDULE_RUNNER_INTERVAL_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, autoRunSchedules, busy, loading, scheduleRunnerBusy, schedules]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setNotificationPermission("Notification" in window ? Notification.permission : "unsupported");
    setScheduleReminderEnabled(window.localStorage.getItem(`scout_schedule_notifier_${workspace.id}`) === "1");
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
  }, [workspace.id]);

  useEffect(() => {
    if (!workspace.id || !scheduleReminderEnabled) return;
    if (typeof window === "undefined") return;
    for (const schedule of dueSchedules) {
      const key = `scout_due_notified_${workspace.id}_${schedule.id}`;
      if (dueReminderRef.current.has(schedule.id) || window.localStorage.getItem(key)) continue;
      dueReminderRef.current.add(schedule.id);
      window.localStorage.setItem(key, "1");
      notifyScheduleDue(schedule);
      emitLiveActivity({
        kind: "schedule",
        status: "due",
        title: "Schedule due",
        message: `${scheduleLabel(schedule)} is due now.`,
        createdAt: new Date().toISOString(),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, scheduleReminderEnabled, schedules]);

  async function enableScheduleNotifier() {
    if (typeof window === "undefined" || !("Notification" in window)) {
      setNotificationPermission("unsupported");
      setStatus("This browser does not support browser notifications. Use the phone reminder button instead.");
      return;
    }
    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
    if (permission === "granted") {
      setScheduleReminderEnabled(true);
      window.localStorage.setItem(`scout_schedule_notifier_${workspace.id}`, "1");
      setStatus("Notifier is on while Scout is open. For phone alerts when Scout is closed, add a phone reminder.");
    } else {
      setScheduleReminderEnabled(false);
      window.localStorage.setItem(`scout_schedule_notifier_${workspace.id}`, "0");
      setStatus("Browser notification permission was not granted. Use phone/calendar reminder instead.");
    }
  }

  function notifyScheduleDue(schedule: MessageSchedule) {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    const notification = new Notification("Scout schedule is due", {
      body: `${scheduleLabel(schedule)} is ready. Open Scout and click Run Due Sends Now.`,
      icon: "/icon-192.png",
      tag: `scout-schedule-${schedule.id}`,
    });
    notification.onclick = () => {
      window.focus();
      window.location.href = "/message";
    };
  }

  function downloadScheduleReminder(schedule: MessageSchedule) {
    if (typeof window === "undefined") return;
    const start = new Date(schedule.scheduled_for);
    if (Number.isNaN(start.getTime())) {
      setError("This schedule has an invalid date/time.");
      return;
    }
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    const appUrl = `${workspace.app_url || window.location.origin}/message`;
    const title = `Scout schedule due: ${scheduleLabel(schedule)}`;
    const description = `Open Scout and run due sends. Schedule type: ${schedule.type}. Count: ${Number(schedule.target_count || 0)}. URL: ${appUrl}`;
    const nativePayload = {
      id: schedule.id,
      title,
      body: description,
      url: appUrl,
      triggerAt: Math.max(Date.now() + 60 * 1000, start.getTime() - 5 * 60 * 1000),
    };

    const nativeBridge = (window as unknown as { ScoutNative?: { scheduleReminder?: (payload: string) => void } }).ScoutNative;
    if (nativeBridge?.scheduleReminder) {
      nativeBridge.scheduleReminder(JSON.stringify(nativePayload));
      setStatus("Phone reminder saved inside the Scout Android app. Your phone will alert you before the schedule is due.");
      return;
    }

    const iosBridge = (window as unknown as { webkit?: { messageHandlers?: { ScoutNative?: { postMessage?: (payload: unknown) => void } } } }).webkit?.messageHandlers?.ScoutNative;
    if (iosBridge?.postMessage) {
      iosBridge.postMessage(nativePayload);
      setStatus("Phone reminder saved inside the Scout iOS app. Your phone will alert you before the schedule is due.");
      return;
    }

    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Scout//Schedule Reminder//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      `UID:scout-${schedule.id}@scout-app`,
      `DTSTAMP:${toIcsDate(new Date())}`,
      `DTSTART:${toIcsDate(start)}`,
      `DTEND:${toIcsDate(end)}`,
      `SUMMARY:${safeIcsText(title)}`,
      `DESCRIPTION:${safeIcsText(description)}`,
      `URL:${safeIcsText(appUrl)}`,
      "BEGIN:VALARM",
      "TRIGGER:-PT5M",
      "ACTION:DISPLAY",
      `DESCRIPTION:${safeIcsText(title)}`,
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `scout-schedule-${schedule.id}.ics`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus("Phone/calendar reminder downloaded. Open it on your phone or desktop calendar and save it.");
  }

  function clearScheduleReminder(schedule: MessageSchedule) {
    dueReminderRef.current.delete(schedule.id);
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(`scout_due_notified_${workspace.id}_${schedule.id}`);
    }
  }

  function templatesForSend(kind: MessageKind = "initial") {
    if (kind === "follow_up") {
      if (currentFollowUpTemplate && currentFollowUpTemplate.active !== false) return [currentFollowUpTemplate];
      return followUpTemplates.length
        ? followUpTemplates.slice(0, 1)
        : allFollowUpTemplates.slice(0, 1);
    }

    // Initial-message sending must never rotate or select follow-up/reply templates.
    const scoped = categoryTemplates;
    const allAllowed = sendableTemplates;
    if (templateMode === "rotate") return scoped.length ? scoped : allAllowed;
    if (currentTemplate && currentTemplate.active !== false) return [currentTemplate];
    return scoped.length ? scoped.slice(0, 1) : allAllowed.slice(0, 1);
  }

  function accountsForSend() {
    if (senderMode === "specific")
      return connectedAccounts.filter((a) => a.id === specificSenderId);
    return connectedAccounts.filter((a) => selectedAccounts[a.id]);
  }

  function senderCap(account: GmailAccount) {
    const raw = senderRunLimits[account.id];
    let runCap = Number.POSITIVE_INFINITY;
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      const defaultLimit = Number(account.default_run_limit || 50);
      runCap = Number.isFinite(defaultLimit) && defaultLimit > 0 ? Math.floor(defaultLimit) : 50;
    } else {
      const parsed = Number(raw);
      runCap = !Number.isFinite(parsed) || parsed <= 0 ? 50 : Math.floor(parsed);
    }
    const remaining = senderRemainingToday(account);
    return Math.max(0, Math.min(runCap, remaining));
  }

  function describeSenderCaps(accountsToUse: GmailAccount[]) {
    return accountsToUse
      .map(
        (account) =>
          `${account.email}: ${Number.isFinite(senderCap(account)) ? senderCap(account).toLocaleString() : "auto"}`,
      )
      .join(" · ");
  }


  async function buildNoContactDiagnostic(messageKind: MessageKind) {
    try {
      const cleanCategory = businessCategoryFilter.trim().replace(/[%_]/g, "");
      const cleanCountry = countryFilter.trim().replace(/[%_]/g, "");
      const cleanSearch = readySearch.trim().replace(/[%_]/g, "");
      const [{ count: totalWithEmail }, { count: contactableWithEmail }] = await Promise.all([
        supabase
          .from("businesses")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", workspace.id)
          .not("email", "is", null)
          .neq("email", ""),
        contactableStatusQuery(
          supabase
            .from("businesses")
            .select("id", { count: "exact", head: true })
            .eq("workspace_id", workspace.id)
            .not("email", "is", null)
            .neq("email", ""),
        ),
      ]);

      let filteredBeforeLocation = 0;
      let locationMatched = 0;
      for (let offset = 0; ; offset += COUNTRY_SCAN_PAGE_SIZE) {
        let filteredQuery = contactableStatusQuery(
          supabase
            .from("businesses")
            .select("id,location,raw,email,status,category,category_id,name,domain,website")
            .eq("workspace_id", workspace.id)
            .not("email", "is", null)
            .neq("email", "")
            .range(offset, offset + COUNTRY_SCAN_PAGE_SIZE - 1),
        );
        if (cleanSearch) filteredQuery = filteredQuery.or(`name.ilike.%${cleanSearch}%,email.ilike.%${cleanSearch}%,domain.ilike.%${cleanSearch}%,website.ilike.%${cleanSearch}%`);
        if (audienceCategoryId) filteredQuery = filteredQuery.eq("category_id", audienceCategoryId);
        else if (cleanCategory) filteredQuery = filteredQuery.ilike("category", `%${cleanCategory}%`);
        const { data: filteredRows, error: filteredError } = await filteredQuery;
        if (filteredError) throw filteredError;
        const pageRows = (filteredRows || []) as Business[];
        filteredBeforeLocation += pageRows.length;
        locationMatched += cleanCountry
          ? applyLocationFilter(pageRows, cleanCountry).length
          : pageRows.length;
        if (pageRows.length < COUNTRY_SCAN_PAGE_SIZE) break;
      }
      const pieces = [
        messageKind === "follow_up" ? "No due follow-up contacts found." : "No contactable leads found for this send.",
        `${Number(totalWithEmail || 0).toLocaleString()} total lead(s) have an email.`,
        `${Number(contactableWithEmail || 0).toLocaleString()} have a contactable status: ${CONTACTABLE_BUSINESS_STATUSES.join(", ")}.`,
      ];
      if (audienceCategoryId || cleanCategory || cleanSearch) pieces.push(`${Number(filteredBeforeLocation).toLocaleString()} match your audience/category/search filters before location.`);
      if (cleanCountry) pieces.push(`${locationMatched.toLocaleString()} match the selected country: ${cleanCountry}.`);
      pieces.push("Use All countries, clear search/category filters, or run Auto Scout/Repair Ready Contacts if the email exists but is not marked contactable.");
      return pieces.join(" ");
    } catch {
      return messageKind === "follow_up"
        ? "No due follow-up contacts with email found."
        : "No contactable leads with email found. Clear filters or run Auto Scout/Repair Ready Contacts.";
    }
  }

  async function filterTeamSendableContacts(candidates: Business[]) {
    if (!candidates.length) return { allowed: [] as Business[], blocked: 0 };

    const businessKeys = new Map<string, string[]>();
    const allKeys = new Set<string>();
    for (const business of candidates) {
      const keys = businessIdentityKeys(business as any);
      businessKeys.set(business.id, keys);
      for (const key of keys) allKeys.add(key);
    }
    if (!allKeys.size) return { allowed: candidates, blocked: 0 };

    const blockedKeys = new Set<string>();
    const keys = Array.from(allKeys);
    const pageSize = 1000;
    for (let index = 0; index < keys.length; index += pageSize) {
      const { data, error: guardError } = await supabase.rpc('team_duplicate_keys', {
        input_keys: keys.slice(index, index + pageSize),
        target_workspace: workspace.id
      });
      if (guardError) {
        const message = formatError(guardError);
        if (message.toLowerCase().includes('team_duplicate_keys')) {
          throw new Error('Team duplicate protection is not installed. Run RUN_THIS_SQL_ONCE_V10_32.sql once.');
        }
        throw guardError;
      }
      for (const row of data || []) blockedKeys.add(String((row as any).normalized_key || ''));
    }

    const isBlocked = (business: Business) => (businessKeys.get(business.id) || []).some((key) => blockedKeys.has(key));
    return {
      allowed: candidates.filter((business) => !isBlocked(business)),
      blocked: candidates.filter(isBlocked).length
    };
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
      for (const business of applyLocationFilter(selected, countryFilter)) {
        const key = normalizeEmail(business.email);
        if (key && !unique.has(key)) unique.set(key, business);
      }
      const guarded = await filterTeamSendableContacts(
        Array.from(unique.values()).slice(0, limit),
      );
      if (guarded.blocked > 0) {
        setStatus(
          `${guarded.blocked.toLocaleString()} lead${guarded.blocked === 1 ? " was" : "s were"} blocked because another Scout user in this deployment owns the business or email.`,
        );
      }
      return guarded.allowed;
    }
    const cleanSearch = readySearch.trim().replace(/[%_]/g, "");
    const cleanCategory = businessCategoryFilter.trim().replace(/[%_]/g, "");
    const cleanCountry = countryFilter.trim().replace(/[%_]/g, "");
    if (!cleanCountry) {
      let query = contactableStatusQuery(
        supabase
          .from("businesses")
          .select("*")
          .eq("workspace_id", workspace.id)
          .not("email", "is", null)
          .neq("email", "")
          .order("updated_at", { ascending: true })
          .limit(limit),
      );
      if (cleanSearch)
        query = query.or(
          `name.ilike.%${cleanSearch}%,email.ilike.%${cleanSearch}%,domain.ilike.%${cleanSearch}%,website.ilike.%${cleanSearch}%`,
        );
      if (audienceCategoryId) query = query.eq("category_id", audienceCategoryId);
      else if (cleanCategory) query = query.ilike("category", `%${cleanCategory}%`);
      const { data, error: loadError } = await query;
      if (loadError) throw loadError;
      for (const business of (data || []) as Business[]) {
        const key = normalizeEmail(business.email);
        if (key && !unique.has(key)) unique.set(key, business);
      }
    } else {
      for (let offset = 0; unique.size < limit; offset += COUNTRY_SCAN_PAGE_SIZE) {
        let query = contactableStatusQuery(
          supabase
            .from("businesses")
            .select("*")
            .eq("workspace_id", workspace.id)
            .not("email", "is", null)
            .neq("email", "")
            .order("updated_at", { ascending: true })
            .range(offset, offset + COUNTRY_SCAN_PAGE_SIZE - 1),
        );
        if (cleanSearch)
          query = query.or(
            `name.ilike.%${cleanSearch}%,email.ilike.%${cleanSearch}%,domain.ilike.%${cleanSearch}%,website.ilike.%${cleanSearch}%`,
          );
        if (audienceCategoryId) query = query.eq("category_id", audienceCategoryId);
        else if (cleanCategory) query = query.ilike("category", `%${cleanCategory}%`);
        const { data, error: loadError } = await query;
        if (loadError) throw loadError;
        const pageRows = (data || []) as Business[];
        for (const business of applyLocationFilter(pageRows, cleanCountry)) {
          const key = normalizeEmail(business.email);
          if (key && !unique.has(key)) unique.set(key, business);
          if (unique.size >= limit) break;
        }
        if (pageRows.length < COUNTRY_SCAN_PAGE_SIZE) break;
      }
    }
    const guarded = await filterTeamSendableContacts(
      Array.from(unique.values()).slice(0, limit),
    );
    if (guarded.blocked > 0) {
      setStatus(
        `${guarded.blocked.toLocaleString()} lead${guarded.blocked === 1 ? " was" : "s were"} blocked because another Scout user in this deployment owns the business or email.`,
      );
    }
    return guarded.allowed;
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

  function templateAttachments(template: MessageTemplate) {
    const direct = Array.isArray((template as any).attachments) ? ((template as any).attachments as any[]) : [];
    const raw = (template as any).raw && Array.isArray((template as any).raw.attachments) ? ((template as any).raw.attachments as any[]) : [];
    return direct.length ? direct : raw;
  }

  function buildContactPayload(
    business: Business,
    template: MessageTemplate,
    index: number,
  ) {
    const localized = resolveTemplateContent(template, business);
    const subjects = splitSubjects(localized.subject, localized.subjectVariants);
    return {
      id: business.id,
      businessId: business.id,
      name: business.name || "",
      businessName: business.name || "",
      email: normalizeEmail(business.email),
      subject: renderTemplate(
        subjects[index % Math.max(1, subjects.length)] || localized.subject,
        business,
      ),
      message: renderTemplate(localized.message, business),
      templateId: template.id,
      templateName: template.name,
      categoryId: template.category_id || "",
      categoryName: template.category_name || "",
      attachments: templateAttachments(template),
      website: business.website || "",
      domain: business.domain || getDomain(business),
      source: business.source || "scout_v1031",
      language: localized.language,
      languageLabel: localized.languageLabel,
      detectedLanguage: localized.detectedLanguage,
      usedLanguageFallback: localized.usedFallback,
    };
  }

  async function markSenderPaused(
    account: GmailAccount,
    reason: string,
    pausedUntil?: string,
  ) {
    const until = pausedUntil || toDateTomorrow();
    const rich = await supabase
      .from("gmail_accounts")
      .update({ status: "limit_hit", paused_until: until, is_paused: true, paused_reason: reason, last_error: reason, updated_at: new Date().toISOString() } as any)
      .eq("workspace_id", workspace.id)
      .eq("id", account.id);
    if (rich.error) {
      await supabase
        .from("gmail_accounts")
        .update({ status: "limit_hit", paused_until: until, last_error: reason, updated_at: new Date().toISOString() } as any)
        .eq("workspace_id", workspace.id)
        .eq("id", account.id);
    }
    setSelectedAccounts((current) => ({ ...current, [account.id]: false }));
    setAccounts((current) => current.map((row) => row.id === account.id ? { ...row, status: "limit_hit", paused_until: until, last_error: reason, is_paused: true, paused_reason: reason } as GmailAccount : row));
  }

  async function logOutreachEvent(payload: Record<string, unknown>) {
    await supabase
      .from("outreach_events")
      .insert({ workspace_id: workspace.id, ...payload });
  }

  async function persistSendOutcome(params: {
    business: Business;
    template: MessageTemplate;
    account: GmailAccount;
    result: SendResult;
    batchId: string;
    subject: string;
    body: string;
    attachments?: any[];
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
      attachments,
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
      status: isSent ? "sent" : statusText || "failed",
      delivery_status: isSent ? "sent" : statusText || "failed",
      error_code: result.code || null,
      sent_at: sentAt,
      is_follow_up: !!isFollowUp,
      raw: {
        ...result,
        dry_run: isDryRun,
        follow_up: !!isFollowUp,
        template_language: resolveTemplateContent(template, business).language,
        detected_business_language: resolveBusinessLanguage(business),
        attachments: (attachments || []).map((a: any) => ({ name: a.name || a.filename, url: a.public_url || a.url }))
      },
    };
    const { error: insertError } = await supabase
      .from("sent_messages")
      .insert(row);
    if (insertError) throw insertError;
    if (isSent && !isDryRun) {
      await supabase
        .from("businesses")
        .update({ status: "contacted", updated_at: sentAt })
        .eq("workspace_id", workspace.id)
        .eq("id", business.id);
    }
  }

  async function startDurableSendJob(
    contactsOverride?: Business[],
    options?: {
      isFollowUp?: boolean;
      limit?: number;
      messageKind?: MessageKind;
      followupSegment?: string;
      allDueFollowUps?: boolean;
    },
  ) {
    const messageKind: MessageKind =
      options?.messageKind || (options?.isFollowUp ? "follow_up" : "initial");
    const templatePool = templatesForSend(messageKind);
    const senders = accountsForSend();
    if (!templatePool.length)
      throw new Error(
        messageKind === "follow_up"
          ? "Create/select at least one follow-up template first. Initial-message templates are no longer used for follow-ups."
          : "Create/select at least one initial-message template in Templates first.",
      );
    if (!senders.length)
      throw new Error("Select at least one connected sender first.");
    const guardBusiness =
      previewBusiness ||
      readyContacts[0] ||
      ({
        name: "there",
        email: "test@example.com",
        website: "",
        domain: "",
        category: "",
        location: "",
        source: "Scout",
      } as Business);
    const guardTemplate = templatePool[0];
    const guardSubject = renderTemplate(
      splitSubjects(guardTemplate.subject, guardTemplate.subject_variants)[0] ||
        guardTemplate.subject,
      guardBusiness,
    );
    const guardBody = renderTemplate(guardTemplate.message, guardBusiness);
    const guard = analyzeSpamRisk(guardSubject, guardBody);
    if (guard.level === "High" && !allowHighRiskSend && !dryRun)
      throw new Error(
        `Safety Check blocked this send because the template risk is HIGH (${guard.score}/100). Fix the template or tick the override checkbox.`,
      );

    const selectedBusinessIds = options?.allDueFollowUps
      ? []
      : contactsOverride?.length
        ? contactsOverride.map((b) => b.id).filter(Boolean)
        : selectedContactIds;
    const targetCount =
      selectedBusinessIds.length ||
      Math.max(
        1,
        Math.min(
          MAX_MESSAGE_BATCH_SIZE,
          Number(options?.limit || sendLimit || 1000),
        ),
      );
    const senderLimitsById = Object.fromEntries(
      senders.map((s) => [
        s.id,
        Number.isFinite(senderCap(s)) ? senderCap(s) : "auto",
      ]),
    );
    const senderLimitsByEmail = Object.fromEntries(
      senders.map((s) => [
        s.email,
        Number.isFinite(senderCap(s)) ? senderCap(s) : "auto",
      ]),
    );

    const { response, json } = await fetchJsonWithTimeout(
      "/api/message/start-job",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
        workspaceId: workspace.id,
        type: messageKind,
        categoryId,
        templateId:
          templateMode === "specific" ? templatePool[0]?.id || null : null,
        targetCount,
        scheduledFor: new Date().toISOString(),
        runNow: true,
        runKind: "manual_now",
        selectedBusinessIds,
        selectedSenderIds: senders.map((s) => s.id),
        selectedSenderEmails: senders.map((s) => s.email),
        templateMode,
        senderMode,
        senderRunLimits: { ...senderLimitsById, ...senderLimitsByEmail },
        businessCategoryFilter,
        countryFilter,
        locationFilter: countryFilter,
        audienceCategoryId,
        audienceCategoryName: selectedAudienceCategory?.name || "",
        readySearch,
        dryRun,
        allowHighRiskSend,
        delayMs,
        followupSegment: options?.followupSegment || followUpSegment,
        raw: {
          source: "message_page_durable_send",
          previous_client_loop_disabled: true,
          all_due_followups: Boolean(options?.allDueFollowUps),
          delay_ms: delayMs,
          parallel_per_sender: true,
          audience_category_id: audienceCategoryId || null,
          audience_category_name: selectedAudienceCategory?.name || null,
        },
        }),
      },
    );
    if (!response.ok || json?.success === false)
      throw new Error(
        json?.error || `Start job failed with HTTP ${response.status}`,
      );
    const scheduleId = json?.schedule?.id || "";
    setProgress(0);
    setSummary({
      requested: targetCount,
      attempted: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      stopped: false,
    });
    setSelectedContacts({});
    setStatus(
      `Durable ${messageKind === "follow_up" ? "follow-up" : "message"} job started for ${targetCount.toLocaleString()} contact(s). Scout will continue in the background. Job: ${scheduleId}`,
    );
    await Promise.allSettled([loadSchedules(), loadRecentSent(), loadAccounts()]);
  }

  async function sendBatch(
    contactsOverride?: Business[],
    options?: {
      isFollowUp?: boolean;
      limit?: number;
      messageKind?: MessageKind;
      followupSegment?: string;
    },
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
      // v8.48: Send Now uses the proven immediate sender again.
      // It does not use cron. Send Now runs directly from this open page.
      const messageKind: MessageKind =
        options?.messageKind || (options?.isFollowUp ? "follow_up" : "initial");
      const templatePool = templatesForSend(messageKind);
      if (!templatePool.length)
        throw new Error(
          messageKind === "follow_up"
            ? "Create/select at least one follow-up template first. Initial-message templates are no longer used for follow-ups."
            : "Create/select at least one initial-message template in Templates first.",
        );
      let activeAccounts = accountsForSend();
      if (!activeAccounts.length)
        throw new Error(
          "Connect Gmail in Settings, then select at least one connected sender here.",
        );
      const guardBusiness =
        previewBusiness ||
        readyContacts[0] ||
        ({
          name: "there",
          email: "test@example.com",
          website: "",
          domain: "",
          category: "",
          location: "",
          source: "Scout",
        } as Business);
      const guardTemplate = templatePool[0];
      const guardSubject = renderTemplate(
        splitSubjects(
          guardTemplate.subject,
          guardTemplate.subject_variants,
        )[0] || guardTemplate.subject,
        guardBusiness,
      );
      const guardBody = renderTemplate(guardTemplate.message, guardBusiness);
      const guard = analyzeSpamRisk(guardSubject, guardBody);
      if (guard.level === "High" && !allowHighRiskSend && !dryRun) {
        throw new Error(
          `Safety Check blocked this send because the template risk is HIGH (${guard.score}/100). Fix the template or tick the override checkbox.`,
        );
      }
      const totalRequested = Math.max(
        1,
        Math.min(
          MAX_MESSAGE_BATCH_SIZE,
          Number(options?.limit || sendLimit || 1000),
        ),
      );
      const finiteCapSum = activeAccounts.reduce(
        (sum, account) =>
          sum + (Number.isFinite(senderCap(account)) ? senderCap(account) : 0),
        0,
      );
      const everySenderCapped = activeAccounts.every((account) =>
        Number.isFinite(senderCap(account)),
      );
      const effectiveLimit = everySenderCapped
        ? Math.min(totalRequested, finiteCapSum || totalRequested)
        : totalRequested;
      const contacts = await getContactsForSend(
        effectiveLimit,
        contactsOverride,
      );
      if (!contacts.length) {
        const diagnostic = await buildNoContactDiagnostic(messageKind);
        throw new Error(diagnostic);
      }

      const batchId = `scout_v830_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
            sender_run_limits: Object.fromEntries(
              activeAccounts.map((a) => [
                a.email,
                Number.isFinite(senderCap(a)) ? senderCap(a) : "auto",
              ]),
            ),
            dryRun,
            delayMs,
            templateMode,
            senderMode,
            categoryId,
            businessCategoryFilter,
            countryFilter,
            locationFilter: countryFilter,
            locationFilterMode: "country_only_from_uploaded_fields",
            messageKind,
            isFollowUp: !!options?.isFollowUp,
            followupSegment: options?.followupSegment || null,
          },
        });
      if (batchError) throw batchError;

      const rowsForDownload: Array<Record<string, unknown>> = [];
      let cursor = 0;
      const sentBySender: Record<string, number> = Object.fromEntries(
        activeAccounts.map((a) => [a.id, 0]),
      );
      let attempted = 0;
      let sent = 0;
      let failed = 0;
      let skipped = 0;
      let stopped = false;
      const requested = contacts.length;
      setStatus(
        `Sending now: 0 / ${requested.toLocaleString()} started. Keep Scout open until it finishes.`,
      );
      emitLiveActivity({
        kind: "send",
        status: "started",
        title: "Send started",
        message: `Starting ${requested.toLocaleString()} email(s).`,
        countText: `0 / ${requested.toLocaleString()}`
      });

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
        const eligibleAccounts = activeAccounts.filter(
          (account) => (sentBySender[account.id] || 0) < senderCap(account),
        );
        if (!eligibleAccounts.length) {
          stopped = true;
          skipped += contacts.length - i;
          setStatus(
            "All selected Gmail senders reached their run caps or were paused. Remaining contacts stayed Ready.",
          );
          break;
        }
        const account =
          senderMode === "specific"
            ? eligibleAccounts[0]
            : eligibleAccounts[cursor % eligibleAccounts.length];
        const template =
          templateMode === "specific"
            ? templatePool[0]
            : templatePool[i % templatePool.length];
        cursor += 1;
        const payload = buildContactPayload(business, template, i);
        attempted += 1;
        setStatus(
          `Sending now ${attempted.toLocaleString()} / ${requested.toLocaleString()} · ${account.email} → ${payload.email}`,
        );
        emitLiveActivity({
          kind: "send",
          status: "sending",
          title: "Sending message",
          message: `Sending message to ${payload.email}`,
          toEmail: payload.email,
          fromEmail: account.email,
          businessName: business.name || "",
          countText: `${attempted.toLocaleString()} / ${requested.toLocaleString()}`
        });

        const response = await fetch("/api/gmail/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            workspace_id: workspace.id,
            business_id: business.id,
            gmail_account_id: account.id,
            to: payload.email,
            subject: payload.subject,
            body: payload.message,
            attachments: payload.attachments,
            dryRun,
          }),
        });
        const json = await response.json().catch(() => ({}));
        const result = ((json?.results || [])[0] || {}) as SendResult;
        const statusText = String(
          result.status || (json?.success ? "sent" : "failed"),
        ).toLowerCase();
        const limitHit = isLimitPayload(json, result);
        const teamDuplicateBlocked =
          String(json?.code || result.code || "").toLowerCase() ===
            "team_duplicate_blocked" ||
          String(result.status || "").toLowerCase() ===
            "team_duplicate_blocked";

        if (teamDuplicateBlocked) {
          const reason =
            json?.error ||
            result.reason ||
            "Blocked because this lead already belongs to another Scout user in this deployment.";
          skipped += 1;
          rowsForDownload.push({
            business: business.name,
            email: business.email,
            sender: account.email,
            template: template.name,
            status: "team_duplicate_blocked",
            reason,
          });
          await logOutreachEvent({
            batch_id: batchId,
            business_id: business.id,
            gmail_account_id: account.id,
            template_id: template.id,
            type: "team_duplicate_blocked",
            message: reason,
            raw: json,
          });
          emitLiveActivity({
            kind: "send",
            status: "skipped",
            title: "Team duplicate blocked",
            message: `${payload.email} was not sent because another Scout user in this deployment owns the lead.`,
            toEmail: payload.email,
            fromEmail: account.email,
            businessName: business.name || "",
            countText: `${attempted.toLocaleString()} / ${requested.toLocaleString()}`,
          });
          continue;
        }

        if (json?.access_token) {
          await supabase
            .from("gmail_accounts")
            .update({ access_token: json.access_token })
            .eq("workspace_id", workspace.id)
            .eq("id", account.id);
          account.access_token = json.access_token;
        }

        if (limitHit) {
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
          emitLiveActivity({
            kind: "send",
            status: "paused",
            title: "Sender limit reached",
            message: `${account.email} was paused before sending to ${payload.email}.`,
            toEmail: payload.email,
            fromEmail: account.email,
            businessName: business.name || "",
            countText: `${attempted.toLocaleString()} / ${requested.toLocaleString()}`
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
          const blocked = isBlockedPayload(json, result);
          const failedStatus = blocked ? "message_blocked" : "failed";
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
            status: failedStatus,
            reason,
          });
          await persistSendOutcome({
            business,
            template,
            account,
            result: {
              ...result,
              status: failedStatus,
              reason,
              code: result.code || (blocked ? "message_blocked" : undefined),
            },
            batchId,
            subject: payload.subject,
            body: payload.message,
            attachments: payload.attachments,
            dryRun,
            isFollowUp: options?.isFollowUp,
          });
          await logOutreachEvent({
            batch_id: batchId,
            business_id: business.id,
            gmail_account_id: account.id,
            template_id: template.id,
            type: failedStatus,
            message: reason,
            raw: json,
          });
          emitLiveActivity({
            kind: "send",
            status: failedStatus,
            title: blocked ? "Message blocked" : "Send failed",
            message: `${payload.email}: ${reason}`,
            toEmail: payload.email,
            fromEmail: account.email,
            businessName: business.name || "",
            countText: `${attempted.toLocaleString()} / ${requested.toLocaleString()}`
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
            attachments: payload.attachments,
            dryRun,
            isFollowUp: options?.isFollowUp,
          });
          if (statusText === "sent") {
            sentBySender[account.id] = (sentBySender[account.id] || 0) + 1;
            if (senderCap(account) <= 0) {
              activeAccounts = activeAccounts.filter((a) => a.id !== account.id);
            }
            setStatus(
              `Message sent ${sent.toLocaleString()} / ${requested.toLocaleString()} · ${account.email} → ${payload.email}`,
            );
            emitLiveActivity({
              kind: "send",
              status: "sent",
              title: "Message sent",
              message: `Message sent to ${payload.email}`,
              toEmail: payload.email,
              fromEmail: account.email,
              businessName: business.name || "",
              countText: `${sent.toLocaleString()} sent · ${attempted.toLocaleString()} / ${requested.toLocaleString()}`
            });
          }
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
            attachments: payload.attachments,
            dryRun,
            isFollowUp: options?.isFollowUp,
          });
          emitLiveActivity({
            kind: "send",
            status: statusText || "skipped",
            title: "Message not sent",
            message: `${payload.email}: ${reason}`,
            toEmail: payload.email,
            fromEmail: account.email,
            businessName: business.name || "",
            countText: `${attempted.toLocaleString()} / ${requested.toLocaleString()}`
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
      emitLiveActivity({
        kind: "send",
        status: finalStatus,
        title: "Send finished",
        message: `Requested ${requested.toLocaleString()}, sent ${sent.toLocaleString()}, failed ${failed.toLocaleString()}, skipped ${skipped.toLocaleString()}.`,
        countText: `${sent.toLocaleString()} sent`
      });
      await Promise.all([
        loadReadyContacts(),
        loadAccounts(),
        loadRecentSent(),
        loadDueFollowUps(),
      ]);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  async function startSendNow() {
    if (busy) return;
    setBusy(true); setError(""); setProgress(0); setLastResults([]);
    try { await startDurableSendJob(undefined, { messageKind: "initial" }); }
    catch (err) { setError(formatError(err)); }
    finally { setBusy(false); }
  }

  async function saveSchedule() {
    setBusy(true);
    setError("");
    try {
      const templatePool = templatesForSend(scheduleType);
      const senders = accountsForSend();
      if (!templatePool.length)
        throw new Error("Create/select at least one template first.");
      if (!senders.length)
        throw new Error("Select at least one connected sender first.");
      const { data: insertedSchedule, error: insertError } = await supabase
        .from("message_schedules")
        .insert({
          workspace_id: workspace.id,
          type: scheduleType,
          category_id: categoryId || null,
          audience_category_id: audienceCategoryId || null,
          audience_category_name: selectedAudienceCategory?.name || null,
          template_id:
            templateMode === "specific" ? templatePool[0]?.id || null : null,
          target_count: Math.max(
            1,
            Math.min(
              MAX_MESSAGE_BATCH_SIZE,
              Number(scheduleCount || sendLimit || 1000),
            ),
          ),
          scheduled_for: new Date(scheduleFor).toISOString(),
          status: "scheduled",
          run_kind: "scheduled",
          followup_segment:
            scheduleType === "follow_up" ? followUpSegment : null,
          raw: {
            audience_category_id: audienceCategoryId || null,
            audience_category_name: selectedAudienceCategory?.name || null,
            business_category_filter: businessCategoryFilter,
            country_filter: countryFilter,
            location_filter: countryFilter,
            location_filter_mode: "uploaded_list_multi_field",
            followup_segment:
              scheduleType === "follow_up" ? followUpSegment : null,
            template_mode: templateMode,
            sender_mode: senderMode,
            selected_sender_ids: senders.map((s) => s.id),
            selected_sender_emails: senders.map((s) => s.email),
            sender_run_limits: Object.fromEntries(
              senders.map((s) => [
                s.email,
                Number.isFinite(senderCap(s)) ? senderCap(s) : "auto",
              ]),
            ),
            delay_ms: delayMs,
            parallel_per_sender: true,
            dry_run: dryRun,
            allow_high_risk_send: allowHighRiskSend,
          },
        })
        .select("*")
        .single();
      if (insertError) throw insertError;
      if (insertedSchedule) setLastSavedSchedule(insertedSchedule as MessageSchedule);
      setStatus("Schedule saved. Saved. Keep Scout open when it is time to send, or add a phone reminder so your phone reminds you.");
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
      const templatePool = templatesForSend("follow_up");
      const senders = accountsForSend();
      if (!templatePool.length)
        throw new Error("Create/select at least one follow-up template first.");
      if (!senders.length)
        throw new Error("Select at least one connected sender first.");
      const { data: insertedSchedule, error: insertError } = await supabase
        .from("message_schedules")
        .insert({
          workspace_id: workspace.id,
          type: "follow_up",
          category_id: categoryId || null,
          audience_category_id: audienceCategoryId || null,
          audience_category_name: selectedAudienceCategory?.name || null,
          template_id:
            templateMode === "specific" ? templatePool[0]?.id || null : null,
          target_count: dueFollowUps.length,
          scheduled_for: new Date(followUpFor).toISOString(),
          status: "scheduled",
          run_kind: "scheduled_follow_up",
          followup_segment: followUpSegment,
          raw: {
            due_mode: true,
            audience_category_id: audienceCategoryId || null,
            audience_category_name: selectedAudienceCategory?.name || null,
            followup_segment: followUpSegment,
            followup_after_hours: 72,
            due_business_ids: dueFollowUps.map((d) => d.business_id),
            template_mode: templateMode,
            sender_mode: senderMode,
            selected_sender_ids: senders.map((s) => s.id),
            selected_sender_emails: senders.map((s) => s.email),
            sender_run_limits: Object.fromEntries(
              senders.map((s) => [
                s.email,
                Number.isFinite(senderCap(s)) ? senderCap(s) : "auto",
              ]),
            ),
            delay_ms: delayMs,
            parallel_per_sender: true,
            dry_run: dryRun,
            allow_high_risk_send: allowHighRiskSend,
          },
        })
        .select("*")
        .single();
      if (insertError) throw insertError;
      if (insertedSchedule) setLastSavedSchedule(insertedSchedule as MessageSchedule);
      setStatus(
        `Saved due follow-up schedule.`,
      );
      await loadSchedules();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  async function getDueFollowUpBusinesses(
    limit = 1000,
    rowsOverride?: DueFollowUp[],
  ) {
    const rows = (rowsOverride || dueFollowUps).slice(0, limit);
    if (!rows.length) return [] as Business[];
    const ids = rows.map((r) => r.business_id);
    const { data, error: loadError } = await supabase
      .from("businesses")
      .select("*")
      .eq("workspace_id", workspace.id)
      .in("id", ids);
    if (loadError) throw loadError;
    const byId = new Map(
      ((data || []) as Business[]).map((business) => [business.id, business]),
    );
    const candidates = ids
      .map((id) => byId.get(id))
      .filter(Boolean) as Business[];
    const guarded = await filterTeamSendableContacts(candidates);
    if (guarded.blocked > 0) {
      setStatus(
        `${guarded.blocked.toLocaleString()} due follow-up${guarded.blocked === 1 ? " was" : "s were"} blocked because another Scout user in this deployment owns the lead.`,
      );
    }
    return guarded.allowed;
  }

  async function sendDueFollowUpsNow() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const { data: dueCountRaw, error: dueCountError } = await supabase.rpc("count_due_followups", {
        target_workspace: workspace.id,
        followup_segment: followUpSegment,
      });
      if (dueCountError) throw dueCountError;
      const dueCount = Math.max(0, Number(dueCountRaw || 0));
      if (!dueCount) throw new Error("No due follow-up contacts found.");
      await startDurableSendJob(undefined, {
        isFollowUp: true,
        limit: dueCount,
        messageKind: "follow_up",
        followupSegment: followUpSegment,
        allDueFollowUps: true,
      });
      setStatus(`All ${dueCount.toLocaleString()} due follow-ups were added to one background sending job. Scout will use its automatic sender delays.`);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  async function runDueSchedulesFromApp(options?: { silent?: boolean }) {
    if (scheduleRunnerRef.current) return { ran: 0, skipped: true };
    scheduleRunnerRef.current = true;
    setScheduleRunnerBusy(true);
    if (!options?.silent) {
      setBusy(true);
      setError("");
      setStatus("Checking saved sends that are due now...");
    }
    try {
      const { response, json } = await fetchJsonWithTimeout(
        "/api/message/run-schedules",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ limit: 1, workspaceId: workspace.id, source: "open_app_parallel_sender_runner" }),
        },
      );
      if (!response.ok || json?.success === false)
        throw new Error(
          json?.error || `Due schedule run failed with HTTP ${response.status}`,
        );
      const results = Array.isArray(json.results) ? json.results : [];
      const sent = results.reduce(
        (sum: number, row: any) => sum + Number(row.sent || 0),
        0,
      );
      const failed = results.reduce(
        (sum: number, row: any) => sum + Number(row.failed || 0),
        0,
      );
      const skipped = results.reduce(
        (sum: number, row: any) => sum + Number(row.skipped || 0),
        0,
      );
      if (Number(json.ran || 0) > 0 || !options?.silent) {
        setStatus(
          Number(json.ran || 0) > 0
            ? `Due send processed ${Number(json.ran || 0)} schedule(s). Sent ${sent}, failed ${failed}, skipped ${skipped}. Keep Scout open while it sends.`
            : "No due schedules right now.",
        );
      }
      await Promise.allSettled([loadSchedules(), loadRecentSent(), loadAccounts()]);
      if (results.some((row: any) => ["sent", "failed"].includes(String(row?.status || "")))) {
        void Promise.allSettled([loadReadyContacts(), loadDueFollowUps()]);
      }
      return json;
    } catch (err) {
      if (!options?.silent) setError(formatError(err));
      else setStatus(`Due send check failed: ${formatError(err)}`);
      return { ran: 0, error: formatError(err) };
    } finally {
      scheduleRunnerRef.current = false;
      setScheduleRunnerBusy(false);
      if (!options?.silent) setBusy(false);
    }
  }

  async function sendDueSchedulesNow() {
    await runDueSchedulesFromApp({ silent: false });
  }

  async function syncBlockedAndBounced() {
    const selected = accountsForSend();
    if (!selected.length)
      return setError("Select at least one connected sender first.");
    setBusy(true);
    setError("");
    try {
      let scanned = 0;
      let noInbox = 0;
      let blocked = 0;
      for (const account of selected) {
        setStatus(
          `Checking ${account.email} for bounces, no-inbox, and blocked-message notices...`,
        );
        const response = await fetch("/api/gmail/sync-bounces", {
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
            json?.error || `Bounce sync failed for ${account.email}`,
          );
        scanned += Number(json.scanned || 0);
        noInbox += Number(json.noInbox || 0);
        blocked += Number(json.blocked || 0);
      }
      setStatus(
        `Bounce/block sync finished. Scanned ${scanned}, no-inbox/bounce ${noInbox}, message-blocked ${blocked}.`,
      );
      await Promise.all([loadRecentSent(), loadDueFollowUps()]);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  function toggleAllContacts(value: boolean) {
    if (!value) return setSelectedContacts({});
    setSelectedContacts(
      Object.fromEntries(readyContacts.map((b) => [b.id, true])),
    );
  }

  function onCategoryChange(value: string) {
    setCategoryId(value);
    const firstInitial = templates.find((t) => t.category_id === value && (t.template_type || "initial") === "initial" && t.active !== false);
    const firstFollowUp = templates.find((t) => t.category_id === value && (t.template_type || "initial") === "follow_up" && t.active !== false);
    if (firstInitial) setTemplateId(firstInitial.id);
    if (firstFollowUp) setFollowUpTemplateId(firstFollowUp.id);
  }

  function senderCountLine(account: GmailAccount) {
    const sent = Number(senderLast24h[account.id] || 0);
    const limit = senderDailyLimit(account);
    return limit > 0
      ? `${sent.toLocaleString()} sent in last 24h / ${limit.toLocaleString()} daily limit`
      : `${sent.toLocaleString()} sent in last 24h`;
  }

  const activeSchedules = schedules.filter((s) => ["scheduled", "due", "running"].includes(String(s.status || "")) && !s.stop_requested);
  const stoppedSchedules = schedules.filter((s) => s.stop_requested || ["stopped", "cancelled", "failed", "complete", "completed"].includes(String(s.status || "")));
  const savedScheduleRows = schedules.slice(0, 40);

  function scheduleProgressText(schedule: MessageSchedule) {
    const target = Number(schedule.target_count || 0);
    const processed = Number(schedule.processed_count || 0);
    const sent = Number(schedule.sent_count || 0);
    const failed = Number(schedule.failed_count || 0);
    const skipped = Number(schedule.skipped_count || 0);
    const parts = [`${processed.toLocaleString()} / ${target.toLocaleString()} processed`, `${sent.toLocaleString()} sent`];
    if (failed) parts.push(`${failed.toLocaleString()} failed`);
    if (skipped) parts.push(`${skipped.toLocaleString()} skipped`);
    return parts.join(" · ");
  }

  async function continueSchedule(schedule: MessageSchedule) {
    setStopBusyId(schedule.id);
    setError("");
    try {
      const response = await fetch("/api/message/continue-schedule", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: workspace.id, scheduleId: schedule.id }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json?.success === false) throw new Error(json?.error || `Continue failed with HTTP ${response.status}`);
      setStatus("Sending is live. Scout will continue in the background using its automatic delays.");
      await loadSchedules();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setStopBusyId("");
    }
  }

  async function stopSchedule(schedule: MessageSchedule) {
    setStopBusyId(schedule.id);
    setError("");
    try {
      const response = await fetch("/api/message/stop-schedule", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: workspace.id, scheduleId: schedule.id }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json?.success === false) throw new Error(json?.error || `Stop failed with HTTP ${response.status}`);
      setStatus("Stopped and hidden from Live Work.");
      await loadSchedules();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setStopBusyId("");
    }
  }


  async function deleteSchedule(schedule: MessageSchedule) {
    if (!window.confirm('Delete this saved send from Scout?')) return;
    setStopBusyId(schedule.id);
    setError("");
    try {
      const response = await fetch("/api/message/delete-schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: workspace.id, scheduleId: schedule.id }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json?.success === false) throw new Error(json?.error || `Delete failed with HTTP ${response.status}`);
      setStatus("Saved send deleted.");
      await loadSchedules();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setStopBusyId("");
    }
  }

  async function deleteStoppedSchedules() {
    if (!window.confirm('Delete all stopped, failed, and finished saved sends?')) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/message/delete-schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: workspace.id, allStopped: true }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json?.success === false) throw new Error(json?.error || `Delete failed with HTTP ${response.status}`);
      setStatus("Old saved sends deleted.");
      await loadSchedules();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {error ? <div className="error">{error}</div> : null}
      {status ? <div className="success">{status}</div> : null}
      {busy || loading ? (
        <div className="progress-track">
          <div
            className="progress-fill"
            style={{ width: `${progress || (loading ? 30 : 0)}%` }}
          />
        </div>
      ) : null}

      <div className="notice">
        Ready to send: <strong>{readyTotal.toLocaleString()}</strong> · Connected senders: <strong>{connectedAccounts.length}</strong> · Due follow-ups: <strong>{dueFollowUps.length.toLocaleString()}</strong>
        <div className="actions" style={{ marginTop: 10 }}>
          <a className="btn secondary mini" href="#send-follow-ups">Send follow-ups</a>
          <span className="muted">Follow-ups are sent from the follow-up section on this same page. First-message sending only uses initial templates.</span>
        </div>
      </div>

      {activeSchedules.length ? (
        <div className="card" style={{ padding: 18 }}>
          <div className="actions" style={{ justifyContent: "space-between" }}>
            <h3 style={{ margin: 0 }}>A sending job is still live</h3>
            <div className="actions" style={{ gap: 6 }}>
              {stoppedSchedules.length ? <button className="btn secondary mini" type="button" onClick={deleteStoppedSchedules}>Clear stopped</button> : null}
              <button className="btn secondary mini" type="button" onClick={() => setShowSavedSends((v) => !v)}>{showSavedSends ? "Hide" : "Show"}</button>
            </div>
          </div>
          <p className="muted">Choose <strong>Continue sending</strong> to keep it live, or <strong>Stop sending</strong> to pause the remaining recipients. Closing Scout does not delete the job.</p>
          {showSavedSends ? <div className="table-wrap">
            <table>
              <thead><tr><th>Type</th><th>Status</th><th>Progress</th><th>Scheduled</th><th>Action</th></tr></thead>
              <tbody>
                {activeSchedules.slice(0, 6).map((job) => (
                  <tr key={`active-${job.id}`}>
                    <td>{job.type === "follow_up" ? "Follow-up" : "Initial"}</td>
                    <td>{job.status}</td>
                    <td>{scheduleProgressText(job)}{job.last_error ? <><br /><span className="error">{job.last_error}</span></> : null}</td>
                    <td>{new Date(job.scheduled_for).toLocaleString()}</td>
                    <td><div className="actions" style={{ gap: 6 }}><button className="btn" type="button" disabled={Boolean(stopBusyId)} onClick={() => continueSchedule(job)}>{stopBusyId === job.id ? "Working…" : "Continue sending"}</button><button className="btn secondary" type="button" disabled={Boolean(stopBusyId)} onClick={() => stopSchedule(job)}>{stopBusyId === job.id ? "Working…" : "Stop sending"}</button></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div> : null}
        </div>
      ) : null}

      <div className="card" style={{ padding: 18 }}>
        <h3>Choose who gets the email</h3>
        <p className="muted" style={{ marginTop: -4 }}>
          Choose the audience and matching template category.
        </p>
        <div className="grid grid-4">
          <div>
            <label className="label">Audience</label>
            <select
              className="select"
              value={audienceCategoryId}
              onChange={(e) => setAudienceCategoryId(e.target.value)}
            >
              <option value="">All audiences</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Location from uploaded list</label>
            <select
              className="select"
              value={countryFilter}
              onChange={(e) => setCountryFilter(e.target.value)}
            >
              <option value="">All countries</option>
              {locationOptions.map((location) => (
                <option key={location.value} value={location.value}>
                  {location.label}
                </option>
              ))}
            </select>
            <p className="muted" style={{ marginTop: 6, fontSize: 12 }}>
              Exact countries from your full Businesses list. Counts show ready-to-send leads and total leads.
            </p>
          </div>
          <div>
            <label className="label">Template category</label>
            <select
              className="select"
              value={categoryId}
              onChange={(e) => onCategoryChange(e.target.value)}
            >
              <option value="">All template categories</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">How many</label>
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
            <div className="notice" style={{ margin: 0 }}>
              <strong>Automatic — no setting needed</strong><br />
              The same Gmail waits a random 90–210 seconds after each successful email. Different Gmail accounts are spaced by a random 3–6 seconds. Users cannot shorten these safety delays.
            </div>
          </div>
        </div>

        <div className="grid grid-2" style={{ marginTop: 14 }}>
          <div className="card" style={{ padding: 14 }}>
            <h3>Initial message template</h3>
            <label className="checkbox-row">
              <input
                type="radio"
                checked={templateMode === "specific"}
                onChange={() => setTemplateMode("specific")}
              />{" "}
              Use one template
            </label>
            <label className="checkbox-row">
              <input
                type="radio"
                checked={templateMode === "rotate"}
                onChange={() => setTemplateMode("rotate")}
              />{" "}
              Rotate initial templates in this category
            </label>
            <select
              className="select"
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              disabled={templateMode === "rotate"}
            >
              <option value="">Select template</option>
              {(categoryId ? categoryTemplates : sendableTemplates).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <div className="actions" style={{ marginTop: 10 }}>
              <Link className="btn secondary" href="/templates">
                Manage Templates
              </Link>
            </div>
          </div>

          <div className="card" style={{ padding: 14 }}>
            <h3>Sender</h3>
            <label className="checkbox-row">
              <input
                type="radio"
                checked={senderMode === "specific"}
                onChange={() => setSenderMode("specific")}
              />{" "}
              Use one Gmail
            </label>
            <label className="checkbox-row">
              <input
                type="radio"
                checked={senderMode === "rotate"}
                onChange={() => setSenderMode("rotate")}
              />{" "}
              Rotate Gmail senders
            </label>
            {senderMode === "specific" ? (
              <select
                className="select"
                value={specificSenderId}
                onChange={(e) => setSpecificSenderId(e.target.value)}
              >
                <option value="">Select sender</option>
                {connectedAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.email} ·{" "}
                    {Number(senderLast24h[a.id] || 0).toLocaleString()} used today
                  </option>
                ))}
              </select>
            ) : (
              <div className="stack" style={{ gap: 8 }}>
                {connectedAccounts.map((a) => (
                  <div key={a.id} className="card" style={{ padding: 10 }}>
                    <label className="checkbox-row" style={{ margin: 0 }}>
                      <input
                        type="checkbox"
                        checked={!!selectedAccounts[a.id]}
                        onChange={(e) =>
                          setSelectedAccounts((cur) => ({
                            ...cur,
                            [a.id]: e.target.checked,
                          }))
                        }
                      />{" "}
                      {a.email}
                    </label>
                    <div className="grid grid-2" style={{ marginTop: 8 }}>
                      <div>
                        <label className="label">Max from this sender</label>
                        <input
                          className="input"
                          type="number"
                          min={1}
                          placeholder={`Settings default: ${Number(a.default_run_limit || 50).toLocaleString()}`}
                          value={senderRunLimits[a.id] || ""}
                          onChange={(e) =>
                            setSenderRunLimits((cur) => ({
                              ...cur,
                              [a.id]: e.target.value,
                            }))
                          }
                        />
                      </div>
                      <div>
                        <label className="label">Today's sending cap</label>
                        <div className="notice" style={{ color: "#86efac" }}>
                          {senderCountLine(a)} · run default{" "}
                          {Number(a.default_run_limit || 50).toLocaleString()}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {senderMode === "specific" && specificSenderId ? (
              <div style={{ marginTop: 10 }}>
                <label className="label">
                  Max from this sender
                </label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  placeholder={`Settings default: ${Number(connectedAccounts.find((a) => a.id === specificSenderId)?.default_run_limit || 50).toLocaleString()}`}
                  value={senderRunLimits[specificSenderId] || ""}
                  onChange={(e) =>
                    setSenderRunLimits((cur) => ({
                      ...cur,
                      [specificSenderId]: e.target.value,
                    }))
                  }
                />
              </div>
            ) : null}
            {!connectedAccounts.length ? (
              <div className="notice" style={{ marginTop: 10 }}>
                No connected senders.{" "}
                <Link href="/settings">Connect Gmail in Settings</Link>.
              </div>
            ) : null}
            <p className="muted" style={{ marginTop: 10 }}>
              Blank sender max uses the default limit in Settings.
            </p>
          </div>
        </div>

        <div className="actions" style={{ marginTop: 14 }}>
          <button
            className="btn"
            type="button"
            disabled={busy || loading}
            onClick={startSendNow}
          >
            Send Now
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
            onClick={() => setShowMoreOptions((v) => !v)}
          >
            {showMoreOptions ? "Hide extra buttons" : "More options"}
          </button>
        </div>
        {showMoreOptions ? (
          <div className="notice" style={{ marginTop: 12 }}>
            <div className="actions">
              <label className="checkbox-row" style={{ margin: 0 }}>
                <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} /> Test only, do not send
              </label>
              <label className="checkbox-row" style={{ margin: 0 }}>
                <input type="checkbox" checked={allowHighRiskSend} onChange={(e) => setAllowHighRiskSend(e.target.checked)} /> Allow risky template
              </label>
              <button className="btn secondary" type="button" disabled={busy || loading} onClick={repairReadyContacts}>Fix Lead Status</button>
              <button className="btn secondary" type="button" disabled={busy || loading} onClick={syncBlockedAndBounced}>Check Bad Inboxes</button>
              <button className="btn secondary" type="button" disabled={!lastResults.length} onClick={() => downloadCsv("scout-message-last-results.csv", lastResults)}>Download Result</button>
            </div>
          </div>
        ) : null}
      </div>

      {summary.requested || summary.attempted || summary.sent || summary.failed || summary.skipped ? (
        <div className="notice">Last send: requested <strong>{summary.requested}</strong>, attempted <strong>{summary.attempted}</strong>, sent <strong>{summary.sent}</strong>, failed/skipped <strong>{summary.failed + summary.skipped}</strong>.</div>
      ) : null}

      <div className="grid grid-2">
        <div className="card" style={{ padding: 18 }}>
          <div className="actions" style={{ justifyContent: "space-between", marginBottom: 12 }}>
            <h3 style={{ margin: 0 }}>Ready Leads</h3>
            <button className="btn secondary mini" type="button" onClick={() => setShowReadyLeads((v) => !v)}>{showReadyLeads ? "Hide" : "Show"}</button>
          </div>
          {showReadyLeads ? <>
          <div
            className="actions"
            style={{ justifyContent: "space-between", marginBottom: 12 }}
          >
            <span className="muted">Search or choose exact leads.</span>
            <div className="actions">
              <input
                className="input"
                style={{ width: 260 }}
                value={readySearch}
                onChange={(e) => setReadySearch(e.target.value)}
                placeholder="Search leads"
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
              Select shown leads
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
                  <th>Language</th>
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
                    <td>{(() => { const language = resolveBusinessLanguage(b); return <><span className="badge">{language.label}</span><br /><span className="muted" style={{ fontSize: 11 }}>{language.sourceLabel}</span></>; })()}</td>
                    <td>{b.category_name || b.category || "-"}</td>
                  </tr>
                ))}
                {!readyContacts.length ? (
                  <tr>
                    <td colSpan={5} className="muted">
                      No Ready contacts found.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          </> : <p className="muted">Hidden to keep this page simple.</p>}
        </div>

        <div className="card" style={{ padding: 18 }}>
          <div className="actions" style={{ justifyContent: "space-between" }}>
            <h3 style={{ margin: 0 }}>Preview</h3>
            <button className="btn secondary mini" type="button" onClick={() => setShowPreview((v) => !v)}>{showPreview ? "Hide" : "Show"}</button>
          </div>
          {showPreview ? <>
          <div className="notice">
            Available fields:{" "}
            {SHORTCODES.map((s) => (
              <code key={s}>{s}</code>
            ))}
          </div>
          {previewBusiness && currentTemplate ? (
            <>
              <p className="muted">
                {previewBusiness.name || previewBusiness.email}
              </p>
              {previewLocalized ? <div className="notice" style={{ marginBottom: 12 }}>
                <strong>Language:</strong> {previewLocalized.languageLabel}. Detected from {previewLocalized.detectedLanguage.sourceLabel}.
                {previewLocalized.usedFallback ? ' This template has no complete matching translation, so Scout will use English.' : ''}
              </div> : null}
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
              <div className="notice" style={{ marginTop: 12 }}>
                <strong>Safety Check:</strong> {spamReport.level} risk · score{" "}
                {spamReport.score}/100.{" "}
                {spamReport.level === "High"
                  ? "Scout will block this send unless you override."
                  : "You can send, but review findings before a large run."}
              </div>
              <div className="stack" style={{ gap: 6, marginTop: 8 }}>
                {spamReport.findings.slice(0, 6).map((f, idx) => (
                  <div className="badge" key={`${f.label}-${idx}`}>
                    {f.severity}: {f.label}
                  </div>
                ))}
                {!spamReport.findings.length ? (
                  <span className="badge">
                    No obvious spam-word issue found.
                  </span>
                ) : null}
              </div>
            </>
          ) : (
            <p className="muted">Select a template and load contacts.</p>
          )}
          <h3 style={{ marginTop: 18 }}>Recent Sent</h3>
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
                    <td colSpan={6} className="muted">
                      No sent logs yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          </> : <p className="muted">Hidden. Click Show to check the email before sending.</p>}
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card" style={{ padding: 18 }}>
          <h3 id="send-follow-ups">Send Follow-ups — 72h no reply</h3>
          <p className="muted">
            These are people you emailed more than 72 hours ago who did not send a reply. Send them now when you are ready.
          </p>
          <div className="notice" style={{ marginBottom: 12 }}>
            Due now: <strong>{dueFollowUps.length.toLocaleString()}</strong> contact(s). You can send up to 1,000 follow-ups at once. Choose the follow-up template here, then send once.
          </div>
          <div className="grid grid-2">
            <div>
              <label className="label">Which follow-ups?</label>
              <select
                className="select"
                value={followUpSegment}
                onChange={(e) =>
                  setFollowUpSegment(
                    e.target.value as
                      | "all_unanswered"
                      | "no_reply"
                      | "auto_reply",
                  )
                }
              >
                <option value="all_unanswered">All due follow-ups</option>
                <option value="no_reply">No reply at all</option>
                <option value="auto_reply">Auto reply only</option>
              </select>
            </div>
            <div>
              <label className="label">Follow-up template to use</label>
              <select
                className="select"
                value={currentFollowUpTemplate?.id || ""}
                onChange={(e) => {
                  setFollowUpTemplateId(e.target.value);
                }}
              >
                <option value="">Use first follow-up template</option>
                {(followUpTemplates.length ? followUpTemplates : allFollowUpTemplates).map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <p className="muted" style={{ marginTop: 6, fontSize: 12 }}>Only follow-up templates show here. One click queues every due follow-up and Scout applies the automatic sender delays.</p>
            </div>
          </div>
          <div className="actions" style={{ marginTop: 12 }}>
            <button
              className="btn"
              type="button"
              disabled={busy || !dueFollowUps.length}
              onClick={sendDueFollowUpsNow}
            >
              Send All Due Follow-ups
            </button>
            <button
              className="btn secondary"
              type="button"
              onClick={loadDueFollowUps}
            >
              Refresh
            </button>
          </div>
          <div className="actions" style={{ marginTop: 12 }}>
            <button className="btn secondary mini" type="button" onClick={() => setShowDueList((v) => !v)}>{showDueList ? "Hide list" : "Show list"}</button>
          </div>
          {showDueList ? (
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table>
                <thead>
                  <tr>
                    <th>Business</th>
                    <th>Email</th>
                    <th>Type</th>
                    <th>Last Sent</th>
                  </tr>
                </thead>
                <tbody>
                  {dueFollowUps.slice(0, 1000).map((row) => (
                    <tr key={`${row.business_id}-${row.last_sent_at}`}>
                      <td>{row.business_name || "-"}</td>
                      <td>{row.to_email}</td>
                      <td>{row.followup_segment || row.segment || row.reply_state || followUpSegment}</td>
                      <td>{new Date(row.last_sent_at).toLocaleString()}</td>
                    </tr>
                  ))}
                  {!dueFollowUps.length ? (
                    <tr>
                      <td colSpan={4} className="muted">No due follow-ups yet.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>

        <div className="card" style={{ padding: 18 }}>
          <h3>Schedule Email</h3>
          <p className="muted">Save a send for later. When it is due, open Scout and click Run Due Sends Now.</p>
          {dueSchedules.length ? (
            <div className="notice" style={{ marginBottom: 12 }}>
              <strong>{dueSchedules.length.toLocaleString()} schedule(s) due now.</strong>{" "}
Click <strong>Run Due Sends Now</strong> to start.
            </div>
          ) : null}
          {lastSavedSchedule ? (
            <div className="notice" style={{ marginBottom: 12 }}>
              Saved schedule for <strong>{new Date(lastSavedSchedule.scheduled_for).toLocaleString()}</strong>.{" "}
              <button className="btn secondary mini" type="button" onClick={() => downloadScheduleReminder(lastSavedSchedule)}>
                Add phone reminder
              </button>
            </div>
          ) : null}
          <div className="grid grid-2">
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
              <label className="label">How many first emails</label>
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
          <label className="checkbox-row" style={{ marginTop: 12 }}>
            <input
              type="checkbox"
              checked={autoRunSchedules}
              onChange={(e) => setAutoRunSchedules(e.target.checked)}
            />{" "}
            Start saved sends automatically; Supabase continues them after Scout is closed
          </label>
          <div className="actions" style={{ marginTop: 12 }}>
            <button className="btn secondary" type="button" onClick={enableScheduleNotifier}>
              {scheduleReminderEnabled && notificationPermission === "granted" ? "App notifier on" : "Enable app notifier"}
            </button>
            <button className="btn secondary" type="button" disabled={!lastSavedSchedule} onClick={() => lastSavedSchedule && downloadScheduleReminder(lastSavedSchedule)}>
              Add phone reminder
            </button>
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
              disabled={busy || scheduleRunnerBusy}
              onClick={sendDueSchedulesNow}
            >
              {scheduleRunnerBusy ? "Running Due Sends…" : "Run Due Sends Now"}
            </button>
          </div>

          <div className="actions" style={{ marginTop: 12 }}>
            <button className="btn secondary mini" type="button" onClick={() => setShowSavedSends((v) => !v)}>{showSavedSends ? "Hide saved sends" : "Show saved sends"}</button>
            {stoppedSchedules.length ? <button className="btn secondary mini" type="button" onClick={deleteStoppedSchedules}>Delete stopped/old sends</button> : null}
          </div>
          {showSavedSends ? (
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table>
                <thead>
                  <tr>
                    <th>For</th>
                    <th>Count</th>
                    <th>Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {savedScheduleRows.map((s) => (
                    <tr key={s.id}>
                      <td>{new Date(s.scheduled_for).toLocaleString()}</td>
                      <td>{Number(s.target_count || 0).toLocaleString()}</td>
                      <td>{s.status}{s.last_error ? <><br /><span className="error">{s.last_error}</span></> : null}</td>
                      <td>
                        <div className="actions" style={{ gap: 6 }}>
                          {String(s.status || "") === "scheduled" && !s.stop_requested ? <button className="btn secondary mini" type="button" onClick={() => downloadScheduleReminder(s)}>Phone reminder</button> : null}
                          {!["sent", "complete", "completed", "cancelled"].includes(String(s.status || "")) ? <button className="btn mini" type="button" disabled={Boolean(stopBusyId)} onClick={() => continueSchedule(s)}>{stopBusyId === s.id ? "Working…" : "Continue sending"}</button> : null}
                          {["scheduled", "due", "running"].includes(String(s.status || "")) && !s.stop_requested ? <button className="btn secondary mini" type="button" disabled={Boolean(stopBusyId)} onClick={() => stopSchedule(s)}>{stopBusyId === s.id ? "Working…" : "Stop sending"}</button> : null}
                          <button className="btn secondary mini" type="button" disabled={Boolean(stopBusyId)} onClick={() => deleteSchedule(s)}>Delete</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!schedules.length ? (
                    <tr>
                      <td colSpan={4} className="muted">No saved sends yet.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
