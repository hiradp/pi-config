import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import statusFooter from "./status-footer.ts";
import turnProgress from "./turn-progress.ts";

export default function (pi: ExtensionAPI) {
  statusFooter(pi);
  turnProgress(pi);
}
