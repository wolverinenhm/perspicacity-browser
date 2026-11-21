# Perspicacity — Fingerprint Uniformity: Engine Patches and Runtime Overrides

**C++ patch inventory, canonicalisation layer, timing mitigations and the human-emulation (behavioural) fingerprint**

| Field | Value |
|---|---|
| Document ID | PSC-FP-003 |
| Revision | 1.0 |
| Status | Proposed — for technical review |
| Parent specification | `ARCHITECTURE.md` (PSC-ARCH-001), §5.2.3, §6.4, Appendix C |
| Sibling specifications | `NETWORK.md` (surface #21, #22), `AGENT.md` (semantic view determinism) |
| Audience | Gecko platform engineers, privacy researchers, QA automation |
| Normative language | RFC 2119 (MUST / SHOULD / MAY) |

---

## 0. Conformance to PSC-ARCH-001

| Parent reference | Obligation | This document |
|---|---|---|
| §6.4 F-1 | One canonical value per surface, identical for every user of a build; no randomisation | §1.2 doctrine; every patch returns a manifest constant |
| §6.4 F-2 | Canonicalise at the lowest layer that can supply the value | §1.3 layer table; several patches are in layout/gfx, not in JS |
| §6.4 F-3 | Letterboxing mandatory in VEIL | §3.1 |
| §6.4 F-5 | Manifest is a build artefact; two-VM diff is a release blocker (I1) | §6.2 CI |
| Appendix C | 31 named surfaces with policy C/D/R/X | §2–§4 cover surfaces 1–31; §6.3 maps them to patches |
| §6.3.2 C-5 | Behaviour is a fingerprint; actuation must be human-paced | §5 (the governor, specified as a *uniform distribution*, not a per-user one) |
| §4.4 | Semantic view must stay deterministic across machines | §3.4 (font metrics) makes AXTree bounds canonical — a prerequisite for `AGENT.md` |

**The thesis of this document.** Fingerprint resistance is not a list of API patches; it is the property that **every observable is a function of the build, not of the device or the user.** The engineering consequence is that all constants live in one generated manifest, every patch reads from it, and the test compares the manifest to what the web can actually observe. Anything else rots: a patch that returns a literal `2` is correct until someone changes the literal, and nobody notices because the test only checks that the function exists.

---

## 1. Doctrine and machinery

### 1.1 Why uniformity and not randomisation

Randomisation ("farbling", per-session noise) is attractive because it appears to defeat fingerprinting cheaply. It does not, for three reasons that are specific to an anonymity product:

1. **A random value is an identifier.** If each session has a distinct canvas hash, the hash becomes a per-session cookie that the origin can persist and join across sites — the exact thing we are preventing.
2. **Randomisation has a distribution.** Detecting farbling is straightforward statistically (compare multiple readings, or compare against the expected rendering of a known drawing). A detection makes the client *more* identifiable, not less.
3. **Tor Browser's own design position is uniformity**: its defences deliberately make its users look alike and unlike ordinary Firefox users. We inherit that property by being a fork of the same lineage, and we would destroy it by adding entropy.

Therefore the rule is absolute in VEIL: **no surface may vary by session, by device, or by user.** Where variation cannot be removed, the surface is disabled rather than approximated (F-4).

### 1.2 The manifest

One JSON file is the source of truth:

```json
// ppx/fingerprint/manifest.json  (generated into C++ and Rust headers at build time)
{
  "manifest_version": 7,
  "tor_browser_parity_base": "140.9.0esr",
  "canvas":   { "policy": "deny_default", "quantize_bits": 5, "dither_seed": 1515931200 },
  "webgl":    { "enabled": false, "unmasked_vendor": "Mozilla", "unmasked_renderer": "Mozilla" },
  "audio":    { "sample_rate": 44100, "quantize_epsilon": 0.0001, "channels": 2 },
  "screen":   { "avail_width": 1000, "avail_height": 1000, "color_depth": 24, "pixel_ratio": 1 },
  "letterbox":{ "step_x": 200, "step_y": 100, "sizes": [[1000,1000],[1200,1000],[1400,1000]] },
  "navigator":{ "hardware_concurrency": 2, "device_memory": 8, "platform": "Win32",
                "ua": "Mozilla/5.0 (Windows NT 10.0; rv:140.0) Gecko/20100101 Firefox/140.0" },
  "timing":   { "resolution_us": 100000, "jitter": true, "date_resolution_ms": 100 },
  "fonts":    { "visibility": 1, "bundled_set": "ppx-fonts-v3" },
  "features": { "shared_array_buffer": false, "webgpu": false, "sab_wasm_threads": false }
}
```

```cpp
// Generated: mozilla/ppx/FingerprintManifest.h  — do not edit by hand
namespace ppx::fp {
  inline constexpr uint8_t kCanvasQuantizeBits = 5;
  inline constexpr uint32_t kCanvasDitherSeed = 1515931200u;
  inline constexpr uint32_t kAudioSampleRate = 44100;
  inline constexpr int32_t kScreenAvailWidth = 1000;
  inline constexpr uint32_t kTimerResolutionUs = 100000;
  inline constexpr bool kWebGLEnabled = false;
  // ...
}
```

Every patch below references `ppx::fp::*` and never a literal. `manifest_version` is exposed in `about:ppx` and embedded in the AUDIT header of every session, so a support report always states the fingerprint generation — which is otherwise an invisible source of "works on my machine" privacy bugs.

### 1.3 Where each layer has to patch

| Layer | Surfaces | Why not higher |
|---|---|---|
| **graphics / rasteriser** | canvas, WebGL, audio DSP | Anything above this inherits device-dependent output; a JS shim cannot un-render a GPU-specific bitmap |
| **layout / fonts** | element metrics, `@font-face`, text measurement, letterboxing | The DOM sees `ClientRect`; only layout knows the true metrics |
| **platform / i18n** | timezone, locale, `Intl`, `Accept-Language` | ICU data is read in C++; overriding in JS leaves `Intl` internals visible |
| **DOM bindings** | `navigator.*`, `screen.*`, `performance.*` | These are the cheap, well-understood patches — the *last* resort, not the first |
| **content process policy** | feature disablement (WebGPU, SAB, sensors) | Capability removal at process setup cannot be re-enabled by a page |

This ordering is the practical meaning of F-2: a patch in the wrong layer is a patch that will be bypassed by the next API that reads the same underlying value.

---

## 2. Graphics and hardware

### 2.1 Canvas

**Threat.** `toDataURL`/`getImageData`/`toBlob` return a device-dependent bitmap: font rasterisation, subpixel antialiasing, GPU blend rounding, colour profile conversion, and the antialiasing path all vary by OS, GPU driver, and window DPI. A single canvas hash separates most users.

**Policy (VEIL).**

| Case | Behaviour |
|---|---|
| Default, no capability | `toDataURL`/`getImageData`/`toBlob` return a **blank surface** of the requested dimensions; no prompt, no error |
| Origin holds `CAP_CANVAS` (user granted via trust chrome) | Readback returns the **canonical** rendering: software rasteriser, bundled fonts, quantised to 5 bits/channel, fixed build-seeded dither |
| `ID-3` attributed | Canonical rendering without a prompt (documented relaxation) |

Why "blank by default" rather than "prompt every time": a prompt is itself observable (timing, dialog presence) and it trains users to click yes. A blank surface is indistinguishable from a canvas that the page cleared, is deterministic, and costs nothing for the 99 % of pages that use canvas for decorative effects. Chat apps that paste screenshots and Figma-class tools are the exception, and they get a clear, one-time grant.

**Patch.**

```cpp
// dom/canvas/CanvasRenderingContext2D.cpp
already_AddRefed<nsICanvasRenderingContextInternal>
CanvasRenderingContext2D::GetCanvas() const { /* unchanged */ }

nsresult CanvasRenderingContext2D::GetImageData(JSContext* aCx, int32_t aSx,
                                               int32_t aSy, int32_t aSw,
                                               int32_t aSh, JS::MutableHandle<JSObject*> aRetval) {
  if (ppx::fp::VeilCanvasDenied(mPrincipal)) {
    return mCanvasElement->CreateBlankImageData(aCx, aSw, aSh, aRetval); // §2.1.1
  }
  nsresult rv = NS_GetImageData(aCx, aSx, aSy, aSw, aSh, aRetval);
  if (NS_FAILED(rv)) return rv;
  ppx::fp::CanonicalizeImageData(aCx, aRetval);                        // §2.1.2
  return NS_OK;
}

// dom/canvas/CanvasUtils.cpp — the single choke point for every extraction path
bool CanvasUtils::IsImageExtractionAllowed(nsIPrincipal* aPrincipal,
                                          JSContext* aCx,
                                          nsIURI* aURI) {
  if (StaticPrefs::ppx_veil_only()) {
    return ppx::fp::HasCapability(aPrincipal, Capability::Canvas);
  }
  return LegacyRFPBehaviour(aPrincipal, aCx, aURI);   // ID-3: canonical, no prompt
}
```

**2.1.1 Blank surface.** Allocate an `ImageData` of the requested size with every pixel `#FFFFFFFF` (alpha 255, RGB 255). Two details: use the requested dimensions exactly (a page can detect a size mismatch) and never throw for tainted canvases (a CORS-tainted canvas must produce the same blank result as an untainted one, or the error becomes an oracle).

**2.1.2 Canonicalisation.** The rendering is made device-independent at three levels:

```cpp
// ppx/fp/CanvasCanonical.cpp
void CanonicalizeImageData(JSContext* aCx, JS::MutableHandle<JSObject*> aData) {
  // 1. Force the software rasteriser for canvas in VEIL (pref set at process start):
  //    gfx.canvas.accelerated = false  → Skia CPU path, identical pixel maths on
  //    every machine for the same Skia revision.
  // 2. Quantise: keep the top N bits per channel, so driver-level ±1 rounding
  //    and colour-profile conversion collapse to the same value.
  const uint8_t mask = (uint8_t)(0xFFu << (8 - ppx::fp::kCanvasQuantizeBits));
  // 3. Fixed dither: a build-constant PRNG stream, so noise is part of the
  //    canonical image rather than per-session entropy.
  XorShift128 rng(ppx::fp::kCanvasDitherSeed);
  for (each pixel p) {
    p.r = (p.r & mask) ^ (rng.next8() & 0x03);
    p.g = (p.g & mask) ^ (rng.next8() & 0x03);
    p.b = (p.b & mask) ^ (rng.next8() & 0x03);
  }
}
```

The dither exists to break *exact* hash matching against reference renders of known drawings while remaining a deterministic function of the build. It is not entropy: two users produce bit-identical output.

**2.1.3 The other canvas surfaces.** `OffscreenCanvas`, `ImageBitmap`, `createImageBitmap(canvas)`, `convertToBlob`, WebGL `readPixels`, and `drawImage(canvas → canvas)` all route through `CanvasUtils::IsImageExtractionAllowed` or a sibling; the patch list is asserted by a unit test that enumerates every `GetImageData`-equivalent binding and fails if one is unpatched. This test is the difference between a defence and a defence-shaped hole.

### 2.2 WebGL

**Threat.** `UNMASKED_VENDOR_WEBGL` and `UNMASKED_RENDERER_WEBGL` leak GPU model and driver version; `getShaderPrecisionFormat` leaks the GPU's ALU layout; `getSupportedExtensions` and the `MAX_*` limits leak the driver generation; rendered output leaks the driver's rounding.

**Policy.** WebGL is **disabled in VEIL** (manifest `webgl.enabled=false`). Context creation throws `NotSupportedError`; the manifest is part of surface #31 (feature-detection correlated set). Rationale: WebGL is the single largest remaining hardware-entropy source, its rendering is irreducibly device-specific, and its legitimate uses in an anonymity context are rare enough that the capability cost is acceptable.

For `ID-2` (SHADOW, non-anonymous by construction) WebGL is permitted with the following patches, because an agent may need to read a dashboard or a map:

```cpp
// dom/canvas/WebGLContext.cpp
void WebGLContext::GetParameter(JSContext* cx, GLenum pname,
                                JS::MutableHandle<JS::Value> retval, ErrorResult& rv) {
  if (ppx::fp::SpoofWebGL()) {
    switch (pname) {
      case LOCAL_GL_UNMASKED_VENDOR_WEBGL:
        retval.setString(ppx::fp::kUnmaskedVendor);   // "Mozilla"
        return;
      case LOCAL_GL_UNMASKED_RENDERER_WEBGL:
        retval.setString(ppx::fp::kUnmaskedRenderer); // "Mozilla"
        return;
      case LOCAL_GL_MAX_TEXTURE_SIZE:      retval.setInt32(8192);  return;
      case LOCAL_GL_MAX_RENDERBUFFER_SIZE: retval.setInt32(8192);  return;
      case LOCAL_GL_MAX_VIEWPORT_DIMS:     /* {8192, 8192} */      return;
      case LOCAL_GL_ALIASED_LINE_WIDTH_RANGE:
      case LOCAL_GL_ALIASED_POINT_SIZE_RANGE: /* {1,1} */          return;
      default: break;
    }
  }
  return LegacyGetParameter(cx, pname, retval, rv);
}

// dom/canvas/WebGLContextExtensions.cpp
// Return a fixed, driver-independent allowlist. Anything not on the list is
// reported absent even if the driver supports it, so the *set* is canonical.
static constexpr std::array<const char*, 12> kCanonicalExtensions = {
  "EXT_texture_filter_anisotropic", "OES_element_index_uint",
  "OES_standard_derivatives", "OES_texture_float", "OES_texture_float_linear",
  "WEBGL_compressed_texture_s3tc", "WEBGL_debug_renderer_info",
  "WEBGL_depth_texture", "WEBGL_draw_buffers", "WEBGL_lose_context",
  "EXT_blend_minmax", "EXT_sRGB"
};
```

`getShaderPrecisionFormat` deserves its own note: it returns three integers per shader type per precision, and the *set* across `{VERTEX, FRAGMENT} × {LOW, MEDIUM, HIGH}` is a clean device fingerprint even when strings are spoofed. The patch returns a canonical table derived from the software GL implementation, and the shader compiler is configured to actually honour those precisions (otherwise the reported values contradict observed numeric behaviour — a contradiction is itself a fingerprint, see §5.6).

### 2.3 AudioContext / OfflineAudioContext

**Threat.** DSP output depends on the platform's audio backend, sample-rate conversion path, FFT implementation (SIMD width, FMA availability), and the `DynamicsCompressorNode` implementation. The `AnalyserNode.getFloatFrequencyData()` buffer is a famously stable fingerprint.

**Policy.** Audio *playback* is untouched (a user hearing their audio is not a fingerprint). All *readback* is canonicalised:

| Surface | VEIL behaviour |
|---|---|
| `AudioContext.sampleRate` | 44100, always (the platform is not consulted) |
| `AudioContext.baseLatency` / `outputLatency` | fixed 0.01 / 0.02 |
| `AnalyserNode.getFloatFrequencyData` / `getByteFrequencyData` | quantised to ε = 1e-4, fixed dither |
| `OfflineAudioContext.startRendering` | rendered on the scalar (non-SIMD) DSP path, quantised |
| `AudioBuffer.getChannelData` | quantised |
| `AudioContext.maxChannelCount` / `destination.maxChannelCount` | 2 |
| `AudioWorklet` | allowed (it is user code, not a probe) |

```cpp
// dom/media/webaudio/AudioContext.cpp
double AudioContext::SampleRate() const {
  return ppx::fp::SpoofAudio() ? ppx::fp::kAudioSampleRate
                               : mSampleRate;   // platform value, ID-3 only
}

// dom/media/webaudio/AnalyserNode.cpp
void AnalyserNode::GetFloatFrequencyData(const Float32Array& aArray) {
  Analyse(aArray);
  if (ppx::fp::SpoofAudio()) {
    ppx::fp::QuantizeAndDither(aArray.Data(), aArray.Length(),
                               ppx::fp::kAudioEpsilon, ppx::fp::kAudioDitherSeed);
  }
}
```

**The hard part, stated honestly.** Forcing the scalar DSP path is what makes the output identical across CPUs, and it costs performance (roughly 3–8× on `OfflineAudioContext` rendering in microbenchmarks). Two mitigations: (a) offline rendering is almost always short in fingerprinting scripts (~0.5 s of audio), so the absolute cost is milliseconds; (b) real-time playback is unaffected because it does not go through the canonical path. A future option is to keep SIMD but pin it to a software implementation compiled with a fixed feature set and no FMA contraction (`-ffp-contract=off`), which we would adopt once it passes the two-VM diff.

### 2.4 The rest of the graphics surface

| Surface | Policy | Mechanism |
|---|---|---|
| `screen.width/height/availWidth/availHeight/colorDepth/pixelDepth` | C from manifest | `dom/base/Screen.cpp` |
| `window.devicePixelRatio` | C (1) | `nsGlobalWindowInner::GetDevicePixelRatio` |
| `matchMedia('(resolution: …)')` | C | `nsMediaFeatures::GetResolution` |
| `matchMedia('(color-gamut: …)')` | C (`srgb`) | `nsMediaFeatures` |
| `matchMedia('(dynamic-range: …)')` | C (`standard`) | `nsMediaFeatures` |
| `navigator.mediaDevices.enumerateDevices` | C (0 devices, empty labels, no prompt) | `MediaManager` |
| `RTCRtpSender.getCapabilities('video')` | C (single codec set) | `PeerConnection.js` |
| Codec support matrix (`canPlayType`, `MediaSource.isTypeSupported`) | C (the built-in software codecs only) | `dom/media/DecoderTraits` |
| `HTMLVideoElement` stats (`mozParsedFrames` etc.) | D | pref + binding removal |
| Image decode timing | not canonicalisable; timer clamping (§4) is the mitigation | — |

---

## 3. System and environment normalisation

### 3.1 Letterboxing

**Threat.** The viewport (and therefore `innerWidth/innerHeight`, media queries, and every element's wrapping) reveals window size, screen size, DPI and window-manager chrome. Combined with font metrics it identifies most desktop configurations.

**Mechanism.** The content viewport is rounded down to a manifest-defined step (default 200×100 CSS px) and the remainder is filled with a neutral letterbox margin drawn by the browser, outside the content area. `innerWidth/innerHeight`, media queries and layout all see the rounded size; the page cannot detect the true window.

```cpp
// layout/base/ppx/Letterbox.cpp
gfx::IntSize Letterbox::ContentSizeFor(const gfx::IntSize& aWindowCssPx) {
  const auto [sx, sy] = ppx::fp::kLetterboxStep;             // 200, 100
  int32_t w = (aWindowCssPx.width / sx) * sx;
  int32_t h = (aWindowCssPx.height / sy) * sy;
  // Snap to the nearest *allowed* size from the manifest to reduce the number
  // of distinct viewports we expose; never below the smallest allowed size.
  return ppx::fp::SnapToAllowedSizes(w, h);
}
```

Three hard requirements learned from doing this badly:

1. **Round in CSS pixels, not device pixels**, so that a HiDPI window and a LoDPI window of the same physical size land on the same bucket.
2. **Apply before layout, not after.** Post-layout adjustment reflows the page and shows up as a `resize` event with implausible timing; it also breaks sites that measure during `DOMContentLoaded`.
3. **Never expose the margin to the page.** The letterbox is a browser-chrome region; `window.outerWidth` reports the rounded content size plus canonical chrome, not the real window.

**Interaction with the AI agent.** The semantic snapshot (`AGENT.md` §3) reports bounds in *layout* coordinates, which are post-letterbox and therefore deterministic across machines. This is a prerequisite for the agent's grounding: an AXTree whose boxes differ by 12 px between two users produces different prompt context for the same page and different model behaviour. Letterboxing is thus both a privacy control and an AI determinism control — a rare case where the two goals coincide.

### 3.2 Navigator and Client Hints

| Property | Canonical value | Patch point |
|---|---|---|
| `navigator.userAgent` | manifest `ua` (Tor-Browser-parity string for the pinned ESR) | `dom/base/Navigator.cpp` |
| `navigator.appVersion` / `appName` / `product` | derived from UA; never "5.0 (X11…)" leaks | idem |
| `navigator.platform` | `Win32` (manifest; matches UA even on macOS/Linux) | idem |
| `navigator.oscpu` | absent (empty string) | idem |
| `navigator.hardwareConcurrency` | 2 | idem |
| `navigator.deviceMemory` | 8 | idem |
| `navigator.maxTouchPoints` | 0 | idem |
| `navigator.languages` | `["en-US","en"]` | `NavigatorLanguages` |
| `navigator.plugins` / `mimeTypes` | fixed, non-empty, canonical (PDF viewer only) | `dom/plugins` |
| `navigator.pdfViewerEnabled` | true | idem |
| `navigator.doNotTrack` | `"1"` (uniform) | idem |
| `navigator.connection.*` | `effectiveType: "4g"`, `rtt: 100`, `downlink: 10` | `dom/network/Connection` |
| `navigator.userAgentData` (UA-CH) | `{ brands: canonical, mobile: false, platform: "Windows" }`; `getHighEntropyValues()` rejects | `dom/base/NavigatorUAData` |
| `navigator.webdriver` | **absent** (not `false`) | binding removal |
| `navigator.gpu` | absent in VEIL | binding removal |
| `navigator.storage.estimate()` | bucketed to 1 GiB / 25 % granularity | `StorageManager` |
| `navigator.permissions.query()` | canonical result set; unknown names reject identically | `Permissions` |

The rule that matters more than any single value: **the values must be mutually consistent** (§5.6). A spoofed UA claiming Windows with a `platform` of `MacIntel`, or UA-CH claiming a Chrome brand while `navigator.userAgent` says Firefox, is more identifying than the truth.

### 3.3 Timezone, locale, and `Intl`

```cpp
// intl/components/... or dom/base/nsRFPService.cpp
// Gecko already routes timezone through mozilla::DateTimeInfo for RFP; we pin it
// unconditionally and remove the host-timezone read from the VEIL code path.
void DateTimeInfo::UpdateTimeZone() {
  if (StaticPrefs::ppx_veil_only()) {
    mTimeZone = TimeZone::FromUTC();          // UTC, always
    mSpoofed = true;
    return;
  }
  LegacyUpdateFromPlatform();                 // ID-3 only
}
```

| Surface | Canonical value | Why |
|---|---|---|
| `Intl.DateTimeFormat().resolvedOptions().timeZone` | `UTC` | Combined with locale and language it is one of the highest-entropy single values |
| `new Date().getTimezoneOffset()` | `0` | Must agree with the above |
| Date/time formatting | ICU canonical data, `en-US`, Gregorian, ISO-ish | — |
| `Intl.Collator` / `NumberFormat` / `PluralRules` | fixed locale, no `-u-` extensions honoured | Extension handling leaks CLDR version |
| `Accept-Language` header | `en-US,en;q=0.5` | Must match `navigator.languages` |
| `privacy.spoof_english` equivalent | always on in VEIL | Tor Browser parity |
| `toLocaleString()` variants | canonical | — |

The one exception, and it must be a deliberate, visible one: a user who needs their local timezone for usability can enable **Regional Consistency Mode**, which sets timezone, locale and `Accept-Language` together to a chosen region. It is legal in `ID-3` only, is recorded in AUDIT, and the UI says in plain language that it reduces anonymity. Partial relaxation (e.g., timezone only) is forbidden, because partial relaxation produces an inconsistent tuple that is *more* unique than either extreme.

### 3.4 Fonts

**Threat.** The set of installed fonts, their versions, and their metrics is one of the most identifying properties of a machine — a handful of fonts separates users into tiny buckets — and font metrics also perturb every text-bound element on every page.

**Policy.**

1. Only the **bundled font set** (`ppx-fonts-v3`, licensed for redistribution) is visible to content. It is byte-identical on every platform and every install, and it is chosen to cover Latin, Cyrillic, Greek, CJK and emoji at a small total size (~28 MB).
2. `font.system.whitelist` and `layout.css.font-visibility = 1` (base fonts only) are both set; the whitelist patch is the primary control and the visibility level is defence in depth.
3. `@font-face { src: local(...) }` is refused (a page can otherwise enumerate installed fonts by probing family names and timing the fallback).
4. `document.fonts.check()` reports only bundled families; unknown families return `false` deterministically.
5. Font *metrics* are canonicalised: hinting off, subpixel positioning on, `text-rendering` ignored, and a fixed fallback chain (`ppx-sans` → `ppx-serif` → `ppx-mono`). This is what makes text-bound element boxes identical across machines — which the agent's grounding depends on (`AGENT.md` §3.2).

```cpp
// gfx/thebes/gfxPlatformFontList.cpp
bool gfxPlatformFontList::FindAndAddFamiliesLocked(...) {
  if (StaticPrefs::ppx_veil_only() && !ppx::fp::IsBundledFamily(aFamily)) {
    return false;                       // deterministic "not installed"
  }
  return LegacyFindAndAddFamilies(...);
}
```

**Breakage risk and mitigation.** A site that depends on a system font (e.g. a document editor requiring Calibri) will fall back; that is a visual, not a functional, failure. The mitigation is a *bundled metric-compatible set* (Carlito for Calibri, Liberation for Arial/Times, etc.), which preserves line breaking and layout for the vast majority of documents while keeping the set uniform.

---

## 4. Timing and side channels

### 4.1 Clock resolution

**Threat.** High-resolution timers turn every other defence into an oracle: cache timing, render timing, network RTT, and Spectre-class gadgets all need sub-millisecond measurement.

**Mechanism.** All time sources are clamped to a 100 ms grid with optional jitter, at the lowest layer that produces the value:

```cpp
// dom/base/nsRFPService.cpp  (the existing RFP machinery, pinned unconditionally)
double nsRFPService::ReduceTimePrecisionAsUSecs(double aTime, int64_t aContextMixin) {
  if (!StaticPrefs::ppx_uniform_timing()) return aTime;
  const double reso = ppx::fp::kTimerResolutionUs;              // 100000
  double clamped = floor(aTime / reso) * reso;
  if (ppx::fp::kTimerJitter) {
    // Jitter is derived from (session salt, context mixin) so that repeated
    // measurements agree with each other (jitter must not be another oracle).
    clamped += ppx::fp::DeterministicJitter(aContextMixin) * reso;
  }
  return clamped;
}
```

| Surface | VEIL policy |
|---|---|
| `performance.now()` | 100 ms grid + deterministic jitter |
| `performance.timeOrigin` | rounded to the 100 ms grid |
| `Date.now()` | 100 ms grid |
| `new Date()` | same, and `getMilliseconds()` quantised to 100 ms |
| `event.timeStamp` | quantised, and **monotone with the clamped clock** |
| `performance.mark/measure` | quantised |
| `requestAnimationFrame` timestamp | quantised |
| `Animation.currentTime` / `Web Animations` | quantised |
| `performance.getEntriesByType('resource')` | `startTime`/`duration` quantised; `transferSize` bucketed to 0 / small / large |
| `Event Counting` API (`performance.eventCounts`) | disabled |
| `navigator.userActivation` timing | quantised |
| `console.time` | quantised |
| `Intl` time zone offsets | consistent with §3.3 |

**The jitter subtlety, which is easy to get wrong.** Jitter must be a deterministic function of `(session salt, context mixin)` rather than fresh randomness per call. If a script calls `performance.now()` twice with no work in between and gets values that differ by up to 100 ms, it learns that jitter is applied and can average the noise away — the classic mistake in timer defences. With a per-context deterministic offset, repeated reads are *consistent*, the true resolution is genuinely 100 ms, and the offset itself is one more value that differs between users only within the 100 ms grid.

### 4.2 SharedArrayBuffer, Atomics and high-resolution execution

```cpp
// js/xpconnect/... process setup (VEIL)
Prefs::Set("javascript.options.shared_memory", false);   // SharedArrayBuffer undefined
Prefs::Set("dom.postMessage.sharedArrayBuffer.bypassCOOP_COEP.insecure", false);
```

With SAB unavailable, `Atomics.wait` cannot park a thread for a precise interval, which removes the standard primitive for building a high-resolution timer out of a shared integer — the pattern that defeats naive `performance.now()` clamping. `WebAssembly` threads are disabled for the same reason. WebAssembly *itself* stays enabled (it is a major compatibility and performance feature and not, by itself, a timing primitive once SAB is gone).

`crossOriginIsolated` remains false, which is honest: the isolation features that would set it (`COOP`/`COEP`) are still supported for *site* behaviour, but `crossOriginIsolated` always reports false because the capabilities it gates are not available in VEIL.

### 4.3 The remaining timing surface

| Vector | Status | Note |
|---|---|---|
| Cache API exists/does-not-exist timing | reduced by 1 ms+ clamping of resource timing | Not eliminated |
| `getBoundingClientRect` subpixel | quantised to 0.125 px (deterministic) | Below perceptual relevance, above float noise |
| CSS `@container` / ResizeObserver storms | rate-limited, quantised timestamps | — |
| WebSocket / SSE framing timing | not clampable at the JS boundary | Mitigated by traffic shaping (`NETWORK.md` §7), accepted |
| Spectre v1/v2 in JS | no SAB, clamped timers, site isolation, JIT hardening (`--enable-jit-hardening`, constant blinding) | Residual accepted with rationale in the risk register |
| `crossOriginOpenerPolicy` attacks | disabled cross-origin opener access in VEIL | — |

We do **not** disable the JIT. Tor Browser ships a JIT in its standard mode for a reason: a browser without a JIT is 2–4× slower on real workloads, and users who route around slowness disable the browser entirely. The timing mitigations above reduce the *practical* resolution of Spectre-class gadgets to 100 ms, which makes a cache-timing exfiltration of a meaningful secret infeasible rather than merely hard — and that is the defensible claim.

---

## 5. The AI agent human-emulation layer

### 5.1 What anti-bot systems actually measure

An automated agent is detectable through four independent classes of signal, and a sophisticated protection (Cloudflare's bot score, Akamai's `_abck`/sensor data, DataDome, PerimeterX) fuses all four:

| Class | Signals | Owner of the fix |
|---|---|---|
| **Stack** | TLS ClientHello, HTTP/2 settings and header order, ALPN, header casing, `navigator.webdriver`, CDP artefacts, headless tells, JS engine quirks vs UA | `NETWORK.md` §5.4 (canonical ClientHello), this doc §3.2 |
| **Environment** | WebGL/Canvas/audio hashes, fonts, screen, timezone, hardware | §2–§3 |
| **Behaviour** | Mouse entropy and path curvature, keystroke inter-arrival, scroll physics, dwell/hover, form-fill speed, click offset distribution, focus/visibility transitions, reading pauses | **this section** |
| **Semantics** | Request sequence, timing vs content, navigation depth, session length, absence of "useless" requests | `AGENT.md` (task planner) |

Perspicacity's own fingerprint uniformity (§1–§4) makes the *stack* and *environment* classes look ordinary, which leaves behaviour as the discriminating signal — and behaviour is also the one signal that a naive agent gets catastrophically wrong (instantaneous clicks, 0 ms keystrokes, perfectly straight pointer lines, no idle time).

### 5.2 The design constraint that makes this privacy-safe

There is an obvious trap: if each user's emulation parameters are tuned to *their* real behaviour, the governor becomes a **behavioural biometric**, more identifying than the fingerprint it was meant to blend. Therefore:

> **The governor's parameter distributions are build constants shared by all users. Only the *sampled sequence* is random, seeded per session from CUSTOS.**

Two users produce different trajectories (good), drawn from the same distribution (good), with no parameter that encodes anything about the individual (essential). This is the behavioural analogue of F-1, and it is the reason the governor lives in this document rather than in a hidden product feature.

### 5.3 Pointer trajectories

Model: Fitts's-law duration, minimum-jerk velocity profile, cubic Bézier path with per-session perturbation, overshoot and correction sub-movement, and a final settle.

```rust
// ppx-humanmodel/src/pointer.rs
pub struct PointerModel { rng: ChaCha20Rng }   // seeded from (session salt, task uuid)

impl PointerModel {
    /// Fitts: T = a + b * log2(D/W + 1). Constants are build-shared.
    fn duration(&self, dist_px: f64, target_px: f64) -> Duration {
        const A: f64 = 0.135;   // s
        const B: f64 = 0.105;   // s
        let id = (dist_px / target_px + 1.0).log2();
        let jitter = self.rng.gen_range(0.85..1.18);
        Duration::from_secs_f64((A + B * id) * jitter)
    }

    /// Produces ~60 Hz pointer samples along a cubic Bézier with a minimum-jerk
    /// velocity profile, an optional overshoot, and a corrective sub-movement.
    pub fn plan(&mut self, from: Pt, to: Pt, target: Rect) -> Vec<PointerSample> {
        let d = (to - from).norm();
        let t = self.duration(d, target.min_dim());
        // Control points: one perpendicular offset for a human-looking arc.
        let perp = (to - from).perp().normalized();
        let bow = self.rng.gen_range(0.04..0.16) * d;
        let c1 = from + (to - from) * 0.30 + perp * bow;
        let c2 = from + (to - from) * 0.68 + perp * bow * 0.6;
        let mut samples = self.trace_bezier(from, c1, c2, to, t);   // min-jerk eased

        // ~70% of human reaches overshoot on small targets, then correct.
        if self.rng.gen_bool(0.7) && d > 120.0 {
            let overshoot = to + (to - from).normalized() * self.rng.gen_range(3.0..14.0);
            samples.extend(self.trace_bezier(to, overshoot, overshoot, to, t * 0.20));
        }
        samples
    }

    fn trace_bezier(&self, p0: Pt, p1: Pt, p2: Pt, p3: Pt, dur: Duration) -> Vec<PointerSample> {
        let n = (dur.as_secs_f64() * 60.0).ceil() as usize;   // 60 Hz, like a mouse
        (0..=n).map(|i| {
            let s = i as f64 / n as f64;
            let u = min_jerk(s);                              // 10s³ - 15s⁴ + 6s⁵
            let p = cubic(p0, p1, p2, p3, u);
            PointerSample { at: dur.mul_f64(s), pos: p, buttons: 0 }
        }).collect()
    }
}
```

The trace is dispatched by the platform layer as **trusted** input at 60 Hz, not as a burst: `nsIDOMWindowUtils::SendNativeMouseEvent` (Gecko) / `WidgetMouseEvent` with the trusted flag, with the same timestamp source the OS would use. A page that reads `event.isTrusted`, `event.movementX`, or the `pointerrawupdate` rate sees what a physical mouse produces.

### 5.4 Keystroke cadence

```rust
// ppx-humanmodel/src/keyboard.rs
pub fn plan_typing(&mut self, text: &str, skill: Skill) -> Vec<KeyEvent> {
    let mut out = Vec::new();
    let mut t = Duration::ZERO;
    let mut prev: Option<char> = None;
    for ch in text.chars() {
        // Inter-key interval: log-normal, median ~112 ms, sigma from skill.
        let mut iki = self.lognormal(std::time::Duration::from_millis(112), skill.sigma());
        // Bigram effects: same-hand pairs are slower, common bigrams faster.
        if let Some(p) = prev { iki *= bigram_factor(p, ch); }
        // Word boundaries: a longer pause and a "think" pause every ~7 words.
        if ch == ' ' { iki *= self.rng.gen_range(1.3..2.1); }
        // Rare, human corrections: backspace then retype.
        if self.rng.gen_bool(0.004) { iki += self.correction_pause(); }
        t += iki;
        out.push(KeyEvent { at: t, ch, down: true });
        out.push(KeyEvent { at: t + self.hold_time(), ch, down: false });
        prev = Some(ch);
    }
    out
}
```

Two non-obvious requirements: (a) the `keydown`→`keyup` hold time matters (a 0 ms hold is a tell even when inter-key intervals look human); (b) `input` events must arrive with the same cadence as `keydown`, or a page listening to `input` sees a different distribution than one listening to `keypress` — an inconsistency detectable by comparing both.

### 5.5 Scroll, dwell, and reading

| Behaviour | Model |
|---|---|
| Wheel scroll | Velocity ramps to ~1200 px/s over ~180 ms, then random wheel deltas of 100 ± 25 px; pauses after 2–4 notches |
| Programmatic scroll (anchors) | `scrollTo` with `behavior:"smooth"` and a canonical 300 ms duration — but *prefer* wheel events, because instant `scrollTo` produces no `wheel` events and is a tell |
| Hover dwell | 120–400 ms before a click on a link; 400–900 ms when the link text changed under the pointer |
| Reading pause | On a page with > 800 words: 1.5–9 s before the first action, log-normal |
| Focus/visibility | Tab visibility is never toggled to fake background; the agent waits for `document.visibilityState === "visible"` |
| Idle | 0.5–2 % of the task wall-clock is spent in no-op idle, distributed as short pauses |

### 5.6 The consistency matrix (where agents actually get caught)

Single-value spoofing is easy; *contradictions* are what detectors exploit. Every release runs a consistency audit that cross-checks these groups and fails the build on a mismatch:

| Group | Must agree |
|---|---|
| UA identity | `navigator.userAgent` ↔ `navigator.appVersion` ↔ `navigator.platform` ↔ UA-CH brands/platform ↔ Sec-CH-UA headers ↔ TLS ClientHello ordering ↔ JS error strings ↔ CSS feature detection |
| Screen | `screen.*` ↔ letterboxed `innerWidth/Height` ↔ `devicePixelRatio` ↔ media queries ↔ `visualViewport` |
| Locale | `navigator.language(s)` ↔ `Accept-Language` ↔ `Intl` ↔ date formats ↔ `toLocaleString` |
| Graphics | WebGL strings ↔ shader precisions ↔ actual shader numeric behaviour ↔ font rendering ↔ canvas output |
| Hardware | `hardwareConcurrency` ↔ `deviceMemory` ↔ parallel-worker throughput (a spoofed 2 cores with 8-way speed is a tell) |
| Timing | clamped timers ↔ animation frame cadence ↔ `requestIdleCallback` scheduling |

The hardware row is the one most often missed: a browser that claims 2 cores but renders a Web Worker benchmark at 32-core speed contradicts itself, and no amount of spoofing fixes it. The mitigation is to *throttle* — the content process caps concurrent JS threads to the manifest value — which is a real performance cost accepted in exchange for consistency.

### 5.7 What the governor does not do

Four limits, stated so the product does not overpromise:

1. **It does not solve challenges.** When a Cloudflare managed challenge, Turnstile widget, or Akamai interstitial appears, the agent stops and hands control to the human, exactly as `ARCHITECTURE.md` §6.2.5 requires for Class-B effects and as the browser does for any human-verification step. Solving or outsourcing challenges is out of scope and would be both a security and an integrity problem.
2. **It does not defeat a determined classifier.** The signals are fused by a model we cannot inspect; the goal is to be indistinguishable from a *population*, not from a specific human, and the residual is a measurable false-positive rate we track as a KPI.
3. **It is not a licence to automate prohibited actions.** The governor runs only inside the capability system (`AGENT.md` §5): every emulated action is an authorised atom with an AUDIT record, and Class-B effects still require a human.
4. **It costs latency.** Human pacing makes a task take 3–10× longer than an instant-mation bot. That is the *point* — it is the same trade Tor makes between latency and anonymity — and the UI must set the expectation before the first task, not after.

---

## 6. Implementation and verification

### 6.1 Patch inventory

| # | File / function | Change | Risk | Test |
|---|---|---|---|---|
| 1 | `dom/canvas/CanvasRenderingContext2D.cpp` | blank/canonical readback | M | canvas corpus |
| 2 | `dom/canvas/CanvasUtils.cpp` | single choke point | L | binding enumeration test |
| 3 | `dom/canvas/WebGLContext.cpp` | parameter spoof, disable in VEIL | M | WebGL corpus |
| 4 | `dom/media/webaudio/AnalyserNode.cpp` | quantise/dither | L | audio corpus |
| 5 | `dom/media/webaudio/AudioContext.cpp` | sample rate, latency | L | idem |
| 6 | `layout/base/ppx/Letterbox.cpp` | pre-layout rounding | **H** | resize/reflow tests |
| 7 | `dom/base/Screen.cpp` | manifest values | L | — |
| 8 | `dom/base/Navigator.cpp` | manifest values, `webdriver` removal | L | — |
| 9 | `dom/base/NavigatorUAData.cpp` | canonical low-entropy | M | — |
| 10 | `intl/.../DateTimeInfo` | UTC pin | M | — |
| 11 | `gfx/thebes/gfxPlatformFontList.cpp` | whitelist | M | font probes |
| 12 | `gfx/thebes/gfxFont.cpp` | hinting/subpixel metrics | M | metric determinism |
| 13 | `dom/base/nsRFPService.cpp` | timer clamp, deterministic jitter | L | timer corpus |
| 14 | `js/src/vm/...` process init | SAB off | L | feature detection |
| 15 | `dom/media/PeerConnection.js` | UA-CH/WebRTC consistency | L | — |

### 6.2 CI: the two-VM golden diff (I1)

Two VMs with deliberately different hardware and OS configuration:

- VM-A: Intel iGPU, Windows 11, en-US, 125 % DPI, Helvetica installed.
- VM-B: NVIDIA dGPU, Linux, de-DE, 100 % DPI, no MS fonts, different timezone.

Each runs the fingerprint harness (adapted from Tor Browser's test corpora and our own 31-surface list), producing a JSON manifest of observed values. **The diff must be empty**, and a single difference fails the build. The harness additionally runs *differential consistency* checks (§5.6), because two identical-but-contradictory fingerprints are still a fingerprint.

### 6.3 Breakage management

| Breakage | Response |
|---|---|
| Canvas-dependent app (maps, design tools, image editors) | User grants `CAP_CANVAS` for the origin; readback stays canonical, so the grant does not create entropy |
| Audio-dependent app with a visualiser | Same capability class (`CAP_AUDIO_READBACK`) |
| WebGL-only app in VEIL | Not supported by design; the UI explains and offers "open in SHADOW" (where WebGL is permitted and the session is already non-anonymous) |
| Missing system font | Bundled metric-compatible fallback (Carlito/Liberation/etc.); document editors keep their layout |
| Timezone-sensitive app (calendar) | Regional Consistency Mode (`ID-3` only), with explicit consent |
| Site detects "unusual" configuration | That is the price of anonymity: we are unusual on purpose, and we are uniform with every other user of this build |

### 6.4 Rollout

1. **M0–M1**: patches 1–5 and 7–13 land behind `ppx_veil_only`; harness runs in report-only mode.
2. **M2**: golden diff must be empty for surfaces 1–15 before LATTICE work merges (the agent's grounding depends on deterministic layout).
3. **M3**: governor ships with a *conservative* parameter set (slower, more human) and a per-site pause switch.
4. **M4**: full 31-surface gate; Regional Consistency Mode documented; red-team exercise on the consistency matrix.

---

## 7. Amendments to PSC-ARCH-001

| ID | Amendment | Rationale |
|---|---|---|
| **A-4** | Add capability classes `CAP_CANVAS` and `CAP_AUDIO_READBACK` (per-origin, Class-A grants) | Lets real apps work without reintroducing entropy: the readback stays canonical |
| **A-5** | WebGL is disabled in VEIL, permitted in SHADOW | Closes the largest hardware-entropy surface; SHADOW is already non-anonymous |
| **A-6** | Behavioural emulation parameters are build-shared distributions, not per-user calibration | Prevents the governor becoming a behavioural biometric (extends F-1 to behaviour) |
| **A-7** | Add the consistency matrix (§5.6) to the I1 gate | A uniform fingerprint is worthless if it contradicts itself |

---

## 8. References

1. Tor Browser design document — fingerprinting defence philosophy and the "differentiate from Firefox" position. [tor-browser-spec](https://gitlab.torproject.org/tpo/applications/tor-browser-spec/-/blame/47ca2d1b25e5e2153369a70aa7d908043f8f7396/design-doc/design.xml?page=2#2)
2. Mozilla — Tor Uplift tracking, including the canvas prompt, WebGL, font and media patches referenced in §2. [wiki.mozilla.org](https://m.wiki.mozilla.org/index.php?title=Security/Tor_Uplift/Tracking&oldid=1139403)
3. Mozilla — `privacy.resistFingerprinting` and the timing-precision machinery (`ReduceTimePrecisionAsUSecs`, `privacy.reduceTimerPrecision.microseconds`, jitter). [Searchfox: nsRFPService.cpp](https://searchfox.org/mozilla-central/source/dom/base/nsRFPService.cpp)
4. W3C — `NetworkIsolationKey`-adjacent privacy partitioning and the fingerprinting surface definitions used to enumerate the 31 surfaces. [w3c.github.io/privacy-threat-model](https://w3c.github.io/privacy-threat-model/)
5. Fitts, P. M. (1954) — the reciprocal speed–accuracy law used for pointer duration; Meyer et al. (1988) — optimised submovement model used for overshoot.
6. Card, Moran & Newell (1983) — keystroke-level model, source of the inter-key interval magnitudes used in §5.4.

