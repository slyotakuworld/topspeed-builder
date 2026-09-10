import path from "node:path";
import fs from "fs-extra";
import sharp, { type Raw } from "sharp";
import type { GridAutoCell, Size } from "@shared/types";

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

/** 连通域区域标记的最小包围盒 + 像素面积，用于 detectAutoCells 多级兜底 */
interface BoundingComponent {
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
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

  /** 公开：裁掉透明区域之外的空白边，供网格单格清理使用 */
  async trimToContent(input: Buffer): Promise<Buffer> {
    return this.trimTransparent(input);
  }

  /**
   * 内容感知切分：把网格大图里每个素材按「真实内容范围」定位，返回包围盒供逐格切割。
   * 前景判定自适应两类画面：
   *   - 透明背景（alpha 有明显空区）：按 alpha 通道取前景；
   *   - 不透明均匀底色：按「与四边采样底色」的颜色距离取前景。
   * 三步流程（核心目标：完整抠下每个素材，包括武器 / 披风等边角料）：
   *   1) 主躯干定位：形态学闭运算多档（dilate→erode）桥接同一素材内的细缝，从 [0,3,5,7,9]
   *      里挑出「数量最接近 expected」的一组连通块。少的一侧惩罚加倍——少一个主躯干等于
   *      永久丢掉一个素材，而多几个还能被后续步骤收掉。
   *   2) 碎块归属（关键改进）：在原始掩码上取全部连通块，按面积区分「主躯干 / 碎件」，
   *      把每个碎件并入最近的主躯干包围盒。被细缝割开的武器尖、披风角因此被完整收进来，
   *      而不是像等分 / 投影直线那样被切掉。距离超过门控半径（单格短边 25%）的保持独立，
   *      避免把邻格素材误吞进来。
   *   3) 数量校准：多于期望说明某素材仍被拆成两块，按包围盒间距最小反复合并到期望数；
   *      仍合不掉则退回槽位归并。
   * 返回值可能少于 expected（画面实际素材数不足，例如设定 16 实为 15）：
   *   调用方据此「按实际数量切分并如实提示」，不补空槽。
   * 连主躯干都无法可靠定位、或定位数量不足 expected 的一半且投影也救不回来时返回 null，调用方退回等分切分。
   */
  async detectAutoCells(input: Buffer, expected: number): Promise<GridAutoCell[] | null> {
    if (!Number.isInteger(expected) || expected < 1 || expected > 200) return null;
    let raw: { data: Buffer; info: sharp.OutputInfo };
    try {
      raw = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    } catch {
      return null;
    }
    const { data, info } = raw;
    const width = info.width;
    const height = info.height;
    const channels = info.channels;
    if (width < 32 || height < 32) return null;

    const mask = this.buildContentMask(data, info, channels);
    if (!mask) return null;
    const total = width * height;
    // 只清真正的噪点（几像素的孤立点）。这里的面积下限绝不能再抬高：
    // 武器尖、披风角这类"边角料"面积虽小，却要在第 2 步被完整并进所属素材的包围盒。
    const minArea = Math.max(10, Math.floor(total * 0.00001));
    this.removeTinyNoise(mask, width, height);

    const cols = Math.ceil(Math.sqrt(expected));
    const rows = Math.ceil(expected / cols);
    // 门控半径：碎件并入主躯干的最大距离，取单格短边 25%——
    // 够收进武器边角料，又远小于格间距，不会跨吞邻格素材
    const gateRadius = Math.max(6, Math.min(width / cols, height / rows) * 0.25);

    // 1) 主躯干定位：形态学闭运算多档，挑出「数量最接近 expected」的一组连通块
    const kernels = [0, 3, 5, 7, 9];
    let mainComponents: BoundingComponent[] | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const k of kernels) {
      const closed = k > 0 ? this.morphClose(mask, width, height, k) : mask;
      // 只把"够格当一个素材"的连通块算作主躯干：混进来的十几像素孤斑（抗锯齿残片、
      // 武器断开的一角）会把数量顶高，凑出看似命中的 expected，实际切出一张空白图。
      const components = this.filterSpriteSized(
        this.labelAndFilterComponents(closed, width, height, minArea)
      );
      if (components.length === 0) continue;
      if (components.length === expected) {
        mainComponents = components;
        break;
      }
      const diff = components.length - expected;
      const score = diff >= 0 ? diff : -diff * 2;
      if (score < bestScore) {
        bestScore = score;
        mainComponents = components;
      }
    }
    if (!mainComponents || mainComponents.length === 0) return null;

    // 2) 碎块归属：把武器 / 披风等边角料并进最近的主躯干，得到包住完整素材的真实包围盒
    let groups = this.absorbFragments(mask, width, height, minArea, mainComponents);
    if (groups.length === 0) return null;

    // 3.5) 粘连拆分：相邻两个素材画到粘连时会被并成一格（表现为某格高达网格行距的近两倍）。
    //     只有数量还不够时才动刀，且只在"内容最稀疏"处下刀，避免把完好的素材切坏。
    if (groups.length < expected) {
      groups = this.splitOversizedGroups(groups, mask, width, height, cols, rows);
      if (groups.length > expected) {
        groups = this.mergeNearestGroups(groups, expected, gateRadius);
      }
    }

    // 3) 数量校准：多出来的先看是不是"AI 多画了"。网格一共 cols×rows 个格位，
    //    只要还装得下、且只多出一两个，就如实返回——用户要的是"画面里每个素材都完整抠下来"，
    //    硬合成设定数量反而会把相邻两格捏成一张细长图。
    //    装不下或明显过载（多半是碎片/同一素材被拆散），才按包围盒间距最小反复合并。
    const slots = cols * rows;
    if (groups.length > expected && (groups.length > slots || groups.length - expected > 2)) {
      groups = this.mergeNearestGroups(groups, expected, gateRadius);
      if (groups.length > expected) {
        const slotted = this.assignComponentsToSlots(groups, expected, cols, rows, width, height);
        if (slotted) return slotted;
      }
    }

    // 数量不足期望的一半 → 主躯干定位不可信，最后试一次投影推断网格线（对粘连 / 噪点图更稳）
    if (groups.length < Math.max(2, Math.ceil(expected * 0.5))) {
      const projected = this.inferGridFromMask(mask, width, height, cols, rows);
      if (projected) {
        const slice = projected.slice(0, expected);
        if (slice.length === expected) return slice;
      }
      return null;
    }

    // 质量闸门：复杂不透明底图（渐变/场景背景）会让掩码几乎铺满整幅，连通块分析随之失效，
    // 典型症状是"某一格吞掉整张图 + 一堆十几像素的碎斑"。这种结果比等分还糟，直接判失败退回等分。
    // 判据：素材不可能大过自己的格位太多（格位面积 = 整幅 / 格数），超出即视为吞并了邻格或整幅。
    const nominalCellArea = (width / cols) * (height / rows);
    let maxCellArea = 0;
    for (const group of groups) {
      const area = (group.maxX - group.minX + 1) * (group.maxY - group.minY + 1);
      if (area > maxCellArea) maxCellArea = area;
    }
    // 实测：正常素材的包围盒最多到格位面积的 2.4 倍（角色武器外扩），
    // 而底图失效时会直接等于整幅面积（16 倍），中间是巨大空档，取 4 倍做分界很安全。
    if (maxCellArea > nominalCellArea * 4) return null;

    // 尺寸一致性闸门：最大的格子比中位数大一个数量级，说明切出来的不是同一套素材
    const sortedAreas = groups
      .map((group) => (group.maxX - group.minX + 1) * (group.maxY - group.minY + 1))
      .sort((a, b) => a - b);
    const medianArea = sortedAreas[Math.floor(sortedAreas.length / 2)] || 1;
    if (maxCellArea > medianArea * 12) return null;

    groups.sort((a, b) => a.minY - b.minY || a.minX - b.minX);
    return groups.map((component) => ({
      left: component.minX,
      top: component.minY,
      width: component.maxX - component.minX + 1,
      height: component.maxY - component.minY + 1
    }));
  }

  /** 生成前景掩码：透明图按 alpha，不透明图按与边缘底色的颜色距离 */
  private buildContentMask(data: Buffer, info: sharp.OutputInfo, channels: number): Uint8Array | null {
    const width = info.width;
    const height = info.height;
    const total = width * height;
    let fullyTransparent = 0;
    let fullyOpaque = 0;
    for (let i = 0; i < total; i += 1) {
      const alpha = data[i * channels + 3];
      if (alpha <= 16) fullyTransparent += 1;
      else if (alpha >= 240) fullyOpaque += 1;
    }
    const transparentRatio = fullyTransparent / total;
    const opaqueRatio = fullyOpaque / total;
    const mask = new Uint8Array(total);

    if (transparentRatio > 0.005 && opaqueRatio < 0.985) {
      // 透明背景：alpha ≥ 24 视为内容（容忍抠图后的细边）
      for (let i = 0; i < total; i += 1) {
        if (data[i * channels + 3] >= 24) mask[i] = 1;
      }
      return mask;
    }

    // 不透明均匀底色：与四边采样的主体颜色差异足够大才算内容
    const background = this.estimateBackgroundFromEdges(data, info);
    const tolerance = Math.max(18, this.computeAdaptiveTolerance(data, info, background, channels));
    for (let i = 0; i < total; i += 1) {
      const offset = i * channels;
      const dr = data[offset] - background.r;
      const dg = data[offset + 1] - background.g;
      const db = data[offset + 2] - background.b;
      if (dr * dr + dg * dg + db * db > tolerance * tolerance) mask[i] = 1;
    }
    return mask;
  }

  /** 4-连通区域标记：统计每块的像素数与真实包围盒 */
  private labelComponents(
    mask: Uint8Array,
    width: number,
    height: number
  ): Array<{ area: number; minX: number; minY: number; maxX: number; maxY: number }> {
    const total = width * height;
    const visited = new Uint8Array(total);
    const stack = new Int32Array(total);
    const components: Array<{ area: number; minX: number; minY: number; maxX: number; maxY: number }> = [];

    for (let start = 0; start < total; start += 1) {
      if (!mask[start] || visited[start]) continue;
      let top = 0;
      stack[top++] = start;
      visited[start] = 1;
      let area = 0;
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;

      while (top > 0) {
        const index = stack[--top] as number;
        area += 1;
        const x = index % width;
        const y = (index - x) / width;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;

        if (x > 0) {
          const next = index - 1;
          if (mask[next] && !visited[next]) {
            visited[next] = 1;
            stack[top++] = next;
          }
        }
        if (x < width - 1) {
          const next = index + 1;
          if (mask[next] && !visited[next]) {
            visited[next] = 1;
            stack[top++] = next;
          }
        }
        if (index >= width) {
          const next = index - width;
          if (mask[next] && !visited[next]) {
            visited[next] = 1;
            stack[top++] = next;
          }
        }
        if (index < total - width) {
          const next = index + width;
          if (mask[next] && !visited[next]) {
            visited[next] = 1;
            stack[top++] = next;
          }
        }
      }

      components.push({ area, minX, minY, maxX, maxY });
    }
    return components;
  }

  /** 4-连通区域标记 + 按尺寸过滤（≥3px 且 ≥minArea），供 detectAutoCells 多级兜底复用 */
  private labelAndFilterComponents(
    mask: Uint8Array,
    width: number,
    height: number,
    minArea: number
  ): BoundingComponent[] {
    const raw = this.labelComponents(mask, width, height);
    return raw.filter(
      (component) =>
        component.maxX - component.minX + 1 >= 3 &&
        component.maxY - component.minY + 1 >= 3 &&
        component.area >= minArea
    );
  }

  /** 二值形态学闭运算：先 dilate 后 erode，桥接同一素材内的细缝。kernelSize 需 ≥3 且为奇数 */
  private morphClose(mask: Uint8Array, width: number, height: number, kernelSize: number): Uint8Array {
    if (kernelSize < 3) return mask;
    const radius = (kernelSize - 1) / 2;
    const dilated = this.morphDilate(mask, width, height, radius);
    return this.morphErode(dilated, width, height, radius);
  }

  /** 1D 可分离方形核的膨胀：水平 + 垂直两次扫描，O(W·H·K) 而非 O(W·H·K²) */
  private morphDilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
    const total = width * height;
    const tmp = new Uint8Array(total);
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        const x0 = x - radius < 0 ? 0 : x - radius;
        const x1 = x + radius >= width ? width - 1 : x + radius;
        let any = 0;
        for (let xx = x0; xx <= x1 && any === 0; xx += 1) {
          if (mask[row + xx]) any = 1;
        }
        tmp[row + x] = any;
      }
    }
    const out = new Uint8Array(total);
    for (let x = 0; x < width; x += 1) {
      for (let y = 0; y < height; y += 1) {
        const y0 = y - radius < 0 ? 0 : y - radius;
        const y1 = y + radius >= height ? height - 1 : y + radius;
        let any = 0;
        for (let yy = y0; yy <= y1 && any === 0; yy += 1) {
          if (tmp[yy * width + x]) any = 1;
        }
        out[y * width + x] = any;
      }
    }
    return out;
  }

  /** 1D 可分离方形核的腐蚀：水平 + 垂直两次扫描 */
  private morphErode(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
    const total = width * height;
    const tmp = new Uint8Array(total);
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        const x0 = x - radius < 0 ? 0 : x - radius;
        const x1 = x + radius >= width ? width - 1 : x + radius;
        let all = 1;
        for (let xx = x0; xx <= x1; xx += 1) {
          if (!mask[row + xx]) { all = 0; break; }
        }
        tmp[row + x] = all;
      }
    }
    const out = new Uint8Array(total);
    for (let x = 0; x < width; x += 1) {
      for (let y = 0; y < height; y += 1) {
        const y0 = y - radius < 0 ? 0 : y - radius;
        const y1 = y + radius >= height ? height - 1 : y + radius;
        let all = 1;
        for (let yy = y0; yy <= y1; yy += 1) {
          if (!tmp[yy * width + x]) { all = 0; break; }
        }
        out[y * width + x] = all;
      }
    }
    return out;
  }

  /**
   * 投影推断网格线：从内容掩码的横/纵密度剖面里，用 DP 求最优分割线，
   * 推断真实网格边界（允许各列/行宽窄略有不同）。
   * 任一行/列方向推断失败则整体返回 null，由调用方走下一级兜底。
   */
  private inferGridFromMask(
    mask: Uint8Array,
    width: number,
    height: number,
    cols: number,
    rows: number
  ): GridAutoCell[] | null {
    const rowDensity = this.computeDensityProfile(mask, width, height, true);
    const colDensity = this.computeDensityProfile(mask, width, height, false);
    const hLines = this.inferLinesByDensity(rowDensity, rows - 1);
    if (!hLines) return null;
    const vLines = this.inferLinesByDensity(colDensity, cols - 1);
    if (!vLines) return null;
    const cells: GridAutoCell[] = [];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        cells.push({
          left: vLines[col],
          top: hLines[row],
          width: vLines[col + 1] - vLines[col],
          height: hLines[row + 1] - hLines[row]
        });
      }
    }
    return cells;
  }

  /** 计算某方向的"内容密度剖面"（该行/列中内容像素占比），并做轻度平滑去毛刺 */
  private computeDensityProfile(
    mask: Uint8Array,
    width: number,
    height: number,
    horizontal: boolean
  ): Float32Array {
    const len = horizontal ? height : width;
    const outer = horizontal ? height : width;
    const raw = new Float32Array(len);
    for (let i = 0; i < len; i += 1) {
      let count = 0;
      if (horizontal) {
        const row = i * width;
        for (let x = 0; x < width; x += 1) {
          if (mask[row + x]) count += 1;
        }
      } else {
        for (let y = 0; y < height; y += 1) {
          if (mask[y * width + i]) count += 1;
        }
      }
      raw[i] = count / outer;
    }
    // 轻度移动平均：抹掉单列/单行的孤立毛刺，同时保留真实的空隙带
    const half = Math.max(1, Math.round(len / 200));
    const smoothed = new Float32Array(len);
    for (let i = 0; i < len; i += 1) {
      let sum = 0;
      let n = 0;
      for (let k = i - half; k <= i + half; k += 1) {
        if (k >= 0 && k < len) {
          sum += raw[k];
          n += 1;
        }
      }
      smoothed[i] = sum / n;
    }
    return smoothed;
  }

  /**
   * 在密度剖面上用 DP 求 n 条最优分割线（返回完整分割线 [0, ...切点, len]）。
   * 目标：最小化各切点处的内容密度之和——切点应落在最空的位置；
   * 约束：每段长度 ∈ [mean×0.5, mean×1.8]，既保证分割大致均匀，
   *       也天然排除图像外围的空白边（把外边距当切点会让首/末段过窄）。
   * 校验：任一最优切点处密度 ≥ 峰值×0.25 视为切到了内容，整体判定失败返回 null。
   */
  private inferLinesByDensity(density: Float32Array, n: number): number[] | null {
    const len = density.length;
    if (n <= 0) return [0, len];
    const segments = n + 1;
    const mean = len / segments;
    const minSeg = Math.max(2, Math.floor(mean * 0.5));
    const maxSeg = Math.max(minSeg + 1, Math.ceil(mean * 1.8));
    if (segments * minSeg > len) return null;

    let peak = 0;
    for (let i = 0; i < len; i += 1) {
      if (density[i] > peak) peak = density[i];
    }
    if (peak <= 0) return null;

    const INF = Number.POSITIVE_INFINITY;
    // dp[j][p]：用 j 段覆盖 [0,p]（p 为第 j 段终点）的最小累计代价
    const dp: Float64Array[] = [];
    const from: Int32Array[] = [];
    for (let j = 0; j <= segments; j += 1) {
      dp.push(new Float64Array(len + 1).fill(INF));
      from.push(new Int32Array(len + 1).fill(-1));
    }
    dp[0][0] = 0;
    for (let j = 1; j <= segments; j += 1) {
      const lo = j * minSeg;
      const hi = Math.min(len, j * maxSeg);
      for (let p = lo; p <= hi; p += 1) {
        const qLo = Math.max(0, p - maxSeg);
        const qHi = p - minSeg;
        const cost = p < len ? density[p] : 0;
        let bestVal = INF;
        let bestQ = -1;
        for (let q = qLo; q <= qHi; q += 1) {
          const prev = dp[j - 1][q];
          if (prev === INF) continue;
          if (prev < bestVal) {
            bestVal = prev;
            bestQ = q;
          }
        }
        if (bestQ >= 0) {
          dp[j][p] = bestVal + cost;
          from[j][p] = bestQ;
        }
      }
    }
    if (from[segments][len] < 0) return null;

    const lines: number[] = [len];
    let p = len;
    for (let j = segments; j >= 1; j -= 1) {
      p = from[j][p];
      if (p < 0) return null;
      lines.push(p);
    }
    lines.reverse();
    if (lines[0] !== 0) return null;

    // 校验：内部切点必须落在"足够空"的位置，否则说明分割线切到了素材
    for (let i = 1; i < lines.length - 1; i += 1) {
      if (density[lines[i]] >= peak * 0.25) return null;
    }
    return lines;
  }

  /** 等分槽位归并：把每个连通块按"中心最近"指派到 expected 个槽位之一，返回各槽位的并集包围盒 */
  private assignComponentsToSlots(
    components: BoundingComponent[],
    expected: number,
    cols: number,
    rows: number,
    width: number,
    height: number
  ): GridAutoCell[] | null {
    if (cols < 1 || rows < 1) return null;
    const stepX = width / cols;
    const stepY = height / rows;
    const owners = new Int32Array(components.length);
    for (let index = 0; index < components.length; index += 1) {
      const component = components[index];
      const cx = (component.minX + component.maxX) / 2;
      const cy = (component.minY + component.maxY) / 2;
      let bestSlot = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let slot = 0; slot < expected; slot += 1) {
        const col = slot % cols;
        const row = Math.floor(slot / cols);
        const dx = cx / stepX - (col + 0.5);
        const dy = cy / stepY - (row + 0.5);
        const distance = dx * dx + dy * dy;
        if (distance < bestDistance) {
          bestDistance = distance;
          bestSlot = slot;
        }
      }
      owners[index] = bestSlot;
    }
    const cells: GridAutoCell[] = [];
    for (let slot = 0; slot < expected; slot += 1) {
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      for (let index = 0; index < components.length; index += 1) {
        if (owners[index] !== slot) continue;
        const component = components[index];
        if (component.minX < minX) minX = component.minX;
        if (component.minY < minY) minY = component.minY;
        if (component.maxX > maxX) maxX = component.maxX;
        if (component.maxY > maxY) maxY = component.maxY;
      }
      if (minX > maxX || minY > maxY) return null;
      cells.push({
        left: minX,
        top: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1
      });
    }
    return cells;
  }

  /**
   * 碎块归属：把掩码里的全部连通块按「最近主躯干」合并，得到每个素材的完整包围盒。
   * 面积远小于最大块的（武器尖、披风角、光效等边角料）会被并入最近的主躯干，
   * 因此包围盒是"素材本体 + 全部边角料"的真实范围，而不是只包住身体导致武器被切掉。
   */
  private absorbFragments(
    mask: Uint8Array,
    width: number,
    height: number,
    minArea: number,
    mainComponents: BoundingComponent[]
  ): BoundingComponent[] {
    const all = this.labelAndFilterComponents(mask, width, height, minArea);
    if (all.length === 0) return mainComponents.map((component) => ({ ...component }));

    let maxArea = 0;
    for (const component of all) {
      if (component.area > maxArea) maxArea = component.area;
    }
    const groups: BoundingComponent[] = mainComponents.map((component) => ({ ...component }));

    for (const component of all) {
      // 已被某个主躯干的包围盒覆盖：说明它就是这个主躯干本身，跳过以免重复计数
      if (this.isCoveredByGroups(component, groups)) continue;

      const cx = (component.minX + component.maxX) / 2;
      const cy = (component.minY + component.maxY) / 2;
      let bestIndex = -1;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < groups.length; index += 1) {
        const distance = this.pointToBoxDistance(cx, cy, groups[index]);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      }

      // 碎件一律并入最近的主躯干，不再用门控半径把它踢成独立一格：
      // 十几像素的孤斑单独成格会切出一张近乎空白的图，而它几乎必然属于某个素材
      // （武器尖、特效碎点、抗锯齿残片），并进最近的一格只会让包围盒略微外扩。
      const target = groups[bestIndex];
      if (component.minX < target.minX) target.minX = component.minX;
      if (component.minY < target.minY) target.minY = component.minY;
      if (component.maxX > target.maxX) target.maxX = component.maxX;
      if (component.maxY > target.maxY) target.maxY = component.maxY;
      target.area += component.area;
    }

    return groups;
  }

  /**
   * 组间合并：数量多于期望时，反复合并代价最小的一对，直到降到期望数或间距超出门控。
   * 代价不只看间距，还要看合并后的包围盒是否还像个"单格素材"：
   * 上下相邻的两个角色间距可能很小，但一合并就成细长条（高接近两倍行距），
   * 那多半是两个不同格的素材被强行捏在一起，要加重代价让算法优先去合并别的对。
   */
  private mergeNearestGroups(
    groups: BoundingComponent[],
    target: number,
    gateRadius: number
  ): BoundingComponent[] {
    const merged = groups.map((component) => ({ ...component }));
    while (merged.length > target) {
      let bestI = -1;
      let bestJ = -1;
      let bestCost = Number.POSITIVE_INFINITY;
      let bestGap = Number.POSITIVE_INFINITY;
      for (let i = 0; i < merged.length; i += 1) {
        for (let j = i + 1; j < merged.length; j += 1) {
          const a = merged[i];
          const b = merged[j];
          const gap = this.boxGap(a, b);
          const mw = Math.max(a.maxX, b.maxX) - Math.min(a.minX, b.minX) + 1;
          const mh = Math.max(a.maxY, b.maxY) - Math.min(a.minY, b.minY) + 1;
          // 代价取"合并后的包围盒面积"：同一格里的两块（身体 + 伸出的武器）并起来仍然紧凑，
          // 而上下相邻的两个角色并起来会得到细长条、面积暴涨，自然被排到后面。
          const cost = mw * mh;
          if (cost < bestCost) {
            bestCost = cost;
            bestGap = gap;
            bestI = i;
            bestJ = j;
          }
        }
      }
      if (bestI < 0 || bestGap > gateRadius) break;
      const a = merged[bestI];
      const b = merged[bestJ];
      a.minX = Math.min(a.minX, b.minX);
      a.minY = Math.min(a.minY, b.minY);
      a.maxX = Math.max(a.maxX, b.maxX);
      a.maxY = Math.max(a.maxY, b.maxY);
      a.area += b.area;
      merged.splice(bestJ, 1);
    }
    return merged;
  }

  /**
   * 剔除尺寸远小于同批最大块的连通块：它们不是独立素材，而是碎斑。
   * 注意只在「主躯干选取」阶段用——碎斑本身仍会在 absorbFragments 里被并进所属素材的包围盒。
   */
  private filterSpriteSized(components: BoundingComponent[]): BoundingComponent[] {
    if (components.length <= 1) return components;
    let maxArea = 0;
    for (const component of components) {
      if (component.area > maxArea) maxArea = component.area;
    }
    const floor = maxArea * 0.02;
    const kept = components.filter((component) => component.area >= floor);
    return kept.length > 0 ? kept : components;
  }

  /**
   * 粘连拆分：把"明显高于 / 宽于单个网格位"的格子按内容最稀疏处切开。
   * 上下相邻的两个角色画到粘连时会并成一个连通块，此时整格高度接近两倍行距，
   * 单靠连通性永远分不开，必须借助网格节拍（行距 / 列距）在空隙带下刀。
   */
  private splitOversizedGroups(
    groups: BoundingComponent[],
    mask: Uint8Array,
    width: number,
    height: number,
    cols: number,
    rows: number
  ): BoundingComponent[] {
    const cellW = width / cols;
    const cellH = height / rows;
    const out: BoundingComponent[] = [];
    for (const group of groups) {
      const w = group.maxX - group.minX + 1;
      const h = group.maxY - group.minY + 1;
      const splitRows = h > cellH * 1.5 ? Math.min(rows, Math.max(2, Math.round(h / cellH))) : 1;
      const splitCols = w > cellW * 1.5 ? Math.min(cols, Math.max(2, Math.round(w / cellW))) : 1;
      if (splitRows === 1 && splitCols === 1) {
        out.push(group);
        continue;
      }
      const yCuts = this.findLowDensityCuts(mask, width, group, splitRows, cellH, false);
      const xCuts = this.findLowDensityCuts(mask, width, group, splitCols, cellW, true);
      const ys = [group.minY, ...yCuts, group.maxY + 1];
      const xs = [group.minX, ...xCuts, group.maxX + 1];
      for (let r = 0; r + 1 < ys.length; r += 1) {
        for (let c = 0; c + 1 < xs.length; c += 1) {
          const box = this.contentBoxIn(mask, width, xs[c], ys[r], xs[c + 1] - 1, ys[r + 1] - 1);
          if (box) out.push(box);
        }
      }
    }
    return out.length > 0 ? out : groups;
  }

  /** 在理想等分点附近找内容最稀疏的切分线（找"空隙带"下刀，避免切到素材本体） */
  private findLowDensityCuts(
    mask: Uint8Array,
    width: number,
    group: BoundingComponent,
    parts: number,
    pitch: number,
    horizontal: boolean
  ): number[] {
    if (parts < 2) return [];
    const start = horizontal ? group.minX : group.minY;
    const end = horizontal ? group.maxX : group.maxY;
    const span = end - start + 1;
    const tolerance = Math.max(2, pitch * 0.4);
    const cuts: number[] = [];
    for (let i = 1; i < parts; i += 1) {
      const ideal = start + (span * i) / parts;
      const from = Math.max(start + 1, Math.round(ideal - tolerance));
      const to = Math.min(end, Math.round(ideal + tolerance));
      let bestLine = -1;
      let bestDensity = Number.POSITIVE_INFINITY;
      for (let line = from; line <= to; line += 1) {
        let density = 0;
        if (horizontal) {
          for (let y = group.minY; y <= group.maxY; y += 1) if (mask[y * width + line]) density += 1;
        } else {
          const row = line * width;
          for (let x = group.minX; x <= group.maxX; x += 1) if (mask[row + x]) density += 1;
        }
        if (density < bestDensity) {
          bestDensity = density;
          bestLine = line;
        }
      }
      if (bestLine > 0) cuts.push(bestLine);
    }
    return cuts;
  }

  /** 取矩形区域内的真实内容包围盒；区域内没有内容返回 null */
  private contentBoxIn(
    mask: Uint8Array,
    width: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number
  ): BoundingComponent | null {
    let minX = -1;
    let minY = -1;
    let maxX = -1;
    let maxY = -1;
    let area = 0;
    for (let y = y0; y <= y1; y += 1) {
      const row = y * width;
      for (let x = x0; x <= x1; x += 1) {
        if (!mask[row + x]) continue;
        area += 1;
        if (minX < 0 || x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (minY < 0) minY = y;
        maxY = y;
      }
    }
    if (minX < 0) return null;
    return { area, minX, minY, maxX, maxY };
  }

  /** 点到包围盒的距离：落在盒内为 0，否则为到最近边的欧氏距离 */
  private pointToBoxDistance(x: number, y: number, box: BoundingComponent): number {
    const dx = Math.max(box.minX - x, 0, x - box.maxX);
    const dy = Math.max(box.minY - y, 0, y - box.maxY);
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** 两包围盒之间的间距：相交或相切为 0 */
  private boxGap(a: BoundingComponent, b: BoundingComponent): number {
    const dx = Math.max(a.minX - b.maxX, 0, b.minX - a.maxX);
    const dy = Math.max(a.minY - b.maxY, 0, b.minY - a.maxY);
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** 连通块中心是否已落在某个已有组的包围盒内（容 1px 误差），用于跳过主躯干自身避免重复计数 */
  private isCoveredByGroups(component: BoundingComponent, groups: BoundingComponent[]): boolean {
    const cx = (component.minX + component.maxX) / 2;
    const cy = (component.minY + component.maxY) / 2;
    for (const group of groups) {
      if (cx >= group.minX - 1 && cx <= group.maxX + 1 && cy >= group.minY - 1 && cy <= group.maxY + 1) {
        return true;
      }
    }
    return false;
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

  /**
   * 只清真正的噪点：几像素的孤立点。
   * 历史教训：这里曾用过 max(12, 0.8% 画布) 的高阈值，结果把武器尖、披风角这类"边角料"
   * 在闭运算之前就整块删掉了，切出来的角色缺胳膊少腿。现在阈值压到个位数像素，
   * 小碎件一律保留，交给 absorbFragments 并进所属素材的包围盒。
   */
  private removeTinyNoise(mask: Uint8Array, width: number, height: number): void {
    const total = width * height;
    const visited = new Uint8Array(total);
    const minRegion = Math.max(4, Math.floor(total * 0.000004));

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

  /**
   * 读取本地图片为「预览用」dataUrl：最长边超过 maxSide（默认 1024）时在主进程先降采样再返回，
   * 避免把全尺寸大图整张 base64 丢给渲染进程解码——渲染主线程一次性解码多张 1254-2048px PNG
   * 会卡死数秒，Windows 上表现为"鼠标正常、所有输入框打字失灵"（键盘/输入法事件流被饿死）。
   * 原图本就不超过 maxSide 时原样返回（只读文件转 base64），零额外开销。
   * dataUrl 仅用于界面预览（切分预览/参考图/素材列表），生成与切分始终按文件路径在主进程取原图，
   * 因此降采样不影响任何下游精度。
   */
  async previewDataUrl(absolutePath: string, maxSide = 1024): Promise<string> {
    const metadata = await sharp(absolutePath, { failOn: "none" }).metadata();
    const longest = Math.max(metadata.width ?? 0, metadata.height ?? 0);
    const extension = path.extname(absolutePath).replace(".", "").toLowerCase() || "png";
    if (longest <= maxSide) {
      const buffer = await fs.readFile(absolutePath);
      const mime = extension === "jpg" || extension === "jpeg" ? "image/jpeg" : "image/png";
      return `data:${mime};base64,${buffer.toString("base64")}`;
    }
    const buffer = await sharp(absolutePath, { failOn: "none" })
      .resize(maxSide, maxSide, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    return `data:image/png;base64,${buffer.toString("base64")}`;
  }
}
