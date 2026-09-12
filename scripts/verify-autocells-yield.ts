/**
 * 验证 imageService.detectAutoCells 的「时间片让出」重构：
 *  1) 结果不变 —— 合成一张 16 格的网格大图（已知每格的精确包围盒），重构后仍应原样返回；
 *  2) 主进程不再被一口气堵死 —— 检测期间事件循环必须能穿插跑别的任务（否则 Windows 上表现为输入框打不出字）。
 *
 * 跑法：npx esbuild scripts/verify-autocells-yield.ts --bundle --platform=node --format=cjs \
 *        --external:sharp --outfile=build/tmp-verify-autocells.cjs && node build/tmp-verify-autocells.cjs
 */
import sharp from "sharp";
import { ImageProcessingService } from "../src/main/services/imageService";

const results: string[] = [];
let failed = 0;
function check(label: string, ok: boolean): void {
  if (!ok) failed += 1;
  results.push(`${ok ? "PASS" : "FAIL"}  ${label}`);
}

const COLS = 4;
const ROWS = 4;
const COUNT = COLS * ROWS;
// 用真实规模（2048×2048）跑：小图只要几十毫秒，看不出「饿死输入事件」的问题
const CELL = Number(process.env.CELL ?? 512);
const SPRITE = Math.round(CELL * 0.47); // 每格中间画一个方块，留出空隙供算法识别为独立素材

interface Expected {
  left: number;
  top: number;
}

/** 合成一张「透明背景 + 每格一个独立方块」的网格大图，返回图片 buffer 与预期的包围盒 */
async function makeGridImage(): Promise<{ buffer: Buffer; expected: Expected[] }> {
  const width = COLS * CELL;
  const height = ROWS * CELL;
  const expected: Expected[] = [];
  const composites: sharp.OverlayOptions[] = [];

  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) {
      const left = col * CELL + Math.round((CELL - SPRITE) / 2);
      const top = row * CELL + Math.round((CELL - SPRITE) / 2);
      expected.push({ left, top });
      composites.push({
        input: {
          create: {
            width: SPRITE,
            height: SPRITE,
            channels: 4,
            background: { r: 220, g: 40, b: 90, alpha: 1 }
          }
        },
        left,
        top
      });
    }
  }

  const buffer = await sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  })
    .composite(composites)
    .png()
    .toBuffer();

  return { buffer, expected };
}

async function main(): Promise<void> {
  const service = new ImageProcessingService();
  const { buffer, expected } = await makeGridImage();

  // 事件循环探针：检测期间每 1ms 一次的定时器能跑多少次，直接反映主进程有没有被独占
  let ticks = 0;
  const ticker = setInterval(() => {
    ticks += 1;
  }, 1);

  const started = Date.now();
  const cells = await service.detectAutoCells(buffer, COUNT);
  const elapsed = Date.now() - started;
  clearInterval(ticker);

  check("detectAutoCells 返回非空结果", Array.isArray(cells));
  check(`识别出的素材数量 = ${COUNT}（实际 ${cells?.length ?? 0}）`, (cells?.length ?? 0) === COUNT);

  if (cells && cells.length === COUNT) {
    // 算法按 (y, x) 排序，与生成顺序一致
    const mismatch = cells.filter((cell, index) => {
      const want = expected[index];
      return (
        !want ||
        Math.abs(cell.left - want.left) > 2 ||
        Math.abs(cell.top - want.top) > 2 ||
        Math.abs(cell.width - SPRITE) > 2 ||
        Math.abs(cell.height - SPRITE) > 2
      );
    });
    check(
      `16 个包围盒与合成图完全吻合（偏差 ≤2px）${mismatch.length > 0 ? `：${JSON.stringify(mismatch.slice(0, 2))}` : ""}`,
      mismatch.length === 0
    );
  }

  // 关键回归点：重构前这是一段纯同步循环，ticks 会停在个位数；
  // 现在每 16ms 让出一次，ticks 应该与耗时同量级。
  check(
    `检测期间事件循环被放行（ticks=${ticks}，耗时 ${elapsed}ms，重构前应接近 0）`,
    ticks >= 5
  );

  results.forEach((line) => console.log(line));
  console.log(`\n${failed === 0 ? "ALL PASS" : `${failed} FAILED`}  (${results.length} 项)`);
  if (failed > 0) process.exitCode = 1;
}

void main();
