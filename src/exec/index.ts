// The only place that starts processes (S8, agent-session.md §A7). Starts in v1: the
// agent (this binary, §A2.3), `clipboard.command` (§A5), the editor (§A6) and gpg
// (`import pass`, import-export.md §1.5). Always a program path plus an argument list;
// never a shell.

export { splitWords } from "./words.ts";
export { lookPath, NOT_FOUND, RELATIVE } from "./lookpath.ts";
export { runProcess, exitError, exitText, goSignalText, GO_SIGNAL_TEXT } from "./run.ts";
export type { RunOptions, RunResult, StdinSpec, StdoutSpec, ChildHandle } from "./run.ts";
export { spawnAgentChild, selfCommand, isCompiled, READINESS_MAX, READINESS_TIMEOUT_MS } from "./agent.ts";
export type { AgentChild, Readiness, SpawnAgentOptions } from "./agent.ts";
export { makePipe, closeQuietly } from "./pipe.ts";
