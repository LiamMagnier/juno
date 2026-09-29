"use client";

import * as React from "react";
import { AddMcpServerDialog } from "@/components/connections/add-mcp-server-dialog";
import { Button } from "@/components/ui/button";
import type { UserMcpServerStatus } from "@/components/connections/types";

const saved: UserMcpServerStatus = {
  id: "fixture", name: "My workspace tools", url: "https://tools.example.com/mcp",
  enabled: true, status: "ok", lastError: null, lastCheckedAt: null,
  toolCount: 2, tools: ["search", "read_document"], accountLabel: null, hasAuthHeader: true,
  createdAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T00:00:00Z",
};

/** Real dialog, dev only. API calls still require the account's normal auth. */
export function ConnectionsGallery() {
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<UserMcpServerStatus | null>(null);
  return <main className="p-8">
    <div className="flex gap-3">
      <Button onClick={() => { setEditing(null); setOpen(true); }}>Add MCP server</Button>
      <Button variant="outline" onClick={() => { setEditing(saved); setOpen(true); }}>Manage saved server</Button>
    </div>
    <AddMcpServerDialog open={open} onOpenChange={setOpen} editing={editing} onSaved={() => setOpen(false)} />
  </main>;
}
