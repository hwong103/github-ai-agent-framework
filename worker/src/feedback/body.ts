export class FeedbackBodyTooLargeError extends Error {
  constructor() {
    super("Feedback upload is too large.");
    this.name = "FeedbackBodyTooLargeError";
  }
}

export async function readBoundedFeedbackFormData(request: Request, maxBytes: number) {
  if (!request.body) {
    throw new TypeError("Request body is missing.");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new FeedbackBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const contentType = request.headers.get("content-type");
  if (!contentType) {
    throw new TypeError("Content-Type is missing.");
  }
  return new Response(body.buffer, {
    headers: { "Content-Type": contentType },
  }).formData();
}
