import type { CloudflareD1Database } from "../env.ts";
import type { FeedbackCaseRow, ParsedFeedbackForm } from "./types.ts";

function toHex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createFeedbackRequestHash(form: ParsedFeedbackForm) {
  const metadata = new TextEncoder().encode([
    form.message,
    form.pathname,
    form.screenshot?.mediaType ?? "",
    String(form.screenshot?.size ?? 0),
  ].join("\u0000"));
  const screenshot = form.screenshot ? new Uint8Array(form.screenshot.bytes) : new Uint8Array();
  const combined = new Uint8Array(metadata.length + 1 + screenshot.length);
  combined.set(metadata);
  combined[metadata.length] = 0;
  combined.set(screenshot, metadata.length + 1);
  return toHex(await crypto.subtle.digest("SHA-256", combined));
}

export async function createFeedbackId(projectId: string, userKey: string, clientRequestId: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${projectId}\u0000${userKey}\u0000${clientRequestId}`),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `fb_${hex.slice(0, 40)}`;
}

const CASE_COLUMNS = `id, project_id, user_key, client_request_id, request_hash,
  message, pathname, screenshot_key, screenshot_media_type, screenshot_size_bytes,
  state, category, triage_reason, assessment_json, assessment_model,
  policy_version, github_issue_number, github_issue_url`;

export async function getFeedbackByClientRequest(
  db: CloudflareD1Database,
  projectId: string,
  userKey: string,
  clientRequestId: string,
) {
  return db
    .prepare(
      `SELECT ${CASE_COLUMNS}
       FROM feedback_cases
       WHERE project_id = ? AND user_key = ? AND client_request_id = ?
       LIMIT 1`,
    )
    .bind(projectId, userKey, clientRequestId)
    .first<FeedbackCaseRow>();
}

export async function getFeedbackById(db: CloudflareD1Database, feedbackId: string) {
  return db
    .prepare(
      `SELECT ${CASE_COLUMNS}
       FROM feedback_cases
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(feedbackId)
    .first<FeedbackCaseRow>();
}

export async function insertFeedbackCase({
  db,
  feedbackId,
  projectId,
  userKey,
  form,
  screenshotKey,
  requestHash,
}: {
  db: CloudflareD1Database;
  feedbackId: string;
  projectId: string;
  userKey: string;
  form: ParsedFeedbackForm;
  screenshotKey: string | null;
  requestHash: string;
}) {
  await db.batch([
    db
      .prepare(
        `INSERT INTO feedback_cases (
           id, project_id, user_key, client_request_id, request_hash, message, pathname,
           screenshot_key, screenshot_media_type, screenshot_size_bytes, state
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted')`,
      )
      .bind(
        feedbackId,
        projectId,
        userKey,
        form.clientRequestId,
        requestHash,
        form.message,
        form.pathname,
        screenshotKey,
        form.screenshot?.mediaType ?? null,
        form.screenshot?.size ?? null,
      ),
    db
      .prepare(
        `INSERT INTO feedback_jobs (id, feedback_id, kind, status, available_at)
         VALUES (?, ?, 'triage', 'pending', CURRENT_TIMESTAMP)`,
      )
      .bind(`fjob_${feedbackId}`, feedbackId),
    db
      .prepare(
        `INSERT INTO feedback_outbox (id, feedback_id, status, next_attempt_at)
         VALUES (?, ?, 'pending', CURRENT_TIMESTAMP)`,
      )
      .bind(`fout_${feedbackId}`, feedbackId),
  ]);
}

export async function countRecentFeedback(
  db: CloudflareD1Database,
  projectId: string,
  userKey: string,
) {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM feedback_cases
       WHERE project_id = ? AND user_key = ?
         AND datetime(created_at) >= datetime('now', '-1 hour')`,
    )
    .bind(projectId, userKey)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export async function insertGithubFeedbackCase({
  db,
  feedbackId,
  projectId,
  issueNumber,
  body,
}: {
  db: CloudflareD1Database;
  feedbackId: string;
  projectId: string;
  issueNumber: number;
  body: string;
}) {
  await db.batch([
    db
      .prepare(
        `INSERT INTO feedback_cases (
           id, project_id, user_key, client_request_id, request_hash, message, pathname, state
         ) VALUES (?, ?, ?, ?, ?, ?, '/github-issue', 'submitted')`,
      )
      .bind(
        feedbackId,
        projectId,
        `github:${projectId}#${issueNumber}`,
        `issue-${issueNumber}`,
        "0".repeat(64),
        body.slice(0, 8000),
      ),
    db
      .prepare(
        `INSERT INTO feedback_jobs (id, feedback_id, kind, status, available_at)
         VALUES (?, ?, 'triage', 'pending', CURRENT_TIMESTAMP)`,
      )
      .bind(`fjob_${feedbackId}`, feedbackId),
    db
      .prepare(
        `INSERT INTO feedback_outbox (id, feedback_id, status, next_attempt_at)
         VALUES (?, ?, 'pending', CURRENT_TIMESTAMP)`,
      )
      .bind(`fout_${feedbackId}`, feedbackId),
  ]);
}

export async function findGithubFeedbackCase(
  db: CloudflareD1Database,
  projectId: string,
  issueNumber: number,
) {
  return db
    .prepare(
      `SELECT ${CASE_COLUMNS}
       FROM feedback_cases
       WHERE project_id = ? AND github_issue_number = ?
       LIMIT 1`,
    )
    .bind(projectId, issueNumber)
    .first<FeedbackCaseRow>();
}
