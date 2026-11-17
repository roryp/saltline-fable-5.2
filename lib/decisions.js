// Minimal client for Microsoft-Decision-1 on Microsoft Foundry
// (POST <foundry-endpoint>/providers/microsoft/v1/systemone).
//
// A request is a plain-text `state` plus named, typed questions:
//   choice -> { type: "choice", instructions, criteria: { value: description } }
//   score  -> { type: "score", instructions, criteria: ["level 0", "level 1", ...] }
//   noul   -> { type: "noul", instructions }   (a yes/no question, answered with a probability)
// The model answers each question with probabilities instead of text.

export const MODEL_NAME = "Microsoft-Decision-1";

export class DecisionError extends Error {
  constructor(message, { status = 0, code = null } = {}) {
    super(message);
    this.name = "DecisionError";
    this.status = status;
    this.code = code;
  }
}

export function createDecisionClient({
  endpoint,
  deployment,
  getHeaders,
  timeoutMs = 6000,
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  if (!endpoint) throw new Error("createDecisionClient: endpoint is required");
  if (typeof getHeaders !== "function") throw new Error("createDecisionClient: getHeaders is required");
  const url = `${endpoint.replace(/\/+$/, "")}/providers/microsoft/v1/systemone`;

  return {
    model: deployment,
    /** @returns {Promise<{ answers: object, usage: object|null, model: string, latencyMs: number }>} */
    async ask({ state, questions }) {
      let headers;
      try {
        headers = await getHeaders();
      } catch (err) {
        throw new DecisionError(err?.message ?? "Authentication failed", { code: "auth_error" });
      }
      const started = performance.now();
      let res;
      let text;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ model: deployment, state, questions }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await res.text();
      } catch (err) {
        const timedOut = err?.name === "TimeoutError";
        throw new DecisionError(timedOut ? `Decision API timed out after ${timeoutMs} ms` : `Network error: ${err?.message ?? err}`, {
          code: timedOut ? "timeout" : "network_error",
        });
      }
      const latencyMs = Math.round(performance.now() - started);

      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        // Not JSON; reported below.
      }
      if (!res.ok) {
        throw new DecisionError(data?.error?.message ?? `Decision API returned HTTP ${res.status}`, {
          status: res.status,
          code: data?.error?.code ?? null,
        });
      }
      if (!data || typeof data.answers !== "object" || data.answers === null || Array.isArray(data.answers)) {
        throw new DecisionError("Decision API returned an unexpected payload");
      }
      return { answers: data.answers, usage: data.usage ?? null, model: data.model ?? deployment, latencyMs };
    },
  };
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** `{ choice, confidence, probabilities: { value: p } }` when the pick is one of `values`, else null. */
export function readChoice(answer, values) {
  if (answer?.type !== "choice" || !values.includes(answer.choice)) return null;
  const probabilities = {};
  for (const value of values) {
    const p = finite(answer.probabilities?.[value]);
    if (p !== null) probabilities[value] = clamp(p, 0, 1);
  }
  return { choice: answer.choice, confidence: finite(answer.confidence), probabilities };
}

/** `{ score, confidence, probabilities: number[] }`, with the probabilities indexed by level. */
export function readScore(answer, levels) {
  const score = finite(answer?.score);
  if (answer?.type !== "score" || score === null) return null;
  const probabilities = Array.from({ length: levels }, (_, i) => clamp(finite(answer.probabilities?.[i]) ?? 0, 0, 1));
  return { score: clamp(score, 0, levels - 1), confidence: finite(answer.confidence), probabilities };
}

/** `{ probability }` for a noul (yes/no) answer. */
export function readNoul(answer) {
  const p = finite(answer?.noul);
  if (answer?.type !== "noul" || p === null) return null;
  return { probability: clamp(p, 0, 1) };
}
