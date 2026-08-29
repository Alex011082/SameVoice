import type { Lang, SubtitleMessage } from './types';

/**
 * Pure stability model for in-call subtitles. No DOM access lives here so the
 * rules below can be unit-tested directly (web/test/subtitles.test.ts).
 *
 * The product rule this file exists to enforce: text that has already been
 * committed to screen is NEVER rewritten. Spoken words cannot be un-spoken, and
 * a caption that mutates under the reader's eye is worse than a late caption.
 */

export const MAX_COMMITTED_LINES = 2;
export const MIN_ON_SCREEN_MS = 1000;

export interface SubtitleLine {
  segmentId: string;
  speakerId: string;
  srcLang: Lang;
  dstLang: Lang;
  srcText: string;
  dstText: string;
  isFinal: boolean;
  tStart: number;
  tEnd: number;
  /** Wall-clock ms at which this line became visible. */
  shownAt: number;
}

export interface SubtitleView {
  /** Oldest first, at most MAX_COMMITTED_LINES entries. */
  committed: SubtitleLine[];
  /** The single in-flight hypothesis, rendered dimmed. */
  partial: SubtitleLine | null;
  /**
   * Wall-clock ms at which view() would return something different without any
   * new message arriving, or null if the view is stable. The renderer uses this
   * to schedule exactly one repaint instead of polling.
   */
  nextChangeAt: number | null;
}

/** Base direction of a line, decided by its declared language - never sniffed
 *  from the characters. A Hebrew line that opens with a Latin brand name or a
 *  digit is still an RTL paragraph. */
export function dirForLang(lang: Lang): 'rtl' | 'ltr' {
  return lang === 'he' ? 'rtl' : 'ltr';
}

export function langLabel(lang: Lang): string {
  return lang === 'he' ? 'עברית' : 'Русский';
}

function lineFromMessage(msg: SubtitleMessage, now: number): SubtitleLine {
  return {
    segmentId: msg.segmentId,
    speakerId: msg.speakerId,
    srcLang: msg.srcLang,
    dstLang: msg.dstLang,
    srcText: msg.srcText,
    dstText: msg.dstText,
    isFinal: msg.isFinal,
    tStart: msg.tStart,
    tEnd: msg.tEnd,
    shownAt: now,
  };
}

export class SubtitleModel {
  private readonly maxLines: number;
  private readonly minOnScreenMs: number;

  private committed: SubtitleLine[] = [];
  private partial: SubtitleLine | null = null;
  private partialSeq = -1;

  /** Segments already committed. A late message for one of these is dropped. */
  private readonly closed = new Set<string>();
  /** Finals that arrived while the oldest visible line was still inside its
   *  minimum on-screen window. Admitted by a later view() call. */
  private queued: SubtitleLine[] = [];

  constructor(opts?: { maxLines?: number; minOnScreenMs?: number }) {
    this.maxLines = opts?.maxLines ?? MAX_COMMITTED_LINES;
    this.minOnScreenMs = opts?.minOnScreenMs ?? MIN_ON_SCREEN_MS;
  }

  push(msg: SubtitleMessage, now: number = Date.now()): void {
    // Nothing follows isFinal:true for a segment. If something does, it is a
    // duplicate or a reordered straggler - drop it rather than rewrite.
    if (this.closed.has(msg.segmentId)) return;

    if (!msg.isFinal) {
      // A newer partial supersedes the previous one. Out-of-order partials for
      // the same segment (lower seq) are ignored so text never shrinks.
      if (this.partial?.segmentId === msg.segmentId && msg.seq <= this.partialSeq) return;
      this.partial = lineFromMessage(msg, now);
      this.partialSeq = msg.seq;
      return;
    }

    this.closed.add(msg.segmentId);
    if (this.partial?.segmentId === msg.segmentId) {
      this.partial = null;
      this.partialSeq = -1;
    }
    this.queued.push(lineFromMessage(msg, now));
    // Two queued lines is already more than the window can ever show.
    if (this.queued.length > this.maxLines) {
      this.queued = this.queued.slice(-this.maxLines);
    }
    this.admit(now);
  }

  view(now: number = Date.now()): SubtitleView {
    this.admit(now);
    return {
      committed: this.committed.map((l) => ({ ...l })),
      partial: this.partial ? { ...this.partial } : null,
      nextChangeAt: this.nextChangeAt(),
    };
  }

  reset(): void {
    this.committed = [];
    this.partial = null;
    this.partialSeq = -1;
    this.queued = [];
    this.closed.clear();
  }

  /** Move queued finals into the visible window, but never evict a line that
   *  has not yet had its minimum time on screen. */
  private admit(now: number): void {
    while (this.queued.length > 0) {
      if (this.committed.length >= this.maxLines) {
        const oldest = this.committed[0];
        if (oldest && now - oldest.shownAt < this.minOnScreenMs) return;
        this.committed.shift();
      }
      const next = this.queued.shift();
      if (!next) return;
      // shownAt is stamped at admission, not at arrival, so a line held back by
      // the readability rule still gets its own full second once shown.
      this.committed.push({ ...next, shownAt: now });
    }
  }

  private nextChangeAt(): number | null {
    if (this.queued.length === 0) return null;
    if (this.committed.length < this.maxLines) return null;
    const oldest = this.committed[0];
    return oldest ? oldest.shownAt + this.minOnScreenMs : null;
  }
}
