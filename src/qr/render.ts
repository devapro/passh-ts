// Renderings of a QR code: terminal half blocks (print.md §6.9) and inline SVG (print.md §6.8).

import type { QrCode } from "./qr.ts";

/** The quiet zone, in modules, of both renderings. */
export const QUIET_ZONE = 4;

function isDark(qr: QrCode, x: number, y: number): boolean {
  const q = QUIET_ZONE;
  const mx = x - q;
  const my = y - q;
  return mx >= 0 && my >= 0 && mx < qr.size && my < qr.size && qr.modules[my]![mx]!;
}

/**
 * The terminal form (print.md §6.9): two module rows per text line, light modules drawn, so
 * the code reads on a dark background: both light `█`, top light and bottom dark `▀`, top dark
 * and bottom light `▄`, both dark a blank; a last odd row: light `▀`, dark a blank. Lines are
 * joined by LF, without a final LF.
 */
export function renderTerminal(qr: QrCode): string {
  const n = qr.size + 2 * QUIET_ZONE;
  const lines: string[] = [];
  for (let y = 0; y < n; y += 2) {
    let line = "";
    for (let x = 0; x < n; x++) {
      const top = isDark(qr, x, y);
      if (y + 1 >= n) {
        line += top ? " " : "▀";
        continue;
      }
      const bottom = isDark(qr, x, y + 1);
      if (!top && !bottom) line += "█";
      else if (!top && bottom) line += "▀";
      else if (top && !bottom) line += "▄";
      else line += " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/** Width and height, in terminal columns and lines, of renderTerminal's output. */
export function terminalSize(qr: QrCode): { cols: number; lines: number } {
  const n = qr.size + 2 * QUIET_ZONE;
  return { cols: n, lines: Math.ceil(n / 2) };
}

/** Escapes text for an SVG attribute value (passh's fixed strings only; `+` is kept, print.md §6.8). */
function escapeAttr(s: string): string {
  return s.replace(/[&<>'"\u0000]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "'" ? "&#39;" : c === '"' ? "&#34;" : "�"));
}

/**
 * The page form (print.md §6.8): `<svg viewBox="0 0 N N" role="img" aria-label="…"
 * shape-rendering="crispEdges"><rect width="N" height="N" fill="#fff"/><path fill="#000"
 * d="…"/></svg>`, N = modules with the quiet zone; one `M{x} {y}h{len}v1h-{len}z` per
 * horizontal run of dark modules, rows top to bottom, runs left to right.
 */
export function renderSvg(qr: QrCode, ariaLabel: string): string {
  const n = qr.size + 2 * QUIET_ZONE;
  let d = "";
  for (let y = 0; y < qr.size; y++) {
    let x = 0;
    while (x < qr.size) {
      if (!qr.modules[y]![x]) {
        x++;
        continue;
      }
      let len = 0;
      while (x + len < qr.size && qr.modules[y]![x + len]) len++;
      d += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h${len}v1h-${len}z`;
      x += len;
    }
  }
  return `<svg viewBox="0 0 ${n} ${n}" role="img" aria-label="${escapeAttr(ariaLabel)}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path fill="#000" d="${d}"/></svg>`;
}
