# Valentina Smart Turn pilot

The production sidecar receives OpenAI Realtime SIP events. It does not receive the caller's raw audio over its control WebSocket. This pilot runs on local WAV files and needs no API credentials. The current sidecar uses server VAD with an 800 ms silence setting. A fixed set of labeled pauses can screen Smart Turn for obvious failures before investing in a separate test media path.

## Run locally

Use Python 3.11 or newer. Keep the model, recordings and manifest outside the repository.

```sh
python -m venv /tmp/valentina-pilot-venv
/tmp/valentina-pilot-venv/bin/pip install -r pilots/smart-turn/requirements.txt
curl -fL https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/f766f81/smart-turn-v3.2-cpu.onnx -o /tmp/smart-turn-v3.2-cpu.onnx
/tmp/valentina-pilot-venv/bin/python pilots/smart-turn/evaluate.py /tmp/smart-turn-v3.2-cpu.onnx /path/to/cases.json
```

Each fixture is a mono 16-bit PCM WAV at 8 or 16 kHz. For example, given a practice recording with a pause inside a correction and a second pause at its end:

```json
[
  {"id":"cita-pausa","wav":"cita.wav","end_ms":2300,"complete":false},
  {"id":"cita-fin","wav":"cita.wav","end_ms":4800,"complete":true}
]
```

Set each cutoff from the actual recording. To approximate candidate points for the current configuration, label clips through 800 ms of silence when the pause lasts that long. Suggested scripts include “Ponme la cita el jueves… espérate, el viernes”, a name with a pause between surnames, and a completed request with Spanglish or car noise. Use consenting internal speakers and fictional data.

The evaluator reports premature decisions, missed ends and CPU processing time for feature extraction plus inference. It does not simulate OpenAI's VAD, measure end-to-end response time or test interruption playback. A later isolated call test should compare the current SIP configuration and native semantic VAD first, and use a separate media stream for Smart Turn if the offline results warrant it. Measure response and interruption at the listener's end and compare compute cost.

Model and preprocessing reference: [Pipecat Smart Turn](https://github.com/pipecat-ai/smart-turn), BSD-2-Clause. Weights: [Smart Turn v3.2 CPU](https://huggingface.co/pipecat-ai/smart-turn-v3/tree/f766f81).
