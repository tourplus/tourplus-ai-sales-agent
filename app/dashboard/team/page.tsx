import { redirect } from "next/navigation";
import { staffUser } from "../../../lib/staff-auth";
import TeamManager from "./team-manager";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const staff = await staffUser();
  if (!staff) redirect("/staff/login?refresh=1");
  if (staff.role !== "admin") return <main><a href="/dashboard">← Dashboard</a><h1>Admin access required</h1><p>Only an active Admin can manage staff access.</p></main>;
  return <TeamManager currentUserId={staff.id} />;
}
