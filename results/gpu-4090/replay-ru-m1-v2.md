# SameVoice predictor + acoustic replay benchmark

**Verdict:** `REJECT` — measured failure is large enough that this configuration should not advance

Samples: **32**. Target gate window: **150 ms**.

## Predictor (linguistic stage only)

| Lang | n | Top-20 | Top-10 | Top-5 | Top-3 | Top-1 |
|---|---:|---:|---:|---:|---:|---:|
| ru | 32 | 3.1% | 0.0% | 0.0% | 0.0% | 0.0% |
| he | — | — | — | — | — | — |

## Acoustic pruning — every language × window

| Lang | Window | Top-10 | Top-5 | Top-3 | Top-1 | vanished | errored | harmed | Lead vs STT p50 | Queue p95 | Pruner RTT p95 | n (eligible/all) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ru | 50 ms | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% (n=1) | — | 0.1 ms | 7.9 ms | 1/32 * |
| ru | 100 ms | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% (n=1) | — | 0.1 ms | 7.4 ms | 1/32 * |
| ru | 150 ms **(gate window)** | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% (n=1) | — | 0.1 ms | 7.6 ms | 1/32 * |
| ru | 200 ms | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% (n=1) | — | 0.1 ms | 6.9 ms | 1/32 * |
| ru | 250 ms | 100.0% | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 0.0% (n=1) | — | 0.1 ms | 5.8 ms | 1/32 * |
| he | 50 ms | — | — | — | — | — | — | — | — | — | — | — |
| he | 100 ms | — | — | — | — | — | — | — | — | — | — | — |
| he | 150 ms **(gate window)** | — | — | — | — | — | — | — | — | — | — | — |
| he | 200 ms | — | — | — | — | — | — | — | — | — | — | — |
| he | 250 ms | — | — | — | — | — | — | — | — | — | — | — |

Every rate in this table is conditional on the predictor having supplied the truth word; predictor misses are counted in the predictor table above, never charged to acoustics.

- **Top-K** — conditional retention: truth word still inside Top-K after acoustics.
- **vanished** — the pruner answered and its ranking had no rank for the truth word.
- **errored** — the pruner never answered for this window: HTTP failure, timeout, or a clip too short for the window. Nothing is known about the scorer here, so this is **not** damage; it is reported separately precisely because an errored row looks identical to a vanished one in the raw artifact.
- **harmed** — acoustics made the rank worse than the predictor's; denominator is only the samples where the truth word survived, printed as `n=` in the cell.
- **Lead vs STT p50** — cold-parallel lead, i.e. the predictor is pessimistically assumed to start at word onset.
- **Queue p95** — time a prune request spent waiting for the card before any model ran. `—` means the pruner did not publish `queue_wait_ms`, which is not the same claim as zero.
- **n** — predictor-eligible samples / all replayed samples for that language and window.
- `*` — fewer than 30 predictor-eligible samples. The gate applies `minSamplesPerLanguage` to the replayed and round-trip counts, not to this one, so a row can carry the marker and still be inside the gate: it means the rates in it rest on too little data to read, not that the gate failed. The row is printed rather than hidden, but its rates decide nothing.

## Gate checks

- **PASS** `ru` minimum predictor samples: actual=32 >= 30.0
- **FAIL** `ru` predictor Top-20 recall: actual=0.0312 >= 0.95
- **PASS** `ru` 150 ms acoustic samples: actual=32 >= 30.0
- **PASS** `ru` 150 ms pruner round-trip samples: actual=32 >= 30.0
- **FAIL** `ru` 150 ms conditional Top-5 retention: actual=0.0 >= 0.95
- **FAIL** `ru` 150 ms conditional Top-3 retention: actual=0.0 >= 0.88
- **FAIL** `ru` 150 ms Top-5 miss rate (vanished + errored + demoted below 5): actual=1.0 <= 0.05
- **FAIL** `ru` 150 ms cold-parallel lead positive rate: actual=None >= 0.75
- **FAIL** `ru` 150 ms cold-parallel lead p50: actual=None >= 150.0
- **PASS** `ru` 150 ms pruner round-trip p95: actual=7.6 <= 220.0
- **FAIL** `he` minimum predictor samples: actual=None >= 30.0
- **FAIL** `he` predictor Top-20 recall: actual=None >= 0.95
- **FAIL** `he` 150 ms acoustic samples: actual=None >= 30.0
- **FAIL** `he` 150 ms pruner round-trip samples: actual=None >= 30.0
- **FAIL** `he` 150 ms conditional Top-5 retention: actual=None >= 0.95
- **FAIL** `he` 150 ms conditional Top-3 retention: actual=None >= 0.88
- **FAIL** `he` 150 ms Top-5 miss rate (vanished + errored + demoted below 5): actual=None <= 0.05
- **FAIL** `he` 150 ms cold-parallel lead positive rate: actual=None >= 0.75
- **FAIL** `he` 150 ms cold-parallel lead p50: actual=None >= 150.0
- **FAIL** `he` 150 ms pruner round-trip p95: actual=None <= 220.0

> PROMOTE only authorizes the next soft-realtime R&D stage. It does not enable hard pruning or audible speculative commit.
