export type FeedbackState =
  | "submitted"
  | "queued"
  | "processing"
  | "needs_discussion"
  | "issue_created";

export type FeedbackCategory = "bug" | "feature" | "other";

export interface FeedbackCaseRow {
  id: string;
  project_id: string;
  user_key: string;
  client_request_id: string;
  request_hash: string;
  message: string;
  pathname: string;
  screenshot_key: string | null;
  screenshot_media_type: string | null;
  screenshot_size_bytes: number | null;
  state: FeedbackState;
  category: FeedbackCategory | null;
  triage_reason: string | null;
  assessment_json: string | null;
  assessment_model: string | null;
  policy_version: string | null;
  github_issue_number: number | null;
  github_issue_url: string | null;
}

export interface FeedbackAssessment {
  category: FeedbackCategory;
  confidence: number;
  title: string;
  summary: string;
  acceptanceCriteria: string[];
  suspectedAreas: string[];
  riskSignals: string[];
  requiresDiscussion: boolean;
  visualEvidenceConsidered: boolean;
}

export interface FeedbackQueueBody {
  projectId: string;
  feedbackId: string;
}

export interface ParsedFeedbackScreenshot {
  bytes: ArrayBuffer;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  extension: "jpg" | "png" | "webp";
  size: number;
}

export interface ParsedFeedbackForm {
  message: string;
  pathname: string;
  clientRequestId: string;
  screenshot: ParsedFeedbackScreenshot | null;
}
