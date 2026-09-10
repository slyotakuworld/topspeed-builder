import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { ImageProcessingService } from "./src/main/services/imageService.ts";

const projectDir = "project/test4";
const outDir = "outputs/split-preview";
const expected = 16;
const cols = 4;
const rows = 4;
const runs = [
  { id: "4e8ddbfd-8ee2-4902-8871-6a8660f79ba6", name: "角色 A" },
  { id: "062eb919-4284-452f-9f53-ab400debca49", name: "角色 B" },
  { id: "e5a6ecf7-26fe-43e1-a438-ae18001aaa7d", name: "角色 C" }
];

const svc = new ImageProcessingService();
await fs.promises.mkdir(outDir, { recursive: true });

interface Box { left: number; top: number; width: number; height: number; }

function evenBoxes(w: number, h: number): Box[] {
  const boxes: Box[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const left = Math.round((c * w) / cols);
      const right = Math.round(((c + 1) * w) / cols);
      const top = Math.round((r * h) / rows);
      const bottom = Math.round(((r + 1) * h) / rows);
      boxes.push({ left, top, width: right - left, height: bottom - top });
    }
  }
  return boxes;
}

function frameSvg(w: number, h: number, boxes: Box[], color: string, dashed: boolean, scale: number): Buffer {
  const dash = dashed ? ' stroke-dasharray="14,9"' : "";
  let s = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">`;
  for (const b of boxes) {
    const x = b.left * scale;
    const y = b.top * scale;
    const bw = b.width * scale;
    const bh = b.height * scale;
    s += `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" fill="none" stroke="#ffffff" stroke-width="6"${dash}/>`;
    s += `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" fill="none" stroke="${color}" stroke-width="3"${dash}/>`;
  }
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const tx = b.left * scale + 6;
    const ty = b.top * scale + 6;
    s += `<rect x="${tx}" y="${ty}" width="34" height="24" rx="5" fill="${color}"/>`;
    s += `<text x="${tx + 17}" y="${ty + 17}" font-family="sans-serif" font-size="16" font-weight="bold" fill="#ffffff" text-anchor="middle">${i + 1}</text>`;
  }
  s += `</svg>`;
  return Buffer.from(s);
}

function headerSvg(w: number, h: number, title: string, leftLabel: string, rightLabel: string, midX: number): Buffer {
  const s = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${w}" height="${h}" fill="#1f2430"/>
    <text x="24" y="40" font-family="sans-serif" font-size="24" font-weight="bold" fill="#ffffff">${title}</text>
    <text x="24" y="72" font-family="sans-serif" font-size="17" fill="#ff6b6b">${leftLabel}</text>
    <text x="${midX + 24}" y="72" font-family="sans-serif" font-size="17" fill="#3ddc97">${rightLabel}</text>
  </svg>`;
  return Buffer.from(s);
}

const PANEL_W = 700;
const GAP = 24;
const HEADER_H = 92;

for (let idx = 0; idx < runs.length; idx++) {
  const run = runs[idx];
  const gridPath = path.join(projectDir, "generated", "raw", run.id, "grid.png");
  const buf = await fs.promises.readFile(gridPath);
  const meta = await sharp(buf).metadata();
  const W = meta.width!;
  const H = meta.height!;
  const scale = PANEL_W / W;
  const PH = Math.round(H * scale);

  const cells = await svc.detectAutoCells(buf, expected);
  const newBoxes = cells ?? evenBoxes(W, H);
  const isFallback = cells === null;

  // 底色 flatten + 画框 + 缩放到统一面板宽
  const flat = await sharp(buf).flatten({ background: "#e3e6ea" }).png().toBuffer();

  const leftPanel = await sharp(flat)
    .composite([{ input: frameSvg(W, H, evenBoxes(W, H), "#e53935", true) }])
    .resize(PANEL_W, PH, { kernel: "lanczos3" })
    .png()
    .toBuffer();

  const rightPanel = await sharp(flat)
    .composite([{ input: frameSvg(W, H, newBoxes, isFallback ? "#1e88e5" : "#00a86b", isFallback) }])
    .resize(PANEL_W, PH, { kernel: "lanczos3" })
    .png()
    .toBuffer();

  const totalW = PANEL_W * 2 + GAP;
  const totalH = PH + HEADER_H;

  const leftLabel = `OLD  ·  even ${cols}x${rows} split (what was used)`;
  const rightLabel = isFallback
    ? `NEW  ·  content-aware: not confident -> fell back to even split`
    : `NEW  ·  content-aware: ${cells!.length} cells snapped to content`;

  const outPath = path.join(outDir, `${String(idx + 1).padStart(2, "0")}_${run.id.slice(0, 8)}.png`);
  await sharp({ create: { width: totalW, height: totalH, channels: 3, background: "#1f2430" } })
    .composite([
      { input: headerSvg(totalW, HEADER_H, `${run.name}  ·  ${run.id.slice(0, 8)}  ·  ${W}x${H}  ·  count=16`, leftLabel, rightLabel, PANEL_W + GAP), left: 0, top: 0 },
      { input: leftPanel, left: 0, top: HEADER_H },
      { input: rightPanel, left: PANEL_W + GAP, top: HEADER_H }
    ])
    .png()
    .toFile(outPath);

  console.log(`${outPath}`);
  console.log(`   OLD=even  NEW=${isFallback ? "even(fallback)" : cells!.length + " cells"}`);
}
