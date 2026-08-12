import type { CloudflareEnv } from "./env.ts";
import { getProjectConfig } from "./config.ts";
import { FeedbackBodyTooLargeError, readBoundedFeedbackFormData } from "./feedback/body.ts";
import { submitFeedback } from "./feedback/submission.ts";
import {
  FeedbackConflictError,
  FeedbackRateLimitError,
  FeedbackServiceUnavailableError,
} from "./feedback/submission.ts";
import { FeedbackValidationError, parseFeedbackFormData } from "./feedback/validation.ts";
import { handleFeedbackQueue, handleFeedbackRecovery } from "./queue.ts";
import type { FeedbackQueueBatch } from "./queue.ts";
import { GithubWebhookError, handleGithubWebhook } from "./webhooks/github.ts";

const MAX_FEEDBACK_MULTIPART_BYTES = 4 * 1024 * 1024 + 64 * 1024;

function projectTokenMatches(env: CloudflareEnv, projectId: string, token: string | null) {
  if (!token) {
    return false;
  }
  const tokens = JSON.parse(env.PROJECTS_JSON ?? "{}") as Record<string, { token?: string }>;
  return tokens[projectId]?.token === token;
}

async function handleFeedbackSubmission(env: CloudflareEnv, request: Request) {
  const projectId = request.headers.get("x-project-id");
  if (!projectId || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(projectId)) {
    return Response.json({ error: "Unknown project." }, { status: 404 });
  }
  if (!projectTokenMatches(env, projectId, request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null)) {
    return Response.json({ error: "Unauthorized project." }, { status: 401 });
  }

  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    return Response.json({ error: "Expected multipart form data." }, { status: 400 });
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_FEEDBACK_MULTIPART_BYTES) {
    return Response.json({ error: "Feedback upload is too large." }, { status: 400 });
  }

  try {
    let formData: FormData;
    try {
      formData = await readBoundedFeedbackFormData(request, MAX_FEEDBACK_MULTIPART_BYTES);
    } catch (error) {
      if (error instanceof FeedbackBodyTooLargeError) {
        throw error;
      }
      throw new FeedbackValidationError("Malformed multipart form data.");
    }
    const config = await getProjectConfig(env, projectId);
    const form = await parseFeedbackFormData(config, formData);
    const userKey = request.headers.get("x-user-key");
    if (!userKey || userKey.length > 256) {
      return Response.json({ error: "Missing user context." }, { status: 401 });
    }

    const result = await submitFeedback({ env, config, userKey, form });
    const duplicate = "duplicate" in result && result.duplicate;
    return Response.json(result, { status: duplicate ? 200 : 202 });
  } catch (error) {
    if (
      error instanceof FeedbackValidationError ||
      error instanceof FeedbackServiceUnavailableError ||
      error instanceof FeedbackConflictError ||
      error instanceof FeedbackRateLimitError ||
      error instanceof FeedbackBodyTooLargeError
    ) {
      const status = error instanceof FeedbackBodyTooLargeError ? 400 : error.status;
      return Response.json({ error: error.message }, { status });
    }
    console.error(JSON.stringify({
      event: "feedback_submission_failed",
      projectId,
      error: error instanceof Error ? error.message : String(error),
    }));
    return Response.json({ error: "Could not submit feedback. Please try again." }, { status: 500 });
  }
}

const worker = {
  async fetch(request: Request, env: CloudflareEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/feedback") {
      return handleFeedbackSubmission(env, request);
    }
    if (url.pathname === "/api/webhooks/github") {
      try {
        return await handleGithubWebhook(env, request);
      } catch (error) {
        if (error instanceof GithubWebhookError) {
          return Response.json({ error: error.message }, { status: error.status });
        }
        console.error(JSON.stringify({
          event: "github_webhook_failed",
          error: error instanceof Error ? error.message : String(error),
        }));
        return Response.json({ error: "Webhook processing failed." }, { status: 500 });
      }
    }
    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  },

  async queue(batch: FeedbackQueueBatch, env: CloudflareEnv) {
    if (batch.queue === env.FEEDBACK_QUEUE_NAME) {
      await handleFeedbackQueue(batch, env);
      return;
    }
    for (const message of batch.messages) {
      message.retry({ delaySeconds: 300 });
    }
  },

  async scheduled(_event: { cron?: string }, env: CloudflareEnv, ctx: { waitUntil: (promise: Promise<unknown>) => void }) {
    ctx.waitUntil(handleFeedbackRecovery(env));
  },
};

export default worker;
