import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { SessionEntry, SessionInfo } from "@earendil-works/pi-coding-agent";
import {
  clip,
  compactEvidence,
  evidenceForSession,
  redactSessionText,
} from "../session-review/sessions.ts";
import type { LoadedSession } from "../session-review/types.ts";

const AT = "2026-08-30T10:00:00.000Z";

function alphanumeric(length: number): string {
  let out = "";
  let seed = "session-review";
  while (out.length < length) {
    seed = createHash("sha256").update(seed).digest("base64");
    out += seed.replaceAll(/[^A-Za-z0-9]/g, "");
  }
  return out.slice(0, length);
}

function info(): SessionInfo {
  return {
    id: "session",
    path: "/sessions/session.jsonl",
    cwd: "/code/repo",
    created: new Date(AT),
    modified: new Date(AT),
    messageCount: 3,
    firstMessage: "Write the file",
    allMessagesText: "",
  };
}

test("redacts around a long alphanumeric line in bounded time", () => {
  const blob = alphanumeric(40_000);
  const input = `API_TOKEN=abc123 before ${blob} after password: "hunter2" done`;

  const start = performance.now();
  const redacted = redactSessionText(input);
  const elapsed = performance.now() - start;

  assert.doesNotMatch(redacted, /abc123|hunter2/);
  assert.match(redacted, /^API_TOKEN=<redacted> before /);
  assert.ok(redacted.includes(blob));
  assert.match(redacted, / after password: "<redacted>" done$/);
  assert.ok(elapsed < 500, `redaction took ${elapsed.toFixed(0)} ms`);
});

test("redacts documented keyword keys without an identifier prefix", () => {
  assert.equal(
    redactSessionText('PRIVATE_KEY=raw-material AUTH=letmein "SECRET": "shh" ok'),
    'PRIVATE_KEY=<redacted> AUTH=<redacted> "SECRET": "<redacted>" ok',
  );
});

test("redacts an unterminated private key block", () => {
  const redacted = redactSessionText(
    "key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\nmore-material",
  );

  assert.doesNotMatch(redacted, /MIIBOgIBAAJBAK|more-material/);
  assert.equal(redacted, "key:\n<redacted-private-key>");
});

test("clips to the character bound after bounded redaction", () => {
  const clipped = clip("word ".repeat(2_000), 1_600);
  assert.equal(clipped.length, 1_600);
  assert.ok(clipped.startsWith("word word"));
  assert.ok(clipped.endsWith("…"));
  assert.equal(clip("short"), "short");

  const padded = clip(`${"a"}${" ".repeat(100)}\n`.repeat(3_000), 1_600);
  assert.ok(padded.length <= 1_600);
  assert.ok(padded.endsWith("…"));

  const material = "MATERIAL".repeat(1_000);
  const boundary = clip(
    `TOKEN=${"x".repeat(5_000)} -----BEGIN PRIVATE KEY-----\n${material}\n-----END PRIVATE KEY-----`,
    1_600,
  );
  assert.doesNotMatch(boundary, /MATERIAL/);
  assert.match(boundary, /^TOKEN=<redacted> <redacted-private-key>/);
});

test("compacts evidence to the overall bound", () => {
  const compacted = compactEvidence("x".repeat(50_000));
  assert.ok(compacted.length <= 20_000);
  assert.ok(compacted.startsWith("x".repeat(6_000)));
  assert.match(compacted, /\[older evidence omitted\]/);
  assert.equal(compactEvidence("small"), "small");
});

test("bounds evidence built from oversized tool calls and results", () => {
  const content = alphanumeric(60_000);
  const session: LoadedSession = {
    info: info(),
    entries: [
      {
        type: "message",
        id: "u",
        parentId: null,
        timestamp: AT,
        message: {
          role: "user",
          content: [{ type: "text", text: "Write the file" }],
          timestamp: 1,
        },
      },
      {
        type: "message",
        id: "a",
        parentId: "u",
        timestamp: AT,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call",
              name: "write",
              arguments: { path: "/code/repo/big.txt", content },
            },
          ],
        },
      },
      {
        type: "message",
        id: "r",
        parentId: "a",
        timestamp: AT,
        message: {
          role: "toolResult",
          toolCallId: "call",
          toolName: "bash",
          content: [{ type: "text", text: content }],
          isError: false,
          timestamp: 1,
        },
      },
    ] as SessionEntry[],
  };

  const start = performance.now();
  const evidence = evidenceForSession(session, [{ name: "repo", path: "/code/repo" }], undefined);
  const elapsed = performance.now() - start;

  assert.ok(evidence.length <= 20_000);
  const toolCall = evidence.split("\n\n").find((line) => line.startsWith("TOOL CALL write:"));
  assert.ok(toolCall);
  assert.ok(toolCall.length <= "TOOL CALL write: ".length + 1_200);
  assert.match(toolCall, /"path":"<repo:repo>\/big.txt"/);
  const toolResult = evidence.split("\n\n").find((line) => line.startsWith("TOOL RESULT bash:"));
  assert.ok(toolResult);
  assert.ok(toolResult.length <= "TOOL RESULT bash: ".length + 1_200);
  assert.ok(elapsed < 500, `evidence took ${elapsed.toFixed(0)} ms`);
});
