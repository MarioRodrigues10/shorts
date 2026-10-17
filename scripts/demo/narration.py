"""Synthesize the demo narration with Piper (local TTS). Pauses and a false start are deliberate,
so Remove silences and Cut retakes have something to do.  Usage: narration.py VOICE.onnx OUT.wav"""
import sys
import wave

from piper import PiperVoice, SynthesisConfig

LINES = [
    ("This is Shorts.", 0.4),
    ("A video editor that runs on", 0.9),  # false start
    ("A video editor for short form content that runs entirely on Linux.", 1.6),
    ("You get captions, cuts and exports without leaving the app.", 1.2),
    ("And everything stays on your own machine.", 0.8),
]

voice = PiperVoice.load(sys.argv[1])
cfg = SynthesisConfig(noise_scale=0.0, noise_w_scale=0.0)  # deterministic, so every run transcribes the same
out = wave.open(sys.argv[2], "wb")
first = True
for text, pause in LINES:
    for ch in voice.synthesize(text, cfg):
        if first:
            out.setnchannels(ch.sample_channels)
            out.setsampwidth(ch.sample_width)
            out.setframerate(ch.sample_rate)
            first = False
        out.writeframes(ch.audio_int16_bytes)
    out.writeframes(b"\0" * int(out.getframerate() * pause) * out.getsampwidth())
out.close()
