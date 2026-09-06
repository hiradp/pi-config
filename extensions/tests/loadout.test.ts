import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters as strip } from "node:util";
import { initTheme, InteractiveMode, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, Text, VStack, visibleWidth } from "@earendil-works/pi-tui";
import { StartupLoadout, type LoadoutSection } from "../ui/loadout-resources.ts";
import { loadoutLines, LoadoutView } from "../ui/loadout.ts";

const theme = {
  name: "rustic-light",
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

function startup() {
  initTheme("dark", false);
  const resources = new Container();
  const header = new Text("Pi", 0, 0);
  const headerContainer = new Container();
  headerContainer.addChild(header);
  const chat = new Text("[Skills]\nThis is a message, not an inventory.", 0, 0);
  const document = new Container();
  document.addChild(headerContainer);
  document.addChild(resources);
  document.addChild(chat);
  const root = new Container();
  root.addChild(document);

  const skills = [
    { name: "commit", filePath: "/project/skills/commit/SKILL.md" },
    { name: "review", filePath: "/project/skills/review/SKILL.md" },
  ];
  const prompts = [{ name: "checkpoint", filePath: "/project/prompts/checkpoint.md" }];
  const extensions = [
    { path: "/project/extensions/ui/index.ts" },
    { path: "/project/extensions/odd, name.ts" },
    {
      path: "/pkg/extensions/tools.ts",
      sourceInfo: { source: "npm:example", scope: "user", baseDir: "/pkg" },
    },
  ];
  const session = {
    sessionManager: { getCwd: () => "/project" },
    settingsManager: { getQuietStartup: () => false },
    promptTemplates: prompts,
    resourceLoader: {
      getSystemPromptSource: () => undefined,
      getAppendSystemPromptSources: () => [],
      getAgentsFiles: () => ({ agentsFiles: [{ path: "/project/AGENTS.md" }] }),
      getSkills: () => ({
        skills,
        diagnostics: [{ type: "warning", message: "skill conflict remains visible" }],
      }),
      getPrompts: () => ({ prompts, diagnostics: [] }),
      getThemes: () => ({
        themes: [{ name: "rustic-light", sourcePath: "/project/themes/rustic-light.json" }],
        diagnostics: [],
      }),
      getExtensions: () => ({
        extensions,
        errors: [{ path: "/broken/index.ts", error: "extension failed to load" }],
      }),
    },
    extensionRunner: {
      getCommandDiagnostics: () => [],
      getShortcutDiagnostics: () => [],
      getRegisteredCommands: () => [],
    },
  };
  // Exercise the installed Pi renderer, not a copy of its private node format.
  // No InteractiveMode constructor, session loading, or terminal I/O is involved.
  const native = Object.assign(
    Object.create(InteractiveMode.prototype) as {
      showLoadedResources(): void;
    },
    {
      runtimeHost: { session },
      options: {},
      toolOutputExpanded: true,
      loadedResourcesContainer: resources,
    },
  );
  native.showLoadedResources();
  const adapter = new StartupLoadout(root, header);
  return { root, resources, adapter, native, skills, session };
}

const plain = (component: Container, width = 120) => component.render(width).map(strip).join("\n");

test("compacts Pi's actual inventory without hiding diagnostics or transcript text", () => {
  const { root, resources, adapter } = startup();
  const original = plain(resources);
  const sections = adapter.capture();

  assert.deepEqual(
    sections.map(({ name, count }) => [name, count]),
    [
      ["Context", 1],
      ["Skills", 2],
      ["Prompts", 1],
      ["Extensions", 3],
      ["Themes", 1],
    ],
  );
  assert.match(sections.find((section) => section.name === "Extensions")!.body, /odd, name\.ts/u);
  assert.doesNotMatch(plain(resources), /\[(Context|Skills|Prompts|Extensions|Themes)\]/u);
  assert.match(plain(root), /This is a message, not an inventory/u);
  assert.match(plain(resources), /skill conflict remains visible/u);
  assert.match(plain(resources), /extension failed to load/u);
  assert.ok(!plain(resources).startsWith("\n"), "listing spacers should disappear too");
  assert.deepEqual(adapter.capture(), sections);

  adapter.dispose();
  assert.equal(plain(resources), original);
});

test("the inventory remains attached when switching to and from the fullscreen layout", () => {
  const { root, adapter } = startup();
  const sections = adapter.capture();
  const document = root.children[0]!;
  root.children = [new VStack([{ component: new ScrollView(document), grow: 1 }])];
  assert.deepEqual(adapter.capture(), sections);
  root.children = [document];
  assert.deepEqual(adapter.capture(), sections);
});

test("reload replaces the inventory instead of keeping stale counts and removed skills", () => {
  const { adapter, native, skills, resources } = startup();
  adapter.capture();
  skills.pop();
  native.showLoadedResources();
  const sections = adapter.capture();

  assert.deepEqual(
    sections.find((section) => section.name === "Skills"),
    {
      name: "Skills",
      body: "commit",
      count: 1,
    },
  );
  resources.clear();
  assert.deepEqual(adapter.capture(), []);
  adapter.dispose();
  assert.equal(resources.children.length, 0);
});

test("unrecognized startup output stays visible, including after an adapter format change", () => {
  const { resources, adapter } = startup();
  const unknown = new Text("[Future resources]\n  do not hide me", 0, 0);
  Object.assign(unknown, { getCollapsedText: () => "[Future resources]\n  do not hide me" });
  resources.addChild(unknown);
  const changed = new Text("[Skills]\nnew-format", 0, 0);
  Object.assign(changed, {
    getCollapsedText: () => "[Skills]\nnew-format",
    getExpandedText: () => "[Skills]\nnew-format",
  });
  resources.addChild(changed);

  adapter.capture();
  assert.match(plain(resources), /do not hide me/u);
  assert.match(plain(resources), /new-format/u);
});

test("quiet startup leaves the header without invented zero counts", () => {
  const { session, native, adapter } = startup();
  session.settingsManager.getQuietStartup = () => true;
  native.showLoadedResources();
  assert.deepEqual(adapter.capture(), []);
  assert.deepEqual(loadoutLines(theme, 80, []), []);
});

test("the summary stays centered and bounded when the terminal narrows", () => {
  const { adapter } = startup();
  const sections = adapter.capture();
  const full = loadoutLines(theme, 80, sections).map(strip);
  assert.equal(full[0]!.trim(), "1 context · 2 skills · 1 prompt · 3 extensions");
  assert.equal(full[1]!.trim(), "/loadout");
  assert.doesNotMatch(full.join("\n"), /rustic-light/u);

  for (let width = 1; width <= 100; width++) {
    for (const styled of loadoutLines(theme, width, sections)) {
      const line = strip(styled);
      assert.ok(visibleWidth(line) <= width);
      if (!line.trim()) continue;
      const left = line.search(/\S/u);
      const right = width - visibleWidth(line);
      assert.ok(Math.abs(left - right) <= 1, `not centered at width ${width}: ${line}`);
    }
  }
});

test("loadout details scroll to the last resource and stay bounded after resize", () => {
  const sections: LoadoutSection[] = [
    {
      name: "Extensions",
      body: Array.from({ length: 100 }, (_, i) => `extension-${i}`).join(", "),
      count: 100,
    },
  ];
  let height = 8;
  let closed = false;
  const view = new LoadoutView(
    sections,
    theme,
    () => height,
    () => {
      closed = true;
    },
  );
  assert.doesNotMatch(view.render(40).join("\n"), /extension-99/u);
  view.handleInput("\x1b[F");
  assert.match(view.render(40).join("\n"), /extension-99/u);

  height = 5;
  const resized = view.render(20);
  assert.ok(resized.length <= height);
  assert.ok(resized.every((line) => visibleWidth(line) <= 20));
  view.handleInput("\x1b[F");
  assert.match(view.render(20).join("\n"), /extension-99/u);
  view.handleInput("\x1b");
  assert.ok(closed);
});
