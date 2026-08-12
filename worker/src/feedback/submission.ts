import type { CloudflareEnv } from "../env.ts";
import type { ProjectConfig } from "../config.ts";
import { enqueueFeedbackCase } from "./processor.ts";
import {
  countRecentFeedback,
  createFeedbackId,
  createFeedbackRequestHash,
  getFeedbackByClientRequest,
  insertFeedbackCase,
} from "./store.ts";
import type { ParsedFeedbackForm } from "./types.ts";

export class FeedbackServiceUnavailableError extends Error {
  readonly status = 503;

  constructor(message = "Feedback is temporarily unavailable.") {
    super(message);
    this.name = "FeedbackServiceUnavailableError";
  }
}

export class FeedbackConflictError extends Error {
  readonly status = 409;

  constructor() {
    super("This feedback request ID was already used for different content.");
    this.name = "FeedbackConflictError";
  }
}

export class FeedbackRateLimitError extends Error {
  readonly status = 429;

  constructor() {
    super("Too many feedback reports. Please try again later.");
    this.name = "FeedbackRateLimitError";
  }
}

export async function submitFeedback({
  env,
  config,
  userKey,
  form,
}: {
  env: CloudflareEnv;
  config: ProjectConfig;
  userKey: string;
  form: ParsedFeedbackForm;
}) {
  if (!env.DB) {
    throw new FeedbackServiceUnavailableError();
  }

  const requestHash = await createFeedbackRequestHash(form);
  const existing = await getFeedbackByClientRequest(env.DB, config.projectId, userKey, form.clientRequestId);
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new FeedbackConflictError();
    }
    return { feedbackId: existing.id, state: existing.state, duplicate: true as const };
  }

  if (await countRecentFeedback(env.DB, config.projectId, userKey) >= 10) {
    throw new FeedbackRateLimitError();
  }

  const feedbackId = await createFeedbackId(config.projectId, userKey, form.clientRequestId);
  const screenshotKey = form.screenshot
    ? `project/${config.projectId}/${feedbackId}/${requestHash.slice(0, 16)}.${form.screenshot.extension}`
    : null;

  if (form.screenshot) {
    if (!env.FEEDBACK_BUCKET) {
      throw new FeedbackServiceUnavailableError("Screenshot feedback is temporarily unavailable.");
    }
    await env.FEEDBACK_BUCKET.put(screenshotKey!, form.screenshot.bytes, {
      httpMetadata: { contentType: form.screenshot.mediaType },
      customMetadata: { feedbackId, projectId: config.projectId },
    });
  }

  try {
    await insertFeedbackCase({
      db: env.DB,
      feedbackId,
      projectId: config.projectId,
      userKey,
      form,
      screenshotKey,
      requestHash,
    });
  } catch (error) {
    const raced = await getFeedbackByClientRequest(env.DB, config.projectId, userKey, form.clientRequestId).catch(() => null);
    if (raced) {
      if (raced.request_hash !== requestHash) {
        if (screenshotKey && env.FEEDBACK_BUCKET) {
          await env.FEEDBACK_BUCKET.delete(screenshotKey).catch(() => undefined);
        }
        throw new FeedbackConflictError();
      }
      return { feedbackId: raced.id, state: raced.state, duplicate: true as const };
    }
    if (screenshotKey && env.FEEDBACK_BUCKET) {
      await env.FEEDBACK_BUCKET.delete(screenshotKey).catch(() => undefined);
    }
    throw error;
  }

  const queued = await enqueueFeedbackCase(env, config.projectId, feedbackId).catch(() => false);
  return { feedbackId, state: queued ? "queued" as const : "submitted" as const };
}
