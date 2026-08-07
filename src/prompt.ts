/**
 * Build Claude Agent SDK prompts from OpenAI-compatible chat messages,
 * including text, images, and PDF/document attachments.
 */
export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source:
        | { type: "base64"; media_type: string; data: string }
        | { type: "url"; url: string };
    }
  | {
      type: "document";
      source:
        | { type: "base64"; media_type: string; data: string }
        | { type: "url"; url: string };
    };

export type SdkUserPrompt = {
  type: "user";
  message: { role: "user"; content: string | AnthropicContentBlock[] };
  parent_tool_use_id: null;
};

function parseDataUrl(url: string): {
  mediaType: string;
  data: string;
} | null {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.+)$/i.exec(
    url.trim(),
  );
  if (!match) return null;
  return {
    mediaType: (match[1] || "application/octet-stream").toLowerCase(),
    data: match[2],
  };
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

function mediaLooksLikePdf(mediaType: string, urlHint = ""): boolean {
  return (
    mediaType.includes("pdf") ||
    /\.pdf(\?|#|$)/i.test(urlHint) ||
    mediaType === "application/octet-stream" && /\.pdf(\?|#|$)/i.test(urlHint)
  );
}

function mediaLooksLikeImage(mediaType: string): boolean {
  return mediaType.startsWith("image/");
}

function pushText(blocks: AnthropicContentBlock[], text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const last = blocks[blocks.length - 1];
  if (last?.type === "text") {
    last.text = `${last.text}\n${trimmed}`;
    return;
  }
  blocks.push({ type: "text", text: trimmed });
}

function pushDataUrl(
  blocks: AnthropicContentBlock[],
  url: string,
): boolean {
  const parsed = parseDataUrl(url);
  if (!parsed) return false;
  if (mediaLooksLikeImage(parsed.mediaType)) {
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: parsed.mediaType,
        data: parsed.data,
      },
    });
    return true;
  }
  if (mediaLooksLikePdf(parsed.mediaType)) {
    blocks.push({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: parsed.data,
      },
    });
    return true;
  }
  // Unknown binary — still try as document so Claude can reject clearly.
  blocks.push({
    type: "document",
    source: {
      type: "base64",
      media_type: parsed.mediaType,
      data: parsed.data,
    },
  });
  return true;
}

function pushRemoteUrl(
  blocks: AnthropicContentBlock[],
  url: string,
  mediaTypeHint?: string,
): void {
  const mediaType = (mediaTypeHint || "").toLowerCase();
  if (mediaLooksLikePdf(mediaType, url)) {
    blocks.push({
      type: "document",
      source: { type: "url", url },
    });
    return;
  }
  blocks.push({
    type: "image",
    source: { type: "url", url },
  });
}

function convertPart(part: unknown, blocks: AnthropicContentBlock[]): void {
  if (!part || typeof part !== "object") return;
  const p = part as Record<string, unknown>;
  const type = typeof p.type === "string" ? p.type : "";

  if (type === "text" && typeof p.text === "string") {
    pushText(blocks, p.text);
    return;
  }

  if (type === "image_url") {
    const imageUrl = p.image_url;
    const url =
      typeof imageUrl === "string"
        ? imageUrl
        : imageUrl &&
            typeof imageUrl === "object" &&
            typeof (imageUrl as { url?: unknown }).url === "string"
          ? (imageUrl as { url: string }).url
          : null;
    if (!url) return;
    if (pushDataUrl(blocks, url)) return;
    if (isHttpUrl(url)) pushRemoteUrl(blocks, url);
    return;
  }

  if (type === "input_image") {
    const url = typeof p.image_url === "string" ? p.image_url : null;
    const b64 = typeof p.data === "string" ? p.data : null;
    const mediaType =
      typeof p.media_type === "string" ? p.media_type : "image/png";
    if (url) {
      if (pushDataUrl(blocks, url)) return;
      if (isHttpUrl(url)) pushRemoteUrl(blocks, url, mediaType);
      return;
    }
    if (b64) {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: b64 },
      });
    }
    return;
  }

  if (type === "file" || type === "input_file") {
    const file = (p.file && typeof p.file === "object" ? p.file : p) as Record<
      string,
      unknown
    >;
    const url = typeof file.url === "string" ? file.url : null;
    const data = typeof file.data === "string" ? file.data : null;
    const mediaType =
      typeof file.media_type === "string"
        ? file.media_type
        : typeof file.mime_type === "string"
          ? file.mime_type
          : "application/octet-stream";
    const name = typeof file.filename === "string" ? file.filename : "";

    if (url) {
      if (pushDataUrl(blocks, url)) return;
      if (isHttpUrl(url)) pushRemoteUrl(blocks, url, mediaType || name);
      return;
    }
    if (data) {
      if (mediaLooksLikeImage(mediaType)) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: mediaType, data },
        });
      } else {
        blocks.push({
          type: "document",
          source: {
            type: "base64",
            media_type: mediaLooksLikePdf(mediaType, name)
              ? "application/pdf"
              : mediaType,
            data,
          },
        });
      }
    }
  }
}

export function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const p = part as { type?: string; text?: string };
      if (p.type === "text" && typeof p.text === "string") return p.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function contentHasAttachments(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (!part || typeof part !== "object") return false;
    const type = (part as { type?: unknown }).type;
    return (
      type === "image_url" ||
      type === "input_image" ||
      type === "file" ||
      type === "input_file" ||
      type === "image" ||
      type === "document"
    );
  });
}

export function openaiContentToAnthropicBlocks(
  content: unknown,
): AnthropicContentBlock[] {
  if (typeof content === "string") {
    const text = content.trim();
    return text ? [{ type: "text", text }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: AnthropicContentBlock[] = [];
  for (const part of content) convertPart(part, blocks);
  return blocks;
}

/**
 * Latest user turn as a Claude Agent SDK prompt (string when text-only).
 */
export function latestUserPrompt(
  messages: Array<{ role?: string; content?: unknown }>,
): string | SdkUserPrompt {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "user") continue;
    const content = msg.content;
    if (!contentHasAttachments(content)) {
      const text = extractTextContent(content).trim();
      if (text) return text;
      continue;
    }
    const blocks = openaiContentToAnthropicBlocks(content);
    if (blocks.length === 0) continue;
    return {
      type: "user",
      message: { role: "user", content: blocks },
      parent_tool_use_id: null,
    };
  }
  return "";
}

export async function* promptAsStream(
  prompt: string | SdkUserPrompt,
): AsyncGenerator<SdkUserPrompt, void, unknown> {
  if (typeof prompt === "string") {
    yield {
      type: "user",
      message: { role: "user", content: prompt },
      parent_tool_use_id: null,
    };
    return;
  }
  yield prompt;
}
