# Perspicacity

**A privacy browser that keeps an AI agent from becoming the thing that deanonymises you.** Windows and Android builds, built from the specification in [`docs/spec/`](docs/spec/).

| | **VEIL** (browsing) | **SHADOW** (agent work) |
|---|---|---|
| Storage | RAM only, per tab, destroyed on close or New Identity | Persistent, local only |
| Network | Tor, with a separate circuit per site *and* per tab | Separate Tor circuits, or direct if you choose |
| Fingerprint | One canonical value per surface for every user | Not anonymous by design |
| The agent | Cannot touch it | Its only home, and every effect needs your approval |

## Download

Get the latest installers from **[Releases](https://github.com/wolverinenhm/perspicacity-browser/releases)**:

- **Windows 10/11 (x64):** `Perspicacity-Setup-<version>-x64.exe` (installer) or `Perspicacity-Portable-<version>-x64.exe` (no install). Tor is included. The installer is not code-signed yet, so SmartScreen may ask you to confirm (*More info → Run anyway*).
- **Android 8.0+:** `Perspicacity-<version>-universal.apk`, or the smaller APK for your phone's CPU (most phones: `arm64-v8a`). Tor is included. Allow "install unknown apps" for your browser or file manager when asked.

Every file is listed with its SHA-256 in `SHA256SUMS.txt` on the release page. Releases are built by GitHub Actions from the tagged source ([workflow](.github/workflows/build.yml)).

## What it does

**VEIL tabs** (the default, `Ctrl+T`)
- **Tor, fail-closed.** Nothing loads until Tor is connected; if Tor stops, pages stop. The Windows build ships the official Tor Expert Bundle (checksum-verified at build time) and can use built-in obfs4, Snowflake or meek bridges, or your own. It also uses a Tor Browser or system Tor that is already running.
- **Circuit isolation.** A local gateway gives every *site in every tab* its own SOCKS username, so Tor puts them on different circuits (desktop). Loopback addresses go through Tor too, so web pages cannot probe services on your machine.
- **RAM-only state.** Each tab is its own in-memory browser session. Closing it, or **New identity** (`Ctrl+Shift+U`), destroys cookies, cache, storage and circuits.
- **One fingerprint for everyone.** Fixed user agent and client hints, UTC timezone (engine-level and in JavaScript), `en-US`, 4 cores, letterboxed viewport (rounded to 200×100), blank canvas readback, no WebGL, WebGPU, WebRTC, battery, gamepad or device enumeration, and 100 ms timers. Patched functions still report `[native code]`.
- **Tracker blocking** with a built-in list of ~140 ad, analytics and fingerprinting hosts, plus your own rules. **HTTPS-only** with a per-site plain-HTTP escape hatch. **Downloads** are renamed safely (no bidi tricks, no reserved names) and executables are flagged; nothing is ever opened automatically.

**SHADOW tabs and the agent** (desktop, `Ctrl+Shift+S`, then the **Agent** button)
- The agent sees a lossy outline of the page (headings and controls with opaque handles), never the DOM, and the outline is read in an isolated world the page cannot touch.
- The model must answer with one action from a closed set (click, type, select, navigate, scroll, wait, done) matching a JSON schema. Anything else is rejected. Page text is fenced as untrusted data.
- Typing, navigating and clicking each need your **Allow once** (clicks can be pre-approved for one site). Passwords are masked in the approval card.
- Every approval, refusal and action is written to an **HMAC-chained audit ledger** you can verify from the menu. Its key is protected by the OS keystore.
- Models (Settings → Agent model):
  - **On your computer, private:** Ollama (default) or LM Studio.
  - **Hosted, with your own API key:** Claude (Anthropic), OpenAI, Google Gemini, DeepSeek, Kimi (Moonshot AI), Qwen (Alibaba Cloud Model Studio), Mistral, xAI Grok, GLM (Zhipu / Z.ai), Groq, Together AI and OpenRouter.
  - **Custom:** any other OpenAI-compatible API (vLLM, LiteLLM, a company gateway, or a regional endpoint such as `api.moonshot.cn`).

  **List models** asks the provider which models your key can use. Keys are stored encrypted with the operating system keystore. A hosted model is a network party: it receives the page outline from Shadow tabs, never anything from VEIL.

## What it does not do

This is honest scope, as the specification asks.

- **The desktop build uses Chromium (via Electron), not the Tor-Browser-derived Gecko engine the spec chooses.** It is a different anonymity set from Tor Browser, fonts and some engine-level surfaces are not uniform, and Web Workers do not get the JavaScript shim (they do get the engine-level timezone and user agent). If your safety depends on anonymity, use Tor Browser.
- **Android WebView** cannot attach per-site circuit credentials, so all Android tabs share Tor's circuit set (New Identity asks Tor for new circuits), and WebView announces itself in some client-hint headers. Per-tab storage separation needs a recent Android System WebView (multi-profile support); on older ones storage is wiped on exit and New Identity instead.
- The agent's memory store (MNEMOSYNE), off-screen shadow rendering, OHTTP inference and the CaMeL dual-planner are specified but not implemented yet. See [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) for the full spec-to-code map.

## Building from source

```bash
# Desktop (Node 22)
cd desktop
npm ci
npm test                       # unit tests
npm start                      # run (uses a running Tor Browser/tor, or vendor/tor)
npx electron . --selftest      # end-to-end self-test in a real window
node scripts/fetch-tor.js windows-x86_64 && npm run dist:win   # Windows installer (on Windows)

# Android (JDK 21, Android SDK)
cd android
./gradlew :core:test :app:assembleRelease
```

To publish a release, push a tag such as `v0.1.0`; the workflow builds everything, runs the tests and attaches the installers. Tags with a dash (`v0.2.0-beta`) become pre-releases. To sign the APK with your own key, add the repository secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`; otherwise the committed development key is used (fine for sideloading, not for a store).

## Repository layout

| Path | What |
|---|---|
| [`desktop/`](desktop/) | Electron app: `src/main` (planes, Tor, gateway, filter, agent, ledger), `src/ui` (browser chrome), `test/` |
| [`android/`](android/) | Android app (`app/`) and the pure-Java core shared logic (`core/`) with tests |
| [`shared/`](shared/) | Fingerprint shim and tracker list used by both apps |
| [`docs/spec/`](docs/spec/) | The five specification documents (rev 1.1) |
| [`.github/workflows/build.yml`](.github/workflows/build.yml) | Tests, Windows installer, APKs, emulator smoke test, releases |

## The specification

| Document | Scope |
|---|---|
| [ARCHITECTURE.md](docs/spec/ARCHITECTURE.md) | Process and IPC model, storage and key hierarchy, threat model, engine selection, delivery plan |
| [NETWORK.md](docs/spec/NETWORK.md) | Embedded Tor, per-class clients, isolation tokens, leak matrix, pluggable transports |
| [FINGERPRINT.md](docs/spec/FINGERPRINT.md) | Fingerprint uniformity, timing mitigations, human-emulation layer |
| [AGENT.md](docs/spec/AGENT.md) | Shadow contexts, accessibility-tree distillation, hybrid inference, capability security |
| [UTILITIES.md](docs/spec/UTILITIES.md) | Filter engine, new-identity rotation, download sanitiser, local automation |

The offline HTML edition of the specification is on the [v1.1.0-docs release](https://github.com/wolverinenhm/perspicacity-browser/releases/tag/v1.1.0-docs).
