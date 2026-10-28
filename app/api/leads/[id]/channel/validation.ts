import { isUuid, RequestError } from "../../../../../lib/staff-auth";

export type ChannelAction =
  | { action: "reply"; conversationId: string; idempotencyKey: string; text: string; template?: { name: string; language: string; parameters: string[] } }
  | { action: "approve_draft"; outboxId: string }
  | { action: "new_enquiry"; conversationId: string };

export function channelAction(body: Record<string, unknown>): ChannelAction {
  if (body.action === "approve_draft") {
    if (Object.keys(body).some(key => !["action", "outboxId"].includes(key)) || !isUuid(body.outboxId)) throw new RequestError(400, "Select a valid message draft");
    return { action: "approve_draft", outboxId: body.outboxId };
  }
  if (body.action === "new_enquiry") {
    if (Object.keys(body).some(key => !["action", "conversationId"].includes(key)) || !isUuid(body.conversationId)) throw new RequestError(400, "Select a valid conversation");
    return { action: "new_enquiry", conversationId: body.conversationId };
  }
  if (body.action !== "reply" || Object.keys(body).some(key => !["action", "conversationId", "idempotencyKey", "text", "template"].includes(key)) || !isUuid(body.conversationId) || !isUuid(body.idempotencyKey)) throw new RequestError(400, "Invalid reply request");
  if (body.template !== undefined) {
    if (body.text !== undefined || !body.template || typeof body.template !== "object" || Array.isArray(body.template)) throw new RequestError(400, "Choose a text reply or an approved template");
    const template = body.template as Record<string, unknown>;
    if (Object.keys(template).some(key => !["name", "language", "parameters"].includes(key)) || typeof template.name !== "string" || !/^[a-z0-9_]{1,128}$/.test(template.name) || typeof template.language !== "string" || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(template.language) || !Array.isArray(template.parameters) || template.parameters.length > 20 || template.parameters.some(value => typeof value !== "string" || !value.trim() || value.length > 1000 || /[\u0000-\u001f\u007f]/.test(value))) throw new RequestError(400, "Invalid approved template fields");
    return { action: "reply", conversationId: body.conversationId, idempotencyKey: body.idempotencyKey, text: "", template: { name: template.name, language: template.language, parameters: template.parameters as string[] } };
  }
  if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.text)) throw new RequestError(400, "Reply must contain 1 to 4000 characters");
  return { action: "reply", conversationId: body.conversationId, idempotencyKey: body.idempotencyKey, text: body.text.trim() };
}
