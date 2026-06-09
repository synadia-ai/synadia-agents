// Deep-research NATS agent built on ax-llm's RLM (Recursive Language Model):
// an Actor/Responder agent with a sandboxed JS REPL, `llmQuery()` for sub-LLM
// calls, and a pluggable `web.*` tool group (search + page extract). Hosted
// via the SDK's `AgentService` helper; streams REPL turn activity as status
// chunks and the final report as response deltas.

import { promises as fs } from "node:fs";
import process from "node:process";
import {
  type AxAgentFunctionGroup,
  AxJSRuntime,
  AxJSRuntimePermission,
  agent,
  ai,
  f,
  fn,
} from "@ax-llm/ax";
import { connect as natsConnect } from "@nats-io/transport-node";
import { loadContextOptions, parseNatsUrl } from "@synadia-ai/agents";
import { AgentService } from "@synadia-ai/agent-service";
import { createSearchProvider } from "./search.js";

const MODEL = process.env["RESEARCH_MODEL"] ?? "openai/gpt-oss-20b";
const API_URL = process.env["NVIDIA_API_URL"] ?? "https://integrate.api.nvidia.com/v1";
const API_KEY = process.env["NVIDIA_API_KEY"];
const MAX_TURNS = Number(process.env["RESEARCH_MAX_TURNS"] ?? 15);
const MAX_SUB_CALLS = Number(process.env["RESEARCH_MAX_SUB_CALLS"] ?? 30);

if (!API_KEY) {
  console.error("NVIDIA_API_KEY is not set. Did you `source .env`?");
  process.exit(1);
}

// NVIDIA's OpenAI-compatible endpoint returns `reasoning_content: null` for
// non-reasoning models (ax rejects non-string `thought`) and refuses parallel
// tool calls on some llama variants. Same scrub as examples/dspy/src/index.ts.
const DEBUG_TRACE = process.env["RESEARCH_DEBUG"] === "1";
// Per-process prefix so concurrent agents (or restarts) don't clobber each
// other's debug dumps in the shared /tmp directory; the counter only needs to
// be unique within a process.
const DEBUG_RUN = Math.random().toString(36).slice(2, 8);
let turn = 0;
const scrubbedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  turn += 1;
  const n = turn;
  let finalInit = init;
  if (init?.body && typeof init.body === "string") {
    try {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      let mutated = false;
      if (Array.isArray(body["messages"]) && Array.isArray(body["tools"])) {
        body["parallel_tool_calls"] = false;
        mutated = true;
      }
      // NVIDIA's vLLM only accepts reasoning_effort in {low, medium, high};
      // "minimal" (emitted by ax for thinkingTokenBudget="minimal") 400s.
      if (body["reasoning_effort"] === "minimal") {
        body["reasoning_effort"] = "low";
        mutated = true;
      }
      if (mutated) {
        finalInit = { ...init, body: JSON.stringify(body) };
      }
    } catch {
      // non-JSON body
    }
  }
  if (DEBUG_TRACE && finalInit?.body) {
    await fs.writeFile(`/tmp/research-${DEBUG_RUN}-req-${n}.json`, String(finalInit.body), { mode: 0o600 });
  }
  const res = await fetch(input, finalInit);
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) return res;
  const body = await res.json();
  if (DEBUG_TRACE) {
    await fs.writeFile(`/tmp/research-${DEBUG_RUN}-res-${n}.json`, JSON.stringify(body, null, 2), { mode: 0o600 });
  }
  const scrub = (obj: unknown): unknown => {
    if (!obj || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(scrub);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k === "reasoning_content" && v === null) continue;
      out[k] = scrub(v);
    }
    return out;
  };
  // Re-serialising the scrubbed body changes its length; drop the original
  // Content-Length so it isn't forwarded stale onto the rebuilt response.
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(scrub(body)), {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
};

const llm = ai({
  name: "openai",
  apiKey: API_KEY,
  apiURL: API_URL,
  // `model` is a strict union of ax's known model ids; we pass an arbitrary
  // NVIDIA endpoint model string, so `as never` opts out of that narrowing.
  config: { model: MODEL as never, stream: false },
  options: { fetch: scrubbedFetch as typeof fetch },
});

// Connection resolution mirrors the client-sdk 01–05 examples: a named NATS
// CLI context (carries creds / nkey / JWT / TLS) takes precedence, then a
// plain NATS_URL, then localhost.
const natsOpts = process.env["NATS_CONTEXT"]
  ? await loadContextOptions(process.env["NATS_CONTEXT"])
  : process.env["NATS_URL"]
    ? parseNatsUrl(process.env["NATS_URL"])
    : { servers: "nats://127.0.0.1:4222" };
const nc = await natsConnect(natsOpts);
const searchProvider = createSearchProvider();

function buildWebTools(emit: (line: string) => void): AxAgentFunctionGroup[] {
  const supportsFindSimilar = typeof searchProvider.findSimilar === "function";
  const capabilities = ["search", "fetch", supportsFindSimilar ? "findSimilar" : null]
    .filter(Boolean)
    .join(", ");
  const functions = [
        fn("search")
          .description(
            "Search the web and return a ranked list of results (title, url, snippet). Use 3-8 max results per call; issue multiple narrow queries instead of one broad one.",
          )
          .arg("query", f.string("Search query. Be specific — include entity names, dates, or constraints."))
          .arg("maxResults", f.number("Maximum results to return (1-10, default 5).").optional())
          .returns(
            f
              .json("Array of { title, url, snippet, score } objects; empty array if nothing relevant.")
              .array(),
          )
          .handler(async ({ query, maxResults }) => {
            const q = String(query ?? "").trim();
            if (!q) return [];
            emit(`→ web.search(${JSON.stringify(q)})`);
            try {
              return await searchProvider.search(q, { maxResults: Number(maxResults) || undefined });
            } catch (err) {
              emit(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
              throw err;
            }
          })
          .build(),
        fn("fetch")
          .description(
            "Extract the readable content of a single web page by URL. Returns plaintext; large pages are truncated by the runtime character cap.",
          )
          .arg("url", f.string("Absolute http(s) URL to extract."))
          .returns(f.json("{ url, title?, content } with plaintext content from the page."))
          .handler(async ({ url }) => {
            const u = String(url ?? "").trim();
            if (!u) throw new Error("fetch: url is required");
            emit(`→ web.fetch(${JSON.stringify(u)})`);
            try {
              return await searchProvider.fetch(u);
            } catch (err) {
              emit(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
              throw err;
            }
          })
          .build(),
  ];

  if (supportsFindSimilar) {
    functions.push(
      fn("findSimilar")
        .description(
          "Given a seed URL, return pages semantically similar to it (same topic, style, or argument) without requiring a fresh query. Use after you find one good source to recursively discover more like it. Provider-specific: only available when the backend supports it.",
        )
        .arg("url", f.string("Seed URL; find pages similar to this one."))
        .arg("maxResults", f.number("Maximum results to return (1-10, default 5).").optional())
        .returns(
          f
            .json("Array of { title, url, snippet, score } objects; empty array if nothing relevant.")
            .array(),
        )
        .handler(async ({ url, maxResults }) => {
          const u = String(url ?? "").trim();
          if (!u) throw new Error("findSimilar: url is required");
          emit(`→ web.findSimilar(${JSON.stringify(u)})`);
          try {
            return await searchProvider.findSimilar!(u, {
              maxResults: Number(maxResults) || undefined,
            });
          } catch (err) {
            emit(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
            throw err;
          }
        })
        .build(),
    );
  }

  return [
    {
      namespace: "web",
      title: "Web Research",
      selectionCriteria:
        "Use for any question that requires current facts, external sources, or citations that aren't in the prompt.",
      description: `Pluggable web search + page extraction backed by "${searchProvider.name}" (capabilities: ${capabilities}). Prefer narrow, specific queries over broad ones; fetch only the URLs you actually cite.`,
      functions,
    },
  ];
}

// `owner` is a single NATS subject token — dots and wildcards would split or
// widen the subject (`agents.prompt.research.<owner>.rlm`), so sanitize whatever
// the environment hands us (e.g. USER=john.doe → john_doe) before using it.
const owner = (process.env["USER"] ?? "anon").replace(/[.*>\s]/g, "_") || "anon";

// AgentService (the host SDK's production-shape helper, same as examples/dspy/)
// owns registration, the verb-first prompt/status subjects, heartbeats, and the
// §6.5 stream terminator on every completion path.
const service = new AgentService({
  nc,
  agent: "research",
  owner,
  name: "rlm",
  description:
    "DSPy-style deep-research agent built on ax-llm RLM: sandboxed JS REPL + llmQuery + pluggable web search.",
  version: "0.1.0",
  maxPayload: "1MB",
  attachmentsOk: false,
  heartbeatIntervalS: 10,
  // We stream our own per-turn status lines below, so disable AgentService's
  // keep-alive ack to avoid interleaving two status streams (matches dspy/).
  keepaliveIntervalS: null,
});

service.onPrompt(async (envelope, response) => {
  // §5.3 plain-text shorthand and §5.1 JSON envelopes both surface as
  // `envelope.prompt` thanks to AgentService's decoder.
  const question = envelope.prompt;

  await response.send({ type: "status", status: "ack" });
  await response.send({ type: "status", status: `provider: ${searchProvider.name}` });

  const emit = (line: string): void => void response.send({ type: "status", status: line });

  // The Recursive Language Model agent. The Actor writes JS in a sandboxed
  // Worker; top-level globals persist across turns; `llmQuery(prompt, ctx?)`
  // delegates to a cheaper sub-LLM for semantic work; `web.search` /
  // `web.fetch` are exposed as injected async functions inside the REPL.
  const researcher = agent(
    'question:string "the user\'s research question" ' +
      '-> report:string "markdown research report with inline [n] citations", ' +
      'citations:string[] "ordered list of source URLs matching the [n] markers in the report"',
    {
      agentIdentity: {
        name: "Deep Research Agent",
        description:
          "Plans subtopics, gathers sources via web.search, extracts evidence via web.fetch, synthesizes a cited markdown report.",
      },
      contextFields: [],
      runtime: new AxJSRuntime({
        permissions: [AxJSRuntimePermission.TIMING],
      }),
      maxTurns: MAX_TURNS,
      maxSubAgentCalls: MAX_SUB_CALLS,
      mode: "simple",
      contextPolicy: {
        preset: "checkpointed",
        budget: "balanced",
      },
      // ax's agent `functions` parameter is a narrow union that doesn't surface
      // the `{ local: AxAgentFunctionGroup[] }` shape in its public types;
      // `as never` opts out so we can pass the web tool group.
      functions: { local: buildWebTools(emit) } as never,
      actorOptions: {
        description: [
          "You are a deep-research actor. The user's question is in `inputs.question`.",
          "Workflow you should self-organize in JS:",
          "  1. Plan 2-5 subtopics that together cover the question. Store them as a global.",
          "  2. For each subtopic, call `await web.search(query, { maxResults: 5 })`. Store results.",
          "  3. Rank URLs by relevance; for the top few, call `await web.fetch(url)` to get content.",
          "  4. (optional) If `web.findSimilar` is available and one source is unusually good, call `await web.findSimilar(goodUrl)` to recursively expand that direction instead of inventing a new keyword query.",
          "  5. Use `await llmQuery('extract facts relevant to X', { page })` to pull evidence from fetched pages, one page at a time. Keep evidence + source URL in a global array.",
          "  6. When you have enough evidence (aim for >=3 distinct sources), call `submit('done')`.",
          "Hard rules:",
          "  - Every claim in the final report must be backed by a URL you actually fetched.",
          "  - Prefer many narrow queries over one broad query.",
          "  - Use `console.log` to inspect intermediate data, but keep output small.",
        ].join("\n"),
        // NVIDIA's vLLM rejects reasoning_effort="minimal" (accepts only
        // low/medium/high). Keep this at "low" unless you switch to an
        // endpoint that supports "minimal" (e.g. native OpenAI gpt-5).
        thinkingTokenBudget: "low",
      },
      agentStatusCallback: (message, status) => {
        emit(`[${status}] ${message}`);
      },
      actorTurnCallback: ({ turn: t, code }) => {
        const firstLine = code.split("\n").find((l) => l.trim()) ?? "";
        emit(`turn ${t}: ${firstLine.slice(0, 120)}${firstLine.length > 120 ? "…" : ""}`);
      },
      debug: DEBUG_TRACE,
    },
  );

  // AgentService emits the §6.5 stream terminator when this handler returns, so
  // surfacing the error as a response chunk (rather than re-throwing) keeps any
  // partial report intact instead of turning it into a §9.1 500.
  try {
    const result = await researcher.forward(llm, { question });
    if (result.report) await response.send(String(result.report));
    const citations = Array.isArray(result.citations) ? result.citations : [];
    if (citations.length > 0) {
      await response.send("\n\n---\n**Sources**\n");
      for (let i = 0; i < citations.length; i++) {
        await response.send(`\n[${i + 1}] ${citations[i]}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await response.send(`\n[agent error] ${message}`);
  }
});

await service.start();
console.log(`research agent listening on ${service.subject.prompt}`);
console.log(`model:    ${MODEL}`);
console.log(`provider: ${searchProvider.name}`);
console.log(`turns:    ${MAX_TURNS} (subcalls ${MAX_SUB_CALLS})`);
console.log("press Ctrl+C to stop");

const shutdown = async (): Promise<void> => {
  console.log("\nshutting down…");
  await service.stop();
  await nc.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
