// QR codes for the print page and its terminal dialog (print.md §6.8, §6.9).

export { encodeText, encodeBytes, numDataCodewords, numRawDataModules } from "./qr.ts";
export type { QrCode, EccLevel } from "./qr.ts";
export { renderTerminal, renderSvg, terminalSize, QUIET_ZONE } from "./render.ts";
