"use client";

import { useEffect, useMemo, useState } from "react";
import {
  DASHBOARD_SEND_MARKETS,
  recommendSendWindow,
  SendMarket,
} from "@/lib/send-time-intelligence";

const EXTRA_MARKETS: SendMarket[] = [
  { id: "us-central", label: "US Central", timezone: "America/Chicago" },
  { id: "us-mountain", label: "US Mountain", timezone: "America/Denver" },
  { id: "canada-west", label: "Canada West", timezone: "America/Vancouver" },
  {
    id: "canada-atlantic",
    label: "Canada Atlantic",
    timezone: "America/Halifax",
  },
  { id: "spain-canary", label: "Spain Canary", timezone: "Atlantic/Canary" },
  { id: "uk", label: "UK", timezone: "Europe/London" },
];

function toneStyles(tone: string) {
  if (tone === "ok")
    return {
      borderColor: "rgba(22,163,74,.34)",
      background: "rgba(22,163,74,.08)",
    };
  if (tone === "good")
    return {
      borderColor: "rgba(37,99,235,.28)",
      background: "rgba(37,99,235,.07)",
    };
  if (tone === "wait")
    return {
      borderColor: "rgba(217,119,6,.30)",
      background: "rgba(217,119,6,.07)",
    };
  return {
    borderColor: "rgba(220,38,38,.30)",
    background: "rgba(220,38,38,.07)",
  };
}

function MarketPill({
  market,
  userTimezone,
  now,
}: {
  market: SendMarket;
  userTimezone: string;
  now: Date;
}) {
  const recommendation = recommendSendWindow({
    marketTimezone: market.timezone,
    userTimezone,
    now,
  });
  const action = recommendation.nextBestUserTime
    ? `Send at ${recommendation.nextBestUserTime}`
    : "Send now";
  return (
    <div
      className="badge"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "7px 10px",
        border: "1px solid",
        whiteSpace: "nowrap",
        ...toneStyles(recommendation.tone),
      }}
      title={`Buyer local time: ${recommendation.marketLocalTime} (${market.timezone}). Recommendation shown in your timezone: ${userTimezone}.`}
    >
      <strong>{market.label}</strong>
      <span>{recommendation.label}</span>
      <span className="muted">· {action}</span>
    </div>
  );
}

export default function SendTimeStrip() {
  const [now, setNow] = useState(() => new Date());
  const [userTimezone, setUserTimezone] = useState("UTC");
  const [extraMarketId, setExtraMarketId] = useState("");

  useEffect(() => {
    try {
      setUserTimezone(
        Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      );
    } catch {
      setUserTimezone("UTC");
    }
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const extraMarket = useMemo(
    () => EXTRA_MARKETS.find((market) => market.id === extraMarketId) || null,
    [extraMarketId],
  );

  return (
    <div className="card" style={{ padding: "10px 12px" }}>
      <div
        className="actions"
        style={{
          justifyContent: "space-between",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <div className="actions" style={{ gap: 8, flexWrap: "wrap" }}>
          <strong style={{ marginRight: 2 }}>Send time:</strong>
          {DASHBOARD_SEND_MARKETS.map((market) => (
            <MarketPill
              key={market.id}
              market={market}
              userTimezone={userTimezone}
              now={now}
            />
          ))}
          {extraMarket ? (
            <MarketPill
              market={extraMarket}
              userTimezone={userTimezone}
              now={now}
            />
          ) : null}
        </div>
        <div className="actions" style={{ gap: 8 }}>
          <span className="muted" style={{ fontSize: 12 }}>
            shown in {userTimezone}
          </span>
          <select
            className="select"
            style={{ width: 170, height: 34, padding: "6px 9px" }}
            value={extraMarketId}
            onChange={(e) => setExtraMarketId(e.target.value)}
          >
            <option value="">More timezones</option>
            {EXTRA_MARKETS.map((market) => (
              <option key={market.id} value={market.id}>
                {market.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
