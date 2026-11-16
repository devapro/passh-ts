// The one-shot print page (spec §7.4, print.md §6): server, certificate, page and dialog.

export {
  startPrintPage,
  checkSettings,
  newToken,
  hostAllowed,
  parseTarget,
  DEFAULT_PRINT_WEB,
  MAX_WRONG_TOKENS,
  SERVE_WAIT_MS,
  type PrintPage,
  type PrintPageResult,
  type PrintWebSettings,
  type Outcome,
  type StartOptions,
} from "./server.ts";
export { planAddresses, allowedRanges, noAddressError, pageUrl, peerAddress, peerAllowed, isPrivate, unmap, type AddressPlan, type BoundAddr } from "./addrs.ts";
export { loadOrCreateCertificate, certificateNotice, type CertPair } from "./cert.ts";
export { makeCertificate, parseCertificate, fingerprint, pem, pemBlock, keyMatches, loadPrivateKey } from "./x509.ts";
export { renderPage, pagePieces, escapeHtml, escapeHtmlKeepPlus, marksHtml, contentSecurityPolicy, styleHash, pageTip, CSS, WHOLE_BLOCK_ROWS } from "./page.ts";
export { runDialog, dialogLines, countdown, type DialogTty, type DialogClipboard, type DialogOptions } from "./dialog.ts";
export { listInterfaces, type Interface, type IfAddr } from "./ifaddrs.ts";
