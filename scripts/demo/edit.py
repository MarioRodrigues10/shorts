"""Turn the raw recording into docs/media/demo.{mp4,webp}: speed up the waits for transcription
and export (between the marks record.py wrote).  Usage: edit.py WORKDIR OUTDIR"""
import json
import subprocess
import sys

work, outdir = sys.argv[1], sys.argv[2]
info = json.load(open(f"{work}/marks.json"))
m = dict(info["marks"])
# the recording starts a little after the page is created; align marks to video time using its end
dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", info["video"]],
                           capture_output=True, text=True, check=True).stdout)
m = {k: t - (m["close"] - dur) for k, t in m.items()}

segs = [  # (start, end, speed)
    (m["home"], m["transcribing"] + 1, 1),
    (m["transcribing"] + 1, m["captions"] - 0.4, 5),
    (m["captions"] - 0.4, m["exporting"] + 0.3, 1),
    (m["exporting"] + 0.3, m["done"] - 0.8, 4),
    (m["done"] - 0.8, m["end"], 1),
]
fc = "".join(f"[0:v]trim={a:.2f}:{b:.2f},setpts=(PTS-STARTPTS)/{sp}[s{i}];" for i, (a, b, sp) in enumerate(segs))
fc += "".join(f"[s{i}]" for i in range(len(segs))) + f"concat=n={len(segs)}:v=1:a=0,fps=30[v]"

def ff(*args):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True)

ff("-i", info["video"], "-filter_complex", fc, "-map", "[v]", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", f"{work}/edit.mp4")
ff("-i", f"{work}/edit.mp4", "-vf", "scale=1280:-2:flags=lanczos", "-c:v", "libx264", "-crf", "28", "-preset", "veryslow",
   "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", f"{outdir}/demo.mp4")
for theme in ("light", "dark"):
    ff("-i", f"{work}/shot-{theme}.png", "-c:v", "libwebp", "-quality", "88", f"{outdir}/editor-{theme}.webp")
ff("-i", f"{work}/edit.mp4", "-vf", "fps=12,scale=960:-1:flags=lanczos", "-c:v", "libwebp_anim", "-lossless", "0",
   "-q:v", "50", "-compression_level", "6", "-loop", "0", f"{outdir}/demo.webp")
