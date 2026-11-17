# Saltline — Fable 5.2 FPS, Microsoft-Decision-1 edition

A small browser first-person shooter: one level in a rainy container port. Cut three uplink relays while drones
("Gulls") and robot dogs ("Hounds") hunt you. In this fork, every Gull and Hound that is hunting you decides its next
move with [Microsoft-Decision-1](https://ai.azure.com/catalog/models/Microsoft-Decision-1) on Microsoft Foundry, the
model behind the rivals in [LUNA GP](https://github.com/roryp/racing). The model answers typed questions (`choice`,
`score`, `noul`) with probabilities instead of text.

![Gull G-14 rams the player while the Harbormaster panel shows each machine's latest decision](docs/harbormaster.jpg)

## Deploy to Azure

One command creates the game's own Microsoft-Decision-1 deployment, hosts the game on App Service and connects the two
with a managed identity. You need the [Azure Developer CLI](https://aka.ms/azd-install) (azd) 1.18+ and an Azure
subscription where you can create resources and assign roles, for example as Owner.

```sh
azd auth login
azd up
```

`azd up` asks for an environment name, a subscription and a region. It only offers regions with enough
Microsoft-Decision-1 quota, and prints the game's URL when it finishes. Everything goes in one resource group:

| Resource | Purpose |
| --- | --- |
| Microsoft Foundry resource with a `decision-1` deployment | Microsoft-Decision-1, GlobalStandard, 1,000 requests a minute. API keys are turned off. |
| User-assigned managed identity | The server's identity. It has the Cognitive Services User role on the Foundry resource, and so do you. |
| App Service plan (Linux, P0v3) and web app | Runs `server.js` on Node 24 LTS with a dedicated vCPU and 4 GB. |

There are no keys or secrets: the server gets Entra ID tokens for its managed identity. A new role assignment can take a
few minutes to apply; until then the machines use the built-in AI.

The P0v3 plan costs about US$57–70 a month, depending on the region, for as long as it exists; the model is billed per
token. In a load test it served about 880 decisions a minute (eight fights) at under 15% CPU. `azd down --purge` deletes
everything.

To change a default, run `azd env set <variable> <value>` and then `azd up` again:

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_SERVICE_SKU` | `P0v3` | App Service plan size, for example `P1v3` |
| `DECISION_SKU` | `GlobalStandard` | `DataZoneStandard` keeps processing inside the US or EU data zone |
| `DECISION_CAPACITY` | `1000` | Model requests a minute (and thousands of tokens a minute); a fight uses about 110 |

DataZoneStandard quota is shared by all the regions in a data zone, so another Microsoft-Decision-1 deployment in the
same subscription may already be using it up.

## Run it locally

Requires Node.js 20.12+ and the Azure CLI signed in (`az login`) with access to a Microsoft-Decision-1 deployment.
There are no npm dependencies.

```sh
azd env get-values > .env   # after azd up; or copy .env.example and set FOUNDRY_ENDPOINT to your own Foundry resource
npm start
```

In Windows PowerShell 5.1, `>` writes UTF-16, which Node can't read: use `azd env get-values | Set-Content .env` there.

Open <http://127.0.0.1:8731>, or the URL `azd up` printed, and click the page to capture the mouse and start the sound.
Press **T** to cycle the AI tags and the Harbormaster panel.

Without `FOUNDRY_ENDPOINT`, or from a plain static server (`python3 -m http.server 8731`), the Gulls and Hounds use the
game's built-in AI.

## How the machines use Microsoft-Decision-1

| Who | When | Questions |
| --- | --- | --- |
| **Each Gull** (drone) | Every 1.3–2.1 s while it hunts you | `choice` maneuver, `score` aggression, `noul` ram you? |
| **Each Hound** (robot dog) | Every 1.3–2.1 s while it hunts you | `choice` tactic, `score` aggression, `noul` charge? |

Each request describes the situation from that machine's point of view: its hull, range and height, whether it can see
you and where you are looking, your health and what you are doing (reloading, sprinting, aiming), the orders of the rest
of the squad, and how many relays you have cut. The game's own AI still flies, walks, aims and shoots; the answers steer
it:

| Answer | Effect |
| --- | --- |
| Gull maneuver: `circle`, `crossfire`, `dive`, `climb` | Orbit radius, altitude and direction round you |
| Hound tactic: `cover`, `flank`, `crossfire`, `hold`, `fall_back` | Where the Hound picks its next firing spot |
| Aggression: 0 Hold fire … 4 Relentless | Fire rate; below 0.5 the machine holds fire |
| Ram, asked when a Gull is at half hull or less | p ≥ 0.25: the Gull dives into you and self-destructs |
| Charge, asked when a Hound sees you within 16 m | p ≥ 0.4: the Hound sprints in to bite, at most every 6 s |

The ram and charge thresholds sit below 0.5 because the model is cautious about drastic moves. A decision is about 500
input tokens, and a fight with five machines makes about 110 calls a minute. If a call fails, that machine falls back to
the built-in AI until the next answer.

Tags over the machines you can see show their current order. The Harbormaster panel shows each answer: the `choice`
probabilities, the aggression `score`, and the `noul` probability against its threshold.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `FOUNDRY_ENDPOINT` | – | Foundry resource endpoint (required for model decisions) |
| `FOUNDRY_DEPLOYMENT` | `decision-1` | Model deployment name |
| `FOUNDRY_API_KEY` | unset | Optional key auth; otherwise Entra ID: the App Service managed identity, else the Azure CLI login |
| `AZURE_CLIENT_ID` | unset | Client ID of the user-assigned managed identity to use on App Service |
| `PORT` / `HOST` | `8731` / `127.0.0.1` | Listen address |
| `DAILY_CALL_LIMIT` | `20000` | Most model calls per UTC day |
| `LOG_DECISIONS` | unset | `1` logs every decision |

The server also reads these from a git-ignored `.env` file next to `server.js`; real environment variables win. On App
Service, `azd` sets `FOUNDRY_ENDPOINT`, `FOUNDRY_DEPLOYMENT`, `AZURE_CLIENT_ID` and `HOST`, and `.webappignore` keeps
your local `.env` out of the deployment.

## Tests

`npm test` runs the node:test suites; they make no model calls.

## Where it comes from

- Built by **Claude Fable 5.2**. The run was set up by Felix Rieseberg (Anthropic) and shared on X on 2026-11-09:
  https://x.com/felixrieseberg/status/2119925633564463609
- Original playable artifact: https://claude.ai/artifact/BGY1SztrAYcJQHSsnHHGmp
- Per his post: one prompt, no human feedback, about 8 hours, about 2.7M output and 445M input tokens (heavily cached), about $550 at API pricing. Models, sounds and textures are all made in code. These numbers are his own and not checked here.

All credit for the game goes to its original author. The upstream repo mirrors the artifact so people can run it
locally; this fork adds the Microsoft-Decision-1 brain for the Gulls and Hounds. If you are the author and want it taken
down, open an issue.

Original demo, with the built-in AI: https://realcodebear.github.io/saltline-fable-5.2/

## What changed from the artifact

- The claude.ai frame-runtime scripts were removed from `<head>`, and a doctype, charset and viewport tag were added so
  the file runs as a plain web page.
- `index.html` loads `css/harbormaster.css` and `js/harbormaster.js`, and has three small hooks in the Hound code. Each
  does nothing without the brain:
  - the Hound's firing-spot picker asks `brain.firePos` first, so the model's tactic picks the spot;
  - Hounds have a `_replan()` method, so a new tactic takes effect at once;
  - `burstsWanted` sets how many bursts a Hound fires before it moves.
- Everything else is new: the server (`server.js`, `lib/`), the brain (`js/`), its styles (`css/`), the tests
  (`test/`) and the Azure deployment (`azure.yaml`, `infra/`).

The game itself is still one file, `index.html` (~1.4 MB). It bundles three.js and loads fonts from Google Fonts. There
are no other outside assets.
