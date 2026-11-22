import type { Layer, LayerConfig, LayerContent } from "../layers.js";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

export class RepoProfileLayer implements Layer {
  config: LayerConfig;

  constructor() {
    this.config = {
      id: "repo_profile",
      order: 2,
      enabled: true,
    };
  }

  async generate(): Promise<LayerContent> {
    const now = Date.now();
    const cwd = process.cwd();

    // Detect workspace root (heuristic: look for AGENTS.md or CLAUDE.md up to 3 levels)
    const files = await this.findProjectFiles(cwd);

    const sections: string[] = [];

    for (const filePath of files) {
      try {
        const content = await readFile(filePath, "utf-8");
        const extracted = this.extractSections(content);
        if (extracted) {
          sections.push(`## ${this.label(filePath)} (${filePath})`, extracted);
        }
      } catch {
        // File not found / permission error = skip silently
      }
    }

    if (sections.length === 0) {
      return { content: "", updatedAt: now, source: "repo_profile (no project files found)" };
    }

    let content = sections.join("\n\n");
    if (content.length > 3000) {
      content = content.slice(0, 3000) + "\n\n(truncated — repo_profile >3000 chars)";
    }

    return { content, updatedAt: now, source: "workspace AGENTS.md/CLAUDE.md" };
  }

  private async findProjectFiles(cwd: string): Promise<string[]> {
    const candidates = ["AGENTS.md", "CLAUDE.md"];
    const found: string[] = [];

    for (let depth = 0; depth <= 3; depth++) {
      for (const name of candidates) {
        const p = resolve(cwd, ...Array(depth).fill(".."), name);
        try {
          await stat(p);
          found.push(p);
        } catch {
          // not found
        }
      }
      if (found.length > 0) break;
    }
    return found;
  }

  private label(path: string): string {
    const basename = path.split("/").pop() || path;
    return basename === "AGENTS.md" ? "AGENTS" : "CLAUDE";
  }

  private extractSections(content: string): string {
    const lines = content.split("\n");
    const relevant: string[] = [];
    let capture = false;

    const triggers = [
      "Tech Stack", "Tech-Stack", "Runtime", "Language", "Framework",
      "Conventions", "Convention", "Standards", "Naming",
      "Forbidden", "Verboten", "Anti-Pattern", "Deny",
      "Build & Development", "Development Commands",
    ];

    for (const line of lines) {
      const trimmed = line.trim();
      if (
        trimmed.startsWith("## ") &&
        triggers.some(t => trimmed.toLowerCase().includes(t.toLowerCase()))
      ) {
        capture = true;
        relevant.push(trimmed);
      } else if (trimmed.startsWith("## ")) {
        capture = false;
      } else if (capture && trimmed.length > 0) {
        // Max 5 lines per section
        if (relevant.filter(l => l.startsWith("-") || l.startsWith("*")).length < 30) {
          relevant.push(trimmed);
        }
      }
    }

    return relevant.length > 1 ? relevant.join("\n") : "";
  }
}
