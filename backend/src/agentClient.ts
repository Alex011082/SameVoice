import type { Config } from "./config.js";
import type { AgentJob, AgentVerdict } from "./types.js";

export interface DispatchResult {
  dispatched: boolean;
  error?: string;
}

const TIMEOUT_MS = 2000;

function describe(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return `agent did not respond within ${TIMEOUT_MS}ms`;
    }
    const cause = (err as { cause?: { code?: string } }).cause;
    if (cause?.code) return `${err.message} (${cause.code})`;
    return err.message;
  }
  return String(err);
}

/**
 * Never throws into the request path: a dead agent degrades the call, it does not fail
 * call creation. Callers surface the message through Call.agent.error.
 */
export async function dispatchAgent(cfg: Config, job: AgentJob): Promise<DispatchResult> {
  try {
    const res = await fetch(`${cfg.agentUrl}/jobs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-speakeasy-agent-key": cfg.agentSharedSecret,
      },
      body: JSON.stringify(job),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 202 || res.status === 409) {
      return { dispatched: true };
    }
    const body = await res.text().catch(() => "");
    return { dispatched: false, error: `agent returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}` };
  } catch (err) {
    return { dispatched: false, error: describe(err) };
  }
}

export type VerdictOutcome =
  | { ok: true; body: unknown }
  | { ok: false; kind: "not_found" | "unreachable"; error: string };

/**
 * Forwards a bilingual judge's verdict to the agent, which owns the JSONL eval log.
 * Unlike dispatch, the result IS surfaced to the caller: a verdict that silently
 * vanished would be worse than none — the tester would believe the label landed.
 */
export async function sendVerdict(cfg: Config, verdict: AgentVerdict): Promise<VerdictOutcome> {
  try {
    const res = await fetch(`${cfg.agentUrl}/jobs/${encodeURIComponent(verdict.callId)}/verdict`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-speakeasy-agent-key": cfg.agentSharedSecret,
      },
      body: JSON.stringify(verdict),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const raw = await res.text().catch(() => "");
    let body: unknown = raw;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      /* keep the raw text; the agent is expected to send JSON but must not be trusted to */
    }
    if (res.ok) return { ok: true, body };
    if (res.status === 404) {
      return {
        ok: false,
        kind: "not_found",
        error: `agent has no eval log for call ${verdict.callId}${raw ? `: ${raw.slice(0, 200)}` : ""}`,
      };
    }
    return {
      ok: false,
      kind: "unreachable",
      error: `agent returned ${res.status}${raw ? `: ${raw.slice(0, 200)}` : ""}`,
    };
  } catch (err) {
    return { ok: false, kind: "unreachable", error: describe(err) };
  }
}

export async function stopAgent(cfg: Config, callId: string): Promise<DispatchResult> {
  try {
    const res = await fetch(`${cfg.agentUrl}/jobs/${encodeURIComponent(callId)}/stop`, {
      method: "POST",
      headers: { "x-speakeasy-agent-key": cfg.agentSharedSecret },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok || res.status === 404) return { dispatched: false };
    return { dispatched: false, error: `agent returned ${res.status}` };
  } catch (err) {
    return { dispatched: false, error: describe(err) };
  }
}
