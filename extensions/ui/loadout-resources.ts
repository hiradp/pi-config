import { stripVTControlCharacters } from "node:util";
import { Spacer, type Component } from "@earendil-works/pi-tui";

const SECTION_NAMES = ["Context", "Skills", "Prompts", "Extensions", "Themes"] as const;
type SectionName = (typeof SECTION_NAMES)[number];

export interface LoadoutSection {
  name: SectionName;
  body: string;
  count: number;
}

interface ComponentTree extends Component {
  children: Component[];
}

function isTree(component: Component): component is ComponentTree {
  return "children" in component && Array.isArray(component.children);
}

function resourceContainer(root: Component, header: Component): ComponentTree | undefined {
  if (!isTree(root)) return;
  for (const [index, child] of root.children.entries()) {
    if (isTree(child) && child.children.includes(header)) {
      const next = root.children[index + 1];
      return next && isTree(next) ? next : undefined;
    }
    const found = resourceContainer(child, header);
    if (found) return found;
  }
  return undefined;
}

// Pi 0.84's resource inventory is not exposed through ExtensionAPI. Read only its
// startup ExpandableText nodes; never infer loaded resources from files on disk.
function readSection(component: Component): LoadoutSection | undefined {
  if (
    !("getCollapsedText" in component) ||
    typeof component.getCollapsedText !== "function" ||
    !("getExpandedText" in component) ||
    typeof component.getExpandedText !== "function"
  ) {
    return;
  }
  try {
    const text: unknown = component.getCollapsedText();
    if (typeof text !== "string") return;
    const match = /^\[(Context|Skills|Prompts|Extensions|Themes)\]\n  ([^\n]+)$/u.exec(
      stripVTControlCharacters(text),
    );
    if (!match) return;
    const expanded: unknown = component.getExpandedText();
    if (typeof expanded !== "string") return;
    const [heading, ...entries] = stripVTControlCharacters(expanded).split("\n");
    if (heading !== `[${match[1]}]`) return;
    const indents = entries.map((entry) => entry.search(/\S/u));
    if (indents.some((indent) => ![2, 4, 6].includes(indent))) return;
    // Expanded scope/package headings have more-indented children. Count leaves,
    // not commas: resource paths and labels can themselves contain commas.
    const count = indents.filter(
      (indent, index) =>
        indent >= (match[1] === "Context" ? 2 : 4) && (indents[index + 1] ?? 0) <= indent,
    ).length;
    if (count === 0) return;
    return { name: match[1] as SectionName, body: match[2]!, count };
  } catch {
    return;
  }
}

export class StartupLoadout {
  private hidden = new Map<Component, Component>();
  private container?: ComponentTree;

  private root: Component;
  private header: Component;

  constructor(root: Component, header: Component) {
    this.root = root;
    this.header = header;
  }

  capture(): LoadoutSection[] {
    const container = resourceContainer(this.root, this.header);
    if (container !== this.container) {
      this.dispose();
      this.container = container;
    }
    if (!container) return [];

    const originals = container.children.map((child) => this.hidden.get(child) ?? child);
    const sections = originals.map(readSection);
    const liveHidden = new Map<Component, Component>();
    container.children = originals.map((child, index) => {
      const listingSpacer =
        child instanceof Spacer &&
        (sections[index - 1] !== undefined || (index === 0 && sections[1]?.name === "Context"));
      if (!sections[index] && !listingSpacer) return child;

      const current = container.children[index]!;
      const hidden = this.hidden.has(current) ? current : { render: () => [], invalidate() {} };
      liveHidden.set(hidden, child);
      return hidden;
    });
    this.hidden = liveHidden;
    return sections.filter((section) => section !== undefined);
  }

  dispose(): void {
    if (this.container) {
      this.container.children = this.container.children.map(
        (child) => this.hidden.get(child) ?? child,
      );
    }
    this.hidden.clear();
    this.container = undefined;
  }
}
