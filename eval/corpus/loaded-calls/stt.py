import json
from pathlib import Path
import mlx_whisper
ROOT = Path("/Users/davidov/SameVoice-corpus/loaded-calls")
out = {}
for wav in sorted(ROOT.glob("call-*.wav")):
    r = mlx_whisper.transcribe(str(wav), path_or_hf_repo="mlx-community/whisper-large-v3-turbo",
                               language="ru", verbose=False)
    segs = [s["text"].strip() for s in r["segments"] if s["text"].strip()]
    out[wav.stem] = segs
    print(wav.stem, "->", len(segs), "сегментов")
json.dump(out, open(ROOT / "transcripts.json", "w"), ensure_ascii=False, indent=1)
print("готово")
