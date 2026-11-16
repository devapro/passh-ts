// The passh agent (spec §5.3, agent-session.md §A2): the `__agent` child process that
// keeps the vault key, its Unix-socket protocol, the client calls, the agent as a key
// source (§A2.8), and the cores of `unlock`, `lock`, the stop after a key change, and
// doctor's agent rows.

export { runAgentChild, parseChildArgs, parseStdinKey, STDIN_MAX } from "./child.ts";
export type { ChildArgs, ChildHooks, StdinKey } from "./child.ts";
export { AgentServer, BindError, CONN_DEADLINE_MS, OWNERSHIP_CHECK_MS } from "./server.ts";
export type { AgentServerOptions, ShutdownReason } from "./server.ts";
export {
  agentRequest,
  agentStatus,
  agentStop,
  agentKey,
  stopAgentAndWait,
  socketFor,
  isAgentError,
  CLIENT_DEADLINE_MS,
  LOCK_POLL_MS,
  LOCK_WAIT_MS,
} from "./client.ts";
export type { AgentStatus, AgentResult, ClientOptions, KeyOutcome } from "./client.ts";
export { agentKeySource, verifyKeySource, keyBlockChangedNote } from "./keysource.ts";
export type { AgentKeySourceOptions } from "./keysource.ts";
export { runUnlock, runLock, stopAgentAfterKeyChange, agentDoctorInfo } from "./commands.ts";
export type { UnlockOptions, UnlockOpened, LockOptions, AgentDoctorInfo, DoctorRow, DoctorLevel } from "./commands.ts";
export { formatAgentTimes, elapsedMs, systemClock } from "./times.ts";
export type { Clock, Instant } from "./times.ts";
export {
  PROTOCOL_VERSION,
  MAX_LINE,
  KEY_TEXT_MAX,
  WIRE,
  frameLine,
  decodeRequest,
  encodeStatus,
  encodeRefusal,
  encodeKeyResponse,
  isKeyText,
  parseKeyText,
  parseAnswer,
  keyFromAnswer,
  isHexDigest,
} from "./protocol.ts";
export type { Request, Refusal, RefusalCode, Answer, ParsedAnswer, StatusFields, Frame } from "./protocol.ts";
