import type { CloudflareEnv } from "./env.ts";
import { processFeedbackCase, recoverFeedbackJobs } from "./feedback/processor.ts";

interface FeedbackQueueMessage {
  readonly body: unknown;
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface FeedbackQueueBatch {
  readonly queue: string;
  readonly messages: readonly FeedbackQueueMessage[];
}

export function getFeedbackQueueBody(body: unknown) {
  if (!body || typeof body !== "object") {
    return null;
  }
  const candidate = body as { projectId?: unknown; feedbackId?: unknown };
  if (
    typeof candidate.projectId !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(candidate.projectId) ||
    typeof candidate.feedbackId !== "string" ||
    !/^fb_[a-f0-9]{40}$/.test(candidate.feedbackId)
  ) {
    return null;
  }
  return { projectId: candidate.projectId, feedbackId: candidate.feedbackId };
}

export async function handleFeedbackQueue(batch: FeedbackQueueBatch, env: CloudflareEnv) {
  for (const message of batch.messages) {
    const parsed = getFeedbackQueueBody(message.body);
    if (!parsed) {
      message.ack();
      continue;
    }
    try {
      const result = await processFeedbackCase(env, parsed.projectId, parsed.feedbackId);
      if (result.state === "retry") {
        message.retry({
          delaySeconds: result.retryAfterSeconds ?? Math.min(30 * 2 ** message.attempts, 3600),
        });
      } else if (result.state === "busy") {
        message.retry({ delaySeconds: 30 });
      } else if (result.state === "not_ready") {
        message.retry({ delaySeconds: 60 });
      } else {
        message.ack();
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: "feedback_queue_failed",
        projectId: parsed.projectId,
        feedbackId: parsed.feedbackId,
        error: error instanceof Error ? error.message : String(error),
      }));
      message.retry({ delaySeconds: Math.min(30 * 2 ** message.attempts, 3600) });
    }
  }
}

export async function handleFeedbackRecovery(env: CloudflareEnv) {
  try {
    await recoverFeedbackJobs(env);
  } catch (error) {
    console.error(JSON.stringify({
      event: "feedback_recovery_failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}
