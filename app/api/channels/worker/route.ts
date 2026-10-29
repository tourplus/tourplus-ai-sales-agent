import { getChannelConfiguration } from "../../../../lib/channels/config";
import { constantTimeToken } from "../../../../lib/channels/normalize";
import { createChannelWorker } from "../../../../lib/channels/worker";
import { sendChannelMessage } from "../../../../lib/channels/provider";
import { generateChannelAI } from "../../../../lib/channels/ai";
import * as store from "../../../../lib/channels/store";
import { readWorkerBody, verifyWorkerDispatch } from "../../../../lib/channels/worker-auth";
import { supabase } from "../../../../lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
async function run(req: Request) {
  const respond = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  try {
    const config = getChannelConfiguration(), secret = config.workerSecret || process.env.CRON_SECRET;
    if (config.mode === "disabled") return respond({ error: "Channel worker is disabled" }, 503);
    if (!secret || secret.length < 32) return respond({ error: "Channel worker is not configured" }, 503);
    const authorization = req.headers.get("authorization") || "";
    // Bearer is retained for trusted server-to-server Next after() wakeups. The
    // database scheduler never writes this persistent key into pg_net's queue.
    const bearer = authorization.startsWith("Bearer ") && constantTimeToken(secret, authorization.slice(7));
    if (!bearer) {
      const body = await readWorkerBody(req);
      const signed = config.workerSecret && body !== null ? verifyWorkerDispatch({ method: req.method, url: req.url, body, headers: req.headers, secret: config.workerSecret }) : null;
      if (!signed) return respond({ error: "Worker authorization required" }, 401);
      // Even a correctly signed request must match a nonce actually issued by
      // the private dispatcher. This atomic RPC burns it before any work runs.
      const consumption = await supabase("rpc/consume_channel_worker_nonce", { method: "POST", body: JSON.stringify({ p_nonce: signed.nonce, p_timestamp: signed.timestamp }), signal: AbortSignal.timeout(5000) });
      if (!consumption.ok) return respond({ error: "Channel worker temporarily unavailable" }, 503);
      if (await consumption.json() !== true) return respond({ error: "Worker authorization required" }, 401);
    }
    if (new URL(req.url).search) return respond({ error: "Worker parameters are not accepted" }, 400);
    const result = await createChannelWorker({ store, accounts: config.accounts, send: sendChannelMessage, generateAI: generateChannelAI }).run();
    return respond({ ok: true, ...result });
  } catch { return respond({ error: "Channel worker temporarily unavailable" }, 503); }
}
export const GET = run;
export const POST = run;
