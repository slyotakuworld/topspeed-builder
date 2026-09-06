import sharp from "sharp";
import fs from "fs-extra";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT_DIR = path.join(ROOT_DIR, "assets");

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans ?? "");
    });
  });
}

const size = 256;
const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${size}" height="${size}" rx="40" fill="#070a0e"/>
  <rect x="8" y="8" width="240" height="240" rx="36" fill="none" stroke="#00d4ff" stroke-width="3"/>
  <text x="128" y="130" text-anchor="middle" font-family="Arial,sans-serif" font-size="100" font-weight="bold" fill="#00d4ff">TB</text>
  <text x="128" y="190" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" fill="#ff8c00" letter-spacing="6">BUILDER</text>
</svg>`;

const source = Buffer.from(svg);
const pngSizes = [16, 32, 64, 128, 256, 512, 1024];
const pngBySize = new Map();

// 可选参数：[源图路径] [输出目录]
// 用法：node generate-icon.mjs [图片路径] [输出目录]
// 不传参数且为交互终端时逐项询问；非交互且未传参时使用内置默认图案和 assets/ 目录
let argPath = process.argv[2];
let argOut = process.argv[3];
if (!argPath && process.stdin.isTTY) {
  const answer = await ask("请输入自定义图标图片路径（可直接拖入文件，直接回车则使用内置默认图案）: ");
  argPath = (answer ?? "").trim().replace(/^\"+|\"+$/g, "");
}
if (!argOut && process.stdin.isTTY) {
  const answer = await ask("请输入图标保存目录（可直接拖入文件夹，直接回车则保存到 assets/）: ");
  argOut = (answer ?? "").trim().replace(/^\"+|\"+$/g, "");
}
let inputPath = null;
if (argPath) {
  const abs = path.resolve(argPath);
  if (!fs.existsSync(abs)) {
    console.error(`图片不存在: ${abs}`);
    process.exit(1);
  }
  inputPath = abs;
}
const outDir = path.resolve(argOut || DEFAULT_OUT_DIR);

const loadSource = () => (inputPath ? sharp(inputPath) : sharp(source));

await fs.ensureDir(outDir);

for (const iconSize of pngSizes) {
  const png = await loadSource().resize(iconSize, iconSize).png().toBuffer();
  pngBySize.set(iconSize, png);
}

await fs.writeFile(path.join(outDir, "icon.png"), pngBySize.get(256));
await fs.writeFile(path.join(outDir, "icon.ico"), createIco([
  { size: 16, data: pngBySize.get(16) },
  { size: 32, data: pngBySize.get(32) },
  { size: 48, data: await loadSource().resize(48, 48).png().toBuffer() },
  { size: 64, data: pngBySize.get(64) },
  { size: 128, data: pngBySize.get(128) },
  { size: 256, data: pngBySize.get(256) }
]));
await fs.writeFile(path.join(outDir, "icon.icns"), createIcns([
  { type: "icp4", data: pngBySize.get(16) },
  { type: "icp5", data: pngBySize.get(32) },
  { type: "icp6", data: pngBySize.get(64) },
  { type: "ic07", data: pngBySize.get(128) },
  { type: "ic08", data: pngBySize.get(256) },
  { type: "ic09", data: pngBySize.get(512) },
  { type: "ic10", data: pngBySize.get(1024) }
]));

console.log(`Icons generated from ${inputPath ? path.basename(inputPath) : "built-in SVG"} -> ${outDir}\\icon.png / icon.ico / icon.icns`);

function createIco(images) {
  const headerSize = 6;
  const directorySize = images.length * 16;
  let imageOffset = headerSize + directorySize;
  const directory = [];
  const payloads = [];

  for (const image of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 0);
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.data.length, 8);
    entry.writeUInt32LE(imageOffset, 12);
    directory.push(entry);
    payloads.push(image.data);
    imageOffset += image.data.length;
  }

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  return Buffer.concat([header, ...directory, ...payloads]);
}

function createIcns(images) {
  const blocks = images.map((image) => {
    const block = Buffer.alloc(8);
    block.write(image.type, 0, 4, "ascii");
    block.writeUInt32BE(image.data.length + 8, 4);
    return Buffer.concat([block, image.data]);
  });
  const totalLength = 8 + blocks.reduce((sum, block) => sum + block.length, 0);
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(totalLength, 4);
  return Buffer.concat([header, ...blocks]);
}
