/**
 * 出图背景相关英文提示（与 OpenAI Images `background: transparent` 参数对齐）。
 * 透明模式：要求真 alpha，禁止再引导绿幕/品红幕（避免与 API 参数打架）。
 * 不透明降级：中性灰底，便于本地色键抠图且不易与角色配色冲突。
 */

export const TRANSPARENT_BACKGROUND_RULE =
  "Background: empty areas must be fully transparent with a real alpha channel (PNG transparency). " +
  "Do NOT use green screen, magenta screen, cyan screen, or any solid fluorescent chroma-key color. " +
  "Do NOT paint large flat color rectangles behind subjects. No ground shadows, no text, no watermark.";

/** API 不支持 background=transparent 时的追加说明（仅在不带 transparent 参数的请求中使用） */
export const OPAQUE_API_FALLBACK_BACKGROUND_APPEND =
  "Background (API fallback, no transparency): use one flat neutral dark gray (#2b2b2b) across the whole canvas. " +
  "Do NOT use green, magenta, cyan, or any fluorescent chroma-key color. No ground shadows, no text, no watermark.";

/** 多格网格、用户关闭透明出图时的底色 */
export const OPAQUE_GRID_BACKGROUND_RULE =
  "Background: use one flat neutral dark gray (#2b2b2b) for every cell; " +
  "do not use green screen, magenta screen, or fluorescent chroma-key colors. " +
  "No ground shadows, no text, no watermark.";
