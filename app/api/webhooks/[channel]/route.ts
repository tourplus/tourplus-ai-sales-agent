import { getChannelConfiguration } from "../../../../lib/channels/config";
import { handleMetaWebhook } from "../../../../lib/channels/webhook";
import { channels, type Channel } from "../../../../lib/channels/types";
import * as store from "../../../../lib/channels/store";
import { after } from "next/server";
import { scheduleChannelWorkerKickoff } from "../../../../lib/channels/worker-kickoff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
async function handle(req: Request, { params }: { params: Promise<{ channel: string }> }) {
  const requestStartedAt = Date.now();
  const { channel } = await params;
  if (!channels.includes(channel as Channel)) return Response.json({ error: "Channel not found" }, { status: 404 });
  try {
    const configuration = getChannelConfiguration();
    const response = await handleMetaWebhook(req, channel as Channel, configuration, store);
    scheduleChannelWorkerKickoff({ method: req.method, status: response.status, requestStartedAt, configuration, schedule: callback => after(callback) });
    return response;
  }
  catch { return Response.json({ error: "Channel configuration unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
}
export const GET = handle;
export const POST = handle;
