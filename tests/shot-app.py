#!/usr/bin/env python3
"""Opens the Evoked app window in the headless test shell, with a session running, and saves screenshots."""
import pathlib
import subprocess
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import run as R

rig = R.Rig(sys.argv[1] if len(sys.argv) > 1 else "1280x1000")
rig.start()
try:
    ext = rig.tmp / "home/.local/share/gnome-shell/extensions" / R.UUID
    p = subprocess.Popen(["gjs", "-m", str(ext / "app.js")], env=rig.env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    rig.procs.append(p)
    time.sleep(5)
    if p.poll() is not None:
        print(p.stdout.read()[-3000:])
        raise SystemExit("the app exited")
    rig.shot("app-idle")
    rig.cmd("Room", "on")
    rig.cmd("Brain", "on")
    phones = [rig.phone(f"p{i}") for i in range(9)]
    for ph in phones:
        ph.say("hi")
    time.sleep(2.5)
    rig.cmd("Join", "off")
    rig.levels.write_text("-25\n")
    for ph in phones[:5]:
        ph.say("tap")
    time.sleep(1.2)
    rig.shot("app-session")
    print("shell errors:", rig.errors()[:3])
    import os
    os.set_blocking(p.stdout.fileno(), False)
    try:
        print("app output:", (p.stdout.read() or "")[-1500:])
    except TypeError:
        print("app output: (none)")
finally:
    rig.stop()
