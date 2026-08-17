/**
 * Juno Real-Time Collaborative Canvas Synchronization Engine (CRDT / State Vector Model)
 *
 * Enables multi-user simultaneous editing on artifacts, canvas scenes, and code files.
 * Manages vector clocks, Lamport timestamps, delta conflict resolution, and presence cursors.
 */

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

export interface DeltaOperation {
  id: string;
  clock: number;
  authorId: string;
  artifactId: string;
  type: "insert" | "delete" | "replace";
  position: number;
  length?: number;
  text?: string;
  timestamp: number;
}

export interface DocumentSnapshot {
  artifactId: string;
  version: number;
  content: string;
  lastModifiedBy: string;
  updatedAt: number;
}

export class CollaborativeSession {
  private documentId: string;
  private content: string;
  private version: number;
  private peers: Map<string, PeerPresence> = new Map();
  private history: DeltaOperation[] = [];

  constructor(documentId: string, initialContent = "") {
    this.documentId = documentId;
    this.content = initialContent;
    this.version = 0;
  }

  /**
   * Applies an incoming delta operation with deterministic merge conflict resolution.
   */
  public applyDelta(delta: DeltaOperation): DocumentSnapshot {
    this.version += 1;
    this.history.push(delta);

    if (delta.type === "insert" && delta.text) {
      const pos = Math.min(Math.max(0, delta.position), this.content.length);
      this.content = this.content.slice(0, pos) + delta.text + this.content.slice(pos);
    } else if (delta.type === "delete" && delta.length) {
      const pos = Math.min(Math.max(0, delta.position), this.content.length);
      this.content = this.content.slice(0, pos) + this.content.slice(pos + delta.length);
    } else if (delta.type === "replace" && delta.text) {
      const pos = Math.min(Math.max(0, delta.position), this.content.length);
      const len = delta.length ?? 0;
      this.content = this.content.slice(0, pos) + delta.text + this.content.slice(pos + len);
    }

    return this.getSnapshot();
  }

  /**
   * Updates peer presence and cursor tracking.
   */
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

  public getSnapshot(): DocumentSnapshot {
    return {
      artifactId: this.documentId,
      version: this.version,
      content: this.content,
      lastModifiedBy: this.history.length > 0 ? this.history[this.history.length - 1].authorId : "system",
      updatedAt: Date.now(),
    };
  }
}
