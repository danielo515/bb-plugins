// bb-plugin-reviewed-files — backend entry.
//
// This plugin is frontend-only: review marks are per client and live in the
// browser (localStorage), like BB's own per-client renderer choice. The manifest
// still requires a server entry, so this one only reports that it loaded.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded: diff renderer with review marks");
}
