import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { ImageProcessingService } from "./src/main/services/imageService.ts";

const projectDir = "project/test4";
const runs = [
  "4e8ddbfd-8ee2-4902-8871-6a8660f79ba6",
  "062eb919-4284-452f-9f53-ab400debca49",
  "e5a6ecf7-26fe-43e1-a438-ae18001aaa7d"
];

const svc = new ImageProcessingService();

for (const runId of runs) {
  const buf = await fs.promises.readFile(path.join(projectDir, "generated", "raw", runId, "grid.png"));
  const meta = await sharp(buf).metadata();
  const t0 = Date.now();
  const cells = await svc.detectAutoCells(buf, 16);
  const ms = Date.now() - t0;
  console.log(`\n=== ${runId} (${meta.width}x${meta.height}) → ${cells ? cells.length + " 格" : "null（退回等分）"}  ${ms}ms`);
  if (cells) {
    const w = meta.width!, h = meta.height!;
    console.log(`  列宽: ${[...new Set(cells.map(c => c.width))].join(", ")}  (等分=${(w / 4).toFixed(0)})`);
    console.log(`  行高: ${[...new Set(cells.map(c => c.height))].join(", ")}  (等分=${(h / 4).toFixed(0)})`);
    console.log(`  切点X: ${[...new Set(cells.map(c => c.left))].sort((a, b) => a - b).join(", ")}`);
    console.log(`  切点Y: ${[...new Set(cells.map(c => c.top))].sort((a, b) => a - b).join(", ")}`);
  }
}
