// Spike applause: a neuron that listens to the room.
//
// The microphone's loudness drives a leaky integrate-and-fire neuron. It adapts to steady
// sound (a voice at constant volume fades into the baseline), so it fires for what stands
// out: clapping, laughter, a sudden question. Every spike is kept, so at the end there is
// a raster of the whole talk.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const TAU_M = 0.06;             // membrane time constant, seconds
const REFRACTORY = 0.05;        // keeps the top rate near 16 spikes a second, so spikes stay countable
const MARGIN = 4;               // dB above the baseline before anything gets through
const RANGE = 12;               // dB above that for a drive of 1 x sensitivity x GAIN
const GAIN = 3;
const ADAPT_UP = 6;             // seconds for the baseline to rise to a sustained sound
const ADAPT_DOWN = 1.5;         // and to fall back when it goes quiet
export const TRACE_SECONDS = 5;
export const TRACE_RATE = 100;  // samples of membrane potential kept per second

const DEFAULT_COMMAND =
    'gst-launch-1.0 -m autoaudiosrc ! audioconvert ! audio/x-raw,channels=1 ! level interval=40000000 ! fakesink sync=false';

const now = () => GLib.get_monotonic_time() / 1e6;

export class Room {
    constructor(settings) {
        this._settings = settings;
        this.active = false;
        this.audio = 'off';     // off | starting | ok | missing | error
        this.onChanged = null;
        this._proc = null;
        this._cancel = null;
        this.resetTalk();
    }

    /** Forget the talk so far. */
    resetTalk() {
        this.started = 0;               // wall-clock seconds when listening began
        this.log = [];                  // spikes in each second of the talk
        this.total = 0;
        this.v = 0;
        this.level = -80;
        this.baseline = null;
        this.lastSpike = -1;
        this.spikes = [];               // monotonic times of recent spikes
        this.trace = new Float32Array(TRACE_SECONDS * TRACE_RATE);
        this.traceSpike = new Uint8Array(this.trace.length);
        this.traceAt = 0;
        this._traceClock = 0;
        this._refractoryUntil = 0;
    }

    get rate() {
        const t = now();
        while (this.spikes.length && t - this.spikes[0] > 2)
            this.spikes.shift();
        return this.spikes.filter(s => t - s <= 1).length;
    }

    get seconds() {
        return this.started ? Math.max(0, Math.floor(Date.now() / 1000 - this.started)) : 0;
    }

    start() {
        if (this.active)
            return;
        this.active = true;
        if (!this.started)
            this.started = Date.now() / 1000;
        this._listen();
        this.onChanged?.();
    }

    stop() {
        if (!this.active)
            return;
        this.active = false;
        this._hush();
        this.audio = 'off';
        this.onChanged?.();
    }

    destroy() {
        this.active = false;
        this._hush();
    }

    // ------------------------------------------------------------ microphone

    _listen() {
        this._hush();
        const custom = this._settings.get_string('audio-command').trim();
        let argv;
        try {
            [, argv] = GLib.shell_parse_argv(custom || DEFAULT_COMMAND);
        } catch (_e) {
            this.audio = 'error';
            return;
        }
        if (!GLib.find_program_in_path(argv[0])) {
            this.audio = 'missing';
            return;
        }
        try {
            this._proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (_e) {
            this.audio = 'error';
            return;
        }
        this.audio = 'starting';
        this._cancel = new Gio.Cancellable();
        const lines = new Gio.DataInputStream({base_stream: this._proc.get_stdout_pipe(), close_base_stream: true});
        const proc = this._proc;
        const read = () => {
            lines.read_line_async(GLib.PRIORITY_DEFAULT, this._cancel, (stream, result) => {
                let line;
                try {
                    [line] = stream.read_line_finish_utf8(result);
                } catch (_e) {
                    return;         // cancelled
                }
                if (line === null) {
                    // the listener ended on its own: no microphone, or it was unplugged
                    if (this._proc === proc && this.active) {
                        this.audio = 'error';
                        this._proc = null;
                        this.onChanged?.();
                    }
                    return;
                }
                const match = /rms=\(GValueArray\)<\s*(-?[\d.]+|-?inf)/.exec(line);
                if (match) {
                    if (this.audio !== 'ok') {
                        this.audio = 'ok';
                        this.onChanged?.();
                    }
                    const db = match[1].includes('inf') ? -80 : parseFloat(match[1]);
                    this.hear(Math.max(-80, Math.min(0, db)), 0.04);
                }
                read();
            });
        };
        read();
    }

    _hush() {
        this._cancel?.cancel();
        this._cancel = null;
        if (this._proc) {
            try {
                this._proc.force_exit();
            } catch (_e) {
                // already gone
            }
        }
        this._proc = null;
    }

    // ------------------------------------------------------------ the neuron

    /** One loudness sample, in dB (0 is the loudest a microphone can report), lasting dt seconds. */
    hear(db, dt) {
        this.level = db;
        if (this.baseline === null)
            this.baseline = db;
        const tau = db > this.baseline ? ADAPT_UP : ADAPT_DOWN;
        this.baseline += (db - this.baseline) * (1 - Math.exp(-dt / tau));

        const sensitivity = this._settings.get_double('sensitivity');
        const drive = Math.max(0, (db - this.baseline - MARGIN) / RANGE) * GAIN * sensitivity;

        const steps = Math.max(1, Math.round(dt / 0.005));
        const h = dt / steps;
        const t0 = now() - dt;
        for (let i = 0; i < steps; i++) {
            const t = t0 + (i + 1) * h;
            let spiked = false;
            if (t >= this._refractoryUntil) {
                this.v += (drive - this.v) * (h / TAU_M);
                if (this.v >= 1) {
                    this.v = 0;
                    this._refractoryUntil = t + REFRACTORY;
                    spiked = true;
                    this._spike(t);
                }
            }
            this._traceClock += h * TRACE_RATE;
            if (spiked)
                this._pendingSpike = true;
            while (this._traceClock >= 1) {
                this._traceClock -= 1;
                this.traceAt = (this.traceAt + 1) % this.trace.length;
                this.trace[this.traceAt] = this.v;
                this.traceSpike[this.traceAt] = this._pendingSpike ? 1 : 0;
                this._pendingSpike = false;
            }
        }
    }

    _spike(t) {
        this.lastSpike = t;
        this.spikes.push(t);
        this.total++;
        const second = this.seconds;
        while (this.log.length <= second)
            this.log.push(0);
        this.log[second]++;
    }
}
