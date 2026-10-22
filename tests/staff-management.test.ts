import test from "node:test";
import assert from "node:assert/strict";
import { staffChange, staffInvitation, StaffValidationError } from "../lib/staff-management-validation";

test("staff invitations require an explicit email, protected role and delivery mode", () => {
  assert.deepEqual(staffInvitation({ email: " Sales@Example.com ", role: "sales", mode: "link", display_name: " Sales Team " }), { email: "sales@example.com", role: "sales", mode: "link", display_name: "Sales Team", resend: false });
  for (const body of [{ email: "x@example.com", role: "owner", mode: "link" }, { email: "x@example.com", role: "admin" }, { email: "bad@example.com\r\nBcc: x@example.com", role: "sales", mode: "email" }, { email: "x@example.com", role: "sales", mode: "link", user_id: "replace-existing" }, { email: "x@example.com", role: "sales", mode: "link", resend: "true" }]) assert.throws(() => staffInvitation(body), StaffValidationError);
});

test("staff updates are strict partial changes without account or credential fields", () => {
  assert.deepEqual(staffChange({ active: false, display_name: " " }), { active: false, display_name: null });
  assert.deepEqual(staffChange({ role: "admin" }), { role: "admin" });
  for (const body of [{}, { active: "false" }, { role: "Admin" }, { email: "change@example.com" }, { password: "replacement" }, { display_name: "x".repeat(201) }, { display_name: "x\u0000y" }]) assert.throws(() => staffChange(body), StaffValidationError);
});
