import { errorResponse, privateJson, publicStaff, requireStaff } from "../../../../lib/staff-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  try { return privateJson({ user: publicStaff(await requireStaff()) }); }
  catch (error) { return errorResponse(error); }
}
