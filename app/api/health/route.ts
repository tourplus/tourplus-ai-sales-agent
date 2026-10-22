import { NextResponse } from "next/server";
import { supabase } from "../../../lib/supabase";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    if (!process.env.SUPABASE_ANON_KEY || !process.env.OPENAI_API_KEY) throw new Error();
    const r = await supabase("staff_members?select=user_id&limit=0");
    if (!r.ok) throw new Error();
    return NextResponse.json({ status: "ok", version: "1.4-crm" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ status: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
