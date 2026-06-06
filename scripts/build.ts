import { rmSync, renameSync } from "node:fs";

// 1. Clear dist
rmSync("dist", { recursive: true, force: true });

// 2. Server build: Bun bundler on clean dist (FIRST — no stale artifacts)
const server = await Bun.build({
  entrypoints: ["src/four-opencode-brain.ts"],
  outdir: "dist",
  target: "bun",
  external: ["@opencode-ai/*", "@node-llama-cpp/*"],
  minify: process.env.NODE_ENV === "production",
});

if (!server.success) {
  for (const log of server.logs) console.error(log);
  process.exit(1);
}

// 3. Extract vec0 extension + Tree-sitter WASM (adds to dist/extensions/)
await Bun.$`bash scripts/build-vec.sh`;

// 4. TUI build: tsc strips types, preserves JSX → four-opencode-brain-tui.*
await Bun.$`bunx tsc --project tsconfig.tui.json`;
renameSync("dist/tui.jsx", "dist/four-opencode-brain-tui.jsx");
renameSync("dist/tui.d.ts", "dist/four-opencode-brain-tui.d.ts");

// Report outputs
for (const out of server.outputs) {
  console.log(`  ${out.path.padEnd(46)} ${(out.size / 1024).toFixed(2)} KB`);
}
for (const f of ["dist/four-opencode-brain-tui.jsx", "dist/four-opencode-brain-tui.d.ts", "dist/four-opencode-brain.d.ts"]) {
  const file = Bun.file(f);
  if (await file.exists()) {
    const size = (await file.arrayBuffer()).byteLength;
    console.log(`  ${f.padEnd(46)} ${(size / 1024).toFixed(2)} KB`);
  }
}
console.log(`\n✅ Built (Bun server → vec0 → tsc TUI)`);
