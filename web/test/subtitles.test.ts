import { describe, expect, it } from 'vitest';
import {
  dirForLang,
  MAX_COMMITTED_LINES,
  MIN_ON_SCREEN_MS,
  SubtitleModel,
} from '../src/subtitles';
import type { Lang, SubtitleMessage } from '../src/types';

function msg(over: Partial<SubtitleMessage> & { segmentId: string }): SubtitleMessage {
  return {
    v: 1,
    callId: 'c_9f2a1b7c4d30',
    seq: 0,
    speakerId: 'u_alex',
    listenerId: 'u_noa',
    srcLang: 'ru' as Lang,
    dstLang: 'he' as Lang,
    srcText: '',
    dstText: '',
    isFinal: false,
    tStart: 0,
    tEnd: 0,
    ...over,
  };
}

describe('dirForLang', () => {
  it('derives direction from the declared language, not the characters', () => {
    expect(dirForLang('he')).toBe('rtl');
    expect(dirForLang('ru')).toBe('ltr');
  });

  it('keeps a mixed he+ru+digits line RTL when the line language is Hebrew', () => {
    const model = new SubtitleModel();
    const t = 1_000;
    model.push(
      msg({
        segmentId: 'seg_u_alex_000001',
        isFinal: true,
        srcLang: 'ru',
        dstLang: 'he',
        srcText: 'встретимся в 7 у моря, ок?',
        // Hebrew opening a line with digits and a Latin token embedded.
        dstText: 'בואי ניפגש ב-7 ליד הים, ok?',
      }),
      t,
    );

    const line = model.view(t).committed[0];
    expect(line).toBeDefined();
    // The translation slot is Hebrew -> rtl even though it starts with a
    // Hebrew word but carries Latin and digits inside the run.
    expect(dirForLang(line!.dstLang)).toBe('rtl');
    // The original slot is Russian -> ltr, on the same rendered line.
    expect(dirForLang(line!.srcLang)).toBe('ltr');
  });
});

describe('SubtitleModel partials', () => {
  it('replaces only the partial slot when a partial supersedes itself', () => {
    const model = new SubtitleModel();
    const t = 5_000;

    model.push(msg({ segmentId: 'seg_a', isFinal: true, srcText: 'привет', dstText: 'היי' }), t);
    model.push(msg({ segmentId: 'seg_b', seq: 0, srcText: 'я' }), t + 100);
    model.push(msg({ segmentId: 'seg_b', seq: 1, srcText: 'я завтра' }), t + 300);

    const view = model.view(t + 300);
    expect(view.partial?.srcText).toBe('я завтра');
    expect(view.committed).toHaveLength(1);
    expect(view.committed[0]?.srcText).toBe('привет');
  });

  it('ignores an out-of-order partial so visible text never shrinks', () => {
    const model = new SubtitleModel();
    model.push(msg({ segmentId: 'seg_b', seq: 3, srcText: 'я завтра прилетаю' }), 0);
    model.push(msg({ segmentId: 'seg_b', seq: 1, srcText: 'я' }), 10);
    expect(model.view(10).partial?.srcText).toBe('я завтра прилетаю');
  });

  it('clears the partial slot when that segment is finalised', () => {
    const model = new SubtitleModel();
    model.push(msg({ segmentId: 'seg_b', seq: 0, srcText: 'я завтра' }), 0);
    model.push(
      msg({ segmentId: 'seg_b', seq: 1, isFinal: true, srcText: 'я завтра прилетаю', dstText: 'אני נוחת מחר' }),
      50,
    );

    const view = model.view(50);
    expect(view.partial).toBeNull();
    expect(view.committed).toHaveLength(1);
    expect(view.committed[0]?.dstText).toBe('אני נוחת מחר');
  });
});

describe('SubtitleModel commitment', () => {
  it('never rewrites a committed line', () => {
    const model = new SubtitleModel();
    const t = 0;
    model.push(msg({ segmentId: 'seg_a', isFinal: true, srcText: 'привет', dstText: 'היי' }), t);

    // A late straggler for a closed segment, and a late partial for it too.
    model.push(msg({ segmentId: 'seg_a', seq: 9, isFinal: true, srcText: 'НЕТ', dstText: 'לא' }), t + 5);
    model.push(msg({ segmentId: 'seg_a', seq: 10, srcText: 'НЕТ' }), t + 10);

    const view = model.view(t + 10);
    expect(view.committed).toHaveLength(1);
    expect(view.committed[0]?.srcText).toBe('привет');
    expect(view.committed[0]?.dstText).toBe('היי');
    expect(view.partial).toBeNull();
  });

  it('never shows more than two committed lines', () => {
    const model = new SubtitleModel();
    let t = 0;
    for (let i = 0; i < 6; i += 1) {
      model.push(msg({ segmentId: `seg_${i}`, isFinal: true, srcText: `s${i}`, dstText: `d${i}` }), t);
      // Space the finals out so the minimum-on-screen rule never holds any back.
      t += MIN_ON_SCREEN_MS + 1;
    }
    const view = model.view(t);
    expect(view.committed.length).toBeLessThanOrEqual(MAX_COMMITTED_LINES);
    expect(view.committed.map((l) => l.srcText)).toEqual(['s4', 's5']);
  });

  it('holds a line back rather than evicting one before its minimum on-screen time', () => {
    const model = new SubtitleModel();
    model.push(msg({ segmentId: 'seg_0', isFinal: true, srcText: 's0' }), 0);
    model.push(msg({ segmentId: 'seg_1', isFinal: true, srcText: 's1' }), 10);
    // A third final arrives while s0 has been visible for only 20ms.
    model.push(msg({ segmentId: 'seg_2', isFinal: true, srcText: 's2' }), 20);

    const held = model.view(20);
    expect(held.committed.map((l) => l.srcText)).toEqual(['s0', 's1']);
    expect(held.nextChangeAt).toBe(MIN_ON_SCREEN_MS);

    // Once s0 has had its second, s2 is admitted without any new message.
    const later = model.view(MIN_ON_SCREEN_MS + 1);
    expect(later.committed.map((l) => l.srcText)).toEqual(['s1', 's2']);
    expect(later.nextChangeAt).toBeNull();
  });

  it('resets cleanly between calls', () => {
    const model = new SubtitleModel();
    model.push(msg({ segmentId: 'seg_a', isFinal: true, srcText: 'привет' }), 0);
    model.reset();
    expect(model.view(0).committed).toHaveLength(0);
    // The same segment id may legitimately reappear in a new call.
    model.push(msg({ segmentId: 'seg_a', isFinal: true, srcText: 'снова' }), 0);
    expect(model.view(0).committed[0]?.srcText).toBe('снова');
  });
});
