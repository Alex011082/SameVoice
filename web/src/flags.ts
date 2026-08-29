import type { Lang, SubtitleMessage } from './types';

/**
 * The bilingual-judge half of the client: which utterance a "that was wrong"
 * press actually refers to.
 *
 * The rule that shapes this file: people react a beat late. By the time a
 * tester decides the translation was wrong, the agent has usually committed the
 * next one. So the log keeps a short history and the UI can aim at the most
 * recent utterance OR the one before it — nothing else is offered, because a
 * longer list turns a reflex into a decision and the conversation stalls.
 *
 * Pure: no DOM, no network. Tested in web/test/flags.test.ts.
 */

/** How many finalised utterances stay flaggable. Only the newest two are offered. */
export const FLAG_HISTORY = 8;

export interface FlagTarget {
  /** Stable id shared with the agent's eval JSONL row. */
  utteranceId: string;
  /** Subtitle segment this came from, used to mark the on-screen line. */
  segmentId: string;
  speakerId: string;
  srcLang: Lang;
  dstLang: Lang;
  srcText: string;
  dstText: string;
  /** Wall-clock ms this became flaggable. */
  receivedAt: number;
  flagged: boolean;
  /** What the judge said it should have been, if they typed anything. */
  expected: string | null;
}

/**
 * The agent may or may not carry an explicit utteranceId. The subtitle
 * segmentId is stable across the partial -> final lifetime of one fragment and
 * is therefore a correct fallback key for the same row.
 */
export function utteranceIdOf(msg: SubtitleMessage): string {
  const explicit = (msg as { utteranceId?: unknown }).utteranceId;
  return typeof explicit === 'string' && explicit.length > 0 ? explicit : msg.segmentId;
}

export class FlagLog {
  private readonly maxEntries: number;
  /** Newest last. */
  private entries: FlagTarget[] = [];

  constructor(opts?: { maxEntries?: number }) {
    this.maxEntries = opts?.maxEntries ?? FLAG_HISTORY;
  }

  /**
   * Record a finalised translated utterance. Partials are ignored: a hypothesis
   * that is still being rewritten cannot be judged, and flagging one would
   * label a row the agent has not written yet.
   */
  push(msg: SubtitleMessage, now: number = Date.now()): void {
    if (!msg.isFinal) return;
    const utteranceId = utteranceIdOf(msg);
    const existing = this.entries.find((e) => e.utteranceId === utteranceId);
    if (existing) {
      // A duplicate final (retransmit) must not push a second card into history
      // and must never clear a verdict the judge already gave.
      existing.srcText = msg.srcText;
      existing.dstText = msg.dstText;
      return;
    }
    this.entries.push({
      utteranceId,
      segmentId: msg.segmentId,
      speakerId: msg.speakerId,
      srcLang: msg.srcLang,
      dstLang: msg.dstLang,
      srcText: msg.srcText,
      dstText: msg.dstText,
      receivedAt: now,
      flagged: false,
      expected: null,
    });
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }

  /** offset 0 = most recent finalised utterance, 1 = the one before it. */
  target(offset: number): FlagTarget | null {
    if (offset < 0) return null;
    const idx = this.entries.length - 1 - offset;
    if (idx < 0) return null;
    const entry = this.entries[idx];
    return entry ? { ...entry } : null;
  }

  byId(utteranceId: string): FlagTarget | null {
    const entry = this.entries.find((e) => e.utteranceId === utteranceId);
    return entry ? { ...entry } : null;
  }

  /** Marks a verdict locally. Returns the updated target, or null if unknown. */
  markFlagged(utteranceId: string, expected: string | null = null): FlagTarget | null {
    const entry = this.entries.find((e) => e.utteranceId === utteranceId);
    if (!entry) return null;
    entry.flagged = true;
    // A later, longer correction wins; an empty one never erases an earlier one.
    if (expected !== null && expected.trim().length > 0) entry.expected = expected.trim();
    return { ...entry };
  }

  /** Segment ids of flagged utterances, for marking the subtitle lines. */
  flaggedSegmentIds(): Set<string> {
    const out = new Set<string>();
    for (const entry of this.entries) if (entry.flagged) out.add(entry.segmentId);
    return out;
  }

  get size(): number {
    return this.entries.length;
  }

  reset(): void {
    this.entries = [];
  }
}

/** One-line preview of what a press would flag, for the button's label area. */
export function flagPreview(target: FlagTarget | null, maxChars = 64): string {
  if (!target) return '';
  const text = target.dstText.trim() || target.srcText.trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}
