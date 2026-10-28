import { redirect } from "next/navigation";
import { staffUser } from "../../../lib/staff-auth";
import ChannelHealth from "./channel-health";

export const dynamic = "force-dynamic";
export default async function ChannelPage() {
  const staff = await staffUser();
  if (!staff) redirect("/staff/login?refresh=1");
  if (staff.role !== "admin") return <main><a href="/dashboard">← Dashboard</a><h1>Admin access required</h1><p>Only an active Admin can view channel connection setup.</p></main>;
  return <ChannelHealth />;
}
