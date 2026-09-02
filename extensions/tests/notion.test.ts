import assert from "node:assert/strict";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { extractToken, invalidateToken, type CommandRunner } from "../notion/auth.ts";
import { MAX_DATABASE_ROWS, MAX_PAGE_CHUNKS, readNotion, searchNotion } from "../notion/client.ts";
import { truncateToolOutput } from "../notion/index.ts";
import {
  renderBlocks,
  richTextToMarkdown,
  richTextToPlainText,
  tableCell,
} from "../notion/markdown.ts";
import type { NotionBlock, StoredRecord } from "../notion/types.ts";
import { notionUrl, parseNotionId, unwrap } from "../notion/utils.ts";

const PAGE_ID = "01234567-89ab-cdef-0123-456789abcdef";
const COMPACT_ID = "0123456789abcdef0123456789abcdef";
const API = "https://www.notion.so/api/v3/";

function block(type: string, title?: string, extra: Partial<NotionBlock> = {}): NotionBlock {
  return { type, ...(title === undefined ? {} : { properties: { title: [[title]] } }), ...extra };
}

function blockMap(entries: Record<string, NotionBlock>): Map<string, NotionBlock> {
  return new Map(Object.entries(entries));
}

function stored<T>(value: T, spaceId?: string): StoredRecord<T> {
  return { value: { value }, ...(spaceId ? { spaceId } : {}) };
}

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

interface RecordedCall {
  url: string;
  endpoint: string;
  body: Record<string, unknown>;
  init: RequestInit;
}

type Handler = (call: RecordedCall) => unknown;

async function withFetch<T>(handler: Handler, run: (calls: RecordedCall[]) => Promise<T>) {
  const calls: RecordedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (init?.signal?.aborted) throw init.signal.reason;
    const call: RecordedCall = {
      url,
      endpoint: url.slice(API.length),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      init: init ?? {},
    };
    calls.push(call);
    const result = handler(call);
    return result instanceof Response ? result : json(result);
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function pageHandler(page: NotionBlock, extra: Record<string, NotionBlock> = {}): Handler {
  return ({ endpoint }) => {
    if (endpoint === "syncRecordValues") {
      return { recordMap: { block: { [PAGE_ID]: stored(page, "space-1") } } };
    }
    if (endpoint === "loadPageChunk") {
      const records = Object.fromEntries(
        Object.entries(extra).map(([id, value]) => [id, stored(value)]),
      );
      return {
        recordMap: { block: { [PAGE_ID]: stored(page), ...records } },
        cursor: { stack: [] },
      };
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
}

process.env.NOTION_TOKEN = "v02:test";

async function withToken<T>(token: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.NOTION_TOKEN;
  invalidateToken();
  if (token === undefined) delete process.env.NOTION_TOKEN;
  else process.env.NOTION_TOKEN = token;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = previous;
    invalidateToken();
  }
}

const SAFE_STORAGE_PASSWORD = "safe-storage-password";
const COOKIE_TOKEN = "v02:user_token_or_cookies_v2:AbC-123_xyz";

function encryptCookie(plaintext: Buffer, version = "v10"): string {
  const key = pbkdf2Sync(SAFE_STORAGE_PASSWORD, "saltysalt", 1003, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from(version), cipher.update(plaintext), cipher.final()])
    .toString("hex")
    .toUpperCase();
}

function cookieFixture(): { directory: string; cookieDatabase: string } {
  const directory = mkdtempSync(join(tmpdir(), "notion-test-"));
  const cookieDatabase = join(directory, "Cookies");
  writeFileSync(cookieDatabase, "not a real database");
  writeFileSync(`${cookieDatabase}-journal`, "");
  return { directory, cookieDatabase };
}

interface RunnerCall {
  command: string;
  args: string[];
  copyExisted: boolean;
  journalExisted: boolean;
}

function cookieRunner(responses: Partial<Record<"security" | "sqlite3", string | Error>>): {
  run: CommandRunner;
  calls: RunnerCall[];
} {
  const calls: RunnerCall[] = [];
  const run: CommandRunner = async (command, args, signal) => {
    if (signal?.aborted) throw signal.reason;
    await new Promise((resolve) => setImmediate(resolve));
    calls.push({
      command,
      args,
      copyExisted: command === "sqlite3" && existsSync(args[0]),
      journalExisted: command === "sqlite3" && existsSync(`${args[0]}-journal`),
    });
    const response = responses[command as "security" | "sqlite3"];
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error(`unexpected command ${command}`);
    return `${response}\n`;
  };
  return { run, calls };
}

test("renders paragraph children indented under the paragraph", () => {
  const blocks = blockMap({
    p: block("text", "Parent", { content: ["c1", "c2"] }),
    c1: block("text", "Child paragraph"),
    c2: block("bulleted_list", "Child bullet"),
  });

  assert.equal(renderBlocks(["p"], blocks), "Parent\n\n  Child paragraph\n\n  - Child bullet");
});

test("renders a toggle heading's body under the heading", () => {
  const blocks = blockMap({
    h: block("header", "Toggle heading", { format: { toggleable: true }, content: ["b1", "b2"] }),
    b1: block("text", "Body"),
    b2: block("sub_header", "Nested toggle", { content: ["b3"] }),
    b3: block("text", "Deeper"),
  });

  assert.equal(
    renderBlocks(["h"], blocks),
    "# Toggle heading\n\nBody\n\n## Nested toggle\n\nDeeper\n",
  );
});

test("indents nested lists and resets numbering after another block type", () => {
  const blocks = blockMap({
    n1: block("numbered_list", "One", { content: ["n1a", "n1b"] }),
    n1a: block("numbered_list", "Sub one"),
    n1b: block("numbered_list", "Sub two"),
    n2: block("numbered_list", "Two"),
    b1: block("bulleted_list", "Bullet", { content: ["b1a"] }),
    b1a: block("bulleted_list", "Nested bullet"),
    n3: block("numbered_list", "Restart"),
  });

  assert.equal(
    renderBlocks(["n1", "n2", "b1", "n3"], blocks),
    "1. One\n   1. Sub one\n   2. Sub two\n2. Two\n- Bullet\n  - Nested bullet\n1. Restart",
  );
});

test("renders to-do items with their checked state", () => {
  const blocks = blockMap({
    t1: { type: "to_do", properties: { title: [["Done"]], checked: [["Yes"]] } },
    t2: { type: "to_do", properties: { title: [["Open"]], checked: [["No"]] } },
    t3: block("to_do", "Unset"),
  });

  assert.equal(renderBlocks(["t1", "t2", "t3"], blocks), "- [x] Done\n- [ ] Open\n- [ ] Unset");
});

test("renders tables with and without a header row", () => {
  const rows = {
    r1: { type: "table_row", properties: { ca: [["Name"]], cb: [["Value"]] } },
    r2: { type: "table_row", properties: { ca: [["a|b"]], cb: [["line1\nline2"]] } },
  };
  const withHeader = blockMap({
    ...rows,
    tbl: {
      type: "table",
      content: ["r1", "r2"],
      format: { table_block_column_order: ["ca", "cb"], table_block_column_header: true },
    },
  });
  const withoutHeader = blockMap({ ...rows, tbl: { type: "table", content: ["r1", "r2"] } });

  assert.equal(
    renderBlocks(["tbl"], withHeader),
    "| Name | Value |\n| --- | --- |\n| a\\|b | line1 line2 |\n",
  );
  assert.equal(
    renderBlocks(["tbl"], withoutHeader),
    "|  |  |\n| --- | --- |\n| Name | Value |\n| a\\|b | line1 line2 |\n",
  );
});

test("indents the whole code block inside a list item", () => {
  const blocks = blockMap({
    li: block("bulleted_list", "Item", { content: ["code"] }),
    code: {
      type: "code",
      properties: { title: [["const a = 1;\nconst b = 2;"]], language: [["JavaScript"]] },
    },
  });

  assert.equal(
    renderBlocks(["li"], blocks),
    "- Item\n  ```javascript\n  const a = 1;\n  const b = 2;\n  ```\n",
  );
});

test("uses a longer fence when code contains three backticks", () => {
  const blocks = blockMap({
    code: { type: "code", properties: { title: [["```md\nfenced\n```"]] } },
  });

  assert.equal(renderBlocks(["code"], blocks), "````\n```md\nfenced\n```\n````\n");
});

test("stops rendering below the maximum block depth", () => {
  const entries: Record<string, NotionBlock> = {};
  for (let level = 0; level < 8; level++) {
    entries[`b${level}`] = block("bulleted_list", `L${level}`, { content: [`b${level + 1}`] });
  }
  const expected = [0, 1, 2, 3, 4, 5].map((level) => `${"  ".repeat(level)}- L${level}`);

  assert.equal(
    renderBlocks(["b0"], blockMap(entries)),
    `${expected.join("\n")}\n${"  ".repeat(6)}*(nested content omitted)*\n`,
  );
});

test("terminates on a self-referencing content cycle", () => {
  const rendered = renderBlocks(
    ["loop"],
    blockMap({ loop: block("bulleted_list", "Loop", { content: ["loop"] }) }),
  );

  assert.equal(rendered.split("- Loop").length - 1, 6);
  assert.match(rendered, /\*\(nested content omitted\)\*\n$/);
});

test("skips ids that are missing from the block map", () => {
  const blocks = blockMap({ p: block("text", "Here", { content: ["missing-child"] }) });

  assert.equal(renderBlocks(["nope"], new Map()), "");
  assert.equal(renderBlocks(["nope", "p"], blocks).trimEnd(), "Here");
});

test("renders synced blocks from their source container", () => {
  const reference: NotionBlock = {
    type: "transclusion_reference",
    format: { transclusion_reference_pointer: { id: "container", table: "block" } },
  };
  const blocks = blockMap({
    ref: reference,
    container: { type: "transclusion_container", content: ["s1"] },
    s1: block("text", "Synced paragraph"),
  });

  assert.equal(renderBlocks(["ref"], blocks), "Synced paragraph\n");
  assert.equal(
    renderBlocks(["ref"], blockMap({ ref: reference })),
    "*(synced block content unavailable)*\n",
  );
});

test("converts rich text annotations to Markdown", () => {
  assert.equal(
    richTextToMarkdown([["bold link", [["b"], ["a", "https://example.com"]]]]),
    "[**bold link**](https://example.com)",
  );
  assert.equal(
    richTextToMarkdown([["‣", [["p", PAGE_ID]]]]),
    `[Notion page](https://www.notion.so/${COMPACT_ID})`,
  );
  assert.equal(
    richTextToMarkdown([
      ["‣", [["d", { type: "daterange", start_date: "2024-01-01", end_date: "2024-01-05" }]]],
    ]),
    "2024-01-01 → 2024-01-05",
  );
  assert.equal(richTextToMarkdown([["‣", [["d", { start_date: "2024-02-02" }]]]]), "2024-02-02");
  assert.equal(richTextToMarkdown([["⁍", [["e", "E=mc^2"]]]]), "$E=mc^2$");
});

test("tolerates malformed rich text chunks", () => {
  assert.equal(richTextToMarkdown("not an array"), "");
  assert.equal(
    richTextToMarkdown([
      null,
      42,
      [],
      [undefined],
      "plain",
      ["text"],
      ["a", [["b"]]],
      ["c", ["not an annotation", ["a"], ["a", 1], 7]],
    ]),
    "plaintext**a**c",
  );
  assert.equal(richTextToPlainText([["x", [["b"]]], [null], 3, "y"]), "xy");
});

test("strips terminal control sequences from rich text but keeps line breaks", () => {
  const unsafe =
    "safe\u001bc reset \u001b[2Acursor \u009b3BC1 \u0007bell \u001b]52;c;clipboard\u0007done";

  assert.equal(richTextToMarkdown([[unsafe, [["b"]]]]), "**safe reset cursor C1 bell done**");
  assert.equal(richTextToPlainText([[unsafe]]), "safe reset cursor C1 bell done");
  assert.equal(
    richTextToPlainText([["line1\r\nline2\rline3\tend\u007f"]]),
    "line1\nline2\nline3\tend",
  );
  assert.equal(
    richTextToMarkdown([["‣", [["a", "https://example.com/\u001b[31m"]]]]),
    "[‣](https://example.com/)",
  );
});

test("extracts ids from Notion URLs and raw ids", () => {
  const view = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const peek = "cccccccccccccccccccccccccccccccc";

  assert.equal(
    parseNotionId(`https://www.notion.so/ws/Page-${COMPACT_ID}?v=${view}&p=${peek}`),
    "cccccccc-cccc-cccc-cccc-cccccccccccc",
  );
  assert.equal(parseNotionId(`https://www.notion.so/ws/Page-${COMPACT_ID}?v=${view}`), PAGE_ID);
  assert.equal(parseNotionId(COMPACT_ID), PAGE_ID);
  assert.equal(parseNotionId(` ${PAGE_ID} `), PAGE_ID);
  assert.equal(parseNotionId(`notion.so/ws/Page-${COMPACT_ID}`), PAGE_ID);
  assert.equal(
    parseNotionId(`https://www.notion.so/ws/deadbeefdeadbeefdeadbeefdeadbeef-${COMPACT_ID}`),
    PAGE_ID,
  );
  assert.equal(
    parseNotionId(`https://www.notion.so/ws/deadbeefdeadbeefdeadbeefdeadbeef/${PAGE_ID}`),
    PAGE_ID,
  );
  assert.throws(() => parseNotionId("hello"), /Could not extract a Notion page or database ID/);
});

test("round-trips ids through notionUrl", () => {
  assert.equal(notionUrl(PAGE_ID), `https://www.notion.so/${COMPACT_ID}`);
  assert.equal(parseNotionId(notionUrl(PAGE_ID)), PAGE_ID);
});

test("unwraps both stored record shapes", () => {
  assert.deepEqual(unwrap({ value: { type: "text" } }), { type: "text" });
  assert.deepEqual(
    unwrap({ value: { value: { type: "text" }, role: "reader" } } as StoredRecord<NotionBlock>),
    {
      type: "text",
    },
  );
  assert.equal(unwrap(undefined), undefined);
  assert.equal(unwrap({}), undefined);
});

test("escapes pipes and flattens line breaks in table cells", () => {
  assert.equal(tableCell([["a|b\nc", [["b"]]]]), "**a\\|b c**");
  assert.equal(tableCell(undefined), "");
});

test("sends every request to a fixed endpoint with ids and queries in the body", async () => {
  const page = block("page", "Hello", { content: ["p1"] });
  await withFetch(pageHandler(page, { p1: block("text", "World") }), async (calls) => {
    const result = await readNotion(`https://www.notion.so/ws/Hello-${COMPACT_ID}`);

    assert.deepEqual(result, {
      title: "Hello",
      type: "page",
      url: notionUrl(PAGE_ID),
      markdown: "# Hello\n\nWorld",
    });
    assert.deepEqual(
      calls.map((call) => call.url),
      [`${API}syncRecordValues`, `${API}loadPageChunk`],
    );
    const requests = calls[0].body.requests as Array<{ pointer: { id: string } }>;
    assert.equal(requests[0].pointer.id, PAGE_ID);
    assert.equal(calls[1].body.pageId, PAGE_ID);
    for (const call of calls) {
      assert.equal(call.init.method, "POST");
      assert.equal((call.init.headers as Record<string, string>).Cookie, "token_v2=v02%3Atest");
    }
  });

  await withFetch(
    () => ({ results: [], recordMap: {} }),
    async (calls) => {
      const query = "../evil?x=1#y";
      await searchNotion(query, "space-1");

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `${API}search`);
      assert.equal(calls[0].body.query, query);
      assert.equal(calls[0].body.spaceId, "space-1");
    },
  );
});

test("reports failed responses with the status and a bounded body", async () => {
  await withFetch(
    () => new Response(`${"x".repeat(1000)}`, { status: 503 }),
    async () => {
      await assert.rejects(
        readNotion(PAGE_ID),
        (error: Error) => error.message === `Notion read failed (503): ${"x".repeat(500)}`,
      );
    },
  );
  await withFetch(
    () => new Response("", { status: 404 }),
    async () => {
      await assert.rejects(readNotion(PAGE_ID), { message: "Notion read failed (404)" });
    },
  );
});

test("propagates the caller's abort signal", async () => {
  const controller = new AbortController();
  controller.abort();

  await withFetch(pageHandler(block("page", "Hello")), async (calls) => {
    await assert.rejects(readNotion(PAGE_ID, controller.signal), { name: "AbortError" });
    assert.equal(calls.length, 0);
  });
});

test("stops loading page chunks at the chunk limit", async () => {
  const page = block("page", "Long");
  await withFetch(
    ({ endpoint }) => {
      if (endpoint === "syncRecordValues") {
        return { recordMap: { block: { [PAGE_ID]: stored(page) } } };
      }
      return { recordMap: { block: {} }, cursor: { stack: [[{ id: "next" }]] } };
    },
    async (calls) => {
      await readNotion(PAGE_ID);

      const chunks = calls.filter((call) => call.endpoint === "loadPageChunk");
      assert.equal(chunks.length, MAX_PAGE_CHUNKS);
      assert.deepEqual(
        chunks.map((call) => call.body.chunkNumber),
        Array.from({ length: MAX_PAGE_CHUNKS }, (_, index) => index),
      );
    },
  );
});

test("caps database rows and notes the limit", async () => {
  const database: NotionBlock = {
    type: "collection_view_page",
    collection_id: "col",
    view_ids: ["view"],
  };
  const rowIds = Array.from({ length: MAX_DATABASE_ROWS }, (_, index) => `row${index}`);
  await withFetch(
    ({ endpoint, body }) => {
      if (endpoint === "syncRecordValues") {
        const [request] = body.requests as Array<{ pointer: { table: string } }>;
        if (request.pointer.table === "block") {
          return { recordMap: { block: { [PAGE_ID]: stored(database, "space-1") } } };
        }
        return {
          recordMap: {
            collection: {
              col: stored({
                name: [["Tasks"]],
                schema: { title: { name: "Name" }, x: { name: "Val|ue" } },
              }),
            },
          },
        };
      }
      assert.equal(endpoint, "queryCollection");
      return {
        result: { reducerResults: { collection_group_results: { blockIds: rowIds } } },
        recordMap: {
          block: Object.fromEntries(
            rowIds.map((id) => [
              id,
              stored({ type: "page", properties: { title: [[id]], x: [["v"]] } }),
            ]),
          ),
        },
      };
    },
    async (calls) => {
      const result = await readNotion(PAGE_ID);

      const query = calls.find((call) => call.endpoint === "queryCollection");
      const loader = query?.body.loader as {
        reducers: { collection_group_results: { limit: number } };
      };
      assert.equal(loader.reducers.collection_group_results.limit, MAX_DATABASE_ROWS);
      assert.equal(result.type, "database");
      assert.match(
        result.markdown,
        /^# Tasks\n\n\| Name \| Val\\\|ue \|\n\| --- \| --- \|\n\| row0 \| v \|\n/,
      );
      assert.ok(
        result.markdown.endsWith(
          `\n\n*Showing the first ${MAX_DATABASE_ROWS} entries from this view.*`,
        ),
      );
    },
  );
});

test("does not cache an empty workspace list", async () => {
  let spaceCalls = 0;
  await withFetch(
    ({ endpoint }) => {
      if (endpoint === "getSpaces") {
        spaceCalls++;
        return spaceCalls === 1
          ? {}
          : { user1: { space_view: { sv1: { value: { space_id: "space-a" } } } } };
      }
      if (endpoint === "syncRecordValues") {
        return { recordMap: { space: { "space-a": stored({ name: "Team" }) } } };
      }
      return { results: [], recordMap: {} };
    },
    async () => {
      assert.deepEqual(await searchNotion("q"), { results: [], spaces: 0 });
      assert.deepEqual(await searchNotion("q"), { results: [], spaces: 1 });
      assert.equal(spaceCalls, 2);
      await searchNotion("q");
      assert.equal(spaceCalls, 2);
    },
  );
});

test("re-extracts the token once after a 401", async () => {
  await withToken("v02:first", async () => {
    let attempts = 0;
    await withFetch(
      (call) => {
        if (call.endpoint === "syncRecordValues" && attempts++ === 0) {
          process.env.NOTION_TOKEN = "v02:second";
          return new Response("unauthorized", { status: 401 });
        }
        return pageHandler(block("page", "Hello"))(call);
      },
      async (calls) => {
        const result = await readNotion(PAGE_ID);

        assert.equal(result.title, "Hello");
        assert.deepEqual(
          calls.map((call) => (call.init.headers as Record<string, string>).Cookie),
          ["token_v2=v02%3Afirst", "token_v2=v02%3Asecond", "token_v2=v02%3Asecond"],
        );
      },
    );
  });

  await withToken("v02:same", async () => {
    await withFetch(
      () => new Response("unauthorized", { status: 401 }),
      async (calls) => {
        await assert.rejects(readNotion(PAGE_ID), {
          message: "Notion read failed (401): unauthorized",
        });
        assert.equal(calls.length, 1);
      },
    );
  });
});

test("prefers NOTION_TOKEN in either its decoded or encoded form", async () => {
  const runner = cookieRunner({ security: new Error("should not run") });

  await withToken("v02:abc", async () => {
    assert.equal(await extractToken({ runCommand: runner.run }), "v02:abc");
  });
  await withToken("v02%3Aabc", async () => {
    assert.equal(await extractToken({ runCommand: runner.run }), "v02:abc");
    await withFetch(pageHandler(block("page", "Hello")), async (calls) => {
      await readNotion(PAGE_ID);
      assert.equal((calls[0].init.headers as Record<string, string>).Cookie, "token_v2=v02%3Aabc");
    });
  });
  assert.equal(runner.calls.length, 0);

  await withToken("v02:abc\nrest", async () => {
    await assert.rejects(extractToken(), { message: "NOTION_TOKEN contains a newline." });
  });
  await withToken("v02%3Aabc%E0%A4%A", async () => {
    await assert.rejects(extractToken(), {
      message: "NOTION_TOKEN is not valid percent-encoding.",
    });
  });
});

test("decrypts the Notion.app cookie from a copy of the cookie database", async () => {
  const { directory, cookieDatabase } = cookieFixture();
  const encoded = Buffer.from(encodeURIComponent(COOKIE_TOKEN));
  const hostPrefix = createHash("sha256").update(".notion.so").digest();
  try {
    for (const plaintext of [encoded, Buffer.concat([hostPrefix, encoded])]) {
      await withToken(undefined, async () => {
        const runner = cookieRunner({
          security: SAFE_STORAGE_PASSWORD,
          sqlite3: encryptCookie(plaintext),
        });

        assert.equal(await extractToken({ runCommand: runner.run, cookieDatabase }), COOKIE_TOKEN);
        assert.equal(await extractToken({ runCommand: runner.run, cookieDatabase }), COOKIE_TOKEN);

        assert.deepEqual(
          runner.calls.map((call) => call.command),
          ["security", "sqlite3"],
        );
        assert.deepEqual(runner.calls[0].args, [
          "find-generic-password",
          "-s",
          "Notion Safe Storage",
          "-w",
        ]);
        const [copy, query] = runner.calls[1].args;
        assert.notEqual(copy, cookieDatabase);
        assert.match(query, /^SELECT hex\(encrypted_value\) FROM cookies WHERE name='token_v2'/);
        assert.equal(runner.calls[1].copyExisted, true);
        assert.equal(runner.calls[1].journalExisted, true);
        assert.equal(existsSync(copy), false);
      });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reports cookie extraction failures accurately", async () => {
  const { directory, cookieDatabase } = cookieFixture();
  const failing = (extra: Record<string, unknown>) => Object.assign(new Error("failed"), extra);
  try {
    await withToken(undefined, async () => {
      const missing = cookieRunner({ security: SAFE_STORAGE_PASSWORD });
      await assert.rejects(
        extractToken({ runCommand: missing.run, cookieDatabase: join(directory, "missing") }),
        /^Error: Notion\.app's cookie database was not found at .*missing\. Make sure Notion\.app is installed and logged in, or set NOTION_TOKEN\.$/,
      );
      assert.equal(missing.calls.length, 1);

      const noSqlite = cookieRunner({
        security: SAFE_STORAGE_PASSWORD,
        sqlite3: failing({ code: "ENOENT" }),
      });
      await assert.rejects(extractToken({ runCommand: noSqlite.run, cookieDatabase }), {
        message:
          "Could not read Notion.app's cookie database (sqlite3 is not installed). Set NOTION_TOKEN instead.",
      });

      const locked = cookieRunner({
        security: SAFE_STORAGE_PASSWORD,
        sqlite3: failing({ code: 1, stderr: "Error: in prepare, database is locked (5)\n" }),
      });
      await assert.rejects(extractToken({ runCommand: locked.run, cookieDatabase }), {
        message:
          "Could not read Notion.app's cookie database (sqlite3 failed: Error: in prepare, database is locked (5)). Set NOTION_TOKEN instead.",
      });

      const timedOut = cookieRunner({ security: failing({ killed: true, signal: "SIGTERM" }) });
      await assert.rejects(extractToken({ runCommand: timedOut.run, cookieDatabase }), {
        message:
          "Could not read Notion Safe Storage from the macOS Keychain (security timed out after 60s). Make sure Notion.app is installed and logged in, or set NOTION_TOKEN.",
      });

      const denied = cookieRunner({
        security: failing({
          code: 44,
          stderr:
            "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n",
        }),
      });
      await assert.rejects(extractToken({ runCommand: denied.run, cookieDatabase }), {
        message:
          "Could not read Notion Safe Storage from the macOS Keychain (security failed: security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.). Make sure Notion.app is installed and logged in, or set NOTION_TOKEN.",
      });

      const empty = cookieRunner({ security: SAFE_STORAGE_PASSWORD, sqlite3: "" });
      await assert.rejects(extractToken({ runCommand: empty.run, cookieDatabase }), {
        message: "Notion's token_v2 cookie was not found. Make sure Notion.app is logged in.",
      });

      const controller = new AbortController();
      controller.abort();
      const aborted = cookieRunner({ security: SAFE_STORAGE_PASSWORD });
      await assert.rejects(
        extractToken({ runCommand: aborted.run, cookieDatabase, signal: controller.signal }),
        { name: "AbortError" },
      );
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wraps undecryptable cookie values in a friendly error", async () => {
  const { directory, cookieDatabase } = cookieFixture();
  try {
    await withToken(undefined, async () => {
      const shortCiphertext = cookieRunner({
        security: SAFE_STORAGE_PASSWORD,
        sqlite3: Buffer.concat([Buffer.from("v10"), Buffer.alloc(5, 1)]).toString("hex"),
      });
      await assert.rejects(extractToken({ runCommand: shortCiphertext.run, cookieDatabase }), {
        message: "Could not decrypt Notion's token_v2 cookie. Set NOTION_TOKEN instead.",
      });

      const wrongKey = cookieRunner({
        security: "another password",
        sqlite3: encryptCookie(Buffer.from(encodeURIComponent(COOKIE_TOKEN))),
      });
      await assert.rejects(extractToken({ runCommand: wrongKey.run, cookieDatabase }), {
        message: "Could not decrypt Notion's token_v2 cookie. Set NOTION_TOKEN instead.",
      });

      const unsupported = cookieRunner({
        security: SAFE_STORAGE_PASSWORD,
        sqlite3: encryptCookie(Buffer.from("v02:x"), "v99"),
      });
      await assert.rejects(extractToken({ runCommand: unsupported.run, cookieDatabase }), {
        message: "Notion's cookie encryption format is not supported. Set NOTION_TOKEN instead.",
      });
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("formats truncation notices for both truncation branches", () => {
  const omitted = truncateToolOutput("x".repeat(DEFAULT_MAX_BYTES + 1));
  assert.equal(omitted.text, "[Output omitted because its first line exceeds 50.0KB.]");
  assert.equal(omitted.truncation?.firstLineExceedsLimit, true);

  const lines = Array.from({ length: DEFAULT_MAX_LINES + 1 }, (_, index) => `line ${index}`);
  const truncated = truncateToolOutput(lines.join("\n"));
  assert.ok(truncated.text.startsWith("line 0\nline 1\n"));
  assert.match(
    truncated.text,
    /\nline 1999\n\n\[Output truncated: showing 2000 of 2001 lines \(\d+\.\dKB of \d+\.\dKB\)\.\]$/,
  );
  assert.equal(truncated.truncation?.outputLines, DEFAULT_MAX_LINES);

  assert.deepEqual(truncateToolOutput("short"), { text: "short" });
});
