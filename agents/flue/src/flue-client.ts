import { createFlueClient, type AttachedAgentEvent } from "@flue/sdk";
import type { FlueBridgeClient } from "./bridge.js";

/** Flue SDK-backed bridge client. Opens a direct agent connection per prompt. */
export class SdkFlueBridgeClient implements FlueBridgeClient {
  async prompt(input: Parameters<FlueBridgeClient["prompt"]>[0]): Promise<unknown> {
    const client = createFlueClient({ baseUrl: input.baseUrl });
    const payload = { message: input.message, session: input.session };

    if (input.transport === "http-sync") {
      const { result } = await client.agents.invoke(input.agent, input.instance, { mode: "sync", payload });
      return result;
    }

    if (input.transport === "http-stream") {
      const events: AttachedAgentEvent[] = [];
      for await (const event of client.agents.invoke(input.agent, input.instance, { mode: "stream", payload })) {
        events.push(event);
      }
      const text = events
        .filter((event): event is Extract<AttachedAgentEvent, { type: "text_delta" }> => event.type === "text_delta")
        .map((event) => event.text)
        .join("");
      return text || events;
    }

    const socket = client.agents.connect(input.agent, input.instance);
    try {
      await socket.ready;
      const { result } = await socket.prompt(input.message, { session: input.session });
      return result;
    } finally {
      socket.close();
    }
  }
}
