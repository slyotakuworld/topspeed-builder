"use strict";
const path = require("node:path");
const fs = require("fs-extra");
const electron = require("electron");
const sharp = require("sharp");
const JSZip = require("jszip");
const node_crypto = require("node:crypto");
const fileLocks = /* @__PURE__ */ new Map();
const PROJECT_DIRECTORIES = [
  "generated/raw",
  "generated/processed",
  "sprites/characters",
  "sprites/enemies",
  "icons/items",
  "icons/skills",
  "icons/ui",
  "tilesets",
  "sheets",
  "atlas",
  "exports",
  "history",
  "references/images",
  "references/masks",
  "references/thumbnails"
];
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function sanitizeFileName(value) {
  const cleaned = value.trim().toLowerCase().replace(/['"]/g, "").replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "_").replace(/^_+|_+$/g, "");
  return cleaned || "asset";
}
function parseSize(size) {
  const match = size.match(/(\d+)\s*x\s*(\d+)/i);
  if (!match) {
    return { width: 64, height: 64 };
  }
  return {
    width: Number(match[1]),
    height: Number(match[2])
  };
}
function toRelative(projectPath, filePath) {
  return path.relative(projectPath, filePath).replace(/\\/g, "/");
}
function resolveProjectPath(projectPath, filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(projectPath, filePath);
}
async function ensureProjectDirectories(projectPath) {
  await Promise.all(PROJECT_DIRECTORIES.map((dir) => fs.ensureDir(path.join(projectPath, dir))));
}
async function readJsonFile(filePath, fallback) {
  try {
    if (!await fs.pathExists(filePath)) {
      return fallback;
    }
    return await fs.readJson(filePath);
  } catch {
    return fallback;
  }
}
async function writeJsonFile(filePath, data) {
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeJson(filePath, data, { spaces: 2 });
}
async function withFileLock(filePath, task) {
  const key = path.resolve(filePath).toLowerCase();
  const previous = fileLocks.get(key) ?? Promise.resolve();
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });
  const current = previous.catch(() => void 0).then(() => next);
  fileLocks.set(key, current);
  await previous.catch(() => void 0);
  try {
    return await task();
  } finally {
    release();
    if (fileLocks.get(key) === current) {
      fileLocks.delete(key);
    }
  }
}
function uniqueByPath(items) {
  const seen = /* @__PURE__ */ new Set();
  const output = [];
  for (const item of items) {
    const key = path.normalize(item.path).toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      output.push(item);
    }
  }
  return output;
}
function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return hash >>> 0;
}
class AIGenerationService {
  async generateImage(args) {
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
  async testConnection(settings) {
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
    let testUrl;
    let testBody;
    const format = settings.customApiFormat || "openai-image";
    const headers = {
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
        signal: AbortSignal.timeout(15e3)
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
  buildPrompt(parts) {
    const background = parts.transparentBackground ? "透明背景，主体居中，不要地面阴影，不要文字，不要水印。" : "干净的游戏素材背景。";
    return [
      `生成可直接用于游戏工程的二维${parts.assetType}精灵，名称为：${parts.name}。`,
      `素材描述：${parts.description}。`,
      `美术风格：${parts.style}。`,
      `最终画布尺寸：${parts.size}。`,
      background,
      "轮廓必须清晰可读，比例保持一致，构图只包含当前素材主体。",
      parts.extra ?? ""
    ].filter(Boolean).join("\n");
  }
  async generateWithOpenAI(args) {
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
  async generateWithOpenAIEdit(args) {
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
  async generateWithCustomProvider(args) {
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
  async generateWithCustomImageFormat(args, endpoint, useReference) {
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
      const response2 = await this.fetchWithContext(endpoint, {
        method: "POST",
        headers: {
          ...args.settings.apiKey ? { Authorization: `Bearer ${args.settings.apiKey}` } : {}
        },
        body: form
      }, "自定义接口");
      return this.readImageResponse(response2, "自定义接口", endpoint);
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
        ...args.settings.apiKey ? { Authorization: `Bearer ${args.settings.apiKey}` } : {}
      },
      body: JSON.stringify(requestPayload)
    }, "自定义接口");
    return this.readImageResponse(response, "自定义接口", endpoint);
  }
  async generateWithCustomChatFormat(args, endpoint, useReference) {
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
        ...args.settings.apiKey ? { Authorization: `Bearer ${args.settings.apiKey}` } : {}
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
  async extractImageFromChatPayload(responseText, endpoint) {
    let payload;
    try {
      payload = JSON.parse(responseText);
    } catch {
      console.error("[Topspeed Builder] 自定义接口 (chat) 返回非 JSON:", responseText.slice(0, 500));
      throw new Error(
        `自定义接口 (Chat格式) 返回了非 JSON 数据。请检查是否选择了正确的 API 格式（设置页可切换 openai-image / openai-chat）。 当前 URL: ${endpoint}; 响应摘要: ${this.summarizeBody(responseText)}`
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
      `自定义接口 (Chat格式) 响应中无法解析图片数据。请检查 API 格式设置或模型名称。 响应摘要: ${this.summarizeBody(responseText)}`
    );
  }
  async extractImageFromChatContent(content, endpoint) {
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
      `自定义接口 (Chat格式) 返回的文本中未找到图片 URL 或 base64 数据。 内容摘要: ${this.summarizeBody(content)}`
    );
  }
  async downloadImageFromUrl(url, endpoint) {
    const imageResponse = await fetch(url, { signal: AbortSignal.timeout(3e4) });
    if (!imageResponse.ok) {
      throw new Error(`下载图片失败: HTTP ${imageResponse.status} ${imageResponse.statusText}, URL: ${url}`);
    }
    return Buffer.from(await imageResponse.arrayBuffer());
  }
  resolveOpenAIImageEndpoint(input, mode) {
    const fallback = "https://api.openai.com/v1/images/generations";
    const raw = input.trim() || fallback;
    const url = new URL(raw);
    const path2 = url.pathname.replace(/\/+$/g, "");
    if (path2 === "" || path2 === "/") {
      url.pathname = `/v1/images/${mode}`;
      return url.toString();
    }
    if (path2 === "/v1") {
      url.pathname = `${path2}/images/${mode}`;
      return url.toString();
    }
    if (path2.endsWith("/images/generations") || path2.endsWith("/images/edits")) {
      url.pathname = path2.replace(/\/images\/(?:generations|edits)$/g, `/images/${mode}`);
      return url.toString();
    }
    return url.toString();
  }
  buildOpenAIGenerationPayload(args, includeExtendedOptions) {
    const requestPayload = {
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
  async generateWithOpenAIWithoutExtendedOptions(args, endpoint) {
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
  async buildOpenAIEditForm(args, includeExtendedOptions) {
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
  async generateOpenAIEditWithoutExtendedOptions(args, endpoint) {
    const response = await this.fetchWithContext(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.settings.apiKey}`
      },
      body: await this.buildOpenAIEditForm(args, false)
    }, "OpenAI");
    return this.readImageResponse(response, "OpenAI", endpoint);
  }
  shouldSendOpenAIExtendedOptions(endpoint, model) {
    const isGptImageModel = /^gpt-image-/i.test(model || "");
    try {
      return new URL(endpoint).hostname === "api.openai.com" || isGptImageModel;
    } catch {
      return isGptImageModel;
    }
  }
  isUnsupportedImageOptionError(status, responseText) {
    if (status !== 400 && status !== 422) {
      return false;
    }
    const lower = responseText.toLowerCase();
    const mentionsExtendedOption = lower.includes("background") || lower.includes("quality") || lower.includes("input_fidelity");
    const rejectsParameter = lower.includes("unknown parameter") || lower.includes("unsupported parameter") || lower.includes("unrecognized parameter") || lower.includes("invalid parameter") || lower.includes("not supported") || lower.includes("extra input") || lower.includes("unexpected");
    return mentionsExtendedOption && rejectsParameter;
  }
  assertHttpEndpoint(endpoint, label) {
    let url;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error(`${label} 不是有效 URL：${endpoint}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`${label} 必须以 http:// 或 https:// 开头：${endpoint}`);
    }
  }
  parseJsonResponse(responseText, context) {
    try {
      return JSON.parse(responseText);
    } catch {
      const responseKind = responseText.trimStart().startsWith("<") ? "HTML 页面" : "非 JSON 内容";
      throw new Error(
        `${context.provider} 返回了${responseKind}，无法解析图片结果。请检查设置页的接口基础地址是否是图片生成接口，不要填网页地址。 当前 URL: ${context.endpoint}; HTTP ${context.status}; Content-Type: ${context.contentType || "未知"}; ` + this.summarizeBody(responseText)
      );
    }
  }
  async readImageResponse(response, provider, endpoint) {
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
  async extractImageFromPayload(payload, provider) {
    const image = payload.data?.[0] ?? payload;
    const b64 = image?.b64_json ?? image?.image ?? payload.b64_json ?? payload.image;
    const url = image?.url ?? payload.url;
    if (b64) {
      return Buffer.from(String(b64).replace(/^data:image\/\w+;base64,/, ""), "base64");
    }
    if (url) {
      const imageResponse = await this.fetchWithContext(url, void 0, `${provider} 图片下载`);
      if (!imageResponse.ok) {
        throw new Error(`下载${provider}图片失败: HTTP ${imageResponse.status} ${imageResponse.statusText}`);
      }
      return Buffer.from(await imageResponse.arrayBuffer());
    }
    throw new Error(`${provider} 响应中没有可解析的图片数据。`);
  }
  summarizeBody(body) {
    const summary = body.replace(/\s+/g, " ").trim().slice(0, 800);
    return summary ? `响应内容: ${summary}` : "响应正文为空。";
  }
  async fetchWithContext(input, init, provider) {
    try {
      return await fetch(input, init);
    } catch (error) {
      throw new Error(`${provider} 请求失败: ${this.describeFetchError(error)}; URL: ${input}`);
    }
  }
  describeFetchError(error) {
    if (!(error instanceof Error)) {
      return String(error);
    }
    const cause = error.cause;
    const details = [error.message];
    if (cause?.code) {
      details.push(`code=${cause.code}`);
    }
    if (cause?.name || cause?.message) {
      details.push(`cause=${[cause.name, cause.message].filter(Boolean).join(": ")}`);
    }
    return details.join("; ");
  }
  mapProviderSize(size) {
    const { width, height } = parseSize(size);
    if (width > height) {
      return "1536x1024";
    }
    if (height > width) {
      return "1024x1536";
    }
    return "1024x1024";
  }
  async fileToBlob(filePath) {
    const buffer = await fs.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const type = extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : extension === ".webp" ? "image/webp" : "image/png";
    return new Blob([buffer], { type });
  }
  async fetchModels(settings) {
    const provider = settings.aiProvider;
    if (provider === "local-draft") {
      return [];
    }
    if (!settings.apiBaseUrl.trim()) {
      throw new Error("接口地址为空，请先填写 API Base URL。");
    }
    const root = this.resolveApiRoot(settings.apiBaseUrl, provider);
    const modelsUrl = `${root}/models`;
    const headers = {
      "Content-Type": "application/json"
    };
    if (settings.apiKey.trim()) {
      headers.Authorization = `Bearer ${settings.apiKey.trim()}`;
    }
    try {
      const response = await fetch(modelsUrl, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(15e3)
      });
      const responseText = await response.text();
      if (!response.ok) {
        throw new Error(`获取模型列表失败：HTTP ${response.status} ${response.statusText}。${this.summarizeBody(responseText)}`);
      }
      let json;
      try {
        json = JSON.parse(responseText);
      } catch {
        throw new Error(
          `获取模型列表返回了非 JSON 数据，请确认接口基础地址是否指向 OpenAI 兼容服务（应能访问 ${modelsUrl}）。${this.summarizeBody(responseText)}`
        );
      }
      const list = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
      const ids = list.map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const candidate = item.id ?? item.name;
          return typeof candidate === "string" ? candidate : "";
        }
        return "";
      }).filter(Boolean).map(String);
      if (ids.length === 0) {
        throw new Error("接口返回了模型列表，但没有可识别的模型 ID（期望 OpenAI 兼容的 { data: [{ id }] } 结构）。");
      }
      return this.pickImageModels(ids);
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
  resolveApiRoot(input, provider) {
    const fallback = "https://api.openai.com/v1";
    let raw = (input || "").trim();
    if (!raw) {
      raw = provider === "openai" ? fallback : "";
    }
    if (!raw) {
      throw new Error("接口地址为空，请先填写 API Base URL。");
    }
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`接口地址不是有效 URL：${raw}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`接口地址必须以 http:// 或 https:// 开头：${raw}`);
    }
    let path2 = url.pathname.replace(/\/+$/, "");
    path2 = path2.replace(/\/images\/generations$/i, "").replace(/\/images\/edits$/i, "").replace(/\/images$/i, "").replace(/\/models$/i, "");
    return `${url.origin}${path2}`;
  }
  pickImageModels(ids) {
    const pattern = /(image|img|dall-e|gpt-image|imagen|flux|stable|sd-|sd3|sdxl|recraft|ideogram|krea|midjourney|wan|sora|emova|kolors|qwen|glm|step|hunyuan|abab|minimax|doubao|spark|moonshot|grok|claude|chatgpt)/i;
    const filtered = ids.filter((id) => pattern.test(id));
    const result = filtered.length > 0 ? filtered : ids;
    return [...new Set(result)].sort((a, b) => a.localeCompare(b, void 0, { sensitivity: "base" }));
  }
  async generateLocalDraft(prompt, size, referenceImages) {
    const { width, height } = parseSize(size);
    const canvasWidth = Math.max(width, 64);
    const canvasHeight = Math.max(height, 64);
    const hash = hashString(prompt);
    const hue = hash % 360;
    const accentHue = (hue + 127) % 360;
    const shadowHue = (hue + 220) % 360;
    const label = (prompt.match(/名称为：([^。\n]+)/)?.[1] ?? prompt.match(/named ([^\n.]+)/i)?.[1] ?? "草稿").slice(0, 10);
    const blocks = Array.from({ length: 18 }, (_, index) => {
      const x = 10 + (hash >> index % 12 & 31);
      const y = 12 + (hash >> (index + 4) % 12 & 31);
      const blockSize = 4 + (hash >> index % 8 & 7);
      const opacity = 0.45 + (hash >> index % 16 & 7) / 20;
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
      const reference = await sharp(firstReference.filePath).ensureAlpha().resize({
        width: canvasWidth,
        height: canvasHeight,
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }).modulate({ brightness: 0.92, saturation: 0.75 }).png().toBuffer();
      const badge = await sharp(
        Buffer.from(`
          <svg width="${canvasWidth}" height="${canvasHeight}" xmlns="http://www.w3.org/2000/svg">
            <rect x="2" y="2" width="30" height="12" rx="3" fill="rgba(0, 212, 255, .68)"/>
            <text x="17" y="10.5" text-anchor="middle" font-size="7" font-family="monospace" fill="#071013">参考</text>
          </svg>
        `)
      ).png().toBuffer();
      return sharp({
        create: {
          width: canvasWidth,
          height: canvasHeight,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        }
      }).composite([
        { input: reference, blend: "over" },
        { input: draft, blend: "screen" },
        { input: badge, blend: "over" }
      ]).png().toBuffer();
    } catch {
      return draft;
    }
  }
  escapeSvg(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
}
class AtlasPackingService {
  async pack(args) {
    const padding = args.padding ?? 2;
    const maxWidth = args.maxWidth ?? 1024;
    const images = await Promise.all(
      args.files.map(async (filePath) => {
        const metadata2 = await sharp(filePath).metadata();
        return {
          filePath,
          name: path.basename(filePath),
          width: metadata2.width ?? 1,
          height: metadata2.height ?? 1
        };
      })
    );
    if (images.length === 0) {
      throw new Error("图集打包失败：没有可用 PNG 文件。");
    }
    let x = padding;
    let y = padding;
    let rowHeight = 0;
    let atlasWidth = 0;
    const placements = [];
    for (const image of images) {
      if (x + image.width + padding > maxWidth && x > padding) {
        x = padding;
        y += rowHeight + padding;
        rowHeight = 0;
      }
      placements.push({ ...image, x, y });
      x += image.width + padding;
      rowHeight = Math.max(rowHeight, image.height);
      atlasWidth = Math.max(atlasWidth, x);
    }
    const atlasHeight = y + rowHeight + padding;
    const outputPath = path.join(args.projectPath, "atlas", `${args.name}_atlas.png`);
    const metadataPath = path.join(args.projectPath, "atlas", `${args.name}_atlas.json`);
    await fs.ensureDir(path.dirname(outputPath));
    await sharp({
      create: {
        width: Math.max(atlasWidth, 1),
        height: Math.max(atlasHeight, 1),
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    }).composite(placements.map((item) => ({ input: item.filePath, left: item.x, top: item.y }))).png().toFile(outputPath);
    const metadata = {
      meta: {
        image: toRelative(args.projectPath, outputPath),
        size: { w: atlasWidth, h: atlasHeight },
        padding
      },
      frames: Object.fromEntries(
        placements.map((item) => [
          item.name,
          {
            frame: {
              x: item.x,
              y: item.y,
              w: item.width,
              h: item.height
            }
          }
        ])
      )
    };
    await writeJsonFile(metadataPath, metadata);
    return {
      atlasPath: toRelative(args.projectPath, outputPath),
      metadataPath: toRelative(args.projectPath, metadataPath),
      metadata
    };
  }
}
class ExportService {
  async exportProject(project, input) {
    const exportRoot = path.join(project.path, "exports");
    await fs.ensureDir(exportRoot);
    const targets = input.targets.length > 0 ? input.targets : project.exportTargets;
    const files = [];
    for (const target of targets) {
      const created = await this.exportTarget(project, target);
      files.push(...created);
    }
    let zipPath;
    if (input.includeZip) {
      zipPath = await this.createZip(project.path, exportRoot, targets);
      files.push(zipPath);
    }
    return {
      exportRoot,
      targets,
      files,
      zipPath
    };
  }
  async exportTarget(project, target) {
    const root = path.join(project.path, "exports", target);
    await fs.emptyDir(root);
    const files = [];
    const copy = async (source, destination) => {
      const sourcePath = path.join(project.path, source);
      if (await fs.pathExists(sourcePath)) {
        const destinationPath = path.join(root, destination);
        await fs.copy(sourcePath, destinationPath);
        files.push(destinationPath);
      }
    };
    if (target === "unity") {
      await copy("sprites", "sprites");
      await copy("icons", "sprites/icons");
      await copy("sheets", "sheets");
      await copy("atlas", "atlas");
      const guidePath = path.join(root, "unity_import_guide.md");
      await fs.writeFile(guidePath, this.unityGuide(project), "utf8");
      files.push(guidePath);
    } else if (target === "godot") {
      await copy("sprites", "sprites");
      await copy("icons", "sprites/icons");
      await copy("sheets", "sheets");
      await copy("atlas", "atlas");
      const guidePath = path.join(root, "godot_import_guide.md");
      await fs.writeFile(guidePath, this.godotGuide(project), "utf8");
      files.push(guidePath);
    } else if (target === "tiled") {
      await copy("tilesets", "tilesets");
      const guidePath = path.join(root, "tiled_import_guide.md");
      await fs.writeFile(guidePath, this.tiledGuide(project), "utf8");
      files.push(guidePath);
    } else {
      await copy("icons", "icons");
      await copy("sprites", "sprites");
      await copy("tilesets", "tilesets");
      await copy("sheets", "sheets");
      await copy("atlas", "atlas");
      const guidePath = path.join(root, `${target}_readme.md`);
      await fs.writeFile(guidePath, this.commonGuide(project, target), "utf8");
      files.push(guidePath);
    }
    const metadataPath = path.join(root, "sprites_metadata.json");
    await writeJsonFile(metadataPath, {
      exportedAt: nowIso(),
      target,
      project: {
        id: project.id,
        name: project.name,
        gameType: project.gameType,
        style: project.style,
        defaultResolution: project.defaultResolution
      },
      assets: project.assets
    });
    files.push(metadataPath);
    return files;
  }
  async createZip(projectPath, exportRoot, targets) {
    const zip = new JSZip();
    const zipPath = path.join(exportRoot, `ai_sprite_studio_export_${Date.now()}.zip`);
    zip.file("project.json", await fs.readFile(path.join(projectPath, "project.json")));
    for (const target of targets) {
      const targetRoot = path.join(exportRoot, target);
      if (await fs.pathExists(targetRoot)) {
        await this.addDirectory(zip.folder(target), targetRoot);
      }
    }
    const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    await fs.writeFile(zipPath, buffer);
    return zipPath;
  }
  async addDirectory(zip, directory) {
    const entries = await fs.readdir(directory);
    for (const entry of entries) {
      const absolute = path.join(directory, entry);
      const stats = await fs.stat(absolute);
      if (stats.isDirectory()) {
        await this.addDirectory(zip.folder(entry), absolute);
      } else {
        zip.file(entry, await fs.readFile(absolute));
      }
    }
  }
  unityGuide(project) {
    return `# Unity 导入说明

项目：${project.name}

1. 将本目录中的精灵、精灵表和图集目录拖入 Unity 项目面板。
2. 单张 PNG 的纹理类型设置为精灵，建议每单位像素数使用 ${project.defaultResolution.split("x")[0]}。
3. 精灵表设置为多精灵模式，然后在精灵编辑器中按 ${project.defaultResolution} 网格切分。
4. 图集 PNG 可放入 Unity 精灵图集，JSON 元数据可用于运行时定位帧坐标。
5. 瓦片集 PNG 可导入瓦片调色板；如使用瓦片地图，请按瓦片尺寸创建网格。
`;
  }
  godotGuide(project) {
    return `# Godot 导入说明

项目：${project.name}

1. 将精灵、精灵表和图集目录复制到 Godot 资源目录。
2. 单张 PNG 可直接用于 Sprite2D。
3. 精灵表可在 AnimatedSprite2D 或 SpriteFrames 中按 ${project.defaultResolution} 切分。
4. 图集 JSON 保存了每个帧的坐标和尺寸，可用于 AtlasTexture 或自定义加载器。
5. 瓦片集 PNG 可在瓦片集编辑器中按瓦片尺寸创建地图层。
`;
  }
  tiledGuide(project) {
    return `# Tiled 导入说明

项目：${project.name}

1. 打开瓦片集目录中的预览地图文件。
2. 新建地图时设置瓦片尺寸为 ${project.defaultResolution}。
3. 将瓦片集 PNG 作为瓦片集图片导入。
4. 瓦片集 JSON 包含瓦片类型、坐标和主题信息，可供游戏运行时读取。
`;
  }
  commonGuide(project, target) {
    return `# ${target} 通用资源包

项目：${project.name}

目录包含 PNG 单帧、精灵表、图集、瓦片集和 JSON 元数据。所有路径均为相对路径，适合直接拷贝到二维游戏项目资源目录中。
`;
  }
}
class GenerationService {
  constructor(settingsService2, projectService2, aiService2, imageService2, spriteSheetService2, atlasService2, tileSetService2, historyService2) {
    this.settingsService = settingsService2;
    this.projectService = projectService2;
    this.aiService = aiService2;
    this.imageService = imageService2;
    this.spriteSheetService = spriteSheetService2;
    this.atlasService = atlasService2;
    this.tileSetService = tileSetService2;
    this.historyService = historyService2;
  }
  async generate(input) {
    const project = await this.projectService.openProjectPath(input.projectPath);
    this.validateInput(input);
    if (input.assetType === "character") {
      return this.generateCharacter(project, input);
    }
    if (input.assetType === "tileset") {
      return this.generateTileset(project, input);
    }
    if (input.assetType === "icon" || input.assetType === "item" || input.assetType === "ui") {
      return this.generateIconBatch(project, input);
    }
    return this.generateGeneric(project, input);
  }
  async generateIconBatch(project, input) {
    const logs = [];
    const runId = node_crypto.randomUUID();
    const assetName = sanitizeFileName(input.name || "icons");
    const storageName = this.storageName(assetName, runId);
    const size = parseSize(input.size);
    const itemNames = this.resolveIconNames(input);
    const outputDirectory = input.assetType === "ui" ? "icons/ui" : "icons/items";
    const files = [];
    const absoluteFiles = [];
    const prompts = [];
    const referenceImages = this.resolveReferenceImages(project, input);
    const maskImagePath = this.resolveMaskImagePath(project, input);
    const referenceGuidance = this.buildReferenceGuidance(input);
    for (let index = 0; index < itemNames.length; index += 1) {
      const itemName = itemNames[index];
      const itemSlug = sanitizeFileName(itemName);
      const fileName = `${input.assetType}_${itemSlug}_${String(index).padStart(2, "0")}.png`;
      const rawPath = path.join(project.path, "generated", "raw", runId, fileName);
      const processedPath = path.join(project.path, outputDirectory, storageName, fileName);
      const prompt = this.aiService.buildPrompt({
        assetType: this.assetTypeLabel(input.assetType),
        name: itemName,
        description: `${input.description}。同批次物品列表：${itemNames.join("、")}`,
        style: this.buildStylePrompt(project, input),
        size: input.size,
        transparentBackground: input.transparentBackground,
        extra: [
          "单个居中图标。正交视角的游戏背包素材。与同批次保持一致色板。",
          this.buildSingleSubjectGuidance(input),
          referenceGuidance
        ].filter(Boolean).join(" ")
      });
      prompts.push(prompt);
      try {
        const image = await this.generateWithRetry(prompt, input.size, input.transparentBackground, input, referenceImages, maskImagePath);
        await fs.ensureDir(path.dirname(rawPath));
        await fs.writeFile(rawPath, image);
        logs.push(`保存原始图像: ${rawPath}`);
        await this.imageService.saveProcessedImage(image, processedPath, {
          width: size.width,
          height: size.height,
          transparentBackground: input.transparentBackground,
          trim: true,
          isolateSubject: input.assetType !== "ui"
        });
        logs.push(`保存处理图像: ${processedPath}`);
        files.push(toRelative(project.path, processedPath));
        absoluteFiles.push(processedPath);
      } catch (error) {
        logs.push(`生成失败 ${itemName}: ${this.formatError(error)}`);
      }
    }
    if (files.length === 0) {
      throw new Error(`批量图标生成失败，没有成功输出。日志：${logs.join(" | ")}`);
    }
    let atlasPath;
    let atlasMetadataPath;
    if (input.makeAtlas && absoluteFiles.length > 0) {
      const atlas = await this.atlasService.pack({
        projectPath: project.path,
        name: storageName,
        files: absoluteFiles
      });
      atlasPath = atlas.atlasPath;
      atlasMetadataPath = atlas.metadataPath;
      logs.push(`生成图集: ${path.join(project.path, atlasPath)}`);
    }
    const metadataPath = path.join(project.path, outputDirectory, storageName, `${storageName}_metadata.json`);
    const metadata = {
      name: input.name,
      type: input.assetType,
      style: project.style,
      detailPrompt: this.resolveDetailPrompt(input),
      ...this.buildGenerationMetadata(input),
      size,
      files,
      atlas: atlasPath,
      prompt: prompts.join("\n\n---\n\n"),
      exportTargets: input.exportTargets,
      createdAt: nowIso()
    };
    await writeJsonFile(metadataPath, metadata);
    logs.push(`生成元数据: ${metadataPath}`);
    const asset = this.createAsset(input, {
      id: runId,
      project,
      files,
      metadataPath: toRelative(project.path, metadataPath),
      atlasPath,
      prompt: metadata.prompt
    });
    await this.persistResult(project, input, asset, logs, files, [atlasPath, atlasMetadataPath].filter(Boolean));
    return {
      asset,
      files,
      metadataPath: asset.metadataPath,
      atlasPath,
      logs
    };
  }
  async generateCharacter(project, input) {
    const logs = [];
    const runId = node_crypto.randomUUID();
    const assetName = sanitizeFileName(input.name || "character");
    const storageName = this.storageName(assetName, runId);
    const frameSize = parseSize(input.size);
    const animations = input.animations.length ? input.animations : [
      { name: "待机", frames: 4, fps: 6, loop: true },
      { name: "行走", frames: 4, fps: 8, loop: true },
      { name: "攻击", frames: 4, fps: 10, loop: false }
    ];
    const versionCount = Math.max(input.count, 1);
    const columns = Math.max(...animations.map((animation) => animation.frames), 1);
    const rows = Math.max(animations.length, 1);
    const sheetSize = {
      width: frameSize.width * columns,
      height: frameSize.height * rows
    };
    `${sheetSize.width}x${sheetSize.height}`;
    const frames = [];
    const prompts = [];
    const sourceSheets = [];
    const sheetPaths = [];
    const sheetMetadataPaths = [];
    const diagnostics = [];
    const referenceImages = this.resolveReferenceImages(project, input);
    const maskImagePath = this.resolveMaskImagePath(project, input);
    const referenceGuidance = this.buildReferenceGuidance(input);
    const isCharacterI2I = input.generationMode === "image-to-image" && input.referenceImages.some((ref) => ref.sourceAssetId);
    const sourceAsset = isCharacterI2I ? this.findAssetById(project, input.referenceImages.find((ref) => ref.sourceAssetId).sourceAssetId) : void 0;
    sourceAsset?.prompt ?? "";
    const originalSourceSheets = this.findSourceSheetPaths(sourceAsset, project);
    const resolvedReferences = isCharacterI2I && originalSourceSheets.length > 0 ? originalSourceSheets.map((sheetPath2) => ({ filePath: sheetPath2, role: "subject", path: sheetPath2 })) : referenceImages;
    for (let versionIndex = 0; versionIndex < versionCount; versionIndex += 1) {
      const versionLabel = `v${String(versionIndex + 1).padStart(2, "0")}`;
      const versionOutputName = versionCount > 1 ? `${storageName}_${versionLabel}` : storageName;
      const versionDirectory = path.join(project.path, "sprites", "characters", storageName, versionLabel);
      const baseFileName = `character_${storageName}_${versionLabel}_base.png`;
      const basePath = path.join(versionDirectory, baseFileName);
      const rawBasePath = path.join(project.path, "generated", "raw", runId, baseFileName);
      const basePrompt = this.buildBaseCharacterPrompt(input, project, referenceGuidance);
      prompts.push(basePrompt);
      try {
        const baseImage = await this.generateWithRetry(basePrompt, input.size, input.transparentBackground, input, resolvedReferences, maskImagePath);
        await fs.ensureDir(path.dirname(rawBasePath));
        await fs.writeFile(rawBasePath, baseImage);
        await fs.ensureDir(path.dirname(basePath));
        await fs.writeFile(basePath, baseImage);
        sourceSheets.push(toRelative(project.path, basePath));
        logs.push(`生成基础角色立绘: ${basePath}`);
        const frameReference = [
          { filePath: basePath, path: basePath, role: "subject" }
        ];
        const frameBuffers = [];
        const frameMeta = [];
        for (let rowIndex = 0; rowIndex < animations.length; rowIndex += 1) {
          const animation = animations[rowIndex];
          for (let frameIndex = 0; frameIndex < animation.frames; frameIndex += 1) {
            const fileName = `character_${storageName}_${versionLabel}_${animation.name}_${String(frameIndex).padStart(2, "0")}.png`;
            const processedPath = path.join(versionDirectory, fileName);
            const framePrompt = this.buildCharacterFramePrompt(input, animations, animation, frameIndex);
            prompts.push(framePrompt);
            const frameImage = await this.generateWithRetry(framePrompt, input.size, input.transparentBackground, input, frameReference, maskImagePath);
            frameBuffers.push(frameImage);
            frameMeta.push({ animation, frameIndex, fileName, processedPath });
          }
        }
        const processedFrameBuffers = await this.imageService.normalizeFramesConsistently(
          frameBuffers,
          {
            width: frameSize.width,
            height: frameSize.height,
            transparentBackground: input.transparentBackground,
            trim: false,
            anchor: "center",
            padding: 0,
            removeEdgeArtifacts: true
          }
        );
        const versionFrames = [];
        for (let index = 0; index < frameMeta.length; index += 1) {
          const meta = frameMeta[index];
          await fs.ensureDir(path.dirname(meta.processedPath));
          await fs.writeFile(meta.processedPath, processedFrameBuffers[index]);
          const frame = {
            absolutePath: meta.processedPath,
            relativePath: toRelative(project.path, meta.processedPath),
            name: meta.fileName,
            animation: meta.animation.name,
            frameIndex: meta.frameIndex
          };
          frames.push(frame);
          versionFrames.push(frame);
          const diagnostic = await this.inspectCharacterFrame(meta.processedPath, frameSize);
          diagnostics.push({ ...diagnostic, file: frame.relativePath });
          if (diagnostic.warnings.length > 0) {
            logs.push(`角色帧诊断 ${frame.relativePath}: ${diagnostic.warnings.join("；")}`);
          }
        }
        if (input.makeSpriteSheet && versionFrames.length > 0) {
          const sheet = await this.spriteSheetService.createSpriteSheet({
            projectPath: project.path,
            outputName: versionOutputName,
            frames: versionFrames.map((frame) => ({
              filePath: frame.absolutePath,
              name: frame.name,
              animation: frame.animation,
              frameIndex: frame.frameIndex
            })),
            animations,
            size: input.size
          });
          sheetPaths.push(sheet.sheetPath);
          sheetMetadataPaths.push(sheet.metadataPath);
          logs.push(`生成精灵表: ${path.join(project.path, sheet.sheetPath)}`);
        }
      } catch (error) {
        logs.push(`角色版本失败 ${versionLabel}: ${this.formatError(error)}`);
      }
    }
    if (frames.length === 0) {
      throw new Error(`角色序列帧生成失败，没有成功输出。日志：${logs.join(" | ")}`);
    }
    const sheetPath = sheetPaths[0];
    const files = frames.map((frame) => frame.relativePath);
    const metadataPath = path.join(project.path, "sprites", "characters", storageName, `${storageName}_metadata.json`);
    await writeJsonFile(metadataPath, {
      name: input.name,
      type: "character",
      style: project.style,
      detailPrompt: this.resolveDetailPrompt(input),
      ...this.buildGenerationMetadata(input),
      generationStrategy: "character-frame-reference",
      characterVersions: versionCount,
      sheetGrid: {
        columns,
        rows,
        frameSize,
        sheetSize
      },
      sourceSheets,
      diagnostics,
      size: frameSize,
      files,
      sheet: sheetPath,
      sheets: sheetPaths,
      sheetMetadata: sheetMetadataPaths[0],
      sheetMetadataFiles: sheetMetadataPaths,
      animations,
      prompt: prompts.join("\n\n---\n\n"),
      exportTargets: input.exportTargets,
      createdAt: nowIso()
    });
    const asset = this.createAsset(input, {
      id: runId,
      project,
      files: [...files, ...sourceSheets, ...sheetPaths].filter(Boolean),
      metadataPath: toRelative(project.path, metadataPath),
      sheetPath,
      prompt: prompts.join("\n\n---\n\n")
    });
    await this.persistResult(
      project,
      input,
      asset,
      logs,
      files,
      [...sourceSheets, ...sheetPaths, ...sheetMetadataPaths, toRelative(project.path, metadataPath)].filter(Boolean)
    );
    return {
      asset,
      files,
      metadataPath: asset.metadataPath,
      sheetPath,
      logs
    };
  }
  buildCharacterSheetGuidance(input, animations, columns, rows) {
    const rowPlan = animations.map((animation, index) => `第 ${index + 1} 行：${animation.name}，从左到右 ${animation.frames} 帧。`).join(" ");
    return [
      "请生成一张完整的角色动作表，不要生成单张角色插图。",
      `固定网格布局为 ${columns} 列 x ${rows} 行，每个格子是一帧。`,
      rowPlan,
      this.buildAnimationContinuityGuidance(animations),
      "整张图必须是清晰的游戏精灵动作表：每格边界在构图上严格等宽等高，但不要画可见网格线。",
      "Keep 15-20% transparent safe padding inside every cell; no body part, weapon, cape, projectile, or magic effect may touch or cross a cell edge.",
      "If the provider canvas is not exactly the grid aspect ratio, keep the whole grid centered with equal transparent outer margins and mathematically even rows and columns.",
      `角色视角：${this.characterViewLabel(input.characterView)}。`,
      `严格遵守角色名称和素材描述：${input.name || "角色"}；${input.description || "按用户描述"}。不得替换职业、性别、物种、主装备或体型；描述是人形角色时，不要改成动物、怪物、吉祥物或抽象生物。`,
      "所有格子必须是同一个角色：同一脸型、发型、服装、道具、身高比例、色板和轮廓。",
      "每个格子只允许出现一个角色姿势，角色要居中，脚底基线一致，大小一致。",
      "不要文字、不要标签、不要边框、不要网格线、不要额外装饰、不要多个角色。",
      "不要把整套小图压进某一个格子；整张输出本身就是动作表。"
    ].filter(Boolean).join(" ");
  }
  buildAnimationContinuityGuidance(animations) {
    const rowRules = animations.map((animation) => {
      const name = animation.name.toLowerCase();
      if (name.includes("走") || name.includes("walk") || name.includes("run") || name.includes("跑")) {
        return `${animation.name} 行必须是连续步行动画：从左到右依次为左脚接触、过渡、右脚接触、过渡；双脚和武器位置必须逐帧推进，不要每帧都保持同一只脚在前。`;
      }
      if (name.includes("攻") || name.includes("attack") || name.includes("slash") || name.includes("hit")) {
        return `${animation.name} 行必须是连续攻击动画：从左到右依次为蓄力、挥出、命中/最大伸展、收招；武器轨迹必须逐帧推进，不要生成互不相干的姿势。`;
      }
      if (name.includes("待") || name.includes("idle")) {
        return `${animation.name} 行必须是连续待机循环：只做轻微呼吸、重心或手臂变化，不要突然改变体型、朝向或装备。`;
      }
      return `${animation.name} 行必须表现同一个动作时间线的连续关键帧，相邻帧只做渐进变化。`;
    });
    return [
      "动画连续性硬约束：每一行都是同一动作的时间序列，不是独立姿势合集。",
      "同一行从左到右必须能直接播放成循环或一次性动作；角色朝向、身高、脚底基线、装备和轮廓比例保持一致。",
      ...rowRules
    ].join(" ");
  }
  /**
   * 方法1 - 基础角色立绘提示词：生成一张干净的单帧角色正面站姿立绘，
   * 作为后续逐帧图生图的身份参考锚。
   */
  buildBaseCharacterPrompt(input, project, referenceGuidance) {
    return this.aiService.buildPrompt({
      assetType: "角色基础立绘",
      name: input.name || "角色",
      description: input.description,
      style: this.buildStylePrompt(project, input),
      size: input.size,
      transparentBackground: input.transparentBackground,
      extra: [
        "只生成一个角色的单张正面站姿立绘，不要生成动作表、不要生成网格、不要生成多帧。",
        `角色视角：${this.characterViewLabel(input.characterView)}。`,
        `严格遵守角色名称和素材描述：${input.name || "角色"}；${input.description || "按用户描述"}。不得替换职业、性别、物种、主装备或体型；描述是人形角色时，不要改成动物、怪物、吉祥物或抽象生物。`,
        "角色居中、全身可见、脚底靠近画布底部、留 15-20% 安全区不要贴边。",
        "不要文字、不要标签、不要边框、不要网格线、不要多个角色、不要装饰。",
        referenceGuidance
      ].filter(Boolean).join(" ")
    });
  }
  /**
   * 方法1 - 逐帧动作提示词：为指定动画的指定帧序号生成单帧图，
   * 配合基础立绘参考图做图生图以保证身份一致。
   */
  buildCharacterFramePrompt(input, animations, animation, frameIndex) {
    const totalFrames = animation.frames;
    const progress = totalFrames > 1 ? `${frameIndex + 1}/${totalFrames}` : "1/1";
    const name = animation.name.toLowerCase();
    let poseDesc = "";
    if (name.includes("待") || name.includes("idle")) {
      poseDesc = `待机呼吸动画第 ${progress} 帧：身体仅做轻微起伏或重心微移，不要改变朝向、体型或装备。`;
    } else if (name.includes("走") || name.includes("walk") || name.includes("run") || name.includes("跑")) {
      const steps = ["左脚接触地面", "过渡姿态", "右脚接触地面", "过渡姿态"];
      poseDesc = `行走动画第 ${progress} 帧：${steps[frameIndex % steps.length]}，双脚和武器位置必须逐帧推进。`;
    } else if (name.includes("攻") || name.includes("attack") || name.includes("slash") || name.includes("hit")) {
      const phases = ["蓄力准备", "挥出攻击", "命中/最大伸展", "收招回位"];
      poseDesc = `攻击动画第 ${progress} 帧：${phases[frameIndex % phases.length]}，武器轨迹必须逐帧推进。`;
    } else {
      poseDesc = `${animation.name} 动画第 ${progress} 帧：表现该动作时间线上的一个连续关键帧。`;
    }
    return [
      `基于参考图中的角色，生成其「${animation.name}」动作的第 ${frameIndex + 1} 帧（共 ${totalFrames} 帧）。`,
      poseDesc,
      "必须保持与参考图完全一致的角色身份：同一脸型、发型、服装、道具、身高比例、色板和轮廓。",
      `角色视角：${this.characterViewLabel(input.characterView)}。`,
      "角色居中、脚底基线一致、大小一致，留 15-20% 安全区不要贴边。",
      "只生成这一帧，不要生成多帧、不要生成动作表、不要生成网格。",
      "不要文字、不要标签、不要边框、不要多个角色。"
    ].filter(Boolean).join(" ");
  }
  async normalizeCharacterSheet(input, size, grid) {
    const sheet = grid.transparentBackground ? await this.imageService.removeBackground(input) : await sharp(input).ensureAlpha().png().toBuffer();
    const crop = await this.detectCharacterSheetCrop(sheet, grid.columns, grid.rows);
    let pipeline = sharp(sheet).ensureAlpha();
    if (crop) {
      pipeline = pipeline.extract(crop);
    }
    const normalized = await pipeline.resize({
      width: size.width,
      height: size.height,
      fit: "fill",
      kernel: sharp.kernel.nearest
    }).png().toBuffer();
    const minimumForegroundPixels = Math.max(32, Math.floor(size.width * size.height * 2e-3));
    if (await this.countVisibleAlphaPixels(normalized) >= minimumForegroundPixels) {
      return normalized;
    }
    return sharp(input).ensureAlpha().resize({
      width: size.width,
      height: size.height,
      fit: "fill",
      kernel: sharp.kernel.nearest
    }).png().toBuffer();
  }
  async countVisibleAlphaPixels(input, threshold = 12) {
    const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    const totalPixels = info.width * info.height;
    let alphaPixels = 0;
    for (let index = 0; index < totalPixels; index += 1) {
      if (data[index * channels + 3] > threshold) {
        alphaPixels += 1;
      }
    }
    return alphaPixels;
  }
  async detectCharacterSheetCrop(sheet, columns, rows) {
    const { data, info } = await sharp(sheet).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    const totalPixels = info.width * info.height;
    const xWeights = new Float64Array(info.width);
    const yWeights = new Float64Array(info.height);
    let foregroundPixels = 0;
    let minX = info.width;
    let minY = info.height;
    let maxX = -1;
    let maxY = -1;
    for (let index = 0; index < totalPixels; index += 1) {
      const alpha = data[index * channels + 3];
      if (alpha <= 12) continue;
      const x = index % info.width;
      const y = Math.floor(index / info.width);
      xWeights[x] += 1;
      yWeights[y] += 1;
      foregroundPixels += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    const minimumForegroundPixels = Math.max(32, Math.floor(totalPixels * 2e-3));
    if (foregroundPixels < minimumForegroundPixels || maxX < minX || maxY < minY) {
      return void 0;
    }
    const safeColumns = Math.max(1, columns);
    const safeRows = Math.max(1, rows);
    const xBounds = this.inferGridAxisBounds(xWeights, safeColumns, minX, maxX);
    const yBounds = this.inferGridAxisBounds(yWeights, safeRows, minY, maxY);
    const targetAspect = safeColumns / safeRows;
    const rect = this.expandRectToAspect({
      left: xBounds?.start ?? minX,
      top: yBounds?.start ?? minY,
      right: xBounds?.end ?? maxX + 1,
      bottom: yBounds?.end ?? maxY + 1
    }, targetAspect, info.width, info.height);
    return this.toIntegerCropRect(rect, info.width, info.height);
  }
  inferGridAxisBounds(weights, expectedCells, foregroundMin, foregroundMax) {
    const clusters = this.weightedKMeans1D(weights, expectedCells, foregroundMin, foregroundMax);
    if (!clusters) return void 0;
    const meaningfulWeight = Math.max(1, clusters.totalWeight / Math.max(expectedCells * 12, 1));
    const meaningfulClusters = clusters.totals.filter((weight) => weight >= meaningfulWeight).length;
    if (meaningfulClusters < expectedCells) {
      return void 0;
    }
    const gaps = [];
    for (let index = 1; index < clusters.centers.length; index += 1) {
      gaps.push(clusters.centers[index] - clusters.centers[index - 1]);
    }
    const medianGap = this.median(gaps);
    if (!medianGap || medianGap <= 0) {
      return void 0;
    }
    const hasUnstableGap = gaps.some((gap) => gap < medianGap * 0.45 || gap > medianGap * 1.8);
    if (hasUnstableGap) {
      return void 0;
    }
    const start = Math.min(clusters.centers[0] - medianGap / 2, foregroundMin);
    const end = Math.max(clusters.centers[clusters.centers.length - 1] + medianGap / 2, foregroundMax + 1);
    return { start, end };
  }
  weightedKMeans1D(weights, expectedClusters, min, max) {
    if (expectedClusters <= 0 || max < min) return void 0;
    let totalWeight = 0;
    for (let value = min; value <= max; value += 1) {
      totalWeight += weights[value];
    }
    if (totalWeight <= 0) return void 0;
    const span = max - min + 1;
    const centers = Array.from({ length: expectedClusters }, (_, index) => min + (index + 0.5) * span / expectedClusters);
    for (let iteration = 0; iteration < 30; iteration += 1) {
      const sums = new Array(expectedClusters).fill(0);
      const totals = new Array(expectedClusters).fill(0);
      for (let value = min; value <= max; value += 1) {
        const weight = weights[value];
        if (weight <= 0) continue;
        const clusterIndex = this.closestCenterIndex(value, centers);
        sums[clusterIndex] += value * weight;
        totals[clusterIndex] += weight;
      }
      let changed = false;
      for (let index = 0; index < expectedClusters; index += 1) {
        if (totals[index] <= 0) continue;
        const nextCenter = sums[index] / totals[index];
        if (Math.abs(nextCenter - centers[index]) > 0.25) {
          changed = true;
        }
        centers[index] = nextCenter;
      }
      centers.sort((a, b) => a - b);
      if (!changed) break;
    }
    const finalTotals = new Array(expectedClusters).fill(0);
    for (let value = min; value <= max; value += 1) {
      const weight = weights[value];
      if (weight <= 0) continue;
      finalTotals[this.closestCenterIndex(value, centers)] += weight;
    }
    return { centers, totals: finalTotals, totalWeight };
  }
  closestCenterIndex(value, centers) {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < centers.length; index += 1) {
      const distance = Math.abs(value - centers[index]);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    return bestIndex;
  }
  median(values) {
    if (values.length === 0) return void 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }
  expandRectToAspect(rect, aspect, imageWidth, imageHeight) {
    let { left, top, right, bottom } = rect;
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);
    if (width / height < aspect) {
      const targetWidth = height * aspect;
      const offset = (targetWidth - width) / 2;
      left -= offset;
      right += offset;
    } else {
      const targetHeight = width / aspect;
      const offset = (targetHeight - height) / 2;
      top -= offset;
      bottom += offset;
    }
    if (left < 0) {
      right -= left;
      left = 0;
    }
    if (top < 0) {
      bottom -= top;
      top = 0;
    }
    if (right > imageWidth) {
      left -= right - imageWidth;
      right = imageWidth;
    }
    if (bottom > imageHeight) {
      top -= bottom - imageHeight;
      bottom = imageHeight;
    }
    return {
      left: Math.max(0, left),
      top: Math.max(0, top),
      right: Math.min(imageWidth, right),
      bottom: Math.min(imageHeight, bottom)
    };
  }
  toIntegerCropRect(rect, imageWidth, imageHeight) {
    const left = Math.max(0, Math.min(imageWidth - 1, Math.floor(rect.left)));
    const top = Math.max(0, Math.min(imageHeight - 1, Math.floor(rect.top)));
    const right = Math.max(left + 1, Math.min(imageWidth, Math.ceil(rect.right)));
    const bottom = Math.max(top + 1, Math.min(imageHeight, Math.ceil(rect.bottom)));
    const width = right - left;
    const height = bottom - top;
    if (width < 2 || height < 2) {
      return void 0;
    }
    return { left, top, width, height };
  }
  async extractCharacterFrame(sheet, args) {
    const metadata = await sharp(sheet).metadata();
    const width = metadata.width ?? args.frameSize.width * args.columns;
    const height = metadata.height ?? args.frameSize.height * args.rows;
    const cellWidth = width / args.columns;
    const cellHeight = height / args.rows;
    const left = Math.max(0, Math.floor(args.frameIndex * cellWidth));
    const top = Math.max(0, Math.floor(args.rowIndex * cellHeight));
    const right = Math.min(width, Math.ceil((args.frameIndex + 1) * cellWidth));
    const bottom = Math.min(height, Math.ceil((args.rowIndex + 1) * cellHeight));
    return sharp(sheet).ensureAlpha().extract({
      left,
      top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top)
    }).png().toBuffer();
  }
  async inspectCharacterFrame(filePath, expectedSize) {
    const { data, info } = await sharp(filePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    const total = info.width * info.height;
    const mask = new Uint8Array(total);
    let alphaPixels = 0;
    let minX = info.width;
    let minY = info.height;
    let maxX = -1;
    let maxY = -1;
    for (let index = 0; index < total; index += 1) {
      const alpha = data[index * channels + 3];
      if (alpha > 12) {
        mask[index] = 1;
        alphaPixels += 1;
        const x = index % info.width;
        const y = Math.floor(index / info.width);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    const alphaRatio = total > 0 ? alphaPixels / total : 0;
    const warnings = [];
    if (alphaPixels === 0) {
      warnings.push("空白帧");
    }
    if (alphaRatio > 0 && alphaRatio < 0.015) {
      warnings.push("主体过小，疑似整套图被压缩进单帧或生成失败");
    }
    if (alphaRatio > 0.78) {
      warnings.push("透明区域过少，疑似背景未清理或整格被填满");
    }
    const bboxWidth = maxX >= minX ? maxX - minX + 1 : 0;
    const bboxHeight = maxY >= minY ? maxY - minY + 1 : 0;
    const edgeMargin = Math.max(1, Math.floor(Math.min(expectedSize.width, expectedSize.height) * 0.03));
    if (alphaPixels > 0 && (minX <= edgeMargin || minY <= edgeMargin || maxX >= info.width - 1 - edgeMargin || maxY >= info.height - 1 - edgeMargin)) {
      warnings.push("主体贴近帧边缘，可能存在切割残缺");
    }
    if (bboxWidth > expectedSize.width * 0.94 && bboxHeight > expectedSize.height * 0.94 && alphaRatio > 0.45) {
      warnings.push("主体占满整格，疑似多状态套图或背景占用");
    }
    const largeComponents = this.countLargeAlphaComponents(mask, info.width, info.height, Math.max(32, Math.floor(total * 0.055)));
    if (largeComponents > 2) {
      warnings.push("检测到多个分离主体，疑似一格多角色");
    }
    return {
      alphaRatio: Number(alphaRatio.toFixed(4)),
      largeComponents,
      warnings
    };
  }
  countLargeAlphaComponents(mask, width, height, minPixels) {
    const visited = new Uint8Array(mask.length);
    const stack = [];
    let largeComponents = 0;
    for (let start = 0; start < mask.length; start += 1) {
      if (!mask[start] || visited[start]) continue;
      let size = 0;
      visited[start] = 1;
      stack.push(start);
      while (stack.length > 0) {
        const index = stack.pop();
        size += 1;
        const x = index % width;
        const y = Math.floor(index / width);
        const neighbors = [
          x > 0 ? index - 1 : -1,
          x < width - 1 ? index + 1 : -1,
          y > 0 ? index - width : -1,
          y < height - 1 ? index + width : -1
        ];
        for (const next of neighbors) {
          if (next < 0 || !mask[next] || visited[next]) continue;
          visited[next] = 1;
          stack.push(next);
        }
      }
      if (size >= minPixels) {
        largeComponents += 1;
      }
    }
    return largeComponents;
  }
  async generateTileset(project, input) {
    const logs = [];
    const runId = node_crypto.randomUUID();
    const assetName = sanitizeFileName(input.name || input.tileTheme || "瓦片集");
    const storageName = this.storageName(assetName, runId);
    const size = parseSize(input.size);
    const tileTypes = input.tileTypes.length ? input.tileTypes : ["地板", "墙体", "转角", "边缘", "门", "水面"];
    const tiles = [];
    const files = [];
    const prompts = [];
    const referenceImages = this.resolveReferenceImages(project, input);
    const maskImagePath = this.resolveMaskImagePath(project, input);
    const referenceGuidance = this.buildReferenceGuidance(input);
    for (let index = 0; index < tileTypes.length; index += 1) {
      const tileType = tileTypes[index];
      const tileSlug = sanitizeFileName(tileType);
      const fileName = `tileset_${storageName}_${tileSlug}_${String(index).padStart(2, "0")}.png`;
      const rawPath = path.join(project.path, "generated", "raw", runId, fileName);
      const processedPath = path.join(project.path, "tilesets", storageName, fileName);
      const prompt = this.aiService.buildPrompt({
        assetType: "瓦片集瓦片",
        name: tileType,
        description: `${input.tileTheme || input.description} ${tileType}`,
        style: this.buildStylePrompt(project, input),
        size: input.size,
        transparentBackground: false,
        extra: [
          "俯视角瓦片。不要透视镜头。铺满整个瓦片画布。",
          input.tileSeamless ? "边缘应尽量可重复、可平铺。" : "",
          `该瓦片属于同一组「${assetName}」瓦片集。`,
          referenceGuidance
        ].join(" ")
      });
      prompts.push(prompt);
      try {
        const image = await this.generateWithRetry(prompt, input.size, false, input, referenceImages, maskImagePath);
        await fs.ensureDir(path.dirname(rawPath));
        await fs.writeFile(rawPath, image);
        await this.imageService.saveProcessedImage(image, processedPath, {
          width: size.width,
          height: size.height,
          transparentBackground: false,
          trim: false
        });
        tiles.push({ filePath: processedPath, type: tileType });
        files.push(toRelative(project.path, processedPath));
        logs.push(`生成瓦片: ${processedPath}`);
      } catch (error) {
        logs.push(`瓦片失败 ${tileType}: ${this.formatError(error)}`);
      }
    }
    if (tiles.length === 0) {
      throw new Error(`瓦片集生成失败，没有成功输出。日志：${logs.join(" | ")}`);
    }
    const tileset = await this.tileSetService.composeTileSet({
      projectPath: project.path,
      name: storageName,
      tiles,
      size: input.size,
      theme: input.tileTheme,
      seamless: input.tileSeamless
    });
    await this.appendGenerationMetadata(path.join(project.path, tileset.metadataPath), input);
    logs.push(`生成瓦片集: ${path.join(project.path, tileset.tilesetPath)}`);
    logs.push(`生成 Tiled 地图文件: ${path.join(project.path, tileset.tmxPath)}`);
    const asset = this.createAsset(input, {
      id: runId,
      project,
      files: [...files, tileset.tilesetPath, tileset.previewPath, tileset.tmxPath],
      metadataPath: tileset.metadataPath,
      prompt: prompts.join("\n\n---\n\n")
    });
    await this.persistResult(
      project,
      input,
      asset,
      logs,
      files,
      [tileset.tilesetPath, tileset.metadataPath, tileset.previewPath, tileset.tmxPath]
    );
    return {
      asset,
      files,
      metadataPath: tileset.metadataPath,
      previewPath: tileset.previewPath,
      tmxPath: tileset.tmxPath,
      logs
    };
  }
  async generateGeneric(project, input) {
    const logs = [];
    const runId = node_crypto.randomUUID();
    const assetName = sanitizeFileName(input.name || input.assetType);
    const storageName = this.storageName(assetName, runId);
    const size = parseSize(input.size);
    const files = [];
    const absoluteFiles = [];
    const prompts = [];
    const referenceImages = this.resolveReferenceImages(project, input);
    const maskImagePath = this.resolveMaskImagePath(project, input);
    const referenceGuidance = this.buildReferenceGuidance(input);
    for (let index = 0; index < Math.max(input.count, 1); index += 1) {
      const fileName = `${input.assetType}_${assetName}_${String(index).padStart(2, "0")}.png`;
      const rawPath = path.join(project.path, "generated", "raw", runId, fileName);
      const processedPath = path.join(project.path, "generated", "processed", storageName, fileName);
      const prompt = this.aiService.buildPrompt({
        assetType: this.assetTypeLabel(input.assetType),
        name: input.name,
        description: input.description,
        style: this.buildStylePrompt(project, input),
        size: input.size,
        transparentBackground: input.transparentBackground,
        extra: ["可直接复用的游戏二维素材。", this.buildSingleSubjectGuidance(input), referenceGuidance].filter(Boolean).join(" ")
      });
      prompts.push(prompt);
      try {
        const image = await this.generateWithRetry(prompt, input.size, input.transparentBackground, input, referenceImages, maskImagePath);
        await fs.ensureDir(path.dirname(rawPath));
        await fs.writeFile(rawPath, image);
        await this.imageService.saveProcessedImage(image, processedPath, {
          width: size.width,
          height: size.height,
          transparentBackground: input.transparentBackground,
          trim: true,
          isolateSubject: this.shouldIsolateSingleSubject(input)
        });
        files.push(toRelative(project.path, processedPath));
        absoluteFiles.push(processedPath);
        logs.push(`生成素材: ${processedPath}`);
      } catch (error) {
        logs.push(`素材失败 #${index}: ${this.formatError(error)}`);
      }
    }
    if (files.length === 0) {
      throw new Error(`素材生成失败，没有成功输出。日志：${logs.join(" | ")}`);
    }
    let atlasPath;
    if (input.makeAtlas && absoluteFiles.length > 1) {
      const atlas = await this.atlasService.pack({
        projectPath: project.path,
        name: storageName,
        files: absoluteFiles
      });
      atlasPath = atlas.atlasPath;
      logs.push(`生成图集: ${path.join(project.path, atlasPath)}`);
    }
    const metadataPath = path.join(project.path, "generated", "processed", storageName, `${storageName}_metadata.json`);
    await writeJsonFile(metadataPath, {
      name: input.name,
      type: input.assetType,
      style: project.style,
      detailPrompt: this.resolveDetailPrompt(input),
      ...this.buildGenerationMetadata(input),
      size,
      files,
      atlas: atlasPath,
      prompt: prompts.join("\n\n---\n\n"),
      exportTargets: input.exportTargets,
      createdAt: nowIso()
    });
    const asset = this.createAsset(input, {
      id: runId,
      project,
      files,
      metadataPath: toRelative(project.path, metadataPath),
      atlasPath,
      prompt: prompts.join("\n\n---\n\n")
    });
    await this.persistResult(project, input, asset, logs, files, [atlasPath].filter(Boolean));
    return {
      asset,
      files,
      metadataPath: asset.metadataPath,
      atlasPath,
      logs
    };
  }
  async generateWithRetry(prompt, size, transparentBackground, input, referenceImages, maskImagePath) {
    const settings = await this.settingsService.getSettings();
    if (settings.aiProvider === "local-draft") {
      return this.aiService.generateImage({
        prompt,
        size,
        transparentBackground,
        settings,
        referenceImages,
        maskImagePath,
        editIntent: input.editIntent,
        referenceStrength: input.referenceStrength
      });
    }
    let lastError;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        return await this.aiService.generateImage({
          prompt,
          size,
          transparentBackground,
          settings,
          referenceImages,
          maskImagePath,
          editIntent: input.editIntent,
          referenceStrength: input.referenceStrength
        });
      } catch (error) {
        lastError = error;
        if (!this.isRetriableImageError(error)) {
          throw error;
        }
        if (attempt < 4) {
          await this.sleep(this.isRateLimitError(error) ? 8e3 * attempt : 3e3 * attempt);
        }
      }
    }
    if (this.isRateLimitError(lastError)) {
      throw new Error(`图片生成接口连续限流，已重试 4 次但没有成功；不会生成本地假图。最后错误：${this.formatError(lastError)}`);
    }
    if (this.isTransientImageError(lastError)) {
      throw new Error(`图片生成请求连续网络失败，已重试 4 次但没有成功。最后错误：${this.formatError(lastError)}`);
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  resolveIconNames(input) {
    if (input.iconItems.length > 0) {
      return input.iconItems.slice(0, Math.max(input.count, 1));
    }
    return Array.from({ length: Math.max(input.count, 1) }, (_, index) => `${input.name || "icon"} ${index + 1}`);
  }
  storageName(assetName, runId) {
    return `${assetName}_${runId.slice(0, 8)}`;
  }
  isRateLimitError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("HTTP 429") || message.toLowerCase().includes("too many requests");
  }
  isRetriableImageError(error) {
    return this.isRateLimitError(error) || this.isTransientImageError(error);
  }
  isTransientImageError(error) {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    return lower.includes("fetch failed") || lower.includes("network") || lower.includes("timeout") || lower.includes("econnreset") || lower.includes("etimedout") || lower.includes("und_err_connect_timeout") || message.includes("HTTP 502") || message.includes("HTTP 503") || message.includes("HTTP 504");
  }
  sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
  formatError(error) {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.replace(/\s+/g, " ").trim();
    return normalized.length > 320 ? `${normalized.slice(0, 320)}...` : normalized;
  }
  createAsset(input, args) {
    const size = parseSize(input.size);
    const timestamp = nowIso();
    return {
      id: args.id,
      name: input.name,
      type: input.assetType,
      description: input.description,
      style: this.resolveAssetStyle(args.project, input),
      size,
      files: args.files,
      metadataPath: args.metadataPath,
      atlasPath: args.atlasPath,
      sheetPath: args.sheetPath,
      generationMode: input.generationMode ?? "text-to-image",
      referenceImages: input.generationMode === "image-to-image" ? input.referenceImages : void 0,
      maskImagePath: input.generationMode === "image-to-image" ? input.maskImagePath : void 0,
      prompt: args.prompt,
      exportTargets: input.exportTargets,
      createdAt: timestamp,
      updatedAt: timestamp
    };
  }
  async persistResult(project, input, asset, logs, files, extraFiles) {
    await this.projectService.addAssets(project.path, [asset]);
    const outputFiles = [...files, ...extraFiles].filter(Boolean);
    const historyRecord = {
      id: asset.id,
      createdAt: asset.createdAt,
      assetType: input.assetType,
      prompt: asset.prompt,
      parameters: input,
      style: asset.style,
      outputFiles,
      exportTargets: input.exportTargets,
      favorite: false,
      exported: false
    };
    await this.historyService.append(project.path, historyRecord);
    logs.push(`保存历史记录: ${path.join(project.path, "history", `${asset.id}.json`)}`);
  }
  findAssetById(project, assetId) {
    return project.assets.find((asset) => asset.id === assetId);
  }
  findSourceSheetPaths(asset, project) {
    if (!asset) return [];
    const sheets = asset.files.filter((file) => file.includes("source_sheet"));
    if (sheets.length > 0) return sheets.map((f) => resolveProjectPath(project.path, f));
    if (asset.sheetPath) return [resolveProjectPath(project.path, asset.sheetPath)];
    if (asset.files.length > 0) return [resolveProjectPath(project.path, asset.files[0])];
    return [];
  }
  buildCharacterI2IPrompt(originalPrompt, input, project, animations, columns, rows, versionIndex, versionCount) {
    const versionLabel = `v${String(versionIndex + 1).padStart(2, "0")}`;
    const mergedDescription = input.description ? `修改要求：${input.description}。来自用户的新描述，必须覆盖原描述中可能冲突的部分。` : "";
    return [
      originalPrompt,
      "======== 以上是原始生成提示词 ========",
      mergedDescription,
      `版本：${versionCount > 1 ? `${input.name} ${versionLabel}` : input.name}`,
      `角色视角：${this.characterViewLabel(input.characterView)}。`,
      this.buildCharacterSheetGuidance(input, animations, columns, rows),
      "请基于原始角色设计进行修改调整，保持角色身份、服装、色板一致，只改变指定的部分。"
    ].filter(Boolean).join("\n");
  }
  validateInput(input) {
    const mode = input.generationMode ?? "text-to-image";
    if (mode !== "image-to-image") {
      return;
    }
    if (!input.referenceImages?.length) {
      throw new Error("图生图模式需要至少一张参考图。");
    }
    if (input.referenceImages.length > 4) {
      throw new Error("图生图 v1 最多支持 4 张参考图。");
    }
    if (input.editIntent === "inpaint" && !input.maskImagePath) {
      throw new Error("局部替换模式需要提供蒙版 PNG。");
    }
  }
  resolveReferenceImages(project, input) {
    if ((input.generationMode ?? "text-to-image") !== "image-to-image") {
      return [];
    }
    return input.referenceImages.map((reference) => ({
      ...reference,
      filePath: resolveProjectPath(project.path, reference.path)
    }));
  }
  resolveMaskImagePath(project, input) {
    if ((input.generationMode ?? "text-to-image") !== "image-to-image" || !input.maskImagePath) {
      return void 0;
    }
    return resolveProjectPath(project.path, input.maskImagePath);
  }
  buildReferenceGuidance(input) {
    if ((input.generationMode ?? "text-to-image") !== "image-to-image") {
      return "";
    }
    const roleLabels = {
      subject: "保持主体身份和轮廓",
      style: "匹配视觉风格、线条语言和渲染方式",
      composition: "遵循构图和镜头安排",
      palette: "复用色板和材质气质"
    };
    const intentLabels = {
      "preserve-subject": "保留参考图主体，并重绘成可用于游戏工程的素材。",
      "preserve-style": "创建一个遵循参考风格的新素材。",
      "preserve-composition": "创建一个遵循参考构图的新素材。",
      "same-series": "创建一个与参考素材属于同系列的变体。",
      inpaint: "只编辑蒙版区域，其余区域保持视觉稳定。"
    };
    const strengthLabels = {
      low: "宽松参考输入图。",
      medium: "在提示词要求和参考图保留之间保持平衡。",
      high: "尽量高保真保留参考图细节。"
    };
    const roles = input.referenceImages.map((reference, index) => `第 ${index + 1} 张参考图（${this.referenceRoleLabel(reference.role)}）：${roleLabels[reference.role]}。`).join(" ");
    return [
      "使用提供的输入参考图。",
      intentLabels[input.editIntent],
      strengthLabels[input.referenceStrength],
      roles
    ].filter(Boolean).join(" ");
  }
  buildGenerationMetadata(input) {
    const generationMode = input.generationMode ?? "text-to-image";
    if (generationMode !== "image-to-image") {
      return { generationMode };
    }
    return {
      generationMode,
      editIntent: input.editIntent,
      referenceStrength: input.referenceStrength,
      referenceImages: input.referenceImages,
      maskImagePath: input.maskImagePath
    };
  }
  async appendGenerationMetadata(metadataPath, input) {
    try {
      const metadata = await fs.readJson(metadataPath);
      await writeJsonFile(metadataPath, {
        ...metadata,
        ...this.buildGenerationMetadata(input)
      });
    } catch {
      await writeJsonFile(metadataPath, this.buildGenerationMetadata(input));
    }
  }
  buildSingleSubjectGuidance(input) {
    if (!this.shouldIsolateSingleSubject(input)) {
      return "";
    }
    return [
      "单主体硬约束：画面只能有一个完整主体，居中，占据主要区域。",
      "不要生成多个候选、大小对比版本、进化形态、变体展示、同屏多个生物或多个道具。",
      "不要画背景、地面、投影、边框、文字、标签或参考小图。",
      "如果需要精英变体细节，把细节合并到同一个主体上，不要额外画第二个怪物。"
    ].join(" ");
  }
  shouldIsolateSingleSubject(input) {
    return input.assetType === "enemy" || input.assetType === "icon" || input.assetType === "item";
  }
  buildStylePrompt(project, input) {
    const detailPrompt = this.resolveDetailPrompt(input);
    const styleName = project.style.trim();
    const styleDescription = project.styleDescription.trim();
    const parts = [
      styleName ? `主要美术风格：${styleName}` : "",
      styleDescription && styleDescription !== styleName ? `风格说明：${styleDescription}` : "",
      this.buildStyleHardConstraints(project, input),
      detailPrompt ? `对象细节：${detailPrompt}` : ""
    ];
    return parts.filter(Boolean).join("\n");
  }
  buildStyleHardConstraints(project, input) {
    const styleText = `${project.style} ${project.styleDescription}`.toLowerCase();
    const constraints = [];
    if (styleText.includes("像素") || styleText.includes("pixel") || styleText.includes("16-bit") || styleText.includes("16bit")) {
      constraints.push(
        "严格像素美术硬约束：低分辨率游戏精灵、硬边方块像素、清晰像素轮廓、有限色板、无抗锯齿、无写实绘画、无3D渲染、无照片质感、无柔焦阴影。"
      );
      if (input.assetType === "character") {
        constraints.push("角色必须像可直接放入 2D 游戏的 16-bit 角色 sprite，不要生成写实怪物插画或概念图。");
      }
    }
    return constraints.join("\n");
  }
  resolveAssetStyle(project, input) {
    const detailPrompt = this.resolveDetailPrompt(input);
    return detailPrompt ? `${project.style} | ${detailPrompt}` : project.style;
  }
  characterViewLabel(value) {
    const labels = {
      "side-view": "侧视角",
      "top-down": "俯视角",
      "four-direction": "四方向",
      "eight-direction": "八方向"
    };
    return labels[value] ?? value;
  }
  referenceRoleLabel(value) {
    const labels = {
      subject: "主体参考",
      style: "风格参考",
      composition: "构图参考",
      palette: "色板参考"
    };
    return labels[value];
  }
  assetTypeLabel(value) {
    const labels = {
      character: "角色",
      enemy: "怪物",
      icon: "图标",
      item: "道具",
      ui: "界面元素",
      tileset: "瓦片集",
      background: "背景",
      effect: "特效"
    };
    return labels[value];
  }
  resolveDetailPrompt(input) {
    const legacyStyle = input.style;
    return (input.detailPrompt || legacyStyle || "").trim();
  }
}
class HistoryService {
  async append(projectPath, record) {
    await withFileLock(this.historyPath(projectPath), async () => {
      const history = await this.getHistory(projectPath);
      const next = [record, ...history].slice(0, 200);
      await writeJsonFile(this.historyPath(projectPath), next);
      await writeJsonFile(path.join(projectPath, "history", `${record.id}.json`), record);
    });
  }
  async getHistory(projectPath) {
    await fs.ensureDir(path.join(projectPath, "history"));
    return readJsonFile(this.historyPath(projectPath), []);
  }
  historyPath(projectPath) {
    return path.join(projectPath, "history", "history.json");
  }
}
class ImageProcessingService {
  async processImage(input, options) {
    let output = await this.prepareForeground(input, options);
    if (options.trim) {
      output = await this.trimTransparent(output);
    }
    output = await this.normalizeCanvas(output, { width: options.width, height: options.height }, options.anchor ?? "center", options.padding ?? 0);
    return this.ensureNotBlank(output, input, options);
  }
  async saveProcessedImage(input, outputPath, options) {
    const processed = await this.processImage(input, options);
    await fs.ensureDir(path.dirname(outputPath));
    await fs.writeFile(outputPath, processed);
  }
  async removeBackground(input) {
    return this.removeFlatBackground(input);
  }
  async normalizeFramesConsistently(inputs, options) {
    const prepared = await Promise.all(inputs.map((input) => this.prepareForeground(input, options)));
    if (!options.trim) {
      const normalized2 = await Promise.all(
        prepared.map((frame) => this.normalizeCanvas(frame, { width: options.width, height: options.height }, options.anchor ?? "center", options.padding ?? 0))
      );
      return Promise.all(normalized2.map((frame, index) => this.ensureNotBlank(frame, inputs[index], options)));
    }
    const bounds = await Promise.all(prepared.map((frame) => this.getAlphaBounds(frame)));
    const nonEmptyBounds = bounds.filter((box) => Boolean(box));
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
      const content = await sharp(frame).ensureAlpha().extract({
        left: box.minX,
        top: box.minY,
        width: box.width,
        height: box.height
      }).resize({
        width: Math.max(1, Math.round(box.width * scale)),
        height: Math.max(1, Math.round(box.height * scale)),
        fit: "fill",
        kernel: sharp.kernel.nearest
      }).png().toBuffer();
      return this.placeOnCanvas(content, { width: options.width, height: options.height }, options.anchor ?? "center", safePadding);
    }));
    return Promise.all(normalized.map((frame, index) => this.ensureNotBlank(frame, inputs[index], options)));
  }
  async normalizeFile(inputPath, outputPath, size) {
    const buffer = await fs.readFile(inputPath);
    const processed = await this.normalizeCanvas(buffer, size);
    await fs.ensureDir(path.dirname(outputPath));
    await fs.writeFile(outputPath, processed);
  }
  async prepareForeground(input, options) {
    let output = options.transparentBackground ? await this.removeFlatBackground(input) : await sharp(input).ensureAlpha().png().toBuffer();
    if (options.removeEdgeArtifacts) {
      output = await this.removeEdgeArtifacts(output);
    }
    if (options.isolateSubject) {
      output = await this.keepLargestAlphaComponent(output);
    }
    return output;
  }
  async removeFlatBackground(input) {
    const image = sharp(input).ensureAlpha();
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    const totalPixels = info.width * info.height;
    const originalAlphaPixels = this.countAlphaPixels(data, channels, totalPixels);
    const alreadyTransparent = this.hasRealAlphaChannel(data, channels, totalPixels);
    if (alreadyTransparent) {
      const cleaned = this.defringeAlpha(data, info);
      const cleanedAlphaPixels = this.countAlphaPixels(cleaned, channels, totalPixels);
      const minimumForegroundPixels2 = Math.max(16, Math.floor(totalPixels * 1e-3));
      if (cleanedAlphaPixels < minimumForegroundPixels2 || cleanedAlphaPixels < originalAlphaPixels * 0.1) {
        return sharp(input).ensureAlpha().png().toBuffer();
      }
      return sharp(cleaned, {
        raw: { width: info.width, height: info.height, channels }
      }).png().toBuffer();
    }
    const background = this.estimateBackgroundFromEdges(data, info);
    const tolerance = this.computeAdaptiveTolerance(data, info, background, channels);
    const backgroundCandidates = new Uint8Array(data.length / channels);
    for (let i = 0; i < data.length; i += channels) {
      const index = i / channels;
      const distance = Math.sqrt(
        (data[i] - background.r) ** 2 + (data[i + 1] - background.g) ** 2 + (data[i + 2] - background.b) ** 2
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
    const minimumForegroundPixels = Math.max(16, Math.floor(totalPixels * 1e-3));
    if (remainingPixels < minimumForegroundPixels) {
      return sharp(input).ensureAlpha().png().toBuffer();
    }
    return sharp(data, {
      raw: { width: info.width, height: info.height, channels }
    }).png().toBuffer();
  }
  countAlphaPixels(data, channels, totalPixels, threshold = 12) {
    let alphaPixels = 0;
    for (let index = 0; index < totalPixels; index += 1) {
      if (data[index * channels + 3] > threshold) {
        alphaPixels += 1;
      }
    }
    return alphaPixels;
  }
  hasRealAlphaChannel(data, channels, totalPixels) {
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
  defringeAlpha(data, info) {
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
  estimateBackgroundFromEdges(data, info) {
    const channels = info.channels;
    const samples = [];
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
    const rValues = samples.map((s) => s.r).sort((a, b) => a - b);
    const gValues = samples.map((s) => s.g).sort((a, b) => a - b);
    const bValues = samples.map((s) => s.b).sort((a, b) => a - b);
    const mid = Math.floor(samples.length / 2);
    return {
      r: rValues[mid],
      g: gValues[mid],
      b: bValues[mid]
    };
  }
  computeAdaptiveTolerance(data, info, background, channels) {
    const edgeDists = [];
    for (let x = 0; x < info.width; x++) {
      [0, info.height - 1].forEach((y) => {
        const i = (y * info.width + x) * channels;
        edgeDists.push(Math.sqrt(
          (data[i] - background.r) ** 2 + (data[i + 1] - background.g) ** 2 + (data[i + 2] - background.b) ** 2
        ));
      });
    }
    if (edgeDists.length === 0) return 42;
    edgeDists.sort((a, b) => a - b);
    const q3 = edgeDists[Math.floor(edgeDists.length * 0.75)];
    const iqr = edgeDists[Math.floor(edgeDists.length * 0.75)] - edgeDists[Math.floor(edgeDists.length * 0.25)];
    return Math.min(64, Math.max(24, Math.round(q3 + iqr * 1.5)));
  }
  cleanupStrayPixels(mask, width, height) {
    const total = width * height;
    const visited = new Uint8Array(total);
    const minRegion = Math.max(12, Math.floor(total * 8e-3));
    for (let start = 0; start < total; start++) {
      if (!mask[start] || visited[start]) continue;
      const stack = [start];
      visited[start] = 1;
      const component = [];
      while (stack.length > 0) {
        const index = stack.pop();
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
  edgeConnectedMask(mask, width, height) {
    const total = width * height;
    const connected = new Uint8Array(total);
    const stack = [];
    const push = (index) => {
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
      const index = stack.pop();
      const x = index % width;
      if (x > 0) push(index - 1);
      if (x < width - 1) push(index + 1);
      if (index >= width) push(index - width);
      if (index < total - width) push(index + width);
    }
    return connected;
  }
  async trimTransparent(input) {
    try {
      return await sharp(input).trim({
        background: { r: 0, g: 0, b: 0, alpha: 0 },
        threshold: 1
      }).png().toBuffer();
    } catch {
      return input;
    }
  }
  async removeEdgeArtifacts(input) {
    const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    const total = info.width * info.height;
    const visited = new Uint8Array(total);
    const remove = new Uint8Array(total);
    const minArtifactArea = Math.max(64, Math.floor(total * 0.035));
    const minStrayArea = Math.max(4, Math.floor(total * 35e-5));
    for (let start = 0; start < total; start += 1) {
      if (visited[start] || data[start * channels + 3] <= 12) {
        continue;
      }
      const stack = [start];
      const component = [];
      visited[start] = 1;
      let touchesEdge = false;
      while (stack.length > 0) {
        const index = stack.pop();
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
          if (next === index - 1 && nextX !== x - 1 || next === index + 1 && nextX !== x + 1) {
            continue;
          }
          if (data[next * channels + 3] > 12) {
            visited[next] = 1;
            stack.push(next);
          }
        }
      }
      if (touchesEdge && component.length < minArtifactArea || component.length < minStrayArea) {
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
        channels
      }
    }).png().toBuffer();
  }
  async keepLargestAlphaComponent(input) {
    const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    const total = info.width * info.height;
    const visited = new Uint8Array(total);
    let bestComponent = [];
    for (let start = 0; start < total; start += 1) {
      if (visited[start] || data[start * channels + 3] <= 12) {
        continue;
      }
      const stack = [start];
      const component = [];
      visited[start] = 1;
      while (stack.length > 0) {
        const index = stack.pop();
        component.push(index);
        const x = index % info.width;
        const neighbors = [index - 1, index + 1, index - info.width, index + info.width];
        for (const next of neighbors) {
          if (next < 0 || next >= total || visited[next]) {
            continue;
          }
          const nextX = next % info.width;
          if (next === index - 1 && nextX !== x - 1 || next === index + 1 && nextX !== x + 1) {
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
    const minimumSubjectPixels = Math.max(8, Math.floor(total * 1e-3));
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
        channels
      }
    }).png().toBuffer();
  }
  async getAlphaBounds(input) {
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
      return void 0;
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
  async ensureNotBlank(output, original, options) {
    const bounds = await this.getAlphaBounds(output);
    const minimumPixels = Math.max(2, Math.floor(options.width * options.height * 1e-3));
    if (bounds && bounds.alphaPixels >= minimumPixels) {
      return output;
    }
    const fallback = await sharp(original).ensureAlpha().png().toBuffer();
    const trimmed = options.trim ? await this.trimTransparent(fallback) : fallback;
    return this.normalizeCanvas(trimmed, { width: options.width, height: options.height }, options.anchor ?? "center", options.padding ?? 0);
  }
  async normalizeCanvas(input, size, anchor = "center", padding = 0) {
    const safePadding = Math.max(0, Math.min(padding, Math.floor(Math.min(size.width, size.height) / 4)));
    const targetWidth = Math.max(1, size.width - safePadding * 2);
    const targetHeight = Math.max(1, size.height - safePadding * 2);
    const resized = await sharp(input).resize({
      width: targetWidth,
      height: targetHeight,
      fit: "inside",
      kernel: sharp.kernel.nearest
    }).png().toBuffer();
    const metadata = await sharp(resized).metadata();
    const resizedWidth = metadata.width ?? targetWidth;
    const resizedHeight = metadata.height ?? targetHeight;
    return this.placeOnCanvas(resized, size, anchor, safePadding, resizedWidth, resizedHeight);
  }
  async placeOnCanvas(input, size, anchor = "center", padding = 0, knownWidth, knownHeight) {
    const metadata = knownWidth && knownHeight ? void 0 : await sharp(input).metadata();
    const resizedWidth = knownWidth ?? metadata?.width ?? size.width;
    const resizedHeight = knownHeight ?? metadata?.height ?? size.height;
    const left = Math.floor((size.width - resizedWidth) / 2);
    const top = anchor === "bottom-center" ? Math.max(0, size.height - padding - resizedHeight) : Math.floor((size.height - resizedHeight) / 2);
    return sharp({
      create: {
        width: size.width,
        height: size.height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    }).composite([{
      input,
      left,
      top
    }]).png().toBuffer();
  }
}
class ProjectService {
  constructor(settingsService2) {
    this.settingsService = settingsService2;
    this.recentPath = path.join(electron.app.getPath("userData"), "recent-projects.json");
  }
  recentPath;
  async chooseProjectRoot() {
    const result = await electron.dialog.showOpenDialog({
      title: "选择项目父目录",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) {
      throw new Error("已取消选择目录");
    }
    return result.filePaths[0];
  }
  async createProject(input) {
    const settings = await this.settingsService.getSettings();
    const parentDirectory = input.parentDirectory?.trim() || settings.defaultProjectRoot;
    const projectPath = path.join(parentDirectory, sanitizeFileName(input.name));
    if (await fs.pathExists(path.join(projectPath, "project.json"))) {
      throw new Error(`项目已存在：${projectPath}`);
    }
    await ensureProjectDirectories(projectPath);
    const createdAt = nowIso();
    const project = {
      id: node_crypto.randomUUID(),
      name: input.name.trim() || "未命名项目",
      path: projectPath,
      gameType: input.gameType,
      style: input.style,
      styleDescription: input.style,
      defaultResolution: input.defaultResolution,
      defaultBackground: input.defaultBackground,
      exportTargets: input.exportTargets,
      assets: [],
      styleTemplates: [
        {
          id: node_crypto.randomUUID(),
          name: "十六位像素风",
          description: "十六位像素美术，轮廓干净，限制色板，透明背景",
          lineWeight: "清晰一像素边缘",
          lighting: "左上方柔和主光",
          cameraView: "侧视角"
        },
        {
          id: node_crypto.randomUUID(),
          name: "暗黑地牢",
          description: "暗黑地牢幻想，可读形状，低饱和金属与石材色板",
          lineWeight: "粗轮廓",
          lighting: "低照度暖色火把光",
          cameraView: "俯视角"
        }
      ],
      createdAt,
      updatedAt: createdAt
    };
    await this.saveProject(project);
    return project;
  }
  async openProjectDialog() {
    const result = await electron.dialog.showOpenDialog({
      title: "打开 Topspeed Builder 项目",
      filters: [{ name: "Topspeed Builder 项目", extensions: ["json"] }],
      properties: ["openFile"]
    });
    if (result.canceled || result.filePaths.length === 0) {
      throw new Error("已取消打开项目");
    }
    return this.openProjectPath(result.filePaths[0]);
  }
  async openProjectPath(inputPath) {
    const projectJsonPath = this.projectJsonPath(inputPath);
    if (!await fs.pathExists(projectJsonPath)) {
      throw new Error(`未找到项目配置文件：${projectJsonPath}`);
    }
    return withFileLock(projectJsonPath, async () => {
      const normalized = await this.readNormalizedProject(projectJsonPath);
      return this.saveProjectUnlocked(normalized);
    });
  }
  async saveProject(project) {
    return withFileLock(path.join(project.path, "project.json"), () => this.saveProjectUnlocked(project));
  }
  async saveProjectUnlocked(project) {
    const nextProject = {
      ...project,
      updatedAt: nowIso()
    };
    await ensureProjectDirectories(nextProject.path);
    await writeJsonFile(path.join(nextProject.path, "project.json"), nextProject);
    await this.addRecent(nextProject);
    return nextProject;
  }
  async addAssets(projectPath, assets) {
    return withFileLock(path.join(projectPath, "project.json"), async () => {
      const project = await this.readNormalizedProject(this.projectJsonPath(projectPath));
      const assetMap = new Map(project.assets.map((asset) => [asset.id, asset]));
      for (const asset of assets) {
        assetMap.set(asset.id, asset);
      }
      return this.saveProjectUnlocked({
        ...project,
        assets: Array.from(assetMap.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      });
    });
  }
  async getRecentProjects() {
    return withFileLock(this.recentPath, async () => {
      const recent = await readJsonFile(this.recentPath, []);
      const existing = [];
      for (const item of recent) {
        if (await fs.pathExists(path.join(item.path, "project.json"))) {
          existing.push({
            ...item,
            name: this.translateLegacyDefault(item.name),
            style: this.translateLegacyDefault(item.style)
          });
        }
      }
      if (existing.length !== recent.length) {
        await writeJsonFile(this.recentPath, existing);
      }
      return existing;
    });
  }
  async deleteAsset(projectPath, assetId) {
    return withFileLock(path.join(projectPath, "project.json"), async () => {
      const project = await this.readNormalizedProject(this.projectJsonPath(projectPath));
      const asset = project.assets.find((a) => a.id === assetId);
      if (asset) {
        const allPaths = [
          ...asset.files,
          asset.metadataPath,
          asset.atlasPath,
          asset.sheetPath
        ].filter(Boolean);
        for (const file of allPaths) {
          try {
            await fs.remove(resolveProjectPath(project.path, file));
          } catch {
          }
        }
      }
      return this.saveProjectUnlocked({ ...project, assets: project.assets.filter((a) => a.id !== assetId) });
    });
  }
  async removeRecentProject(projectPath) {
    return withFileLock(this.recentPath, async () => {
      const recent = await readJsonFile(this.recentPath, []);
      const next = recent.filter((item) => path.normalize(item.path) !== path.normalize(projectPath));
      await writeJsonFile(this.recentPath, next);
      return next;
    });
  }
  async addRecent(project) {
    await withFileLock(this.recentPath, async () => {
      const recent = await readJsonFile(this.recentPath, []);
      const next = uniqueByPath([
        {
          id: project.id,
          name: project.name,
          path: project.path,
          gameType: project.gameType,
          style: project.style,
          updatedAt: nowIso()
        },
        ...recent
      ]).slice(0, 12);
      await writeJsonFile(this.recentPath, next);
    });
  }
  projectJsonPath(inputPath) {
    return inputPath.endsWith("project.json") ? inputPath : path.join(inputPath, "project.json");
  }
  async readNormalizedProject(projectJsonPath) {
    const project = await fs.readJson(projectJsonPath);
    return {
      id: project.id ?? node_crypto.randomUUID(),
      name: this.translateLegacyDefault(project.name ?? project.projectName ?? "未命名项目"),
      path: path.dirname(projectJsonPath),
      gameType: project.gameType ?? "RPG",
      style: this.translateLegacyDefault(project.style ?? "十六位像素风"),
      styleDescription: this.translateLegacyDefault(project.styleDescription ?? project.style ?? ""),
      defaultResolution: project.defaultResolution ?? "64x64",
      defaultBackground: project.defaultBackground ?? "transparent",
      exportTargets: project.exportTargets ?? ["common"],
      assets: project.assets ?? [],
      styleTemplates: this.normalizeStyleTemplates(project.styleTemplates ?? []),
      createdAt: project.createdAt ?? nowIso(),
      updatedAt: project.updatedAt ?? nowIso()
    };
  }
  normalizeStyleTemplates(templates) {
    return templates.map((template) => ({
      ...template,
      name: this.translateLegacyDefault(template.name),
      description: this.translateLegacyDefault(template.description),
      lineWeight: template.lineWeight ? this.translateLegacyDefault(template.lineWeight) : template.lineWeight,
      lighting: template.lighting ? this.translateLegacyDefault(template.lighting) : template.lighting,
      cameraView: template.cameraView ? this.translateLegacyDefault(template.cameraView) : template.cameraView
    }));
  }
  translateLegacyDefault(value) {
    const legacy = {
      "Untitled Project": "未命名项目",
      "16-bit pixel art": "十六位像素风",
      "16-bit pixel art, clean silhouette, limited palette, transparent background": "十六位像素美术，轮廓干净，限制色板，透明背景",
      "dark dungeon fantasy, readable shapes, muted metal and stone palette": "暗黑地牢幻想，可读形状，低饱和金属与石材色板",
      "crisp 1px edges": "清晰一像素边缘",
      "top-left soft key light": "左上方柔和主光",
      "side-view": "侧视角",
      "bold outline": "粗轮廓",
      "low warm torch light": "低照度暖色火把光",
      "top-down": "俯视角"
    };
    return legacy[value] ?? value;
  }
}
const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
const MIME_BY_EXTENSION = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};
class ReferenceService {
  async chooseReferenceImages(projectPath) {
    const result = await electron.dialog.showOpenDialog({
      title: "选择参考图",
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
      properties: ["openFile", "multiSelections"]
    });
    if (result.canceled || result.filePaths.length === 0) {
      throw new Error("已取消选择参考图");
    }
    const imported = [];
    for (const filePath of result.filePaths) {
      imported.push(await this.importImage(projectPath, filePath, "references/images"));
    }
    return imported;
  }
  async chooseMask(projectPath) {
    const result = await electron.dialog.showOpenDialog({
      title: "选择局部编辑蒙版图片",
      filters: [{ name: "PNG 蒙版", extensions: ["png"] }],
      properties: ["openFile"]
    });
    if (result.canceled || result.filePaths.length === 0) {
      throw new Error("已取消选择蒙版");
    }
    const imported = await this.importImage(projectPath, result.filePaths[0], "references/masks", true);
    return imported;
  }
  async importImage(projectPath, sourcePath, destinationDirectory, requireAlpha = false) {
    await ensureProjectDirectories(projectPath);
    const extension = path.extname(sourcePath).toLowerCase();
    const mime = MIME_BY_EXTENSION[extension];
    if (!mime) {
      throw new Error(`不支持的参考图格式：${extension || "未知"}，仅支持 PNG/JPG/WebP。`);
    }
    if (requireAlpha && extension !== ".png") {
      throw new Error("蒙版必须是带透明通道的 PNG 文件。");
    }
    const stats = await fs.stat(sourcePath);
    if (stats.size > MAX_REFERENCE_IMAGE_BYTES) {
      throw new Error(`参考图超过 20MB：${sourcePath}`);
    }
    const metadata = await sharp(sourcePath).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error(`无法读取参考图尺寸：${sourcePath}`);
    }
    if (requireAlpha && !metadata.hasAlpha) {
      throw new Error("蒙版图片必须包含透明通道；透明区域表示可编辑区域。");
    }
    const buffer = await fs.readFile(sourcePath);
    const hash = node_crypto.createHash("sha256").update(buffer).digest("hex");
    const baseName = sanitizeFileName(path.basename(sourcePath, extension));
    const fileName = `${hash.slice(0, 12)}_${baseName}${extension}`;
    const targetPath = path.join(projectPath, destinationDirectory, fileName);
    await fs.ensureDir(path.dirname(targetPath));
    await fs.copy(sourcePath, targetPath, { overwrite: true });
    const thumbnail = await sharp(buffer).ensureAlpha().resize({
      width: 144,
      height: 144,
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }).png().toBuffer();
    const thumbnailPath = path.join(projectPath, "references", "thumbnails", `${hash.slice(0, 12)}_${baseName}.png`);
    await fs.ensureDir(path.dirname(thumbnailPath));
    await fs.writeFile(thumbnailPath, thumbnail);
    return {
      path: toRelative(projectPath, targetPath),
      role: "subject",
      name: path.basename(sourcePath),
      width: metadata.width,
      height: metadata.height,
      mime,
      bytes: stats.size,
      hash,
      thumbnailPath: toRelative(projectPath, thumbnailPath),
      dataUrl: `data:image/png;base64,${thumbnail.toString("base64")}`
    };
  }
}
class SettingsService {
  settingsPath;
  constructor() {
    this.settingsPath = path.join(electron.app.getPath("userData"), "settings.json");
  }
  async getSettings() {
    const defaults = await this.getDefaultSettings();
    return {
      ...defaults,
      ...await this.readSavedSettings()
    };
  }
  async saveSettings(settings) {
    await writeJsonFile(this.settingsPath, settings);
    return this.getSettings();
  }
  async getDefaultSettings() {
    const projectRoot = path.join(electron.app.getPath("documents"), "Topspeed Builder Projects");
    await fs.ensureDir(projectRoot);
    return {
      aiProvider: "openai",
      customApiFormat: "openai-image",
      apiKey: "",
      apiBaseUrl: "https://api.openai.com/v1/images/generations",
      model: "gpt-image-1.5",
      availableModels: [],
      defaultProjectRoot: projectRoot,
      defaultExportDirectory: "",
      defaultImageSize: "64x64",
      defaultGenerationCount: 1,
      savePromptHistory: true,
      autoTransparent: true,
      autoTrim: true,
      autoPackAtlas: true,
      generationQuality: "low"
    };
  }
  async readSavedSettings() {
    try {
      if (!await fs.pathExists(this.settingsPath)) {
        return {};
      }
      const raw = await fs.readFile(this.settingsPath, "utf8");
      try {
        return JSON.parse(raw);
      } catch {
        return this.readLooseSettings(raw);
      }
    } catch {
      return {};
    }
  }
  readLooseSettings(raw) {
    const output = {};
    this.readLooseString(raw, output, "aiProvider");
    this.readLooseString(raw, output, "customApiFormat");
    this.readLooseString(raw, output, "apiKey");
    this.readLooseString(raw, output, "apiBaseUrl");
    this.readLooseString(raw, output, "model");
    this.readLooseArray(raw, output, "availableModels");
    this.readLooseString(raw, output, "defaultProjectRoot");
    this.readLooseString(raw, output, "defaultExportDirectory");
    this.readLooseString(raw, output, "defaultImageSize");
    this.readLooseString(raw, output, "generationQuality");
    this.readLooseNumber(raw, output, "defaultGenerationCount");
    this.readLooseBoolean(raw, output, "savePromptHistory");
    this.readLooseBoolean(raw, output, "autoTransparent");
    this.readLooseBoolean(raw, output, "autoTrim");
    this.readLooseBoolean(raw, output, "autoPackAtlas");
    return output;
  }
  readLooseString(raw, output, key) {
    const match = raw.match(new RegExp(`"${String(key)}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
    if (match) {
      output[key] = this.decodeLooseJsonString(match[1]);
    }
  }
  readLooseArray(raw, output, key) {
    const match = raw.match(new RegExp(`"${String(key)}"\\s*:\\s*(\\[[^\\]]*\\])`));
    if (!match) return;
    try {
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed)) {
        output[key] = parsed.filter((item) => typeof item === "string");
      }
    } catch {
    }
  }
  readLooseNumber(raw, output, key) {
    const match = raw.match(new RegExp(`"${String(key)}"\\s*:\\s*(\\d+)`));
    if (match) {
      output[key] = Number(match[1]);
    }
  }
  readLooseBoolean(raw, output, key) {
    const match = raw.match(new RegExp(`"${String(key)}"\\s*:\\s*(true|false)`));
    if (match) {
      output[key] = match[1] === "true";
    }
  }
  decodeLooseJsonString(value) {
    const repaired = value.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
    try {
      return JSON.parse(`"${repaired}"`);
    } catch {
      return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
  }
}
class SpriteSheetService {
  async createSpriteSheet(args) {
    const frameSize = parseSize(args.size);
    const maxFramesPerAnimation = Math.max(...args.animations.map((animation) => animation.frames), 1);
    const sheetWidth = frameSize.width * maxFramesPerAnimation;
    const sheetHeight = frameSize.height * Math.max(args.animations.length, 1);
    const outputPath = path.join(args.projectPath, "sheets", `${args.outputName}_spritesheet.png`);
    const metadataPath = path.join(args.projectPath, "sheets", `${args.outputName}_spritesheet.json`);
    const composites = [];
    const metadataFrames = [];
    const animationIndex = new Map(args.animations.map((animation, index) => [animation.name, index]));
    for (const frame of args.frames) {
      const row = animationIndex.get(frame.animation) ?? 0;
      const left = frame.frameIndex * frameSize.width;
      const top = row * frameSize.height;
      composites.push({ input: frame.filePath, left, top });
      metadataFrames.push({
        name: frame.name,
        animation: frame.animation,
        index: metadataFrames.length,
        x: left,
        y: top,
        w: frameSize.width,
        h: frameSize.height
      });
    }
    await fs.ensureDir(path.dirname(outputPath));
    await sharp({
      create: {
        width: sheetWidth,
        height: sheetHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    }).composite(composites).png().toFile(outputPath);
    const metadata = {
      character: args.outputName,
      frameSize,
      sheet: toRelative(args.projectPath, outputPath),
      frames: metadataFrames,
      animations: Object.fromEntries(
        args.animations.map((animation) => {
          const frames = metadataFrames.filter((frame) => frame.animation === animation.name).map((frame) => frame.index);
          return [animation.name, { frames, fps: animation.fps, loop: animation.loop }];
        })
      )
    };
    await writeJsonFile(metadataPath, metadata);
    return {
      sheetPath: toRelative(args.projectPath, outputPath),
      metadataPath: toRelative(args.projectPath, metadataPath),
      metadata
    };
  }
}
class TileSetService {
  async composeTileSet(args) {
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
      left: index % columns * tileSize.width,
      top: Math.floor(index / columns) * tileSize.height
    }));
    await sharp({
      create: {
        width: columns * tileSize.width,
        height: rows * tileSize.height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    }).composite(composites).png().toFile(outputPath);
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
        x: index % columns * tileSize.width,
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
  async createPreview(tiles, outputPath, tileSize) {
    const previewWidth = tileSize.width * 6;
    const previewHeight = tileSize.height * 4;
    const composites = Array.from({ length: 24 }, (_, index) => {
      const tile = tiles[index % tiles.length];
      return {
        input: tile.filePath,
        left: index % 6 * tileSize.width,
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
    }).composite(composites).png().toFile(outputPath);
  }
  createTmx(args) {
    const mapWidth = 8;
    const mapHeight = 8;
    const csvRows = Array.from(
      { length: mapHeight },
      (_, y) => Array.from({ length: mapWidth }, (_2, x) => (x + y) % args.tileCount + 1).join(",")
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
const settingsService = new SettingsService();
const projectService = new ProjectService(settingsService);
const referenceService = new ReferenceService();
const aiService = new AIGenerationService();
const imageService = new ImageProcessingService();
const spriteSheetService = new SpriteSheetService();
const atlasService = new AtlasPackingService();
const tileSetService = new TileSetService();
const historyService = new HistoryService();
const exportService = new ExportService();
const generationService = new GenerationService(
  settingsService,
  projectService,
  aiService,
  imageService,
  spriteSheetService,
  atlasService,
  tileSetService,
  historyService
);
function createWindow() {
  const mainWindow = new electron.BrowserWindow({
    width: 1440,
    height: 980,
    minWidth: 1120,
    minHeight: 760,
    title: "Topspeed Builder",
    backgroundColor: "#07090b",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}
function registerIpc() {
  handle("project:create", (input) => projectService.createProject(input));
  handle("project:chooseRoot", () => projectService.chooseProjectRoot());
  handle("project:openDialog", () => projectService.openProjectDialog());
  handle("project:openPath", (projectPath) => projectService.openProjectPath(projectPath));
  handle("project:save", (project) => projectService.saveProject(project));
  handle("project:recent", () => projectService.getRecentProjects());
  handle("project:removeRecent", (projectPath) => projectService.removeRecentProject(projectPath));
  handle("settings:get", () => settingsService.getSettings());
  handle("settings:save", (settings) => settingsService.saveSettings(settings));
  handle("settings:testConnection", (settings) => aiService.testConnection(settings));
  handle("settings:fetchModels", (settings) => aiService.fetchModels(settings));
  handle("project:deleteAsset", (projectPath, assetId) => projectService.deleteAsset(projectPath, assetId));
  handle("reference:chooseImages", (projectPath) => referenceService.chooseReferenceImages(projectPath));
  handle("reference:chooseMask", (projectPath) => referenceService.chooseMask(projectPath));
  handle("generate:assets", (input) => generationService.generate(input));
  handle("history:get", (projectPath) => historyService.getHistory(projectPath));
  handle("export:project", async (input) => {
    const project = await projectService.openProjectPath(input.projectPath);
    return exportService.exportProject(project, input);
  });
  handle("image:dataUrl", async (projectPath, filePath) => {
    const absolutePath = resolveProjectPath(projectPath, filePath);
    const buffer = await fs.readFile(absolutePath);
    const extension = path.extname(absolutePath).replace(".", "").toLowerCase() || "png";
    const mime = extension === "jpg" || extension === "jpeg" ? "image/jpeg" : "image/png";
    return `data:${mime};base64,${buffer.toString("base64")}`;
  });
  handle("shell:showItem", async (filePath) => {
    electron.shell.showItemInFolder(filePath);
    return true;
  });
  handle("shell:showProjectItem", async (projectPath, filePath) => {
    electron.shell.showItemInFolder(resolveProjectPath(projectPath, filePath));
    return true;
  });
  handle("shell:openPath", async (filePath) => {
    const result = await electron.shell.openPath(filePath);
    if (result) {
      throw new Error(result);
    }
    return true;
  });
}
function handle(channel, handler) {
  electron.ipcMain.handle(channel, async (_event, ...args) => {
    try {
      const data = await handler(...args);
      return { ok: true, data };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });
}
electron.app.whenReady().then(() => {
  registerIpc();
  createWindow();
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    electron.app.quit();
  }
});
