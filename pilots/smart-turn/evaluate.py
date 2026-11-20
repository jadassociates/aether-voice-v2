"""Evaluate labeled turn candidates from mono 16-bit PCM WAV recordings."""
import argparse
import hashlib
import json
from pathlib import Path
from time import perf_counter
import wave

import numpy as np
import onnxruntime as ort
from scipy.signal import resample_poly
from transformers import WhisperFeatureExtractor

MODEL_SHA256 = "2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f"
TARGET_RATE = 16_000
WINDOW_SECONDS = 8


def read_candidate(path, end_ms):
    with wave.open(str(path), "rb") as wav:
        rate = wav.getframerate()
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or rate not in (8000, 16000):
            raise ValueError(f"{path}: expected mono 16-bit PCM WAV at 8 or 16 kHz")
        end = round(end_ms * rate / 1000)
        if not 0 < end <= wav.getnframes():
            raise ValueError(f"{path}: end_ms falls outside recording")
        start = max(0, end - WINDOW_SECONDS * rate)
        wav.setpos(start)
        samples = np.frombuffer(wav.readframes(end - start), dtype="<i2").astype(np.float32)
    samples /= 32768
    return resample_poly(samples, 2, 1) if rate == 8000 else samples


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model", type=Path)
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()
    with args.model.open("rb") as model:
        if hashlib.file_digest(model, "sha256").hexdigest() != MODEL_SHA256:
            parser.error("expected the pinned Pipecat Smart Turn v3.2 CPU ONNX file")
    cases = json.loads(args.manifest.read_text())
    if not cases or any(type(case["complete"]) is not bool for case in cases):
        parser.error("manifest must contain cases with boolean complete labels")
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(args.model), sess_options=options, providers=["CPUExecutionProvider"])
    extractor = WhisperFeatureExtractor(chunk_length=WINDOW_SECONDS)

    def score(samples):
        features = extractor(
            samples, sampling_rate=TARGET_RATE, return_tensors="np",
            padding="max_length", max_length=WINDOW_SECONDS * TARGET_RATE,
            truncation=True, do_normalize=True,
        ).input_features
        return float(session.run(None, {"input_features": features})[0].item())

    score(np.zeros(TARGET_RATE, dtype=np.float32))
    results = []
    for case in cases:
        audio = read_candidate(args.manifest.parent / case["wav"], case["end_ms"])
        start = perf_counter()
        probability = score(audio)
        processing_ms = (perf_counter() - start) * 1000
        results.append({
            "case": case["id"],
            "expected_complete": case["complete"],
            "predicted_complete": probability > 0.5,
            "probability": round(probability, 4),
            "processing_ms": round(processing_ms, 2),
        })
    print(json.dumps({
        "candidates": results,
        "premature_responses": sum(r["predicted_complete"] and not r["expected_complete"] for r in results),
        "missed_ends": sum(r["expected_complete"] and not r["predicted_complete"] for r in results),
        "median_processing_ms": round(float(np.median([r["processing_ms"] for r in results])), 2),
    }, indent=2))


if __name__ == "__main__":
    main()
