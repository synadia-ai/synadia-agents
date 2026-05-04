// Pluggable model resolution.
//
// `runBridge` and `buildBridgeAgent` take a `ModelFactory` so the bridge
// isn't hard-wired to Vercel's AI Gateway. Two factories ship out of the
// box:
//
//   - {@link gatewayModelFactory} — Vercel AI Gateway (the upstream
//     open-agents default). Routes `provider/model` ids like
//     `anthropic/claude-opus-4.6` to the configured backend. Auth via
//     `AI_GATEWAY_API_KEY`.
//   - {@link openRouterModelFactory} — OpenRouter via its OpenAI-compatible
//     endpoint. Models are the slugs from openrouter.ai/models. Auth via
//     `OPENROUTER_API_KEY`.
//
// Custom factories are trivial: any function `(modelId) => LanguageModel`
// works. The bridge only uses the returned model — no cache control, no
// adaptive thinking, no per-provider middleware unless the factory wires
// it itself.

import type { LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

import { gateway } from "../vendor/agent/models.js";
import type { GatewayModelId } from "../vendor/agent/models.js";

export type ModelFactory = (modelId: string) => LanguageModel;

/**
 * Vercel AI Gateway. Carries the upstream open-agents provider tuning
 * (Anthropic adaptive thinking, OpenAI `store:false`, GPT-5 reasoning
 * defaults) — see `vendor/agent/models.ts` for the full list.
 *
 * Get an API key at <https://vercel.com/dashboard/ai-gateway>; set it as
 * `AI_GATEWAY_API_KEY`. Models follow the `provider/model-id` shape, e.g.
 * `anthropic/claude-opus-4.6`, `openai/gpt-5`, `google/gemini-2.5-pro`.
 */
export function gatewayModelFactory(): ModelFactory {
  return (id) => gateway(id as GatewayModelId);
}

export interface OpenRouterFactoryOptions {
  /** Required. Defaults to `process.env.OPENROUTER_API_KEY`. */
  readonly apiKey?: string;
  /** Defaults to `https://openrouter.ai/api/v1`. */
  readonly baseURL?: string;
  /** OpenRouter's HTTP-Referer header (used for rankings). Optional. */
  readonly httpReferer?: string;
  /** OpenRouter's X-Title header. Optional. */
  readonly appTitle?: string;
}

/**
 * OpenRouter via its OpenAI-compatible API. No provider-specific tuning
 * is applied — calls go through `provider.chat(modelId)` to pin to
 * Chat Completions (the Responses API is OpenAI-only).
 *
 * Model ids are OpenRouter slugs (see <https://openrouter.ai/models>),
 * e.g. `anthropic/claude-sonnet-4`, `meta-llama/llama-3.3-70b-instruct`,
 * `qwen/qwen3-coder`. Auth via the `OPENROUTER_API_KEY` env var or the
 * `apiKey` option.
 */
export function openRouterModelFactory(opts: OpenRouterFactoryOptions = {}): ModelFactory {
  const apiKey = opts.apiKey ?? process.env["OPENROUTER_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "openRouterModelFactory: OPENROUTER_API_KEY is not set. " +
        "Get a key at https://openrouter.ai/keys and export it, or pass `apiKey`.",
    );
  }
  const provider = createOpenAI({
    apiKey,
    baseURL: opts.baseURL ?? "https://openrouter.ai/api/v1",
    headers: {
      ...(opts.httpReferer !== undefined ? { "HTTP-Referer": opts.httpReferer } : {}),
      ...(opts.appTitle !== undefined ? { "X-Title": opts.appTitle } : {}),
    },
  });
  return (id) => provider.chat(id);
}
