import type { CloudflareD1Database, CloudflareEnv } from "../env.ts";
import { getProjectConfig } from "../config.ts";
import { assessFeedback, parseFeedbackAssessment } from "./assessment.ts";
import {
  createFeedbackGithubIssue,
  GitHubRepositoryNotPrivateError,
  updateFeedbackGithubIssue,
} from "./github.ts";
import { triageFeedback } from "./policy.ts";
import { getFeedbackById } from "./store.ts";
import type { FeedbackAssessment, FeedbackCaseRow } from "./types.ts";

const LEASE_MINUTES = 10;
const REENQUEUE_SECONDS = 5 * 60;

interface ClaimedFeedbackJob {
  id: string;
  feedback_id: string;
  attempt_count: number;
  max_attempts: number;
  lease_token: string;
}

export interface FeedbackProcessResult {
  state: "complete" | "busy" | "not_ready" | "retry";
  retryAfterSeconds?: number;
}

class FeedbackLeaseLostError extends Error {
  constructor() {
    super("Feedback processing lease was lost.");
    this.name = "FeedbackLeaseLostError";
  }
}

async function renewLease(db: CloudflareD1Database, job: ClaimedFeedbackJob) {
  const renewed = await db
    .prepare(
      `UPDATE feedback_jobs
       SET lease_expires_at = datetime('now', '+' || ? || ' minutes'),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'processing' AND lease_token = ?
         AND datetime(lease_expires_at) > CURRENT_TIMESTAMP
       RETURNING id`,
    )
    .bind(LEASE_MINUTES, job.id, job.lease_token)
    .first<{ id: string }>();
  if (!renewed) {
    throw new FeedbackLeaseLostError();
  }
}

async function markCaseProcessing(db: CloudflareD1Database, job: ClaimedFeedbackJob) {
  const updated = await db
    .prepare(
      `UPDATE feedback_cases
       SET state = 'processing', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND EXISTS (
           SELECT 1 FROM feedback_jobs
           WHERE id = ? AND status = 'processing' AND lease_token = ?
             AND datetime(lease_expires_at) > CURRENT_TIMESTAMP
         )
       RETURNING id`,
    )
    .bind(job.feedback_id, job.id, job.lease_token)
    .first<{ id: string }>();
  if (!updated) {
    throw new FeedbackLeaseLostError();
  }
}

export async function deleteFeedbackScreenshot(
  env: CloudflareEnv,
  job: ClaimedFeedbackJob,
  feedback: FeedbackCaseRow,
) {
  if (!feedback.screenshot_key) {
    return;
  }
  if (!env.DB || !env.FEEDBACK_BUCKET) {
    throw new Error("Feedback screenshot storage is unavailable.");
  }

  await renewLease(env.DB, job);
  await env.FEEDBACK_BUCKET.delete(feedback.screenshot_key);
  const cleared = await env.DB
    .prepare(
      `UPDATE feedback_cases
       SET screenshot_key = NULL, screenshot_media_type = NULL,
           screenshot_size_bytes = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND EXISTS (
           SELECT 1 FROM feedback_jobs
           WHERE id = ? AND status = 'processing' AND lease_token = ?
             AND datetime(lease_expires_at) > CURRENT_TIMESTAMP
         )
       RETURNING id`,
    )
    .bind(feedback.id, job.id, job.lease_token)
    .first<{ id: string }>();
  if (!cleared) {
    throw new FeedbackLeaseLostError();
  }
  feedback.screenshot_key = null;
  feedback.screenshot_media_type = null;
  feedback.screenshot_size_bytes = null;
}

async function claimJob(db: CloudflareD1Database, feedbackId: string) {
  const leaseToken = crypto.randomUUID();
  return db
    .prepare(
      `UPDATE feedback_jobs
       SET status = 'processing',
           attempt_count = attempt_count + 1,
           lease_token = ?,
           lease_expires_at = datetime('now', '+' || ? || ' minutes'),
           last_error = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE feedback_id = ?
         AND attempt_count < max_attempts
         AND (
           (status IN ('pending', 'retry') AND datetime(available_at) <= CURRENT_TIMESTAMP)
           OR (status = 'processing' AND datetime(lease_expires_at) <= CURRENT_TIMESTAMP)
         )
       RETURNING id, feedback_id, attempt_count, max_attempts, lease_token`,
    )
    .bind(leaseToken, LEASE_MINUTES, feedbackId)
    .first<ClaimedFeedbackJob>();
}

async function finishNeedsDiscussion(
  db: CloudflareD1Database,
  job: ClaimedFeedbackJob,
  category: "bug" | "feature" | "other",
  reason: string,
  assessment: FeedbackAssessment | null,
  policyVersion: string,
  assessmentModel: string | null,
  issue?: { number: number; url: string },
) {
  const results = await db.batch([
    db
      .prepare(
        `UPDATE feedback_cases
         SET state = 'needs_discussion', category = ?, triage_reason = ?,
             assessment_json = ?, assessment_model = ?, policy_version = ?,
             github_issue_number = ?, github_issue_url = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND EXISTS (
             SELECT 1 FROM feedback_jobs
             WHERE id = ? AND status = 'processing' AND lease_token = ?
               AND datetime(lease_expires_at) > CURRENT_TIMESTAMP
           )`,
      )
      .bind(
        category,
        reason,
        assessment ? JSON.stringify(assessment) : null,
        assessmentModel,
        policyVersion,
        issue?.number ?? null,
        issue?.url ?? null,
        job.feedback_id,
        job.id,
        job.lease_token,
      ),
    db
      .prepare(
        `UPDATE feedback_outbox
         SET status = 'completed', last_error = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE feedback_id = ?
           AND EXISTS (
             SELECT 1 FROM feedback_jobs
             WHERE id = ? AND status = 'processing' AND lease_token = ?
               AND datetime(lease_expires_at) > CURRENT_TIMESTAMP
           )`,
      )
      .bind(job.feedback_id, job.id, job.lease_token),
    db
      .prepare(
        `UPDATE feedback_jobs
         SET status = 'completed', lease_token = NULL, lease_expires_at = NULL,
             completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'processing' AND lease_token = ?
           AND datetime(lease_expires_at) > CURRENT_TIMESTAMP`,
      )
      .bind(job.id, job.lease_token),
  ]);
  if (Number(results[2]?.meta?.changes ?? 0) !== 1) {
    throw new FeedbackLeaseLostError();
  }
}

async function finishIssueCreated(
  db: CloudflareD1Database,
  job: ClaimedFeedbackJob,
  category: "bug" | "feature" | "other",
  reason: string,
  issue: { number: number; url: string },
  assessment: FeedbackAssessment | null,
  policyVersion: string,
  assessmentModel: string | null,
) {
  const results = await db.batch([
    db
      .prepare(
        `UPDATE feedback_cases
         SET state = 'issue_created', category = ?, triage_reason = ?,
             assessment_json = ?, assessment_model = ?, policy_version = ?,
             github_issue_number = ?, github_issue_url = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND EXISTS (
             SELECT 1 FROM feedback_jobs
             WHERE id = ? AND status = 'processing' AND lease_token = ?
               AND datetime(lease_expires_at) > CURRENT_TIMESTAMP
           )`,
      )
      .bind(
        category,
        reason,
        assessment ? JSON.stringify(assessment) : null,
        assessmentModel,
        policyVersion,
        issue.number,
        issue.url,
        job.feedback_id,
        job.id,
        job.lease_token,
      ),
    db
      .prepare(
        `UPDATE feedback_outbox
         SET status = 'completed', last_error = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE feedback_id = ?
           AND EXISTS (
             SELECT 1 FROM feedback_jobs
             WHERE id = ? AND status = 'processing' AND lease_token = ?
               AND datetime(lease_expires_at) > CURRENT_TIMESTAMP
           )`,
      )
      .bind(job.feedback_id, job.id, job.lease_token),
    db
      .prepare(
        `UPDATE feedback_jobs
         SET status = 'completed', lease_token = NULL, lease_expires_at = NULL,
             completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'processing' AND lease_token = ?
           AND datetime(lease_expires_at) > CURRENT_TIMESTAMP`,
      )
      .bind(job.id, job.lease_token),
  ]);
  if (Number(results[2]?.meta?.changes ?? 0) !== 1) {
    throw new FeedbackLeaseLostError();
  }
}

async function releaseForRetry(
  env: CloudflareEnv,
  job: ClaimedFeedbackJob,
  error: unknown,
  feedback?: FeedbackCaseRow | null,
) {
  const terminal = job.attempt_count >= job.max_attempts;
  const delaySeconds = Math.min(30 * 2 ** Math.max(job.attempt_count - 1, 0), 3600);
  const errorMessage = (error instanceof Error ? error.message : String(error)).slice(0, 500);

  if (terminal && feedback?.screenshot_key) {
    await deleteFeedbackScreenshot(env, job, feedback);
  }

  const db = env.DB!;
  const results = await db.batch([
    db
      .prepare(
        `UPDATE feedback_cases
         SET state = ?,
             triage_reason = CASE WHEN ? = 1 THEN 'automation_attempts_exhausted' ELSE triage_reason END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND EXISTS (
             SELECT 1 FROM feedback_jobs
             WHERE id = ? AND status = 'processing' AND lease_token = ?
               AND datetime(lease_expires_at) > CURRENT_TIMESTAMP
           )`,
      )
      .bind(
        terminal ? "needs_discussion" : "queued",
        terminal ? 1 : 0,
        job.feedback_id,
        job.id,
        job.lease_token,
      ),
    db
      .prepare(
        `UPDATE feedback_outbox
         SET status = ?, next_attempt_at = datetime('now', '+' || ? || ' seconds'),
             last_error = ?, updated_at = CURRENT_TIMESTAMP
         WHERE feedback_id = ?
           AND EXISTS (
             SELECT 1 FROM feedback_jobs
             WHERE id = ? AND status = 'processing' AND lease_token = ?
               AND datetime(lease_expires_at) > CURRENT_TIMESTAMP
           )`,
      )
      .bind(
        terminal ? "completed" : "pending",
        delaySeconds,
        errorMessage,
        job.feedback_id,
        job.id,
        job.lease_token,
      ),
    db
      .prepare(
        `UPDATE feedback_jobs
         SET status = ?,
             available_at = datetime('now', '+' || ? || ' seconds'),
             lease_token = NULL,
             lease_expires_at = NULL,
             last_error = ?,
             updated_at = CURRENT_TIMESTAMP,
             completed_at = CASE WHEN ? = 'failed' THEN CURRENT_TIMESTAMP ELSE completed_at END
         WHERE id = ? AND status = 'processing' AND lease_token = ?
           AND datetime(lease_expires_at) > CURRENT_TIMESTAMP`,
      )
      .bind(
        terminal ? "failed" : "retry",
        delaySeconds,
        errorMessage,
        terminal ? "failed" : "retry",
        job.id,
        job.lease_token,
      ),
  ]);

  const released = Number(results[2]?.meta?.changes ?? 0) === 1;
  return { retryAfterSeconds: terminal ? null : delaySeconds, released };
}

export async function processFeedbackCase(
  env: CloudflareEnv,
  projectId: string,
  feedbackId: string,
): Promise<FeedbackProcessResult> {
  if (!env.DB) {
    return { state: "retry", retryAfterSeconds: 60 };
  }

  const job = await claimJob(env.DB, feedbackId);
  if (!job) {
    const existing = await env.DB
      .prepare(`SELECT status, available_at FROM feedback_jobs WHERE feedback_id = ? LIMIT 1`)
      .bind(feedbackId)
      .first<{ status: string; available_at: string }>();
    if (!existing || existing.status === "completed" || existing.status === "failed") {
      return { state: "complete" };
    }
    return existing.status === "processing" ? { state: "busy" } : { state: "not_ready" };
  }

  let feedback: FeedbackCaseRow | null = null;
  try {
    await markCaseProcessing(env.DB, job);
    feedback = await getFeedbackById(env.DB, feedbackId);
    if (!feedback) {
      throw new Error("Feedback case was not found.");
    }
    const config = await getProjectConfig(env, projectId);
    const assessment = feedback.assessment_json
      ? parseFeedbackAssessment(feedback.assessment_json)
      : await assessFeedback(env, config, feedback);
    const triage = triageFeedback(config, feedback.message, assessment);
    const assessmentModel = assessment ? config.assessmentModel : null;

    if (assessment && !feedback.assessment_json) {
      await renewLease(env.DB, job);
      const saved = await env.DB
        .prepare(
          `UPDATE feedback_cases
           SET assessment_json = ?, assessment_model = ?, policy_version = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?
             AND EXISTS (
               SELECT 1 FROM feedback_jobs
               WHERE id = ? AND status = 'processing' AND lease_token = ?
                 AND datetime(lease_expires_at) > CURRENT_TIMESTAMP
             )
           RETURNING id`,
        )
        .bind(
          JSON.stringify(assessment),
          assessmentModel,
          config.policyVersion,
          feedbackId,
          job.id,
          job.lease_token,
        )
        .first<{ id: string }>();
      if (!saved) {
        throw new FeedbackLeaseLostError();
      }
      feedback.assessment_json = JSON.stringify(assessment);
      feedback.assessment_model = assessmentModel;
      feedback.policy_version = config.policyVersion;
    }
    if (assessment) {
      await deleteFeedbackScreenshot(env, job, feedback);
    }

    const persistTerminal = async (issue?: { number: number; url: string }) => {
      if (triage.decision === "needs_discussion") {
        await finishNeedsDiscussion(
          env.DB!,
          job,
          triage.category,
          triage.reason,
          assessment,
          config.policyVersion,
          assessmentModel,
          issue,
        );
      } else {
        await finishIssueCreated(
          env.DB!,
          job,
          triage.category,
          triage.reason,
          issue!,
          assessment,
          config.policyVersion,
          assessmentModel,
        );
      }
    };

    if (feedback.github_issue_number && feedback.github_issue_url) {
      await renewLease(env.DB, job);
      let issue;
      try {
        issue = await updateFeedbackGithubIssue({
          env,
          config,
          issue: {
            number: feedback.github_issue_number,
            url: feedback.github_issue_url,
          },
          feedback,
          triage,
        });
      } catch (error) {
        if (!(error instanceof GitHubRepositoryNotPrivateError)) {
          throw error;
        }
        await finishNeedsDiscussion(
          env.DB,
          job,
          triage.category,
          "github_repository_not_private",
          assessment,
          config.policyVersion,
          assessmentModel,
        );
        return { state: "complete" };
      }
      await persistTerminal(issue);
      return { state: "complete" };
    }

    await renewLease(env.DB, job);
    let issue;
    try {
      issue = await createFeedbackGithubIssue({
        env,
        config,
        feedback,
        triage,
        beforeCreate: () => renewLease(env.DB!, job),
      });
    } catch (error) {
      if (!(error instanceof GitHubRepositoryNotPrivateError)) {
        throw error;
      }
      await finishNeedsDiscussion(
        env.DB,
        job,
        triage.category,
        "github_repository_not_private",
        assessment,
        config.policyVersion,
        assessmentModel,
      );
      return { state: "complete" };
    }
    await persistTerminal(issue);
    return { state: "complete" };
  } catch (error) {
    if (error instanceof FeedbackLeaseLostError) {
      return { state: "busy" };
    }
    const released = await releaseForRetry(env, job, error, feedback);
    if (!released.released) {
      return { state: "busy" };
    }
    if (released.retryAfterSeconds === null) {
      return { state: "complete" };
    }
    return { state: "retry", retryAfterSeconds: released.retryAfterSeconds };
  }
}

export async function enqueueFeedbackCase(env: CloudflareEnv, projectId: string, feedbackId: string) {
  if (!env.DB || !env.FEEDBACK_QUEUE) {
    return false;
  }
  const ready = await env.DB
    .prepare(
      `SELECT outbox.feedback_id
       FROM feedback_outbox outbox
       JOIN feedback_jobs job ON job.feedback_id = outbox.feedback_id
       WHERE outbox.feedback_id = ?
         AND outbox.status IN ('pending', 'enqueued')
         AND job.status IN ('pending', 'retry')
         AND datetime(job.available_at) <= CURRENT_TIMESTAMP
       LIMIT 1`,
    )
    .bind(feedbackId)
    .first<{ feedback_id: string }>();
  if (!ready) {
    return false;
  }

  await env.FEEDBACK_QUEUE.send({ projectId, feedbackId }, { contentType: "json" });
  await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE feedback_outbox
         SET status = 'enqueued', attempt_count = attempt_count + 1,
             next_attempt_at = datetime('now', '+' || ? || ' seconds'),
             last_error = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE feedback_id = ? AND status IN ('pending', 'enqueued')`,
      )
      .bind(REENQUEUE_SECONDS, feedbackId),
    env.DB
      .prepare(
        `UPDATE feedback_cases SET state = 'queued', updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND state = 'submitted'`,
      )
      .bind(feedbackId),
  ]);
  return true;
}

export async function enqueuePendingFeedback(env: CloudflareEnv, limit = 100) {
  if (!env.DB || !env.FEEDBACK_QUEUE) {
    return 0;
  }
  const pending = await env.DB
    .prepare(
      `SELECT outbox.feedback_id, feedback_cases.project_id
       FROM feedback_outbox outbox
       JOIN feedback_jobs job ON job.feedback_id = outbox.feedback_id
       JOIN feedback_cases ON feedback_cases.id = outbox.feedback_id
       WHERE outbox.status IN ('pending', 'enqueued')
         AND datetime(outbox.next_attempt_at) <= CURRENT_TIMESTAMP
         AND job.status IN ('pending', 'retry')
         AND datetime(job.available_at) <= CURRENT_TIMESTAMP
       ORDER BY datetime(outbox.next_attempt_at), datetime(outbox.created_at)
       LIMIT ?`,
    )
    .bind(Math.min(Math.max(Math.trunc(limit), 1), 100))
    .all<{ feedback_id: string; project_id: string }>();
  const rows = pending.results ?? [];
  if (rows.length === 0) {
    return 0;
  }
  await env.FEEDBACK_QUEUE.sendBatch(
    rows.map((row) => ({
      body: { projectId: row.project_id, feedbackId: row.feedback_id },
      contentType: "json" as const,
    })),
  );
  await env.DB.batch(
    rows.map((row) => env.DB!
      .prepare(
        `UPDATE feedback_outbox
         SET status = 'enqueued', attempt_count = attempt_count + 1,
             next_attempt_at = datetime('now', '+' || ? || ' seconds'),
             last_error = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE feedback_id = ? AND status IN ('pending', 'enqueued')`,
      )
      .bind(REENQUEUE_SECONDS, row.feedback_id)),
  );
  return rows.length;
}

export async function recoverFeedbackJobs(env: CloudflareEnv) {
  if (!env.DB) {
    return 0;
  }
  await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE feedback_jobs
         SET status = 'failed',
             lease_token = NULL, lease_expires_at = NULL,
             last_error = 'processing_lease_expired_attempts_exhausted',
             completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE attempt_count >= max_attempts
           AND (
             status IN ('pending', 'retry')
             OR (status = 'processing' AND datetime(lease_expires_at) <= CURRENT_TIMESTAMP)
           )`,
      ),
    env.DB
      .prepare(
        `UPDATE feedback_cases
         SET state = 'needs_discussion', triage_reason = 'automation_attempts_exhausted',
             updated_at = CURRENT_TIMESTAMP
         WHERE state NOT IN ('issue_created', 'needs_discussion')
           AND EXISTS (
             SELECT 1 FROM feedback_jobs job
             WHERE job.feedback_id = feedback_cases.id
               AND job.status = 'failed'
               AND job.last_error = 'processing_lease_expired_attempts_exhausted'
           )`,
      ),
    env.DB
      .prepare(
        `UPDATE feedback_outbox
         SET status = 'completed',
             last_error = 'processing_lease_expired_attempts_exhausted',
             updated_at = CURRENT_TIMESTAMP
         WHERE status != 'completed'
           AND EXISTS (
             SELECT 1 FROM feedback_jobs job
             WHERE job.feedback_id = feedback_outbox.feedback_id
               AND job.status = 'failed'
               AND job.last_error = 'processing_lease_expired_attempts_exhausted'
           )`,
      ),
    env.DB
      .prepare(
        `UPDATE feedback_jobs
         SET status = 'retry', available_at = CURRENT_TIMESTAMP,
             lease_token = NULL, lease_expires_at = NULL,
             last_error = 'processing_lease_expired', updated_at = CURRENT_TIMESTAMP
         WHERE status = 'processing'
           AND attempt_count < max_attempts
           AND datetime(lease_expires_at) <= CURRENT_TIMESTAMP`,
      ),
    env.DB
      .prepare(
        `UPDATE feedback_cases
         SET state = 'queued', updated_at = CURRENT_TIMESTAMP
         WHERE state = 'processing'
           AND EXISTS (
             SELECT 1 FROM feedback_jobs job
             WHERE job.feedback_id = feedback_cases.id AND job.status = 'retry'
           )`,
      ),
    env.DB
      .prepare(
        `UPDATE feedback_outbox
         SET status = 'pending', next_attempt_at = CURRENT_TIMESTAMP,
             last_error = 'processing_lease_expired', updated_at = CURRENT_TIMESTAMP
         WHERE status != 'completed'
           AND EXISTS (
             SELECT 1 FROM feedback_jobs job
             WHERE job.feedback_id = feedback_outbox.feedback_id AND job.status = 'retry'
           )`,
      ),
  ]);

  const exhaustedScreenshots = await env.DB
    .prepare(
      `SELECT fc.id AS feedback_id, fc.screenshot_key
       FROM feedback_cases fc
       JOIN feedback_jobs job ON job.feedback_id = fc.id
       WHERE job.status = 'failed'
         AND job.last_error = 'processing_lease_expired_attempts_exhausted'
         AND fc.screenshot_key IS NOT NULL`,
    )
    .all<{ feedback_id: string; screenshot_key: string }>();
  for (const row of exhaustedScreenshots.results ?? []) {
    try {
      if (env.FEEDBACK_BUCKET) {
        await env.FEEDBACK_BUCKET.delete(row.screenshot_key);
      }
      await env.DB.prepare(
        `UPDATE feedback_cases
         SET screenshot_key = NULL, screenshot_media_type = NULL,
             screenshot_size_bytes = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND screenshot_key IS NOT NULL`,
      )
        .bind(row.feedback_id)
        .run();
    } catch (error) {
      console.error(JSON.stringify({
        event: "feedback_exhausted_screenshot_cleanup_failed",
        feedbackId: row.feedback_id,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  return enqueuePendingFeedback(env);
}
