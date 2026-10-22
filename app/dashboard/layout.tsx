import { redirect } from "next/navigation";
import { staffRequired } from "../../lib/staff-auth";
export const dynamic = "force-dynamic";
export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  if (!(await staffRequired())) redirect("/staff/login?refresh=1");
  return <>{children}</>;
}
