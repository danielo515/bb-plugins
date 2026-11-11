// bb-plugin-context-meter is frontend-only (app.tsx); bb requires a server
// entry, so this one only logs its lifecycle.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default async function plugin(bb: BbPluginApi) {
  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
