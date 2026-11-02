"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import type { Day, FitbitReport } from "@/lib/fitbit/report";

type Status = { connected: boolean; needsPermissions: boolean; multipleAccounts: boolean };
const transport = new DefaultChatTransport({
  api: "/api/advice",
  prepareSendMessagesRequest: () => ({ body: { shareWithFireworks: true } }),
});

async function readResponse(response: Response) {
  const value = await response.json();
  if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : "The request failed. Try again.");
  return value;
}
function publicMessage(error: unknown) {
  if (!(error instanceof Error)) return "The request failed. Try again.";
  if (["TimeoutError", "AbortError"].includes(error.name)) return "The request timed out. Try the connection check again.";
  try { const value = JSON.parse(error.message); if (typeof value.error === "string") return value.error; } catch {}
  return error.message;
}
function duration(value: number | null) {
  if (value === null) return "No data";
  const minutes = Math.round(value);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function dateLabel(value: string) {
  return new Date(`${value}T12:00:00Z`).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function Dashboard({ fixtureData = false }: { fixtureData?: boolean }) {
  const initialLoadStarted = useRef(false);
  const [connection, setConnection] = useState<Status | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [report, setReport] = useState<FitbitReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [sharing, setSharing] = useState(false);
  const { messages, sendMessage, setMessages, status, error, clearError, stop } = useChat({
    transport,
    onFinish: () => setSharing(false),
    onError: () => setSharing(false),
  });
  const generating = status === "submitted" || status === "streaming";
  const busy = loading || statusLoading || generating;

  const refresh = useCallback(async () => {
    setLoading(true); setNotice(""); setSharing(false); setMessages([]); clearError();
    try {
      const response = await fetch("/api/fitbit/report", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      const value = await response.json();
      if (!response.ok) {
        const code = value.code;
        if (code === "CONNECT_FITBIT") setConnection({ connected: false, needsPermissions: false, multipleAccounts: false });
        else if (code === "MULTIPLE_ACCOUNTS") setConnection({ connected: false, needsPermissions: false, multipleAccounts: true });
        else if (["HEALTH_PERMISSIONS_REQUIRED", "RECONNECT_REQUIRED"].includes(code)) setConnection({ connected: true, needsPermissions: true, multipleAccounts: false });
        else if (["NO_RECENT_DATA", "HEALTH_DATA_UNAVAILABLE", "FITBIT_RATE_LIMIT", "GOOGLE_HEALTH_NOT_ENABLED", "ACCOUNT_NOT_LINKED", "INVALID_IDENTITY", "INVALID_SLEEP_DATA", "INVALID_TIMEZONE", "FITBIT_UNAVAILABLE", "HEALTH_PERMISSION_DENIED"].includes(code)) setConnection({ connected: true, needsPermissions: false, multipleAccounts: false });
        else setConnection(null);
        // A disconnected account is an onboarding state, not an error banner.
        if (code === "CONNECT_FITBIT") { setReport(null); return; }
        throw new Error(typeof value.error === "string" ? value.error : "The request failed. Try again.");
      }
      setConnection({ connected: true, needsPermissions: false, multipleAccounts: false });
      setReport(value);
    } catch (error) { setReport(null); setNotice(publicMessage(error)); }
    finally { setLoading(false); setStatusLoading(false); }
  }, [clearError, setMessages]);

  // React Strict Mode replays effects in development. List the connected
  // account once per mount, then use the same request to build the report.
  useEffect(() => {
    if (initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    void refresh();
  }, [refresh]);
  useEffect(() => {
    // The tool output is the fresh server-fetched summary actually used by the
    // model. Update the cards if data changed since the initial page load.
    for (const message of messages) for (const part of message.parts) {
      if (isToolUIPart(part) && part.state === "output-available") {
        const value = part.output as FitbitReport;
        if (value && typeof value.date === "string" && Array.isArray(value.days) && value.latest) setReport(value);
      }
    }
  }, [messages]);

  async function disconnect() {
    setLoading(true); setNotice("");
    try {
      await readResponse(await fetch("/api/fitbit/disconnect", { method: "POST", signal: AbortSignal.timeout(15_000) }));
      setReport(null); setMessages([]); clearError(); setSharing(false);
      setConnection({ connected: false, needsPermissions: false, multipleAccounts: false });
    } catch (error) { setNotice(publicMessage(error)); }
    finally { setLoading(false); }
  }
  function generate() {
    if (!sharing || busy || !report) return;
    setMessages([]); clearError();
    void sendMessage({ text: "Generate today's wellbeing suggestions from my Fitbit summary." }).catch(() => {});
  }
  const ready = connection?.connected && !connection.needsPermissions && !connection.multipleAccounts;

  return <div className="dashboard">
    <section className="connection card" aria-labelledby="connection-title">
      <div className="connection-copy"><span className={`connection-icon ${ready ? "connected" : ""}`} aria-hidden="true">f</span>
        <div><h2 id="connection-title">Fitbit <span className="badge">{statusLoading ? "Checking" : ready && report ? "Connected" : ready ? "Authorization saved" : "Not ready"}</span></h2>
          <p>{fixtureData ? "Using generated health readings for testing." : ready ? "Fitbit data through Google Health. Readings depend on the permissions you grant." :
            connection?.multipleAccounts ? "Connect one Fitbit account to use for your daily report." :
            connection?.needsPermissions ? "Reconnect and allow the requested read permissions." : "Connect your personal Google account after linking it in the Google Health mobile app."}</p></div>
      </div>
      <div className="connection-actions">
        {connection?.connected || connection?.multipleAccounts ? <>
          {ready && <button className="button secondary" onClick={() => void refresh()} disabled={busy}>{loading ? "Loading..." : "Refresh data"}</button>}
            <form action="/api/fitbit/connect" method="post"><button className="button primary" disabled={busy}>Review permissions</button></form>
          <button className="text-button" disabled={busy} onClick={() => void disconnect()}>Disconnect</button>
        </> : connection ? <form action="/api/fitbit/connect" method="post"><button className="button primary" disabled={busy}>Connect Fitbit <span aria-hidden="true">↗</span></button></form> :
          !statusLoading && <button className="button secondary" disabled={busy} onClick={() => void refresh()}>Retry connection check</button>}
      </div>
    </section>
    {notice && <p className="notice error" role="alert" aria-label="Fitbit error">{notice}</p>}
    {loading && <p className="loading" role="status">Reading your Fitbit data...</p>}
    {report ? <>
      <div className="section-heading"><div><p className="eyebrow">Latest completed day</p><h2>{dateLabel(report.date)}</h2></div><p>Report cutoff: {report.timeZone}<br /><span>Compared with the preceding seven days</span></p></div>
      <div className="metrics">
        <Metric label="Steps" value={report.latest.steps?.toLocaleString() ?? "No data"} average={report.baseline.steps.value?.toLocaleString() ?? null} days={report.baseline.steps.days} />
        <Metric label="Sleep" value={duration(report.latest.sleepMinutes)} average={report.baseline.sleepMinutes.value === null ? null : duration(report.baseline.sleepMinutes.value)} days={report.baseline.sleepMinutes.days} />
        <Metric label="Active minutes" value={report.latest.activeMinutes === null ? "No data" : `${report.latest.activeMinutes} min`} average={report.baseline.activeMinutes.value === null ? null : `${report.baseline.activeMinutes.value} min`} days={report.baseline.activeMinutes.days} />
        <Metric label="Resting heart rate" value={report.latest.restingHeartRate === null ? "No data" : `${report.latest.restingHeartRate} bpm`} average={report.baseline.restingHeartRate.value === null ? null : `${report.baseline.restingHeartRate.value} bpm`} days={report.baseline.restingHeartRate.days} />
      </div>
      <section className="history card" aria-labelledby="history-title">
        <div className="section-heading"><div><h2 id="history-title">Your recent activity</h2><p>Steps over eight days</p></div><span className="chart-key"><i /> Latest completed day</span></div>
        <StepChart days={report.days} />
        <details><summary>View daily readings</summary><div className="table-scroll"><table><thead><tr><th>Date</th><th>Steps</th><th>Sleep</th><th>Active</th><th>Resting HR</th></tr></thead>
          <tbody>{report.days.map((day) => <tr key={day.date}><th>{day.date}</th><td>{day.steps?.toLocaleString() ?? "No data"}</td><td>{duration(day.sleepMinutes)}</td><td>{day.activeMinutes === null ? "No data" : `${day.activeMinutes} min`}</td><td>{day.restingHeartRate === null ? "No data" : `${day.restingHeartRate} bpm`}</td></tr>)}</tbody></table></div></details>
        <p className="data-note">Missing readings are shown as no data. Zero steps can also mean your device was not worn. Active minutes combine moderate and vigorous minutes. Dates follow the local time recorded with each reading.</p>
        {report.warnings.map((warning) => <p className="data-note warning" key={warning}>{warning}</p>)}
      </section>
      <section className="advice card" aria-labelledby="advice-title">
        <p className="eyebrow">Based on your Fitbit summary</p><h2 id="advice-title">Suggestions for today</h2>
        <p className="muted">Fireworks can compare your latest completed day with your recent readings and suggest a few practical things to try.</p>
        <label className="consent"><input type="checkbox" checked={sharing} disabled={busy} onChange={(event) => setSharing(event.target.checked)} /><span>Share my daily readings and seven-day comparison with Fireworks to generate suggestions.</span></label>
        <div className="advice-actions"><button className="button primary" disabled={!sharing || busy} onClick={generate}>{generating ? "Generating suggestions..." : "Generate suggestions"}</button>
          {generating && <button className="button secondary" onClick={() => { void stop(); setSharing(false); }}>Stop</button>}</div>
        {generating && <p className="loading" role="status">Reading the summary and generating suggestions...</p>}
        {error && <p className="notice error" role="alert" aria-label="Advice error">{publicMessage(error)}</p>}
        <div className="advice-output" role="log" aria-label="Daily suggestions" aria-live="polite">{messages.filter((message) => message.role === "assistant").map((message) => <div key={message.id}>{message.parts.map((part, index) => part.type === "text" ? <div key={index} className="advice-text"><Markdown skipHtml components={{
          a: ({ href, children }) => href && /^https?:\/\//i.test(href) ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
          img: ({ alt }) => <span>{alt}</span>,
        }}>{part.text}</Markdown></div> : null)}</div>)}</div>
        <p className="data-note">Data is refreshed before generating suggestions. Your name, email, and access tokens are not included. This app keeps the summary and suggestions in memory for this visit.</p>
      </section>
    </> : !loading && <section className="empty card"><h2>Your daily summary will appear here</h2><p>{fixtureData ? "Connect a test account to load the example report." : "Connect Fitbit and sync your device to review the latest completed day and the seven days before it."}</p></section>}
  </div>;
}

function Metric({ label, value, average, days }: { label: string; value: string; average: string | null; days: number }) {
  return <section className="metric card" aria-label={label}><p>{label}</p><h3>{value}</h3><span>{average === null ? "No comparison data" : `${average} average · ${days}/7 days`}</span></section>;
}

function StepChart({ days }: { days: Day[] }) {
  const max = Math.max(1, ...days.map((day) => day.steps ?? 0));
  return <div className="chart" role="img" aria-label={`Daily steps from ${days[0].date} to ${days.at(-1)!.date}. Exact values are available in daily readings.`}>
    {days.map((day, index) => <div className="bar-column" key={day.date} title={`${day.date}: ${day.steps === null ? "no data" : `${day.steps.toLocaleString()} steps`}`}>
      <span className="bar-value">{day.steps === null ? "-" : day.steps >= 1000 ? `${(day.steps / 1000).toFixed(1)}k` : day.steps}</span>
      <div className="bar-track"><div className={`bar ${index === days.length - 1 ? "current" : ""} ${day.steps === null ? "missing" : ""}`} style={{ height: `${day.steps === null ? 8 : Math.max(2, day.steps / max * 100)}%` }} /></div>
      <span className="bar-label">{dateLabel(day.date)}</span>
    </div>)}
  </div>;
}
