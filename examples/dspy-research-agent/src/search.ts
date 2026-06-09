// Pluggable web-search / page-fetch abstraction used by the RLM agent's
// `web.*` tool group. Today only Tavily is implemented, but the interface is
// the only thing the agent sees — add a new provider here, wire it in
// `createSearchProvider`, and nothing in index.ts changes.

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
}

export interface FetchedPage {
  url: string;
  title?: string;
  content: string;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, opts?: { maxResults?: number }): Promise<SearchResult[]>;
  fetch(url: string): Promise<FetchedPage>;
  /**
   * Neural "more like this" — given a seed URL, return semantically similar
   * pages without having to invent a follow-up query. Optional: only some
   * providers support it (Exa does; Tavily does not). Call sites should
   * feature-check with `typeof provider.findSimilar === "function"`.
   */
  findSimilar?(url: string, opts?: { maxResults?: number }): Promise<SearchResult[]>;
}

// URLs reaching `fetch`/`findSimilar` are LLM-generated inside the sandboxed
// REPL. Before handing one to a search backend, assert it's a real http(s)
// URL so a hallucinated `file://`, `data:`, or bare string can't be smuggled
// through to the provider.
function assertHttpUrl(url: string): void {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`only http/https URLs are supported, got: ${url.slice(0, 80)}`);
  }
}

// ---------------------------------------------------------------------------
// Tavily — https://docs.tavily.com/
// ---------------------------------------------------------------------------

class TavilyProvider implements SearchProvider {
  readonly name = "tavily";
  constructor(private readonly apiKey: string) {}

  async search(query: string, opts?: { maxResults?: number }): Promise<SearchResult[]> {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        search_depth: "basic",
        max_results: Math.min(Math.max(opts?.maxResults ?? 5, 1), 10),
        include_answer: false,
        include_raw_content: false,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`tavily search ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
    return (data.results ?? []).map((r) => ({
      title: String(r["title"] ?? ""),
      url: String(r["url"] ?? ""),
      snippet: String(r["content"] ?? ""),
      score: typeof r["score"] === "number" ? (r["score"] as number) : undefined,
    }));
  }

  async fetch(url: string): Promise<FetchedPage> {
    assertHttpUrl(url);
    const res = await fetch("https://api.tavily.com/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: this.apiKey, urls: [url] }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`tavily extract ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      results?: Array<{ url?: string; raw_content?: string }>;
      failed_results?: Array<{ url?: string; error?: string }>;
    };
    const hit = data.results?.[0];
    if (!hit?.raw_content) {
      const failed = data.failed_results?.[0];
      throw new Error(`tavily extract: no content for ${url}${failed?.error ? ` (${failed.error})` : ""}`);
    }
    return {
      url: hit.url ?? url,
      content: hit.raw_content,
    };
  }
}

// ---------------------------------------------------------------------------
// Exa — https://docs.exa.ai/ (neural + keyword search, content extraction in
// a single request). API key goes in the `x-api-key` header.
// ---------------------------------------------------------------------------

class ExaProvider implements SearchProvider {
  readonly name = "exa";
  constructor(private readonly apiKey: string) {}

  async search(query: string, opts?: { maxResults?: number }): Promise<SearchResult[]> {
    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.apiKey },
      body: JSON.stringify({
        query,
        numResults: Math.min(Math.max(opts?.maxResults ?? 5, 1), 10),
        type: "auto",
        contents: { text: { maxCharacters: 1000 } },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`exa search ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
    return (data.results ?? []).map((r) => ({
      title: String(r["title"] ?? ""),
      url: String(r["url"] ?? ""),
      snippet: String(r["text"] ?? ""),
      score: typeof r["score"] === "number" ? (r["score"] as number) : undefined,
    }));
  }

  async fetch(url: string): Promise<FetchedPage> {
    assertHttpUrl(url);
    const res = await fetch("https://api.exa.ai/contents", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.apiKey },
      body: JSON.stringify({ urls: [url], text: true }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`exa contents ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      results?: Array<{ url?: string; title?: string; text?: string }>;
    };
    const hit = data.results?.[0];
    if (!hit?.text) {
      throw new Error(`exa contents: no text for ${url}`);
    }
    return { url: hit.url ?? url, title: hit.title, content: hit.text };
  }

  async findSimilar(url: string, opts?: { maxResults?: number }): Promise<SearchResult[]> {
    assertHttpUrl(url);
    const res = await fetch("https://api.exa.ai/findSimilar", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.apiKey },
      body: JSON.stringify({
        url,
        numResults: Math.min(Math.max(opts?.maxResults ?? 5, 1), 10),
        contents: { text: { maxCharacters: 1000 } },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`exa findSimilar ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
    return (data.results ?? []).map((r) => ({
      title: String(r["title"] ?? ""),
      url: String(r["url"] ?? ""),
      snippet: String(r["text"] ?? ""),
      score: typeof r["score"] === "number" ? (r["score"] as number) : undefined,
    }));
  }
}

// ---------------------------------------------------------------------------
// Stub — lets the agent start without any search key. Returns a clear message
// so the LLM can tell the user what's missing instead of hanging.
// ---------------------------------------------------------------------------

class StubProvider implements SearchProvider {
  readonly name = "stub";
  constructor(private readonly reason: string) {}
  async search(): Promise<SearchResult[]> {
    throw new Error(`web search is disabled: ${this.reason}`);
  }
  async fetch(): Promise<FetchedPage> {
    throw new Error(`web fetch is disabled: ${this.reason}`);
  }
}

// ---------------------------------------------------------------------------
// Factory — env-driven selection. Add new providers above and extend this.
// ---------------------------------------------------------------------------

export function createSearchProvider(env: NodeJS.ProcessEnv = process.env): SearchProvider {
  const explicit = env["RESEARCH_PROVIDER"]?.toLowerCase();
  const tavilyKey = env["TAVILY_API_KEY"];
  const exaKey = env["EXA_API_KEY"];

  if (explicit === "tavily") {
    return tavilyKey
      ? new TavilyProvider(tavilyKey)
      : new StubProvider("RESEARCH_PROVIDER=tavily but TAVILY_API_KEY is not set");
  }
  if (explicit === "exa") {
    return exaKey
      ? new ExaProvider(exaKey)
      : new StubProvider("RESEARCH_PROVIDER=exa but EXA_API_KEY is not set");
  }
  if (explicit) {
    return new StubProvider(`unknown RESEARCH_PROVIDER=${explicit}`);
  }
  // Auto-select: Tavily first, then Exa. Tie goes to whichever key is set.
  if (tavilyKey) return new TavilyProvider(tavilyKey);
  if (exaKey) return new ExaProvider(exaKey);
  return new StubProvider("no TAVILY_API_KEY or EXA_API_KEY set");
}
