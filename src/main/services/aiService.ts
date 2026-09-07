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

    const endpoint = args.settings.apiBaseUrl.trim();
    this.assertHttpEndpoint(endpoint, "自定义接口基础地址");
    const useReference = (args.referenceImages?.length ?? 0) > 0;

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

    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (settings.apiKey.trim()) {
      headers.Authorization = `Bearer ${settings.apiKey.trim()}`;
    }

    const testBody = JSON.stringify({
      model: settings.model || "gpt-image-1.5",
      prompt: "test",
      n: 0,
      size: "256x256"
    });

    try {
      const response = await fetch(baseUrl, {
        method: "POST",
        headers,
        body: testBody,
        signal: AbortSignal.timeout(15000)
      });

      const responseText = await response.text();
      const detail = `HTTP ${response.status} · ${this.summarizeBody(responseText)}`;

      if (response.ok) {
        return { ok: true, status: response.status, detail };
      }

      if (response.status === 400) {
        return { ok: true, status: response.status, detail: `接口连通，鉴权通过（服务端以 HTTP 400 拒绝了测试参数，无实际图片生成）` };
      }

      if (response.status === 401 || response.status === 403) {
        return { ok: false, status: response.status, detail: `鉴权失败(${response.status})：请检查 API Key 是否正确。${this.summarizeBody(responseText)}` };
      }

      if (response.status === 404) {
        return { ok: false, status: response.status, detail: `接口地址未找到(404)：请检查 API Base URL 路径是否正确。${this.summarizeBody(responseText)}` };
      }

      return { ok: false, status: response.status, detail };
    } catch (error) {
      const message = this.describeFetchError(error);
      if (message.includes("ENOTFOUND") || message.includes("not found") || message.includes("DNS")) {
        return { ok: false, status: 0, detail: `DNS 解析失败：无法找到服务器地址，请检查域名是否正确。 详情: ${message}` };
      }
      if (message.includes("ECONNREFUSED") || message.includes("refused")) {
        return { ok: false, status: 0, detail: `连接被拒绝：服务器拒绝连接，请检查地址和端口是否正确。 详情: ${message}` };
      }
      if (message.includes("timed out") || message.includes("ETIMEDOUT") || message.includes("AbortError")) {
        return { ok: false, status: 0, detail: `连接超时：服务器无响应，请检查网络和 API 地址。 详情: ${message}` };
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
      const form = new FormData();
      form.append("prompt", args.prompt);
      form.append("size", args.size);
      form.append("model", args.settings.model);
      form.append("transparentBackground", String(args.transparentBackground));
      form.append("editIntent", args.editIntent ?? "");
      form.append("referenceStrength", args.referenceStrength ?? "");
      form.append(
        "referenceImages",
        JSON.stringify(
          (args.referenceImages ?? []).map((reference) => ({
            role: reference.role,
            name: reference.name,
            sourceAssetId: reference.sourceAssetId
          }))
        )
      );

      for (const reference of args.referenceImages ?? []) {
        form.append("image", await this.fileToBlob(reference.filePath), path.basename(reference.filePath));
      }

      const response = await this.fetchWithContext(endpoint, {
        method: "POST",
        headers: {
          ...(args.settings.apiKey ? { Authorization: `Bearer ${args.settings.apiKey}` } : {})
        },
        body: form
      }, "自定义接口");

      return this.readImageResponse(response, "自定义接口", endpoint);
    }

    const basePayload: Record<string, unknown> = {
      prompt: args.prompt,
      size: args.size,
      model: args.settings.model,
      transparentBackground: args.transparentBackground
    };

    // 生成质量为可选透传参数；服务端不支持时自动回退为不带 quality 的请求重试
    const withQuality = args.quality ? { ...basePayload, quality: args.quality } : null;
    let response = await this.postJson(endpoint, args.settings.apiKey, withQuality ?? basePayload);

    if (!response.ok && withQuality) {
      const responseText = await response.text();
      if (this.isUnsupportedImageOptionError(response.status, responseText)) {
        response = await this.postJson(endpoint, args.settings.apiKey, basePayload);
      } else {
        throw new Error(
          `图片接口失败: HTTP ${response.status} ${response.statusText}. ${this.summarizeBody(responseText)}`
        );
      }
    }

    return this.readImageResponse(response, "自定义接口", endpoint);
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
      const imageResponse = await this.fetchWithContext(url, undefined, `${provider} 图片下载`);
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

  private async fetchWithContext(input: string, init: RequestInit | undefined, provider: string): Promise<Response> {
    try {
      return await fetch(input, init);
    } catch (error) {
      throw new Error(`${provider} 请求失败: ${this.describeFetchError(error)}; URL: ${input}`);
    }
  }

  private describeFetchError(error: unknown): string {
    if (!(error instanceof Error)) {
      return String(error);
    }

    const cause = error.cause as { name?: string; message?: string; code?: string } | undefined;
    const details = [error.message];
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

      return this.pickImageModels(ids);
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
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

  private pickImageModels(ids: string[]): string[] {
    const pattern =
      /(image|img|dall-e|gpt-image|imagen|flux|stable|sd-|sd3|sdxl|recraft|ideogram|krea|midjourney|wan|sora|emova|kolors|qwen|glm|step|hunyuan|abab|minimax|doubao|spark|moonshot|grok|claude|chatgpt)/i;
    const filtered = ids.filter((id) => pattern.test(id));
    const result = filtered.length > 0 ? filtered : ids;
    return [...new Set(result)].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }

}
