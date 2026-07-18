"use client";

import { useEffect, useRef, useState } from "react";
import { emitLiveActivity } from "@/lib/live-activity-client";

const LOCK_KEY = "scout_v10_open_app_runner_lock";
const LAST_RUN_KEY = "scout_v10_open_app_runner_last_run";
const RUN_INTERVAL_MS = 5_000;
const LOCK_TTL_MS = 60_000;

const INBOUND_LOCK_KEY = "scout_v10_25_inbound_sync_lock";
const INBOUND_LAST_RUN_KEY = "scout_v10_25_inbound_sync_last_run";
const INBOUND_INTERVAL_MS = 150_000;
const INBOUND_LOCK_TTL_MS = 35_000;

type RunnerResponse = {
  success?: boolean;
  ran?: number;
  results?: Array<{ sent?: number; failed?: number; skipped?: number }>;
  error?: string;
};

type InboundSyncResponse = {
  success?: boolean;
  accountsChecked?: number;
  totals?: {
    scanned?: number;
    saved?: number;
    realReplies?: number;
    autoReplies?: number;
    noInbox?: number;
    blocked?: number;
    bounced?: number;
    limitNotices?: number;
    errors?: number;
  };
  error?: string;
};

function now() {
  return Date.now();
}

function readNumber(key: string) {
  if (typeof window === "undefined") return 0;
  const value = Number(window.localStorage.getItem(key) || "0");
  return Number.isFinite(value) ? value : 0;
}

function acquireNamedLock(keyPrefix: string, workspaceId: string, ttlMs: number) {
  if (typeof window === "undefined") return false;
  const key = `${keyPrefix}_${workspaceId}`;
  const current = readNumber(key);
  if (current && current > now() - ttlMs) return false;
  window.localStorage.setItem(key, String(now()));
  return true;
}

function releaseNamedLock(keyPrefix: string, workspaceId: string) {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(`${keyPrefix}_${workspaceId}`);
}

function acquireLock(workspaceId: string) {
  return acquireNamedLock(LOCK_KEY, workspaceId, LOCK_TTL_MS);
}

function releaseLock(workspaceId: string) {
  releaseNamedLock(LOCK_KEY, workspaceId);
}

export function AppOpenRunner({ workspaceId }: { workspaceId?: string | null }) {
  const [active, setActive] = useState(false);
  const busyRef = useRef(false);
  const inboundBusyRef = useRef(false);

  async function runDueSchedulesSilently() {
    if (!workspaceId || busyRef.current) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    const lastRunKey = `${LAST_RUN_KEY}_${workspaceId}`;
    const lastRun = readNumber(lastRunKey);
    if (lastRun && lastRun > now() - RUN_INTERVAL_MS) return;
    if (!acquireLock(workspaceId)) return;

    busyRef.current = true;
    setActive(true);
    window.localStorage.setItem(lastRunKey, String(now()));
    try {
      const response = await fetch("/api/message/run-schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          limit: 1,
          source: "v10_34_parallel_sender_runner",
        }),
      });
      const json = (await response.json().catch(() => ({}))) as RunnerResponse;
      if (!response.ok || json?.success === false) {
        const message = json?.error || `Open app runner failed with HTTP ${response.status}`;
        emitLiveActivity({
          kind: "schedule",
          status: "runner_note",
          title: "Schedule check",
          message,
          createdAt: new Date().toISOString(),
        });
        return;
      }
      const ran = Number(json.ran || 0);
      if (ran > 0) {
        const results = Array.isArray(json.results) ? json.results : [];
        const sent = results.reduce((sum, row) => sum + Number(row.sent || 0), 0);
        const failed = results.reduce((sum, row) => sum + Number(row.failed || 0), 0);
        const skipped = results.reduce((sum, row) => sum + Number(row.skipped || 0), 0);
        emitLiveActivity({
          kind: "schedule",
          status: "running",
          title: "Due schedule running",
          message: `Open app runner processed ${ran} due schedule(s). Sent ${sent}, failed ${failed}, skipped ${skipped}.`,
          countText: `${sent} sent`,
          createdAt: new Date().toISOString(),
        });
      }
    } finally {
      busyRef.current = false;
      setActive(false);
      releaseLock(workspaceId);
    }
  }


  async function syncInboundSilently(force = false) {
    if (!workspaceId || inboundBusyRef.current) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    const lastRunKey = `${INBOUND_LAST_RUN_KEY}_${workspaceId}`;
    const lastRun = readNumber(lastRunKey);
    if (!force && lastRun && lastRun > now() - INBOUND_INTERVAL_MS) return;
    if (!acquireNamedLock(INBOUND_LOCK_KEY, workspaceId, INBOUND_LOCK_TTL_MS)) return;

    inboundBusyRef.current = true;
    window.localStorage.setItem(lastRunKey, String(now()));
    try {
      const response = await fetch("/api/gmail/auto-sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          maxResults: 3,
          bounceMaxResults: 0,
          days: 2,
          accountLimit: 2,
          deadlineMs: 8000,
          newOnly: true,
          source: "v10_27_app_open_tiny_new_reply_pulse",
        }),
      });
      const json = (await response.json().catch(() => ({}))) as InboundSyncResponse;
      if (!response.ok || json?.success === false) {
        // App-open reply checks are quick background checks. Do not create noisy Scout alerts for a timeout.
        // Manual full sync remains available on the Replies page.
        return;
      }

      const totals = json.totals || {};
      const important = Number(totals.realReplies || 0) + Number(totals.noInbox || 0) + Number(totals.blocked || 0) + Number(totals.bounced || 0) + Number(totals.limitNotices || 0);
      if (important > 0) {
        emitLiveActivity({
          kind: "schedule",
          status: "complete",
          title: "Replies synced",
          message: `Scout found ${Number(totals.realReplies || 0)} real repl${Number(totals.realReplies || 0) === 1 ? "y" : "ies"}, ${Number(totals.autoReplies || 0)} auto messages, and ${Number(totals.noInbox || 0) + Number(totals.blocked || 0) + Number(totals.bounced || 0)} delivery issue(s).`,
          createdAt: new Date().toISOString(),
        });
      }
      window.dispatchEvent(new CustomEvent("scout-notifications-refresh"));
    } finally {
      inboundBusyRef.current = false;
      releaseNamedLock(INBOUND_LOCK_KEY, workspaceId);
    }
  }

  useEffect(() => {
    if (!workspaceId || typeof window === "undefined") return;
    const tick = () => runDueSchedulesSilently().catch(() => undefined);
    const inboundTick = () => syncInboundSilently().catch(() => undefined);
    const first = window.setTimeout(tick, 3000);
    const firstInbound = window.setTimeout(() => syncInboundSilently().catch(() => undefined), 8000);
    const timer = window.setInterval(tick, RUN_INTERVAL_MS);
    const inboundTimer = window.setInterval(inboundTick, INBOUND_INTERVAL_MS);
    return () => {
      window.clearTimeout(first);
      window.clearTimeout(firstInbound);
      window.clearInterval(timer);
      window.clearInterval(inboundTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId || typeof window === "undefined") return;
    const onFocus = () => {
      runDueSchedulesSilently().catch(() => undefined);
      if (typeof document === "undefined" || document.visibilityState === "visible") syncInboundSilently().catch(() => undefined);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  if (!active) return null;
  return null;
}
