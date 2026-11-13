#!/usr/bin/env python3
"""End-to-end tests for Evoked, in a real (headless) GNOME Shell.

Starts a private session bus, a local relay server (mosquitto) and `gnome-shell --headless`,
loads the extension from this checkout, and plays an audience with simulated phones. The
room neuron is fed loudness from a script instead of a microphone. Screenshots land in
tests/out/.

    python3 tests/run.py            # or: make test

Needs gnome-shell, gjs, GTK 4 and mosquitto (or set EVOKED_TEST_RELAY to a ws:// relay).
In a container you also need a system D-Bus (`dbus-daemon --system --fork`).
"""
import ast
import json
import os
import pathlib
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
UUID = "evoked@dabane-ghassan.github.io"
SCHEMA = "org.gnome.shell.extensions.evoked"
OUT = ROOT / "tests" / "out"
OBJ = "/io/github/dabane_ghassan/Evoked"
IFACE = "io.github.dabane_ghassan.Evoked"

RIG_JS = """
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
export default class Rig extends Extension {
    enable() { global.context.unsafe_mode = true; }
    disable() { global.context.unsafe_mode = false; }
}
"""

INPUT_JS = """
const Clutter = imports.gi.Clutter; const GLib = imports.gi.GLib;
const backend = Clutter.get_default_backend ? Clutter.get_default_backend() : global.stage.context.get_backend();
const seat = backend.get_default_seat();
const t = global._t = {};
t.v = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
t.k = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
t.now = () => GLib.get_monotonic_time();
t.move = (x, y) => t.v.notify_absolute_motion(t.now(), x, y);
t.click = (b = 1) => { t.v.notify_button(t.now(), b, Clutter.ButtonState.PRESSED); t.v.notify_button(t.now(), b, Clutter.ButtonState.RELEASED); };
t.key = (keyval, down) => t.k.notify_keyval(t.now(), keyval, down ? Clutter.KeyState.PRESSED : Clutter.KeyState.RELEASED);
t.chord = (...keys) => { keys.forEach(k => t.key(k, true)); keys.slice().reverse().forEach(k => t.key(k, false)); };
t.ext = () => Main.extensionManager.lookup('%s').stateObj;
imports.gi.St.Settings.get().uninhibit_animations();
'ready'
""" % UUID


class Phone:
    def __init__(self, proc):
        self.proc = proc
        self.seen = []
        self.buffer = ""

    def say(self, *lines):
        for line in lines:
            self.proc.stdin.write(line + "\n")
        self.proc.stdin.flush()

    def heard(self):
        """Everything the presenter has sent this phone so far: [(channel, message), ...]."""
        fd = self.proc.stdout.fileno()
        while True:
            try:
                chunk = os.read(fd, 65536)
            except BlockingIOError:
                break
            if not chunk:
                break
            self.buffer += chunk.decode()
        *lines, self.buffer = self.buffer.split("\n")
        for line in lines:
            if " " in line:
                channel, payload = line.split(" ", 1)
                try:
                    self.seen.append((channel, json.loads(payload)))
                except ValueError:
                    pass
        return self.seen

    def last(self, channel):
        found = [m for c, m in self.heard() if c == channel]
        return found[-1] if found else None


class Rig:
    def __init__(self, size="1280x800"):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="evoked-test-"))
        self.env = dict(os.environ)
        self.env.update({
            "HOME": str(self.tmp / "home"),
            "XDG_RUNTIME_DIR": str(self.tmp / "run"),
            "XDG_DATA_HOME": str(self.tmp / "home/.local/share"),
            "XDG_CONFIG_HOME": str(self.tmp / "home/.config"),
            "XDG_CACHE_HOME": str(self.tmp / "home/.cache"),
            "XDG_SESSION_TYPE": "wayland", "XDG_CURRENT_DESKTOP": "GNOME",
            "GSETTINGS_BACKEND": "keyfile", "LIBGL_ALWAYS_SOFTWARE": "1",
            "NO_AT_BRIDGE": "1", "GTK_A11Y": "none",
        })
        self.env.pop("DBUS_SESSION_BUS_ADDRESS", None)
        self.env.pop("WAYLAND_DISPLAY", None)
        for d in ("home", "run"):
            (self.tmp / d).mkdir()
        (self.tmp / "run").chmod(0o700)
        self.size = size
        self.procs = []
        self.log = self.tmp / "shell.log"
        self.probe_log = self.tmp / "probe.log"

    # -- session ------------------------------------------------------------

    def start(self):
        exts = self.tmp / "home/.local/share/gnome-shell/extensions"
        (exts / "rig@test").mkdir(parents=True)
        (exts / "rig@test/metadata.json").write_text(json.dumps({
            "uuid": "rig@test", "name": "rig", "description": "lets the tests drive the shell",
            "shell-version": [self.shell_major()]}))
        (exts / "rig@test/extension.js").write_text(RIG_JS)
        shutil.copytree(ROOT / "extension", exts / UUID)
        subprocess.run(["glib-compile-schemas", str(exts / UUID / "schemas")], check=True)

        bus = subprocess.Popen(["dbus-daemon", "--session", "--nofork", "--print-address=1"],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=self.env, text=True)
        self.procs.append(bus)
        self.env["DBUS_SESSION_BUS_ADDRESS"] = bus.stdout.readline().strip()
        gs = ["gsettings", "set", "org.gnome.shell"]
        subprocess.run(gs + ["enabled-extensions", f"['rig@test', '{UUID}']"], env=self.env, check=True)
        subprocess.run(gs + ["disable-user-extensions", "false"], env=self.env, check=True)
        subprocess.run(gs + ["welcome-dialog-last-shown-version", "99.0"], env=self.env, check=True)
        self.before_shell(exts / UUID / "schemas")

        shell = subprocess.Popen(
            ["gnome-shell", "--headless", "--wayland", "--no-x11", "--virtual-monitor", self.size],
            stdout=open(self.log, "w"), stderr=subprocess.STDOUT, env=self.env)
        self.procs.append(shell)
        self.env["WAYLAND_DISPLAY"] = "wayland-0"
        deadline = time.time() + 40
        while time.time() < deadline:
            if shell.poll() is not None:
                raise SystemExit(f"gnome-shell exited early:\n{self.log.read_text()[-3000:]}")
            r = subprocess.run(["gdbus", "call", "--session", "-d", "org.gnome.Shell", "-o", "/org/gnome/Shell",
                                "-m", "org.freedesktop.DBus.Properties.Get", "org.gnome.Shell", "ShellVersion"],
                               env=self.env, capture_output=True, text=True)
            if r.returncode == 0:
                break
            time.sleep(0.3)
        else:
            raise SystemExit("gnome-shell did not come up")
        time.sleep(2)
        self.js("Main.overview.hide(); 1")
        time.sleep(0.8)
        assert "ready" in self.js(INPUT_JS)

    @staticmethod
    def shell_major():
        out = subprocess.run(["gnome-shell", "--version"], capture_output=True, text=True).stdout
        return out.split()[-1].split(".")[0]

    def stop(self):
        for p in reversed(self.procs):
            p.send_signal(signal.SIGTERM)
        for p in self.procs:
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
        shutil.rmtree(self.tmp, ignore_errors=True)

    # -- helpers ------------------------------------------------------------

    def js(self, code):
        r = subprocess.run(["gdbus", "call", "--session", "-d", "org.gnome.Shell", "-o", "/org/gnome/Shell",
                            "-m", "org.gnome.Shell.Eval", code], env=self.env, capture_output=True, text=True)
        out = r.stdout.strip()
        if not out.startswith("(true"):
            raise RuntimeError(f"shell eval failed: {out or r.stderr}\n  code: {code[:200]}")
        # Eval answers (true, '<json>') in GVariant text form, quoted like a Python string
        inner = ast.literal_eval(out[len("(true, "):-1])
        return json.loads(inner) if inner else None

    def t(self, call, wait=0.25):
        self.js(f"global._t.{call}; 1")
        time.sleep(wait)

    def keys(self, *names, wait=0.4):
        self.js("const C = imports.gi.Clutter; global._t.chord(%s); 1" % ", ".join(f"C.KEY_{n}" for n in names))
        time.sleep(wait)

    def cmd(self, method, *args):
        r = subprocess.run(["gdbus", "call", "--session", "-d", "org.gnome.Shell", "-o", OBJ,
                            "-m", f"{IFACE}.{method}", *args], env=self.env, capture_output=True, text=True)
        return r.stdout.strip()

    def state(self):
        return json.loads(self.js("global._t.ext().GetState()"))

    def ext(self, expr):
        return self.js(f"((e) => {expr})(global._t.ext())")

    def setting(self, schemas, key, value):
        subprocess.run(["gsettings", "--schemadir", str(schemas), "set", SCHEMA, key, value], env=self.env, check=True)

    def before_shell(self, schemas):
        """Point the extension at the local relay and at a scripted 'microphone'."""
        self.schemas = schemas
        self.relay = os.environ.get("EVOKED_TEST_RELAY")
        if not self.relay:
            port = 19001
            conf = self.tmp / "mosquitto.conf"
            conf.write_text(f"listener {port} 127.0.0.1\nprotocol websockets\nallow_anonymous true\n")
            self.procs.append(subprocess.Popen(["mosquitto", "-c", str(conf)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
            for _ in range(50):
                with socket.socket() as s:
                    if s.connect_ex(("127.0.0.1", port)) == 0:
                        break
                time.sleep(0.1)
            self.relay = f"ws://127.0.0.1:{port}"
        self.levels = self.tmp / "levels"
        self.levels.write_text("-60\n")
        self.setting(schemas, "relay-url", f"'{self.relay}'")
        self.setting(schemas, "audio-command", f"'python3 {ROOT}/tests/fake-mic.py {self.levels}'")
        self.setting(schemas, "room-code", "'TEST'")

    def phone(self, pid):
        p = subprocess.Popen(["gjs", "-m", str(ROOT / "tests/fake-phone.js"), self.relay, "TEST", pid],
                             env=self.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        os.set_blocking(p.stdout.fileno(), False)
        self.procs.append(p)
        return Phone(p)

    def shot(self, name):
        OUT.mkdir(parents=True, exist_ok=True)
        path = OUT / f"{name}.png"
        path.unlink(missing_ok=True)
        subprocess.run(["gdbus", "call", "--session", "-d", "org.gnome.Shell.Screenshot",
                        "-o", "/org/gnome/Shell/Screenshot", "-m", "org.gnome.Shell.Screenshot.Screenshot",
                        "false", "false", str(path)], env=self.env, capture_output=True)

    def errors(self):
        text = self.log.read_text()
        return [line for line in text.split("\n") if "JS ERROR" in line or ("CRITICAL" in line and "evoked" in line.lower())]


class Results:
    def __init__(self):
        self.failed = []
        self.count = 0

    def check(self, name, ok, detail=""):
        self.count += 1
        print(f"  {'ok  ' if ok else 'FAIL'} {name}" + (f"   [{detail}]" if detail and not ok else ""))
        if not ok:
            self.failed.append(name)


def browser_phones(rig, r):
    """The real join page, in headless Chrome, as three more phones. Skipped without Node + Playwright."""
    node = shutil.which("node")
    npm_root = subprocess.run(["npm", "root", "-g"], capture_output=True, text=True).stdout.strip() if shutil.which("npm") else ""
    env = dict(os.environ, NODE_PATH=npm_root)
    for chrome in ("/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"):
        if os.path.exists(chrome):
            env["CHROME_PATH"] = chrome
            break
    if not node or subprocess.run([node, "-e", "require('playwright')"], env=env, capture_output=True).returncode != 0:
        print("real join page in a browser: skipped (needs Node and Playwright)")
        return
    print("real join page in a browser")
    from urllib.parse import quote
    port = 18765
    server = subprocess.Popen([sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1", "--directory", str(ROOT / "docs")],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    rig.procs.append(server)
    time.sleep(0.6)
    rig.cmd("Mode", "free")
    before = rig.state()["brain"]
    url = f"http://127.0.0.1:{port}/j/?relay={quote(rig.relay, safe='')}#TEST"
    proc = subprocess.Popen([node, str(ROOT / "tests/browser-phones.cjs"), url, "3"], env=env, stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    rig.procs.append(proc)

    def ask(line):
        proc.stdin.write(line + "\n")
        proc.stdin.flush()
        answer = proc.stdout.readline().strip()
        return json.loads(answer) if answer.startswith("{") else answer

    r.check("the page loads without errors", proc.stdout.readline().strip() == "ready")
    time.sleep(2.5)
    r.check("three browser phones join the session", rig.state()["brain"]["people"] == before["people"] + 3, rig.state()["brain"])
    st = ask("state 0")
    r.check("the page shows which neuron you are", st["online"] and st["status"].startswith("neuron ") and st["status"].endswith(f"of {before['people'] + 3}"), st)
    ask("tap 0")
    ask("tap 1")
    time.sleep(0.7)
    OUT.mkdir(parents=True, exist_ok=True)
    ask(f"shot 0 {OUT / 'phone-free.png'}")
    r.check("tapping the neuron on the page fires it on the presenter's screen", rig.state()["brain"]["spikes"] == before["spikes"] + 2, rig.state()["brain"])
    rig.cmd("Mode", "vote")
    time.sleep(1.0)
    st = ask("state 2")
    r.check("the page switches to the two choices", st["ctl"]["mode"] == "vote" and st["labels"] == ["Bayes", "Hebb"], st)
    ask("vote 2 1")
    time.sleep(0.7)
    ask(f"shot 2 {OUT / 'phone-vote.png'}")
    r.check("a vote on the page adds evidence for that side", rig.ext("e.brain.evidence[1] > 0 && e.brain.evidence[0] === 0") is True, rig.ext("e.brain.evidence"))
    rig.cmd("Mode", "wave")
    time.sleep(0.8)
    rig.cmd("Wave")
    time.sleep(3.0)
    r.check("a wave makes the page flash", "on" in ask("state 1")["flash"])
    proc.stdin.write("quit\n")
    proc.stdin.flush()
    proc.wait(timeout=20)
    time.sleep(1.5)
    r.check("closing the page takes its neuron out of the network", rig.state()["brain"]["people"] == before["people"], rig.state()["brain"])


def run(rig, r):
    print("loading")
    st = rig.state()
    r.check("extension loads and answers on D-Bus", st["room"]["active"] is False and st["brain"]["active"] is False, st)

    print("room neuron")
    rig.cmd("Room", "on")
    time.sleep(1.5)
    st = rig.state()
    r.check("turning the room neuron on starts listening", st["room"]["active"] and st["room"]["audio"] == "ok", st["room"])
    r.check("its panel is on screen", rig.ext("e.stage._roomCard.box.mapped") is True)
    # stretching a drawn panel blurs it on big and HiDPI screens: everything must be drawn at its final size
    r.check("panels are drawn at full size, never stretched",
            rig.ext("[e.stage._corner, e.stage._join, e.stage._summary, e.stage._roomArea].every(a => a.scale_x === 1 && a.scale_y === 1)") is True)
    time.sleep(1.0)
    r.check("a quiet room: no spikes", rig.state()["room"]["spikes"] == 0, rig.state()["room"])
    rig.levels.write_text("-22\n")          # applause
    time.sleep(1.2)
    rig.shot("01-applause")
    loud = rig.state()["room"]
    r.check("applause makes it fire", loud["spikes"] >= 8 and loud["rate"] >= 5, loud)
    time.sleep(14)
    before = rig.state()["room"]["spikes"]
    time.sleep(2)
    after = rig.state()["room"]["spikes"]
    r.check("a steady sound fades into the baseline: it stops firing", after - before <= 1, (before, after))
    rig.levels.write_text("-60\n")
    time.sleep(3)
    rig.levels.write_text("-18\n")          # a burst of laughter after quiet
    time.sleep(1.0)
    rig.levels.write_text("-60\n")
    r.check("and a new burst after quiet makes it fire again", rig.state()["room"]["spikes"] - after >= 5)

    print("raster of the talk")
    rig.keys("Control_L", "Alt_L", "e")
    r.check("Ctrl+Alt+E shows the raster", rig.state()["rasterVisible"] is True and rig.ext("e.stage._summary.mapped") is True)
    time.sleep(0.5)
    rig.shot("02-raster")
    saved = rig.cmd("SaveRaster")
    path = ast.literal_eval(saved)[0] if saved else ""
    r.check("the raster is saved as a picture", bool(path) and pathlib.Path(path).stat().st_size > 5000, saved)
    if path:
        OUT.mkdir(parents=True, exist_ok=True)
        shutil.copy(path, OUT / "raster.png")
    rig.keys("Control_L", "Alt_L", "e")
    r.check("and hides it again", rig.state()["rasterVisible"] is False)
    rig.cmd("NewTalk")
    r.check("a new talk starts from zero", rig.state()["room"]["spikes"] == 0)
    rig.keys("Control_L", "Alt_L", "r")
    r.check("Ctrl+Alt+R turns the room neuron off", rig.state()["room"]["active"] is False)
    r.check("and stops the microphone listener", rig.ext("e.room._proc === null") is True)

    print("audience brain")
    rig.keys("Control_L", "Alt_L", "b", wait=1.5)
    st = rig.state()["brain"]
    r.check("Ctrl+Alt+B starts a session and connects to the relay", st["active"] and st["relay"] == "online", st)
    r.check("the join link carries the room code", st["join"].endswith("#TEST") and st["code"] == "TEST", st["join"])
    r.check("the join card with its QR code is showing", rig.ext("e.stage._join.mapped && e.stage._qr !== null") is True)
    time.sleep(0.6)
    rig.shot("03-join")
    qr = subprocess.run(["zbarimg", "-q", "--raw", str(OUT / "03-join.png")], capture_output=True, text=True) if shutil.which("zbarimg") else None
    if qr is not None:
        r.check("the QR code on screen scans back to the join link", qr.stdout.strip() == st["join"], qr.stdout.strip())

    phones = [rig.phone(f"p{i}") for i in range(12)]
    for p in phones:
        p.say("hi")
    time.sleep(2.5)
    r.check("twelve phones join", rig.state()["brain"]["people"] == 12, rig.state()["brain"])
    ctl = phones[3].last("ctl")
    r.check("each phone is told the mode and given a seat", bool(ctl) and ctl["mode"] == "free" and ctl["n"] == 12 and len(ctl["seats"]) == 12 and "p3" in ctl["seats"], ctl)
    rig.keys("Control_L", "Alt_L", "j")
    r.check("Ctrl+Alt+J hides the join card and shows the network", rig.ext("!e.stage._join.visible && e.stage._brainCard.box.mapped") is True)

    phones[0].say("tap")
    phones[5].say("tap", "tap")
    time.sleep(0.5)
    rig.shot("04-free")
    r.check("taps arrive as spikes", rig.state()["brain"]["spikes"] == 3, rig.state()["brain"])
    r.check("three of twelve is not synchrony", rig.ext("e.brain.syncedAt < 0") is True)
    for p in phones:
        p.say("tap")
    time.sleep(0.45)
    rig.shot("05-sync")
    r.check("the whole room tapping together is detected as synchrony", rig.ext("e.brain.syncedAt > 0") is True)

    print("wave")
    r.check("mode can be switched to wave", "true" in rig.cmd("Mode", "wave") and rig.state()["brain"]["mode"] == "wave")
    time.sleep(0.8)
    r.check("phones are told about the new mode", phones[7].last("ctl")["mode"] == "wave")
    rig.keys("Control_L", "Alt_L", "w")
    time.sleep(0.6)
    rig.shot("06-wave")
    go = phones[2].last("go")
    r.check("Ctrl+Alt+W sends a wave to the phones", bool(go) and 40 <= go["step"] <= 220, go)

    print("vote")
    rig.setting(rig.schemas, "vote-labels", "['Bayes', 'Hebb']")
    rig.cmd("Mode", "vote")
    time.sleep(0.8)
    ctl = phones[1].last("ctl")
    r.check("vote mode sends the two choices", ctl["mode"] == "vote" and ctl["labels"] == ["Bayes", "Hebb"], ctl)
    for _ in range(3):
        for p in phones[:4]:
            p.say("tap 0")
        for p in phones[4:]:
            p.say("tap 1")
        time.sleep(0.3)
    rig.shot("07-vote")
    r.check("evidence accumulates, more for the side with more taps", rig.ext("e.brain.evidence[1] > e.brain.evidence[0] && e.brain.evidence[0] > 0") is True, rig.ext("e.brain.evidence"))
    r.check("nobody has won yet", rig.state()["brain"]["winner"] == -1)
    for _ in range(8):
        for p in phones[4:]:
            p.say("tap 1")
        time.sleep(0.25)
    rig.shot("08-winner")
    r.check("the side that reaches the threshold wins", rig.state()["brain"]["winner"] == 1, rig.ext("e.brain.evidence"))

    browser_phones(rig, r)

    print("leaving")
    before = rig.state()["brain"]["people"]
    phones[0].say("bye")
    time.sleep(0.8)
    r.check("a phone that says goodbye leaves the network", rig.state()["brain"]["people"] == before - 1)
    rig.cmd("Brain", "off")
    time.sleep(0.8)
    r.check("ending the session tells the phones it is over", phones[4].last("ctl") == {"over": True}, phones[4].last("ctl"))
    r.check("and takes everything off the screen", rig.ext("e.stage._group.visible") is False)

    print("cleaning up")
    rig.cmd("Room", "on")
    time.sleep(0.8)
    rig.js("Main.extensionManager.disableExtension('%s'); 1" % UUID)
    time.sleep(0.8)
    left = rig.js("Main.layoutManager.uiGroup.get_children().filter(c => (c.name || '').startsWith('evoked')).length")
    r.check("disabling removes every actor", left == 0, left)
    mics = subprocess.run(["pgrep", "-f", "fake-mic.py"], capture_output=True, text=True).stdout.split()
    r.check("and stops the microphone listener", mics == [], mics)
    rig.js("Main.extensionManager.enableExtension('%s'); 1" % UUID)
    time.sleep(0.8)
    r.check("it can be enabled again", rig.state()["room"]["active"] is False)
    errs = rig.errors()
    r.check("no JavaScript errors in the shell log", errs == [], errs[:3])


def main():
    rig = Rig()
    r = Results()
    try:
        rig.start()
        run(rig, r)
    finally:
        for p in rig.procs:
            if p.stdin:
                try:
                    p.stdin.close()
                except OSError:
                    pass
        rig.stop()
    print(f"\n{r.count - len(r.failed)}/{r.count} checks passed" + (f"; failed: {', '.join(r.failed)}" if r.failed else ""))
    sys.exit(1 if r.failed else 0)


if __name__ == "__main__":
    main()
