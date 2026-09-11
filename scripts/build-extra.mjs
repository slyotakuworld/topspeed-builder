import { build } from "esbuild";
import { resolve } from "node:path";

const root = process.cwd();

/**
 * 把 TS 入口打包成可在普通 Node 运行的 cjs（无需 electron），供 CLI / 独立 MCP 使用。
 * - node_modules 外置（packages: "external"）：运行时从项目 node_modules 解析 sharp / fs-extra / MCP SDK 等
 * - 通过 tsconfig.json 的 paths 解析 @shared/* 源码别名
 */
async function bundle(entry, outfile) {
  await build({
    entryPoints: [resolve(root, entry)],
    outfile: resolve(root, outfile),
    bundle: true,
    platform: "node",
    target: "node18",
    format: "cjs",
    packages: "external",
    absWorkingDir: root,
    tsconfig: resolve(root, "tsconfig.json"),
    resolveExtensions: [".ts", ".tsx", ".js", ".json"],
    logLevel: "info"
  });
  console.log(`[build:extra] 已打包 ${entry} -> ${outfile}`);
}

await Promise.all([
  bundle("src/cli.ts", "build/extra/cli.cjs"),
  bundle("src/mcp/standalone.ts", "build/extra/mcp.cjs")
]);
