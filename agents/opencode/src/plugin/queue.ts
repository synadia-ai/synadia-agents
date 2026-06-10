import type { PluginEventQueue, PluginPromptEventQueueItem } from "./types.js";
import { AsyncQueue } from "../async-queue.js";

export class AsyncPluginEventQueue extends AsyncQueue<PluginPromptEventQueueItem> implements PluginEventQueue {}
