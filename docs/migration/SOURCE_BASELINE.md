# SpeakEasy source migration

This branch imports the tracked source baseline from the local SpeakEasy project (`/Users/davidov/SpeakEasy`) into the private SameVoice repository.

Migration rules:

- source code, configuration examples, tests, evaluation scripts, lockfiles and documentation are preserved;
- real secrets are not imported;
- tracked WAV evaluation artifacts are intentionally excluded from Git and should live in persistent/object storage rather than the source repository;
- the original Stage 0 root README is preserved as `docs/migration/SPEAKEASY_STAGE0_README.md`;
- the SameVoice R&D README and RunPod plan remain the repository-level orientation documents.

The migration is a baseline import only. GPU-specific restructuring and the RunPod image are handled after the baseline is verified.
