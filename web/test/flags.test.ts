import { describe, expect, it } from 'vitest';
import { flagPreview, FlagLog, utteranceIdOf } from '../src/flags';
import type { SubtitleMessage } from '../src/types';

let seq = 0;

function msg(over: Partial<SubtitleMessage> = {}): SubtitleMessage {
  seq += 1;
  return {
    v: 1,
    callId: 'c_1',
    segmentId: `s${seq}`,
    seq: 0,
    speakerId: 'u_alex',
    listenerId: 'u_noa',
    srcLang: 'ru',
    dstLang: 'he',
    srcText: `источник ${seq}`,
    dstText: `תרגום ${seq}`,
    isFinal: true,
    tStart: seq,
    tEnd: seq + 1,
    ...over,
  };
}

describe('utteranceIdOf', () => {
  it('prefers the agent-supplied id', () => {
    expect(utteranceIdOf(msg({ segmentId: 's1', utteranceId: 'u_9' }))).toBe('u_9');
  });

  it('falls back to the segment id, which is the same stable identity', () => {
    expect(utteranceIdOf(msg({ segmentId: 's1' }))).toBe('s1');
  });

  it('ignores an empty utteranceId', () => {
    expect(utteranceIdOf(msg({ segmentId: 's1', utteranceId: '' }))).toBe('s1');
  });
});

describe('FlagLog targeting', () => {
  it('has nothing to flag before any translation arrives', () => {
    const log = new FlagLog();
    expect(log.target(0)).toBeNull();
    expect(log.target(1)).toBeNull();
  });

  it('ignores partials — a hypothesis still being rewritten is not judgeable', () => {
    const log = new FlagLog();
    log.push(msg({ segmentId: 's1', isFinal: false }));
    expect(log.target(0)).toBeNull();
    log.push(msg({ segmentId: 's1', isFinal: true }));
    expect(log.target(0)?.utteranceId).toBe('s1');
  });

  it('aims offset 0 at the newest utterance and offset 1 at the one before', () => {
    const log = new FlagLog();
    log.push(msg({ segmentId: 's1' }));
    log.push(msg({ segmentId: 's2' }));
    log.push(msg({ segmentId: 's3' }));
    expect(log.target(0)?.segmentId).toBe('s3');
    expect(log.target(1)?.segmentId).toBe('s2');
    expect(log.target(-1)).toBeNull();
  });

  it('does not create a second entry for a retransmitted final', () => {
    const log = new FlagLog();
    log.push(msg({ segmentId: 's1', dstText: 'first' }));
    log.push(msg({ segmentId: 's1', dstText: 'first (again)' }));
    expect(log.size).toBe(1);
    expect(log.target(0)?.dstText).toBe('first (again)');
  });

  it('keeps a verdict when the same final is retransmitted', () => {
    const log = new FlagLog();
    log.push(msg({ segmentId: 's1' }));
    log.markFlagged('s1', 'היה צריך להגיד אחרת');
    log.push(msg({ segmentId: 's1' }));
    expect(log.target(0)?.flagged).toBe(true);
    expect(log.target(0)?.expected).toBe('היה צריך להגיד אחרת');
  });

  it('marks the right utterance when the judge reacts a beat late', () => {
    const log = new FlagLog();
    log.push(msg({ segmentId: 's1', dstText: 'good' }));
    log.push(msg({ segmentId: 's2', dstText: 'bad' }));
    // The next one already arrived before the tester could press the button.
    log.push(msg({ segmentId: 's3', dstText: 'also good' }));
    const late = log.target(1);
    expect(late?.segmentId).toBe('s2');
    log.markFlagged(late!.utteranceId);
    expect(log.flaggedSegmentIds()).toEqual(new Set(['s2']));
    expect(log.target(0)?.flagged).toBe(false);
  });

  it('never erases an existing correction with an empty one', () => {
    const log = new FlagLog();
    log.push(msg({ segmentId: 's1' }));
    log.markFlagged('s1', 'should have been this');
    log.markFlagged('s1', '   ');
    expect(log.target(0)?.expected).toBe('should have been this');
  });

  it('trims the correction it stores', () => {
    const log = new FlagLog();
    log.push(msg({ segmentId: 's1' }));
    log.markFlagged('s1', '  נכון  ');
    expect(log.target(0)?.expected).toBe('נכון');
  });

  it('returns null when asked to flag an unknown utterance', () => {
    const log = new FlagLog();
    expect(log.markFlagged('nope')).toBeNull();
  });

  it('drops the oldest entries past the history bound', () => {
    const log = new FlagLog({ maxEntries: 3 });
    for (const id of ['s1', 's2', 's3', 's4']) log.push(msg({ segmentId: id }));
    expect(log.size).toBe(3);
    expect(log.target(2)?.segmentId).toBe('s2');
    expect(log.byId('s1')).toBeNull();
  });

  it('hands back copies, so the UI cannot mutate the log', () => {
    const log = new FlagLog();
    log.push(msg({ segmentId: 's1' }));
    const target = log.target(0)!;
    target.flagged = true;
    expect(log.target(0)?.flagged).toBe(false);
  });

  it('resets between calls', () => {
    const log = new FlagLog();
    log.push(msg({ segmentId: 's1' }));
    log.reset();
    expect(log.size).toBe(0);
    expect(log.target(0)).toBeNull();
  });
});

describe('flagPreview', () => {
  it('prefers the translation, which is the thing being judged', () => {
    const log = new FlagLog();
    log.push(msg({ segmentId: 's1', srcText: 'привет', dstText: 'שלום' }));
    expect(flagPreview(log.target(0))).toBe('שלום');
  });

  it('falls back to the source when MT produced nothing', () => {
    const log = new FlagLog();
    log.push(msg({ segmentId: 's1', srcText: 'привет', dstText: '' }));
    expect(flagPreview(log.target(0))).toBe('привет');
  });

  it('truncates long text and marks the elision', () => {
    const log = new FlagLog();
    log.push(msg({ segmentId: 's1', dstText: 'a'.repeat(200) }));
    const preview = flagPreview(log.target(0), 10);
    expect(preview).toHaveLength(10);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('is empty with no target', () => {
    expect(flagPreview(null)).toBe('');
  });
});
