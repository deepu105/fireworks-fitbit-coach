import { z } from "zod";
import { PublicError } from "../http";
import { ACTIVITY_SCOPE, FITBIT_SCOPES, METRICS_SCOPE, SLEEP_SCOPE } from "./scopes";

// Protobuf int64 values arrive as decimal strings. Do not coerce null to zero.
const nonnegative = z.union([z.string().regex(/^\d+$/).transform(Number), z.number()])
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const civilDate = z.object({ year: z.number().int().min(2000).max(9999), month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) });
const civilTime = z.object({ date: civilDate });
const rollupSchema = z.object({ civilStartTime: civilTime,
  steps: z.object({ countSum: nonnegative }).optional(),
  activeMinutes: z.object({ activeMinutesRollupByActivityLevel: z.array(z.object({ activityLevel: z.string(), activeMinutesSum: nonnegative })) }).optional(),
});
const heartSchema = z.object({ dailyRestingHeartRate: z.object({ date: civilDate, beatsPerMinute: nonnegative.refine((n) => n > 0) }) });
const sleepSchema = z.object({ sleep: z.object({
  interval: z.object({ startTime: z.string().datetime({ offset: true }), endTime: z.string().datetime({ offset: true }),
    civilEndTime: civilTime.optional(), endUtcOffset: z.string().regex(/^-?\d+(?:\.\d+)?s$/).optional() }),
  summary: z.object({ minutesAsleep: nonnegative }),
}) });
const pageSchema = z.object({ dataPoints: z.array(z.unknown()).optional(), rollupDataPoints: z.array(z.unknown()).optional(), nextPageToken: z.string().max(8192).optional() });

export type Day = { date: string; steps: number | null; activeMinutes: number | null; sleepMinutes: number | null; restingHeartRate: number | null };
type Average = { value: number | null; days: number };
export type FitbitReport = {
  date: string; timeZone: string; generatedAt: string; latest: Day;
  baseline: Record<Exclude<keyof Day, "date">, Average>; days: Day[]; warnings: string[];
};
const shiftDay = (day: string, amount: number) => new Date(Date.parse(`${day}T12:00:00Z`) + amount * 86_400_000).toISOString().slice(0, 10);
const dateString = (date: z.infer<typeof civilDate>) => `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
const asCivilTime = (day: string) => { const [year, month, date] = day.split("-").map(Number); return { date: { year, month, day: date }, time: {} }; };

export function latestCompleteDay(now: Date, timeZone: string) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const part = (name: string) => parts.find((value) => value.type === name)!.value;
    return shiftDay(`${part("year")}-${part("month")}-${part("day")}`, -1);
  } catch { throw new PublicError("INVALID_TIMEZONE", "Set REPORT_TIME_ZONE to a valid IANA timezone."); }
}

export async function fetchFitbitReport(options: {
  token: string; signal: AbortSignal; now?: Date; fetch?: typeof fetch; scopes?: string[]; timeZone?: string; apiOrigin?: string;
}): Promise<FitbitReport> {
  const now = options.now ?? new Date();
  // This setting chooses the report cutoff. Google keeps each reading's recorded
  // civil date, including travel/DST; we do not rebucket readings into this zone.
  const timeZone = options.timeZone ?? process.env.REPORT_TIME_ZONE?.trim() ?? "UTC";
  const date = latestCompleteDay(now, timeZone);
  const dates = Array.from({ length: 8 }, (_, index) => shiftDay(date, index - 7));
  const end = shiftDay(date, 1);
  const scopes = options.scopes ?? FITBIT_SCOPES;
  const apiFetch = options.fetch ?? fetch;
  const apiOrigin = options.apiOrigin ?? "https://health.googleapis.com";
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(25_000)]);
  const warnings: string[] = apiOrigin === "https://health.googleapis.com" ? [] : ["Generated test readings. These measurements do not come from a real health account."];
  async function get(path: string, body?: Record<string, unknown>): Promise<unknown> {
    try {
      const response = await apiFetch(`${apiOrigin}/v4/users/me/${path}`, {
        method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${options.token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), cache: "no-store", redirect: "error", signal,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const details = z.object({ error: z.object({ details: z.array(z.object({ reason: z.string().optional() })).optional() }) }).safeParse(payload);
        const reasons = details.success ? details.data.error.details?.map((d) => d.reason) ?? [] : [];
        if (reasons.includes("ACCOUNT_NOT_LINKED")) throw new PublicError("ACCOUNT_NOT_LINKED", "Open the Google Health mobile app with this personal Google account and finish creating or linking its health profile, then reconnect.", 409);
        if (response.status === 401) throw new PublicError("RECONNECT_REQUIRED", "Reconnect Google Health to renew access to your Fitbit data.", 409);
        if (response.status === 403) {
          if (reasons.some((reason) => ["SERVICE_DISABLED", "ACCESS_NOT_CONFIGURED"].includes(reason ?? ""))) throw new PublicError("GOOGLE_HEALTH_NOT_ENABLED", "Enable the Google Health API in the Google Cloud project for this OAuth client.", 503);
          throw new PublicError("HEALTH_PERMISSION_DENIED", "Google Health denied this data request. Check the granted read permissions and Google Cloud API configuration.", 403);
        }
        if (response.status === 429) throw new PublicError("FITBIT_RATE_LIMIT", "Google Health's request limit was reached. Wait before refreshing.", 429);
        throw new PublicError("FITBIT_UNAVAILABLE", "Google Health could not return this data. Try again later.");
      }
      return payload;
    } catch (error) {
      if (error instanceof PublicError) throw error;
      throw new PublicError("FITBIT_UNAVAILABLE", "The Google Health request failed or timed out. Try again later.");
    }
  }
  // OAuth consent can succeed even for an account without a health profile.
  const identity = z.object({ healthUserId: z.string().min(1) }).safeParse(await get("identity"));
  if (!identity.success) throw new PublicError("INVALID_IDENTITY", "Google Health did not confirm a linked health profile.");

  async function pages(path: string, key: "dataPoints" | "rollupDataPoints", body?: Record<string, unknown>) {
    const output: unknown[] = [];
    const seen = new Set<string>();
    let next = "";
    for (let index = 0; index < 8; index++) {
      const url = new URL(`https://health.googleapis.com/v4/users/me/${path}`);
      if (!body && next) url.searchParams.set("pageToken", next);
      const page = pageSchema.safeParse(await get(`${url.pathname.split("/users/me/")[1]}${url.search}`, body ? { ...body, ...(next ? { pageToken: next } : {}) } : undefined));
      if (!page.success) throw new PublicError("INVALID_HEALTH_DATA", "Google Health returned an unreadable data page.");
      output.push(...(page.data[key] ?? []));
      next = page.data.nextPageToken ?? "";
      if (!next) return output;
      if (seen.has(next)) break;
      seen.add(next);
    }
    throw new PublicError("INCOMPLETE_HEALTH_DATA", "Google Health returned too many data pages. No partial total was used.");
  }
  const range = { start: asCivilTime(dates[0]), end: asCivilTime(end) };
  function rollup(type: string) {
    return pages(`dataTypes/${type}/dataPoints:dailyRollUp`, "rollupDataPoints", { range, windowSizeDays: 1, pageSize: 8 });
  }
  function reconcile(type: string, field: string) {
    const query = new URLSearchParams({ filter: `${field} >= "${dates[0]}" AND ${field} < "${end}"`, pageSize: "25" });
    return pages(`dataTypes/${type}/dataPoints:reconcile?${query}`, "dataPoints");
  }
  const sources = [
    { label: "Steps", scope: ACTIVITY_SCOPE, read: () => rollup("steps") },
    { label: "Active minutes", scope: ACTIVITY_SCOPE, read: () => rollup("active-minutes") },
    { label: "Sleep", scope: SLEEP_SCOPE, read: () => reconcile("sleep", "sleep.interval.civil_end_time") },
    { label: "Resting heart rate", scope: METRICS_SCOPE, read: () => reconcile("daily-resting-heart-rate", "daily_resting_heart_rate.date") },
  ];
  let failedSources = 0;
  const results = await Promise.all(sources.map(async (source) => {
    if (!scopes.includes(source.scope)) { warnings.push(`${source.label} permission was not granted. Reconnect to add it.`); return []; }
    try { return await source.read(); }
    catch (error) {
      if (error instanceof PublicError && ["RECONNECT_REQUIRED", "FITBIT_RATE_LIMIT", "ACCOUNT_NOT_LINKED", "GOOGLE_HEALTH_NOT_ENABLED"].includes(error.code)) throw error;
      failedSources++;
      warnings.push(error instanceof PublicError && error.code === "HEALTH_PERMISSION_DENIED" ? `${source.label} access was denied. Reconnect to review permissions.` : `${source.label} data was unavailable. No value was assumed.`);
      return [];
    }
  }));
  const days: Day[] = dates.map((day) => ({ date: day, steps: null, activeMinutes: null, sleepMinutes: null, restingHeartRate: null }));
  for (const [sourceIndex, metric] of [[0, "steps"], [1, "activeMinutes"]] as const) {
    const seen = new Set<string>();
    for (const raw of results[sourceIndex]) {
      const parsed = rollupSchema.safeParse(raw);
      if (!parsed.success) { warnings.push(`${sources[sourceIndex].label} included an unreadable record.`); continue; }
      const point = parsed.data;
      const day = days.find((day) => day.date === dateString(point.civilStartTime.date));
      if (!day) continue;
      if (seen.has(day.date)) { day[metric] = null; warnings.push(`Duplicate ${sources[sourceIndex].label.toLowerCase()} for ${day.date} was excluded.`); continue; }
      seen.add(day.date);
      if (metric === "steps") day.steps = point.steps?.countSum ?? null;
      else {
        const levels = point.activeMinutes?.activeMinutesRollupByActivityLevel;
        // Sum actual MODERATE/VIGOROUS minutes. Do not double vigorous minutes
        // as Active Zone Minutes would, or infer activity from LIGHT minutes.
        if (levels && levels.length && new Set(levels.map((value) => value.activityLevel)).size === levels.length && levels.every((value) => ["LIGHT", "MODERATE", "VIGOROUS"].includes(value.activityLevel))) {
          const total = levels.filter((value) => ["MODERATE", "VIGOROUS"].includes(value.activityLevel)).reduce((sum, value) => sum + value.activeMinutesSum, 0);
          if (total <= 1440) day.activeMinutes = total;
        }
      }
    }
  }
  const heartSeen = new Set<string>();
  for (const raw of results[3]) {
    const parsed = heartSchema.safeParse(raw);
    if (!parsed.success) { warnings.push("Resting heart rate included an unreadable record."); continue; }
    const value = parsed.data.dailyRestingHeartRate;
    const day = days.find((day) => day.date === dateString(value.date));
    if (!day) continue;
    if (heartSeen.has(day.date)) { day.restingHeartRate = null; warnings.push(`Duplicate resting heart rate for ${day.date} was excluded.`); }
    else day.restingHeartRate = value.beatsPerMinute;
    heartSeen.add(day.date);
  }
  const sleeps = new Map<string, { start: number; end: number; minutes: number }[]>();
  for (const raw of results[2]) {
    const parsed = sleepSchema.safeParse(raw);
    if (!parsed.success) throw new PublicError("INVALID_SLEEP_DATA", "Google Health returned an unreadable sleep session. No incomplete sleep total was used.");
    const { interval, summary } = parsed.data.sleep;
    const start = Date.parse(interval.startTime), end = Date.parse(interval.endTime);
    // Some reconciled responses omit derived civil time. Use their recorded
    // end offset, never the backend machine's timezone, for the end date.
    const offset = interval.endUtcOffset === undefined ? null : Number(interval.endUtcOffset.slice(0, -1));
    const day = interval.civilEndTime ? dateString(interval.civilEndTime.date) : offset === null ? null : new Date(end + offset * 1000).toISOString().slice(0, 10);
    if (!day || !dates.includes(day)) continue;
    const logs = sleeps.get(day) ?? [];
    logs.push({ start, end, minutes: summary.minutesAsleep }); sleeps.set(day, logs);
  }
  for (const day of days) {
    const logs = sleeps.get(day.date);
    if (!logs?.length) continue;
    logs.sort((a, b) => a.start - b.start);
    const total = logs.reduce((sum, log) => sum + log.minutes, 0);
    if (total > 1440 || logs.some((log, index) => log.end <= log.start || log.minutes > (log.end - log.start) / 60_000 + 1 || (index > 0 && log.start < logs[index - 1].end))) {
      warnings.push(`Overlapping or invalid sleep data for ${day.date} was excluded.`);
    } else day.sleepMinutes = total;
  }
  const latest = days[7];
  if ([latest.steps, latest.activeMinutes, latest.sleepMinutes, latest.restingHeartRate].every((value) => value === null)) {
    if (failedSources === sources.filter((source) => scopes.includes(source.scope)).length) throw new PublicError("HEALTH_DATA_UNAVAILABLE", "Google Health could not return any of the permitted data streams. Check API permissions and configuration, then retry.");
    throw new PublicError("NO_RECENT_DATA", `No supported Google Health readings are available for ${date}. Sync your tracker or add a sleep log in the mobile app for that date. Reconnect if you withheld permissions.${warnings.length ? " " + [...new Set(warnings)].join(" ") : ""}`, 422);
  }
  function average(metric: Exclude<keyof Day, "date">): Average {
    const values = days.slice(0, 7).map((day) => day[metric]).filter((value): value is number => value !== null);
    return { value: values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 10) / 10 : null, days: values.length };
  }
  return { date, timeZone, generatedAt: now.toISOString(), latest, days,
    baseline: { steps: average("steps"), activeMinutes: average("activeMinutes"), sleepMinutes: average("sleepMinutes"), restingHeartRate: average("restingHeartRate") }, warnings: [...new Set(warnings)],
  };
}
