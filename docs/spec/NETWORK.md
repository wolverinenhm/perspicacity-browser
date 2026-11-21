# Perspicacity — Embedded Onion Routing in the Network Service

**Implementation plan for an in-process Arti client with strict circuit isolation, leak prevention, and native pluggable transports**

| Field | Value |
|---|---|
| Document ID | PSC-NET-002 |
| Revision | 1.0 |
| Status | Proposed — for technical review |
| Parent specification | `ARCHITECTURE.md` (PSC-ARCH-001), §4, §5.7, §6.3 |
| Audience | Network stack engineers, Rust systems engineers, security reviewers |
| Normative language | RFC 2119 (MUST / SHOULD / MAY) |

---

## 0. Conformance to PSC-ARCH-001

This document is a child of the architecture specification. Every mechanism below exists to satisfy an invariant, a contract rule, or a threat control already defined there; where it proposes a change, the change is registered in §11 and in the parent's Appendix H.

| Parent reference | Obligation | How this document satisfies it |
|---|---|---|
| §4.2 CIC-1 (no ambient authority) | `ppx-net` is the only socket owner; no other process may reach the network | §3.2: single-owner enforcement, compile-time and seccomp-level |
| §4.8 (fail closed) | Tor loss MUST NOT fall back to cleartext | §4.6 readiness gate; §5.6 no direct path exists in the VEIL build |
| §5.2.2 (network supercookies) | HSTS/Alt-Svc/TLS tickets/DNS cache must not persist | §5.5: state placement and per-class TLS session caches |
| §5.7 (egress allowlist) | Every network effect is enumerable and attributed | §3.4 `EgressPort` implementation and `purpose` tagging |
| §6.3.1 (circuit isolation) | Distinct circuits per FPD and per identity class | §6: `NetworkIsolationKey` → `IsolationToken` derivation, one `TorClient` per class |
| §6.3.2 C-6 (direct-path leakage) | No UDP, no QUIC, no unproxied DNS, no speculative sockets | §7: the leak matrix and its enforcement points |
| §1.4 I6 | No VEIL traffic shares a circuit across FPDs or classes | §9.1: circuit-isolation conformance harness |

**Out of scope.** Tor protocol cryptography, relay selection theory, and the sociology of circumvention (which bridges to recommend to which population). This is an engineering specification for the client side of those systems.

---

## 1. Why embed, and what it actually buys

### 1.1 The localhost proxy is a leak surface, not a convenience

The conventional architecture — browser → `127.0.0.1:9050` SOCKS5 → `tor` daemon — has six defect classes that cannot be fixed by configuration:

| # | Defect | Consequence | Why configuration cannot fix it |
|---|---|---|---|
| P-1 | **Any local process can use the proxy** | A compromised or malicious local app inherits the user's anonymity and their guard observations; the operator cannot attribute traffic | SOCKS5 has no client authentication, and even with it, the credential must live somewhere the browser can read |
| P-2 | **Web content can reach the proxy port** | `fetch("http://127.0.0.1:9050")` from a page is a localhost-SSRF probe; PNA/LNA preflights help, they do not eliminate the surface | The listener exists; its existence is the vulnerability |
| P-3 | **Port squatting / race on start** | A malicious process binds 9050 first and silently proxies (or records) all traffic | The browser must connect to a *name*, and names are claimable |
| P-4 | **Configuration drift** | A user disables the proxy, changes the port, installs a PAC file, or an update resets a pref | There is no single authority that can *prove* no direct path exists |
| P-5 | **Resolution ambiguity** | `socks5://` vs `socks5h://`, `network.proxy.socks_remote_dns` mis-set, or a proxy that resolves locally | DNS leaks are decided by a string in a pref, not by a type system |
| P-6 | **Process lifetime coupling** | Browser dies, daemon survives (state leaks across sessions); daemon dies, browser silently goes direct | Two lifecycles that must be reconciled by heuristics |

Embedding Arti removes P-1 through P-6 *structurally*: there is no listener, no name, no pref, no second lifecycle, and resolution is a property of the address type rather than a configuration. That is the entire argument. It is not a performance argument (Arti is currently slower than C-Tor on some paths) and it is not a purity argument.

### 1.2 What embedding costs

Honesty about the price, because it shapes the plan:

| Cost | Magnitude | Mitigation |
|---|---|---|
| We own bootstrap, guard state, PT supervision and failure handling | ~3 engineer-months to first light; ongoing | §4, §8; reuse Tor Browser's UX decisions |
| Arti is younger than C-Tor | Fewer deployed years, less adversarial review | Pin a specific Arti release per browser release; fuzz the client state machine; keep the network service outside the TCB (it already is) |
| No SOCKS means no free interoperability | Every consumer must use our `EgressPort` | That is the design: `EgressPort` is where policy lives (§3.4) |
| Feature lag (e.g. onion-service client auth, conflux) | Some Tor features unavailable | Explicitly out of scope for VEIL; revisit per release |
| Rust in the network process | Second toolchain, ABI surface | `cxx` bridge, pinned toolchain, no `unsafe` in our crates (`#![forbid(unsafe_code)]` except the FFI module) |

### 1.3 The resulting shape

```text
┌──────────────────────────── ppx-browser (TCB) ────────────────────────────┐
│  Necko front-end (nsIChannel, load groups, cache)   ← no sockets          │
└───────────────▲───────────────────────────────────────────┬───────────────┘
                │ cap-ipdl: PpxNet (Navigate, Cancel, Ack)   │ SENTRY policy
┌───────────────┴──────────────────────────── ppx-net (untrusted) ──────────┐
│  Necko socket layer (nsSocketTransport)                                   │
│      │ tcp stream handed to…                                              │
│      ▼                                                                    │
│  ppx-tor  ── arti-client::TorClient × N (one per identity class)          │
│      │        └── tokio runtime (dedicated threads, no tokio in parent)   │
│      │             └── tor-proto / tor-circmgr / tor-chanmgr              │
│      ▼                                                                    │
│  ppx-pt supervisor ── obfs4 (lyrebird) │ snowflake │ webtunnel  (children) │
└───────────────┬───────────────────────────────────────────────────────────┘
                │ TLS over TCP (only egress in the product)
                ▼
        Guard ── Middle ── Exit ──▶ origin
```

Note the direction of the FFI: **C++ owns the file descriptors, Rust owns the circuits.** The socket layer never gives Arti a raw socket; it gives it a `tokio`-compatible TCP stream that the socket process created under its own sandbox and its own accounting. This keeps fd lifetime, byte accounting and shutdown semantics in one place (the C++ side), which matters for SENTRY's disclosure log and for crash-only teardown (§4.5).

---

## 2. Crate and process layout

### 2.1 Crates

| Crate | Language | Responsibility | Unsafe |
|---|---|---|---|
| `ppx-tor` | Rust | Arti lifecycle, per-class clients, isolation token derivation, stream allocation | `#![deny(unsafe_code)]` except `ffi` |
| `ppx-tor-ffi` | Rust + C++ | `cxx` bridge: async stream open, events, config | `#[cxx::bridge]` only |
| `ppx-pt` | Rust | PT supervisor, bridge bootstrap (Moat/rdsys), PT health | `#![forbid(unsafe_code)]` |
| `ppx-egress` | Rust | SENTRY client: purpose tagging, DLP hooks, disclosure records | safe |
| `ppx-isolation` | Rust | `NetworkIsolationKey` → `IsolationToken`, per-class client registry | safe |
| `netwerk/` (Gecko, patched) | C++ | Connection pooling keyed by isolation, socket creation, speculative-load removal | existing |

### 2.2 Threading model

Arti is `async` and expects a `tokio`-compatible runtime (`tor-rtcompat` `TokioRustlsRuntime` or `NativeTlsProvider`). The Gecko socket process is threaded C++ with its own event loop. The bridge is therefore explicit:

- A **dedicated** `tokio::runtime::Runtime` with `worker_threads = 2` and `max_blocking_threads = 4`, created on first use, owned by `ppx-tor`. No other runtime exists in the product.
- C++ **never** calls into Rust on a Gecko thread and blocks. Every call returns a `cxx::Future` or posts a completion to a Gecko `nsIEventTarget` (`SocketThread`), so the socket thread never blocks on Tor.
- Rust **never** calls into C++ synchronously from a Tokio worker except to enqueue a task onto the socket thread (a non-blocking post with a bounded queue; a full queue is a fatal error for that stream, not a block).
- Shutdown is ordered: stop accepting → cancel all streams (`CancellationToken`) → wait ≤ 2 s → abort runtime → close fds. This matches the crash-only teardown in §5.6 of the parent.

### 2.3 The bridge (abridged `cxx`)

```rust
// pp/ppx-tor-ffi/src/lib.rs
#[cxx::bridge(namespace = "ppx::net")]
mod ffi {
    /// One per identity class. Opaque to C++.
    struct ClientStats {
        bootstrap_percent: u8,
        circuits_ready: u32,
        streams_open: u32,
        guard_fingerprint: [u8; 20], // for the local privacy dashboard only
    }

    struct TorConfig {
        data_dir: String,       // a memfd path or a CELL-D path; never $HOME
        cache_dir: String,
        socks_unused: bool,     // always true: documents that no listener exists
        bridges_enabled: bool,
        pt_dir: String,
        timeout_connect_ms: u32,
        timeout_circuit_ms: u32,
    }

    extern "Rust" {
        type TorRuntime;

        fn runtime_start(cfg: &TorConfig) -> Result<Box<TorRuntime>>;
        fn bootstrap(runtime: &TorRuntime, class_id: u8) -> Result<u8>;  // percent, blocking-free
        fn new_isolation_client(runtime: &TorRuntime, class_id: u8, salt: &[u8])
            -> Result<u64>;                                            // client handle
        fn connect_stream(
            runtime: &TorRuntime,
            client: u64,
            host: &str,             // hostname or IP literal; resolution is exit-side
            port: u16,
            isolation_token: &[u8; 32],
            purpose: u32,           // maps to EgressPort purpose enum
        ) -> Result<Box<StreamHandle>>;
        fn stream_write(h: &mut StreamHandle, data: &[u8]) -> Result<usize>;
        fn stream_read(h: &mut StreamHandle, buf: &mut [u8]) -> Result<usize>;
        fn stream_shutdown(h: &mut StreamHandle);
        fn stats(runtime: &TorRuntime, client: u64) -> ClientStats;
        fn stop(runtime: &TorRuntime);
    }
}
```

The C++ side wraps this in `PpxTorService`, a `nsISocketTransportService`-adjacent facade that Necko's `nsHttpConnectionMgr` already understands:

```cpp
// netwerk/protocol/ppx/PpxTorTransport.cpp  (new)
class PpxTorTransport final : public nsISocketTransport {
 public:
  NS_DECL_ISUPPORTS
  // Necko calls OpenInputStream/OpenOutputStream exactly as for a TCP socket,
  // so the HTTP stack needs no changes beyond the transport factory switch.
  NS_IMETHOD OpenInputStream(uint32_t flags, uint32_t seg,
                             nsIInputStream** out) override {
    return mBridge->OpenInputStream(mHandle, flags, seg, out);
  }
  // ...
 private:
  ~PpxTorTransport() = default;
  RefPtr<PpxTorBridge> mBridge;
  ppx::net::BoxStreamHandle mHandle;  // Rust-owned
  IsolationToken mToken;              // 32 bytes, see §6.2
};
```

**Why this shape.** Necko's HTTP/2, HTTP/1.1, cache, and connection-pool logic are mature and battle-tested; rewriting them over a Rust async API would be a multi-year regression risk. By presenting Arti as *another socket transport*, we inherit all of it and change exactly two things: which transport the connection manager picks, and what key the pool is bucketed by (§6.5).

---

## 3. Egress ownership and enforcement

### 3.1 Compile-time single egress

The VEIL build is compiled with `-DPPX_VEIL_ONLY=1`, which removes from the binary:

- `nsSocketTransport`'s direct-connect path (`PR_Connect` call sites behind `#if !PPX_VEIL_ONLY`),
- `nsHttpChannel`'s `Alt-Svc` and `HTTP/3` code paths,
- `network.predictor` (DNS/connection pre-warm),
- `nsDNSService`'s platform-resolver backend (only the "exit-side resolution" path remains),
- the PAC/proxy configuration service (`nsProtocolProxyService` retains only `EgressPort` routing),
- `WebRTC`'s UDP socket factory.

A release build therefore *cannot* open a direct connection even if policy is subverted at runtime. This is the difference between "we set a pref" and "the code is not there", and it is the standard the parent sets in §5.2.3.

### 3.2 Runtime single egress

Defence in depth on top of the compile-time removal:

| Layer | Mechanism | Verification |
|---|---|---|
| Process | Only `ppx-net`, `ppx-pt` and `ppx-infer` (via `ppx-net`) have a socket capability | `capgraph` + per-process seccomp allowlist |
| Syscall | `socket(AF_INET, SOCK_DGRAM, …)` denied everywhere except `ppx-pt`; `connect()` denied in all processes except `ppx-net`/`ppx-pt` | seccomp filter unit test, nightly syscall audit |
| API | All egress flows through `EgressPort::Submit` with a `purpose`; unknown purpose = deny | SENTRY conformance test |
| Accounting | Every fd is registered with a `(class, purpose, origin)` tuple at creation; unregistered fds are killed by a watchdog | fd-audit test (I6 companion) |
| Build | `nm`/`strings` check: no symbol named `PR_Connect` in the VEIL binary's `ppx-net` component | CI gate |

### 3.3 DNS posture: exit-side resolution instead of DoH

The prompt asks for DoH tunnelled through the exit. Architecturally, that is the wrong target, and it is worth being precise about why:

- With Arti, `connect_stream(host="example.com")` sends the **hostname** inside the Tor `CONNECT` cell; the exit resolves it. There is no local resolver, no local cache, and no DoH request to leak, because the browser never performs a DNS lookup of its own.
- A DoH resolver reached *through Tor* would be strictly worse: it adds a second party that sees the full query set under a stable identity, and it re-introduces a persistent cache.
- The residual risks that DoH-through-Tor would address are (a) a hostile exit logging queries and (b) an origin that requires ECH. (a) is an accepted Tor trade-off; (b) is handled at the TLS layer, not by DNS.

Therefore: **VEIL forbids DoH and all local resolution.** `TorAddr::Hostname` is the only address form the API accepts; an IP literal is allowed but tagged `purpose=direct-ip` and displayed in the disclosure log (it is a real fingerprint: few sites are reached by IP). For `ID-3` (attributed, no Tor), `ppx-net` offers DoH with a user-selected resolver, pinned by SPKI hash, with cache disabled; that is the only place DoH exists in the product.

**One exception, carefully bounded:** bridge bootstrap (Moat, §8.3) requires HTTPS to a *fronted* endpoint before Tor is available. That request is made by `ppx-pt` over a plain `rustls` connection with domain fronting, has no cookies, no referrer, no client hints, and is distinguishable from page traffic by design. It is disclosed once, at first use, in the bootstrap UI.

### 3.4 `EgressPort`: the only door

```rust
// ppx-egress/src/lib.rs
pub enum Purpose {
    Navigate, Subresource, Fetch, WebSocket, EventSource,
    ModelInfer, UpdateCheck, BridgeBootstrap, DirectIp,
}

pub struct EgressRequest<'a> {
    pub class: IdentityClass,
    pub purpose: Purpose,
    pub origin: Origin,          // scheme + host + port; never a full URL
    pub isolation: IsolationToken,
    pub body: &'a [u8],          // empty for GET; bounded at 64 KiB for DLP scan
}

pub async fn submit(req: EgressRequest<'_>) -> Result<EgressGrant, EgressError> {
    // 1. Policy: purpose must be enabled for the callers' class.
    POLICY.check(req.class, req.purpose)?;
    // 2. DLP: only for purposes that can carry secrets (ModelInfer, UpdateCheck).
    if req.purpose.carries_payload() { DLP::scan(req.body)?; }
    // 3. Attribution: record (class, purpose, origin, len, digest) BEFORE connecting.
    AUDIT.disclosure(&req)?;
    // 4. Connect through the class's TorClient with this isolation token.
    TOR.connect(req.class, &req.origin, &req.isolation, req.purpose).await
}
```

The invariant that makes this worth the indirection: **no successful connection exists without a prior AUDIT record.** The audit append is fsync'd and the connect is sequenced after it, so a crash cannot produce an unattributed connection, and an attacker who compromises a component cannot create one without also forging an HMAC-chained audit entry (which requires CUSTOS).

---

## 4. Lifecycle, bootstrap, and failure

### 4.1 States

```rust
#[derive(Clone, Debug)]
pub enum TorState {
    Stopped,
    Bootstrapping { pct: u8, phase: BootstrapPhase },
    Ready { guards: usize, built_in_ms: u32 },
    Degraded { reason: DegradedReason },   // usable but policy-restricted
    Failed  { reason: FailReason },        // fail closed; UI blocks navigation
}

pub enum BootstrapPhase { Connecting, Handshake, RequestingDescriptors, LoadingKeys, BuildingCircuit }
```

State transitions are monotonic within a session except `Degraded`/`Failed`, which are terminal until an explicit user retry. `Ready` is **required** before any VEIL navigation may be committed; the UI shows a progress indicator in trust chrome and the address bar refuses to navigate (rather than showing a network error, which would encourage retrying outside the browser).

### 4.2 Bootstrap

```rust
// ppx-tor/src/runtime.rs
pub async fn bootstrap(&self, class: IdentityClass) -> Result<u8> {
    let cfg = TorClientConfigBuilder::from_directories(&self.dirs).build()?;
    let client = TorClient::create_bootstrapped(cfg).await?; // blocks until usable
    // Report progress through an event stream so trust chrome can show it.
    self.events.emit(TorEvent::Ready { class, guards: client.guard_count() });
    self.clients.insert(class, Arc::new(client));
    Ok(100)
}
```

Two production details:

> **A note on API names.** Signatures in this document track a *pinned* Arti release (the version is part of the browser's dependency manifest and is bumped only with a full network-service regression run). Where the pinned release lacks an accessor used above — a guard count, an explicit dirty-circuit signal — the surrounding design is unaffected: the property we depend on is that equal isolation tokens share a circuit and unequal tokens do not, which is `tor-circmgr`'s contract, not an API convention.

1. **Pre-bootstrap the classes the user will need, lazily.** `ID-0` bootstraps at first VEIL navigation; `ID-1`/`ID-2` bootstrap when a task is created. A dedicated class client costs ~1–3 s of bootstrap and ~2–6 MB of RAM, so we do not pay it for classes the user never touches.
2. **Never bootstrap in a way that leaks the clock.** Tor's TLS validation needs a sane clock; a device with a wildly wrong clock fails bootstrap with an error that uniquely identifies the device to a network observer watching the handshake. Mitigation: on bootstrap failure due to time skew, we do *not* attempt NTP (a beacon); we surface "system clock appears incorrect" and refuse. This is a small example of how anonymity requirements invert normal engineering instincts.

### 4.3 Guards and state persistence (amendment A-1)

This is the one place where this document proposes a change to the parent, and it is worth stating plainly.

The parent (§5.2, §5.4) says session state is RAM-only and nothing persists. For Tor guards, strict adherence would mean **new entry guards every session**. That is worse for security: guard discovery and guard-rotation attacks are exactly what long-lived, pinned guards defend against, and an adversary at the network edge benefits from forcing rotation. It is *not* worse for anonymity in the sense that matters, because a guard set is not observable by sites and is not a join key across identity classes as long as it is per-class.

**Proposal (registered as A-1):** persist *only* the guard set and the bridge line, encrypted per identity class in CELL-D, for at most 30 days, never shared between classes, and never for `ID-1` ephemeral task identities (which MUST get a fresh guard set, because a task identity should not be linkable to a previous one even at the entry node).

| Class | Guard persistence | Rationale |
|---|---|---|
| `ID-0` | 30 days, encrypted, class-scoped | Guard security dominates; no cross-class sharing |
| `ID-1` | none (fresh per task) | Task identity must be unlinkable at every hop, including entry |
| `ID-2` | 30 days per persona | A durable pseudonym needs stable guards to avoid guard-discovery |
| `ID-3` | not Tor by default | — |

Implementation: Arti's state directory points at a `CELL-D`-backed path exposed by `ppx-cell` (a per-class encrypted directory, not the generic VFS arena, because file semantics are simpler here and Arti writes SQLite-based state). The key comes from CUSTOS via a `CAP_KEYOP` handle; `ppx-tor` never sees the raw key, only a file handle opened by `ppx-cell` after unwrapping. On class deletion, the directory is destroyed and the key revoked.

### 4.4 Circuit build policy

| Parameter | VEIL value | Rationale |
|---|---|---|
| `MaxCircuitDirtiness` equivalent (`circuit_max_dirty`) | 600 s | Matches Tor Browser; limits per-exit linkability |
| Pre-built circuits per client | 2 | Avoids the ~400 ms cold-build on the critical path without fanning out |
| Conflux (multi-path) | **disabled** | Splits flows across paths, which weakens the correlation story and complicates isolation accounting |
| Path bias / guard pinning | Arti defaults + 1 pinned primary guard | Matches Tor's guard design |
| Stream timeout (connect) | 45 s | Long enough for a slow exit; short enough not to hang the UI |
| Stream timeout (idle) | 300 s | Drains pre-built circuits rather than holding them open |

### 4.5 Teardown

Ordered, and observable: cancel `CancellationToken` → `TorClient::…shutdown()` → drop the runtime → `ppx-cell` wipes the class directory → CUSTOS destroys the class key. The whole sequence is bounded at 2 s; exceeding it is a `WIPE_INCOMPLETE` event in AUDIT and a UI warning on next start (consistent with §5.6 of the parent). A crash that skips teardown leaves only ciphertext (guard state) and no plaintext.

### 4.6 Failure policy (fail closed)

| Failure | Behaviour |
|---|---|
| Bootstrap fails | No navigation is possible. UI offers retry, bridge configuration, and "quit". Never offers "continue without Tor" |
| PT exits | The client using it fails; other clients unaffected; a circuit rebuilt on a dead PT is retried once, then the class is `Degraded` |
| Exit blocks the target | Surface the exit's failure as an origin error; do not retry through another circuit automatically (retrying on a new exit with the same stream content is itself a correlation signal, and can look like a probing client) |
| Clock skew | Refuse, with an explanatory dialog; no NTP |
| Suspend/resume | All streams cancelled, all circuits torn down, fresh bootstrap, session keys rotated (parent §5.2, "sleep is a security event") |

---

## 5. Transport integration with Necko

### 5.1 Transport selection

```cpp
// netwerk/base/nsSocketTransportService2.cpp (patched)
already_AddRefed<nsISocketTransport> PpxTransportFactory::CreateTransport(
    const nsACString& aHost, int32_t aPort,
    const OriginAttributes& aAttrs, const NetworkIsolationKey& aKey) {
  if (StaticPrefs::ppx_veil_only()) {
    auto token = ppx::isolation::TokenFor(aAttrs, aKey);   // §6.2
    return MakeAndAddRef<PpxTorTransport>(aHost, aPort, token, aAttrs);
  }
  return LegacyDirectTransport(aHost, aPort, aAttrs);      // only reachable in ID-3
}
```

### 5.2 Connection pooling keyed by isolation

Gecko's `nsHttpConnectionMgr` already buckets connections by a `ConnectionEntry` key that includes `OriginAttributes`. We extend the key:

```cpp
// netwerk/protocol/http/nsHttpConnectionInfo.h (patched)
struct IsolationKey {
  OriginAttributes mAttrs;          // includes firstPartyDomain + userContextId(=class)
  NetworkIsolationKey mNik;         // top-level site + nonce
  IsolationToken mTorToken;         // 32 bytes, derived (§6.2)

  bool operator==(const IsolationKey& o) const {
    return mAttrs == o.mAttrs && mNik == o.mNik &&
           std::memcmp(mTorToken.bytes, o.mTorToken.bytes, 32) == 0;
  }
};
```

**Invariant (tested):** two connections with different `IsolationKey`s are never multiplexed onto the same HTTP/2 connection and never share a TLS session cache entry. This is the local half of I6; the remote half (circuits) is §6.4.

### 5.3 The speculative-load inventory (what must be removed)

| Feature | Gecko pref / code | VEIL action |
|---|---|---|
| Link prefetch | `network.prefetch-next` | off; handler removed |
| DNS prefetch | `network.dns.disablePrefetch` | off; `dns-prefetch` hint ignored |
| Preconnect | `network.preconnect` | off; hint ignored |
| Speculation Rules / prerender | `dom.speculation_rules.enabled`, `fission.webContentIsolationStrategy` interactions | disabled |
| `<a ping>` | `browser.send_pings` | disabled |
| Pre-warmed socket pool | `network.http.connection-retry-timeout`, pool early-open | disabled |
| OCSP live fetch | `security.OCSP.enabled` | 0 (stapling only, CRLite local) |
| Alt-Svc | `network.http.altsvc.enabled` | disabled and code path removed |
| HSTS write | `network.stricttransportsecurity.preloadlist` (read-only preload) | read-only, RAM-only additions |
| Favicon auto-fetch | browser UI | lazy, foreground tab only, no cache |

This table is the implementation of parent §5.2.2–5.2.3 and §6.3.3, and the CI syscall audit asserts that removing them did in fact remove the syscalls (a disabled pref whose code still opens a socket is a false sense of security).

### 5.4 TLS session handling

- Tickets and 0-RTT: disabled in VEIL (`security.tls.enable_0rtt_data=false`, `security.tls.enable_tickets=false`) because a resumed session is a stable identifier at the origin *and* at the exit.
- Session cache: per `(IsolationKey)`, in RAM, never written to CELL-V's DB.
- ClientHello: a single canonical profile (cipher list order, extensions, GREASE, ALPN), identical for all users (parent Appendix C, surface #21). This is a *fingerprint* control implemented in the network layer, so it is specified here and tested by the fingerprint conformance suite in `FINGERPRINT.md`.
- ECH: enabled where the exit supports it (it is a genuine improvement to the exit→origin leg), with the caveat that ECH's outer SNI is a public-visibility downgrade the UI explains.

---

## 6. Strict stream and circuit isolation

### 6.1 The isolation dimensions

Isolation must be enforced on *five* independent dimensions, and it is a defect if any two of them collapse into one. The parent's RULE-1 is the first two; the rest are the network-layer consequences.

| Dim | Key material | Consequence of collapse |
|---|---|---|
| **D1 Class** | identity class (`ID-0`…`ID-3`) | A task's traffic shares an exit and (worse) a guard with the user's browsing |
| **D2 First-party domain** | registrable domain of the top-level document | Cross-site linkability at the exit; classic Tor Browser bug class |
| **D3 Role** | `UserTab` vs `AgentTask` vs `Background` (update, CRLite) | Background maintenance becomes a clock and a join key for foreground activity |
| **D4 Purpose** | navigate vs subresource vs model inference | Model traffic and page traffic share a path → prompt/page correlation |
| **D5 Time** | circuit dirtiness window + stream birth time | Long-lived circuits build a per-exit history |

D3 and D5 are the dimensions most often forgotten, and they are exactly where an agentic browser leaks: a background agent's research traffic and the user's foreground reading are both "the browser" to a naive design.

### 6.2 Deriving the isolation token

Arti's `StreamPrefs::set_isolation_group(IsolationToken)` takes an opaque token; streams with different tokens are guaranteed by `tor-circmgr` not to share a circuit. The token must be *stable for the isolation key* and *unguessable/unlinkable* for everyone else, so it is derived, not stored:

```rust
// ppx-isolation/src/lib.rs
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct IsolationKey {
    pub class: IdentityClass,
    pub first_party: RegistrableDomain,  // eTLD+1, IDNA-normalised, lowercased
    pub role: Role,
    pub purpose: Purpose,
}

pub struct IsolationDeriver { salt: [u8; 32] }   // per session, from CUSTOS, never logged

impl IsolationDeriver {
    /// 32-byte token handed to Arti. Deterministic within the session, so a tab's
    /// subresources reuse its circuit; unlinkable across sessions and across keys.
    pub fn token(&self, k: &IsolationKey) -> IsolationToken {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.salt).unwrap();
        mac.update(b"ppx/isolation/v1");
        mac.update(&[k.class as u8]);
        mac.update(&(k.first_party.as_str().len() as u16).to_be_bytes());
        mac.update(k.first_party.as_str().as_bytes());
        mac.update(&[k.role as u8, k.purpose as u8]);
        let mut out = [0u8; 32];
        mac.finalize().into_bytes().copy_into_slice(&mut out);
        IsolationToken::from_bytes(out)   // `arti_client::IsolationToken`
    }
}
```

Two properties are worth spelling out because they are what make this safe:

1. **The FPD is not sent to Tor.** Arti sees a 32-byte HMAC, not `example.com`. The token is used purely as an equality class inside `tor-circmgr`. This is strictly stronger than the SOCKS-username approach used by Tor Browser, where the credential (even if obfuscated) is visible to the Tor process and to anything that can read its config or memory.
2. **The mapping is invertible only by us.** Because the salt is per-session and comes from CUSTOS, a stolen disk yields no link between tokens and domains, and a process that dumps memory in one session cannot match tokens in the next.

### 6.3 One client per identity class

```rust
pub struct ClientRegistry {
    clients: HashMap<IdentityClass, Arc<TorClient<TokioRustlsRuntime>>>,
    deriver: IsolationDeriver,
    dirs: HashMap<IdentityClass, ClassDirs>,   // §4.3
}

impl ClientRegistry {
    pub async fn client(&mut self, class: IdentityClass) -> Result<Arc<TorClient<_>>> {
        if let Some(c) = self.clients.get(&class) { return Ok(c.clone()); }
        let cfg = self.config_for(class)?;            // its own guard state, its own bridges
        let c = Arc::new(TorClient::create_bootstrapped(cfg).await?);
        self.clients.insert(class, c.clone());
        Ok(c)
    }

    pub async fn connect(&mut self, k: IsolationKey, host: &str, port: u16)
        -> Result<DataStream> {
        // Cross-class join: structurally impossible because the client differs.
        let client = self.client(k.class).await?;
        let mut prefs = StreamPrefs::new();
        prefs.set_isolation_group(self.deriver.token(&k));
        prefs.set_connect_timeout(Duration::from_millis(45_000));
        // Hostname, never a resolved IP: resolution happens at the exit (§3.3).
        let addr = TorAddr::from((host, port))?;
        client.connect_with_prefs(addr, &prefs).await
    }
}
```

**Why a client per class rather than one client with distinct tokens?** Because a `TorClient` owns a guard set. Sharing a client across classes means the same entry guard observes both the user's browsing and the agent's research, which is precisely the join we are trying to prevent at D1. The cost is one bootstrap per class (lazily, §4.2) and a small amount of duplicate directory state; the benefit is that **class separation holds at every hop, not merely at the exit.**

### 6.4 The stream→circuit assertion

Isolation is a claim until it is measured. In debug and in the conformance harness, `ppx-tor` subscribes to `tor-circmgr` events and records `(IsolationToken, CircuitId)` pairs in a local ring buffer:

```rust
// Only compiled with feature = "isolation-audit".
fn on_stream_attached(ev: &StreamEvent) {
    let tok = ev.isolation_token;
    let circ = ev.circuit_id;
    match AUDIT_RING.last_circuit_for(tok) {
        Some(c) if c != circ => {
            // Legitimate: the dirty window elapsed. Illegal: same token, live circuit, different id.
            assert!(ev.previous_circuit_dirty, "ISOLATION VIOLATION: token reused across live circuits");
        }
        _ => {}
    }
    AUDIT_RING.record(tok, circ);
}
```

The harness then asserts the *equivalence relation*: for every pair of streams, `same_isolation_key ⇔ same_circuit`, within one dirty window. This is the test that catches the class of bug where a refactor accidentally derives the token from the origin instead of the first-party domain — a one-line change that would silently merge every subresource on the page into a different circuit and destroy the anonymity set's shape.

### 6.5 Pool, TLS cache and DNS cache keying

All caches that can outlive a connection must be keyed by `IsolationKey`, not by origin:

| Cache | Key | Location | Lifetime |
|---|---|---|---|
| HTTP/2 connection pool | `IsolationKey` + origin | `ppx-net` | circuit dirty window |
| TLS session cache | `IsolationKey` + origin | `ppx-net` RAM | session |
| DNS (exit-side) | none — no local cache | — | — |
| HSTS | first-party domain (RAM) | `ppx-cell` | session |
| HTTP cache | `IsolationKey` | CELL-V | session |
| Alt-Svc | disabled | — | — |
| OCSP/CRLite | content-hash keyed, local only | CELL-P (CRLite data) | release |

### 6.6 Shadow Window isolation (the agent/foreground split)

The requirement is stronger than "the agent gets its own tab". A Shadow task MUST be isolated from the user's browsing on **all five dimensions, plus a sixth: concurrency.**

```rust
pub struct ShadowIsolation {
    pub task_uuid: Uuid,
    pub declared_origins: OriginBudget,   // from the plan, §AGENT
    pub class: IdentityClass,             // ID-1 or ID-2 only
}

impl ShadowIsolation {
    pub fn key(&self, fp: RegistrableDomain, purpose: Purpose) -> IsolationKey {
        // Role::AgentTask guarantees the agent never shares a circuit with a user tab,
        // even when both are on the same first-party domain and in the same class.
        IsolationKey { class: self.class, first_party: fp, role: Role::AgentTask, purpose }
    }
}
```

Consequences, and they are deliberate:

- **Same site, different circuits.** If the user has `shop.example` open in VEIL and the agent visits `shop.example` in SHADOW, the two go through different circuits *and* different clients *and* different cookie jars. The origin sees two unrelated visitors. That is the correct outcome, and it is why the "agent drives your tab" mode is exceptional and human-mediated (parent §1.2 D1).
- **No shared concurrency.** A per-class semaphore of 1 for top-level navigations (§6.3.2 C-4 in the parent) means the agent's parallelism cannot reshape the foreground's packet timing.
- **No shared background role.** Update checks, CRLite refresh and bridge bootstrap use `Role::Background` with a distinct token, so maintenance traffic cannot be timestamp-correlated with a user's session start.

### 6.7 What isolation does *not* buy

Two honest limits: (a) isolation prevents *circuit sharing*, not *traffic-analysis correlation*; two isolated flows that start within 50 ms of each other are still correlated by timing, which is why the concurrency governor exists; (b) isolation is per-client, so a compromised `ppx-net` can collapse it. That is why `ppx-net` is outside the TCB and its output is audited: an attacker who owns it can misroute, but the resulting connections still need `EgressPort` grants, which are logged.

---

## 7. Leak prevention

### 7.1 The matrix

Each row is a leak class, the enforcement point, and the test that proves it.

| # | Leak | Enforcement | Test |
|---|---|---|---|
| L-1 | **UDP from page traffic** | `socket(AF_INET, SOCK_DGRAM)` denied by seccomp in every process except `ppx-pt` | syscall audit: zero UDP sockets in `ppx-net`/content |
| L-2 | **WebRTC / ICE** | `RTCPeerConnection` unavailable in VEIL; in `ID-3` ICE is proxied-only with host-candidate suppression | JS harness: constructor absent; candidate set empty |
| L-3 | **QUIC / HTTP/3** | code path compiled out; no h3 ALPN; Alt-Svc ignored | packet capture: single TCP flow per origin |
| L-4 | **Unproxied DNS** | `TorAddr::Hostname` only; platform resolver removed from the VEIL build | tcpdump: zero UDP/53, zero TCP/853 |
| L-5 | **Direct IP literals** | allowed but tagged `Purpose::DirectIp`, surfaced in disclosure log | UI test + audit assertion |
| L-6 | **Speculative sockets** | §5.3 inventory | syscall audit during idle: zero `connect` |
| L-7 | **Proxy bypass** | no PAC, no env proxy, no `no_proxy`, single transport factory | fuzz the pref namespace; no path reaches direct |
| L-8 | **Tor control port abuse** | no control port at all (in-process API); `NEWNYM`-equivalent is a method, rate-limited and audited | API test |
| L-9 | **Bridge line leakage** | bridge lines encrypted in CELL-K, never in prefs, never in logs | `strings` scan of profile + logs |
| L-10 | **Crash-report/telemetry egress** | no such code exists (`PSC-ARCH-001` §8.1) | binary symbol audit |
| L-11 | **Time-skew beacon** | no NTP, ever (§4.2) | syscall audit: zero UDP/123 |
| L-12 | **Captive portal probe** | removed | code audit: no well-known probe URL constant |

### 7.2 WebRTC / ICE, concretely

In Gecko the surface is `dom/media/PeerConnection` plus the ICE stack. Two patches:

```cpp
// dom/media/PeerConnection.sys.mjs / PeerConnection.js (patched)
if (RFPService::IsRFPEnabledFor(RFPTarget::WebRTC) &&
    StaticPrefs::ppx_veil_only()) {
  // VEIL: no peer connections at all. Throw a *web-visible* error that looks
  // like a missing feature, not like a policy denial, so it is not a probe oracle.
  throw new DOMException("RTCPeerConnection is not available", "NotSupportedError");
}
```

```cpp
// dom/media/webrtc/transport/third_party/nICEr/src/ice/ice_candidate.c (patched)
// Applies only to ID-3, where WebRTC is permitted but must not reveal the host.
if (PPX_ICE_PROXIED_ONLY) {
  // 1. Suppress host candidates entirely.
  // 2. Force relay candidates only (TURN/TCP/TLS), and only via EgressPort.
  // 3. Replace mDNS candidates with a single opaque candidate.
  // 4. Deny STUN binding requests that would resolve the public IP.
}
```

The important design choice: **VEIL does not attempt to "anonymise" WebRTC; it removes it.** WebRTC's UDP requirement is fundamentally incompatible with Tor's TCP-only carriage, and every attempt to make WebRTC "work over Tor" ends in either a TURN server that sees the exit IP or a degraded experience that pushes users to disable protections. Removal is the only honest option, and the parent already lists it in §5.2.3.

### 7.3 QUIC and the fallback rule

The fallback rule needs to be precise, because "disable QUIC" is not enough:

1. Arti carries TCP streams only, so QUIC cannot be tunnelled. The client therefore MUST NOT offer `h3` in ALPN for VEIL connections.
2. If an origin's `Alt-Svc` advertises `h3`, the header is dropped at parse time and never cached.
3. If a *future* Arti version gains QUIC-over-Tor support, the build flag flips and the fingerprint manifest (Appendix C, surface #21) must be updated in the same commit — ALPN is a fingerprint, so this is not a free change.
4. `network.http.http3.enable` is forced false *and* the `Http3Session` translation unit is excluded from the VEIL build, so a pref flip cannot resurrect it.

### 7.4 Loopback hardening (what remains after embedding)

Embedding removes the SOCKS listener, but three subprocesses still speak over a local channel:

| Channel | Direction | Protection |
|---|---|---|
| PT `CMETHOD` listener (`127.0.0.1:ephemeral`) | `ppx-net` → PT | Random port per launch, bound to `127.0.0.1`, lifetime tied to the PT process; a peer must complete the PT handshake; PT traffic is a bridge to a guard, so a local peer gains bridge use but not the user's circuits |
| `STDIN`/`STDOUT` PT control | bidirectional | Pipe with `CLOEXEC`, no inheritance by other children |
| `ppx-tor` ↔ Necko | in-process | Not a channel; FFI |

The residual risk (a same-UID local process using the PT listener as a free bridge) is documented as accepted: it is a resource-abuse issue, not a deanonymisation issue, and eliminating it would require PTs to accept pre-connected sockets, which the PT spec does not provide.

---

## 8. Pluggable transports

### 8.1 Why they are subprocesses and not libraries

`obfs4` (via Lyrebird), `Snowflake`, and `WebTunnel` are Go programs. Reimplementing them in Rust would be a multi-year project with its own security review, and *divergence* from the reference implementation is itself a fingerprint (a PT with subtly different padding or TLS behaviour is distinguishable at the censor). Perspicacity therefore ships the reference implementations, sandboxed:

```rust
// ppx-pt/src/supervisor.rs
pub struct PtSpec {
    pub name: &'static str,           // "obfs4" | "snowflake" | "webtunnel"
    pub binary: PathBuf,              // inside the signed app bundle
    pub args: Vec<String>,
    pub sandbox: SandboxProfile,      // seccomp allowlist; UDP only for snowflake
}

impl Supervisor {
    pub fn spawn(&self, spec: &PtSpec, state_dir: &Path) -> Result<PtChild> {
        let mut cmd = Command::new(&spec.binary);
        cmd.env_clear()                                    // no inherited secrets
           .env("TOR_PT_MANAGED_TRANSPORT_VER", "1")
           .env("TOR_PT_CLIENT_TRANSPORTS", spec.name)
           .env("TOR_PT_EXIT_ON_STDIN_CLOSE", "1")
           .env("TOR_PT_STATE_LOCATION", state_dir)
           .stdin(Stdio::piped()).stdout(Stdio::piped())
           .stderr(Stdio::null());                         // never log bridge lines
        sandbox::apply(spec.sandbox)?;
        PtChild::negotiate(cmd.spawn()?)
    }
}
```

### 8.2 The PT negotiation we implement

The supervisor implements the client side of the PT specification, with strict parsing:

```text
→ (env) TOR_PT_CLIENT_TRANSPORTS=obfs4
← VERSION 1
← CMETHOD obfs4 socks5 127.0.0.1:41123
← CMETHODS DONE
```

Rules we add on top of the spec:

| Rule | Reason |
|---|---|
| Any output line not matching a known keyword is fatal | Prevents a compromised PT binary from injecting protocol confusion |
| `CMETHOD` must be `127.0.0.1` (never `0.0.0.0`, never a hostname) | Prevents exposing the bridge to the LAN |
| The listener port must be ephemeral and the process short-lived | Shrinks the loopback window (§7.4) |
| `stderr` is discarded, not logged | Bridge lines and relay IPs must never hit disk |
| The PT process is a child of `ppx-net` with `PDEATHSIG` | No orphaned transports after a crash |
| Per-PT memory/CPU rlimits | A PT is a network adversary-adjacent component |

### 8.3 Automated bridge bootstrapping

The bootstrap state machine, in order of preference. Each step has a timeout and a fingerprint cost, both shown in the UI.

```rust
pub enum BridgeSource { Builtin, Moat, UserPaste, QrScan }

pub async fn bootstrap_bridges(ctx: &Ctx) -> Result<BridgeConfig> {
    // 1. Built-in defaults: WebTunnel and Snowflake lines shipped in the binary.
    //    No network request; works offline; zero added fingerprint surface.
    if let Ok(cfg) = ctx.try_builtin().await { return Ok(cfg); }

    // 2. Moat: fronted HTTPS request for circumvention bridges (§8.4).
    //    Only attempted after a *direct* bootstrap failure, so users who do not
    //    need circumvention never contact the bridge distributor at all.
    if ctx.direct_bootstrap_failed() {
        if let Ok(lines) = MoatClient::request(ctx, Transport::WebTunnel).await {
            for line in lines.into_iter().take(3) {
                if ctx.probe(&line).await.is_ok() { return Ok(line.into()); }
            }
        }
        if let Ok(lines) = MoatClient::request(ctx, Transport::Snowflake).await {
            for line in lines.into_iter().take(3) {
                if ctx.probe(&line).await.is_ok() { return Ok(line.into()); }
            }
        }
    }

    // 3. User paste / QR: the only path that persists a bridge line.
    ctx.await_user_bridge_input().await
}
```

Design notes that matter:

- **Built-ins first.** A user who is not censored never talks to a bridge distributor, so the distributor cannot build a census of our users. This ordering is a privacy decision, not a performance one.
- **Probe budget.** At most 3 candidates per transport, each probed once, with jittered delays drawn from the same distribution as the actuation governor (`FINGERPRINT.md` §4) so that a censor watching for bridge-scanning patterns sees ordinary-looking retry behaviour.
- **Bridge lines are secrets.** A bridge line identifies a circumvention endpoint; leaking it burns it. They live in CELL-K wrapped, are never logged, never shown in the disclosure log's origin field (only `purpose=BridgeBootstrap`), and are excluded from diagnostic bundles.

### 8.4 Moat, and the honesty about it

Moat is a fronted HTTPS API used by Tor Browser to distribute bridges. It is a *protocol-coupled* dependency: the endpoint, headers, and fronting CDN change as the circumvention arms race evolves. Our implementation therefore lives behind a versioned trait with a build-time protocol tag:

```rust
pub trait BridgeDistributor {
    const PROTOCOL_TAG: &'static str;   // e.g. "moat/1", bumped when the wire format changes
    async fn request(&self, t: Transport) -> Result<Vec<BridgeLine>>;
}
```

and is re-verified against Tor Browser's implementation at every browser rebase (it is on the §7.7 rebase checklist of the parent). If Moat becomes unavailable, the built-in bridge lines and user-pasted lines still work; the product degrades to "no automatic circumvention", never to "no privacy".

Snowflake additionally needs a rendezvous with the broker; its client handles this internally, and our supervisor only supplies the broker URL configured in the bridge line. Because Snowflake is WebRTC-based, it is the one PT permitted UDP — see amendment A-2 in §11.

### 8.5 Transport–class binding

Bridge configuration is **per identity class**, not global. A user who needs circumvention in `ID-0` does not thereby route `ID-2` persona traffic over the same bridge (which would link the persona to the anonymous browsing at the censor's vantage point). The UI makes this explicit with a per-class "circumvention" section, and a class with no working transport fails closed rather than borrowing another class's.

---

## 9. Verification

### 9.1 Circuit-isolation conformance (I6)

| Test | Method | Pass criterion |
|---|---|---|
| Same FPD, same role → same circuit | Harness opens 20 subresource streams across 5 origins on one FPD | One circuit per dirty window |
| Different FPD → different circuits | 10 FPDs × 3 streams | 10 distinct circuits, no reuse |
| Class separation | `ID-0` and `ID-2` both reach the same FPD | Different clients, different guards, different circuits |
| Agent/foreground separation | SHADOW task and VEIL tab on the same FPD | Different circuits, different cookie jars |
| Background role | Trigger update check during navigation | Distinct circuit; no temporal proximity below 2 s |
| Token derivation | Property test over 10^6 keys | Collisions = 0; tokens indistinguishable from random |

### 9.2 Leak conformance (C-6, I2-adjacent)

| Test | Method | Pass criterion |
|---|---|---|
| UDP | `strace -f -e trace=socket` across a full session | Zero `AF_INET/SOCK_DGRAM` outside `ppx-pt` |
| DNS | Same, plus tcpdump on the host | Zero packets to port 53/853 |
| Direct connect | LD_PRELOAD shim that aborts on `connect` to a non-loopback address outside `ppx-net` | No aborts |
| QUIC | Server offering h3 + Alt-Svc; capture | Single TCP connection, no UDP/443 |
| WebRTC | JS harness in VEIL | Constructor throws; no STUN traffic |
| Idle | 10-minute idle capture | Zero packets after bootstrap |
| Kill switch | Kill Arti mid-navigation | Navigation fails; no direct connection appears in the capture |

### 9.3 Fuzzing

`cxx` boundary (lengths, lifetimes), PT protocol parser (structured fuzz over the line protocol), bridge-line parser, and the isolation deriver (differential against a reference). The `cxx` fuzzer is the important one: it is the only place where C++ memory meets Rust ownership.

---

## 10. Performance budget

| Metric | Budget | Notes |
|---|---|---|
| Bootstrap, first class, good network | ≤ 3 s p50, ≤ 8 s p95 | Directory fetch dominates |
| Bootstrap, warm guard state | ≤ 1.2 s p50 | The A-1 persistence pays off here |
| Circuit build (cold, per FPD) | ≤ 600 ms p50 | Off critical path via pre-build pool |
| Stream open (circuit warm) | ≤ 90 ms p95 | Includes exit CONNECT |
| FFI overhead per read/write | ≤ 8 µs p95 | `cxx` + bounded copy; verified by microbench |
| RAM per class client | ≤ 6 MB | Guards + descriptors + circuits |
| RAM, all clients idle | ≤ 20 MB | Three classes |
| Bootstrapped-but-idle CPU | ≤ 0.2 % | No polling timers |
| Pre-built circuits | 2 per active client | Rebuilt on demand, not on a timer |

The pre-build pool deserves a note: pre-building on *hover* would be a fingerprint (a client that connects before a click behaves differently from a human browser), so pre-build is triggered by the *current page's* first-party domain becoming active, and only one circuit ahead. This is the same trade-off as speculative connections, resolved in favour of not leaking intent.

---

## 11. Amendments to PSC-ARCH-001

| ID | Amendment | Rationale | Parent action |
|---|---|---|---|
| **A-1** | Guard/bridge state MAY persist encrypted in CELL-D, per identity class, ≤ 30 days; never for `ID-1` | Guard stability is a security property and cannot be replaced by rotation | Amend §5.4's persistence table |
| **A-2** | UDP is denied to every product process **except `ppx-pt`** (Snowflake's WebRTC) | C-6 as written would have made Snowflake impossible; page traffic still never uses UDP | Clarify §6.3.2 C-6 |
| **A-3** | "Tor control port" does not exist; `NEWNYM` is an in-process method with rate limiting and audit | Removes a local attack surface while preserving the capability | Note in §6.2.1 |

---

## 12. References

1. Arti project documentation — `arti-client`, `TorClient`, `StreamPrefs`, `IsolationToken`, `TorAddr`. [docs.rs/arti-client](https://docs.rs/arti-client)
2. Tor Project — pluggable transport specification (managed transports, `CMETHOD`, environment contract). [spec.torproject.org/pt-spec](https://spec.torproject.org/pt-spec/index.html)
3. Tor Project — `IsolateSOCKSAuth` and stream isolation semantics (the mechanism we replace with in-process tokens). [tor man page](https://2019.www.torproject.org/docs/tor-manual.html.en)
4. RFC 9458 — Oblivious HTTP (referenced from `AGENT.md` for the inference path, which reuses this document's `EgressPort`). [rfc-editor.org](https://www.rfc-editor.org/rfc/rfc9458)
5. Tor Browser design document — circuit isolation and first-party domain semantics (the behaviour being reimplemented). [tor-browser-spec](https://gitlab.torproject.org/tpo/applications/tor-browser-spec/-/blame/47ca2d1b25e5e2153369a70aa7d908043f8f7396/design-doc/design.xml?page=2#2)

