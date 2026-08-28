import type { FilePart } from "ai";
import { createDataUrlFilePart } from "eve/client";
import type { RequestAttachment } from "@synadia-ai/agents";

export const FALLBACK_MEDIA_TYPE = "application/octet-stream";

// Small extension map for the attachment types callers actually send.
// Anything unrecognized ships as application/octet-stream — Eve still
// forwards the bytes; the model just gets a weaker content-type hint.
const MEDIA_TYPES: Record<string, string> = {
  css: "text/css",
  csv: "text/csv",
  gif: "image/gif",
  htm: "text/html",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  toml: "application/toml",
  txt: "text/plain",
  webp: "image/webp",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
};

export function mediaTypeForFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return FALLBACK_MEDIA_TYPE;
  const ext = filename.slice(dot + 1).toLowerCase();
  return MEDIA_TYPES[ext] ?? FALLBACK_MEDIA_TYPE;
}

/** Protocol §5 attachment → AI SDK file part with an inline data: URL. */
export function attachmentToFilePart(attachment: RequestAttachment): FilePart {
  return createDataUrlFilePart({
    bytes: attachment.content,
    filename: attachment.filename,
    mediaType: mediaTypeForFilename(attachment.filename),
  });
}
