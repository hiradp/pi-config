import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionCost } from "../footer.ts";

test("session cost includes all persisted usage", () => {
  const ctx = {
    sessionManager: {
      getEntries() {
        return [
          {
            type: "message",
            message: { role: "assistant", usage: { cost: { total: 1 } } },
          },
          {
            type: "message",
            message: { role: "toolResult", usage: { cost: { total: 2 } } },
          },
          { type: "branch_summary", usage: { cost: { total: 3 } } },
          { type: "compaction", usage: { cost: { total: 4 } } },
        ];
      },
    },
  } as unknown as ExtensionContext;

  assert.equal(sessionCost(ctx), 10);
});
