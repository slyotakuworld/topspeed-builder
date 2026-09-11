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

interface View {
  scale: number;
  tx: number;
  ty: number;
}

interface PanState {
  x0: number;
  y0: number;
  tx0: number;
  ty0: number;
  moved: boolean;
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

/** 世界边距：让切图框即使超出图片范围也能完整显示，不会被画布裁掉 */
function computeMargin(w: number, h: number): number {
  if (w <= 0 || h <= 0) return 0;
  return Math.max(140, Math.round(Math.max(w, h) * 0.22));
}

function CropThumb({
  img,
  points,
  index,
  selected,
  onSelect,
  onDelete,
  onZoom
}: {
  img: HTMLImageElement | null;
  points: Point[];
  index: number;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onZoom: () => void;
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current && img) drawCrop(ref.current, img, points);
  }, [img, points]);
  return (
    <div
      className={`freeCutThumb${selected ? " selected" : ""}`}
      onClick={onSelect}
      onDoubleClick={onZoom}
      title="双击放大查看全图"
    >
      <canvas ref={ref} width={150} height={150} />
      <span className="freeCutThumbIdx">{index + 1}</span>
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
  const [view, setView] = useState<View>({ scale: 1, tx: 0, ty: 0 });
  const [lightbox, setLightbox] = useState<{ points: Point[]; index: number } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<
    null | { kind: "rect"; start: Point } | { kind: "vertex"; regionId: string; index: number } | { kind: "move"; regionId: string; last: Point }
  >(null);
  const didDragRef = useRef(false);
  const panRef = useRef<PanState | null>(null);
  const viewInitRef = useRef(false);
  const loadedSourceRef = useRef<"auto" | "manual">("auto");

  // 用于在非 React 回调（window 监听）里读取最新值
  const viewRef = useRef(view);
  viewRef.current = view;
  const minScaleRef = useRef(0.1);
  const maxScaleRef = useRef(20);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const polyDraftRef = useRef(polyDraft);
  polyDraftRef.current = polyDraft;
  const suppressClickRef = useRef(false);

  const margin = imgSize.w > 0 ? computeMargin(imgSize.w, imgSize.h) : 0;
  const bitmapW = imgSize.w + 2 * margin;
  const bitmapH = imgSize.h + 2 * margin;

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

  const clamp = useCallback((v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v)), []);

  // 客户端坐标 -> 图片坐标（世界画布带 MARGIN 偏移，transform 已体现在 getBoundingClientRect 中）
  const clientToImage = useCallback((e: { clientX: number; clientY: number }): Point => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const bw = canvas.width;
    const bh = canvas.height;
    const bx = ((e.clientX - rect.left) / rect.width) * bw;
    const by = ((e.clientY - rect.top) / rect.height) * bh;
    return { x: bx - margin, y: by - margin };
  }, [margin]);

  // 计算让整张图（含边距）完整居中的视图
  const getFitView = useCallback((): View | null => {
    const el = stageRef.current;
    if (!el || imgSize.w === 0) return null;
    const rect = el.getBoundingClientRect();
    const cw = rect.width;
    const ch = rect.height;
    if (cw <= 0 || ch <= 0) return null;
    const W = bitmapW;
    const H = bitmapH;
    const s = Math.min(cw / W, ch / H) * 0.95;
    const tx = (cw - W * s) / 2;
    const ty = (ch - H * s) / 2;
    return { scale: s, tx, ty };
  }, [imgSize.w, imgSize.h, bitmapW, bitmapH]);

  // 首次拿到图片尺寸后，初始化视图并标定缩放上下限
  useEffect(() => {
    if (imgSize.w === 0 || viewInitRef.current) return;
    const f = getFitView();
    if (!f) return;
    viewInitRef.current = true;
    setView(f);
    minScaleRef.current = f.scale;
    maxScaleRef.current = f.scale * 16;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imgSize.w, imgSize.h, getFitView]);

  // 窗口大小变化时重新标定缩放下限并钳制当前视图
  useEffect(() => {
    const onResize = () => {
      const f = getFitView();
      if (!f) return;
      minScaleRef.current = f.scale;
      maxScaleRef.current = f.scale * 16;
      setView((v) => ({ ...v, scale: clamp(v.scale, minScaleRef.current, maxScaleRef.current) }));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [getFitView, clamp]);

  // 滚轮缩放（以光标为中心），用原生非 passive 监听以便 preventDefault
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const { scale, tx, ty } = viewRef.current;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const ns = clamp(scale * factor, minScaleRef.current, maxScaleRef.current);
      const bx = (cx - tx) / scale;
      const by = (cy - ty) / scale;
      setView({ scale: ns, tx: cx - bx * ns, ty: cy - by * ns });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [clamp, imgSize.w]);

  // ESC 关闭（避免“点空白退出”的前提下仍提供键盘退出途径）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 重绘叠加层
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || imgSize.w === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    const m = margin;
    const iw = imgSize.w;
    const ih = imgSize.h;
    ctx.clearRect(0, 0, W, H);
    // 世界背景
    ctx.fillStyle = "#eef1f5";
    ctx.fillRect(0, 0, W, H);
    // 图片区域棋盘格，便于区分“画布内/外”
    ctx.save();
    ctx.beginPath();
    ctx.rect(m, m, iw, ih);
    ctx.clip();
    const cs = 16;
    for (let y = 0; y < ih; y += cs) {
      for (let x = 0; x < iw; x += cs) {
        const dark = ((((x / cs) | 0) + ((y / cs) | 0)) & 1) === 0;
        ctx.fillStyle = dark ? "#dfe4ea" : "#eef1f5";
        ctx.fillRect(m + x, m + y, cs, cs);
      }
    }
    ctx.restore();
    if (imgRef.current) ctx.drawImage(imgRef.current, m, m);

    regions.forEach((r) => {
      const sel = r.id === selectedId;
      ctx.lineWidth = sel ? 3 : 2;
      ctx.strokeStyle = sel ? "#ff4d4f" : "rgba(80,160,255,0.9)";
      ctx.beginPath();
      r.points.forEach((p, i) => {
        const x = p.x + m;
        const y = p.y + m;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.stroke();
      if (sel) {
        r.points.forEach((p) => {
          const x = p.x + m;
          const y = p.y + m;
          ctx.fillStyle = "#ff4d4f";
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y, 6, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        });
      }
    });
    if (rectDraft) {
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = "#ff4d4f";
      ctx.lineWidth = 2;
      ctx.strokeRect(
        rectDraft.start.x + m,
        rectDraft.start.y + m,
        rectDraft.current.x - rectDraft.start.x,
        rectDraft.current.y - rectDraft.start.y
      );
      ctx.setLineDash([]);
    }
    if (polyDraft.length > 0) {
      ctx.strokeStyle = "#ff4d4f";
      ctx.lineWidth = 2;
      ctx.beginPath();
      polyDraft.forEach((p, i) => {
        const x = p.x + m;
        const y = p.y + m;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      if (mousePos) ctx.lineTo(mousePos.x + m, mousePos.y + m);
      ctx.stroke();
      polyDraft.forEach((p, i) => {
        const x = p.x + m;
        const y = p.y + m;
        ctx.fillStyle = i === 0 ? "#00b96b" : "#ff4d4f";
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }, [regions, selectedId, rectDraft, polyDraft, mousePos, imgSize, margin]);

  // 顶点命中：扫描所有区域，取屏幕距离最近的顶点（解决“想拖顶点却拖了框”）
  const hitTestVertex = useCallback(
    (p: Point): { regionId: string; index: number } | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const thr = 11 * (canvas.width / rect.width); // 屏幕 ~11px 换算到图片坐标
      let best: { regionId: string; index: number } | null = null;
      let bestD = thr;
      for (const r of regions) {
        for (let i = 0; i < r.points.length; i += 1) {
          const d = Math.hypot(r.points[i].x - p.x, r.points[i].y - p.y);
          if (d <= bestD) {
            bestD = d;
            best = { regionId: r.id, index: i };
          }
        }
      }
      return best;
    },
    [regions]
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
    const id =
      typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
    setRegions((prev) => [...prev, { id, points }]);
    setSelectedId(id);
    setEdited(true);
  }, []);

  // 右键单击动作：多边形绘制中撤销上一点；否则取消选中
  const rightClickAction = useCallback(() => {
    if (modeRef.current === "polygon" && polyDraftRef.current.length > 0) {
      setPolyDraft((prev) => prev.slice(0, -1));
      setMousePos(null);
    } else {
      setSelectedId(null);
    }
  }, []);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 2) {
        // 右键：记录起点，由 window 监听完成平移 / 单击判定
        e.preventDefault();
        if (canvasRef.current) canvasRef.current.style.cursor = "grabbing";
        panRef.current = {
          x0: e.clientX,
          y0: e.clientY,
          tx0: viewRef.current.tx,
          ty0: viewRef.current.ty,
          moved: false
        };
        const move = (ev: MouseEvent) => {
          const pan = panRef.current;
          if (!pan) return;
          const dx = ev.clientX - pan.x0;
          const dy = ev.clientY - pan.y0;
          if (Math.hypot(dx, dy) > 3) pan.moved = true;
          setView((v) => ({ ...v, tx: pan.tx0 + dx, ty: pan.ty0 + dy }));
        };
        const up = (ev: MouseEvent) => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          const pan = panRef.current;
          panRef.current = null;
          if (canvasRef.current) canvasRef.current.style.cursor = "crosshair";
          if (ev.button === 2 && pan && !pan.moved) rightClickAction();
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
        return;
      }
      if (e.button !== 0) return; // 仅左键进入绘制逻辑
      e.preventDefault();
      const p = clientToImage(e);
      didDragRef.current = false;
      // 多边形绘制进行中：由 onClick 负责加点，这里不启动拖拽
      if (mode === "polygon" && polyDraft.length > 0) return;

      const vtx = hitTestVertex(p);
      if (vtx) {
        actionRef.current = { kind: "vertex", regionId: vtx.regionId, index: vtx.index };
        setSelectedId(vtx.regionId);
        if (mode === "polygon") suppressClickRef.current = true;
        return;
      }
      const rid = hitTestRegion(p);
      if (rid) {
        actionRef.current = { kind: "move", regionId: rid, last: p };
        setSelectedId(rid);
        if (mode === "polygon") suppressClickRef.current = true;
        return;
      }
      if (mode === "rect") {
        actionRef.current = { kind: "rect", start: p };
        setRectDraft({ start: p, current: p });
      }
    },
    [mode, polyDraft.length, hitTestVertex, hitTestRegion, clientToImage, rightClickAction]
  );

  const onMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (panRef.current) return; // 右键平移中，交给 window 监听
      const p = clientToImage(e);
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
      // 无活动操作时更新悬停光标，提示是否可抓取顶点
      if (mode === "polygon" && polyDraft.length > 0) {
        setMousePos(p);
      } else if (canvasRef.current) {
        const hoverVtx = hitTestVertex(p);
        canvasRef.current.style.cursor = hoverVtx ? "pointer" : mode === "polygon" ? "crosshair" : "crosshair";
      }
    },
    [mode, polyDraft.length, clientToImage, hitTestVertex]
  );

  const onMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return; // 右键释放由 window 监听处理
      const action = actionRef.current;
      if (action?.kind === "rect") {
        const cur = clientToImage(e);
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
    [clientToImage, hitTestRegion]
  );

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      if (mode !== "polygon") return;
      if (didDragRef.current) return; // 刚结束拖拽，不加点
      const p = clientToImage(e);
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
    [mode, polyDraft.length, hitTestRegion, clientToImage]
  );

  const finalizePolygon = useCallback(() => {
    if (polyDraft.length >= 3) {
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

  const deleteRegion = useCallback((id: string) => {
    setRegions((prev) => prev.filter((r) => r.id !== id));
    setSelectedId((cur) => (cur === id ? null : cur));
    setEdited(true);
  }, []);

  return (
    <div className="modalOverlay">
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
              <div className="freeCutStage" ref={stageRef} onContextMenu={(e) => e.preventDefault()}>
                <div
                  className="freeCutStageInner"
                  ref={innerRef}
                  style={{
                    transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
                    width: bitmapW,
                    height: bitmapH
                  }}
                >
                  <canvas
                    ref={canvasRef}
                    width={bitmapW}
                    height={bitmapH}
                    className="freeCutCanvas"
                    onMouseDown={onMouseDown}
                    onMouseMove={onMouseMove}
                    onMouseUp={onMouseUp}
                    onClick={onClick}
                    onDoubleClick={mode === "polygon" ? finalizePolygon : undefined}
                    onMouseLeave={() => setMousePos(null)}
                  />
                </div>
                <div className="freeCutZoomBadge">{Math.round(view.scale * 100)}%</div>
              </div>
            )}
            <div className="freeCutHint">
              {mode === "rect"
                ? t("freecut.rectHint")
                : polyDraft.length > 0
                  ? t("freecut.polygonDrawingHint", { n: polyDraft.length })
                  : t("freecut.polygonHint")}
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
                  index={i}
                  selected={r.id === selectedId}
                  onSelect={() => setSelectedId(r.id)}
                  onDelete={() => deleteRegion(r.id)}
                  onZoom={() => setLightbox({ points: r.points, index: i })}
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
              width={220}
              height={220}
              ref={(el) => {
                if (el && imgRef.current) drawCrop(el, imgRef.current, previewRegion.points);
              }}
            />
            <div className="freeCutPopupActions">
              <button
                className="primaryButton"
                onClick={() => {
                  addRegion(previewRegion.points);
                  setPreviewRegion(null);
                }}
              >
                <Check size={14} /> {t("freecut.keep")}
              </button>
              <button className="ghostButton" onClick={() => setPreviewRegion(null)}>
                <RefreshCw size={14} /> {t("freecut.redraw")}
              </button>
            </div>
          </div>
        )}

        {lightbox && (
          <div className="freeCutLightbox" onClick={() => setLightbox(null)}>
            <div className="freeCutLightboxInner" onClick={(e) => e.stopPropagation()}>
              <canvas
                width={460}
                height={460}
                ref={(el) => {
                  if (el && imgRef.current) drawCrop(el, imgRef.current, lightbox.points);
                }}
              />
              <div className="freeCutLightboxCap">
                {t("freecut.preview")} #{lightbox.index + 1} · {t("freecut.lightboxClose")}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
