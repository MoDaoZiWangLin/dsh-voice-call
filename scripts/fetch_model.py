# Download + extract sherpa-onnx offline ASR models into ../models.
# Default model: SenseVoice (best Chinese accuracy, punctuation-aware, int8).
# Usage:
#   python scripts/fetch_model.py                # sense-voice (default)
#   python scripts/fetch_model.py --model zipformer   # bilingual zh-en zipformer
#   python scripts/fetch_model.py --model all         # both
import argparse, io, sys, tarfile, urllib.request, pathlib

MODELS = {
    # SenseVoice (zh/en/ja/ko/yue) — int8, strong Chinese + punctuation (ITN)
    "sense-voice": {
        "name": "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17",
        "probe": "model.onnx",
    },
    # bilingual zh-en zipformer (fallback / English-friendly)
    "zipformer": {
        "name": "sherpa-onnx-zipformer-zh-en-2023-11-22",
        "probe": "tokens.txt",
    },
}

DEST = pathlib.Path(__file__).resolve().parent.parent / "models"
DEST.mkdir(parents=True, exist_ok=True)

URL_PREFIX = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"


def fetch(name):
    meta = MODELS[name]
    model = meta["name"]
    url = f"{URL_PREFIX}/{model}.tar.bz2"
    out_dir = DEST / model
    if out_dir.exists() and (out_dir / meta["probe"]).exists():
        print("already present:", out_dir)
        return
    print("downloading", url)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        total = int(r.headers.get("Content-Length", 0))
        data = io.BytesIO()
        done = 0
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            data.write(chunk)
            done += len(chunk)
            if total:
                print(f"  {done/1e6:.1f}/{total/1e6:.1f} MB", end="\r")
    print()
    print("extracting ...")
    data.seek(0)
    with tarfile.open(fileobj=data, mode="r:bz2") as tf:
        tf.extractall(DEST)
    print("done ->", out_dir)
    print("files:", sorted(p.name for p in out_dir.iterdir()))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=[*MODELS.keys(), "all"], default="sense-voice")
    args = parser.parse_args()
    if args.model == "all":
        for name in MODELS:
            fetch(name)
    else:
        fetch(args.model)
