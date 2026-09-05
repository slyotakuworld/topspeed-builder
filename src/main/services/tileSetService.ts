import path from "node:path";
import fs from "fs-extra";
import sharp from "sharp";
import { parseSize, toRelative, writeJsonFile } from "./utils";

interface TileSetTile {
  filePath: string;
  type: string;
}

export class TileSetService {
  async composeTileSet(args: {
    projectPath: string;
    name: string;
    tiles: TileSetTile[];
    size: string;
    theme: string;
    seamless: boolean;
  }): Promise<{ tilesetPath: string; metadataPath: string; previewPath: string; tmxPath: string }> {
    const tileSize = parseSize(args.size);
    const columns = Math.max(1, Math.ceil(Math.sqrt(args.tiles.length)));
    const rows = Math.max(1, Math.ceil(args.tiles.length / columns));
    const outputPath = path.join(args.projectPath, "tilesets", `${args.name}_tileset.png`);
    const metadataPath = path.join(args.projectPath, "tilesets", `${args.name}_tileset.json`);
    const previewPath = path.join(args.projectPath, "tilesets", `${args.name}_tileset_preview.png`);
    const tmxPath = path.join(args.projectPath, "tilesets", `${args.name}_tileset.tmx`);

    await fs.ensureDir(path.dirname(outputPath));

    const composites = args.tiles.map((tile, index) => ({
      input: tile.filePath,
      left: (index % columns) * tileSize.width,
      top: Math.floor(index / columns) * tileSize.height
    }));

    await sharp({
      create: {
        width: columns * tileSize.width,
        height: rows * tileSize.height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
      .composite(composites)
      .png()
      .toFile(outputPath);

    const metadata = {
      name: args.name,
      theme: args.theme,
      tileSize,
      seamlessRequested: args.seamless,
      image: toRelative(args.projectPath, outputPath),
      columns,
      rows,
      tiles: args.tiles.map((tile, index) => ({
        id: index,
        type: tile.type,
        file: toRelative(args.projectPath, tile.filePath),
        x: (index % columns) * tileSize.width,
        y: Math.floor(index / columns) * tileSize.height,
        w: tileSize.width,
        h: tileSize.height
      }))
    };

    await writeJsonFile(metadataPath, metadata);
    await this.createPreview(args.tiles, previewPath, tileSize);
    await fs.writeFile(
      tmxPath,
      this.createTmx({
        name: args.name,
        imageFile: path.basename(outputPath),
        columns,
        rows,
        tileWidth: tileSize.width,
        tileHeight: tileSize.height,
        tileCount: args.tiles.length
      }),
      "utf8"
    );

    return {
      tilesetPath: toRelative(args.projectPath, outputPath),
      metadataPath: toRelative(args.projectPath, metadataPath),
      previewPath: toRelative(args.projectPath, previewPath),
      tmxPath: toRelative(args.projectPath, tmxPath)
    };
  }

  private async createPreview(
    tiles: TileSetTile[],
    outputPath: string,
    tileSize: { width: number; height: number }
  ): Promise<void> {
    const previewWidth = tileSize.width * 6;
    const previewHeight = tileSize.height * 4;
    const composites = Array.from({ length: 24 }, (_, index) => {
      const tile = tiles[index % tiles.length];
      return {
        input: tile.filePath,
        left: (index % 6) * tileSize.width,
        top: Math.floor(index / 6) * tileSize.height
      };
    });

    await sharp({
      create: {
        width: previewWidth,
        height: previewHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
      .composite(composites)
      .png()
      .toFile(outputPath);
  }

  private createTmx(args: {
    name: string;
    imageFile: string;
    columns: number;
    rows: number;
    tileWidth: number;
    tileHeight: number;
    tileCount: number;
  }): string {
    const mapWidth = 8;
    const mapHeight = 8;
    const csvRows = Array.from({ length: mapHeight }, (_, y) =>
      Array.from({ length: mapWidth }, (_, x) => ((x + y) % args.tileCount) + 1).join(",")
    ).join(",\n");

    return `<?xml version="1.0" encoding="UTF-8"?>
<map version="1.10" tiledversion="1.10.2" orientation="orthogonal" renderorder="right-down" width="${mapWidth}" height="${mapHeight}" tilewidth="${args.tileWidth}" tileheight="${args.tileHeight}" infinite="0" nextlayerid="2" nextobjectid="1">
 <tileset firstgid="1" name="${args.name}" tilewidth="${args.tileWidth}" tileheight="${args.tileHeight}" tilecount="${args.tileCount}" columns="${args.columns}">
  <image source="${args.imageFile}" width="${args.columns * args.tileWidth}" height="${args.rows * args.tileHeight}"/>
 </tileset>
 <layer id="1" name="preview" width="${mapWidth}" height="${mapHeight}">
  <data encoding="csv">
${csvRows}
  </data>
 </layer>
</map>
`;
  }
}
