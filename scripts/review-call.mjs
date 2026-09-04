#!/usr/bin/env node
// Read one call's eval log and print a session report: every translated
// utterance with its source, the flagged ones highlighted, latency percentiles
// per stage, and counts.
//
//   npm run review                     # list the calls on disk
//   npm run review -- latest           # the most recently modified call
//   npm run review -- c_ab12cd34ef56   # one call by id
//   npm run review -- latest --flagged # only the utterances a judge marked wrong
//   npm run review -- latest --json    # machine-readable summary, for diffing runs
//
// This is the thing the two testers look at after a call, which is why the
// flagged utterances are printed FIRST, in full, with the correction the judge
// typed. A verdict of "wrong" from a bilingual judge who heard both sides is
// worth more than any automatic metric in this repo — the report is arranged so
// that those lines cannot be scrolled past.
//
// The log is JSON Lines: one JSON object per line, appended as the call runs, so
// a crash mid-call still leaves everything up to that point readable. Two kinds
// of record share the file and are joined on the utterance id:
//
//   utterance  written by the agent when a unit has been translated and spoken
//   verdict    written when a tester presses the WRONG button (optionally with
//              what it should have been)
//
// An `utterance` line is one committed CHUNK, and one spoken utterance is
// several of them — median ONE WORD on the Omri-Maya call (27.08.2026), the
// measurement kept at agent/src/speakeasy_agent/chunker.py:60. The commit policy
// has tightened since and nothing has re-measured the ratio. Rows of the same
// utterance share `utteranceKey`, and the writer marks `isFirstChunk` on exactly
// one of them — which is what the latency table below aggregates over for the
// stages that are anchored on speech start. Counting those per chunk weighted
// every utterance by how many chunks it happened to produce. A log may still
// hold a key with NO first chunk (a barge-in cancelled or dropped that row);
// that is counted and printed rather than left to shrink an n silently.
//
// Field names are read tolerantly (camelCase and snake_case, a few synonyms):
// this tool and the writer are built by different people at the same time, and
// a report that refuses to print because a key is spelled `src_lang` instead of
// `srcLang` would be worse than useless on the evening of a test session.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const C = {
  reset: "\u001b[0m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  cyan: "\u001b[36m",
  dim: "\u001b[2m",
  bold: "\u001b[1m",
};
const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const c = (name, s) => (NO_COLOR ? String(s) : `${C[name]}${s}${C.reset}`);

// --------------------------------------------------------------------- args
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const positional = argv.filter((a) => !a.startsWith("--"));

let evalDir = null;
const dirIdx = argv.indexOf("--dir");
if (dirIdx !== -1) {
  evalDir = argv[dirIdx + 1];
  if (!evalDir) fail("--dir needs a path");
  positional.splice(positional.indexOf(evalDir), 1);
  flags.delete("--dir");
}

function fail(msg) {
  console.error(`${c("red", "error:")} ${msg}`);
  process.exit(1);
}

/** EVAL_LOG_DIR from .env, so the tool follows the configured location. */
function evalDirFromEnv() {
  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) return "logs/calls";
  const m = /^\s*(?:export\s+)?EVAL_LOG_DIR\s*=\s*(.*)$/m.exec(readFileSync(envPath, "utf8"));
  if (!m) return "logs/calls";
  return m[1].trim().replace(/^["']|["']$/g, "") || "logs/calls";
}

// resolve, not join: EVAL_LOG_DIR is relative to the repo root, but --dir may
// legitimately be an absolute path (an archived session outside the repo).
const DIR = resolve(ROOT, evalDir ?? evalDirFromEnv());

// ------------------------------------------------------------ field readers
const pick = (obj, ...names) => {
  for (const n of names) {
    const v = obj?.[n];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
};

const KIND = (r) => String(pick(r, "type", "kind", "event", "record") ?? "utterance").toLowerCase();

const isVerdict = (r) => {
  const k = KIND(r);
  if (["verdict", "judgement", "judgment", "judge", "flag", "review"].includes(k)) return true;
  // A record that carries only a verdict field and an id is a verdict too.
  return pick(r, "verdict", "judgeVerdict", "judge_verdict") !== undefined && pick(r, "source", "sourceText", "source_text", "srcText", "src_text", "transcript") === undefined;
};

const uttId = (r) =>
  pick(r, "utteranceId", "utterance_id", "uid", "id", "unitId", "unit_id");

// A log line is one committed CHUNK, and one utterance is several of them.
// These two readers are what lets a percentile take one sample per utterance
// instead of one per chunk. `segmentId` cannot do it: adjacent chunks of one
// utterance get different segment ids.
//
// In logs written after the key was made unique it is
// `<first chunk's utteranceId>@<ms since call start>`. Older logs used the
// offset alone, so two utterances a fraction of a millisecond apart share a key
// there — groupingAnomalies counts those and printReport says so.
const uttKey = (r) => pick(r, "utteranceKey", "utterance_key") ?? uttId(r);

// Missing means a log written before the mark existed — every call recorded so
// far, 27.08.2026 included. Those files can only support one utterance per row,
// which is exactly how this tool always read them — so nothing is regrouped.
const isFirstChunk = (r) => {
  const v = pick(r, "isFirstChunk", "is_first_chunk", "firstChunk", "first_chunk");
  return v === undefined ? true : Boolean(v);
};

/** Latencies live either in a nested object or flat on the record. */
function latencies(r) {
  const nested = pick(r, "latency", "latencies", "metrics", "timings") ?? {};
  const src = { ...nested, ...r };
  const num = (...names) => {
    const v = pick(src, ...names);
    const n = typeof v === "string" ? Number(v) : v;
    return Number.isFinite(n) ? n : undefined;
  };
  // The first name in each list is the one the agent actually writes
  // (agent/src/speakeasy_agent/direction.py, UnitMetrics.stage_timings); the
  // rest are the synonyms this tool has always accepted.
  return {
    stt: num("speech_start_to_first_partial_ms", "stt_final_ms", "sttFinalMs", "stt_ms", "sttMs"),
    chunk: num("first_partial_to_commit_ms", "chunk_ms", "chunkMs", "commit_ms", "commitMs"),
    mt: num("commit_to_mt_done_ms", "mt_ms", "mtMs"),
    tts: num("mt_done_to_first_audio_ms", "tts_ttfb_ms", "ttsTtfbMs", "tts_ms", "ttsMs"),
    e2e: num(
      "speech_start_to_first_audio_ms",
      "e2e_ms",
      "e2eMs",
      "perceived_ms",
      "perceivedMs",
      "total_ms",
      "totalMs",
    ),
  };
}

function providers(r) {
  const nested = pick(r, "providers", "provider") ?? {};
  const src = { ...nested, ...r };
  return {
    stt: pick(src, "stt", "stt_provider", "sttProvider"),
    mt: pick(src, "mt", "mt_provider", "mtProvider"),
    tts: pick(src, "tts", "tts_provider", "ttsProvider"),
  };
}

function normalizeUtterance(r) {
  const l = latencies(r);
  const p = providers(r);
  return {
    id: uttId(r) ?? null,
    utteranceKey: uttKey(r) ?? null,
    firstChunk: isFirstChunk(r),
    hasKey: pick(r, "utteranceKey", "utterance_key") !== undefined,
    ts: pick(r, "ts", "timestamp", "at", "time", "createdAt", "created_at") ?? null,
    callId: pick(r, "callId", "call_id", "call") ?? null,
    srcLang: pick(r, "srcLang", "src_lang", "sourceLang", "source_lang", "from") ?? "?",
    dstLang: pick(r, "dstLang", "dst_lang", "targetLang", "target_lang", "to") ?? "?",
    speakerId: pick(r, "speakerId", "speaker_id", "speaker", "speakerUserId") ?? "?",
    speakerGender: pick(r, "speakerGender", "speaker_gender") ?? "?",
    listenerId: pick(r, "listenerId", "listener_id", "listener", "listenerUserId") ?? null,
    listenerGender: pick(r, "listenerGender", "listener_gender") ?? "?",
    tone: pick(r, "tone", "register") ?? "?",
    source: String(pick(r, "srcText", "src_text", "source", "sourceText", "source_text", "src", "transcript", "original") ?? ""),
    translation: String(pick(r, "dstText", "dst_text", "translation", "translationText", "translation_text", "translated", "dst", "text") ?? ""),
    latency: l,
    providers: p,
    // Read but NOT filtered on: this tool has always percentiled over every
    // row, and agent/scripts/review_call.py has always dropped these. Changing
    // either aggregation here would silently move every number in every past
    // report, so instead the divergence is counted and printed below.
    cancelled: Boolean(pick(r, "cancelled", "was_cancelled", "isCancelled") ?? false),
    error: pick(r, "error", "err", "failure") ?? null,
    verdict: null,
    correction: null,
    verdictBy: null,
    verdictTs: null,
    verdictNote: null,
  };
}

function normalizeVerdict(r) {
  const raw = String(pick(r, "verdict", "judgeVerdict", "judge_verdict", "flag", "label") ?? "wrong").toLowerCase();
  const verdict = ["wrong", "bad", "incorrect", "false", "0"].includes(raw)
    ? "wrong"
    : ["ok", "good", "correct", "right", "true", "1"].includes(raw)
      ? "ok"
      : raw;
  return {
    id: uttId(r) ?? null,
    verdict,
    correction: pick(r, "correction", "expected", "shouldBe", "should_be", "corrected", "suggestion") ?? null,
    by: pick(r, "by", "judgeId", "judge_id", "userId", "user_id", "judge") ?? null,
    ts: pick(r, "ts", "timestamp", "at", "time") ?? null,
    note: pick(r, "note", "comment", "reason") ?? null,
  };
}

// ------------------------------------------------------------------- loading
function listCalls() {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const path = join(DIR, f);
      return { id: basename(f, ".jsonl"), path, mtime: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function loadCall(path) {
  const utterances = [];
  const byId = new Map();
  const verdicts = [];
  let malformed = 0;
  let lineNo = 0;

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    lineNo += 1;
    const t = line.trim();
    if (t === "") continue;
    let rec;
    try {
      rec = JSON.parse(t);
    } catch {
      malformed += 1;
      continue;
    }
    if (typeof rec !== "object" || rec === null) {
      malformed += 1;
      continue;
    }
    if (isVerdict(rec)) {
      verdicts.push(normalizeVerdict(rec));
      continue;
    }
    const u = normalizeUtterance(rec);
    // A record with no text at all is metadata (call header, end marker); skip
    // it rather than printing an empty row.
    if (u.source === "" && u.translation === "") continue;
    u._line = lineNo;
    utterances.push(u);
    if (u.id) byId.set(u.id, u);
  }

  // Last verdict for an id wins — a judge is allowed to change their mind.
  let orphanVerdicts = 0;
  for (const v of verdicts) {
    const u = v.id ? byId.get(v.id) : undefined;
    if (!u) {
      orphanVerdicts += 1;
      continue;
    }
    u.verdict = v.verdict;
    u.correction = v.correction;
    u.verdictBy = v.by;
    u.verdictTs = v.ts;
    u.verdictNote = v.note;
  }

  return { utterances, verdicts, malformed, orphanVerdicts };
}

// ---------------------------------------------------------------- statistics
/** Nearest-rank percentile. Returns undefined for an empty sample. */
function pct(sorted, p) {
  if (sorted.length === 0) return undefined;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/** Width of the stage-name column; the longest label plus a space. */
const STAGE_COL = 22;

/** These chunk rows bucketed per utterance, in first-seen order. A row with no
 * id at all gets a bucket of its own rather than being merged with every other
 * id-less row. */
function groupByUtterance(rows) {
  const groups = new Map();
  rows.forEach((u, i) => {
    const key = u.utteranceKey ?? `#${i}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(u);
    else groups.set(key, [u]);
  });
  return groups;
}

/** How many utterances these chunk rows came from. */
function countUtterances(rows) {
  return groupByUtterance(rows).size;
}

/** [utterances with NO first chunk here, utterances with MORE THAN ONE].
 *
 * Neither is hypothetical and neither shows up in the numbers themselves.
 *
 * No first chunk: the row carrying `isFirstChunk` was cancelled by a barge-in,
 * failed at the provider, or never reached the log (barge-in also drops units
 * still queued inside the direction, and those are never written). Such an
 * utterance is counted but contributes ZERO samples to every utterance-basis
 * stage — which is what makes an `n` below the utterance count look like a
 * missing metric when it is nothing of the sort.
 *
 * More than one: a log written before the key was made unique per utterance,
 * where two utterances whose speech starts fell in the same millisecond shared
 * a key. Such a pair is ONE line in the counts and TWO samples above. */
function groupingAnomalies(rows) {
  let missing = 0;
  let excess = 0;
  for (const group of groupByUtterance(rows).values()) {
    const firsts = group.filter((u) => u.firstChunk).length;
    if (firsts === 0) missing += 1;
    else if (firsts > 1) excess += 1;
  }
  return [missing, excess];
}

// Which rows may enter a percentile.
//
//   "utterance"  the metric is anchored on a timestamp belonging to the whole
//                utterance (speech start, first partial), so it means what its
//                name says only on the FIRST chunk. On the 2nd chunk
//                speech -> 1st audio measures "how long until the 2nd chunk was
//                spoken" — a different question that must not share a
//                percentile with the first. One sample per utterance.
//   "chunk"      the metric measures work done for this chunk alone (one MT
//                call, one synthesis). One sample per chunk, as before.
const UTTERANCE = "utterance";
const CHUNK = "chunk";

function stageStats(utterances) {
  const stages = [
    // Labels name what the agent actually measures, so a number here can be
    // traced back to one key in the JSONL without guessing.
    ["stt", "speech -> 1st partial", UTTERANCE],
    ["chunk", "1st partial -> commit", UTTERANCE],
    ["mt", "commit -> MT done", CHUNK],
    ["tts", "MT done -> 1st audio", CHUNK],
    ["e2e", "speech -> 1st audio", UTTERANCE],
  ];
  return stages.map(([key, label, basis]) => {
    const rows = basis === UTTERANCE ? utterances.filter((u) => u.firstChunk) : utterances;
    const vals = rows.map((u) => u.latency[key]).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    return {
      key,
      label,
      basis,
      n: vals.length,
      p50: pct(vals, 50),
      p90: pct(vals, 90),
      p99: pct(vals, 99),
      max: vals.length ? vals[vals.length - 1] : undefined,
    };
  });
}

const ms = (v) => (Number.isFinite(v) ? `${Math.round(v)} ms` : "—");

// ------------------------------------------------------------------ printing
function langBadge(u) {
  return `${u.srcLang}→${u.dstLang}`;
}

function shortTs(ts) {
  if (ts === null || ts === undefined) return "";
  const d = typeof ts === "number" ? new Date(ts < 1e12 ? ts * 1000 : ts) : new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toTimeString().slice(0, 8);
}

function printUtterance(u, index) {
  const flagged = u.verdict === "wrong";
  const marker = flagged ? c("red", "WRONG") : u.verdict === "ok" ? c("green", "  ok ") : c("dim", "  ·  ");
  const head =
    `${c("dim", String(index).padStart(4))} ${marker} ` +
    `${c("cyan", langBadge(u))} ` +
    `${c("dim", `${u.speakerId} ${u.speakerGender}→${u.listenerGender} ${u.tone}`)}` +
    // On a later chunk this is "speech start -> THIS chunk's audio", not the
    // delay the listener perceived, so it is marked rather than shown bare.
    `${u.latency.e2e !== undefined ? ` ${c("dim", u.firstChunk ? ms(u.latency.e2e) : `${ms(u.latency.e2e)} (to this chunk)`)}` : ""}` +
    `${u.ts ? ` ${c("dim", shortTs(u.ts))}` : ""}`;
  console.log(head);
  // Stacked rather than columnar on purpose: one of these two lines is Hebrew,
  // and a terminal renders RTL text inside a fixed-width column by reordering
  // it across the column boundary. Full-width lines stay readable.
  console.log(`       ${c("dim", "src")}  ${u.source || c("dim", "(empty)")}`);
  console.log(`       ${c("bold", "dst")}  ${flagged ? c("red", u.translation) : u.translation}`);
  if (u.correction) {
    console.log(`       ${c("yellow", "fix")}  ${c("yellow", u.correction)}`);
  }
  if (u.verdictNote) {
    console.log(`       ${c("dim", "note")} ${c("dim", u.verdictNote)}`);
  }
  if (!u.id) {
    console.log(`       ${c("yellow", "warn")} ${c("dim", `line ${u._line} has no utterance id — no verdict can ever attach to it`)}`);
  }
}

function printReport(callId, path, data) {
  const { utterances, malformed, orphanVerdicts } = data;

  const flagged = utterances.filter((u) => u.verdict === "wrong");
  const okd = utterances.filter((u) => u.verdict === "ok");
  const unjudged = utterances.length - flagged.length - okd.length;

  const byDirection = new Map();
  for (const u of utterances) {
    const k = langBadge(u);
    const e = byDirection.get(k) ?? { rows: [], wrong: 0, ok: 0 };
    e.rows.push(u);
    if (u.verdict === "wrong") e.wrong += 1;
    if (u.verdict === "ok") e.ok += 1;
    byDirection.set(k, e);
  }

  const prov = utterances.length ? utterances[utterances.length - 1].providers : {};
  const provTriple = `stt=${prov.stt ?? "?"} mt=${prov.mt ?? "?"} tts=${prov.tts ?? "?"}`;
  const isMock = ["stt", "mt", "tts"].every((k) => prov[k] === "mock");

  const line = "─".repeat(76);
  console.log(`\n${c("bold", `SpeakEasy session report — ${callId}`)}`);
  console.log(c("dim", path));
  console.log(line);

  // ------------------------------------------------------------ the headline
  // Both counts, always: a chunk count read as an utterance count is what made
  // every latency percentile in this repo wrong. A verdict is attached to a
  // chunk, so the judged numbers below are chunk numbers.
  const nUtterances = countUtterances(utterances);
  console.log(
    `  utterances ${c("bold", nUtterances)}` +
      `   chunks ${c("bold", utterances.length)}` +
      `   flagged wrong ${flagged.length ? c("red", flagged.length) : c("green", "0")}` +
      `   confirmed ok ${okd.length ? c("green", okd.length) : "0"}` +
      `   unjudged ${c("dim", unjudged)}`
  );
  if (utterances.length > 0 && flagged.length + okd.length > 0) {
    const judged = flagged.length + okd.length;
    const acc = ((okd.length / judged) * 100).toFixed(0);
    console.log(`  judged ${judged}/${utterances.length} chunks   ${c("bold", `${acc}%`)} of judged translations accepted`);
  }
  console.log(`  providers  ${provTriple}${isMock ? c("yellow", "   <- MOCK: mechanics only, translation quality here means nothing") : ""}`);

  for (const [dir, e] of byDirection) {
    console.log(
      `  ${c("cyan", dir.padEnd(8))} ${String(countUtterances(e.rows)).padStart(4)} utterances` +
        ` in ${String(e.rows.length).padStart(4)} chunks` +
        `${e.wrong ? c("red", `   ${e.wrong} wrong`) : ""}${e.ok ? c("green", `   ${e.ok} ok`) : ""}`
    );
  }

  // ---------------------------------------------------------------- latency
  console.log(`\n${c("bold", "  latency")}   ${c("dim", `nearest-rank percentiles over ${nUtterances} utterance(s) / ${utterances.length} chunk(s); n is the sample count`)}`);
  console.log(`  ${c("dim", "stage".padEnd(STAGE_COL) + "basis".padEnd(11) + "n".padStart(5) + "p50".padStart(10) + "p90".padStart(10) + "p99".padStart(10) + "max".padStart(10))}`);
  for (const s of stageStats(utterances)) {
    const row =
      `  ${s.label.padEnd(STAGE_COL)}${s.basis.padEnd(11)}${String(s.n).padStart(5)}` +
      `${ms(s.p50).padStart(10)}${ms(s.p90).padStart(10)}${ms(s.p99).padStart(10)}${ms(s.max).padStart(10)}`;
    console.log(s.key === "e2e" ? c("bold", row) : row);
  }
  console.log(
    c("dim", `  basis=${UTTERANCE}: ONE sample per utterance, from its FIRST committed chunk only — these`) +
      c("dim", "\n             stages are anchored on speech start, so on later chunks they measure something else")
  );
  console.log(c("dim", `  basis=${CHUNK}: one sample per committed chunk (one MT call, one synthesis)`));
  const [noFirstChunk, duplicateFirstChunk] = groupingAnomalies(utterances);
  if (noFirstChunk) {
    // Printed beside the n it explains: an utterance whose first chunk is gone
    // is counted above and sampled nowhere, and nothing else on this screen
    // would tell the reader that.
    console.log(
      c("yellow", `  NOTE: ${noFirstChunk} of ${nUtterances} utterance(s) carry no first chunk — a barge-in or a`) +
        c("yellow", `\n        provider error took that row — so they contribute NOTHING to the ${UTTERANCE}-basis`) +
        c("yellow", "\n        rows above. That is why those n can be lower than the utterance count.")
    );
  }
  if (duplicateFirstChunk) {
    console.log(
      c("yellow", `  NOTE: ${duplicateFirstChunk} utteranceKey(s) carry MORE THAN ONE first chunk. This log predates`) +
        c("yellow", "\n        the unique key: two utterances whose speech starts fell in the same millisecond") +
        c("yellow", `\n        share one key, so they are 1 utterance in the counts and 2 samples in the ${UTTERANCE} rows.`)
    );
  }
  if (!utterances.some((u) => u.hasKey)) {
    console.log(
      c("yellow", "  NOTE: this log carries no utteranceKey — it predates the per-utterance key, so every") +
        c("yellow", "\n        chunk is counted as its own utterance, exactly as this tool always did.")
    );
  }
  // The two readers share a basis but NOT an eligibility set, and only one of
  // them says so. A founder who runs both on a call with a barge-in gets
  // different n from each, and has to be told which difference is which.
  const undelivered = utterances.filter((u) => u.cancelled || u.error).length;
  if (undelivered) {
    console.log(
      c("yellow", `  NOTE: ${undelivered} of ${utterances.length} chunk(s) were cancelled or errored, and every number`) +
        c("yellow", "\n        above INCLUDES them — this tool always has. agent/scripts/review_call.py drops") +
        c("yellow", "\n        them, so the two readers will report different n for this call. Neither is a bug;") +
        c("yellow", "\n        review_call.py answers 'what did the listener get', this one 'what did the pipeline do'.")
    );
  }
  const e2e = stageStats(utterances).find((s) => s.key === "e2e");
  if (e2e && e2e.n === 0) {
    // "The writer is not emitting it" is only one of the two reasons this n can
    // be zero, and it used to be printed for both. The other is that every
    // first-chunk row is gone, which is a fact about THIS call, not about the
    // writer, and blaming the writer for it sends the reader to the wrong file.
    // The writer is only to blame if NO row anywhere carries the value. If some
    // later chunk has it and no first chunk does, the writer is fine and the
    // basis is what emptied the sample — pointing at the writer there sends the
    // reader to the wrong file.
    const writerEmitsE2e = utterances.some((u) => Number.isFinite(u.latency.e2e));
    console.log(
      c(
        "dim",
        writerEmitsE2e
          ? "  (no end-to-end metric on any FIRST chunk — the writer emits it, but every first chunk of this call was cancelled, errored or never reached audio)"
          : "  (no end-to-end metric in this log — the writer is not emitting e2e_ms)"
      )
    );
  }

  // ------------------------------------------------------- flagged, in full
  if (flagged.length > 0) {
    console.log(`\n${line}\n${c("red", c("bold", `  FLAGGED WRONG — ${flagged.length}`))}   ${c("dim", "these are the labelled data; everything else is telemetry")}\n`);
    flagged.forEach((u) => printUtterance(u, utterances.indexOf(u) + 1));
    if (flags.has("--flagged")) {
      console.log(line);
      return;
    }
  } else if (flags.has("--flagged")) {
    console.log(`\n${c("green", "  nothing was flagged wrong in this call.")}\n`);
    return;
  }

  // ---------------------------------------------------------- the transcript
  console.log(`\n${line}\n${c("bold", "  TRANSCRIPT")}\n`);
  utterances.forEach((u, i) => printUtterance(u, i + 1));

  console.log(line);
  if (malformed > 0) {
    console.log(c("yellow", `  ${malformed} unparseable line(s) skipped — a writer crashed mid-line, or the file is not JSONL`));
  }
  if (orphanVerdicts > 0) {
    console.log(
      c("yellow", `  ${orphanVerdicts} verdict(s) reference an utterance id that is not in this file`) +
        c("dim", " — a judge flagged something from a different call, or ids do not match")
    );
  }
  console.log("");
}

function jsonReport(callId, path, data) {
  const { utterances, malformed, orphanVerdicts } = data;
  const flagged = utterances.filter((u) => u.verdict === "wrong");
  const okd = utterances.filter((u) => u.verdict === "ok");
  return {
    callId,
    path,
    counts: {
      // utterances vs chunks: never one number. See stageStats.
      utterances: countUtterances(utterances),
      chunks: utterances.length,
      // Without these two an `n` that disagrees with `utterances` cannot be
      // explained from the JSON alone. See groupingAnomalies.
      utterancesWithoutFirstChunk: groupingAnomalies(utterances)[0],
      utterancesWithDuplicateFirstChunk: groupingAnomalies(utterances)[1],
      // Included in every latency number in this file, and excluded from every
      // latency number in agent/scripts/review_call.py. Published so a diff of
      // the two JSONs is explainable instead of alarming.
      cancelledOrErroredChunks: utterances.filter((u) => u.cancelled || u.error).length,
      flaggedWrong: flagged.length,
      confirmedOk: okd.length,
      unjudged: utterances.length - flagged.length - okd.length,
      malformedLines: malformed,
      orphanVerdicts,
    },
    providers: utterances.length ? utterances[utterances.length - 1].providers : null,
    latency: Object.fromEntries(stageStats(utterances).map((s) => [s.key, { basis: s.basis, n: s.n, p50: s.p50 ?? null, p90: s.p90 ?? null, p99: s.p99 ?? null, max: s.max ?? null }])),
    flagged: flagged.map((u) => ({
      id: u.id,
      direction: `${u.srcLang}->${u.dstLang}`,
      speakerId: u.speakerId,
      speakerGender: u.speakerGender,
      listenerGender: u.listenerGender,
      tone: u.tone,
      source: u.source,
      translation: u.translation,
      correction: u.correction,
    })),
  };
}

// -------------------------------------------------------------------- main
const calls = listCalls();

if (positional.length === 0 || flags.has("--list")) {
  if (calls.length === 0) {
    console.log(
      `${c("yellow", "no call logs found in")} ${DIR}\n` +
        `${c("dim", "Make a TRANSLATED call (u_alex ru <-> u_noa he) with EVAL_LOG_ENABLED=true and one\n")}` +
        `${c("dim", "file per call appears here. Mock providers are enough — the judging flow is\n")}` +
        `${c("dim", "fully testable offline.")}`
    );
    process.exit(0);
  }
  console.log(`\n${c("bold", "calls in")} ${DIR}\n`);
  for (const call of calls) {
    const data = loadCall(call.path);
    const wrong = data.utterances.filter((u) => u.verdict === "wrong").length;
    console.log(
      `  ${c("bold", call.id.padEnd(18))} ` +
        `${String(countUtterances(data.utterances)).padStart(4)} utterances` +
        `${c("dim", ` in ${String(data.utterances.length).padStart(4)} chunks`)}` +
        `${wrong ? c("red", `   ${wrong} flagged`) : c("dim", "   0 flagged")}` +
        `   ${c("dim", new Date(call.mtime).toLocaleString())}`
    );
  }
  console.log(`\n${c("dim", "  npm run review -- latest        # the top one")}`);
  console.log(`${c("dim", "  npm run review -- <callId>      # a specific call")}`);
  console.log(`${c("dim", "  npm run review -- latest --flagged   # only what a judge marked wrong")}\n`);
  process.exit(0);
}

const requested = positional[0];
let target;
if (requested === "latest") {
  if (calls.length === 0) fail(`no call logs in ${DIR} — nothing to review`);
  target = calls[0];
} else {
  const id = requested.replace(/\.jsonl$/, "");
  target = calls.find((x) => x.id === id);
  if (!target) {
    const path = existsSync(requested) ? requested : join(DIR, `${id}.jsonl`);
    if (!existsSync(path)) {
      fail(
        `no log for "${requested}" in ${DIR}\n` +
          `        available: ${calls.length ? calls.map((x) => x.id).join(", ") : "(none)"}`
      );
    }
    target = { id, path, mtime: statSync(path).mtimeMs };
  }
}

const data = loadCall(target.path);

if (flags.has("--json")) {
  console.log(JSON.stringify(jsonReport(target.id, target.path, data), null, 2));
} else {
  printReport(target.id, target.path, data);
}
