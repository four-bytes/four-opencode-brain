// scripts/test-llama.ts — Verify node-llama-cpp binary + model loading
import { existsSync, readdirSync, statSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";

const brainDir = resolve(import.meta.dir || ".", "..");
const modelPath = join(homedir(), ".cache", "four-opencode-brain", "models", "all-MiniLM-L6-v2.Q8_0.gguf");

console.log("=== Environment ===");
console.log("cwd:", process.cwd());
console.log("brainDir:", brainDir);
console.log("platform:", process.platform, "arch:", process.arch);

console.log("\n=== Binary Check ===");
const binsDir = join(brainDir, "node_modules", "node-llama-cpp", "bins", "linux-x64");
console.log("binsDir:", binsDir);
console.log("exists:", existsSync(binsDir));
if (existsSync(binsDir)) {
    const files = readdirSync(binsDir);
    console.log("files:", files.length);
    files.forEach(f => {
        const s = statSync(join(binsDir, f));
        console.log(`  ${f} (${s.size} bytes)`);
    });
}

const addonPath = join(binsDir, "llama-addon.node");
console.log("addon exists:", existsSync(addonPath));
const metaPath = join(binsDir, "_nlcBuildMetadata.json");
console.log("metadata exists:", existsSync(metaPath));

console.log("\n=== Model Check ===");
console.log("modelPath:", modelPath);
console.log("exists:", existsSync(modelPath));
if (existsSync(modelPath)) {
    console.log("size:", (statSync(modelPath).size / 1024 / 1024).toFixed(1), "MB");
}

console.log("\n=== node-llama-cpp Import ===");
try {
    const nlc = await import("node-llama-cpp");
    console.log("import OK, exports:", Object.keys(nlc).slice(0, 10));
} catch (e: any) {
    console.error("IMPORT FAILED:", e.message);
}

console.log("\n=== getLlama() ===");
try {
    const { getLlama } = await import("node-llama-cpp");
    console.log("Calling getLlama({ gpu: false, build: 'never', logLevel: 5 })...");
    const llama = await getLlama({ gpu: false, build: "never" as any, logLevel: 5 } as any);
    console.log("getLlama OK, gpu:", llama.gpu);
    
    console.log("\n=== loadModel() ===");
    try {
        const model = await llama.loadModel({ modelPath });
        console.log("loadModel OK, contextSize:", model.contextSize);
        
        console.log("\n=== createEmbeddingContext() ===");
        try {
            const ctx = await model.createEmbeddingContext();
            console.log("createEmbeddingContext OK");
            
            console.log("\n=== Test Embed ===");
            const emb = await ctx.getEmbeddingFor("Hello world");
            console.log("embedding vector length:", emb.vector.length);
            
            console.log("\n✅ ALL PASSED — embedding model works!");
        } catch (e: any) {
            console.error("createEmbeddingContext FAILED:", e.message);
        }
    } catch (e: any) {
        console.error("loadModel FAILED:", e.message);
    }
} catch (e: any) {
    console.error("getLlama FAILED:", e.message, "\nstack:", e.stack?.slice(0, 500));
}
