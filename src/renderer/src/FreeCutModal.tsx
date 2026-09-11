import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  PenTool,
  RefreshCw,
  RotateCcw,
  Save,
  Scissors,
  Square,
  Trash2,
  X
} from "lucide-react";
import type {
  FreeCutData,
  GenerateAssetInput,
  GeneratedAssetResult,
  ManualRegion
} from "@shared/types";

interface Point {
  x: number;
  y: number;
}

interface FreeCutModalProps {
  projectPath: string;
  gridImagePath: string;
  runId: string;
  count: number;
  /** 用于导出命名的表单输入（name / cellNames / transparentBackground / trimEdges 等） */
  input: GenerateAssetInput;
  /** 已加载的网格大图 data URL（由父组件传入，省一次 IPC） */
  gridDataUrl: string;
  onClose: () => void;
  onExported?: (result: GeneratedAssetResult) => void;
}

function pointInPolygon(px: number, py: number, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** 把某个多边形区域裁出并绘制到缩略 canvas（按 bbox 适配 + 多边形裁剪） */
function drawCrop(canvas: HTMLCanvasElement, img: HTMLImageElement, points: Point[]): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const cw = canvas.width;
  const ch = canvas.height;
  ctx.clearRect(0, 0, cw, ch);
  if (points.length < 3) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const scale = Math.min(cw / bw, ch / bh) * 0.94;
  const offX = (cw - bw * scale) / 2;
  const offY = (ch - bh * scale) / 2;
  ctx.save();
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = offX + (p.x - minX) * scale;
    const y = offY + (p.y - minY) * scale;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(img, minX, minY, bw, bh, offX, offY, bw * scale, bh * scale);
  ctx.restore();
}

function CropThumb({
  img,
  points,
  selected,
  onSelect,
  onDelete
}: {
  img: HTMLImageElement | null;
  points: Point[];
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current && img) drawCrop(ref.current, img, points);
  }, [img, points]);
  return (
    <div className={`freeCutThumb${selected ? " selected" : ""}`} onClick={onSelect}>
      <canvas ref={ref} width={104} height={104} />
      <button
        type="button"
        className="freeCutThumbDel"
        title="删除该切图"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}

export default function FreeCutModal(props: FreeCutModalProps): JSX.Element {
  const { t } = useTranslation();
  const { projectPath, gridImagePath, runId, count, input, gridDataUrl, onClose, onExported } = props;

  const [regions, setRegions] = useState<ManualRegion[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<"rect" | "polygon">("rect");
  const [polyDraft, setPolyDraft] = useState<Point[]>([]);
  const [rectDraft, setRectDraft] = useState<{ start: Point; current: Point } | null>(null);
  const [mousePos, setMousePos] = useState<Point | null>(null);
  const [previewRegion, setPreviewRegion] = useState<ManualRegion | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const actionRef = useRef<
    null | { kind: "rect"; start: Point } | { kind: "vertex"; regionId: string; index: number } | { kind: "move"; regionId: string; last: Point }
  >(null);
  const didDragRef = useRef(false);
  const loadedSourceRef = useRef<"auto" | "manual">("auto");

  // 载入：无缓存时回退智能对齐结果作为初始数据
  useEffect(() => {
    let alive = true;
    window.topspeedBuilder
      .freecutLoad(projectPath, gridImagePath, count, runId)
      .then((res) => {
        if (!alive || !res.ok || !res.data) return;
        setRegions(res.data.regions);
        loadedSourceRef.current = res.data.source;
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 加载网格图到 Image 对象
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.src = gridDataUrl;
    return () => {
      img.onload = null;
    };
  }, [gridDataUrl]);

  const getScale = useCallback((): number => {
    const canvas = canvasRef.current;
    if (!canvas || canvas.width === 0) return 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return 1;
    // contain 比例：屏幕 1px 对应多少 bitmap 像素
    return Math.min(rect.width / canvas.width, rect.height / canvas.height);
  }, []);

  const toImageCoords = useCallback((e: React.MouseEvent): Point => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const imgW = canvas.width;
    const imgH = canvas.height;
    // 与 CSS object-fit: contain 一致：先算出居中留白后的显示区域
    const scale = Math.min(rect.width / imgW, rect.height / imgH);
    const dispW = imgW * scale;
    const dispH = imgH * scale;
    const offX = (rect.width - dispW) / 2;
    const offY = (rect.height - dispH) / 2;
    return {
      x: ((e.clientX - rect.left - offX) / dispW) * imgW,
      y: ((e.clientY - rect.top - offY) / dispH) * imgH
    };
  }, []);

  // 重绘叠加层
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    regions.forEach((r) => {
      const sel = r.id === selectedId;
      ctx.lineWidth = sel ? 3 : 2;
      ctx.strokeStyle = sel ? "#ff4d4f" : "rgba(80,160,255,0.9)";
      ctx.beginPath();
      r.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
      if (sel) {
        r.points.forEach((p) => {
          ctx.fillStyle = "#ff4d4f";
          ctx.beginPath();
          ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
          ctx.fill();
        });
      }
    });
    if (rectDraft) {
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = "#ff4d4f";
      ctx.lineWidth = 2;
      ctx.strokeRect(
        rectDraft.start.x,
        rectDraft.start.y,
        rectDraft.current.x - rectDraft.start.x,
        rectDraft.current.y - rectDraft.start.y
      );
      ctx.setLineDash([]);
    }
    if (polyDraft.length > 0) {
      ctx.strokeStyle = "#ff4d4f";
      ctx.lineWidth = 2;
      ctx.beginPath();
      polyDraft.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      if (mousePos) ctx.lineTo(mousePos.x, mousePos.y);
      ctx.stroke();
      polyDraft.forEach((p, i) => {
        ctx.fillStyle = i === 0 ? "#00b96b" : "#ff4d4f";
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }, [regions, selectedId, rectDraft, polyDraft, mousePos]);

  const hitTestVertex = useCallback(
    (p: Point): { regionId: string; index: number } | null => {
      if (!selectedId) return null;
      const r = regions.find((it) => it.id === selectedId);
      if (!r) return null;
      const thr = 8 * getScale();
      for (let i = 0; i < r.points.length; i += 1) {
        if (Math.hypot(r.points[i].x - p.x, r.points[i].y - p.y) <= thr) return { regionId: r.id, index: i };
      }
      return null;
    },
    [regions, selectedId, getScale]
  );

  const hitTestRegion = useCallback(
    (p: Point): string | null => {
      for (let i = regions.length - 1; i >= 0; i -= 1) {
        if (pointInPolygon(p.x, p.y, regions[i].points)) return regions[i].id;
      }
      return null;
    },
    [regions]
  );

  const addRegion = useCallback((points: Point[]) => {
    const id = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
    setRegions((prev) => [...prev, { id, points }]);
    setSelectedId(id);
    setEdited(true);
  }, []);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const p = toImageCoords(e);
      didDragRef.current = false;
      // 多边形绘制进行中：由 onClick 负责加点，这里不启动拖拽
      if (mode === "polygon" && polyDraft.length > 0) return;

      const vtx = hitTestVertex(p);
      if (vtx) {
        actionRef.current = { kind: "vertex", regionId: vtx.regionId, index: vtx.index };
        return;
      }
      const rid = hitTestRegion(p);
      if (rid) {
        actionRef.current = { kind: "move", regionId: rid, last: p };
        setSelectedId(rid);
        return;
      }
      if (mode === "rect") {
        actionRef.current = { kind: "rect", start: p };
        setRectDraft({ start: p, current: p });
      }
    },
    [mode, polyDraft.length, hitTestVertex, hitTestRegion, toImageCoords]
  );

  const onMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const p = toImageCoords(e);
      const action = actionRef.current;
      if (action?.kind === "rect") {
        didDragRef.current = true;
        setRectDraft({ start: action.start, current: p });
        return;
      }
      if (action?.kind === "vertex") {
        didDragRef.current = true;
        setRegions((prev) =>
          prev.map((r) =>
            r.id === action.regionId
              ? { ...r, points: r.points.map((pt, i) => (i === action.index ? p : pt)) }
              : r
          )
        );
        return;
      }
      if (action?.kind === "move") {
        didDragRef.current = true;
        const dx = p.x - action.last.x;
        const dy = p.y - action.last.y;
        action.last = p;
        setRegions((prev) =>
          prev.map((r) =>
            r.id === action.regionId
              ? { ...r, points: r.points.map((pt) => ({ x: pt.x + dx, y: pt.y + dy })) }
              : r
          )
        );
        return;
      }
      if (mode === "polygon" && polyDraft.length > 0) {
        setMousePos(p);
      }
    },
    [mode, polyDraft.length, toImageCoords]
  );

  const onMouseUp = useCallback(
    (e: React.MouseEvent) => {
      const action = actionRef.current;
      if (action?.kind === "rect") {
        const cur = toImageCoords(e);
        const moved = Math.hypot(cur.x - action.start.x, cur.y - action.start.y) > 4;
        if (moved) {
          const pts: Point[] = [
            { x: action.start.x, y: action.start.y },
            { x: cur.x, y: action.start.y },
            { x: cur.x, y: cur.y },
            { x: action.start.x, y: cur.y }
          ];
          const id =
            typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
          setPreviewRegion({ id, points: pts });
        } else {
          setSelectedId(hitTestRegion(cur));
        }
        setRectDraft(null);
      } else if (action?.kind === "vertex" || action?.kind === "move") {
        if (didDragRef.current) setEdited(true);
      }
      actionRef.current = null;
    },
    [toImageCoords, hitTestRegion]
  );

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      if (mode !== "polygon") return;
      if (didDragRef.current) return; // 刚结束拖拽，不加点
      const p = toImageCoords(e);
      if (polyDraft.length === 0) {
        // 空闲态：点中已有区域则选中，否则空白区首点作为多边形起点
        const rid = hitTestRegion(p);
        if (rid) {
          setSelectedId(rid);
          return;
        }
        setPolyDraft([p]);
        return;
      }
      // 继续加点；与末点太近（双击/原地重复）则不添加
      setPolyDraft((prev) => {
        const last = prev[prev.length - 1];
        if (last && Math.hypot(last.x - p.x, last.y - p.y) < 3) return prev;
        return [...prev, p];
      });
    },
    [mode, polyDraft.length, hitTestRegion, toImageCoords]
  );

  const finalizePolygon = useCallback(() => {
    if (polyDraft.length >= 3) {
      // 闭合后弹预览小窗，与矩形模式一致：保留 / 重画
      setPreviewRegion({ id: "preview", points: polyDraft });
    }
    setPolyDraft([]);
    setMousePos(null);
  }, [polyDraft]);

  const onRestore = useCallback(async () => {
    setBusy(true);
    try {
      const res = await window.topspeedBuilder.freecutRestore(projectPath, gridImagePath, count, runId);
      if (res.ok && res.data) {
        setRegions(res.data.regions);
        loadedSourceRef.current = res.data.source;
        setEdited(false);
        setPolyDraft([]);
        setSelectedId(null);
        setMsg(t("freecut.restored"));
      }
    } finally {
      setBusy(false);
    }
  }, [projectPath, gridImagePath, count, runId, t]);

  const onSave = useCallback(async () => {
    const data: FreeCutData = {
      runId,
      regions,
      source: edited ? "manual" : loadedSourceRef.current,
      updatedAt: new Date().toISOString()
    };
    const res = await window.topspeedBuilder.freecutSave(projectPath, gridImagePath, data);
    if (res.ok) setMsg(t("freecut.saved"));
  }, [projectPath, gridImagePath, runId, regions, edited, t]);

  const onExport = useCallback(async () => {
    if (regions.length === 0) {
      setMsg(t("freecut.noRegions"));
      return;
    }
    setBusy(true);
    setMsg("");
    try {
      const res = await window.topspeedBuilder.freecutExport(input, gridImagePath, runId, regions);
      if (!res.ok || !res.data) throw new Error(res.error || "export failed");
      setMsg(t("freecut.exported", { count: res.data.files.length }));
      onExported?.(res.data);
    } catch (err) {
      setMsg(`${t("freecut.exportFailed")}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [regions, input, gridImagePath, runId, t, onExported]);

  const deleteRegion = useCallback(
    (id: string) => {
      setRegions((prev) => prev.filter((r) => r.id !== id));
      setSelectedId((cur) => (cur === id ? null : cur));
      setEdited(true);
    },
    []
  );

  return (
    <div className="modalOverlay" onClick={onClose}>
      <div className="freeCutModal" onClick={(e) => e.stopPropagation()}>
        <div className="freeCutHeader">
          <h3>
            <Scissors size={16} /> {t("freecut.title")}
          </h3>
          <button className="freeCutClose" onClick={onClose} title={t("freecut.close")}>
            <X size={18} />
          </button>
        </div>

        <div className="freeCutToolbar">
          <div className="freeCutModes">
            <button
              className={`freeCutModeBtn${mode === "rect" ? " active" : ""}`}
              onClick={() => {
                setMode("rect");
                setPolyDraft([]);
                setMousePos(null);
              }}
            >
              <Square size={14} /> {t("freecut.rectMode")}
            </button>
            <button
              className={`freeCutModeBtn${mode === "polygon" ? " active" : ""}`}
              onClick={() => setMode("polygon")}
            >
              <PenTool size={14} /> {t("freecut.polygonMode")}
            </button>
          </div>
          <div className="freeCutActions">
            <button className="ghostButton" onClick={onRestore} disabled={busy} title={t("freecut.restoreHint")}>
              <RotateCcw size={14} /> {t("freecut.restore")}
            </button>
            <button className="ghostButton" onClick={onSave} disabled={busy}>
              <Save size={14} /> {t("freecut.save")}
            </button>
            <button className="primaryButton" onClick={onExport} disabled={busy || regions.length === 0}>
              <Scissors size={14} /> {t("freecut.export")}
            </button>
          </div>
        </div>

        <div className="freeCutBody">
          <div className="freeCutCanvasWrap">
            {imgSize.w > 0 && (
              <div className="freeCutStage" style={{ aspectRatio: `${imgSize.w} / ${imgSize.h}` }}>
                <img src={gridDataUrl} alt="grid" draggable={false} />
                <canvas
                  ref={canvasRef}
                  width={imgSize.w}
                  height={imgSize.h}
                  className="freeCutCanvas"
                  onMouseDown={onMouseDown}
                  onMouseMove={onMouseMove}
                  onMouseUp={onMouseUp}
                  onClick={onClick}
                  onDoubleClick={mode === "polygon" ? finalizePolygon : undefined}
                  onMouseLeave={() => setMousePos(null)}
                />
              </div>
            )}
            <div className="freeCutHint">
              {mode === "rect"
                ? t("freecut.rectHint")
                : polyDraft.length > 0
                  ? t("freecut.polygonDrawingHint", { n: polyDraft.length })
                  : t("freecut.polygonHint")}
              {mode === "polygon" && polyDraft.length > 0 && (
                <button className="freeCutClosePolygon" onClick={finalizePolygon}>
                  <Check size={13} /> {t("freecut.closePolygon")}
                </button>
              )}
            </div>
          </div>

          <div className="freeCutPreviewPane">
            <div className="freeCutPreviewHead">
              {t("freecut.preview")} ({regions.length})
            </div>
            <div className="freeCutThumbList">
              {regions.length === 0 && <div className="freeCutEmpty">{t("freecut.empty")}</div>}
              {regions.map((r, i) => (
                <CropThumb
                  key={r.id}
                  img={imgRef.current}
                  points={r.points}
                  selected={r.id === selectedId}
                  onSelect={() => setSelectedId(r.id)}
                  onDelete={() => deleteRegion(r.id)}
                />
              ))}
            </div>
            <div className="freeCutPreviewIndex">{t("freecut.thumbnailNote")}</div>
          </div>
        </div>

        {msg && <div className="freeCutMsg">{msg}</div>}

        {previewRegion && (
          <div className="freeCutPopup" onClick={(e) => e.stopPropagation()}>
            <div className="freeCutPopupTitle">{t("freecut.cropPreview")}</div>
            <canvas
              width={200}
              height={200}
              ref={(el) => {
                if (el && imgRef.current) drawCrop(el, imgRef.current, previewRegion.points);
              }}
            />
            <div className="freeCutPopupActions">
              <button className="primaryButton" onClick={() => {
                addRegion(previewRegion.points);
                setPreviewRegion(null);
              }}>
                <Check size={14} /> {t("freecut.keep")}
              </button>
              <button className="ghostButton" onClick={() => setPreviewRegion(null)}>
                <RefreshCw size={14} /> {t("freecut.redraw")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
