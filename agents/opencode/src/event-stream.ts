export interface EventStreamOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}

export async function assertEventEndpointReachable(options: EventStreamOptions): Promise<Response> {
  const fetchImpl = options.fetch ?? fetch;
  const url = new URL("/event", options.baseUrl);
  const res = await fetchImpl(url, {
    method: "GET",
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!res.ok && res.status !== 405) {
    throw new Error(`/event probe returned HTTP ${res.status}`);
  }
  return res;
}
