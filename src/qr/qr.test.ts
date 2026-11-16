// QR encoder (print.md §6.8, §6.9): codes the reference drew for the same inputs, module for module.

import { describe, expect, test } from "bun:test";
import { encodeText, numDataCodewords, renderSvg, renderTerminal, terminalSize } from "./index.ts";

// Captured from reference/passh-go: the dialog's QR code of a URL (level L) and the page's
// SVG of a (throwaway test vault's) recovery key (level M).
const URL_VECTOR = "https://172.21.0.1:22859/p/gQw1cV17Q8w_HvjPFIykAQ";
const URL_QR = "█████████████████████████████████████\n█████████████████████████████████████\n████ ▄▄▄▄▄ █▀▄█▀ ▄▀██▀██▄█ ▄▄▄▄▄ ████\n████ █   █ █▄   ▄█ ▀▄▄ ▀▀█ █   █ ████\n████ █▄▄▄█ █ ▀█▀█▀█▄▄█▄▀▀█ █▄▄▄█ ████\n████▄▄▄▄▄▄▄█ ▀▄█ █ ▀▄█ ▀▄█▄▄▄▄▄▄▄████\n████▄▄▀▄▀▀▄▄██ ▀▄ █▀  █  █ ▄▄▀▄▄▀████\n████▀▄▄██ ▄█▀▄▄█ ▄▄▀ ▀▄█ ▄▀█▄▄  █████\n███████▄▄ ▄▀█▀▀▀ ▀▀ █▄ █  ▄▀█▄█▄▄████\n████▀▀▄▀█▀▄ █▄▀ ▀█▀  ▄▀   ▄▄  ▄ ▄████\n████▄▀█▄▄▀▄▀▀█▄█▄█ ▀▀▀   ▀██▀▀█▄▀████\n████▄██ ▄▀▄█ ▀ ▀▀█   ▀▀▄ ▀██ ██  ████\n████▄█▄██▄▄▄▀▀▄█▄▀▄ ▀ █  ▄▄▄ █ ▀▀████\n████ ▄▄▄▄▄ █▄▄▀▄▀ ▄▀ ▀▀▀ █▄█ ▀▀ █████\n████ █   █ █▀▀██ ▀   █▀█▄▄▄ ▄▀▀▀▀████\n████ █▄▄▄█ █▀▀█▀▀▀▀ ▀▄█▀ ▀█ ▄ ▄▀▄████\n████▄▄▄▄▄▄▄█▄█▄█▄█▄████▄████▄█▄▄█████\n█████████████████████████████████████\n▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀";
const KEY_VECTOR = "AGE-SECRET-KEY-1AS0SM78YS5A7LV78VLDN2GLNX9FVSN4HX7ZNJ9UHVZW7RNEL90ZSCKPUTK";
const KEY_SVG = "<svg viewBox=\"0 0 41 41\" role=\"img\" aria-label=\"QR code of the vault key\" shape-rendering=\"crispEdges\"><rect width=\"41\" height=\"41\" fill=\"#fff\"/><path fill=\"#000\" d=\"M4 4h7v1h-7zM12 4h1v1h-1zM17 4h1v1h-1zM20 4h1v1h-1zM22 4h1v1h-1zM24 4h5v1h-5zM30 4h7v1h-7zM4 5h1v1h-1zM10 5h1v1h-1zM13 5h2v1h-2zM16 5h3v1h-3zM22 5h1v1h-1zM24 5h1v1h-1zM28 5h1v1h-1zM30 5h1v1h-1zM36 5h1v1h-1zM4 6h1v1h-1zM6 6h3v1h-3zM10 6h1v1h-1zM15 6h1v1h-1zM18 6h1v1h-1zM21 6h2v1h-2zM25 6h1v1h-1zM27 6h1v1h-1zM30 6h1v1h-1zM32 6h3v1h-3zM36 6h1v1h-1zM4 7h1v1h-1zM6 7h3v1h-3zM10 7h1v1h-1zM12 7h2v1h-2zM16 7h1v1h-1zM19 7h3v1h-3zM25 7h1v1h-1zM27 7h2v1h-2zM30 7h1v1h-1zM32 7h3v1h-3zM36 7h1v1h-1zM4 8h1v1h-1zM6 8h3v1h-3zM10 8h1v1h-1zM12 8h1v1h-1zM14 8h1v1h-1zM20 8h1v1h-1zM23 8h1v1h-1zM25 8h2v1h-2zM28 8h1v1h-1zM30 8h1v1h-1zM32 8h3v1h-3zM36 8h1v1h-1zM4 9h1v1h-1zM10 9h1v1h-1zM12 9h2v1h-2zM15 9h5v1h-5zM22 9h1v1h-1zM24 9h1v1h-1zM27 9h1v1h-1zM30 9h1v1h-1zM36 9h1v1h-1zM4 10h7v1h-7zM12 10h1v1h-1zM14 10h1v1h-1zM16 10h1v1h-1zM18 10h1v1h-1zM20 10h1v1h-1zM22 10h1v1h-1zM24 10h1v1h-1zM26 10h1v1h-1zM28 10h1v1h-1zM30 10h7v1h-7zM12 11h2v1h-2zM22 11h3v1h-3zM26 11h3v1h-3zM4 12h1v1h-1zM8 12h1v1h-1zM10 12h4v1h-4zM15 12h1v1h-1zM17 12h1v1h-1zM19 12h2v1h-2zM24 12h3v1h-3zM28 12h6v1h-6zM36 12h1v1h-1zM4 13h2v1h-2zM7 13h3v1h-3zM15 13h2v1h-2zM20 13h2v1h-2zM23 13h1v1h-1zM25 13h3v1h-3zM29 13h1v1h-1zM31 13h4v1h-4zM36 13h1v1h-1zM4 14h3v1h-3zM8 14h1v1h-1zM10 14h1v1h-1zM12 14h4v1h-4zM17 14h2v1h-2zM22 14h1v1h-1zM24 14h2v1h-2zM28 14h3v1h-3zM35 14h2v1h-2zM6 15h2v1h-2zM11 15h1v1h-1zM14 15h1v1h-1zM16 15h2v1h-2zM19 15h1v1h-1zM23 15h2v1h-2zM26 15h4v1h-4zM31 15h3v1h-3zM36 15h1v1h-1zM4 16h2v1h-2zM7 16h8v1h-8zM17 16h1v1h-1zM20 16h1v1h-1zM24 16h1v1h-1zM27 16h3v1h-3zM31 16h3v1h-3zM35 16h2v1h-2zM4 17h4v1h-4zM9 17h1v1h-1zM11 17h1v1h-1zM13 17h2v1h-2zM17 17h2v1h-2zM21 17h5v1h-5zM30 17h1v1h-1zM32 17h2v1h-2zM35 17h1v1h-1zM4 18h1v1h-1zM7 18h1v1h-1zM10 18h1v1h-1zM13 18h1v1h-1zM15 18h1v1h-1zM17 18h1v1h-1zM19 18h1v1h-1zM21 18h1v1h-1zM24 18h5v1h-5zM30 18h2v1h-2zM5 19h5v1h-5zM12 19h1v1h-1zM14 19h1v1h-1zM16 19h5v1h-5zM24 19h2v1h-2zM27 19h1v1h-1zM29 19h1v1h-1zM31 19h1v1h-1zM35 19h1v1h-1zM5 20h1v1h-1zM8 20h1v1h-1zM10 20h1v1h-1zM13 20h3v1h-3zM18 20h1v1h-1zM22 20h1v1h-1zM24 20h1v1h-1zM26 20h2v1h-2zM29 20h3v1h-3zM34 20h1v1h-1zM5 21h5v1h-5zM12 21h3v1h-3zM16 21h3v1h-3zM20 21h1v1h-1zM22 21h1v1h-1zM24 21h1v1h-1zM28 21h2v1h-2zM32 21h2v1h-2zM35 21h1v1h-1zM7 22h1v1h-1zM10 22h1v1h-1zM12 22h1v1h-1zM15 22h1v1h-1zM19 22h3v1h-3zM24 22h1v1h-1zM27 22h3v1h-3zM31 22h1v1h-1zM34 22h2v1h-2zM4 23h2v1h-2zM8 23h1v1h-1zM11 23h2v1h-2zM14 23h4v1h-4zM21 23h2v1h-2zM26 23h1v1h-1zM30 23h2v1h-2zM33 23h1v1h-1zM4 24h1v1h-1zM6 24h2v1h-2zM10 24h1v1h-1zM12 24h3v1h-3zM16 24h2v1h-2zM19 24h1v1h-1zM22 24h1v1h-1zM24 24h1v1h-1zM27 24h1v1h-1zM29 24h1v1h-1zM32 24h2v1h-2zM4 25h3v1h-3zM8 25h2v1h-2zM12 25h1v1h-1zM15 25h4v1h-4zM20 25h1v1h-1zM24 25h2v1h-2zM33 25h1v1h-1zM36 25h1v1h-1zM7 26h2v1h-2zM10 26h1v1h-1zM12 26h5v1h-5zM20 26h3v1h-3zM24 26h2v1h-2zM27 26h2v1h-2zM30 26h4v1h-4zM11 27h1v1h-1zM13 27h1v1h-1zM16 27h3v1h-3zM24 27h3v1h-3zM30 27h2v1h-2zM35 27h1v1h-1zM4 28h2v1h-2zM7 28h2v1h-2zM10 28h2v1h-2zM13 28h5v1h-5zM19 28h2v1h-2zM26 28h1v1h-1zM28 28h6v1h-6zM36 28h1v1h-1zM12 29h1v1h-1zM14 29h1v1h-1zM16 29h1v1h-1zM21 29h2v1h-2zM24 29h5v1h-5zM32 29h2v1h-2zM35 29h2v1h-2zM4 30h7v1h-7zM12 30h1v1h-1zM14 30h2v1h-2zM17 30h1v1h-1zM20 30h1v1h-1zM22 30h1v1h-1zM24 30h2v1h-2zM27 30h2v1h-2zM30 30h1v1h-1zM32 30h3v1h-3zM4 31h1v1h-1zM10 31h1v1h-1zM15 31h1v1h-1zM17 31h2v1h-2zM20 31h1v1h-1zM25 31h4v1h-4zM32 31h3v1h-3zM4 32h1v1h-1zM6 32h3v1h-3zM10 32h1v1h-1zM12 32h4v1h-4zM19 32h2v1h-2zM23 32h1v1h-1zM25 32h1v1h-1zM27 32h8v1h-8zM36 32h1v1h-1zM4 33h1v1h-1zM6 33h3v1h-3zM10 33h1v1h-1zM14 33h2v1h-2zM18 33h1v1h-1zM22 33h3v1h-3zM27 33h1v1h-1zM30 33h4v1h-4zM35 33h1v1h-1zM4 34h1v1h-1zM6 34h3v1h-3zM10 34h1v1h-1zM13 34h4v1h-4zM19 34h1v1h-1zM21 34h1v1h-1zM25 34h1v1h-1zM27 34h1v1h-1zM30 34h2v1h-2zM33 34h1v1h-1zM4 35h1v1h-1zM10 35h1v1h-1zM13 35h3v1h-3zM17 35h5v1h-5zM24 35h1v1h-1zM26 35h1v1h-1zM28 35h2v1h-2zM32 35h1v1h-1zM34 35h1v1h-1zM36 35h1v1h-1zM4 36h7v1h-7zM12 36h2v1h-2zM20 36h1v1h-1zM22 36h2v1h-2zM25 36h3v1h-3zM29 36h2v1h-2zM33 36h4v1h-4z\"/></svg>";

describe("reference vectors", () => {
  test("a URL at level L: version 3, mixed segments, the reference's mask", () => {
    const qr = encodeText(URL_VECTOR, "L");
    expect(qr.version).toBe(3);
    expect(qr.mask).toBe(7);
    expect(renderTerminal(qr)).toBe(URL_QR);
    expect(terminalSize(qr)).toEqual({ cols: 37, lines: 19 });
  });

  test("a recovery key at level M: version 4 (41 modules with the quiet zone)", () => {
    const qr = encodeText(KEY_VECTOR, "M");
    expect(qr.version).toBe(4);
    expect(renderSvg(qr, "QR code of the vault key")).toBe(KEY_SVG);
  });
});

describe("structure", () => {
  test("data capacities of known versions", () => {
    // Standard data codeword counts (ISO 18004 table 7).
    expect(numDataCodewords(1, "L")).toBe(19);
    expect(numDataCodewords(1, "H")).toBe(9);
    expect(numDataCodewords(3, "L")).toBe(55);
    expect(numDataCodewords(4, "M")).toBe(64);
    expect(numDataCodewords(10, "M")).toBe(216);
    expect(numDataCodewords(40, "L")).toBe(2956);
    expect(numDataCodewords(40, "H")).toBe(1276);
  });

  test("the smallest version that fits", () => {
    expect(encodeText("A", "L").version).toBe(1);
    expect(encodeText("x".repeat(17), "L").version).toBe(1); // 17 bytes: v1-L byte capacity
    expect(encodeText("x".repeat(18), "L").version).toBe(2);
    expect(encodeText("1".repeat(41), "L").version).toBe(1); // numeric capacity 41
    expect(encodeText("x".repeat(2953), "L").version).toBe(40);
    expect(() => encodeText("x".repeat(2954), "L")).toThrow();
  });

  test("finder patterns, timing and the dark module", () => {
    const qr = encodeText("https://192.168.1.10:8443/p/kq7Zabcdefghijklmnopqr", "L");
    const m = qr.modules;
    const n = qr.size;
    for (const [x0, y0] of [[0, 0], [n - 7, 0], [0, n - 7]] as const) {
      for (let i = 0; i < 7; i++) {
        expect(m[y0]![x0 + i]).toBe(true);
        expect(m[y0 + 6]![x0 + i]).toBe(true);
        expect(m[y0 + i]![x0]).toBe(true);
      }
      expect(m[y0 + 1]![x0 + 1]).toBe(false);
      expect(m[y0 + 3]![x0 + 3]).toBe(true);
    }
    for (let i = 8; i < n - 8; i++) expect(m[6]![i]).toBe(i % 2 === 0);
    expect(m[n - 8]![8]).toBe(true);
  });

  test("terminal rendering: light modules drawn, two rows per line, odd last row", () => {
    const qr = encodeText("A", "L"); // 21 modules + 8 = 29 rows: 15 lines
    const lines = renderTerminal(qr).split("\n");
    expect(lines.length).toBe(15);
    expect(lines[0]).toBe("█".repeat(29));
    expect(lines[14]).toBe("▀".repeat(29));
    for (const l of lines) expect([...l].length).toBe(29);
  });

  test("SVG: one path segment per horizontal run, no href, src or xmlns", () => {
    const svg = renderSvg(encodeText("A", "M"), "a & b");
    expect(svg).toStartWith('<svg viewBox="0 0 29 29" role="img" aria-label="a &amp; b" shape-rendering="crispEdges"><rect width="29" height="29" fill="#fff"/><path fill="#000" d="M4 4h7v1h-7z');
    expect(svg).not.toMatch(/href|src|xmlns/);
  });
});
