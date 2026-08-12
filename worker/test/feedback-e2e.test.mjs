import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { enqueueFeedbackCase, processFeedbackCase } from "../src/feedback/processor.ts";
import { submitFeedback } from "../src/feedback/submission.ts";
import { getProjectConfig } from "../src/config.ts";
import { handleGithubWebhook } from "../src/webhooks/github.ts";

const PROJECTS_JSON = JSON.stringify({
  "my-app": {
    projectId: "my-app",
    repo: "owner/my-app",
    defaultBranch: "main",
    productName: "My App",
    policyVersion: "2026-08-12.1",
    assessmentModel: "@cf/meta/llama-4-scout-17b-16e-instruct",
    staticPaths: ["/", "/profile"],
    dynamicPathPatterns: [],
    riskTerms: ["balance", "settlement", "payment", "migration", "delete"],
    microfixTerms: ["typo", "tooltip", "copy", "text"],
    uiLocationTerms: ["button", "page", "profile"],
    token: "test-project-token"
  }
});

class D1FromSqlite {
  constructor(db) {
    this.db = db;
  }

  prepare(query) {
    const statement = this.db.prepare(query);
    let params = [];
    return {
      bind(...values) {
        params = values;
        return this;
      },
      async first() {
        return statement.get(...params) ?? null;
      },
      async all() {
        return { results: statement.all(...params) ?? [], success: true };
      },
      async run() {
        const result = statement.run(...params);
        return { success: true, meta: { changes: Number(result.changes ?? 0) } };
      },
    };
  }

  async batch(statements) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

async function openDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(await readFile(new URL("../d1/0001_feedback_automation.sql", import.meta.url), "utf8"));
  return db;
}

function makeEnv(db, { bucketDeletes, queueMessages }) {
  return {
    PROJECTS_JSON,
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: "",
    GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
    DB: new D1FromSqlite(db),
    FEEDBACK_BUCKET: {
      async put() {},
      async get() {
        return null;
      },
      async delete(key) {
        bucketDeletes.push(key);
      },
    },
    FEEDBACK_QUEUE: {
      async send(message) {
        queueMessages.push(message);
      },
      async sendBatch(messages) {
        for (const message of messages) {
          queueMessages.push(message.body);
        }
      },
    },
  };
}

async function pemPrivateKey() {
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign"],
  );
  const raw = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const bytes = new Uint8Array(raw);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return `-----BEGIN PRIVATE KEY-----\n${btoa(binary).match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;
}

function installFakeGitHub({ createdIssues, privateRepo = true }) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? "GET" });
    if (url.endsWith("/repos/owner/my-app/installation")) {
      return Response.json({ id: 9876 });
    }
    if (url.endsWith("/app/installations/9876/access_tokens")) {
      return Response.json({ token: "installation-token", expires_at: "2030-01-01T00:00:00Z" });
    }
    if (url.endsWith("/repos/owner/my-app")) {
      return Response.json({ private: privateRepo });
    }
    if (url.includes("/issues?state=all")) {
      return Response.json([]);
    }
    if (url.endsWith("/issues") && init.method === "POST") {
      const number = createdIssues.length + 1;
      createdIssues.push(JSON.parse(String(init.body)));
      return Response.json({ number, html_url: `https://github.com/owner/my-app/issues/${number}` });
    }
    return Response.json({});
  };
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

const SAFE_ASSESSMENT = {
  category: "bug",
  confidence: 0.95,
  title: "Profile tooltip typo",
  summary: "The profile button tooltip has a typo.",
  acceptanceCriteria: ["The tooltip text is corrected."],
  suspectedAreas: ["profile"],
  riskSignals: [],
  requiresDiscussion: false,
  visualEvidenceConsidered: false,
};

test("end-to-end: eligible feedback is queued, assessed, and lands as an agent:ready GitHub issue", async () => {
  const db = await openDb();
  const bucketDeletes = [];
  const queueMessages = [];
  const env = makeEnv(db, { bucketDeletes, queueMessages });
  env.GITHUB_APP_PRIVATE_KEY = await pemPrivateKey();
  const createdIssues = [];
  const github = installFakeGitHub({ createdIssues });
  const config = await getProjectConfig(env, "my-app");

  try {
    const submitted = await submitFeedback({
      env,
      config,
      userKey: "user_1",
      form: {
        message: "The tooltip text on the profile button has a typo.",
        pathname: "/profile",
        clientRequestId: "req_1",
        screenshot: null,
      },
    });
    assert.equal(submitted.state, "queued");
    assert.deepEqual(queueMessages, [{ projectId: "my-app", feedbackId: submitted.feedbackId }]);

    const result = await processFeedbackCase(env, "my-app", submitted.feedbackId);
    assert.equal(result.state, "complete");
    assert.equal(createdIssues.length, 1);
    const payload = createdIssues[0];
    assert.ok(payload.labels.includes("agent:ready"));
    assert.ok(payload.labels.includes("feedback"));
    assert.match(payload.body, /diffindo-feedback-agent:/);

    const caseRow = db.prepare("SELECT state, github_issue_number FROM feedback_cases WHERE id = ?").get(submitted.feedbackId);
    assert.equal(caseRow.state, "issue_created");
    assert.equal(caseRow.github_issue_number, 1);
    const job = db.prepare("SELECT status FROM feedback_jobs WHERE feedback_id = ?").get(submitted.feedbackId);
    assert.equal(job.status, "completed");
  } finally {
    github.restore();
    db.close();
  }
});

test("end-to-end: discussion-required feedback creates a needs:triage issue and deletes the screenshot", async () => {
  const db = await openDb();
  const bucketDeletes = [];
  const queueMessages = [];
  const env = makeEnv(db, { bucketDeletes, queueMessages });
  env.GITHUB_APP_PRIVATE_KEY = await pemPrivateKey();
  const createdIssues = [];
  const github = installFakeGitHub({ createdIssues });
  const config = await getProjectConfig(env, "my-app");

  try {
    const submitted = await submitFeedback({
      env,
      config,
      userKey: "user_1",
      form: {
        message: "Maybe we should rethink the entire group expense strategy.",
        pathname: "/profile",
        clientRequestId: "req_2",
        screenshot: null,
      },
    });
    // Force a stored assessment that the policy sees as discussion-required.
    db.prepare(
      "UPDATE feedback_cases SET assessment_json = ?, state = 'submitted' WHERE id = ?",
    ).run(JSON.stringify({
      ...SAFE_ASSESSMENT,
      category: "other",
      confidence: 0.4,
      requiresDiscussion: true,
    }), submitted.feedbackId);

    const result = await processFeedbackCase(env, "my-app", submitted.feedbackId);
    assert.equal(result.state, "complete");
    assert.equal(createdIssues.length, 1);
    const payload = createdIssues[0];
    assert.ok(payload.labels.includes("needs:triage"));
    assert.ok(!payload.labels.includes("agent:ready"));
  } finally {
    github.restore();
    db.close();
  }
});

test("GitHub webhook rejects a bad signature and accepts an opened-ready issue", async () => {
  const db = await openDb();
  const queueMessages = [];
  const env = makeEnv(db, { bucketDeletes: [], queueMessages });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("test-webhook-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payload = JSON.stringify({
    action: "opened",
    issue: {
      number: 7,
      title: "Tooltip typo",
      body: "The tooltip text on the profile button has a typo.",
      labels: [{ name: "agent:ready" }],
    },
    repository: { full_name: "owner/my-app" },
  });
  const signatureBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const signature = "sha256=" + Array.from(new Uint8Array(signatureBytes), (b) => b.toString(16).padStart(2, "0")).join("");

  await assert.rejects(
    () => handleGithubWebhook(env, new Request("https://example.test/api/webhooks/github", {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=00", "content-type": "application/json" },
      body: payload,
    })),
    /Invalid GitHub webhook signature/,
  );

  const good = await handleGithubWebhook(env, new Request("https://example.test/api/webhooks/github", {
    method: "POST",
    headers: { "x-hub-signature-256": signature, "content-type": "application/json" },
    body: payload,
  }));
  const goodJson = await good.json();
  assert.equal(good.status, 200);
  assert.equal(typeof goodJson.feedbackId, "string");
  assert.equal(queueMessages.length, 1);
  db.close();
});
