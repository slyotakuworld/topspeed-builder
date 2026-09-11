import type {
  PromptAssistantFields,
  PromptAssistantInput,
  PromptAssistantResult,
  PromptAssistantSettings
} from "@shared/types";
import { DEFAULT_PROMPT_ASSISTANT_FIELDS } from "@shared/types";

function buildSystemPrompt(fields: PromptAssistantFields): string {
  const enabled = { ...DEFAULT_PROMPT_ASSISTANT_FIELDS, ...fields };
  const schemaLines: string[] = [];
  if (enabled.description) {
    schemaLines.push('  "description": "对整张图要出现的内容做整体描述（中文，1-2 句，融入用户的类型与自然语言意图）"');
  }
  if (enabled.detailPrompt) {
    schemaLines.push('  "detailPrompt": "对象细节提示词：针对每个素材的造型、配色、材质、光影等可追加的细节要求（中文，若干条）"');
  }
  if (enabled.cellNames) {
    schemaLines.push('  "cellNames": ["素材1名称", "素材2名称"]');
  }
  if (enabled.style) {
    schemaLines.push('  "style": "美术风格自定义描述（如赛博朋克、像素风、厚涂等，含线条、光影、色彩倾向，呼应自然语言里的风格诉求）"');
  }
  // 全关时兜底为全开，避免出现空 JSON 模板让模型无从输出
  if (schemaLines.length === 0) {
    return buildSystemPrompt(DEFAULT_PROMPT_ASSISTANT_FIELDS);
  }
  return `你是游戏精灵图生成提示词助手。用户已经填好了一批素材生成参数（类型、数量等），并且用自然语言补充描述了他想要的风格 / 效果 / 对象。你需要结合这些「现有参数」和「自然语言描述」，生成用于 AI 绘制一张含多个素材的网格大图的提示词。你必须只输出一个 JSON 对象（不要任何额外解释、不要 markdown 代码块），且只包含下列字段：
{
${schemaLines.join(",\n")}
}`;
}

function resolveApiRoot(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function buildHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
  return headers;
}

function summarize(body: string): string {
  const text = body.trim();
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

export class PromptAssistantService {
  /** 连接测试：走 /models 列表接口，同时验证 API Key 鉴权 */
  async testConnection(settings: PromptAssistantSettings): Promise<{ ok: boolean; status: number; detail: string }> {
    if (!settings.baseUrl.trim()) {
      return { ok: false, status: 0, detail: "接口地址为空，请先填写提示词助手的 API Base URL。" };
    }
    const modelsUrl = `${resolveApiRoot(settings.baseUrl)}/models`;
    try {
      const response = await fetch(modelsUrl, {
        method: "GET",
        headers: buildHeaders(settings.apiKey),
        signal: AbortSignal.timeout(20000)
      });
      const text = await response.text();
      if (response.ok) return { ok: true, status: response.status, detail: "连接成功。" };
      return { ok: false, status: response.status, detail: `连接失败：HTTP ${response.status} ${response.statusText}。${summarize(text)}` };
    } catch (err) {
      return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 拉取模型列表 GET {root}/models */
  async fetchModels(settings: PromptAssistantSettings): Promise<string[]> {
    if (!settings.baseUrl.trim()) throw new Error("接口地址为空，请先填写提示词助手的 API Base URL。");
    const modelsUrl = `${resolveApiRoot(settings.baseUrl)}/models`;
    const response = await fetch(modelsUrl, {
      method: "GET",
      headers: buildHeaders(settings.apiKey),
      signal: AbortSignal.timeout(15000)
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`获取模型列表失败：HTTP ${response.status} ${response.statusText}。${summarize(text)}`);
    try {
      const json = JSON.parse(text) as { data?: unknown; models?: unknown };
      const list = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
      return list
        .map((item) => (item && typeof item === "object" && "id" in item ? String((item as { id: unknown }).id) : null))
        .filter((id): id is string => !!id);
    } catch {
      return [];
    }
  }

  /** 根据主题 + 游戏类型，让 LLM 一次性生成四个提示词字段 */
  async generate(settings: PromptAssistantSettings, input: PromptAssistantInput): Promise<PromptAssistantResult> {
    if (!settings.baseUrl.trim()) throw new Error("提示词助手接口地址为空。");
    if (!settings.model.trim()) throw new Error("提示词助手未选择模型。");

    const url = `${resolveApiRoot(settings.baseUrl)}/chat/completions`;
    const contextParts: string[] = [];
    contextParts.push(`现有素材生成参数：`);
    contextParts.push(`- 素材类型：${input.assetType || "未指定"}`);
    contextParts.push(`- 素材数量：${input.count && input.count > 0 ? input.count : "未指定"}`);
    if (input.currentDescription && input.currentDescription.trim()) {
      contextParts.push(`- 当前已填描述：${input.currentDescription.trim()}`);
    }
    if (input.currentStyle && input.currentStyle.trim()) {
      contextParts.push(`- 当前已选风格：${input.currentStyle.trim()}`);
    }
    contextParts.push(`\n用户的自然语言描述（请据此生成风格 / 效果 / 对象细节，并融入上面的现有参数）：`);
    contextParts.push(input.naturalLanguage.trim());
    const userPrompt = contextParts.join("\n") +
      (input.count && input.count > 0 ? `\n\n要求：cellNames 请提供恰好 ${input.count} 个名称，顺序对应网格布局。` : "");

    const body = {
      model: settings.model.trim(),
      messages: [
        { role: "system", content: buildSystemPrompt(input.fields ?? settings.fields ?? DEFAULT_PROMPT_ASSISTANT_FIELDS) },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.8
    };

    const response = await fetch(url, {
      method: "POST",
      headers: buildHeaders(settings.apiKey),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000)
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`提示词助手调用失败：HTTP ${response.status} ${response.statusText}。${summarize(text)}`);
    }

    const json = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    return parseAssistantResult(content, input.count);
  }
}

/** 从 LLM 文本中抽取 JSON 并规整成结构化结果（带兜底）。
 *  - parsed=true  ：成功提取结构化 JSON，调用方可直接自动填充表单。
 *  - parsed=false ：模型未按约定返回 JSON（如输出了解释性文字 / 代码块 / 残缺结构），
 *                   返回原始文本 raw，由调用方展示给用户手动复制粘贴。 */
function parseAssistantResult(content: string, count?: number): PromptAssistantResult {
  let raw: Record<string, unknown> = {};
  let parsed = false;
  const match = content.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      raw = JSON.parse(match[0]) as Record<string, unknown>;
      parsed = true;
    } catch {
      raw = {};
    }
  }

  const str = (v: unknown, fallback: string): string => (typeof v === "string" && v.trim() ? v.trim() : fallback);
  let cellNames: string[] = [];
  if (Array.isArray(raw.cellNames)) {
    cellNames = raw.cellNames.filter((x) => typeof x === "string").map((x) => String(x));
  } else if (typeof raw.cellNames === "string" && raw.cellNames.trim()) {
    cellNames = raw.cellNames
      .split(/[\n,，、]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (cellNames.length === 0) {
    const n = count && count > 0 ? count : 1;
    cellNames = Array.from({ length: n }, (_, i) => `素材${i + 1}`);
  }

  return {
    description: str(raw.description, ""),
    detailPrompt: str(raw.detailPrompt, ""),
    cellNames,
    style: str(raw.style, ""),
    parsed,
    raw: content
  };
}
