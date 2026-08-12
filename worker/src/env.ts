export interface CloudflareAiBinding {
  run: (model: string, input: unknown) => Promise<unknown>;
}

export interface CloudflareD1Result<T = unknown> {
  results?: T[];
  success: boolean;
  meta?: {
    changes?: number;
  };
}

export interface CloudflareD1PreparedStatement {
  bind: (...values: unknown[]) => CloudflareD1PreparedStatement;
  all: <T = unknown>() => Promise<CloudflareD1Result<T>>;
  first: <T = unknown>() => Promise<T | null>;
  run: () => Promise<CloudflareD1Result>;
}

export interface CloudflareD1Database {
  prepare: (query: string) => CloudflareD1PreparedStatement;
  batch: <T = unknown>(
    statements: CloudflareD1PreparedStatement[],
  ) => Promise<Array<CloudflareD1Result<T>>>;
}

export interface CloudflareQueue<T = unknown> {
  send: (
    message: T,
    options?: { contentType?: "json"; delaySeconds?: number },
  ) => Promise<unknown>;
  sendBatch: (
    messages: Array<{ body: T; contentType?: "json"; delaySeconds?: number }>,
  ) => Promise<unknown>;
}

export interface CloudflareR2Bucket {
  put: (
    key: string,
    value: ArrayBuffer,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ) => Promise<unknown>;
  get: (key: string) => Promise<{
    arrayBuffer: () => Promise<ArrayBuffer>;
  } | null>;
  delete: (key: string) => Promise<void>;
}

export interface CloudflareEnv {
  AI?: CloudflareAiBinding;
  DB?: CloudflareD1Database;
  FEEDBACK_QUEUE?: CloudflareQueue<{ projectId: string; feedbackId: string }>;
  FEEDBACK_BUCKET?: CloudflareR2Bucket;
  FEEDBACK_QUEUE_NAME?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  PROJECTS_JSON?: string;
}
