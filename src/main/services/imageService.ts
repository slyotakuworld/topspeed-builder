import path from "node:path";
import fs from "fs-extra";
import sharp, { type Raw } from "sharp";
import type { Size } from "@shared/types";

interface ProcessImageOptions {
  width: number;
  height: number;
  transparentBackground: boolean;
  trim: boolean;
  anchor?: "center" | "bottom-center";
  padding?: number;
  removeEdgeArtifacts?: boolean;
  isolateSubject?: boolean;
}

interface AlphaBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
  alphaPixels: number;
}

export class ImageProcessingService {
  async processImage(input: Buffer, options: ProcessImageOptions): Promise<Buffer> {
    let output = await this.prepareForeground(input, options);

    if (options.trim) {
      output = await this.trimTransparent(output);
    }

    output = await this.normalizeCanvas(output, { width: options.width, height: options.height }, options.anchor ?? "center", options.padding ?? 0);
    return this.ensureNotBlank(output, input, options);
  }

  async saveProcessedImage(input: Buffer, outputPath: string, options: ProcessImageOptions): Promise<void> {
    const processed = await this.processImage(input, options);
    await fs.ensureDir(path.dirname(outputPath));
    await fs.writeFile(outputPath, processed);
  }

  async removeBackground(input: Buffer): Promise<Buffer> {
    return this.removeFlatBackground(input);
  }

  async normalizeFramesConsistently(inputs: Buffer[], options: ProcessImageOptions): Promise<Buffer[]> {
    const prepared = await Promise.all(inputs.map((input) => this.prepareForeground(input, options)));
    if (!options.trim) {
      const normalized = await Promise.all(
        prepared.map((frame) => this.normalizeCanvas(frame, { width: options.width, height: options.height }, options.anchor ?? "center", options.padding ?? 0))
      );
      return Promise.all(normalized.map((frame, index) => this.ensureNotBlank(frame, inputs[index], options)));
    }

    const bounds = await Promise.all(prepared.map((frame) => this.getAlphaBounds(frame)));
    const nonEmptyBounds = bounds.filter((box): box is AlphaBounds => Boolean(box));

    if (nonEmptyBounds.length === 0) {
      return Promise.all(inputs.map((input) => this.processImage(input, options)));
    }

    const safePadding = Math.max(0, Math.min(options.padding ?? 0, Math.floor(Math.min(options.width, options.height) / 4)));
    const targetWidth = Math.max(1, options.width - safePadding * 2);
    const targetHeight = Math.max(1, options.height - safePadding * 2);
    const maxContentWidth = Math.max(...nonEmptyBounds.map((box) => box.width), 1);
    const maxContentHeight = Math.max(...nonEmptyBounds.map((box) => box.height), 1);
    const scale = Math.min(targetWidth / maxContentWidth, targetHeight / maxContentHeight);

    const normalized = await Promise.all(prepared.map(async (frame, index) => {
      const box = bounds[index];
      if (!box) {
        return this.normalizeCanvas(frame, { width: options.width, height: options.height }, options.anchor ?? "center", safePadding);
      }

      const content = await sharp(frame)
        .ensureAlpha()
        .extract({
          left: box.minX,
          top: box.minY,
          width: box.width,
          height: box.height
        })
        .resize({
          width: Math.max(1, Math.round(box.width * scale)),
          height: Math.max(1, Math.round(box.height * scale)),
          fit: "fill",
          kernel: sharp.kernel.nearest
        })
        .png()
        .toBuffer();

      return this.placeOnCanvas(content, { width: options.width, height: options.height }, options.anchor ?? "center", safePadding);
    }));

    return Promise.all(normalized.map((frame, index) => this.ensureNotBlank(frame, inputs[index], options)));
  }

  async normalizeFile(inputPath: string, outputPath: string, size: Size): Promise<void> {
    const buffer = await fs.readFile(inputPath);
    const processed = await this.normalizeCanvas(buffer, size);
    await fs.ensureDir(path.dirname(outputPath));
    await fs.writeFile(outputPath, processed);
  }

  private async prepareForeground(input: Buffer, options: Pick<ProcessImageOptions, "transparentBackground" | "removeEdgeArtifacts" | "isolateSubject">): Promise<Buffer> {
    let output = options.transparentBackground
      ? await this.removeFlatBackground(input)
      : await sharp(input).ensureAlpha().png().toBuffer();

    if (options.removeEdgeArtifacts) {
      output = await this.removeEdgeArtifacts(output);
    }

    if (options.isolateSubject) {
      output = await this.keepLargestAlphaComponent(output);
    }

    return output;
  }

  private async removeFlatBackground(input: Buffer): Promise<Buffer> {
    const image = sharp(input).ensureAlpha();
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    const totalPixels = info.width * info.height;
    const originalAlphaPixels = this.countAlphaPixels(data, channels, totalPixels);

    const alreadyTransparent = this.hasRealAlphaChannel(data, channels, totalPixels);
    if (alreadyTransparent) {
      const cleaned = this.defringeAlpha(data, info);
      const cleanedAlphaPixels = this.countAlphaPixels(cleaned, channels, totalPixels);
      const minimumForegroundPixels = Math.max(16, Math.floor(totalPixels * 0.001));
      if (cleanedAlphaPixels < minimumForegroundPixels || cleanedAlphaPixels < originalAlphaPixels * 0.1) {
        return sharp(input).ensureAlpha().png().toBuffer();
      }

      return sharp(cleaned, {
        raw: { width: info.width, height: info.height, channels: channels as Raw["channels"] }
      }).png().toBuffer();
    }

    const background = this.estimateBackgroundFromEdges(data, info);
    const tolerance = this.computeAdaptiveTolerance(data, info, background, channels);
    const backgroundCandidates = new Uint8Array(data.length / channels);

    for (let i = 0; i < data.length; i += channels) {
      const index = i / channels;
      const distance = Math.sqrt(
        (data[i] - background.r) ** 2 +
        (data[i + 1] - background.g) ** 2 +
        (data[i + 2] - background.b) ** 2
      );

      if (distance <= tolerance || data[i + 3] < 8) {
        backgroundCandidates[index] = 1;
      }
    }

    const toRemove = this.edgeConnectedMask(backgroundCandidates, info.width, info.height);
    let remainingPixels = 0;

    for (let i = 0; i < data.length; i += channels) {
      if (toRemove[i / channels]) {
        data[i + 3] = 0;
      } else if (data[i + 3] >= 8) {
        remainingPixels += 1;
      }
    }

    const minimumForegroundPixels = Math.max(16, Math.floor(totalPixels * 0.001));
    if (remainingPixels < minimumForegroundPixels) {
      return sharp(input).ensureAlpha().png().toBuffer();
    }

    return sharp(data, {
      raw: { width: info.width, height: info.height, channels: channels as Raw["channels"] }
    }).png().toBuffer();
  }

  private countAlphaPixels(data: Buffer, channels: number, totalPixels: number, threshold = 12): number {
    let alphaPixels = 0;
    for (let index = 0; index < totalPixels; index += 1) {
      if (data[index * channels + 3] > threshold) {
        alphaPixels += 1;
      }
    }
    return alphaPixels;
  }

  private hasRealAlphaChannel(data: Buffer, channels: number, totalPixels: number): boolean {
    let fullyOpaque = 0;
    let fullyTransparent = 0;
    for (let i = 0; i < totalPixels; i++) {
      const alpha = data[i * channels + 3];
      if (alpha >= 240) fullyOpaque++;
      else if (alpha <= 16) fullyTransparent++;
    }
    const transparentRatio = fullyTransparent / totalPixels;
    const opaqueRatio = fullyOpaque / totalPixels;
    return transparentRatio > 0.02 && opaqueRatio < 0.98;
  }

  private defringeAlpha(data: Buffer, info: sharp.OutputInfo): Buffer {
    const channels = info.channels;
    const total = info.width * info.height;
    const width = info.width;
    const height = info.height;
    const sourceAlpha = new Uint8Array(total);

    for (let i = 0; i < total; i++) {
      sourceAlpha[i] = data[i * channels + 3];
    }

    for (let i = 0; i < total; i++) {
      const offset = i * channels;
      const alpha = sourceAlpha[i];
      if (alpha <= 16) {
        data[offset + 3] = 0;
        continue;
      }

      if (alpha < 128) {
        data[offset + 3] = 0;
        continue;
      }

      const x = i % width;
      const y = Math.floor(i / width);
      let transparentNeighbors = 0;
      let totalNeighbors = 0;

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const ny = y + dy;
          const nx = x + dx;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          totalNeighbors++;
          const neighborAlpha = sourceAlpha[ny * width + nx];
          if (neighborAlpha <= 16) transparentNeighbors++;
        }
      }

      if (totalNeighbors > 0 && transparentNeighbors / totalNeighbors >= 0.5) {
        data[offset + 3] = 0;
      }
    }

    return data;
  }

  private estimateBackgroundFromEdges(data: Buffer, info: sharp.OutputInfo): { r: number; g: number; b: number } {
    const channels = info.channels;
    const samples: Array<{ r: number; g: number; b: number }> = [];

    const stride = Math.max(1, Math.floor(Math.min(info.width, info.height) / 40));
    for (let x = 0; x < info.width; x += stride) {
      const top = x * channels;
      samples.push({ r: data[top], g: data[top + 1], b: data[top + 2] });
      const bottom = ((info.height - 1) * info.width + x) * channels;
      samples.push({ r: data[bottom], g: data[bottom + 1], b: data[bottom + 2] });
    }
    for (let y = stride; y < info.height - 1; y += stride) {
      const left = y * info.width * channels;
      samples.push({ r: data[left], g: data[left + 1], b: data[left + 2] });
      const right = (y * info.width + info.width - 1) * channels;
      samples.push({ r: data[right], g: data[right + 1], b: data[right + 2] });
    }

    const rValues = samples.map(s => s.r).sort((a, b) => a - b);
    const gValues = samples.map(s => s.g).sort((a, b) => a - b);
    const bValues = samples.map(s => s.b).sort((a, b) => a - b);
    const mid = Math.floor(samples.length / 2);

    return {
      r: rValues[mid],
      g: gValues[mid],
      b: bValues[mid]
    };
  }

  private computeAdaptiveTolerance(
    data: Buffer, info: sharp.OutputInfo,
    background: { r: number; g: number; b: number }, channels: number
  ): number {
    const edgeDists: number[] = [];
    for (let x = 0; x < info.width; x++) {
      [0, info.height - 1].forEach(y => {
        const i = (y * info.width + x) * channels;
        edgeDists.push(Math.sqrt(
          (data[i] - background.r) ** 2 +
          (data[i + 1] - background.g) ** 2 +
          (data[i + 2] - background.b) ** 2
        ));
      });
    }
    if (edgeDists.length === 0) return 42;
    edgeDists.sort((a, b) => a - b);

    const q3 = edgeDists[Math.floor(edgeDists.length * 0.75)];
    const iqr = edgeDists[Math.floor(edgeDists.length * 0.75)] - edgeDists[Math.floor(edgeDists.length * 0.25)];
    return Math.min(64, Math.max(24, Math.round(q3 + iqr * 1.5)));
  }

  private cleanupStrayPixels(mask: Uint8Array, width: number, height: number): void {
    const total = width * height;
    const visited = new Uint8Array(total);
    const minRegion = Math.max(12, Math.floor(total * 0.008));

    for (let start = 0; start < total; start++) {
      if (!mask[start] || visited[start]) continue;

      const stack = [start];
      visited[start] = 1;
      const component: number[] = [];

      while (stack.length > 0) {
        const index = stack.pop()!;
        component.push(index);
        const x = index % width;
        const y = Math.floor(index / width);
        const neighbors = [
          x > 0 ? index - 1 : -1,
          x < width - 1 ? index + 1 : -1,
          y > 0 ? index - width : -1,
          y < height - 1 ? index + width : -1
        ];
        for (const next of neighbors) {
          if (next >= 0 && mask[next] && !visited[next]) {
            visited[next] = 1;
            stack.push(next);
          }
        }
      }

      if (component.length < minRegion) {
        for (const index of component) mask[index] = 0;
      }
    }
  }

  private edgeConnectedMask(mask: Uint8Array, width: number, height: number): Uint8Array {
    const total = width * height;
    const connected = new Uint8Array(total);
    const stack: number[] = [];

    const push = (index: number): void => {
      if (index < 0 || index >= total || !mask[index] || connected[index]) return;
      connected[index] = 1;
      stack.push(index);
    };

    for (let x = 0; x < width; x += 1) {
      push(x);
      push((height - 1) * width + x);
    }

    for (let y = 1; y < height - 1; y += 1) {
      push(y * width);
      push(y * width + width - 1);
    }

    while (stack.length > 0) {
      const index = stack.pop() as number;
      const x = index % width;
      if (x > 0) push(index - 1);
      if (x < width - 1) push(index + 1);
      if (index >= width) push(index - width);
      if (index < total - width) push(index + width);
    }

    return connected;
  }

  private async trimTransparent(input: Buffer): Promise<Buffer> {
    try {
      return await sharp(input)
        .trim({
          background: { r: 0, g: 0, b: 0, alpha: 0 },
          threshold: 1
        })
        .png()
        .toBuffer();
    } catch {
      return input;
    }
  }

  private async removeEdgeArtifacts(input: Buffer): Promise<Buffer> {
    const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    const total = info.width * info.height;
    const visited = new Uint8Array(total);
    const remove = new Uint8Array(total);
    const minArtifactArea = Math.max(64, Math.floor(total * 0.035));
    const minStrayArea = Math.max(4, Math.floor(total * 0.00035));

    for (let start = 0; start < total; start += 1) {
      if (visited[start] || data[start * channels + 3] <= 12) {
        continue;
      }

      const stack = [start];
      const component: number[] = [];
      visited[start] = 1;
      let touchesEdge = false;

      while (stack.length > 0) {
        const index = stack.pop() as number;
        component.push(index);
        const x = index % info.width;
        const y = Math.floor(index / info.width);
        if (x <= 1 || y <= 1 || x >= info.width - 2 || y >= info.height - 2) {
          touchesEdge = true;
        }

        const neighbors = [index - 1, index + 1, index - info.width, index + info.width];
        for (const next of neighbors) {
          if (next < 0 || next >= total || visited[next]) {
            continue;
          }
          const nextX = next % info.width;
          if ((next === index - 1 && nextX !== x - 1) || (next === index + 1 && nextX !== x + 1)) {
            continue;
          }
          if (data[next * channels + 3] > 12) {
            visited[next] = 1;
            stack.push(next);
          }
        }
      }

      if ((touchesEdge && component.length < minArtifactArea) || component.length < minStrayArea) {
        for (const index of component) {
          remove[index] = 1;
        }
      }
    }

    for (let index = 0; index < total; index += 1) {
      if (remove[index]) {
        data[index * channels + 3] = 0;
      }
    }

    return sharp(data, {
      raw: {
        width: info.width,
        height: info.height,
        channels: channels as Raw["channels"]
      }
    })
      .png()
      .toBuffer();
  }

  private async keepLargestAlphaComponent(input: Buffer): Promise<Buffer> {
    const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    const total = info.width * info.height;
    const visited = new Uint8Array(total);
    let bestComponent: number[] = [];

    for (let start = 0; start < total; start += 1) {
      if (visited[start] || data[start * channels + 3] <= 12) {
        continue;
      }

      const stack = [start];
      const component: number[] = [];
      visited[start] = 1;

      while (stack.length > 0) {
        const index = stack.pop() as number;
        component.push(index);
        const x = index % info.width;
        const neighbors = [index - 1, index + 1, index - info.width, index + info.width];

        for (const next of neighbors) {
          if (next < 0 || next >= total || visited[next]) {
            continue;
          }
          const nextX = next % info.width;
          if ((next === index - 1 && nextX !== x - 1) || (next === index + 1 && nextX !== x + 1)) {
            continue;
          }
          if (data[next * channels + 3] > 12) {
            visited[next] = 1;
            stack.push(next);
          }
        }
      }

      if (component.length > bestComponent.length) {
        bestComponent = component;
      }
    }

    const minimumSubjectPixels = Math.max(8, Math.floor(total * 0.001));
    if (bestComponent.length < minimumSubjectPixels) {
      return input;
    }

    const keep = new Uint8Array(total);
    for (const index of bestComponent) {
      keep[index] = 1;
    }
    for (let index = 0; index < total; index += 1) {
      if (!keep[index]) {
        data[index * channels + 3] = 0;
      }
    }

    return sharp(data, {
      raw: {
        width: info.width,
        height: info.height,
        channels: channels as Raw["channels"]
      }
    })
      .png()
      .toBuffer();
  }

  private async getAlphaBounds(input: Buffer): Promise<AlphaBounds | undefined> {
    const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    const total = info.width * info.height;
    let alphaPixels = 0;
    let minX = info.width;
    let minY = info.height;
    let maxX = -1;
    let maxY = -1;

    for (let index = 0; index < total; index += 1) {
      if (data[index * channels + 3] <= 12) {
        continue;
      }

      const x = index % info.width;
      const y = Math.floor(index / info.width);
      alphaPixels += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }

    if (alphaPixels === 0 || maxX < minX || maxY < minY) {
      return undefined;
    }

    return {
      minX,
      minY,
      maxX,
      maxY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      alphaPixels
    };
  }

  private async ensureNotBlank(output: Buffer, original: Buffer, options: ProcessImageOptions): Promise<Buffer> {
    const bounds = await this.getAlphaBounds(output);
    const minimumPixels = Math.max(2, Math.floor(options.width * options.height * 0.001));
    if (bounds && bounds.alphaPixels >= minimumPixels) {
      return output;
    }

    const fallback = await sharp(original).ensureAlpha().png().toBuffer();
    const trimmed = options.trim ? await this.trimTransparent(fallback) : fallback;
    return this.normalizeCanvas(trimmed, { width: options.width, height: options.height }, options.anchor ?? "center", options.padding ?? 0);
  }

  private async normalizeCanvas(input: Buffer, size: Size, anchor: "center" | "bottom-center" = "center", padding = 0): Promise<Buffer> {
    const safePadding = Math.max(0, Math.min(padding, Math.floor(Math.min(size.width, size.height) / 4)));
    const targetWidth = Math.max(1, size.width - safePadding * 2);
    const targetHeight = Math.max(1, size.height - safePadding * 2);
    const resized = await sharp(input)
      .resize({
        width: targetWidth,
        height: targetHeight,
        fit: "inside",
        kernel: sharp.kernel.nearest
      })
      .png()
      .toBuffer();
    const metadata = await sharp(resized).metadata();
    const resizedWidth = metadata.width ?? targetWidth;
    const resizedHeight = metadata.height ?? targetHeight;
    return this.placeOnCanvas(resized, size, anchor, safePadding, resizedWidth, resizedHeight);
  }

  private async placeOnCanvas(
    input: Buffer,
    size: Size,
    anchor: "center" | "bottom-center" = "center",
    padding = 0,
    knownWidth?: number,
    knownHeight?: number
  ): Promise<Buffer> {
    const metadata = knownWidth && knownHeight ? undefined : await sharp(input).metadata();
    const resizedWidth = knownWidth ?? metadata?.width ?? size.width;
    const resizedHeight = knownHeight ?? metadata?.height ?? size.height;
    const left = Math.floor((size.width - resizedWidth) / 2);
    const top =
      anchor === "bottom-center"
        ? Math.max(0, size.height - padding - resizedHeight)
        : Math.floor((size.height - resizedHeight) / 2);

    return sharp({
      create: {
        width: size.width,
        height: size.height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
      .composite([{
        input,
        left,
        top
      }])
      .png()
      .toBuffer();
  }
}
