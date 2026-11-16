// OSC 52 bytes (agent-session.md §A5): ESC ] 5 2 ; c ; <base64> BEL, standard base64 with
// padding and no line breaks of the value's UTF-8 bytes. No tmux/screen passthrough
// wrapper and no length limit (spec audit #27, reproduced: terminals may drop long payloads).

const encoder = new TextEncoder();

/** The sequence that puts value on the clipboard: `\x1b]52;c;<base64>\x07`. */
export function osc52Sequence(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return "\x1b]52;c;" + Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64") + "\x07";
}

/** The sequence that clears the clipboard: `\x1b]52;c;\x07`. */
export const OSC52_CLEAR = "\x1b]52;c;\x07";
