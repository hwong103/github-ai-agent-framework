import assert from "node:assert/strict";
import test from "node:test";

import { getProjectConfig } from "../src/config.ts";
import { triageFeedback } from "../src/feedback/policy.ts";

const PROJECTS_JSON = JSON.stringify({
  "my-app": {
    projectId: "my-app",
    repo: "owner/my-app",
    defaultBranch: "main",
    productName: "My App",
    policyVersion: "2026-08-12.1",
    assessmentModel: "@cf/meta/llama-4-scout-17b-16e-instruct",
    staticPaths: ["/", "/profile"],
    riskTerms: ["balance", "settlement", "payment"],
    microfixTerms: ["typo", "tooltip", "copy"],
    uiLocationTerms: ["button", "page", "profile"]
  }
});

const safeAssessment = {
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

test("config-driven policy routes an eligible microfix and rejects risky scope", async () => {
  const config = await getProjectConfig({ PROJECTS_JSON }, "my-app");
  const eligible = triageFeedback(config, "The tooltip text on the profile button has a typo.", safeAssessment);
  assert.equal(eligible.decision, "ready_for_build");
  assert.ok(eligible.labels.includes("agent:ready"));
  assert.ok(eligible.labels.includes("agent:model:deepseek-v4-flash"));

  const risky = triageFeedback(config, "The settlement balance text is wrong on the page.", safeAssessment);
  assert.equal(risky.decision, "needs_discussion");
  assert.equal(risky.reason, "high_risk_or_sensitive_change");

  const ambiguous = triageFeedback(config, "It feels odd", safeAssessment);
  assert.equal(ambiguous.decision, "needs_discussion");
});

test("AI is veto-only: model fields can block but never grant eligibility", async () => {
  const config = await getProjectConfig({ PROJECTS_JSON }, "my-app");
  const message = "The tooltip text on the profile button has a typo.";
  assert.equal(triageFeedback(config, message, null).decision, "ready_for_build");
  assert.equal(
    triageFeedback(config, message, { ...safeAssessment, requiresDiscussion: true }).decision,
    "needs_discussion",
  );
  assert.equal(
    triageFeedback(config, message, { ...safeAssessment, category: "feature" }).reason,
    "assessment_vetoed_automation",
  );
});
