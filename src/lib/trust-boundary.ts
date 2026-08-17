/**
 * Juno Agent & Tool Trust Boundary Engine
 *
 * Enforces strict provenance tracking and deterministic authorization gating.
 * Principle: The model may propose actions; the authorization layer decides whether they execute.
 * Untrusted external data (webpages, PDFs, MCP tools, repo files) CANNOT gain instruction authority.
 */

import { createHash } from "node:crypto";
import type { ActionRiskClass } from "@/lib/action-approval";
import { canonicalize } from "@/lib/work/canonical";

export type ProvenanceKind =
  | "user"
  | "system"
  | "trusted_app_metadata"
  | "external_website"
  | "uploaded_document"
  | "mcp_tool_response"
  | "connector_content"
  | "repo_file"
  | "repo_instruction"
  | "retrieved_memory";

export interface ContextualProvenance {
  kind: ProvenanceKind;
  sourceId: string;
  isUntrusted: boolean;
  derivedFromUntrusted?: boolean;
  timestamp: number;
}

export const UNTRUSTED_PROVENANCE_KINDS: ReadonlySet<ProvenanceKind> = new Set([
  "external_website",
  "uploaded_document",
  "mcp_tool_response",
  "connector_content",
  "repo_file",
  "repo_instruction",
]);

export interface ToolSecurityPolicy {
  toolId: string;
  capability: string;
  riskClass: ActionRiskClass;
  scope: string;
  requiresExplicitConfirmation: boolean;
}

/**
 * Registry of intrinsic tool risk classes and confirmation policies
 */
export const TOOL_SECURITY_REGISTRY: Record<string, ToolSecurityPolicy> = {
  // Destructive / Sensitive
  "delete_file": { toolId: "delete_file", capability: "fs.delete", riskClass: "destructive_or_sensitive", scope: "workspace", requiresExplicitConfirmation: true },
  "delete_calendar_event": { toolId: "delete_calendar_event", capability: "calendar.delete", riskClass: "destructive_or_sensitive", scope: "calendar", requiresExplicitConfirmation: true },
  "git_hard_reset": { toolId: "git_hard_reset", capability: "git.reset", riskClass: "destructive_or_sensitive", scope: "repository", requiresExplicitConfirmation: true },
  "purchase_item": { toolId: "purchase_item", capability: "payment.charge", riskClass: "destructive_or_sensitive", scope: "finance", requiresExplicitConfirmation: true },
  "account_escalation": { toolId: "account_escalation", capability: "auth.escalate", riskClass: "destructive_or_sensitive", scope: "account", requiresExplicitConfirmation: true },
  
  // External Write
  "send_email": { toolId: "send_email", capability: "email.send", riskClass: "external_write", scope: "email", requiresExplicitConfirmation: true },
  "publish_post": { toolId: "publish_post", capability: "social.publish", riskClass: "external_write", scope: "social", requiresExplicitConfirmation: true },
  "write_file": { toolId: "write_file", capability: "fs.write", riskClass: "reversible_write", scope: "workspace", requiresExplicitConfirmation: false },
  
  // Read Only
  "read_file": { toolId: "read_file", capability: "fs.read", riskClass: "read_only", scope: "workspace", requiresExplicitConfirmation: false },
  "web_search": { toolId: "web_search", capability: "search.query", riskClass: "read_only", scope: "web", requiresExplicitConfirmation: false },
  "list_files": { toolId: "list_files", capability: "fs.list", riskClass: "read_only", scope: "workspace", requiresExplicitConfirmation: false },
};

/**
 * Computes a deterministic SHA-256 digest bound to the exact tool call and arguments.
 */
export function computeActionReceiptDigest(input: {
  userId: string;
  sessionId: string;
  toolName: string;
  args: Record<string, unknown>;
}): string {
  const canonicalArgs = canonicalize(input.args);
  const payload = [
    input.userId,
    input.sessionId,
    input.toolName,
    canonicalArgs,
  ].join("\0");

  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Validates whether an incoming proposal is authorized to execute.
 */
export function evaluateActionAuthorization(input: {
  toolName: string;
  args: Record<string, unknown>;
  userId: string;
  sessionId: string;
  provenance: ContextualProvenance;
  approvalReceiptDigest?: string;
}): {
  allowed: boolean;
  requiresConfirmation: boolean;
  expectedDigest: string;
  reason: string;
} {
  const expectedDigest = computeActionReceiptDigest({
    userId: input.userId,
    sessionId: input.sessionId,
    toolName: input.toolName,
    args: input.args,
  });

  const policy = TOOL_SECURITY_REGISTRY[input.toolName] || {
    toolId: input.toolName,
    capability: "unknown",
    riskClass: "destructive_or_sensitive",
    scope: "unknown",
    requiresExplicitConfirmation: true,
  };

  // If tool is read-only and not destructive
  if (policy.riskClass === "read_only") {
    return {
      allowed: true,
      requiresConfirmation: false,
      expectedDigest,
      reason: "Read-only actions are permitted.",
    };
  }

  // If action is initiated/influenced by untrusted context, enforce confirmation
  const mustConfirm = policy.requiresExplicitConfirmation || input.provenance.isUntrusted || input.provenance.derivedFromUntrusted;

  if (mustConfirm) {
    if (!input.approvalReceiptDigest) {
      return {
        allowed: false,
        requiresConfirmation: true,
        expectedDigest,
        reason: "Action requires explicit user confirmation.",
      };
    }

    if (input.approvalReceiptDigest !== expectedDigest) {
      return {
        allowed: false,
        requiresConfirmation: true,
        expectedDigest,
        reason: "Approval digest mismatch: the proposed arguments differ from the approved receipt.",
      };
    }
  }

  return {
    allowed: true,
    requiresConfirmation: false,
    expectedDigest,
    reason: "Authorized by matching cryptographic approval digest.",
  };
}

/**
 * Defangs and sanitizes untrusted input text before injecting into model context.
 */
export function sanitizeUntrustedContent(content: string, source: string): string {
  if (!content) return "";
  // Strip control chars and normalize zero-width characters used in homoglyph injection
  const normalized = content
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // remove zero-width spaces/joiners
    .replace(/<<<JUNO_UNTRUSTED_BEGIN>>>/gi, "[UNTRUSTED_MARKER_DEFANGED]")
    .replace(/<<<JUNO_UNTRUSTED_END>>>/gi, "[UNTRUSTED_MARKER_DEFANGED]");

  return [
    `<<<JUNO_UNTRUSTED_BEGIN source=${source}>>>`,
    normalized,
    `<<<JUNO_UNTRUSTED_END>>>`,
  ].join("\n");
}
