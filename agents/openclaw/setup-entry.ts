import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { natsPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(natsPlugin);
