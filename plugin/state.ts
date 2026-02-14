/**
 * CallosumState — Manages journal, locks, and context tracking.
 * 
 * All state is file-based in a shared directory, enabling cross-session
 * coordination on the same VM via filesystem.
 */

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, statSync, renameSync } from "fs";
import { join } from "path";
import type { Tier } from "./tier-engine.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface Lock {
  instance: string;
  contextKey: string;
  tier: Tier;
  acquiredAt: number;
  expiresAt: number;
}

export interface ContextEntry {
  instance: string;
  contextKey: string;
  tier: Tier;
  timestamp: number;
  tool: string;
}

export interface JournalEntry {
  timestamp: string;
  instance: string;
  tool: string;
  tier: Tier;
  ruleName: string;
  contextKey: string | null;
  action: "intercept" | "complete" | "blocked";
  params_summary?: string;
  conflict?: string;
}

export interface ConflictResult {
  hasConflict: boolean;
  conflictWith?: string;
  locked?: boolean;
}

// ─── Constants ─────────────────────────────────────────────────────────────

const CONTEXT_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const ROTATION_SIZE_BYTES = 2 * 1024 * 1024; // 2MB
const ROTATION_KEEP = 1;

// ─── State Manager ─────────────────────────────────────────────────────────

export class CallosumState {
  private stateDir: string;
  private lockExpiryMs: number;

  constructor(stateDir: string, lockExpiryMs: number) {
    this.stateDir = stateDir;
    this.lockExpiryMs = lockExpiryMs;
    mkdirSync(stateDir, { recursive: true });
  }

  private locksPath() { return join(this.stateDir, "locks.json"); }
  private contextsPath() { return join(this.stateDir, "contexts.json"); }
  private journalPath() { return join(this.stateDir, "journal.jsonl"); }

  // ── Locks ──

  readLocks(): Lock[] {
    try {
      return (JSON.parse(readFileSync(this.locksPath(), "utf-8")) as Lock[])
        .filter((l) => l.expiresAt > Date.now());
    } catch { return []; }
  }

  private writeLocks(locks: Lock[]) {
    writeFileSync(this.locksPath(), JSON.stringify(locks, null, 2));
  }

  acquireLock(instance: string, contextKey: string, tier: Tier): boolean {
    const locks = this.readLocks();
    const existing = locks.find((l) => l.contextKey === contextKey);
    if (existing && existing.instance !== instance) return false;
    if (existing && existing.instance === instance) {
      existing.expiresAt = Date.now() + this.lockExpiryMs;
      this.writeLocks(locks);
      return true;
    }
    locks.push({
      instance, contextKey, tier,
      acquiredAt: Date.now(),
      expiresAt: Date.now() + this.lockExpiryMs,
    });
    this.writeLocks(locks);
    return true;
  }

  releaseLock(instance: string, contextKey: string) {
    const locks = this.readLocks();
    this.writeLocks(locks.filter((l) => !(l.contextKey === contextKey && l.instance === instance)));
  }

  // ── Context ──

  private readContexts(): ContextEntry[] {
    try {
      return (JSON.parse(readFileSync(this.contextsPath(), "utf-8")) as ContextEntry[])
        .filter((e) => e.timestamp > Date.now() - CONTEXT_WINDOW_MS);
    } catch { return []; }
  }

  private writeContexts(entries: ContextEntry[]) {
    writeFileSync(this.contextsPath(), JSON.stringify(entries, null, 2));
  }

  recordContext(instance: string, contextKey: string, tier: Tier, tool: string) {
    const contexts = this.readContexts();
    contexts.push({ instance, contextKey, tier, timestamp: Date.now(), tool });
    this.writeContexts(contexts);
  }

  // ── Conflict Detection ──

  checkConflicts(instance: string, contextKey: string, tier: Tier): ConflictResult {
    const locks = this.readLocks();
    const lockConflict = locks.find((l) => l.contextKey === contextKey && l.instance !== instance);
    if (lockConflict) {
      return { hasConflict: true, conflictWith: lockConflict.instance, locked: true };
    }
    if (tier >= 3) {
      const contexts = this.readContexts();
      const recent = contexts.find((c) => c.contextKey === contextKey && c.instance !== instance);
      if (recent) {
        return { hasConflict: true, conflictWith: recent.instance };
      }
    }
    return { hasConflict: false };
  }

  // ── Journal ──

  appendJournal(entry: JournalEntry) {
    const journalPath = this.journalPath();
    appendFileSync(journalPath, JSON.stringify(entry) + "\n");
    this.maybeRotate(journalPath);
  }

  getJournal(limit: number = 50): JournalEntry[] {
    try {
      const lines = readFileSync(this.journalPath(), "utf-8").trim().split("\n");
      return lines.slice(-limit).map((l) => JSON.parse(l));
    } catch { return []; }
  }

  private maybeRotate(journalPath: string) {
    try {
      if (statSync(journalPath).size <= ROTATION_SIZE_BYTES) return;
      for (let i = ROTATION_KEEP; i >= 1; i--) {
        try { renameSync(`${journalPath}.${i}`, `${journalPath}.${i + 1}`); } catch {}
      }
      try { renameSync(`${journalPath}.${ROTATION_KEEP + 1}`, "/dev/null"); } catch {}
      renameSync(journalPath, `${journalPath}.1`);
    } catch {}
  }

  // ── Status ──

  getStatus() {
    return {
      locks: this.readLocks(),
      recentContexts: this.readContexts(),
      journalLines: this.countJournalLines(),
    };
  }

  private countJournalLines(): number {
    try {
      return readFileSync(this.journalPath(), "utf-8").trim().split("\n").length;
    } catch { return 0; }
  }
}
