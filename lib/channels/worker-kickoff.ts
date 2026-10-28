import type { ChannelConfiguration } from "./types";

export const CHANNEL_WORKER_ORIGIN = "https://tourplus-ai-sales-agent.vercel.app";
export const CHANNEL_WORKER_PATH = "/api/channels/worker";
const webhookBudgetMs = 55000;
const maximumKickoffMs = 10000;
const minimumKickoffMs = 1000;

type Environment = Record<string, string | undefined>;
type KickoffOptions = {
  method: string;
  status: number;
  requestStartedAt: number;
  configuration: Pick<ChannelConfiguration, "mode" | "workerSecret">;
  schedule: (callback: () => Promise<void>) => void;
  environment?: Environment;
  fetcher?: typeof fetch;
  now?: () => number;
  warn?: () => void;
};

export function workerKickoffBudget(requestStartedAt: number, now: number): number {
  if (!Number.isFinite(requestStartedAt) || !Number.isFinite(now) || requestStartedAt > now + 1000) return 0;
  const remaining = Math.floor(requestStartedAt + webhookBudgetMs - now);
  return remaining >= minimumKickoffMs ? Math.min(maximumKickoffMs, remaining) : 0;
}

export function workerKickoffAllowed(options: Pick<KickoffOptions, "method" | "status" | "configuration">, environment: Environment): boolean {
  return options.method === "POST" && options.status === 200
    && options.configuration.mode === "live" && environment.CHANNELS_MODE === "live"
    && environment.VERCEL_ENV === "production"
    && environment.VERCEL_PROJECT_PRODUCTION_URL === "tourplus-ai-sales-agent.vercel.app"
    && typeof options.configuration.workerSecret === "string"
    && options.configuration.workerSecret.length >= 32
    && options.configuration.workerSecret.length <= 4096
    && !/[\u0000-\u0020\u007f]/.test(options.configuration.workerSecret);
}

// A best-effort authenticated wakeup only. Provider calls and queue transitions
// remain inside the existing worker, including its ownership/takeover checks.
// Timing out this HTTP handoff does not prove that the worker did not execute;
// it never authorizes a resend. The durable minute sweep handles later retries.
export function scheduleChannelWorkerKickoff(options: KickoffOptions): boolean {
  const environment = options.environment || process.env;
  const now = options.now || Date.now;
  if (!workerKickoffAllowed(options, environment) || !workerKickoffBudget(options.requestStartedAt, now())) return false;
  const fetcher = options.fetcher || fetch;
  const warn = options.warn || (() => console.warn("Channel worker kickoff did not complete; durable recovery remains pending"));
  const callback = async () => {
    const timeout = workerKickoffBudget(options.requestStartedAt, now());
    if (!timeout) return;
    try {
      const response = await fetcher(CHANNEL_WORKER_ORIGIN + CHANNEL_WORKER_PATH, {
        method: "POST", redirect: "error", cache: "no-store",
        headers: { Authorization: `Bearer ${options.configuration.workerSecret}`, "Content-Type": "application/json" },
        body: "{}", signal: AbortSignal.timeout(timeout),
      });
      // Discard bodies: they can contain operational data and are not needed to
      // decide whether the HTTP wakeup reached an authenticated worker.
      await response.body?.cancel();
      if (!response.ok) warn();
    } catch { warn(); }
  };
  try { options.schedule(callback); return true; }
  catch { warn(); return false; }
}
