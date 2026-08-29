# SameVoice RunPod container

This directory contains the runtime scaffolding for the **R&D** Pod. It does not download model weights and it does not deploy anything by itself.

## What is already wired

The image builds the current SpeakEasy/SameVoice application and starts three existing services in one container:

- web preview on `5173`;
- Fastify backend on `8787`;
- Python translation agent on `8788`.

The browser is compiled with `VITE_BACKEND_URL=/`, so `/api` and `/healthz` stay same-origin and Vite proxies them to the backend. The agent remains loopback-only.

Persistent runtime data is redirected to `/workspace`:

- `/workspace/models`
- `/workspace/checkpoints`
- `/workspace/datasets`
- `/workspace/benchmarks`
- `/workspace/hf-cache`
- `/workspace/logs/archive`
- `/workspace/logs/calls`

## GPU layout

The intended 2 x RTX 4090 layout is service-parallel, not model-parallel:

- GPU 0: acoustic scout, rolling predictor, local/speculative MT;
- GPU 1: local TTS / speculative TTS.

The optional GPU engines are exposed as command hooks in `docker/entrypoint.sh`. They stay blank until the actual model services are committed. This avoids shipping fake placeholder servers while preserving the final process topology.

## Reproducible build

Backend, web and Python dependencies are committed with lockfiles. The image uses `npm ci` and `uv sync --frozen`, and `uv` itself is pinned in `Dockerfile.runpod`.

Local build command:

```bash
docker build -f Dockerfile.runpod -t samevoice-rnd:local .
```

`.github/workflows/container-smoke.yml` performs the same build on GitHub and then boots the resulting CUDA-based image with mock providers. This does not require an NVIDIA GPU because the optional local GPU engines are not started during packaging validation. The first build-and-boot check passed.

## Keyless mock smoke run

A mock-only boot can be tested without vendor keys:

```bash
docker run --rm \
  -e SAMEVOICE_BOOTSTRAP_MOCK_ENV=1 \
  -p 5173:5173 \
  samevoice-rnd:local
```

That explicitly copies `.env.example` to the disposable container. It must **not** be enabled on a real R&D Pod that uses LiveKit/vendor credentials.

## Real RunPod runtime

Use RunPod Secrets/environment for credentials. Do not bake `.env`, API keys, user audio, voice embeddings, datasets or model weights into the image.

The persistent volume should be mounted at `/workspace`. On first GPU boot run:

```bash
/opt/samevoice/scripts/runpod-preflight.sh
```

It verifies GPU visibility, expected GPU count, `/workspace` write access, disk capacity, runtimes and the GPU split.

`docker/runpod.env.example` contains only non-secret deployment defaults and the future local-engine hooks.

## LiveKit

The container does **not** install an unpinned LiveKit server binary. Use the existing configured LiveKit transport (for R&D normally LiveKit Cloud or another explicitly managed SFU). This keeps the image reproducible and prevents a `latest` LiveKit release from silently changing benchmark conditions.

## Health

Docker health is green only when all three current services answer:

- `http://127.0.0.1:8787/healthz`
- `http://127.0.0.1:8788/healthz`
- `http://127.0.0.1:5173/`

If one long-running process exits, the entrypoint exits too instead of leaving a half-working benchmark Pod alive.

## Not done yet

The container is packaging-ready, not model-ready. `runpod` STT/MT/TTS adapters in the current agent are still Stage-1 stubs, and the acoustic scout / rolling predictor services have not yet been implemented. Do not start paying for the 2-GPU Pod until those local service contracts and model choices are prepared.
