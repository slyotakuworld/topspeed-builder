// Topspeed Builder 一键启动引导脚本
// 职责：校验 Node 版本 -> 安装依赖 -> 提供中文启动菜单 -> 执行对应命令
// 安全：不写死任何密钥；仅运行 npm install / npm run *；不执行远程脚本。

import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

// 期望的 Node 版本：README 推荐 22，最低支持 18
const RECOMMENDED_NODE = 22;
const MIN_NODE = 18;

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};
function c(text, color) {
  return `${colors[color] || ''}${text}${colors.reset}`;
}

function log(msg) {
  console.log(msg);
}

function parseNodeVersion(v) {
  // v22.12.0 -> 22.12.0
  const m = String(v).replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function meetsMin(ver, min) {
  if (!ver) return false;
  if (ver.major !== min) return ver.major > min;
  return true; // major 等于 min 即视为满足最低要求
}

// 运行命令并透传输出，返回 Promise<number>（退出码）
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      stdio: 'inherit',
      shell: true,
      ...opts,
    });
    child.on('close', (code) => resolve(code ?? 0));
    child.on('error', (err) => {
      log(c(`启动命令失败: ${err.message}`, 'red'));
      resolve(1);
    });
  });
}

async function needInstall(force) {
  const nm = join(ROOT, 'node_modules');
  return force || !existsSync(nm);
}

async function installDeps(force) {
  if (!(await needInstall(force))) {
    log(c('检测到 node_modules 已存在，跳过安装（使用 --force 可强制重装）。', 'green'));
    return true;
  }
  log(c('开始安装依赖 (npm install)，这可能需要几分钟...', 'cyan'));
  const code = await run('npm', ['install']);
  if (code !== 0) {
    log(c('依赖安装失败，请检查网络或 npm 配置后重试。', 'red'));
    return false;
  }
  log(c('依赖安装完成。', 'green'));
  return true;
}

function showMenu() {
  log('');
  log(c('================================================', 'cyan'));
  log(c('   Topspeed Builder 启动菜单', 'bold'));
  log(c('================================================', 'cyan'));
  log('  1) 安装依赖并启动开发模式 (Electron 窗口)');
  log('  2) 仅安装依赖（不启动）');
  log('  3) 安装依赖并构建 (npm run build)');
  log('  4) 安装依赖并生产预览 (electron-vite preview)');
  log('  5) 退出');
  log(c('================================================', 'cyan'));
  log('  提示：开发模式下会直接打开桌面应用窗口，无需打开浏览器。');
  log('');
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

async function main() {
  log(c('Topspeed Builder 一键启动器', 'bold'));
  log('');

  // 1. 校验 Node 版本
  const nodeVer = parseNodeVersion(process.version);
  if (!nodeVer) {
    log(c(`无法解析当前 Node 版本: ${process.version}`, 'red'));
    process.exit(1);
  }
  if (!meetsMin(nodeVer, MIN_NODE)) {
    log(c(`当前 Node 版本为 ${nodeVer.major}.${nodeVer.minor}.${nodeVer.patch}，低于最低要求 ${MIN_NODE}。`, 'red'));
    log(c('请安装 Node.js 22 LTS 后重试：https://nodejs.org/', 'yellow'));
    process.exit(1);
  }
  if (nodeVer.major < RECOMMENDED_NODE) {
    log(c(`当前 Node 版本 ${nodeVer.major}.${nodeVer.minor}.${nodeVer.patch}，推荐 Node.js ${RECOMMENDED_NODE} LTS 以获得最佳兼容性。`, 'yellow'));
  } else {
    log(c(`Node 版本 ${nodeVer.major}.${nodeVer.minor}.${nodeVer.patch} 校验通过。`, 'green'));
  }
  log('');

  // 2. 解析命令行参数（--force 强制重装）
  const force = process.argv.slice(2).includes('--force');

  // 3. 启动菜单
  while (true) {
    showMenu();
    const choice = await ask(c('请选择操作 [1-5]: ', 'cyan'));
    log('');
    switch (choice) {
      case '1': {
        if (!(await installDeps(force))) return;
        log(c('启动开发模式 (npm run dev)...', 'cyan'));
        await run('npm', ['run', 'dev']);
        return;
      }
      case '2': {
        if (!(await installDeps(force))) return;
        log(c('依赖已就绪，未启动应用。', 'green'));
        return;
      }
      case '3': {
        if (!(await installDeps(force))) return;
        log(c('构建项目 (npm run build)...', 'cyan'));
        const code = await run('npm', ['run', 'build']);
        if (code === 0) log(c('构建完成，输出在 build/out/ 目录。', 'green'));
        return;
      }
      case '4': {
        if (!(await installDeps(force))) return;
        log(c('构建并启动生产预览 (npm start)...', 'cyan'));
        const code = await run('npm', ['run', 'build']);
        if (code === 0) await run('npm', ['run', 'start']);
        return;
      }
      case '5': {
        log(c('已退出。', 'green'));
        return;
      }
      default: {
        log(c('无效选择，请输入 1-5。', 'red'));
      }
    }
  }
}

main().catch((err) => {
  log(c(`启动器异常: ${err?.message || err}`, 'red'));
  process.exit(1);
});
