import type { ProjectConfig } from "../config.ts";
import type { ParsedFeedbackForm, ParsedFeedbackScreenshot } from "./types.ts";

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ALLOWED_SCREENSHOT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export class FeedbackValidationError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "FeedbackValidationError";
  }
}

function singleText(formData: FormData, name: string, required = true) {
  const values = formData.getAll(name);
  if (values.length === 0 && !required) {
    return null;
  }
  if (values.length !== 1 || typeof values[0] !== "string") {
    throw new FeedbackValidationError(`Invalid ${name}.`);
  }
  return values[0];
}

export function isAllowedFeedbackPathname(config: ProjectConfig, pathname: string) {
  if (
    pathname.length > 512 ||
    !pathname.startsWith("/") ||
    pathname.includes("?") ||
    pathname.includes("#") ||
    pathname.includes("\\") ||
    pathname.includes("..") ||
    pathname.includes("//")
  ) {
    return false;
  }

  if (config.staticPaths.includes(pathname)) {
    return true;
  }
  return config.dynamicPathPatterns.some((pattern) => new RegExp(pattern).test(pathname));
}

function detectImageType(bytes: Uint8Array): ParsedFeedbackScreenshot["mediaType"] | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export async function validateFeedbackScreenshot(
  config: ProjectConfig,
  file: File,
): Promise<ParsedFeedbackScreenshot> {
  if (file.size < 1 || file.size > config.maxScreenshotBytes) {
    throw new FeedbackValidationError(`Screenshots must be between 1 byte and ${config.maxScreenshotBytes} bytes.`);
  }
  if (!ALLOWED_SCREENSHOT_TYPES.has(file.type)) {
    throw new FeedbackValidationError("Screenshots must be a JPEG, PNG, or WebP image.");
  }

  const bytes = await file.arrayBuffer();
  const detectedType = detectImageType(new Uint8Array(bytes));
  if (!detectedType || detectedType !== file.type) {
    throw new FeedbackValidationError("The screenshot contents do not match its image type.");
  }

  const extensions = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  } as const;
  return {
    bytes,
    mediaType: detectedType,
    extension: extensions[detectedType],
    size: file.size,
  };
}

export async function parseFeedbackFormData(
  config: ProjectConfig,
  formData: FormData,
): Promise<ParsedFeedbackForm> {
  const message = singleText(formData, "message")!.trim();
  if (!message || message.length > config.maxMessageLength) {
    throw new FeedbackValidationError(
      `Feedback must be between 1 and ${config.maxMessageLength} characters.`,
    );
  }

  const pathname = singleText(formData, "pathname", false)?.trim() ?? "";
  if (!pathname || !isAllowedFeedbackPathname(config, pathname)) {
    throw new FeedbackValidationError("Feedback cannot be submitted from this page.");
  }

  const clientRequestId = singleText(formData, "clientRequestId")!.trim();
  if (!CLIENT_REQUEST_ID_PATTERN.test(clientRequestId)) {
    throw new FeedbackValidationError("Invalid clientRequestId.");
  }

  const screenshots = formData.getAll("screenshot");
  if (screenshots.length > 1 || (screenshots.length === 1 && !(screenshots[0] instanceof File))) {
    throw new FeedbackValidationError("Invalid screenshot.");
  }
  const screenshot = screenshots.length === 1
    ? await validateFeedbackScreenshot(config, screenshots[0] as File)
    : null;

  return { message, pathname, clientRequestId, screenshot };
}
