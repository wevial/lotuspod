import type { SpotShape } from "../bridge";

// A rectangle and a point in one drawing's coordinates.
export interface Rect { x: number; y: number; w: number; h: number }
export type Point = [number, number];

// The points a stroke keeps and the nodes a mark names, as the comments route
// takes them (lotuspod.features.serve.spots).
const MAX_POINTS = 256;
export const MAX_NODES = 12;
// Mermaid 11.4.1's box ids, as features/blocks/ts/diagram-cards.js reads them:
// flowchart-ID-N, which the ELK layout prefixes with the svg's own id and a
// dash. An id the route would refuse is no node of a mark.
const BOX_ID = /^flowchart-(.+)-\d+$/;
const NODE_ID = /^[A-Za-z0-9_-]+$/;
const LABEL = 100;

// A target's drawing: a diagram's svg once Mermaid has drawn it in its pre,
// else null (an image, or a diagram not drawn yet).
export function drawingOf(target: HTMLElement): SVGSVGElement | null {
  return target.tagName === "PRE" ? target.querySelector<SVGSVGElement>(":scope > svg") : null;
}

// A drawn flowchart's boxes, by node id, in the order drawn.
export function nodesOf(svg: SVGSVGElement): Map<string, SVGGElement> {
  const found = new Map<string, SVGGElement>();
  const prefix = svg.id ? svg.id + "-" : "";
  svg.querySelectorAll<SVGGElement>("g.node").forEach(group => {
    const id = prefix && group.id.startsWith(prefix) ? group.id.slice(prefix.length) : group.id;
    const match = BOX_ID.exec(id);
    if (match && NODE_ID.test(match[1]) && !found.has(match[1])) found.set(match[1], group);
  });
  return found;
}

// A box's words as drawn, a space wherever its lines break, without control
// characters and at most LABEL long.
export function labelOf(group: Element): string {
  const pieces: string[] = [];
  const walk = (at: Node) => {
    if (at.nodeType === Node.TEXT_NODE) {
      pieces.push(at.nodeValue || "");
    } else if (at.nodeType === Node.ELEMENT_NODE) {
      const element = at as Element;
      const name = element.localName;
      const line = name === "br" || name === "text" || (name === "tspan" && (element.hasAttribute("x") || element.hasAttribute("y")));
      if (line) pieces.push(" ");
      element.childNodes.forEach(walk);
      if (line) pieces.push(" ");
    }
  };
  walk(group.querySelector(".nodeLabel") || group);
  return pieces.join("").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, LABEL);
}

// element's box in layer's coordinates; null while either is not drawn.
export function rectIn(layer: SVGGraphicsElement, element: SVGGraphicsElement): Rect | null {
  const from = element.getCTM();
  const to = layer.getCTM();
  if (!from || !to) return null;
  const matrix = to.inverse().multiply(from);
  const box = element.getBBox();
  return bounds([[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height],
    [box.x + box.width, box.y + box.height]].map(([x, y]) => {
    const point = new DOMPoint(x, y).matrixTransform(matrix);
    return [point.x, point.y] as Point;
  }));
}

// A point on the screen in layer's coordinates.
export function pointIn(layer: SVGGraphicsElement, x: number, y: number): Point | null {
  const matrix = layer.getScreenCTM();
  if (!matrix) return null;
  const point = new DOMPoint(x, y).matrixTransform(matrix.inverse());
  return [point.x, point.y];
}

// How many of layer's units one px on the screen is.
export function unitOf(layer: SVGGraphicsElement): number {
  const matrix = layer.getScreenCTM();
  const scale = matrix ? Math.hypot(matrix.a, matrix.b) : 0;
  return scale > 0 ? 1 / scale : 1;
}

function bounds(points: Point[]): Rect {
  const xs = points.map(point => point[0]);
  const ys = points.map(point => point[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

// The smallest rectangle holding every one of rects.
export function spanOf(rects: Rect[]): Rect {
  return bounds(rects.flatMap(rect => [[rect.x, rect.y], [rect.x + rect.w, rect.y + rect.h]] as Point[]));
}

export function grow(rect: Rect, by: number): Rect {
  return { x: rect.x - by, y: rect.y - by, w: rect.w + 2 * by, h: rect.h + 2 * by };
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

// The boxes a mark's bounding box covers, those it covers most first, at most
// MAX_NODES: a box is covered when at least half the smaller area, its own or
// the mark's, overlaps.
export function covered(mark: Rect, boxes: Map<string, Rect>): string[] {
  return [...boxes].map(([id, box]) => ({ id, area: overlap(mark, box), least: Math.min(mark.w * mark.h, box.w * box.h) }))
    .filter(each => each.area > 0 && each.area >= each.least / 2)
    .sort((a, b) => b.area - a.area)
    .slice(0, MAX_NODES)
    .map(each => each.id);
}

// At most MAX_POINTS points, thinned evenly, the first and last kept.
export function thin(points: Point[]): Point[] {
  if (points.length <= MAX_POINTS) return points;
  return Array.from({ length: MAX_POINTS }, (_, at) => points[Math.round(at * (points.length - 1) / (MAX_POINTS - 1))]);
}

// A shape's bounding box.
export function shapeBounds(shape: SpotShape): Rect {
  return shape.kind === "box" ? { x: shape.x, y: shape.y, w: shape.w, h: shape.h } : bounds(shape.points);
}

// A shape held within frame.
export function clamp(shape: SpotShape, frame: Rect): SpotShape {
  const x = (value: number) => Math.min(frame.x + frame.w, Math.max(frame.x, value));
  const y = (value: number) => Math.min(frame.y + frame.h, Math.max(frame.y, value));
  if (shape.kind === "stroke") return { kind: "stroke", points: shape.points.map(([px, py]) => [x(px), y(py)]) };
  const left = x(shape.x), top = y(shape.y);
  return { kind: "box", x: left, y: top, w: x(shape.x + shape.w) - left, h: y(shape.y + shape.h) - top };
}

// A shape in frame's coordinates as fractions of it (into), or back (out of);
// rounded to digits after the point. A box's edges are rounded, not its
// origin and size apart, so a box within the frame stays within it: its far
// edge, origin plus size, never passes the rounded one.
export function into(shape: SpotShape, frame: Rect, digits = 4): SpotShape {
  const round = (value: number) => Number(value.toFixed(digits));
  const x = (value: number) => round((value - frame.x) / frame.w);
  const y = (value: number) => round((value - frame.y) / frame.h);
  if (shape.kind === "stroke") return { kind: "stroke", points: shape.points.map(([px, py]) => [x(px), y(py)]) };
  const span = (from: number, to: number) => {
    let size = round(to - from);
    while (size > 0 && from + size > to) size = round(size - 10 ** -digits);
    return size;
  };
  const left = x(shape.x), top = y(shape.y);
  return { kind: "box", x: left, y: top, w: span(left, x(shape.x + shape.w)), h: span(top, y(shape.y + shape.h)) };
}

export function outOf(shape: SpotShape, frame: Rect): SpotShape {
  const x = (value: number) => frame.x + value * frame.w;
  const y = (value: number) => frame.y + value * frame.h;
  if (shape.kind === "stroke") return { kind: "stroke", points: shape.points.map(([px, py]) => [x(px), y(py)]) };
  return { kind: "box", x: x(shape.x), y: y(shape.y), w: shape.w * frame.w, h: shape.h * frame.h };
}
