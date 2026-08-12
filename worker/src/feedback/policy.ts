import type { ProjectConfig } from "../config.ts";
import type { FeedbackAssessment, FeedbackCategory } from "./types.ts";

export interface FeedbackTriage {
  decision: "ready_for_build" | "needs_discussion";
  category: FeedbackCategory;
  title: string;
  reason: string;
  labels: string[];
}

const PROMPT_INJECTION_PATTERN = /\b(ignore (?:all |the )?(?:previous|prior|system) instructions|system prompt|developer message|run (?:this )?(?:command|script)|curl\s+https?:|sudo\b|rm\s+-rf)\b/i;
const DISCUSSION_PATTERN = /\b(not sure|unsure|maybe|brainstorm|discuss|which approach|what do you think|should we|redesign|rethink|strategy|policy)\b/i;
const BROAD_SCOPE_PATTERN = /\b(entire|whole|all|every|everywhere|across the (?:app|product|codebase)|app-wide|site-wide|rewrite|replace the|architecture|refactor)\b/i;
const BUG_PATTERN = /\b(bug|broken|error|wrong|missing|typo|misspell(?:ed|ing)?|doesn['\u2019]?t|does not|can(?:not|'t)|unable)\b/i;
const FEATURE_PATTERN = /\b(please add|would like|i['\u2019]?d like|could you add|allow (?:me|us|users))\b/i;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function anyTerm(message: string, terms: string[]) {
  return terms.some((term) => new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(message));
}

function compactTitle(message: string, category: FeedbackCategory) {
  const firstLine = (message.split(/\r?\n/)[0] ?? "").replace(/\s+/g, " ").trim();
  const withoutTrailingPunctuation = firstLine.replace(/[.!?]+$/, "");
  const limited = withoutTrailingPunctuation.length > 72
    ? `${withoutTrailingPunctuation.slice(0, 71).trimEnd()}\u2026`
    : withoutTrailingPunctuation;
  const prefix = category === "bug" ? "UI fix" : category === "feature" ? "UI request" : "Feedback";
  return `${prefix}: ${limited || "User feedback"}`;
}

function discussion(
  config: ProjectConfig,
  category: FeedbackCategory,
  title: string,
  reason: string,
): FeedbackTriage {
  return {
    decision: "needs_discussion",
    category,
    title,
    reason,
    labels: [config.labels.feedback, config.labels.needsTriage],
  };
}

export function triageFeedback(
  config: ProjectConfig,
  message: string,
  assessment: FeedbackAssessment | null = null,
): FeedbackTriage {
  const normalized = message.replace(/\s+/g, " ").trim();
  const hasBugSignal = BUG_PATTERN.test(normalized);
  const hasFeatureSignal = FEATURE_PATTERN.test(normalized);
  const category: FeedbackCategory = hasBugSignal === hasFeatureSignal
    ? "other"
    : hasBugSignal
      ? "bug"
      : "feature";
  const title = compactTitle(normalized, category);

  if (PROMPT_INJECTION_PATTERN.test(normalized) || assessment?.riskSignals.includes("prompt_injection")) {
    return discussion(config, category, title, "prompt_injection_signal");
  }
  if (
    anyTerm(normalized, config.riskTerms) ||
    BROAD_SCOPE_PATTERN.test(normalized) ||
    (assessment?.riskSignals.length ?? 0) > 0
  ) {
    return discussion(config, category, title, "high_risk_or_sensitive_change");
  }
  if (DISCUSSION_PATTERN.test(normalized)) {
    return discussion(config, category, title, "product_or_implementation_discussion_requested");
  }

  // Eligibility is determined wholly from raw text. Model output can veto, never authorize.
  const deterministicallyEligible =
    category !== "other" &&
    normalized.length >= 24 &&
    anyTerm(normalized, config.microfixTerms) &&
    anyTerm(normalized, config.uiLocationTerms);
  if (!deterministicallyEligible) {
    return discussion(config, category, title, category === "other"
      ? "intent_not_confidently_classified"
      : "outside_narrow_ui_microfix_allowlist");
  }

  if (
    assessment && (
      assessment.requiresDiscussion ||
      assessment.confidence < 0.85 ||
      assessment.category !== category
    )
  ) {
    return discussion(config, category, title, "assessment_vetoed_automation");
  }

  const modelLabel = assessment?.visualEvidenceConsidered
    ? config.labels.modelVisual
    : config.labels.modelNarrow;
  return {
    decision: "ready_for_build",
    category,
    title,
    reason: category === "bug" ? "narrow_ui_microfix" : "narrow_ui_copy_request",
    labels: [
      config.labels.feedback,
      category === "bug" ? config.labels.bug : config.labels.enhancement,
      modelLabel,
      config.labels.agentReady,
    ],
  };
}
