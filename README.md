# Perspicacity

**Architecture and subsystem specifications for a hardened desktop browser that combines autonomous AI agent workflows with Tor-grade anonymity.**

> **Status: design-stage.** This repository contains specifications, not implementation. There is no browser source here, no build system, and no runnable artifact. Everything is a *proposal* — revision 1.1 — written to be falsified, costed, and argued with.

---

## The problem these documents solve

An AI agent needs DOM access, cross-tab state and durable memory. High anonymity requires no persistent state, strict origin isolation and a uniform fingerprint. Naively composed, **the agent becomes the deanonymiser**: memory is a supercookie, a DOM reader is a cross-origin read primitive, an autonomous clicker is a timing oracle, and an LLM API call is an exfiltration channel that bypasses the proxy entirely.

The design resolves this by treating anonymity as a **correlation** problem rather than a persistence problem, and by splitting the browser into two mutually distrustful identity domains:

| | **VEIL** | **SHADOW** |
|---|---|---|
| Purpose | Hermetic browsing | Agentic execution |
| State | RAM-only, destroyed per session | Encrypted at rest, local only |
| Network | Tor, circuit per first-party domain | Separate circuits, separate clients |
| Fingerprint | One canonical value per surface, identical for every user | Non-anonymous by construction |
| The agent | Cannot touch it except through **LATTICE** | Its home |

The only bridge between them is a typed, provenance-tracking capability broker. Every cross-domain effect is either (a) lossy, labelled data, or (b) a human-approved capability recorded in an append-only ledger. There is no third kind.

## The document set

| Document | Scope | Words |
|---|---|---|
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | Parent specification: process and IPC model, storage and key hierarchy, threat model, engine selection, delivery plan | ~25 000 |
| **[NETWORK.md](NETWORK.md)** | Embedded Arti in the network service: per-class clients, isolation tokens, leak matrix, pluggable transports | ~7 500 |
| **[FINGERPRINT.md](FINGERPRINT.md)** | Engine patches and runtime overrides for fingerprint uniformity, timing mitigations, human-emulation layer | ~6 100 |
| **[AGENT.md](AGENT.md)** | Off-screen shadow contexts, AXTree distillation, hybrid local/OHTTP inference, capability security | ~6 400 |
| **[UTILITIES.md](UTILITIES.md)** | Native filter engine, new-identity rotation, download sanitiser, local automation | ~6 100 |

Each child document opens with a **conformance table** mapping its mechanisms to parent invariants, and proposes any deviation as a registered amendment. **[Appendix H of ARCHITECTURE.md](ARCHITECTURE.md#appendix-h--amendments-register)** is the single register of those changes (A-1 … A-16).

## Reading paths

| If you are… | Read |
|---|---|
| Evaluating the idea | ARCHITECTURE §0–§2, then §7 (engine decision) |
| A security reviewer | ARCHITECTURE §4.2, §6, then FINGERPRINT §5.6 and AGENT §5 |
| A browser platform engineer | ARCHITECTURE §4, NETWORK §2–§6, FINGERPRINT §6 |
| An ML/agent engineer | AGENT §3–§6, then UTILITIES §5 |
| A product owner | ARCHITECTURE §1.3, §9, then the amendments register |

## Seven decisions the specification rests on

| ADR | Decision |
|---|---|
| 001 | Base engine: **Gecko, via a Tor-Browser-derived fork** — the anonymity properties cannot be retrofitted; agency must be built either way (weighted comparison in ARCHITECTURE §7.4, with kill criteria) |
| 002 | New subsystems use a **Mojo-conforming capability-IPC contract**, bound to IPDL on Gecko, kept engine-neutral |
| 003 | **No CDP or WebDriver BiDi is exposed to the agent**, and both are compiled out of release builds |
| 004 | Renderers never hold storage paths or keys; storage is a capability service |
| 005 | **Remote inference is forbidden in VEIL**; in SHADOW it is treated as an untrusted network party |
| 006 | Two approval classes only: pre-approved capability classes, and human confirmations with unspoofable receipts |
| 007 | Reproducible builds, signed updates: no telemetry, no crash upload, no remote Safe Browsing |

## Conventions

- **RFC 2119** keywords (MUST / SHOULD / MAY) are normative.
- Codenames: **VEIL** (hermetic plane), **SHADOW** (agent plane), **LATTICE** (the only bridge), **ARBITER** (policy), **CUSTOS** (keys), **MNEMOSYNE** (memory), **SENTRY** (egress), **AUDIT** (ledger).
- Identity classes `ID-0`…`ID-3`; storage cells `CELL-V/S/D/K/A/P`; acceptance invariants `I1`…`I6`.
- Engine-specific names (prefs, protocol layers, sandbox primitives) are given because the architecture depends on them, but should be re-verified against the chosen base at implementation time.

## What these documents do not claim

Perspicacity does **not** make a logged-in session anonymous; it does **not** defeat a global adversary who can correlate both ends of a circuit with a confident website-fingerprinting classifier; it does **not** guarantee swap-proof memory on a host with unencrypted swap; and it does **not** make prompt injection impossible — it makes *unauthorised effects* impossible for a defined effect set, and makes the residual risk visible and auditable. These limits are stated in the documents themselves rather than in a footer, because a privacy product's credibility is exactly the set of claims it refuses to make.
