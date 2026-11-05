# MCP configuration unification (G78, configuration phase)

The Connections header Add button and directory tile now open one add flow. It supports OAuth sign-in, an encrypted Authorization header, and anonymous servers. The existing header-server editor remains available for saved header servers. The development Connections gallery uses the same add dialog.

UserMcpServer is the canonical configuration table. The additive migration copies legacy OAuth CustomConnector rows, preserves their mcp: IDs, disambiguates colliding names, and carries descriptions, cached tools and disabled tools. OAuth credentials remain encrypted in the existing Connection ledger, under the same provider IDs. Existing static server IDs, saved chat references, permission blocks and action receipts are unchanged. The old table remains as a migration snapshot; removal deletes its stale snapshot as well as the canonical row and token.

OAuth reads and writes use the owner-scoped mcp-config-store adapter. Header management endpoints reject OAuth IDs, and the runtime cannot resolve an OAuth row as a header server. Existing MCP transport, SSRF checks, tool permission classification, approval broker and audit paths remain in use. Both forms are tested against the same runtime and directory projection.

Regression evidence is in mcp-config-unification-db.test.ts: real migration execution with colliding fixture names and preserved ciphertext, canonical writes, concurrent duplicate adds, cross-account denial, credential-free directory payloads, stable runtime IDs and disabled-tool filtering, and atomic cleanup. mcp-add.spec.ts exercises token and OAuth/error recovery paths at desktop and phone widths against mocked endpoints. These browser checks do not establish live third-party OAuth acceptance.

The subsequent runtime phase is described in [MCP_RUNTIME_HOOKS.md](MCP_RUNTIME_HOOKS.md). G78 still needs the reserved Code customization editor and persistent owner-reviewed cloud hook hashes. No unsupported editor capability is advertised by this configuration phase.
