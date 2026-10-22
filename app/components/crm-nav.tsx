"use client";
import { usePathname } from "next/navigation";
export default function CrmNav({ role }: { role?: "admin" | "sales" }) {
  const path = usePathname();
  const links = [{ href: "/dashboard", label: "Leads" }, { href: "/dashboard/followups", label: "Follow-ups" }, ...(role === "admin" ? [{ href: "/dashboard/team", label: "Staff management" }] : [])];
  return <nav className="crm-nav" aria-label="CRM navigation">{links.map(link => <a key={link.href} href={link.href} aria-current={path === link.href ? "page" : undefined}>{link.label}</a>)}</nav>;
}
