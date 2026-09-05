import path from "node:path";
import fs from "fs-extra";
import sharp from "sharp";
import type { AppSettings, EditIntent, ReferenceImageRole, ReferenceStrength } from "@shared/types";
import { hashString, parseSize } from "./utils";

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
  referenceImages?: ReferenceImagePayload[];
  maskImagePath?: string;
  editIntent?: EditIntent;
  referenceStrength?: ReferenceStrength;
}

export class AIGenerationService {
  async generateImage(args: GenerateImageArgs): Promise<Buffer> {
    if (args.settings.aiProvider === "local-draft") {
      return this.generateLocalDraft(args.prompt, args.size, args.referenceImages);
    }

    if (args.settings.aiProvider === "custom") {
      return this.generateWithCustomProvider(args);
    }

    if ((args.referenceImages?.length ?? 0) > 0 || args.maskImagePath) {
      return this.generateWithOpenAIEdit(args);
    }

    return this.generateWithOpenAI(args);
  }

  async testConnection(settings: AppSettings): Promise<{ ok: boolean; status: number; detail: string }> {
    if (settings.aiProvider === "local-draft") {
      return { ok: true, status: 0, detail: "本地草稿模式无需联网检测。" };
    }

    if (!settings.apiBaseUrl.trim()) {
      return { ok: false, status: 0, detail: "接口地址为空，请先填写 API Base URL。" };
    }

    const baseUrl = settings.apiBaseUrl.trim();
    try {
      this.assertHttpEndpoint(baseUrl, "自定义接口基础地址");
    } catch (err) {
      return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) };
    }

    let testUrl: string;
    let testBody: string | undefined;
    const format = settings.customApiFormat || "openai-image";
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (settings.apiKey.trim()) {
      headers.Authorization = `Bearer ${settings.apiKey.trim()}`;
    }

    if (format === "openai-chat") {
      testUrl = baseUrl;
      testBody = JSON.stringify({
        model: settings.model || "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1
      });
    } else {
      testUrl = baseUrl;
      testBody = JSON.stringify({
        model: settings.model || "gpt-image-1.5",
        prompt: "test",
        n: 0,
        size: "256x256"
      });
    }

    try {
      const response = await fetch(testUrl, {
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

      if (format === "openai-image" && response.status === 400) {
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

  private async generateWithOpenAI(args: GenerateImageArgs): Promise<Buffer> {
    if (!args.settings.apiKey.trim()) {
      throw new Error("OpenAI 接口密钥为空。请在设置页配置接口密钥，或切换到本地草稿模式。");
    }

    const endpoint = this.resolveOpenAIImageEndpoint(args.settings.apiBaseUrl, "generations");
    this.assertHttpEndpoint(endpoint, "OpenAI 接口基础地址");
    const includeExtendedOptions = this.shouldSendOpenAIExtendedOptions(endpoint, args.settings.model);
    const requestPayload = this.buildOpenAIGenerationPayload(args, includeExtendedOptions);

    const response = await this.fetchWithContext(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.settings.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestPayload)
    }, "OpenAI");

    const responseText = await response.text();
    if (!response.ok) {
      console.error("[Topspeed Builder] OpenAI 图片生成失败:", responseText);
      if (includeExtendedOptions && this.isUnsupportedImageOptionError(response.status, responseText)) {
        return this.generateWithOpenAIWithoutExtendedOptions(args, endpoint);
      }

      throw new Error(
        `OpenAI 图片生成失败：HTTP ${response.status} ${response.statusText}. ${this.summarizeBody(responseText)}`
      );
    }

    return this.extractImageFromPayload(
      this.parseJsonResponse(responseText, {
      provider: "OpenAI",
      endpoint,
      status: response.status,
      contentType: response.headers.get("content-type") ?? ""
      }),
      "OpenAI"
    );
  }

  private async generateWithOpenAIEdit(args: GenerateImageArgs): Promise<Buffer> {
    if (!args.settings.apiKey.trim()) {
      throw new Error("OpenAI 接口密钥为空。请在设置页配置接口密钥，或切换到本地草稿模式。");
    }

    const references = args.referenceImages ?? [];
    if (references.length === 0) {
      throw new Error("图生图需要至少一张参考图。");
    }

    const endpoint = this.resolveOpenAIImageEndpoint(args.settings.apiBaseUrl, "edits");
    this.assertHttpEndpoint(endpoint, "OpenAI 接口基础地址");

    const includeExtendedOptions = this.shouldSendOpenAIExtendedOptions(endpoint, args.settings.model);
    const form = await this.buildOpenAIEditForm(args, includeExtendedOptions);

    const response = await this.fetchWithContext(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.settings.apiKey}`
      },
      body: form
    }, "OpenAI");

    if (!response.ok && includeExtendedOptions) {
      const responseText = await response.text();
      if (this.isUnsupportedImageOptionError(response.status, responseText)) {
        return this.generateOpenAIEditWithoutExtendedOptions(args, endpoint);
      }
      throw new Error(
        `OpenAI 图片接口失败: HTTP ${response.status} ${response.statusText}. ${this.summarizeBody(responseText)}`
      );
    }

    return this.readImageResponse(response, "OpenAI", endpoint);
  }

  private async generateWithCustomProvider(args: GenerateImageArgs): Promise<Buffer> {
    if (!args.settings.apiBaseUrl.trim()) {
      throw new Error("自定义接口地址为空。请在设置页配置接口基础地址。");
    }

    const endpoint = args.settings.apiBaseUrl.trim();
    this.assertHttpEndpoint(endpoint, "自定义接口基础地址");
    const format = args.settings.customApiFormat || "openai-image";
    const useReference = (args.referenceImages?.length ?? 0) > 0 || Boolean(args.maskImagePath);

    if (format === "openai-chat") {
      return this.generateWithCustomChatFormat(args, endpoint, useReference);
    }

    return this.generateWithCustomImageFormat(args, endpoint, useReference);
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

      if (args.maskImagePath) {
        form.append("mask", await this.fileToBlob(args.maskImagePath), path.basename(args.maskImagePath));
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

    const requestPayload = {
      prompt: args.prompt,
      size: args.size,
      model: args.settings.model,
      transparentBackground: args.transparentBackground
    };

    const response = await this.fetchWithContext(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(args.settings.apiKey ? { Authorization: `Bearer ${args.settings.apiKey}` } : {})
      },
      body: JSON.stringify(requestPayload)
    }, "自定义接口");

    return this.readImageResponse(response, "自定义接口", endpoint);
  }

  private async generateWithCustomChatFormat(
    args: GenerateImageArgs,
    endpoint: string,
    useReference: boolean
  ): Promise<Buffer> {
    if (useReference) {
      throw new Error(
        "Chat 格式自定义接口暂不支持参考图/蒙版。请在设置页将 API 格式切换为 openai-image，或移除参考图后重试。"
      );
    }

    const payload = {
      model: args.settings.model,
      messages: [
        {
          role: "system",
          content: "You are an image generation AI. Generate an image based on the user's description. Return the image as a URL or base64-encoded data in JSON format."
        },
        {
          role: "user",
          content: args.prompt
        }
      ],
      max_tokens: 4096
    };

    const response = await this.fetchWithContext(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(args.settings.apiKey ? { Authorization: `Bearer ${args.settings.apiKey}` } : {})
      },
      body: JSON.stringify(payload)
    }, "自定义接口");

    const responseText = await response.text();
    if (!response.ok) {
      console.error("[Topspeed Builder] 自定义接口 (chat) 响应异常:", responseText);
      throw new Error(
        `自定义接口失败：HTTP ${response.status} ${response.statusText}。${this.summarizeBody(responseText)}`
      );
    }

    return await this.extractImageFromChatPayload(responseText, endpoint);
  }

  private async extractImageFromChatPayload(responseText: string, endpoint: string): Promise<Buffer> {
    let payload: any;
    try {
      payload = JSON.parse(responseText);
    } catch {
      console.error("[Topspeed Builder] 自定义接口 (chat) 返回非 JSON:", responseText.slice(0, 500));
      throw new Error(
        `自定义接口 (Chat格式) 返回了非 JSON 数据。请检查是否选择了正确的 API 格式（设置页可切换 openai-image / openai-chat）。` +
          ` 当前 URL: ${endpoint}; 响应摘要: ${this.summarizeBody(responseText)}`
      );
    }

    const imageData = payload.data?.[0];
    if (imageData?.url || imageData?.b64_json) {
      const b64 = imageData.b64_json;
      const url = imageData.url ?? payload.url;

      if (b64) {
        return Buffer.from(String(b64).replace(/^data:image\/\w+;base64,/, ""), "base64");
      }

      if (url) {
        this.assertHttpEndpoint(url, "Chat 响应 data[0].url");
        return await this.downloadImageFromUrl(url, endpoint);
      }
    }

    const choice = payload.choices?.[0];
    if (choice) {
      const content = choice.message?.content ?? choice.text ?? "";
      return await this.extractImageFromChatContent(content, endpoint);
    }

    console.error("[Topspeed Builder] 自定义接口 (chat) 无法解析响应:", responseText.slice(0, 500));
    throw new Error(
      `自定义接口 (Chat格式) 响应中无法解析图片数据。请检查 API 格式设置或模型名称。` +
        ` 响应摘要: ${this.summarizeBody(responseText)}`
    );
  }

  private async extractImageFromChatContent(content: string, endpoint: string): Promise<Buffer> {
    const b64Match = content.match(/["']?data:image\/\w+;base64,([A-Za-z0-9+/=]+)["']?/);
    if (b64Match) {
      return Buffer.from(b64Match[1], "base64");
    }

    const urlMatch = content.match(/https?:\/\/[^\s"'<>]+\.(?:png|jpg|jpeg|webp|gif)[^\s"'<>]*/i);
    if (urlMatch) {
      this.assertHttpEndpoint(urlMatch[0], "Chat 响应中提取的图片 URL");
      return await this.downloadImageFromUrl(urlMatch[0], endpoint);
    }

    const genericB64 = content.match(/"([A-Za-z0-9+/=]{100,})"/);
    if (genericB64) {
      try {
        return Buffer.from(genericB64[1], "base64");
      } catch {
      }
    }

    throw new Error(
      `自定义接口 (Chat格式) 返回的文本中未找到图片 URL 或 base64 数据。` +
        ` 内容摘要: ${this.summarizeBody(content)}`
    );
  }

  private async downloadImageFromUrl(url: string, endpoint: string): Promise<Buffer> {
    const imageResponse = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!imageResponse.ok) {
      throw new Error(`下载图片失败: HTTP ${imageResponse.status} ${imageResponse.statusText}, URL: ${url}`);
    }
    return Buffer.from(await imageResponse.arrayBuffer());
  }

  private resolveOpenAIImageEndpoint(input: string, mode: "generations" | "edits"): string {
    const fallback = "https://api.openai.com/v1/images/generations";
    const raw = input.trim() || fallback;
    const url = new URL(raw);
    const path = url.pathname.replace(/\/+$/g, "");

    if (path === "" || path === "/") {
      url.pathname = `/v1/images/${mode}`;
      return url.toString();
    }

    if (path === "/v1") {
      url.pathname = `${path}/images/${mode}`;
      return url.toString();
    }

    if (path.endsWith("/images/generations") || path.endsWith("/images/edits")) {
      url.pathname = path.replace(/\/images\/(?:generations|edits)$/g, `/images/${mode}`);
      return url.toString();
    }

    return url.toString();
  }

  private buildOpenAIGenerationPayload(args: GenerateImageArgs, includeExtendedOptions: boolean): Record<string, unknown> {
    const requestPayload: Record<string, unknown> = {
      model: args.settings.model || "gpt-image-1.5",
      prompt: args.prompt,
      n: 1,
      size: this.mapProviderSize(args.size)
    };

    if (includeExtendedOptions) {
      requestPayload.quality = args.settings.generationQuality;
      requestPayload.background = args.transparentBackground ? "transparent" : "auto";
    }

    return requestPayload;
  }

  private async generateWithOpenAIWithoutExtendedOptions(args: GenerateImageArgs, endpoint: string): Promise<Buffer> {
    const response = await this.fetchWithContext(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.settings.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(this.buildOpenAIGenerationPayload(args, false))
    }, "OpenAI");

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(
        `OpenAI 图片生成失败：HTTP ${response.status} ${response.statusText}. ${this.summarizeBody(responseText)}`
      );
    }

    return this.extractImageFromPayload(
      this.parseJsonResponse(responseText, {
        provider: "OpenAI",
        endpoint,
        status: response.status,
        contentType: response.headers.get("content-type") ?? ""
      }),
      "OpenAI"
    );
  }

  private async buildOpenAIEditForm(args: GenerateImageArgs, includeExtendedOptions: boolean): Promise<FormData> {
    const form = new FormData();
    form.append("model", args.settings.model || "gpt-image-1.5");
    form.append("prompt", args.prompt);
    form.append("n", "1");
    form.append("size", this.mapProviderSize(args.size));

    if (includeExtendedOptions) {
      form.append("quality", args.settings.generationQuality);
      form.append("background", args.transparentBackground ? "transparent" : "auto");
      if (args.referenceStrength === "high") {
        form.append("input_fidelity", "high");
      }
    }

    for (const reference of args.referenceImages ?? []) {
      form.append("image", await this.fileToBlob(reference.filePath), path.basename(reference.filePath));
    }

    if (args.maskImagePath) {
      form.append("mask", await this.fileToBlob(args.maskImagePath), path.basename(args.maskImagePath));
    }

    return form;
  }

  private async generateOpenAIEditWithoutExtendedOptions(args: GenerateImageArgs, endpoint: string): Promise<Buffer> {
    const response = await this.fetchWithContext(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.settings.apiKey}`
      },
      body: await this.buildOpenAIEditForm(args, false)
    }, "OpenAI");

    return this.readImageResponse(response, "OpenAI", endpoint);
  }

  private shouldSendOpenAIExtendedOptions(endpoint: string, model: string): boolean {
    const isGptImageModel = /^gpt-image-/i.test(model || "");
    try {
      return new URL(endpoint).hostname === "api.openai.com" || isGptImageModel;
    } catch {
      return isGptImageModel;
    }
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

  private mapProviderSize(size: string): string {
    const { width, height } = parseSize(size);
    if (width > height) {
      return "1536x1024";
    }
    if (height > width) {
      return "1024x1536";
    }
    return "1024x1024";
  }

  private async fileToBlob(filePath: string): Promise<Blob> {
    const buffer = await fs.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const type = extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : extension === ".webp" ? "image/webp" : "image/png";
    return new Blob([buffer], { type });
  }

  async fetchModels(settings: AppSettings): Promise<string[]> {
    const provider = settings.aiProvider;
    if (provider === "local-draft") {
      return [];
    }

    if (!settings.apiBaseUrl.trim()) {
      throw new Error("接口地址为空，请先填写 API Base URL。");
    }

    const root = this.resolveApiRoot(settings.apiBaseUrl, provider);
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

  private resolveApiRoot(input: string, provider: string): string {
    const fallback = "https://api.openai.com/v1";
    let raw = (input || "").trim();
    if (!raw) {
      raw = provider === "openai" ? fallback : "";
    }
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

  private async generateLocalDraft(prompt: string, size: string, referenceImages?: ReferenceImagePayload[]): Promise<Buffer> {
    const { width, height } = parseSize(size);
    const canvasWidth = Math.max(width, 64);
    const canvasHeight = Math.max(height, 64);
    const hash = hashString(prompt);
    const hue = hash % 360;
    const accentHue = (hue + 127) % 360;
    const shadowHue = (hue + 220) % 360;
    const label = (prompt.match(/名称为：([^。\n]+)/)?.[1] ?? prompt.match(/named ([^\n.]+)/i)?.[1] ?? "草稿").slice(0, 10);

    const blocks = Array.from({ length: 18 }, (_, index) => {
      const x = 10 + ((hash >> (index % 12)) & 31);
      const y = 12 + ((hash >> ((index + 4) % 12)) & 31);
      const blockSize = 4 + ((hash >> (index % 8)) & 7);
      const opacity = 0.45 + (((hash >> (index % 16)) & 7) / 20);
      const color = index % 3 === 0 ? accentHue : index % 3 === 1 ? hue : shadowHue;
      return `<rect x="${x}" y="${y}" width="${blockSize}" height="${blockSize}" fill="hsl(${color}, 72%, 58%)" opacity="${opacity.toFixed(
        2
      )}" />`;
    }).join("");

    const svg = `
      <svg width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
        <rect width="64" height="64" fill="transparent"/>
        <g shape-rendering="crispEdges">
          <rect x="18" y="15" width="28" height="34" rx="4" fill="hsl(${hue}, 60%, 42%)"/>
          <rect x="23" y="10" width="18" height="16" rx="4" fill="hsl(${accentHue}, 68%, 62%)"/>
          <rect x="16" y="36" width="32" height="9" fill="hsl(${shadowHue}, 52%, 32%)"/>
          <rect x="24" y="22" width="5" height="5" fill="#10131a"/>
          <rect x="35" y="22" width="5" height="5" fill="#10131a"/>
          ${blocks}
        </g>
        <text x="32" y="59" text-anchor="middle" font-size="5" font-family="monospace" fill="rgba(255,255,255,.82)">${this.escapeSvg(
          label
        )}</text>
      </svg>
    `;

    const draft = await sharp(Buffer.from(svg)).png().toBuffer();
    const firstReference = referenceImages?.[0];
    if (!firstReference) {
      return draft;
    }

    try {
      const reference = await sharp(firstReference.filePath)
        .ensureAlpha()
        .resize({
          width: canvasWidth,
          height: canvasHeight,
          fit: "contain",
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .modulate({ brightness: 0.92, saturation: 0.75 })
        .png()
        .toBuffer();

      const badge = await sharp(
        Buffer.from(`
          <svg width="${canvasWidth}" height="${canvasHeight}" xmlns="http://www.w3.org/2000/svg">
            <rect x="2" y="2" width="30" height="12" rx="3" fill="rgba(0, 212, 255, .68)"/>
            <text x="17" y="10.5" text-anchor="middle" font-size="7" font-family="monospace" fill="#071013">参考</text>
          </svg>
        `)
      )
        .png()
        .toBuffer();

      return sharp({
        create: {
          width: canvasWidth,
          height: canvasHeight,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        }
      })
        .composite([
          { input: reference, blend: "over" },
          { input: draft, blend: "screen" },
          { input: badge, blend: "over" }
        ])
        .png()
        .toBuffer();
    } catch {
      return draft;
    }
  }

  private escapeSvg(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}
