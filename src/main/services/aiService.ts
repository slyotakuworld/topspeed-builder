import path from "node:path";
import fs from "fs-extra";
import type { AppSettings, GenerationQuality, ReferenceImageRole, ReferenceStrength } from "@shared/types";

interface ReferenceImagePayload {
  filePath: string;
  role: ReferenceImageRole;
  name?: string;
  sourceAssetId?: string;
}

interface GenerateImageArgs {
  prompt: string;
  size: string;
  transparentBackground: boolean;
  settings: AppSettings;
  quality?: GenerationQuality;
  referenceImages?: ReferenceImagePayload[];
  editIntent?: string;
  referenceStrength?: ReferenceStrength;
}

export class AIGenerationService {
  async generateImage(args: GenerateImageArgs): Promise<Buffer> {
    if (!args.settings.apiBaseUrl.trim()) {
      throw new Error("接口地址为空。请在设置页配置 API 接口地址。");
    }

    const rawEndpoint = args.settings.apiBaseUrl.trim();
    this.assertHttpEndpoint(rawEndpoint, "自定义接口基础地址");
    const useReference = (args.referenceImages?.length ?? 0) > 0;
    const endpoint = this.resolveImageEndpoint(rawEndpoint, useReference);

    return this.generateWithCustomImageFormat(args, endpoint, useReference);
  }

  async testConnection(settings: AppSettings): Promise<{ ok: boolean; status: number; detail: string }> {
    if (!settings.apiBaseUrl.trim()) {
      return { ok: false, status: 0, detail: "接口地址为空，请先填写 API Base URL。" };
    }

    const baseUrl = settings.apiBaseUrl.trim();
    try {
      this.assertHttpEndpoint(baseUrl, "API 接口基础地址");
    } catch (err) {
      return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) };
    }
    // 连接测试走模型列表接口 GET {root}/models（与「拉取模型」同一地址解析语义）：
    // 1) /models 响应快——不像真实出图那样要等数十秒到数分钟，不会被短超时误杀；
    // 2) 大多数 OpenAI 兼容网关（如 aixoras / new-api 中转）对 /models 同样要求鉴权，
    //    因此可以同时验证 API Key（无 key 会返回 401/403）。
    const modelsUrl = `${this.resolveApiRoot(baseUrl)}/models`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (settings.apiKey.trim()) {
      headers.Authorization = `Bearer ${settings.apiKey.trim()}`;
    }

    try {
      const response = await fetch(modelsUrl, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(20000)
      });

      const responseText = await response.text();
      if (response.ok) {
        let modelCount = -1;
        try {
          const json = JSON.parse(responseText);
          const list = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
          modelCount = list.length;
        } catch {
          // 返回体不是 JSON 也视为连通成功（部分网关 /models 形态不同）
        }
        const detail =
          modelCount >= 0
            ? `接口连通（HTTP 200），鉴权通过，模型列表共 ${modelCount} 个。`
            : "接口连通（HTTP 200）。";
        return { ok: true, status: response.status, detail };
      }

      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          status: response.status,
          detail: `鉴权失败(${response.status})：请检查 API Key 是否正确。${this.summarizeBody(responseText)}`
        };
      }

      if (response.status === 404) {
        return {
          ok: false,
          status: response.status,
          detail: `接口地址未找到(404)：请检查 API Base URL 路径是否正确。${this.summarizeBody(responseText)}`
        };
      }

      return { ok: false, status: response.status, detail: `HTTP ${response.status} · ${this.summarizeBody(responseText)}` };
    } catch (error) {
      const message = this.describeFetchError(error);
      if (message.includes("ENOTFOUND") || message.includes("not found") || message.includes("DNS")) {
        return { ok: false, status: 0, detail: `DNS 解析失败：无法找到服务器地址，请检查域名是否正确。 详情: ${message}` };
      }
      if (message.includes("ECONNREFUSED") || message.includes("refused")) {
        return { ok: false, status: 0, detail: `连接被拒绝：服务器拒绝连接，请检查地址和端口是否正确。 详情: ${message}` };
      }
      if (
        message.includes("超时") ||
        message.includes("aborted") ||
        message.includes("timed out") ||
        message.includes("ETIMEDOUT") ||
        message.includes("AbortError")
      ) {
        return {
          ok: false,
          status: 0,
          detail: `连接超时（20 秒内 ${modelsUrl} 无响应）：请检查网络是否可访问该 API 域名；若是海外/代理服务，请确认代理已生效或换国内可达的网关。 详情: ${message}`
        };
      }
      if (message.includes("SSL") || message.includes("CERT") || message.includes("self signed") || message.includes("DEPTH_ZERO")) {
        return { ok: false, status: 0, detail: `SSL/证书错误：${message}` };
      }
      return { ok: false, status: 0, detail: `连接失败：${message}` };
    }
  }

  buildPrompt(parts: {
    assetType: string;
    name: string;
    description: string;
    style: string;
    size: string;
    extra?: string;
    transparentBackground: boolean;
  }): string {
    const background = parts.transparentBackground
      ? "透明背景，主体居中，不要地面阴影，不要文字，不要水印。"
      : "干净的游戏素材背景。";

    return [
      `生成可直接用于游戏工程的二维${parts.assetType}精灵，名称为：${parts.name}。`,
      `素材描述：${parts.description}。`,
      `美术风格：${parts.style}。`,
      `最终画布尺寸：${parts.size}。`,
      background,
      "轮廓必须清晰可读，比例保持一致，构图只包含当前素材主体。",
      parts.extra ?? ""
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async generateWithCustomImageFormat(
    args: GenerateImageArgs,
    endpoint: string,
    useReference: boolean
  ): Promise<Buffer> {
    if (useReference) {
      // OpenAI /images/edits 只认标准字段：image / prompt / model / size / background / quality。
      // 不再发送 editIntent / referenceStrength / referenceImages 等自定义字段——
      // 严格网关（官方 OpenAI / new-api 中转）会在鉴权前先以 400 invalid arguments 拒绝它们。
      const buildReferenceForm = async (includeQuality: boolean): Promise<FormData> => {
        const form = new FormData();
        form.append("prompt", args.prompt);
        form.append("size", args.size);
        form.append("model", args.settings.model);
        // OpenAI 标准透明背景字段；关闭时缺省即为不透明/auto
        if (args.transparentBackground) {
          form.append("background", "transparent");
        }
        // 生成质量为可选透传参数；服务端不支持时自动回退为不带 quality 的请求重试
        if (includeQuality && args.quality) {
          form.append("quality", args.quality);
        }
        for (const reference of args.referenceImages ?? []) {
          form.append("image", await this.fileToBlob(reference.filePath), path.basename(reference.filePath));
        }
        return form;
      };

      const sendReferenceForm = async (includeQuality: boolean): Promise<Response> =>
        this.fetchWithContext(
          endpoint,
          {
            method: "POST",
            headers: {
              ...(args.settings.apiKey ? { Authorization: `Bearer ${args.settings.apiKey}` } : {})
            },
            body: await buildReferenceForm(includeQuality)
          },
          "自定义接口"
        );

      let response = await sendReferenceForm(true);
      if (!response.ok && args.quality) {
        const responseText = await response.text();
        if (this.isUnsupportedImageOptionError(response.status, responseText)) {
          response = await sendReferenceForm(false);
        } else {
          throw new Error(
            `图片接口失败: HTTP ${response.status} ${response.statusText}. ${this.summarizeBody(responseText)}`
          );
        }
      }

      return this.readImageResponse(response, "自定义接口", endpoint);
    }

    // ---- 无参考图：JSON 通道（OpenAI Images 标准参数 + 降级链）----
    // 只发送 OpenAI 标准字段：prompt / size / model / quality / background。
    // 不同网关差异仅在于对可选字段的支持度：宽松网关（如 Gitee AI）忽略未知可选字段，
    // 严格网关（new-api / OpenAI 官方）对不支持的参数直接 400。
    // 依次尝试：带质量+透明 → 去掉质量 → 去掉透明，直到网关接受。
    const wantsTransparent = args.transparentBackground === true;
    const wantsQuality = Boolean(args.quality);

    const buildPayload = (useQuality: boolean, withTransparent: boolean): Record<string, unknown> => {
      const payload: Record<string, unknown> = {
        prompt: args.prompt,
        size: args.size,
        model: args.settings.model
      };
      if (useQuality && args.quality) {
        payload.quality = args.quality;
      }
      if (withTransparent) {
        payload.background = "transparent";
      }
      return payload;
    };

    const candidates: Array<{ q: boolean; bg: boolean }> = [{ q: wantsQuality, bg: wantsTransparent }];
    if (wantsQuality) {
      candidates.push({ q: false, bg: wantsTransparent });
    }
    if (wantsTransparent) {
      // 网关不支持 transparent 背景时，放弃透明以保证能出图
      candidates.push({ q: false, bg: false });
    }

    let lastStatus = 0;
    let lastErrorText = "";
    for (const candidate of candidates) {
      const response = await this.postJson(endpoint, args.settings.apiKey, buildPayload(candidate.q, candidate.bg));
      if (response.ok) {
        return this.readImageResponse(response, "自定义接口", endpoint);
      }
      const body = await response.text();
      if (!this.isUnsupportedImageOptionError(response.status, body)) {
        throw new Error(`图片接口失败: HTTP ${response.status} ${response.statusText}. ${this.summarizeBody(body)}`);
      }
      lastStatus = response.status;
      lastErrorText = body;
    }

    throw new Error(
      `图片接口失败: HTTP ${lastStatus}。服务端拒绝了所有请求参数组合（含质量/透明背景等可选参数）。` +
        (lastErrorText ? ` 最后一条响应: ${this.summarizeBody(lastErrorText)}` : "")
    );
  }

  private async postJson(endpoint: string, apiKey: string, payload: Record<string, unknown>): Promise<Response> {
    return this.fetchWithContext(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify(payload)
      },
      "自定义接口"
    );
  }

  private isUnsupportedImageOptionError(status: number, responseText: string): boolean {
    if (status !== 400 && status !== 422) {
      return false;
    }

    const lower = responseText.toLowerCase();
    const mentionsExtendedOption =
      lower.includes("background") ||
      lower.includes("quality") ||
      lower.includes("input_fidelity");
    const rejectsParameter =
      lower.includes("unknown parameter") ||
      lower.includes("unsupported parameter") ||
      lower.includes("unrecognized parameter") ||
      lower.includes("unrecognized request argument") ||
      lower.includes("unrecognized argument") ||
      lower.includes("invalid parameter") ||
      lower.includes("not supported") ||
      lower.includes("extra input") ||
      lower.includes("unexpected");

    return mentionsExtendedOption && rejectsParameter;
  }

  private assertHttpEndpoint(endpoint: string, label: string): void {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error(`${label} 不是有效 URL：${endpoint}`);
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`${label} 必须以 http:// 或 https:// 开头：${endpoint}`);
    }
  }

  private parseJsonResponse(
    responseText: string,
    context: { provider: string; endpoint: string; status: number; contentType: string }
  ): any {
    try {
      return JSON.parse(responseText);
    } catch {
      const responseKind = responseText.trimStart().startsWith("<") ? "HTML 页面" : "非 JSON 内容";
      throw new Error(
        `${context.provider} 返回了${responseKind}，无法解析图片结果。请检查设置页的接口基础地址是否是图片生成接口，不要填网页地址。` +
          ` 当前 URL: ${context.endpoint}; HTTP ${context.status}; Content-Type: ${context.contentType || "未知"}; ` +
          this.summarizeBody(responseText)
      );
    }
  }

  private async readImageResponse(response: Response, provider: string, endpoint: string): Promise<Buffer> {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("image/")) {
      if (!response.ok) {
        throw new Error(`${provider} 图片接口失败: HTTP ${response.status} ${response.statusText}`);
      }
      return Buffer.from(await response.arrayBuffer());
    }

    const responseText = await response.text();
    if (!response.ok) {
      console.error(`[Topspeed Builder] ${provider} 图片接口失败:`, responseText);
      throw new Error(
        `${provider} 图片接口失败: HTTP ${response.status} ${response.statusText}. ${this.summarizeBody(responseText)}`
      );
    }

    return this.extractImageFromPayload(
      this.parseJsonResponse(responseText, {
        provider,
        endpoint,
        status: response.status,
        contentType
      }),
      provider
    );
  }

  private async extractImageFromPayload(payload: any, provider: string): Promise<Buffer> {
    const image = payload.data?.[0] ?? payload;
    const b64 = image?.b64_json ?? image?.image ?? payload.b64_json ?? payload.image;
    const url = image?.url ?? payload.url;

    if (b64) {
      return Buffer.from(String(b64).replace(/^data:image\/\w+;base64,/, ""), "base64");
    }

    if (url) {
      const imageResponse = await this.fetchWithContext(url, undefined, `${provider} 图片下载`, 120000);
      if (!imageResponse.ok) {
        throw new Error(`下载${provider}图片失败: HTTP ${imageResponse.status} ${imageResponse.statusText}`);
      }
      return Buffer.from(await imageResponse.arrayBuffer());
    }

    throw new Error(`${provider} 响应中没有可解析的图片数据。`);
  }

  private summarizeBody(body: string): string {
    const summary = body.replace(/\s+/g, " ").trim().slice(0, 800);
    return summary ? `响应内容: ${summary}` : "响应正文为空。";
  }

  /** 统一请求入口：生成/下载等耗时请求带明确超时，超时后给出可读错误 */
  private async fetchWithContext(
    input: string,
    init: RequestInit | undefined,
    provider: string,
    timeoutMs = 300000
  ): Promise<Response> {
    try {
      const mergedInit: RequestInit = { ...init };
      if (!mergedInit.signal) {
        mergedInit.signal = AbortSignal.timeout(timeoutMs);
      }
      return await fetch(input, mergedInit);
    } catch (error) {
      const detail = this.describeFetchError(error);
      const abortedBySignal = this.isAbortTimeout(error);
      throw new Error(
        `${provider} 请求失败: ${detail}${abortedBySignal ? `（等待 ${Math.round(timeoutMs / 1000)} 秒无响应，已中止）` : ""}; URL: ${input}`
      );
    }
  }

  private isAbortTimeout(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    const cause = error.cause as { name?: string } | undefined;
    return (
      error.name === "TimeoutError" ||
      error.name === "AbortError" ||
      (cause?.name ?? "").includes("Timeout") ||
      (cause?.name ?? "").includes("Abort")
    );
  }

  private describeFetchError(error: unknown): string {
    if (!(error instanceof Error)) {
      return String(error);
    }

    const cause = error.cause as { name?: string; message?: string; code?: string } | undefined;
    const low = error.message.toLowerCase();
    const isTimeout =
      error.name === "TimeoutError" ||
      error.name === "AbortError" ||
      (cause?.name ?? "").includes("Timeout") ||
      (cause?.name ?? "").includes("Abort") ||
      low.includes("aborted") ||
      low.includes("timed out") ||
      low.includes("timeout");

    const details: string[] = isTimeout
      ? ["网络请求超时或已中止（服务器未在限时内响应）", error.message]
      : [error.message];
    if (cause?.code) {
      details.push(`code=${cause.code}`);
    }
    if (cause?.name || cause?.message) {
      details.push(`cause=${[cause.name, cause.message].filter(Boolean).join(": ")}`);
    }

    return details.join("; ");
  }

  private async fileToBlob(filePath: string): Promise<Blob> {
    const buffer = await fs.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const type = extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : extension === ".webp" ? "image/webp" : "image/png";
    return new Blob([buffer], { type });
  }

  async fetchModels(settings: AppSettings): Promise<string[]> {
    if (!settings.apiBaseUrl.trim()) {
      throw new Error("接口地址为空，请先填写 API Base URL。");
    }

    const root = this.resolveApiRoot(settings.apiBaseUrl);
    const modelsUrl = `${root}/models`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (settings.apiKey.trim()) {
      headers.Authorization = `Bearer ${settings.apiKey.trim()}`;
    }

    try {
      const response = await fetch(modelsUrl, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(15000)
      });

      const responseText = await response.text();
      if (!response.ok) {
        throw new Error(`获取模型列表失败：HTTP ${response.status} ${response.statusText}。${this.summarizeBody(responseText)}`);
      }

      let json: any;
      try {
        json = JSON.parse(responseText);
      } catch {
        throw new Error(
          `获取模型列表返回了非 JSON 数据，请确认接口基础地址是否指向 OpenAI 兼容服务（应能访问 ${modelsUrl}）。${this.summarizeBody(responseText)}`
        );
      }

      const list = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
      const ids = (list as unknown[])
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object") {
            const candidate = (item as { id?: unknown; name?: unknown }).id ?? (item as { name?: unknown }).name;
            return typeof candidate === "string" ? candidate : "";
          }
          return "";
        })
        .filter(Boolean)
        .map(String);

      if (ids.length === 0) {
        throw new Error("接口返回了模型列表，但没有可识别的模型 ID（期望 OpenAI 兼容的 { data: [{ id }] } 结构）。");
      }

      return this.dedupeSorted(ids);
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * 解析图片生成端点，兼容两种填写方式：
   * 1) OpenAI 兼容 Base URL（如 https://ai.gitee.com/v1）→ 自动补全 /images/generations
   *    （带参考图时为 /images/edits），与「拉取模型」对地址的 Base URL 语义保持一致；
   * 2) 完整图片接口地址（路径含 /images 段）→ 原样使用（历史填写方式，向后兼容）；
   * 3) 其它自定义路径（如 /txt2img）→ 视为完整接口地址，原样使用。
   */
  private resolveImageEndpoint(input: string, useReference: boolean): string {
    const raw = input.trim();
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return raw;
    }

    const path = url.pathname.replace(/\/+$/, "").toLowerCase();
    const isExplicitImagePath = path.endsWith("/images") || path.includes("/images/");
    if (isExplicitImagePath) {
      return raw;
    }

    const lastSegment = path.slice(path.lastIndexOf("/") + 1);
    const isVersionRoot = path === "" || lastSegment === "v1" || lastSegment === "v2" || lastSegment === "api";
    if (!isVersionRoot) {
      return raw;
    }

    const root = this.resolveApiRoot(raw);
    return `${root}${useReference ? "/images/edits" : "/images/generations"}`;
  }

  private resolveApiRoot(input: string): string {
    const raw = (input || "").trim();
    if (!raw) {
      throw new Error("接口地址为空，请先填写 API Base URL。");
    }

    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`接口地址不是有效 URL：${raw}`);
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`接口地址必须以 http:// 或 https:// 开头：${raw}`);
    }

    let path = url.pathname.replace(/\/+$/, "");
    path = path
      .replace(/\/images\/generations$/i, "")
      .replace(/\/images\/edits$/i, "")
      .replace(/\/images$/i, "")
      .replace(/\/models$/i, "");

    return `${url.origin}${path}`;
  }

  /** 全量返回接口给定的模型，仅做去重 + 按名称排序，不做任何图片模型过滤 */
  private dedupeSorted(ids: string[]): string[] {
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }

}
