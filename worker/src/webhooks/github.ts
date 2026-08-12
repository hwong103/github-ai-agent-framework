import type { CloudflareEnv } from "../env.ts";
import { getProjectConfig } from "../config.ts";
import { enqueueFeedbackCase } from "../feedback/processor.ts";
import {
  createFeedbackId,
  findGithubFeedbackCase,
  insertGithubFeedbackCase,
} from "../feedback/store.ts";

export class GithubWebhookError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "GithubWebhookError";
    this.status = status;
  }
}

async function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyGithubWebhook(
  env: CloudflareEnv,
  rawBody: string,
  signatureHeader: string | null,
) {
  if (!env.GITHUB_WEBHOOK_SECRET) {
    throw new GithubWebhookError("GitHub webhook secret is not configured.", 500);
  }
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    throw new GithubWebhookError("Missing GitHub webhook signature.");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.GITHUB_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody),
  );
  const expected = `sha256=${await bytesToHex(new Uint8Array(signature))}`;
  const provided = signatureHeader.toLowerCase();
  const a = expected.length === provided.length;
  if (!a) {
    throw new GithubWebhookError("Invalid GitHub webhook signature.");
  }
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ provided.charCodeAt(index);
  }
  if (diff !== 0) {
    throw new GithubWebhookError("Invalid GitHub webhook signature.");
  }
}

function issueHasReadyLabel(labels: Array<{ name?: unknown }>, readyLabel: string) {
  return labels.some((label) => label.name === readyLabel);
}

export async function handleGithubWebhook(
  env: CloudflareEnv,
  request: Request,
): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  const rawBody = await request.text();
  await verifyGithubWebhook(env, rawBody, request.headers.get("x-hub-signature-256"));

  if (!env.DB) {
    return Response.json({ error: "Database is not configured." }, { status: 503 });
  }

  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    throw new GithubWebhookError("Malformed GitHub webhook payload.");
  }

  const payload = event as {
    action?: unknown;
    issue?: { number?: unknown; title?: unknown; body?: unknown; labels?: Array<{ name?: unknown }> };
    repository?: { full_name?: unknown };
  };
  if (
    payload.issue?.number === undefined ||
    typeof payload.repository?.full_name !== "string" ||
    typeof payload.action !== "string"
  ) {
    return Response.json({ ok: true });
  }

  const repo = payload.repository.full_name;
  const issueNumber = Number(payload.issue.number);
  const rawProjects = JSON.parse(env.PROJECTS_JSON ?? "{}") as Record<string, { repo?: string }>;
  const projectId = Object.keys(rawProjects).find((id) => rawProjects[id]?.repo === repo);
  if (!projectId) {
    return Response.json({ ok: true });
  }

  const config = await getProjectConfig(env, projectId);
  const isReadyOpen =
    payload.action === "opened" &&
    issueHasReadyLabel(payload.issue.labels ?? [], config.labels.agentReady);
  const isReadyLabel =
    payload.action === "labeled" &&
    (payload as { label?: { name?: unknown } }).label?.name === config.labels.agentReady;
  if (!isReadyOpen && !isReadyLabel) {
    return Response.json({ ok: true });
  }

  const existing = await findGithubFeedbackCase(env.DB, projectId, issueNumber);
  if (existing) {
    await enqueueFeedbackCase(env, projectId, existing.id);
    return Response.json({ ok: true, feedbackId: existing.id });
  }

  const bodyText = typeof payload.issue.body === "string" ? payload.issue.body : "";
  const title = typeof payload.issue.title === "string" ? payload.issue.title : "";
  const message = [title, bodyText].filter(Boolean).join("\n\n").slice(0, 8000);
  const feedbackId = await createFeedbackId(projectId, `github:${projectId}#${issueNumber}`, `issue-${issueNumber}`);
  await insertGithubFeedbackCase({
    db: env.DB,
    feedbackId,
    projectId,
    issueNumber,
    body: message,
  });
  await enqueueFeedbackCase(env, projectId, feedbackId);
  return Response.json({ ok: true, feedbackId });
}
