#!/usr/bin/env python3
# Send to Shorts — DaVinci Resolve script.
# Install: copy into ~/.local/share/DaVinciResolve/Fusion/Scripts/Utility/ (Linux),
# then run it from Workspace > Scripts > Send to Shorts.
#
# Renders the current timeline as a high-quality intermediate (DNxHR HQ .mov, PCM audio)
# into "<Shorts upload folder>/From Resolve" and opens it in Shorts for
# captions, effects and the final export.
import json
import os
import re
import shutil
import subprocess
import time
import urllib.request

STUDIO = "http://127.0.0.1:7377"

try:
    resolve  # provided by Resolve's script runner
except NameError:
    resolve = bmd.scriptapp("Resolve")  # noqa: F821


def studio_upload_dir():
    try:
        with urllib.request.urlopen(STUDIO + "/api/config", timeout=3) as r:
            return os.path.expanduser(json.loads(r.read())["upload_dir"])
    except Exception:
        return os.path.expanduser("~/Videos/Shorts/Media")


def pick_codec(project):
    codecs = project.GetRenderCodecs("mov") or {}
    for want in ("DNxHR HQ", "DNxHR SQ", "Apple ProRes 422 HQ", "Apple ProRes 422"):
        for desc, code in codecs.items():
            if desc.strip() == want or (want in desc and "HQX" not in desc and "444" not in desc):
                return code, desc
    return None, None


def main():
    project = resolve.GetProjectManager().GetCurrentProject()
    timeline = project and project.GetCurrentTimeline()
    if not timeline:
        print("Shorts: open a timeline first")
        return
    out_dir = os.path.join(studio_upload_dir(), "From Resolve")
    os.makedirs(out_dir, exist_ok=True)
    name = re.sub(r"[^\w\-. ]+", "_", timeline.GetName()).strip() or "timeline"

    code, desc = pick_codec(project)
    if code:
        project.SetCurrentRenderFormatAndCodec("mov", code)
    project.SetCurrentRenderMode(1)  # single clip
    project.SetRenderSettings({"SelectAllFrames": True, "TargetDir": out_dir, "CustomName": name,
                               "ExportVideo": True, "ExportAudio": True})
    started = time.time()
    job = project.AddRenderJob()
    if not job:
        print("Shorts: could not add a render job (check the Deliver page settings)")
        return
    print(f"Shorts: rendering '{name}' with {desc or 'the current codec'}…")
    project.StartRendering([job])
    while project.IsRenderingInProgress():
        time.sleep(1)
    status = project.GetRenderJobStatus(job) or {}
    project.DeleteRenderJob(job)
    if status.get("JobStatus") not in ("Complete", None):
        print("Shorts: render failed:", status)
        return

    newest = None
    for f in os.listdir(out_dir):
        p = os.path.join(out_dir, f)
        if f.startswith(name) and os.path.getmtime(p) >= started - 1:
            if newest is None or os.path.getmtime(p) > os.path.getmtime(newest):
                newest = p
    if not newest:
        print("Shorts: rendered file not found in", out_dir)
        return
    print("Shorts: opening", newest)
    shorts = shutil.which("shorts") or os.path.expanduser("~/.local/bin/shorts")
    subprocess.Popen(["/usr/bin/env", "python3", shorts, newest], start_new_session=True)


main()
