import { z } from "zod";

const DEFAULT_LABELS = {
  feedback: "feedback",
  needsTriage: "needs:triage",
  bug: "bug",
  enhancement: "enhancement",
  agentReady: "agent:ready",
  agentBlocked: "agent:blocked",
  agentPrOpen: "agent:pr-open",
  modelVisual: "agent:model:kimi-k3",
  modelNarrow: "agent:model:deepseek-v4-flash",
};

const DEFAULT_MODELS = {
  default: "opencode-go/glm-5.2",
  visual: "opencode-go/kimi-k3",
  narrowFast: "opencode-go/deepseek-v4-flash",
};

export const ProjectConfigSchema = z.object({
  projectId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  defaultBranch: z.string().min(1),
  productName: z.string().min(1),
  policyVersion: z.string().min(1),
  assessmentModel: z.string().min(1),
  maxMessageLength: z.number().int().min(1).max(16000).default(8000),
  maxScreenshotBytes: z.number().int().min(1).max(16 * 1024 * 1024).default(4 * 1024 * 1024),
  minMessageLength: z.number().int().min(1).default(1),
  staticPaths: z.array(z.string()).default([]),
  dynamicPathPatterns: z.array(z.string()).default([]),
  riskTerms: z.array(z.string()).default([]),
  microfixTerms: z.array(z.string()).default([]),
  uiLocationTerms: z.array(z.string()).default([]),
  labels: z.object({
    feedback: z.string().default("feedback"),
    needsTriage: z.string().default("needs:triage"),
    bug: z.string().default("bug"),
    enhancement: z.string().default("enhancement"),
    agentReady: z.string().default("agent:ready"),
    agentBlocked: z.string().default("agent:blocked"),
    agentPrOpen: z.string().default("agent:pr-open"),
    modelVisual: z.string().default("agent:model:kimi-k3"),
    modelNarrow: z.string().default("agent:model:deepseek-v4-flash"),
  }).default(DEFAULT_LABELS),
  models: z.object({
    default: z.string().default("opencode-go/glm-5.2"),
    visual: z.string().default("opencode-go/kimi-k3"),
    narrowFast: z.string().default("opencode-go/deepseek-v4-flash"),
  }).default(DEFAULT_MODELS),
  maxChangedFiles: z.number().int().default(12),
  maxDiffLines: z.number().int().default(600),
  staleApprovalDays: z.number().int().default(7),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export class ProjectConfigError extends Error {
  constructor(projectId: string, detail: string) {
    super(`Project configuration for '${projectId}' is invalid: ${detail}`);
    this.name = "ProjectConfigError";
  }
}

const projectConfigCache = new Map<string, ProjectConfig>();

export function parseProjectConfigs(json: string | undefined): Map<string, ProjectConfig> {
  if (!json || !json.trim()) {
    return new Map();
  }
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("PROJECTS_JSON must be an object keyed by project_id.");
  }
  const result = new Map<string, ProjectConfig>();
  for (const [projectId, raw] of Object.entries(parsed as Record<string, unknown>)) {
    const parsedProject = ProjectConfigSchema.safeParse(raw);
    if (!parsedProject.success) {
      throw new ProjectConfigError(projectId, parsedProject.error.message);
    }
    if (parsedProject.data.projectId !== projectId) {
      throw new ProjectConfigError(projectId, "projectId field must match its key.");
    }
    result.set(projectId, parsedProject.data);
  }
  return result;
}

export async function getProjectConfig(
  env: { PROJECTS_JSON?: string },
  projectId: string,
): Promise<ProjectConfig> {
  const cached = projectConfigCache.get(projectId);
  if (cached) {
    return cached;
  }
  const configs = parseProjectConfigs(env.PROJECTS_JSON);
  const config = configs.get(projectId);
  if (!config) {
    throw new ProjectConfigError(projectId, "unknown project_id");
  }
  projectConfigCache.set(projectId, config);
  return config;
}

export function resetProjectConfigCache() {
  projectConfigCache.clear();
}
