// Talks to the part of Evoked that runs inside GNOME Shell and draws over the slides.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const DEST = 'org.gnome.Shell';
const PATH = '/io/github/dabane_ghassan/Evoked';
const IFACE = 'io.github.dabane_ghassan.Evoked';
export const UUID = 'evoked@dabane-ghassan.github.io';

export class Engine {
    constructor() {
        this._bus = Gio.DBus.session;
        this.state = null;      // null until the shell side answers
        this._watchers = [];
        this._signal = this._bus.signal_subscribe(DEST, IFACE, 'StateChanged', PATH, null,
            Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => this._set(params.deep_unpack()[0]));
        this._tries = 0;
        // spike counts and the firing rate change without a signal: look every second
        this._poll = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
        this.refresh();
    }

    _set(json) {
        try {
            this.state = json === null ? null : JSON.parse(json);
        } catch (_e) {
            this.state = null;
        }
        for (const w of this._watchers)
            w(this.state);
    }

    refresh() {
        this._bus.call(DEST, PATH, IFACE, 'GetState', null, null, Gio.DBusCallFlags.NONE, 2000, null, (bus, res) => {
            try {
                this._set(bus.call_finish(res).deep_unpack()[0]);
            } catch (_e) {
                this._set(null);
                if (this._tries++ === 0) {
                    try {
                        Gio.Subprocess.new(['gnome-extensions', 'enable', UUID],
                            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
                    } catch (_e2) {
                        // not a GNOME session
                    }
                }
            }
        });
    }

    /** Call a method; `arg` is its one string argument, if it takes one. Returns via callback. */
    call(method, arg = null, done = null) {
        const params = arg === null ? null : new GLib.Variant('(s)', [arg]);
        this._bus.call(DEST, PATH, IFACE, method, params, null, Gio.DBusCallFlags.NONE, 4000, null, (bus, res) => {
            let value = null;
            try {
                value = bus.call_finish(res).deep_unpack()[0] ?? null;
            } catch (_e) {
                value = null;
            }
            done?.(value);
            this.refresh();
        });
    }

    watch(callback) {
        this._watchers.push(callback);
        callback(this.state);
    }

    destroy() {
        this._watchers = [];
        if (this._signal)
            this._bus.signal_unsubscribe(this._signal);
        if (this._poll)
            GLib.source_remove(this._poll);
        this._signal = this._poll = 0;
    }
}
