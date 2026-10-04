<div align="center">

# Juno

**A production-grade, multimodal AI platform and native client ecosystem.**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-15_App_Router-black.svg?logo=next.js&logoColor=white)](https://nextjs.org/)
[![Swift](https://img.shields.io/badge/Swift-6.0-FA7343.svg?logo=swift&logoColor=white)](https://swift.org/)
[![Production](https://img.shields.io/badge/Live_Deployment-chat.liams.dev-success.svg)](https://chat.liams.dev)

Streaming Chat · Deep Research · Durable Memory · Canvas Artifacts · Model Context Protocol (MCP) · Realtime Voice Relay · Cloud & Device Code Agents · Native macOS & iOS Apps

</div>

---

## Overview

### What is Juno?

Juno is a modern, full-stack, multimodal AI platform designed for serious everyday work. It combines a high-performance web experience with dedicated native desktop (macOS) and mobile (iOS) applications, backed by a unified synchronization engine and strict security architecture.

### Why does Juno exist?

Most open-source AI chat frontends are either lightweight web wrappers around single provider APIs or monolithic prototypes lacking production security, multi-device synchronization, or deep agentic workflows. Proprietary platforms, conversely, vendor-lock users into closed ecosystems with opaque data practices.

Juno fills this gap by delivering:
1. **Model & Provider Interoperability:** Zero vendor lock-in across OpenAI, Anthropic, Google Gemini, xAI Grok, Mistral, Meta Llama, DeepSeek, Perplexity, Cohere, and local/custom endpoints.
2. **First-Class Native Experience:** Native Swift applications for macOS and iOS that share contracts, tokens, and offline/online state synchronization with the web core.
3. **True Agentic Capabilities:** Unified tool execution, Model Context Protocol (MCP) connectors, autonomous "Code" agent sessions, and persistent agentic teammates with goals and memory.
4. **Defense-in-Depth Security:** Nonce-based CSP, cryptographic encryption-at-rest for user conversations, strict ownership query enforcement, and action-bound approval receipts.

---

## Key Capabilities

- **Unified Multi-Provider Generation:** Seamlessly stream turns, visible thinking/reasoning blocks, and tool executions across 14+ model providers with automatic failover and reasoning effort ladders.
- **Deep Research & Canvas Artifacts:** Interactive document workspaces, live code previews (React, Tailwind, HTML, SVG, Mermaid), version history, and full-screen reading modes.
- **Durable Memory & Personalization:** Long-term memory distillation with encrypted summary profiles and user-controlled forgetting.
- **Model Context Protocol (MCP) & Connectors:** Dynamic discovery, OAuth registration, and tool calling across local and remote MCP servers (Linear, GitHub, Notion, Slack, Google Workspace, Apple ecosystem).
- **Multimodal Realtime Voice:** Low-latency audio streaming relay (`relay/`) supporting duplex speech-to-speech, read-aloud synthesis, and continuous dictation.
- **Code & Work Sessions:** Sandboxed cloud execution environments (`runner/`) and device-bridged agents capable of inspecting file systems, running bash commands, and checking execution outcomes.
- **Native Ecosystem:** Full-featured native clients for macOS (Menu Bar, Global Hotkey, Spotlight-like quick access) and iOS (Dynamic Island, Live Activities, Lock Screen widgets).

---

## Architecture at a Glance

```text
┌────────────────────────────────────────────────────────────────────────┐
│                              Clients                                   │
│   Web (Next.js 15)   │   macOS (Swift/AppKit)   │   iOS (Swift/SwiftUI) │
└───────────┬──────────────────────┬──────────────────────┬──────────────┘
            │                      │                      │
            ▼                      ▼                      ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        Juno Backend Core                               │
│  • Next.js App Router (Modular API & Route Handlers)                   │
│  • NextAuth v5 + TOTP 2FA + Immediate Session Revocation               │
│  • Ownership Query Guard (Mandatory User-Scoping)                      │
│  • Encrypted Transcript & Credential Storage (AES-256-GCM)             │
└───────────┬──────────────────────┬──────────────────────┬──────────────┘
            │                      │                      │
    ┌───────┴────────┐     ┌───────┴────────┐     ┌───────┴────────┐
    ▼                ▼     ▼                ▼     ▼                ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│  PostgreSQL  │ │  S3 Storage  │ │ Voice Relay  │ │ Cloud Runner │
│   (Prisma    │ │ (Attachments,│ │  (WebSocket  │ │ (Agent Core, │
│  Migrations) │ │  Artifacts)  │ │   Service)   │ │  Sandboxed)  │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
```

---

## Security Model

Juno implements defense-in-depth controls audited for production workloads:

- **Encryption at Rest:** Transcripts (`Message.content`), visible thinking (`reasoning`), tool call activities, long-term memory summaries, and OAuth connector tokens are encrypted using rotatable AES-256-GCM keyrings (`src/lib/message-crypto.ts`, `src/lib/crypto.ts`).
- **Database Ownership Enforcement:** The Prisma data access layer (`src/lib/db.ts`) automatically rejects unscoped queries on user-owned tables, verified by static call-site auditing (`tests/ownership-guard-callsites.test.ts`).
- **Action-Bound Approval Receipts:** External mutations and sensitive connector invocations require cryptographic SHA-256 approval receipts bound to user, session, and exact arguments.
- **Origin & CSRF Protection:** Strict same-origin validation on cookie-authenticated mutations; bearer authentication contract enforced for native clients.
- **Automated Security Pipelines:** CodeQL static analysis, GitHub Secret Scanning push protection, and Dependabot supply chain updates.

For detailed disclosure guidelines, see [SECURITY.md](SECURITY.md).

---

## Quick Start

### Prerequisites

- Node.js 20+ (Node 24 recommended)
- PostgreSQL 15+
- npm 10+

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/LiamMagnier/juno.git
cd juno

# 2. Install dependencies (triggers Prisma client generation)
npm install

# 3. Configure environment variables
cp .env.example .env.local
# Edit .env.local with your DATABASE_URL, AUTH_SECRET, and API keys.

# 4. Run database migrations
npx prisma migrate dev

# 5. Extract i18n catalogs and start the development server
npm run dev
```

Visit [http://localhost:3000](http://localhost:3000) to create an account and begin.

---

## Development & Quality Gates

Juno enforces strict quality and contract integrity gates across both web and native targets:

```bash
# Extract UI translation strings
npm run i18n:extract

# Run full project typecheck
npm run typecheck

# Run linter
npm run lint

# Run automated test suites
npm test

# Verify Swift-TypeScript contract sync
npm run capabilities:check
npm run work:contract:check
```

---

## Self-Hosting & Deployment

Juno can be deployed in two primary configurations:

1. **Standalone Production VM (Recommended):** Nginx reverse proxy routing to Next.js (App Router), the standalone realtime voice relay (`relay/`), and the background scheduler under PM2. Complete deployment guides are provided in:
   - [Oracle Cloud Always-Free Setup Guide](deploy/VM_SETUP_GUIDE.md)
   - [Google Cloud Platform Setup Guide](deploy/GCP_SETUP_GUIDE.md)
2. **Hybrid Cloud:** Edge/Serverless web frontend with `/api/*` and WebSocket traffic routed to a dedicated backend instance.

See [`docs/JUNO.md` §20](docs/JUNO.md#20-deployment--operations) for complete operational runbooks.

---

## Contributing

We welcome contributions from the community! Please review our:
- [Contributing Guide](CONTRIBUTING.md) for local setup, commit conventions, and testing requirements.
- [Code of Conduct](CODE_OF_CONDUCT.md) for community standards.
- [Project Governance](GOVERNANCE.md) for maintainer roles and decision-making processes.

---

## License & Third-Party Notices

Juno is open-source software licensed under the **[Apache License, Version 2.0](LICENSE)**.

Third-party dependencies, vendored components (`runner/agent-core/`), typography, and provider trademark notices are documented in [NOTICE](NOTICE).
