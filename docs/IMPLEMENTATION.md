# Implementation status (v0.1)

How the code in this repository maps to the specification in [`spec/`](spec/), and where it
deliberately differs. Deviations are listed the way the spec's amendments register (ARCHITECTURE
Appendix H) lists them, so they can be argued with.

## Implemented

| Spec | Mechanism | Desktop (`desktop/src/main`) | Android (`android/app`) |
|---|---|---|---|
| ARCH D1, §3 | Two planes, separate sessions and circuits | `browser.js`: VEIL = one in-memory `session` per tab; SHADOW = `persist:shadow` | VEIL only |
| ARCH §5.2 | RAM-only VEIL state, destroyed on close / New Identity | `browser.js` `destroyVeilState`, `newIdentity` | Per-tab WebView profiles, `LOAD_NO_CACHE`, wipe on exit/start |
| NET §4, §4.6 | Embedded Tor, fail closed | `tor.js` (bundled Expert Bundle, or external 9150/9050), navigation gated in `browser.js` | `TorController.java` (tor-android), dead-port proxy until Tor is up |
| NET §6.2 | Isolation token per first-party site | `gateway.js`: per-tab SOCKS gateway, username = H(tab nonce ‖ site), Tor `IsolateSOCKSAuth` | not possible in WebView (see A-D2) |
| NET §7.2–7.4 | WebRTC, QUIC, DNS prefetch, loopback | `main.js` switches, `<-loopback>` bypass removal, shim removes `RTCPeerConnection` | shim removes WebRTC |
| NET §8 | Pluggable transports and built-in bridges | `tor.js` reads the bundle's `pt_config.json` | — |
| FP §3–§5 | Canonical values, letterboxing, timers, canvas, WebGL | `fingerprint.js`, `shared/veil-shim.js`, CDP emulation for timezone/locale/UA-CH, `layout()` letterboxing | same shim at document start |
| FP §7 | Human-paced actuation | `agent.js` pacing, `browser.js` jittered input events | — |
| AGT §3 | Semantic snapshot with opaque, generation-scoped handles | `snapshot.js` (isolated world) | — |
| AGT §4.3 | Grammar-constrained decoding | `agent.js` `ACTION_SCHEMA` (Ollama `format`, Claude structured output) + re-validation | — |
| AGT §5.2–5.5 | Closed tool surface, HITL gates, untrusted-data fencing | `agent.js` `validateAction`, `approvalNeeded`, `buildMessages` | — |
| ARCH §8.4 | AUDIT: HMAC-chained ledger | `ledger.js`, key via OS keystore (`settings.js`) | — |
| UTL §2 | Native filter engine | `filter.js` + `shared/filters/trackers.txt` | `core/FilterEngine.java` (same rules, same tests) |
| UTL §2.6 | HTTPS-only | `site.js` `httpsUpgrade` in `onBeforeRequest` | `core/Site.java` |
| UTL §4 | Download sanitiser | `sanitize.js` | `core/FilenameSanitizer.java`, Tor-routed `Downloader.java` |
| ADR-003 | No remote debugging | refuses `--remote-debugging-*` when packaged; Electron fuses disable `RunAsNode`, `NODE_OPTIONS`, inspect flags | — |
| ADR-007 | No telemetry, no remote Safe Browsing | no crash reporter, `disable-background-networking`, spellcheck download disabled | `setSafeBrowsingEnabled(false)`, no backups |

## Deviations (proposed amendments)

- **A-D1 Engine.** ADR-001 chooses a Tor-Browser-derived Gecko fork. v0.1 ships on Chromium
  (Electron) because a Gecko fork cannot be built and shipped as a working installer in a first
  iteration. Consequence: a different, smaller anonymity set than Tor Browser; fonts, some
  media and worker-side JavaScript surfaces are not canonicalised. The fingerprint conformance
  checks in `selftest.js` cover what is canonical today.
- **A-D2 Android isolation.** WebView exposes one proxy per app and no per-request SOCKS
  credentials, so per-site circuits (NET §6.2) are not available on Android; New Identity
  issues `NEWNYM` instead.
- **A-D3 Agent visibility.** The spec's off-screen Shadow Window (AGT §2) is replaced by a
  visible Shadow tab that is brought to the front while the agent clicks or types, because
  trusted input events only reach a visible view in Electron.
- **A-D4 One planner.** The CaMeL split (ARCH §4.5.2) is approximated by the closed tool set,
  schema validation and human gates on every effect; there is no separate quarantined planner.

## Not yet implemented

MNEMOSYNE encrypted memory (ARCH §5.5), OHTTP inference (AGT §4.4), CUSTOS as a separate
process (ARCH §5.3), reproducible builds and signed updates (ARCH §8.1), the 500-payload
injection corpus (I4), and code signing for the Windows installer.

## Tests

- `desktop/test/*.test.js` (`npm test`): site rules, filter, sanitiser, ledger tamper detection,
  SOCKS gateway isolation and fail-closed behaviour, agent validation and approval flow, Tor config.
- `desktop/src/main/selftest.js` (`electron . --selftest`): a real window checks every canonical
  fingerprint value (in frames and workers), tracker blocking, per-tab SOCKS keys, fail-closed
  loading, the agent filling a form with real input events, ledger verification and New
  Identity. CI adds `--selftest-tor` on Windows to bootstrap the bundled Tor and confirm the exit
  with check.torproject.org.
- `android/core` (`./gradlew :core:test`) and an emulator smoke test in CI that waits for the
  app's Tor connection.
