import { randomUUID } from "node:crypto";
import type * as Store from "./store";
import type { ChannelAccount, OutgoingMessage, SendResult } from "./types";

export type ChannelWorkerStore = {
  configureChannelAccount(config: Store.ChannelAccountConfiguration): Promise<unknown>;
  claimAIJobs(workerId: string, limit?: number, leaseSeconds?: number): Promise<Store.AIClaim[]>;
  finishAIJob(jobId: string, leaseToken: string, result: { text: string; expectedLeadUpdatedAt: string; fields?: Record<string, unknown> }): Promise<unknown>;
  failAIJob(jobId: string, leaseToken: string, result: { errorCode: string; retryable?: boolean }): Promise<unknown>;
  claimOutbound(workerId: string, limit?: number, leaseSeconds?: number): Promise<Store.OutboundClaim[]>;
  prepareOutbound(outboxId: string, leaseToken: string): Promise<Store.PreparedOutbound | { state: "cancelled" | "failed" }>;
  finishOutbound(outboxId: string, leaseToken: string, result: Store.SendResult): Promise<unknown>;
};
export type AIProposal = { text: string; fields?: Record<string, unknown> };
export type ChannelWorkerOptions = {
  store: ChannelWorkerStore; accounts: ChannelAccount[];
  send: (account: ChannelAccount, message: OutgoingMessage) => Promise<SendResult>;
  generateAI: (job: Store.AIClaim, account: ChannelAccount) => Promise<AIProposal>;
  now?: () => number;
};
export function createChannelWorker(options: ChannelWorkerOptions) {
  const { store, accounts } = options;
  const now = options.now || Date.now;
  return { async run({ limit = 2, workerId = randomUUID() }: { limit?: number; workerId?: string } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5 || workerId.length > 100) throw new Error("Invalid worker options");
    const result = { ai: 0, sent: 0, retried: 0, failed: 0, unknown: 0, skipped: 0 }, deadline = now() + 45000;
    for (const account of accounts) await store.configureChannelAccount({ channel: account.channel, accountId: account.accountId,
      enabled: account.enabled && account.mode !== "disabled" && !!account.appSecret && !!account.verifyToken,
      aiMode: account.aiMode, approvedTemplates: account.templates });
    const ai = await store.claimAIJobs(workerId, 1, 90);
    for (const job of ai) {
      const account = accounts.find(item => item.channel === job.channel && item.accountId === job.accountId && item.enabled && item.mode !== "disabled" && item.aiMode !== "off");
      if (!account || now() >= deadline) { await store.failAIJob(job.jobId, job.leaseToken, { errorCode: "ai_not_enabled", retryable: false }); result.skipped++; continue; }
      try {
        const proposal = await options.generateAI(job, account);
        await store.finishAIJob(job.jobId, job.leaseToken, { ...proposal, expectedLeadUpdatedAt: job.expectedLeadUpdatedAt }); result.ai++;
      } catch {
        await store.failAIJob(job.jobId, job.leaseToken, { errorCode: "ai_generation_failed", retryable: true }); result.failed++;
      }
    }
    for (let index = 0; index < limit && now() < deadline; index++) {
      const claims = await store.claimOutbound(workerId, 1, 90);
      if (!claims.length) break;
      const claim = claims[0];
      const prepared = await store.prepareOutbound(claim.outboxId, claim.leaseToken);
      if (!("outboxId" in prepared)) { result.skipped++; continue; }
      const account = accounts.find(item => item.channel === prepared.channel && item.accountId === prepared.accountId && item.enabled && item.mode !== "disabled");
      let sent: SendResult;
      if (!account || now() >= deadline) sent = { state: "failed", errorCode: "connection_not_ready" };
      else {
        try { sent = await options.send(account, { recipientId: prepared.recipientId, text: prepared.template ? undefined : prepared.text, template: prepared.template || undefined, clientReference: prepared.clientReference }); }
        catch { sent = { state: "unknown", errorCode: "provider_outcome_unknown" }; }
      }
      // A failure after prepare has transitioned to sending is never retried
      // blindly. If persistence fails, its expired sending lease becomes unknown.
      await store.finishOutbound(claim.outboxId, claim.leaseToken, { ...sent, state: sent.state === "retry" ? "rate_limited" : sent.state });
      if (sent.state === "sent") result.sent++;
      else if (sent.state === "retry") result.retried++;
      else if (sent.state === "unknown") result.unknown++;
      else result.failed++;
    }
    return result;
  } };
}
