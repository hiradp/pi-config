import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import header from "./header.ts";
import statusFooter from "./status-footer.ts";
import turnProgress from "./turn-progress.ts";

export default function (pi: ExtensionAPI) {
  header(pi);
  statusFooter(pi);
  turnProgress(pi);
}
