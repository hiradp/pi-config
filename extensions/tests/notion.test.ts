import assert from "node:assert/strict";
import { test } from "node:test";
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

function block(type: string, title?: string, extra: Partial<NotionBlock> = {}): NotionBlock {
  return { type, ...(title === undefined ? {} : { properties: { title: [[title]] } }), ...extra };
}

function blockMap(entries: Record<string, NotionBlock>): Map<string, NotionBlock> {
  return new Map(Object.entries(entries));
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
