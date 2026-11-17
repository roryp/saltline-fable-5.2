import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const PORT = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${PORT}`;
let server;

before(async () => {
  // Empty values win over .env, so the test never calls the model.
  server = spawn(process.execPath, [fileURLToPath(new URL("../server.js", import.meta.url))], {
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", FOUNDRY_ENDPOINT: "", FOUNDRY_DEPLOYMENT: "", FOUNDRY_API_KEY: "" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (chunk) => String(chunk).includes("running at") && resolve());
    server.once("exit", (code) => reject(new Error(`server exited with ${code}`)));
  });
});

after(() => server.kill());

describe("server", () => {
  it("serves the game but never .env, the server or lib/", async () => {
    for (const path of ["/", "/js/harbormaster.js", "/js/tactics.js", "/css/harbormaster.css"]) {
      assert.equal((await fetch(base + path)).status, 200, path);
    }
    for (const path of ["/.env", "/server.js", "/lib/prompts.js", "/package.json", "/js/../.env", "/%2e%2e/.env"]) {
      assert.equal((await fetch(base + path)).status, 404, path);
    }
  });

  it("only takes decision requests from the game's own origin", async () => {
    const post = (headers) =>
      fetch(`${base}/api/gull`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: "{}" });
    assert.equal((await post({ Origin: "https://evil.example" })).status, 403);
    // Same origin gets through to the (unconfigured) model.
    assert.equal((await post({ Origin: base })).status, 503);
    assert.deepEqual(await (await fetch(`${base}/api/status`)).json(), {
      configured: false,
      model: "Microsoft-Decision-1.1 (decision-1.1)",
      keySource: "Entra ID (Azure CLI login)",
    });
  });
});
