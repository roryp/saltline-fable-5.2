import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDecisionClient, DecisionError, readChoice, readNoul, readScore } from "../lib/decisions.js";

function fakeFetch(status, body) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
  };
  return { impl, calls };
}

const auth = async () => ({ Authorization: "Bearer tok" });

describe("createDecisionClient", () => {
  it("posts the state and typed questions to the Foundry systemone endpoint", async () => {
    const { impl, calls } = fakeFetch(200, {
      model: "microsoft-decision-1",
      answers: { ram: { type: "noul", noul: 0.3 } },
      usage: { input_tokens: 404, output_tokens: 3 },
    });
    const client = createDecisionClient({ endpoint: "https://res.cognitiveservices.azure.com/", deployment: "decision-1-dz", getHeaders: auth, fetchImpl: impl });
    const questions = { ram: { type: "noul", instructions: "Ram?" } };
    const result = await client.ask({ state: "G-12 is hit", questions });

    assert.equal(calls[0].url, "https://res.cognitiveservices.azure.com/providers/microsoft/v1/systemone");
    assert.equal(calls[0].init.headers.Authorization, "Bearer tok");
    assert.deepEqual(JSON.parse(calls[0].init.body), { model: "decision-1-dz", state: "G-12 is hit", questions });
    assert.deepEqual(result.answers, { ram: { type: "noul", noul: 0.3 } });
    assert.equal(result.usage.input_tokens, 404);
  });

  it("turns HTTP errors, timeouts and odd payloads into DecisionError", async () => {
    const ask = (fetchImpl) =>
      createDecisionClient({ endpoint: "https://x", deployment: "d", getHeaders: auth, fetchImpl }).ask({ state: "s", questions: {} });

    await assert.rejects(ask(fakeFetch(429, { error: { message: "Too many requests", code: "429" } }).impl), (err) => {
      assert.ok(err instanceof DecisionError);
      return err.status === 429 && err.message === "Too many requests";
    });
    const timeout = async () => {
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    };
    await assert.rejects(ask(timeout), { code: "timeout" });
    await assert.rejects(ask(fakeFetch(200, { answers: [] }).impl), /unexpected payload/);
  });
});

describe("answer readers", () => {
  it("keep only well-formed answers", () => {
    assert.deepEqual(readChoice({ type: "choice", choice: "dive", probabilities: { dive: 0.7, nope: 0.3 } }, ["dive", "climb"]), {
      choice: "dive",
      confidence: null,
      probabilities: { dive: 0.7 },
    });
    assert.equal(readChoice({ type: "choice", choice: "nope" }, ["dive"]), null);
    assert.equal(readScore({ type: "score", score: 9 }, 5).score, 4);
    assert.equal(readScore({ type: "score", score: "2" }, 5), null);
    assert.deepEqual(readNoul({ type: "noul", noul: 0.25 }), { probability: 0.25 });
    assert.equal(readNoul({ type: "refusal" }), null);
  });
});
