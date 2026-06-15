import type { CodexChannelConfig } from "./types.js";
import { endpointFingerprint } from "./identity.js";

export interface EndpointRegistryEntry {
  readonly id: string;
  readonly endpoint: string;
  readonly authToken?: string;
  readonly explicitAliases?: Readonly<Record<string, string>>;
}

export class EndpointRegistry {
  readonly #entries: EndpointRegistryEntry[];

  constructor(entries: readonly EndpointRegistryEntry[]) {
    if (entries.length === 0) throw new Error("manager endpoint registry is empty; configure explicit endpoints");
    const seen = new Set<string>();
    this.#entries = entries.map((entry, index) => {
      if (!entry.endpoint) throw new Error(`manager endpoint ${index + 1} is empty`);
      const id = entry.id || endpointFingerprint(entry.endpoint);
      if (seen.has(id)) throw new Error(`duplicate manager endpoint id ${id}`);
      seen.add(id);
      return { ...entry, id };
    });
  }

  list(): readonly EndpointRegistryEntry[] { return this.#entries; }

  static fromConfig(config: CodexChannelConfig): EndpointRegistry {
    const managerEndpoints = config.manager.endpoints ?? [];
    const endpoints = managerEndpoints.length > 0
      ? managerEndpoints
      : config.codex.endpoint
        ? [config.codex.endpoint]
        : [];
    const entries = endpoints.map((endpoint) => {
      const entry: EndpointRegistryEntry = { id: endpointFingerprint(endpoint), endpoint };
      if (config.codex.endpointAuth !== undefined) return { ...entry, authToken: config.codex.endpointAuth };
      return entry;
    });
    return new EndpointRegistry(entries);
  }
}
