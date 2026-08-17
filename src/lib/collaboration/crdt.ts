/**
 * Juno Real-Time Collaborative Canvas Synchronization Engine
 *
 * Implements a Conflict-Free Replicated Data Type (RGA / Sequence CRDT)
 * providing mathematically guaranteed convergence across concurrent edits,
 * network reordering, duplicate message delivery, and offline reconnects.
 */

export interface CRDTIdentifier {
  site: string;
  clock: number;
}

export function compareIdentifiers(a: CRDTIdentifier | null, b: CRDTIdentifier | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (a.clock !== b.clock) {
    return a.clock < b.clock ? -1 : 1;
  }
  if (a.site !== b.site) {
    return a.site < b.site ? -1 : 1;
  }
  return 0;
}

export interface CRDTNode {
  id: CRDTIdentifier;
  originLeftId: CRDTIdentifier | null;
  value: string;
  deleted: boolean;
}

export interface PeerPresence {
  userId: string;
  name: string;
  avatarUrl?: string;
  cursor: {
    line: number;
    column: number;
    selectionEndLine?: number;
    selectionEndColumn?: number;
  } | null;
  activeArtifactId: string | null;
  lastSeenAt: number;
}

export type CRDTOperation =
  | {
      type: "insert";
      id: CRDTIdentifier;
      originLeftId: CRDTIdentifier | null;
      value: string;
    }
  | {
      type: "delete";
      targetId: CRDTIdentifier;
    };

export interface DocumentSnapshot {
  artifactId: string;
  version: number;
  content: string;
  lastModifiedBy: string;
  updatedAt: number;
}

export class CollaborativeCRDTDocument {
  public readonly documentId: string;
  public readonly siteId: string;
  private clock: number = 0;
  private nodes: CRDTNode[] = [];
  private nodeMap: Map<string, CRDTNode> = new Map();
  private peers: Map<string, PeerPresence> = new Map();
  private operationsApplied: number = 0;
  private pendingOps: CRDTOperation[] = [];

  constructor(documentId: string, siteId: string = "default", initialContent = "") {
    this.documentId = documentId;
    this.siteId = siteId;

    if (initialContent.length > 0) {
      let prevId: CRDTIdentifier | null = null;
      for (let i = 0; i < initialContent.length; i++) {
        const id: CRDTIdentifier = { site: "root", clock: i + 1 };
        const node: CRDTNode = {
          id,
          originLeftId: prevId,
          value: initialContent[i],
          deleted: false,
        };
        this.nodes.push(node);
        this.nodeMap.set(`${id.site}:${id.clock}`, node);
        prevId = id;
      }
      this.clock = initialContent.length;
    }
  }

  private keyOf(id: CRDTIdentifier): string {
    return `${id.site}:${id.clock}`;
  }

  private posOf(id: CRDTIdentifier | null): number {
    if (id === null) return -1;
    const key = this.keyOf(id);
    for (let i = 0; i < this.nodes.length; i++) {
      if (this.keyOf(this.nodes[i].id) === key) return i;
    }
    return -1;
  }

  public getLamportClock(): number {
    return this.clock;
  }

  /**
   * Generates local insert operations at visible character position.
   */
  public localInsert(visibleIndex: number, text: string): CRDTOperation[] {
    const ops: CRDTOperation[] = [];
    if (!text) return ops;

    let originLeftId: CRDTIdentifier | null = null;
    if (visibleIndex > 0) {
      let visibleCount = 0;
      for (let i = 0; i < this.nodes.length; i++) {
        if (!this.nodes[i].deleted) {
          visibleCount += 1;
          if (visibleCount === visibleIndex) {
            originLeftId = this.nodes[i].id;
            break;
          }
        }
      }
    }

    let prevId = originLeftId;
    for (let charIndex = 0; charIndex < text.length; charIndex++) {
      this.clock += 1;
      const newId: CRDTIdentifier = { site: this.siteId, clock: this.clock };
      const op: CRDTOperation = {
        type: "insert",
        id: newId,
        originLeftId: prevId,
        value: text[charIndex],
      };
      this.applyOperation(op);
      ops.push(op);
      prevId = newId;
    }

    return ops;
  }

  /**
   * Generates local delete operations at visible character position.
   */
  public localDelete(visibleIndex: number, length: number = 1): CRDTOperation[] {
    const ops: CRDTOperation[] = [];
    if (length <= 0) return ops;

    let visibleCount = 0;
    let deletedCount = 0;

    for (let i = 0; i < this.nodes.length && deletedCount < length; i++) {
      if (!this.nodes[i].deleted) {
        if (visibleCount >= visibleIndex && visibleCount < visibleIndex + length) {
          const op: CRDTOperation = {
            type: "delete",
            targetId: this.nodes[i].id,
          };
          this.applyOperation(op);
          ops.push(op);
          deletedCount += 1;
        }
        visibleCount += 1;
      }
    }

    return ops;
  }

  private tryApplySingle(op: CRDTOperation): boolean {
    if (op.type === "insert") {
      const key = this.keyOf(op.id);
      if (this.nodeMap.has(key)) {
        return false; // Idempotent duplicate
      }

      // Check causal readiness
      if (op.originLeftId !== null && !this.nodeMap.has(this.keyOf(op.originLeftId))) {
        return false; // Dependency not yet present
      }

      this.clock = Math.max(this.clock, op.id.clock) + 1;

      const newNode: CRDTNode = {
        id: op.id,
        originLeftId: op.originLeftId,
        value: op.value,
        deleted: false,
      };

      this.nodeMap.set(key, newNode);
      this.operationsApplied += 1;

      const originPos = this.posOf(op.originLeftId);
      let insertIndex = originPos + 1;

      while (insertIndex < this.nodes.length) {
        const other = this.nodes[insertIndex];
        const otherOriginPos = this.posOf(other.originLeftId);

        if (otherOriginPos < originPos) {
          break;
        } else if (otherOriginPos === originPos) {
          if (compareIdentifiers(op.id, other.id) > 0) {
            break;
          } else {
            insertIndex++;
          }
        } else {
          insertIndex++;
        }
      }

      this.nodes.splice(insertIndex, 0, newNode);
      return true;
    } else if (op.type === "delete") {
      const key = this.keyOf(op.targetId);
      const target = this.nodeMap.get(key);
      if (!target) {
        return false; // Dependency not yet present
      }
      if (target.deleted) {
        return false; // Already deleted
      }
      target.deleted = true;
      this.operationsApplied += 1;
      return true;
    }

    return false;
  }

  /**
   * Deterministically applies a CRDT operation with causal buffer resolution.
   */
  public applyOperation(op: CRDTOperation): boolean {
    const applied = this.tryApplySingle(op);
    if (!applied) {
      // Check if duplicate or missing dependency
      if (op.type === "insert" && this.nodeMap.has(this.keyOf(op.id))) {
        return false;
      }
      this.pendingOps.push(op);
      return false;
    }

    // Drain pending buffer
    let progressed = true;
    while (progressed && this.pendingOps.length > 0) {
      progressed = false;
      const remaining: CRDTOperation[] = [];
      for (const pending of this.pendingOps) {
        if (this.tryApplySingle(pending)) {
          progressed = true;
        } else {
          remaining.push(pending);
        }
      }
      this.pendingOps = remaining;
    }

    return true;
  }

  public getText(): string {
    let result = "";
    for (let i = 0; i < this.nodes.length; i++) {
      if (!this.nodes[i].deleted) {
        result += this.nodes[i].value;
      }
    }
    return result;
  }

  public getSnapshot(): DocumentSnapshot {
    return {
      artifactId: this.documentId,
      version: this.operationsApplied,
      content: this.getText(),
      lastModifiedBy: this.nodes.length > 0 ? this.nodes[this.nodes.length - 1].id.site : "system",
      updatedAt: Date.now(),
    };
  }

  public updatePresence(presence: PeerPresence): void {
    this.peers.set(presence.userId, {
      ...presence,
      lastSeenAt: Date.now(),
    });
  }

  public removePeer(userId: string): void {
    this.peers.delete(userId);
  }

  public getActivePeers(timeoutMs = 30_000): PeerPresence[] {
    const threshold = Date.now() - timeoutMs;
    return Array.from(this.peers.values()).filter((p) => p.lastSeenAt >= threshold);
  }
}

/**
 * Backward compatibility alias for legacy tests
 */
export class CollaborativeSession {
  private doc: CollaborativeCRDTDocument;
  private version: number = 0;

  constructor(documentId: string, initialContent = "") {
    this.doc = new CollaborativeCRDTDocument(documentId, "site-1", initialContent);
  }

  public applyDelta(delta: {
    type: "insert" | "delete" | "replace";
    position: number;
    text?: string;
    length?: number;
    id?: string;
    clock?: number;
    authorId?: string;
    artifactId?: string;
    timestamp?: number;
  }): DocumentSnapshot {
    this.version += 1;
    if (delta.type === "insert" && delta.text) {
      this.doc.localInsert(delta.position, delta.text);
    } else if (delta.type === "delete" && delta.length) {
      this.doc.localDelete(delta.position, delta.length);
    } else if (delta.type === "replace" && delta.text) {
      if (delta.length) this.doc.localDelete(delta.position, delta.length);
      this.doc.localInsert(delta.position, delta.text);
    }
    return {
      artifactId: this.doc.documentId,
      version: this.version,
      content: this.doc.getText(),
      lastModifiedBy: "site-1",
      updatedAt: Date.now(),
    };
  }

  public updatePresence(presence: PeerPresence): void {
    this.doc.updatePresence(presence);
  }

  public removePeer(userId: string): void {
    this.doc.removePeer(userId);
  }

  public getActivePeers(timeoutMs = 30_000): PeerPresence[] {
    return this.doc.getActivePeers(timeoutMs);
  }

  public getSnapshot(): DocumentSnapshot {
    return {
      artifactId: this.doc.documentId,
      version: this.version,
      content: this.doc.getText(),
      lastModifiedBy: "site-1",
      updatedAt: Date.now(),
    };
  }
}
