// Lifecycle manager + HTTP client for the JVM sidecar (jbpm-engine/java-runtime) that runs `lang:
// 'java'` script/condition/exitScript code as real, compiled Java — never transpiled to JavaScript.
// The sidecar is a single persistent `java` process, spawned lazily on first use and reused for the
// lifetime of this server; it dynamically javac-compiles each distinct script snippet once (cached by
// source hash) and executes it against a real kcontext binding. Only the one script snippet actually
// referenced by a node is ever compiled — never the whole jBPM project, no Maven/kjar involved.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { config } from '../infra/config.ts';

function findJavaBinary(): string {
  if (process.env.JAVA_HOME && fs.existsSync(path.join(process.env.JAVA_HOME, 'bin/java'))) {
    return path.join(process.env.JAVA_HOME, 'bin/java');
  }
  for (const candidate of [
    '/opt/homebrew/opt/openjdk@17/bin/java',
    '/opt/homebrew/opt/openjdk@21/bin/java',
    '/opt/homebrew/opt/openjdk/bin/java',
    '/usr/local/opt/openjdk@17/bin/java',
    '/usr/local/opt/openjdk/bin/java',
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'java';
}

export interface PendingAction {
  kind: 'signal' | 'abort';
  /** signal name; unset for abort */
  type?: string;
  /** signal payload; unset for abort */
  payload?: unknown;
  /** signal: unset = session-wide broadcast (kcontext.getKieRuntime().signalEvent(type,event)),
   *  set = targeted delivery to this instance id. abort: always the instance id to abort. */
  targetInstanceId?: string;
}

export interface JavaExecResult {
  vars: Record<string, unknown>;
  logs: string;
  pendingActions: PendingAction[];
}

/** a currently-active node instance, as seen by kcontext.getProcessInstance().getNodeInstances() —
 *  see execution-engine.ts's HandlerCtx.tokenId comment for id vs nodeId. */
export interface ActiveNodeInstance {
  id: string;
  nodeId: string;
  nodeName?: string;
}

class JavaSidecarUnavailableError extends Error {
  constructor(detail: string) {
    super(`Java sidecar unavailable — Java script/condition/exitScript code cannot run without it (this engine never falls back to transpiling Java to JavaScript). ${detail}`);
    this.name = 'JavaSidecarUnavailableError';
  }
}

let child: ChildProcess | undefined;
let port: number | undefined;
let starting: Promise<number> | undefined;

function start(): Promise<number> {
  if (starting) return starting;
  starting = new Promise<number>((resolve, reject) => {
    // a bounded, small JVM (serial GC, client-tier JIT): the sidecar only compiles and runs short scripts, and the default heap of a quarter of the machine's RAM can get it killed under memory pressure
    const jvmOpts = (process.env.JAVA_SIDECAR_OPTS ?? '-Xms32m -Xmx384m -XX:+UseSerialGC -XX:TieredStopAtLevel=1 -Xshare:auto').split(/\s+/).filter(Boolean);
    const proc = spawn(findJavaBinary(), [...jvmOpts, '-cp', config.javaSidecarClasspath, 'bpmscript.Server', '0'], {
      stdio: ['pipe', 'pipe', 'pipe'],                                  // stdin stays open: its closing tells the JVM its parent is gone
      env: { ...process.env, BPMSCRIPT_EXIT_WITH_PARENT: '1' },
    });
    child = proc;
    let stderrBuf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(new JavaSidecarUnavailableError(`Timed out waiting for it to start (>${config.javaSidecarStartupTimeoutMs}ms). stderr: ${stderrBuf.trim() || '(empty)'}`));
    }, config.javaSidecarStartupTimeoutMs);

    proc.stdout?.on('data', (chunk: Buffer) => {
      const m = /BPMSCRIPT_LISTENING (\d+)/.exec(chunk.toString('utf8'));
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        port = Number(m[1]);
        resolve(port);
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString('utf8'); });
    proc.on('exit', (code, signal) => {
      const wasRunning = child === proc;
      child = undefined;
      port = undefined;
      starting = undefined;
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new JavaSidecarUnavailableError(
          `The sidecar process exited during startup (code ${code}${signal ? `, signal ${signal}` : ''}). This usually means no JDK is on PATH ` +
          `(a JRE alone can't compile scripts — javax.tools.ToolProvider.getSystemJavaCompiler() needs a JDK), ` +
          `or the classpath "${config.javaSidecarClasspath}" doesn't have compiled bpmscript classes yet. stderr: ${stderrBuf.trim() || '(empty)'}`
        ));
      } else if (wasRunning) {
        // died after a successful start (mid-session) — next execute() call will respawn it
      }
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new JavaSidecarUnavailableError(`Failed to spawn the "java" executable: ${err.message}. Is a JDK installed and on PATH?`));
    });
  });
  return starting;
}

async function ensureStarted(): Promise<number> {
  if (port !== undefined && child) return port;
  return start();
}

/** Stops the sidecar (if running) — used by tests and graceful server shutdown. */
export function stopJavaSidecar(): void {
  if (child) { child.kill(); child = undefined; }
  port = undefined;
  starting = undefined;
}

export interface JavaExecRequest {
  code: string;
  vars: Record<string, unknown>;
  env?: Record<string, string>;
  instanceId?: string | number;
  /** the current active token's id (node-*instance*-level id) — see HandlerCtx.tokenId. Distinct
   *  from `nodeId` below, the node *definition* id. */
  nodeInstanceId?: string;
  nodeId?: string;
  nodeName?: string;
  /** declared process variable types (name -> structureRef, e.g. "String"/"java.lang.Double"/
   *  "java.util.List") — conditions only. Real jBPM's Java condition dialect binds every declared
   *  process variable as a bare, typed local identifier (confirmed against this project's own real
   *  conditions, e.g. `return retryCount < maxRetryCount;`), not just via kcontext.getVariable. */
  varTypes?: Record<string, string>;
  processId?: string;
  processName?: string;
  correlationKey?: string;
  parentInstanceId?: string;
  /** this engine's own instance status string ("running"/"waiting"/"completed"/"aborted"/
   *  "suspended"/"failed") — mapped to real jBPM's ProcessInstance.STATE_* int constants on the
   *  Java side (see Server.java's stateFor()). */
  state?: string;
  /** currently-active node instances, for kcontext.getProcessInstance().getNodeInstances() — a
   *  snapshot built by the caller (see gateway/handler.ts / script/handler.ts), not live-queried. */
  activeNodeInstances?: ActiveNodeInstance[];
}

type SidecarResponse = {
  ok: boolean;
  vars?: Record<string, unknown>;
  logs?: string;
  pendingActions?: PendingAction[];
  result?: boolean;
  error?: string;
};

// At most this many requests are in flight at once: a burst (publish validation compiles ~200 scripts) would otherwise pile onto a cold JVM, push slow
// ones past the timeout, and each timeout used to kill the JVM for everybody.
const MAX_IN_FLIGHT = Math.max(1, Number(process.env.JAVA_SIDECAR_CONCURRENCY || 6));
let inFlight = 0;
const waiting: Array<() => void> = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((r) => waiting.push(r));
  inFlight++;
  try { return await fn(); } finally { inFlight--; waiting.shift()?.(); }
}

function callSidecar(body: Record<string, unknown>): Promise<SidecarResponse> { return slot(() => callSidecarNow(body)); }

async function callSidecarNow(body: Record<string, unknown>): Promise<SidecarResponse> {
  const p = await ensureStarted();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.javaSidecarTimeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${p}/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return await res.json() as SidecarResponse;
  } catch (e) {
    // ECONNREFUSED etc. — the process may have died between ensureStarted() and this call; the
    // caller's next attempt will trigger a fresh spawn via ensureStarted().
    // Only a JVM that is really gone is replaced. A request that merely timed out (aborted) must not take down the shared process with every other request in it.
    const aborted = (e as Error).name === 'AbortError';
    if (!aborted && child && (child.exitCode !== null || child.signalCode !== null || /ECONNREFUSED|ECONNRESET|socket hang up|fetch failed/i.test(String((e as any)?.cause?.code ?? (e as Error).message)))) {
      child.kill(); child = undefined; port = undefined; starting = undefined;
    }
    throw new JavaSidecarUnavailableError(`Request to the sidecar ${aborted ? 'timed out' : 'failed'}: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

function requestFields(req: JavaExecRequest) {
  return {
    instanceId: req.instanceId == null ? '' : String(req.instanceId),
    nodeInstanceId: req.nodeInstanceId, nodeId: req.nodeId, nodeName: req.nodeName,
    processId: req.processId, processName: req.processName, correlationKey: req.correlationKey,
    parentInstanceId: req.parentInstanceId, state: req.state, activeNodeInstances: req.activeNodeInstances || [],
  };
}

/** script / onEntry / onExit body — statements only, no return value (matches real jBPM). Real
 *  jBPM's own Java script/onEntry/onExit dialect ALSO binds declared process variables as bare
 *  identifiers, via the identical unbound-identifier mechanism (JavaActionBuilder) conditions use —
 *  confirmed against jBPM's own build-time codegen templates, not just an extension this engine
 *  invented (an earlier pass through this code assumed conditions-only; that was wrong). `varTypes`
 *  supplies the declared-variable-name-to-type map that makes this binding possible either way. */
export async function executeJava(req: JavaExecRequest): Promise<JavaExecResult> {
  const json = await callSidecar({
    code: req.code, vars: req.vars, env: req.env || {}, varTypes: req.varTypes || {},
    ...requestFields(req),
  });
  if (!json.ok) throw new Error(json.error || 'java execution failed');
  return { vars: json.vars || {}, logs: json.logs || '', pendingActions: json.pendingActions || [] };
}

/** sequence-flow / gateway condition — a boolean Java expression. */
export async function executeJavaCondition(req: JavaExecRequest): Promise<boolean> {
  const json = await callSidecar({
    mode: 'condition', code: req.code, vars: req.vars, env: req.env || {}, varTypes: req.varTypes || {},
    ...requestFields(req),
  });
  if (!json.ok) throw new Error(json.error || 'java condition evaluation failed');
  return !!json.result;
}

/** Publish-time dry compile — real ground truth (the exact javac used at runtime), not a heuristic.
 *  Returns the compiler's own diagnostic message on failure instead of throwing, since a validator's
 *  job is to report problems, not to abort the caller's control flow. `varTypes` matters only when
 *  `asCondition` — see executeJavaCondition. */
export async function validateJava(code: string, asCondition: boolean, varTypes?: Record<string, string>): Promise<{ ok: true } | { ok: false; error: string }> {
  const json = await callSidecar({ mode: 'validate', code, asCondition, vars: {}, env: {}, varTypes: varTypes || {} });
  return json.ok ? { ok: true } : { ok: false, error: json.error || 'java validation failed' };
}
