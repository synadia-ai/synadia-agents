import { createFlueClient, type AttachedAgentEvent } from "@flue/sdk";
import type { FlueBridgeClient } from "./bridge.js";

/** Flue SDK-backed bridge client. Opens a direct agent connection per prompt. */
export class SdkFlueBridgeClient implements FlueBridgeClient {
  async prompt(input: Parameters<FlueBridgeClient["prompt"]>[0], events?: Parameters<FlueBridgeClient["prompt"]>[1]): Promise<unknown> {
    const client = createFlueClient({ baseUrl: input.baseUrl });
    const payload = { message: input.message, session: input.session };

    if (input.transport === "http-sync") {
      const { result } = await client.agents.invoke(input.agent, input.instance, { mode: "sync", payload });
      return result;
    }

    if (input.transport === "http-stream") {
      const eventsSeen: AttachedAgentEvent[] = [];
      const textParts: string[] = [];
      for await (const event of client.agents.invoke(input.agent, input.instance, { mode: "stream", payload })) {
        eventsSeen.push(event);
        if (event.type === "text_delta") {
          textParts.push(event.text);
          await events?.onTextDelta?.(event.text);
        }
      }
      const text = textParts.join("");
      return events?.onTextDelta ? "" : text;
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
