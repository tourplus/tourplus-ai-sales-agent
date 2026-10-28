import { getChannelConfiguration } from "../../../../lib/channels/config";
import { handleMetaWebhook } from "../../../../lib/channels/webhook";
import { channels, type Channel } from "../../../../lib/channels/types";
import * as store from "../../../../lib/channels/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
async function handle(req: Request, { params }: { params: Promise<{ channel: string }> }) {
  const { channel } = await params;
  if (!channels.includes(channel as Channel)) return Response.json({ error: "Channel not found" }, { status: 404 });
  try { return await handleMetaWebhook(req, channel as Channel, getChannelConfiguration(), store); }
  catch { return Response.json({ error: "Channel configuration unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
}
export const GET = handle;
export const POST = handle;
