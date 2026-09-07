// 清理 electron-vite 运行期产生的临时配置文件
// electron-vite 加载 TS 配置时会生成 electron.vite.config.<时间戳>.mjs，
// 正常结束后会自行删除；但进程被中断（Ctrl+C / 崩溃 / 被杀）时 finally 不执行，文件就会残留。
// 本脚本在构建前后各扫一次，保证工作区干净。
//
// 用法：npm run clean:temp（构建/开发脚本会自动调用，无需手动执行）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PATTERN = /^electron\.vite\.config\.\d+\.mjs$/;

const leftovers = fs
  .readdirSync(ROOT_DIR)
  .filter((name) => PATTERN.test(name));

if (leftovers.length === 0) {
  process.exit(0);
}

let removed = 0;
for (const name of leftovers) {
  try {
    fs.unlinkSync(path.join(ROOT_DIR, name));
    removed++;
  } catch {
    // 文件正被占用或已消失，忽略即可，下次运行会再清理
  }
}

console.log(`已清理 ${removed} 个 electron-vite 临时配置文件`);
