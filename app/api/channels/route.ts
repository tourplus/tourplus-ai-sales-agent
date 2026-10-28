import { safeChannelHealth } from "../../../lib/channels/config";
import { errorResponse, privateJson } from "../../../lib/staff-auth";
import { requireAdmin } from "../../../lib/staff-management";

export const dynamic = "force-dynamic";
export async function GET() {
  try {
    await requireAdmin();
    return privateJson({ ...safeChannelHealth(), verification: "configuration_only" });
  } catch (error) { return errorResponse(error); }
}
