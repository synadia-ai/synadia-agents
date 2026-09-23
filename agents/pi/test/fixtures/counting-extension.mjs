// A test extension for `test/smoke.mjs`: it takes every hook the channel
// offers, counts the events it receives and records what they carried, on
// `globalThis.__piSmokeExtension` for the smoke to read. It adds one field
// to the heartbeat and one header to PI's provider requests, and binds an
// AsyncLocalStorage around the request handler and the injection so the
// smoke can see where each event runs. Nothing here means anything to the
// channel; it is a counter.
import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage();

export default function createExtension(ctx) {
  const state = {
    ctx,
    started: 0,
    stopping: 0,
    handles: null,
    promptAccepted: 0,
    acceptedIn: null,
    lastAccepted: null,
    promptEnded: [],
    aroundInject: 0,
    injectedRequests: [],
    providerHeaders: 0,
    aroundToolCall: [],
    interceptedExtras: [],
    promptInterceptorCalls: 0,
  };
  globalThis.__piSmokeExtension = state;
  return {
    name: "smoke-counter",
    requestInterceptors: [
      {
        aroundRequest(rctx, next) {
          state.interceptedExtras.push(rctx.envelope.extras ?? {});
          return als.run(`request:${state.interceptedExtras.length}`, next);
        },
      },
    ],
    promptInterceptors: [
      {
        beforePrompt() {
          state.promptInterceptorCalls++;
          return { headers: { "x-smoke": "1" } };
        },
      },
    ],
    heartbeatExtras: () => ({ smoke_extension: "loaded" }),
    toolExtensions: [{ discoveryFields: () => ({ smoke: true }) }],
    async started(handles) {
      state.started++;
      state.handles = handles;
    },
    async stopping() {
      state.stopping++;
    },
    events: {
      promptAccepted(request) {
        state.promptAccepted++;
        state.lastAccepted = request;
        state.acceptedIn = als.getStore() ?? null;
      },
      promptEnded(request, outcome, atMs) {
        state.promptEnded.push({ id: request.id, outcome, atMs });
      },
      aroundInject(request, run) {
        state.aroundInject++;
        state.injectedRequests.push(request.id);
        return als.run(`inject:${request.id}`, run);
      },
      providerHeaders(request) {
        state.providerHeaders++;
        return { "x-smoke-request": request.id, "x-smoke-store": String(als.getStore() ?? null) };
      },
      aroundToolCall(request, toolName, run) {
        state.aroundToolCall.push({ id: request?.id ?? null, toolName });
        return run();
      },
    },
  };
}
