import sharp from "sharp";
import fs from "fs-extra";

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

await fs.ensureDir("docs");

for (const iconSize of pngSizes) {
  const png = await sharp(source).resize(iconSize, iconSize).png().toBuffer();
  pngBySize.set(iconSize, png);
}

await fs.writeFile("docs/icon.png", pngBySize.get(256));
await fs.writeFile("docs/icon.ico", createIco([
  { size: 16, data: pngBySize.get(16) },
  { size: 32, data: pngBySize.get(32) },
  { size: 48, data: await sharp(source).resize(48, 48).png().toBuffer() },
  { size: 64, data: pngBySize.get(64) },
  { size: 128, data: pngBySize.get(128) },
  { size: 256, data: pngBySize.get(256) }
]));
await fs.writeFile("docs/icon.icns", createIcns([
  { type: "icp4", data: pngBySize.get(16) },
  { type: "icp5", data: pngBySize.get(32) },
  { type: "icp6", data: pngBySize.get(64) },
  { type: "ic07", data: pngBySize.get(128) },
  { type: "ic08", data: pngBySize.get(256) },
  { type: "ic09", data: pngBySize.get(512) },
  { type: "ic10", data: pngBySize.get(1024) }
]));

console.log("Icons generated: docs/icon.png, docs/icon.ico, docs/icon.icns");

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
