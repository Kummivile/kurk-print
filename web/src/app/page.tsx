"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Cable,
  Download,
  Eraser,
  FileText,
  ImageUp,
  MoveLeft,
  PencilLine,
  Ruler,
  RotateCcw,
  Send,
  Upload,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

type Point = {
  x: number;
  y: number;
};

type FreehandShape = {
  id: string;
  kind: "freehand";
  points: Point[];
};

type LineShape = {
  id: string;
  kind: "line";
  start: Point;
  end: Point;
};

type Shape = FreehandShape | LineShape;
type Tool = "freehand" | "line";
type Orientation = "portrait" | "landscape";
type TraceMode = "scanline" | "outline";
type CommandSource = "generated" | "manual";
type TracedImageAsset = {
  name: string;
  previewUrl: string;
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
};

type SerialPortLike = {
  open: (options: { baudRate: number }) => Promise<void>;
  close: () => Promise<void>;
  writable?: WritableStream<Uint8Array>;
  getInfo?: () => { usbVendorId?: number; usbProductId?: number };
};

type SerialNavigator = Navigator & {
  serial?: {
    requestPort: () => Promise<SerialPortLike>;
  };
};

const A4_PORTRAIT = {
  width: 210,
  height: 297,
};

function getPageSize(orientation: Orientation) {
  return orientation === "portrait"
    ? A4_PORTRAIT
    : { width: A4_PORTRAIT.height, height: A4_PORTRAIT.width };
}

function formatCoordinate(value: number) {
  return Math.round(value).toString().padStart(3, "0");
}

function toPrinterPoint(
  point: Point,
  drawingWidth: number,
  drawingHeight: number,
  printerWidth: number,
  printerHeight: number,
) {
  return {
    x: Math.round((point.x / drawingWidth) * printerWidth),
    y: Math.round((point.y / drawingHeight) * printerHeight),
  };
}

function shapeToSegments(shape: Shape) {
  if (shape.kind === "line") {
    return [{ start: shape.start, end: shape.end }];
  }

  return shape.points.slice(1).map((point, index) => ({
    start: shape.points[index],
    end: point,
  }));
}

function shapePath(shape: Shape) {
  if (shape.kind === "line") {
    return `M ${shape.start.x} ${shape.start.y} L ${shape.end.x} ${shape.end.y}`;
  }

  return shape.points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");
}

function buildImageTraceShapes(
  asset: TracedImageAsset,
  threshold: number,
  rowStep: number,
  invert: boolean,
  traceMode: TraceMode,
  drawingWidth: number,
  drawingHeight: number,
) {
  return traceMode === "outline"
    ? buildOutlineTraceShapes(asset, threshold, invert, drawingWidth, drawingHeight)
    : buildScanlineTraceShapes(
        asset,
        threshold,
        rowStep,
        invert,
        drawingWidth,
        drawingHeight,
      );
}

function buildBinaryMask(asset: TracedImageAsset, threshold: number, invert: boolean) {
  const mask = new Array(asset.width * asset.height).fill(false);

  for (let y = 0; y < asset.height; y += 1) {
    for (let x = 0; x < asset.width; x += 1) {
      const pixelIndex = (y * asset.width + x) * 4;
      const r = asset.pixels[pixelIndex] ?? 0;
      const g = asset.pixels[pixelIndex + 1] ?? 0;
      const b = asset.pixels[pixelIndex + 2] ?? 0;
      const alpha = asset.pixels[pixelIndex + 3] ?? 0;
      const luma = (r * 299 + g * 587 + b * 114) / 1000;
      mask[y * asset.width + x] = alpha > 10 && (invert ? luma >= threshold : luma <= threshold);
    }
  }

  return mask;
}

function buildScanlineTraceShapes(
  asset: TracedImageAsset,
  threshold: number,
  rowStep: number,
  invert: boolean,
  drawingWidth: number,
  drawingHeight: number,
) {
  const mask = buildBinaryMask(asset, threshold, invert);
  const margin = 18;
  const usableWidth = Math.max(1, drawingWidth - margin * 2);
  const usableHeight = Math.max(1, drawingHeight - margin * 2);
  const scale = Math.min(usableWidth / asset.width, usableHeight / asset.height);
  const offsetX = (drawingWidth - asset.width * scale) / 2;
  const offsetY = (drawingHeight - asset.height * scale) / 2;
  const shapes: Shape[] = [];

  for (let y = 0; y < asset.height; y += rowStep) {
    let runStart = -1;

    for (let x = 0; x < asset.width; x += 1) {
      const isDark = mask[y * asset.width + x];

      if (isDark && runStart < 0) {
        runStart = x;
      }

      const reachedRunEnd = runStart >= 0 && (!isDark || x === asset.width - 1);
      if (!reachedRunEnd) {
        continue;
      }

      const runEnd = isDark && x === asset.width - 1 ? x : x - 1;
      shapes.push({
        id: `image-${y}-${runStart}-${runEnd}`,
        kind: "line",
        start: {
          x: offsetX + runStart * scale,
          y: offsetY + y * scale,
        },
        end: {
          x: offsetX + Math.max(runStart + 1, runEnd + 1) * scale,
          y: offsetY + y * scale,
        },
      });

      runStart = -1;
    }
  }

  return shapes;
}

function buildOutlineTraceShapes(
  asset: TracedImageAsset,
  threshold: number,
  invert: boolean,
  drawingWidth: number,
  drawingHeight: number,
) {
  const mask = buildBinaryMask(asset, threshold, invert);
  const segmentMap = new Map<string, Point[]>();
  const epsilon = 0.0001;

  const vertexKey = (point: Point) => `${point.x.toFixed(4)},${point.y.toFixed(4)}`;
  const addSegment = (start: Point, end: Point) => {
    const key = `${vertexKey(start)}|${vertexKey(end)}`;
    const reverseKey = `${vertexKey(end)}|${vertexKey(start)}`;
    if (segmentMap.has(reverseKey)) {
      return;
    }
    segmentMap.set(key, [start, end]);
  };

  const sample = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= asset.width || y >= asset.height) {
      return false;
    }
    return mask[y * asset.width + x];
  };

  const midpointTop = (x: number, y: number) => ({ x: x + 0.5, y });
  const midpointRight = (x: number, y: number) => ({ x: x + 1, y: y + 0.5 });
  const midpointBottom = (x: number, y: number) => ({ x: x + 0.5, y: y + 1 });
  const midpointLeft = (x: number, y: number) => ({ x, y: y + 0.5 });

  for (let y = 0; y < asset.height - 1; y += 1) {
    for (let x = 0; x < asset.width - 1; x += 1) {
      const tl = sample(x, y) ? 1 : 0;
      const tr = sample(x + 1, y) ? 1 : 0;
      const br = sample(x + 1, y + 1) ? 1 : 0;
      const bl = sample(x, y + 1) ? 1 : 0;
      const code = tl | (tr << 1) | (br << 2) | (bl << 3);

      switch (code) {
        case 0:
        case 15:
          break;
        case 1:
          addSegment(midpointTop(x, y), midpointLeft(x, y));
          break;
        case 2:
          addSegment(midpointRight(x, y), midpointTop(x, y));
          break;
        case 3:
          addSegment(midpointRight(x, y), midpointLeft(x, y));
          break;
        case 4:
          addSegment(midpointBottom(x, y), midpointRight(x, y));
          break;
        case 5:
          addSegment(midpointTop(x, y), midpointLeft(x, y));
          addSegment(midpointBottom(x, y), midpointRight(x, y));
          break;
        case 6:
          addSegment(midpointBottom(x, y), midpointTop(x, y));
          break;
        case 7:
          addSegment(midpointBottom(x, y), midpointLeft(x, y));
          break;
        case 8:
          addSegment(midpointLeft(x, y), midpointBottom(x, y));
          break;
        case 9:
          addSegment(midpointTop(x, y), midpointBottom(x, y));
          break;
        case 10:
          addSegment(midpointTop(x, y), midpointRight(x, y));
          addSegment(midpointLeft(x, y), midpointBottom(x, y));
          break;
        case 11:
          addSegment(midpointRight(x, y), midpointBottom(x, y));
          break;
        case 12:
          addSegment(midpointLeft(x, y), midpointRight(x, y));
          break;
        case 13:
          addSegment(midpointTop(x, y), midpointRight(x, y));
          break;
        case 14:
          addSegment(midpointLeft(x, y), midpointTop(x, y));
          break;
        default:
          break;
      }
    }
  }

  const adjacency = new Map<string, Point[]>();

  for (const [start, end] of segmentMap.values()) {
    const startKey = vertexKey(start);
    const endKey = vertexKey(end);
    adjacency.set(startKey, [...(adjacency.get(startKey) ?? []), end]);
    adjacency.set(endKey, [...(adjacency.get(endKey) ?? []), start]);
  }

  const visited = new Set<string>();
  const polylines: Point[][] = [];

  for (const [segmentKey, [segmentStart, segmentEnd]] of segmentMap) {
    if (visited.has(segmentKey) || visited.has(`${vertexKey(segmentEnd)}|${vertexKey(segmentStart)}`)) {
      continue;
    }

    const polyline = [segmentStart, segmentEnd];
    visited.add(segmentKey);

    let current = segmentEnd;
    let previous = segmentStart;

    while (true) {
      const candidates = adjacency
        .get(vertexKey(current))
        ?.filter((candidate) => {
          const key = `${vertexKey(current)}|${vertexKey(candidate)}`;
          const reverseKey = `${vertexKey(candidate)}|${vertexKey(current)}`;
          return !visited.has(key) && !visited.has(reverseKey);
        });

      if (!candidates || candidates.length === 0) {
        break;
      }

      const next =
        candidates.find(
          (candidate) =>
            Math.abs(candidate.x - previous.x) > epsilon ||
            Math.abs(candidate.y - previous.y) > epsilon,
        ) ?? candidates[0];

      visited.add(`${vertexKey(current)}|${vertexKey(next)}`);
      polyline.push(next);
      previous = current;
      current = next;
    }

    polylines.push(simplifyPolyline(polyline, 0.65));
  }

  const margin = 18;
  const usableWidth = Math.max(1, drawingWidth - margin * 2);
  const usableHeight = Math.max(1, drawingHeight - margin * 2);
  const scale = Math.min(usableWidth / asset.width, usableHeight / asset.height);
  const offsetX = (drawingWidth - asset.width * scale) / 2;
  const offsetY = (drawingHeight - asset.height * scale) / 2;

  const stitchedPolylines = stitchPolylines(
    polylines
      .filter((polyline) => polyline.length >= 2)
      .filter((polyline) => polylineLength(polyline) >= 3),
    1.75,
  );

  return stitchedPolylines
    .filter((polyline) => polyline.length >= 2)
    .map((polyline, index) => ({
      id: `outline-${index}`,
      kind: "freehand" as const,
      points: polyline.map((point) => ({
        x: offsetX + point.x * scale,
        y: offsetY + point.y * scale,
      })),
    }));
}

function polylineLength(points: Point[]) {
  let total = 0;

  for (let index = 1; index < points.length; index += 1) {
    total += Math.hypot(
      points[index].x - points[index - 1].x,
      points[index].y - points[index - 1].y,
    );
  }

  return total;
}

function pointsAreNear(a: Point, b: Point, tolerance: number) {
  return Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;
}

function stitchPolylines(polylines: Point[][], tolerance: number) {
  const remaining = [...polylines];
  const stitched: Point[][] = [];

  while (remaining.length > 0) {
    let current = [...(remaining.shift() ?? [])];
    let didMerge = true;

    while (didMerge) {
      didMerge = false;

      for (let index = 0; index < remaining.length; index += 1) {
        const candidate = remaining[index];
        const currentStart = current[0];
        const currentEnd = current[current.length - 1];
        const candidateStart = candidate[0];
        const candidateEnd = candidate[candidate.length - 1];

        if (pointsAreNear(currentEnd, candidateStart, tolerance)) {
          current = [...current, ...candidate.slice(1)];
        } else if (pointsAreNear(currentEnd, candidateEnd, tolerance)) {
          current = [...current, ...candidate.slice(0, -1).reverse()];
        } else if (pointsAreNear(currentStart, candidateEnd, tolerance)) {
          current = [...candidate.slice(0, -1), ...current];
        } else if (pointsAreNear(currentStart, candidateStart, tolerance)) {
          current = [...candidate.slice(1).reverse(), ...current];
        } else {
          continue;
        }

        remaining.splice(index, 1);
        current = simplifyPolyline(current, 0.65);
        didMerge = true;
        break;
      }
    }

    stitched.push(current);
  }

  return stitched;
}

function perpendicularDistance(point: Point, start: Point, end: Point) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;

  if (dx === 0 && dy === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }

  return Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x) /
    Math.hypot(dx, dy);
}

function simplifyPolyline(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2) {
    return points;
  }

  let maxDistance = 0;
  let splitIndex = 0;

  for (let index = 1; index < points.length - 1; index += 1) {
    const distance = perpendicularDistance(points[index], points[0], points[points.length - 1]);
    if (distance > maxDistance) {
      maxDistance = distance;
      splitIndex = index;
    }
  }

  if (maxDistance <= tolerance) {
    return [points[0], points[points.length - 1]];
  }

  const left = simplifyPolyline(points.slice(0, splitIndex + 1), tolerance);
  const right = simplifyPolyline(points.slice(splitIndex), tolerance);
  return [...left.slice(0, -1), ...right];
}

function downloadCommands(contents: string) {
  const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "drawing-commands.txt";
  anchor.click();
  URL.revokeObjectURL(url);
}

function wait(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function normalizeCommandScript(script: string) {
  return script
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

export default function Home() {
  const svgId = useId();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const serialPortRef = useRef<SerialPortLike | null>(null);
  const [tool, setTool] = useState<Tool>("freehand");
  const [orientation, setOrientation] = useState<Orientation>("portrait");
  const [manualShapes, setManualShapes] = useState<Shape[]>([]);
  const [draftShape, setDraftShape] = useState<Shape | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [baudRate, setBaudRate] = useState(115200);
  const [isConnected, setIsConnected] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [connectionLabel, setConnectionLabel] = useState("No Arduino connected");
  const [sessionLog, setSessionLog] = useState<string[]>([
    "Web Serial is idle. Connect your Arduino to send the generated script.",
  ]);
  const [tracedImage, setTracedImage] = useState<TracedImageAsset | null>(null);
  const [traceThreshold, setTraceThreshold] = useState(148);
  const [traceRowStep, setTraceRowStep] = useState(3);
  const [traceInvert, setTraceInvert] = useState(false);
  const [traceMode, setTraceMode] = useState<TraceMode>("outline");
  const [commandSource, setCommandSource] = useState<CommandSource>("generated");
  const [manualCommandText, setManualCommandText] = useState("HOME\nMOV:100,0\nMOV:199,0\nMOV:100,0");
  const [loadedCommandFileName, setLoadedCommandFileName] = useState<string | null>(null);
  const pageSize = useMemo(() => getPageSize(orientation), [orientation]);
  const [printerWidth, setPrinterWidth] = useState(pageSize.width);
  const [printerHeight, setPrinterHeight] = useState(pageSize.height);

  const drawingWidth = pageSize.width;
  const drawingHeight = pageSize.height;
  const serialSupported =
    typeof navigator !== "undefined" && Boolean((navigator as SerialNavigator).serial);
  const shapes = useMemo(() => {
    if (!tracedImage) {
      return manualShapes;
    }

    return buildImageTraceShapes(
      tracedImage,
      traceThreshold,
      traceRowStep,
      traceInvert,
      traceMode,
      drawingWidth,
      drawingHeight,
    );
  }, [
    drawingHeight,
    drawingWidth,
    manualShapes,
    traceInvert,
    traceMode,
    traceRowStep,
    traceThreshold,
    tracedImage,
  ]);

  const totalSegments = useMemo(
    () => shapes.reduce((count, shape) => count + shapeToSegments(shape).length, 0),
    [shapes],
  );
  const boardLockedToImage = Boolean(tracedImage);
  const tracedImageFrame = useMemo(() => {
    if (!tracedImage) {
      return null;
    }

    const margin = 18;
    const usableWidth = Math.max(1, drawingWidth - margin * 2);
    const usableHeight = Math.max(1, drawingHeight - margin * 2);
    const scale = Math.min(usableWidth / tracedImage.width, usableHeight / tracedImage.height);

    return {
      width: tracedImage.width * scale,
      height: tracedImage.height * scale,
      x: (drawingWidth - tracedImage.width * scale) / 2,
      y: (drawingHeight - tracedImage.height * scale) / 2,
    };
  }, [drawingHeight, drawingWidth, tracedImage]);

  function pushLog(entry: string) {
    setSessionLog((current) => [entry, ...current].slice(0, 8));
  }

  const commandText = useMemo(() => {
    const commands = ["HOME"];

    for (const shape of shapes) {
      const segments = shapeToSegments(shape);

      if (segments.length === 0) {
        continue;
      }

      const first = toPrinterPoint(
        segments[0].start,
        drawingWidth,
        drawingHeight,
        printerWidth,
        printerHeight,
      );
      commands.push(`MOV:${formatCoordinate(first.x)},${formatCoordinate(first.y)}`);

      for (const segment of segments) {
        const start = toPrinterPoint(
          segment.start,
          drawingWidth,
          drawingHeight,
          printerWidth,
          printerHeight,
        );
        const end = toPrinterPoint(
          segment.end,
          drawingWidth,
          drawingHeight,
          printerWidth,
          printerHeight,
        );

        commands.push(
          `LINE:${formatCoordinate(start.x)},${formatCoordinate(start.y)},${formatCoordinate(end.x)},${formatCoordinate(end.y)}`,
        );
      }
    }

    return commands.join("\n");
  }, [drawingHeight, drawingWidth, printerHeight, printerWidth, shapes]);
  const activeCommandText = commandSource === "manual" ? manualCommandText : commandText;
  const activeCommandLines = useMemo(
    () => normalizeCommandScript(activeCommandText).split("\n").filter(Boolean),
    [activeCommandText],
  );

  function switchOrientation(nextOrientation: Orientation) {
    const nextSize = getPageSize(nextOrientation);
    setOrientation(nextOrientation);
    setPrinterWidth(nextSize.width);
    setPrinterHeight(nextSize.height);
    setDraftShape(null);
    setCursor(null);
    setManualShapes([]);
  }

  function getPointFromEvent(event: React.PointerEvent<SVGSVGElement>): Point | null {
    const svg = svgRef.current;

    if (!svg) {
      return null;
    }

    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return null;
    }

    const x = ((event.clientX - rect.left) / rect.width) * drawingWidth;
    const y = ((event.clientY - rect.top) / rect.height) * drawingHeight;

    return {
      x: Math.max(0, Math.min(drawingWidth, x)),
      y: Math.max(0, Math.min(drawingHeight, y)),
    };
  }

  function startShape(point: Point) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    if (tool === "freehand") {
      setDraftShape({
        id,
        kind: "freehand",
        points: [point],
      });
      return;
    }

    setDraftShape({
      id,
      kind: "line",
      start: point,
      end: point,
    });
  }

  function commitDraft() {
    if (!draftShape) {
      return;
    }

    if (draftShape.kind === "freehand" && draftShape.points.length < 2) {
      setDraftShape(null);
      return;
    }

    if (
      draftShape.kind === "line" &&
      draftShape.start.x === draftShape.end.x &&
      draftShape.start.y === draftShape.end.y
    ) {
      setDraftShape(null);
      return;
    }

    setManualShapes((current) => [...current, draftShape]);
    setDraftShape(null);
  }

  function handlePointerDown(event: React.PointerEvent<SVGSVGElement>) {
    if (boardLockedToImage) {
      return;
    }

    const point = getPointFromEvent(event);
    if (!point) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDrawing(true);
    setCursor(point);
    startShape(point);
  }

  function handlePointerMove(event: React.PointerEvent<SVGSVGElement>) {
    if (boardLockedToImage) {
      return;
    }

    const point = getPointFromEvent(event);
    if (!point) {
      return;
    }

    setCursor(point);

    if (!isDrawing || !draftShape) {
      return;
    }

    if (draftShape.kind === "freehand") {
      setDraftShape({
        ...draftShape,
        points: [...draftShape.points, point],
      });
      return;
    }

    setDraftShape({
      ...draftShape,
      end: point,
    });
  }

  function handlePointerUp(event: React.PointerEvent<SVGSVGElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    setIsDrawing(false);
    commitDraft();
  }

  function handlePointerLeave() {
    setCursor(null);
  }

  function handleUndo() {
    if (boardLockedToImage) {
      return;
    }

    setDraftShape(null);
    setManualShapes((current) => current.slice(0, -1));
  }

  function handleReset() {
    setDraftShape(null);
    setManualShapes([]);
    setTracedImage(null);
  }

  async function handleImageUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(reader.error ?? new Error("Image read failed"));
        reader.readAsDataURL(file);
      });

      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const nextImage = new Image();
        nextImage.onload = () => resolve(nextImage);
        nextImage.onerror = () => reject(new Error("Image decode failed"));
        nextImage.src = dataUrl;
      });

      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");

      if (!context) {
        throw new Error("Canvas context is unavailable");
      }

      canvas.width = image.width;
      canvas.height = image.height;
      context.drawImage(image, 0, 0);

      const imageData = context.getImageData(0, 0, image.width, image.height);

      setDraftShape(null);
      setTool("line");
      setManualShapes([]);
      setTracedImage({
        name: file.name,
        previewUrl: dataUrl,
        width: image.width,
        height: image.height,
        pixels: imageData.data,
      });
      pushLog(`Loaded ${file.name} for black-and-white tracing.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown image import error";
      pushLog(`Image import failed: ${message}`);
    } finally {
      event.target.value = "";
    }
  }

  async function handleCommandFileUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      const contents = await file.text();
      const normalized = normalizeCommandScript(contents);

      if (!normalized) {
        throw new Error("The uploaded file is empty.");
      }

      setManualCommandText(normalized);
      setLoadedCommandFileName(file.name);
      setCommandSource("manual");
      pushLog(`Loaded ${file.name} with ${normalized.split("\n").length} commands.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown file import error";
      pushLog(`Command file import failed: ${message}`);
    } finally {
      event.target.value = "";
    }
  }

  async function handleConnect() {
    const serial = (navigator as SerialNavigator).serial;

    if (!serial) {
      pushLog("This browser does not expose Web Serial. Use Chrome or Edge for the demo.");
      return;
    }

    try {
      const port = await serial.requestPort();
      await port.open({ baudRate });

      serialPortRef.current = port;
      setIsConnected(true);

      const info = port.getInfo?.();
      const details =
        info?.usbVendorId !== undefined || info?.usbProductId !== undefined
          ? ` VID:${info?.usbVendorId ?? "?"} PID:${info?.usbProductId ?? "?"}`
          : "";

      setConnectionLabel(`Connected at ${baudRate} baud${details}`);
      pushLog(`Connected to Arduino over Web Serial at ${baudRate} baud.${details}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown connection error";
      setIsConnected(false);
      serialPortRef.current = null;
      setConnectionLabel("Connection failed");
      pushLog(`Connection failed: ${message}`);
    }
  }

  async function handleDisconnect() {
    const port = serialPortRef.current;

    if (!port) {
      return;
    }

    try {
      await port.close();
      pushLog("Arduino connection closed.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown disconnect error";
      pushLog(`Disconnect had an issue: ${message}`);
    } finally {
      serialPortRef.current = null;
      setIsConnected(false);
      setIsSending(false);
      setConnectionLabel("No Arduino connected");
    }
  }

  async function handleSendToArduino() {
    const port = serialPortRef.current;

    if (!port?.writable) {
      pushLog("Connect to the Arduino before sending a script.");
      return;
    }

    const lines = activeCommandLines;

    if (lines.length === 0) {
      pushLog("There is no command script to send.");
      return;
    }

    setIsSending(true);
    pushLog(
      `Sending ${lines.length} ${commandSource === "manual" ? "manual" : "generated"} commands to the Arduino...`,
    );

    const writer = port.writable.getWriter();
    const encoder = new TextEncoder();

    try {
      for (const line of lines) {
        await writer.write(encoder.encode(`${line}\n`));
        await wait(12);
      }

      await writer.write(encoder.encode("PRINT:END\n"));
      pushLog(`Finished sending ${lines.length} commands.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown send error";
      pushLog(`Send failed: ${message}`);
    } finally {
      writer.releaseLock();
      setIsSending(false);
    }
  }

  useEffect(() => {
    return () => {
      const port = serialPortRef.current;
      if (port) {
        void port.close().catch(() => undefined);
      }
    };
  }, []);

  return (
    <main className="min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top_left,_rgba(255,206,122,0.24),_transparent_28%),linear-gradient(135deg,_#f7f2e8_0%,_#f1e3cf_35%,_#d0e0d7_100%)] text-stone-950">
      <div className="mx-auto flex min-h-screen max-w-7xl flex-col px-4 py-6 sm:px-6 lg:px-8">
        <section className="relative overflow-hidden rounded-[2rem] border border-stone-900/10 bg-white/72 p-6 shadow-[0_30px_80px_rgba(58,40,20,0.12)] backdrop-blur xl:p-8">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-[linear-gradient(90deg,rgba(36,93,76,0.15),rgba(216,140,44,0.14),rgba(155,54,43,0.10))]" />
          <div className="relative flex flex-col gap-8">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-2xl">
                <p className="text-xs font-semibold uppercase tracking-[0.35em] text-stone-500">
                  Kurk Draw Studio
                </p>
                <h1 className="mt-3 text-4xl font-semibold tracking-tight text-stone-950 sm:text-5xl">
                  Sketch the print path before the printer is even plugged in.
                </h1>
                <p className="mt-4 max-w-xl text-sm leading-6 text-stone-600 sm:text-base">
                  Draw directly on the board, preview the generated motion commands,
                  and keep the workflow browser-first until the Arduino side is ready.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3 rounded-2xl border border-stone-900/10 bg-stone-950 px-4 py-3 text-stone-50 shadow-lg shadow-stone-950/10 sm:grid-cols-3">
                <div>
                  <p className="text-[0.65rem] uppercase tracking-[0.25em] text-stone-400">
                    Shapes
                  </p>
                  <p className="mt-1 text-2xl font-semibold">{shapes.length}</p>
                </div>
                <div>
                  <p className="text-[0.65rem] uppercase tracking-[0.25em] text-stone-400">
                    Segments
                  </p>
                  <p className="mt-1 text-2xl font-semibold">{totalSegments}</p>
                </div>
                <div className="col-span-2 sm:col-span-1">
                  <p className="text-[0.65rem] uppercase tracking-[0.25em] text-stone-400">
                    Printer
                  </p>
                  <p className="mt-1 text-lg font-semibold">
                    {printerWidth} × {printerHeight}
                  </p>
                </div>
              </div>
            </div>

            <div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.9fr)]">
              <section className="rounded-[1.75rem] border border-stone-900/10 bg-stone-950 p-4 text-white shadow-[0_25px_60px_rgba(25,18,11,0.18)] sm:p-5">
                <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      onClick={() => switchOrientation("portrait")}
                      variant={orientation === "portrait" ? "secondary" : "outline"}
                      className={cn(
                        "border-white/10 bg-white/5 text-white hover:bg-white/10",
                        orientation === "portrait" &&
                          "bg-white text-stone-950 hover:bg-stone-100",
                      )}
                    >
                      A4 Portrait
                    </Button>
                    <Button
                      onClick={() => switchOrientation("landscape")}
                      variant={orientation === "landscape" ? "secondary" : "outline"}
                      className={cn(
                        "border-white/10 bg-white/5 text-white hover:bg-white/10",
                        orientation === "landscape" &&
                          "bg-white text-stone-950 hover:bg-stone-100",
                      )}
                    >
                      A4 Landscape
                    </Button>
                    <Button
                      onClick={() => {
                        setDraftShape(null);
                        setTool("freehand");
                      }}
                      variant={tool === "freehand" ? "secondary" : "outline"}
                      className={cn(
                        "border-white/10 bg-white/5 text-white hover:bg-white/10",
                        tool === "freehand" && "bg-[#d88c2c] text-stone-950 hover:bg-[#e59d3b]",
                      )}
                    >
                      <PencilLine />
                      Freehand
                    </Button>
                    <Button
                      onClick={() => {
                        setDraftShape(null);
                        setTool("line");
                      }}
                      variant={tool === "line" ? "secondary" : "outline"}
                      className={cn(
                        "border-white/10 bg-white/5 text-white hover:bg-white/10",
                        tool === "line" && "bg-[#8fca89] text-stone-950 hover:bg-[#9dd698]",
                      )}
                    >
                      <Ruler />
                      Line
                    </Button>
                  </div>

                  <div className="flex flex-wrap gap-2">
	                    <Button
	                      onClick={handleUndo}
	                      variant="outline"
	                      className="border-white/10 bg-white/5 text-white hover:bg-white/10"
	                      disabled={shapes.length === 0 || boardLockedToImage}
	                    >
                      <MoveLeft />
                      Undo
                    </Button>
	                    <Button
	                      onClick={handleReset}
	                      variant="outline"
	                      className="border-white/10 bg-white/5 text-white hover:bg-white/10"
                      disabled={shapes.length === 0 && !draftShape}
                    >
                      <RotateCcw />
                      Clear
                    </Button>
                  </div>
                </div>

                <div className="relative overflow-hidden rounded-[1.5rem] border border-white/10 bg-[linear-gradient(180deg,#f8f0de_0%,#efe5d0_100%)]">
                  <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(103,80,52,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(103,80,52,0.08)_1px,transparent_1px)] bg-[size:45px_45px]" />
                  <svg
                    id={svgId}
                    ref={svgRef}
                    viewBox={`0 0 ${drawingWidth} ${drawingHeight}`}
                    className="relative w-full max-h-[72vh] touch-none"
                    style={{ aspectRatio: `${drawingWidth} / ${drawingHeight}` }}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerUp}
                    onPointerLeave={handlePointerLeave}
	                  >
	                    <rect
	                      x="18"
                      y="18"
                      width={drawingWidth - 36}
                      height={drawingHeight - 36}
                      rx="18"
                      fill="transparent"
                      stroke="rgba(95,73,47,0.28)"
	                      strokeDasharray="10 10"
	                    />

	                    {tracedImage && tracedImageFrame ? (
	                      <image
	                        href={tracedImage.previewUrl}
	                        x={tracedImageFrame.x}
	                        y={tracedImageFrame.y}
	                        width={tracedImageFrame.width}
	                        height={tracedImageFrame.height}
	                        opacity={0.16}
	                        preserveAspectRatio="none"
	                      />
	                    ) : null}

	                    {shapes.map((shape) => (
	                      <path
                        key={shape.id}
                        d={shapePath(shape)}
                        fill="none"
                        stroke="#1f5f4d"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="7"
                      />
                    ))}

                    {draftShape ? (
                      <path
                        d={shapePath(draftShape)}
                        fill="none"
                        stroke="#b84a2d"
                        strokeDasharray="12 10"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="6"
                      />
                    ) : null}
                  </svg>

                  <div className="absolute bottom-4 left-4 rounded-full border border-stone-900/10 bg-white/85 px-3 py-1.5 text-xs font-medium text-stone-700 shadow-sm">
                    {cursor
                      ? `Cursor ${Math.round(cursor.x)}, ${Math.round(cursor.y)}`
	                      : "Move over the board to inspect coordinates"}
	                  </div>
	                  {tracedImage ? (
	                    <div className="absolute right-4 top-4 rounded-full border border-stone-900/10 bg-white/90 px-3 py-1.5 text-xs font-medium text-stone-700 shadow-sm">
	                      Image trace preview locked
	                    </div>
	                  ) : null}
	                </div>

                <div className="mt-4 flex flex-col gap-2 text-sm text-stone-300 sm:flex-row sm:items-center sm:justify-between">
                  <p>
                    Tool: <span className="font-semibold text-white">{tool}</span>
                  </p>
                  <p>
                    Paper size: <span className="font-semibold text-white">A4 {orientation}</span>
                    {" · "}
                    <span className="font-semibold text-white">
                      {drawingWidth} × {drawingHeight} mm
                    </span>
                  </p>
                </div>
              </section>

	              <aside className="flex flex-col gap-6">
	                <section className="rounded-[1.75rem] border border-stone-900/10 bg-white/80 p-5 shadow-[0_25px_50px_rgba(42,33,20,0.08)] backdrop-blur">
	                  <div className="flex items-center justify-between gap-3">
	                    <div>
	                      <p className="text-xs font-semibold uppercase tracking-[0.3em] text-stone-500">
	                        Image Trace
	                      </p>
	                      <h2 className="mt-2 text-xl font-semibold text-stone-950">
	                        Black and white import
	                      </h2>
	                    </div>
	                    <div className="rounded-full bg-[#1f5f4d] px-3 py-1 text-xs font-semibold text-white">
	                      Beta
	                    </div>
	                  </div>

	                  <p className="mt-4 text-sm leading-6 text-stone-600">
	                    Upload a black-and-white image and the dashboard will convert dark pixels
	                    into horizontal plotter lines that fit the current page orientation.
	                  </p>

	                  <label className="mt-5 flex cursor-pointer items-center justify-center gap-3 rounded-[1.25rem] border border-dashed border-stone-300 bg-stone-50 px-4 py-5 text-sm font-medium text-stone-700 transition hover:border-stone-500 hover:bg-stone-100">
	                    <ImageUp className="size-4" />
	                    <span>{tracedImage ? "Replace traced image" : "Upload image"}</span>
	                    <input
	                      type="file"
	                      accept="image/png,image/jpeg,image/webp,image/bmp"
	                      className="hidden"
	                      onChange={handleImageUpload}
	                    />
	                  </label>

	                  {tracedImage ? (
	                    <div className="mt-4 rounded-[1.25rem] border border-stone-200 bg-white p-4">
	                      <div className="flex items-start justify-between gap-4">
	                        <div>
	                          <p className="text-sm font-semibold text-stone-900">
	                            {tracedImage.name}
	                          </p>
	                          <p className="mt-1 text-xs uppercase tracking-[0.25em] text-stone-500">
	                            {tracedImage.width} × {tracedImage.height}px source
	                          </p>
	                        </div>
	                        <div
	                          aria-label="Uploaded trace source preview"
	                          className="h-16 w-16 rounded-2xl border border-stone-200 bg-cover bg-center"
	                          style={{ backgroundImage: `url(${tracedImage.previewUrl})` }}
	                        />
	                      </div>

	                      <div className="mt-5 space-y-4">
	                        <div className="grid gap-2 sm:grid-cols-2">
	                          <Button
	                            type="button"
	                            onClick={() => setTraceMode("outline")}
	                            variant={traceMode === "outline" ? "secondary" : "outline"}
	                            className={cn(
	                              "justify-center border-stone-300 bg-white text-stone-900 hover:bg-stone-100",
	                              traceMode === "outline" &&
	                                "border-[#1f5f4d] bg-[#1f5f4d] text-white hover:bg-[#276d59]",
	                            )}
	                          >
	                            Outline trace
	                          </Button>
	                          <Button
	                            type="button"
	                            onClick={() => setTraceMode("scanline")}
	                            variant={traceMode === "scanline" ? "secondary" : "outline"}
	                            className={cn(
	                              "justify-center border-stone-300 bg-white text-stone-900 hover:bg-stone-100",
	                              traceMode === "scanline" &&
	                                "border-[#1f5f4d] bg-[#1f5f4d] text-white hover:bg-[#276d59]",
	                            )}
	                          >
	                            Scanline fill
	                          </Button>
	                        </div>

	                        <label className="flex flex-col gap-2">
	                          <span className="flex items-center justify-between text-sm font-medium text-stone-700">
	                            Threshold
	                            <span className="text-stone-500">{traceThreshold}</span>
	                          </span>
	                          <input
	                            type="range"
	                            min={0}
	                            max={255}
	                            value={traceThreshold}
	                            onChange={(event) => setTraceThreshold(Number(event.target.value))}
	                          />
	                        </label>

	                        {traceMode === "scanline" ? (
	                          <label className="flex flex-col gap-2">
	                            <span className="flex items-center justify-between text-sm font-medium text-stone-700">
	                              Row spacing
	                              <span className="text-stone-500">{traceRowStep}px</span>
	                            </span>
	                            <input
	                              type="range"
	                              min={1}
	                              max={8}
	                              step={1}
	                              value={traceRowStep}
	                              onChange={(event) => setTraceRowStep(Number(event.target.value))}
	                            />
	                          </label>
	                        ) : null}

	                        <label className="flex items-center gap-3 text-sm font-medium text-stone-700">
	                          <input
	                            type="checkbox"
	                            checked={traceInvert}
	                            onChange={(event) => setTraceInvert(event.target.checked)}
	                            className="size-4 rounded border-stone-300"
	                          />
	                          Invert light and dark areas
	                        </label>
	                      </div>

	                      <p className="mt-4 text-sm leading-6 text-stone-600">
	                        {traceMode === "outline"
	                          ? "Outline trace follows the outer contour of dark regions, which is much cleaner for circles, logos, and icons."
	                          : "Lower row spacing keeps more detail but creates many more `LINE` commands."}{" "}
	                        Clear the board to return to manual drawing.
	                      </p>
	                    </div>
	                  ) : null}
	                </section>

	                <section className="rounded-[1.75rem] border border-stone-900/10 bg-white/80 p-5 shadow-[0_25px_50px_rgba(42,33,20,0.08)] backdrop-blur">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.3em] text-stone-500">
                        Output Mapping
                      </p>
                      <h2 className="mt-2 text-xl font-semibold text-stone-950">
                        Printer coordinates
                      </h2>
                    </div>
                    <div className="rounded-full bg-stone-950 px-3 py-1 text-xs font-semibold text-stone-50">
                      MVP
                    </div>
                  </div>

                  <div className="mt-5 grid gap-4 sm:grid-cols-2">
                    <label className="flex flex-col gap-2">
                      <span className="text-sm font-medium text-stone-700">Printer width</span>
                      <input
                        type="number"
                        min={1}
                        value={printerWidth}
                        onChange={(event) =>
                          setPrinterWidth(Math.max(1, Number(event.target.value) || 1))
                        }
                        className="h-11 rounded-2xl border border-stone-300 bg-white px-4 text-sm text-stone-950 outline-none transition focus:border-stone-500"
                      />
                    </label>
                    <label className="flex flex-col gap-2">
                      <span className="text-sm font-medium text-stone-700">Printer height</span>
                      <input
                        type="number"
                        min={1}
                        value={printerHeight}
                        onChange={(event) =>
                          setPrinterHeight(Math.max(1, Number(event.target.value) || 1))
                        }
                        className="h-11 rounded-2xl border border-stone-300 bg-white px-4 text-sm text-stone-950 outline-none transition focus:border-stone-500"
                      />
                    </label>
                  </div>

                  <p className="mt-4 text-sm leading-6 text-stone-600">
                    Switch between portrait and landscape and keep the exported coordinates aligned
                    with the visible A4 page layout.
                  </p>
                </section>

                <section className="rounded-[1.75rem] border border-stone-900/10 bg-white/80 p-5 shadow-[0_25px_50px_rgba(42,33,20,0.08)] backdrop-blur">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.3em] text-stone-500">
                        Arduino Link
                      </p>
                      <h2 className="mt-2 text-xl font-semibold text-stone-950">
                        Demo Web Serial
                      </h2>
                    </div>
                    <div
                      className={cn(
                        "rounded-full px-3 py-1 text-xs font-semibold",
                        isConnected
                          ? "bg-emerald-100 text-emerald-800"
                          : "bg-stone-200 text-stone-700",
                      )}
                    >
                      {isConnected ? "Connected" : "Disconnected"}
                    </div>
                  </div>

                  <p className="mt-4 text-sm leading-6 text-stone-600">
                    This uses browser Web Serial to stream the generated script over USB to your
                    own Arduino firmware.
                  </p>

                  <div className="mt-5 grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                    <label className="flex flex-col gap-2">
                      <span className="text-sm font-medium text-stone-700">Baud rate</span>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={baudRate}
                        onChange={(event) =>
                          setBaudRate(Math.max(1, Number(event.target.value) || 1))
                        }
                        className="h-11 rounded-2xl border border-stone-300 bg-white px-4 text-sm text-stone-950 outline-none transition focus:border-stone-500"
                      />
                    </label>

                    <div className="flex flex-wrap gap-2">
                      <Button
                        onClick={handleConnect}
                        className="bg-[#1f5f4d] text-white hover:bg-[#276d59]"
                        disabled={!serialSupported || isConnected || isSending}
                      >
                        <Cable />
                        Connect
                      </Button>
                      <Button
                        onClick={handleDisconnect}
                        variant="outline"
                        className="border-stone-300 bg-white text-stone-950 hover:bg-stone-100"
                        disabled={!isConnected || isSending}
                      >
                        Disconnect
                      </Button>
                    </div>
                  </div>

                  <div className="mt-4 rounded-2xl border border-stone-200 bg-stone-950 px-4 py-3 text-sm text-stone-100">
                    <p className="font-medium text-white">{connectionLabel}</p>
                    <p className="mt-1 text-stone-400">
                      {serialSupported
                        ? "Browser support detected. Pick a port, then send the script."
                        : "Web Serial is not available in this browser."}
                    </p>
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button
                      onClick={handleSendToArduino}
                      className="bg-[#d88c2c] text-stone-950 hover:bg-[#e39a37]"
                      disabled={!isConnected || isSending || activeCommandLines.length === 0}
                    >
                      <Send />
                      {isSending ? "Sending..." : "Send to Arduino"}
                    </Button>
                  </div>

                  <div className="mt-4 rounded-[1.25rem] border border-stone-200 bg-white p-4">
                    <p className="text-sm font-medium text-stone-800">Session log</p>
                    <div className="mt-3 space-y-2 text-sm text-stone-600">
                      {sessionLog.map((entry, index) => (
                        <p key={`${entry}-${index}`}>{entry}</p>
                      ))}
                    </div>
                  </div>
                </section>

                <section className="flex min-h-0 flex-1 flex-col rounded-[1.75rem] border border-stone-900/10 bg-[#14110f] p-5 text-stone-100 shadow-[0_30px_70px_rgba(25,18,11,0.18)]">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.3em] text-stone-500">
                        Command Workbench
                      </p>
                      <h2 className="mt-2 text-xl font-semibold text-white">
                        Plotter command script
                      </h2>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        onClick={() => setCommandSource("generated")}
                        variant={commandSource === "generated" ? "secondary" : "outline"}
                        className={cn(
                          "border-white/10 bg-white/5 text-white hover:bg-white/10",
                          commandSource === "generated" &&
                            "bg-[#8fca89] text-stone-950 hover:bg-[#9dd698]",
                        )}
                      >
                        <FileText />
                        Generated
                      </Button>
                      <Button
                        type="button"
                        onClick={() => setCommandSource("manual")}
                        variant={commandSource === "manual" ? "secondary" : "outline"}
                        className={cn(
                          "border-white/10 bg-white/5 text-white hover:bg-white/10",
                          commandSource === "manual" &&
                            "bg-[#d88c2c] text-stone-950 hover:bg-[#e39a37]",
                        )}
                      >
                        <PencilLine />
                        Manual
                      </Button>
                      <Button
                        onClick={() => downloadCommands(activeCommandText)}
                        className="bg-[#d88c2c] text-stone-950 hover:bg-[#e39a37]"
                      >
                        <Download />
                        Export
                      </Button>
                    </div>
                  </div>

                  <div className="mt-5 grid gap-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="flex cursor-pointer items-center justify-center gap-3 rounded-[1.25rem] border border-dashed border-white/15 bg-white/5 px-4 py-4 text-sm font-medium text-stone-200 transition hover:border-white/35 hover:bg-white/10">
                        <Upload className="size-4" />
                        <span>Upload `.txt` commands</span>
                        <input
                          type="file"
                          accept=".txt,text/plain"
                          className="hidden"
                          onChange={handleCommandFileUpload}
                        />
                      </label>
                      <div className="rounded-[1.25rem] border border-white/10 bg-black/25 px-4 py-4 text-sm text-stone-300">
                        <p className="font-medium text-white">
                          {loadedCommandFileName ?? "No command file loaded"}
                        </p>
                        <p className="mt-1 text-stone-400">
                          Paste a script below or load a `.txt`, then switch to Manual mode to send it.
                        </p>
                      </div>
                    </div>

                    <label className="flex flex-col gap-3">
                      <span className="text-sm font-medium text-stone-200">
                        Manual command editor
                      </span>
                      <textarea
                        value={manualCommandText}
                        onChange={(event) => {
                          setManualCommandText(event.target.value);
                          setCommandSource("manual");
                        }}
                        spellCheck={false}
                        className="min-h-48 rounded-[1.25rem] border border-white/10 bg-black/30 px-4 py-4 font-mono text-sm leading-6 text-stone-100 outline-none transition focus:border-[#d88c2c]"
                        placeholder={"HOME\nMOV:100,0\nLINE:010,010,120,120"}
                      />
                    </label>

                    <div className="overflow-hidden rounded-[1.25rem] border border-white/10 bg-black/30">
                      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3 text-sm text-stone-300">
                        <p>
                          Active script:{" "}
                          <span className="font-semibold text-white">
                            {commandSource === "manual" ? "Manual commands" : "Generated from canvas"}
                          </span>
                        </p>
                        <p>{activeCommandLines.length} lines ready</p>
                      </div>
                      <pre className="max-h-80 overflow-auto p-4 text-sm leading-6 text-stone-200">
                        <code>{activeCommandText}</code>
                      </pre>
                    </div>
                  </div>

                  <div className="mt-4 flex items-start gap-3 rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-stone-300">
                    <Eraser className="mt-0.5 size-4 text-[#8fca89]" />
                    <p>
                      Generated strokes still export as `LINE` commands, but now you can also paste
                      or upload your own `.txt` script and send that exact command list to the plotter.
                    </p>
                  </div>
                </section>
              </aside>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
