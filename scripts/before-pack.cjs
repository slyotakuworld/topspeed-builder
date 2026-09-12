const { execFileSync } = require("node:child_process");
const path = require("node:path");

/**
 * electron-builder beforePack 钩子。
 *
 * package.json 的 extraFiles 会把 build/extra/*.cjs 复制进 app 根目录的 tool/ 下
 * （即 win-unpacked/tool/cli.cjs、mcp.cjs）。所以在打包前必须保证这两个 bundle
 * 是**最新**的 —— 放在这里而不是只写在 npm script 里，是为了让任何入口
 * （npm run pack:win / dist:win，或直接调用 electron-builder）都不会漏掉它们、
 * 也不会把上一次的旧产物打进包里。
 */
module.exports = async function beforePack(context) {
  const projectDir =
    (context && context.packager && context.packager.projectDir) || process.cwd();

  console.log("[beforePack] 构建 CLI / MCP bundle（build:extra）...");
  execFileSync(process.execPath, [path.join(projectDir, "scripts", "build-extra.mjs")], {
    cwd: projectDir,
    stdio: "inherit"
  });
};
