import { getChannelConfiguration } from "../../../../lib/channels/config";
import { constantTimeToken } from "../../../../lib/channels/normalize";
import { createChannelWorker } from "../../../../lib/channels/worker";
import { sendChannelMessage } from "../../../../lib/channels/provider";
import { generateChannelAI } from "../../../../lib/channels/ai";
import * as store from "../../../../lib/channels/store";

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
    if (!authorization.startsWith("Bearer ") || !constantTimeToken(secret, authorization.slice(7))) return respond({ error: "Worker authorization required" }, 401);
    if (new URL(req.url).search) return respond({ error: "Worker parameters are not accepted" }, 400);
    const result = await createChannelWorker({ store, accounts: config.accounts, send: sendChannelMessage, generateAI: generateChannelAI }).run();
    return respond({ ok: true, ...result });
  } catch { return respond({ error: "Channel worker temporarily unavailable" }, 503); }
}
export const GET = run;
export const POST = run;
