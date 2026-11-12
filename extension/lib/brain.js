// Audience brain: every phone in the room is one neuron.
//
// Phones open the join page, connect to the relay server and send a message per tap.
// This side listens, keeps one neuron per phone, and tells the phones what mode the room
// is in. Three modes:
//   free   every tap is a spike; the room can try to fire in sync
//   wave   the presenter sends a wave and the phones light up one after another
//   vote   two choices race to a threshold, pushed by taps (a decision by accumulation)

import GLib from 'gi://GLib';

import {Relay} from './relay.js';

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';     // no I or O: they read as 1 and 0
const GONE_AFTER = 25;          // seconds without a sign of life
const SYNC_WINDOW = 0.25;       // spikes this close together count as together
const SYNC_NEEDED = 0.7;        // fraction of the room that must fire together
const VOTE_TAPS = 6;            // taps per person, on average, to reach the threshold
const VOTE_LEAK = 8;            // seconds for unpushed evidence to drain away
export const MODES = ['free', 'wave', 'vote'];

const now = () => GLib.get_monotonic_time() / 1e6;

export class Brain {
    constructor(settings) {
        this._settings = settings;
        this.active = false;
        this.room = '';
        this.mode = 'free';
        this.joinVisible = false;
        this.relayState = 'offline';
        this.people = new Map();        // phone id -> {seat, seen, spike, spikes, choice}
        this.onChanged = null;
        this._seats = 0;
        this._relay = null;
        this._ctlTimer = 0;
        this._waveId = 0;
        this.waveStart = 0;
        this.waveStep = 0;
        this.sync = 0;                  // fraction of the room that fired together just now
        this.syncedAt = -10;
        this.evidence = [0, 0];
        this.winner = -1;
        this.wonAt = -10;
        this.totalSpikes = 0;
    }

    get count() {
        return this.people.size;
    }

    get joinUrl() {
        const base = this._settings.get_string('join-url').replace(/[#?].*$/, '');
        const relay = this._settings.get_string('relay-url');
        const custom = relay !== this._settings.get_default_value('relay-url').unpack();
        return `${base}${custom ? `?relay=${encodeURIComponent(relay)}` : ''}#${this.room}`;
    }

    get labels() {
        const [a, b] = this._settings.get_strv('vote-labels');
        return [a || 'A', b || 'B'];
    }

    get _base() {
        return `evoked/1/${this.room}`;
    }

    start() {
        if (this.active)
            return;
        this.active = true;
        this.room = Array.from({length: 4}, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join('');
        const forced = this._settings.get_string('room-code').toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (forced)
            this.room = forced.slice(0, 8);
        this.people.clear();
        this._seats = 0;
        this.evidence = [0, 0];
        this.winner = -1;
        this.joinVisible = true;
        this._relay = new Relay(this._settings.get_string('relay-url'), {
            onMessage: (topic, payload) => this._message(topic, payload),
            onState: state => {
                this.relayState = state;
                if (state === 'online')
                    this._announce();
                this.onChanged?.();
            },
        });
        this._relay.subscribe(`${this._base}/up/+`);
        this._announce();
        this.onChanged?.();
    }

    stop() {
        if (!this.active)
            return;
        this.active = false;
        this.joinVisible = false;
        if (this._ctlTimer)
            GLib.source_remove(this._ctlTimer);
        this._ctlTimer = 0;
        // tell the phones the session is over before hanging up
        this._relay?.publish(`${this._base}/ctl`, JSON.stringify({over: true}), true);
        this._relay?.close();
        this._relay = null;
        this.relayState = 'offline';
        this.people.clear();
        this.onChanged?.();
    }

    destroy() {
        this.onChanged = null;
        this.stop();
    }

    setMode(mode) {
        if (!MODES.includes(mode) || mode === this.mode)
            return;
        this.mode = mode;
        this.evidence = [0, 0];
        this.winner = -1;
        this._announce();
        this.onChanged?.();
    }

    setJoinVisible(on) {
        if (on === this.joinVisible)
            return;
        this.joinVisible = on;
        this.onChanged?.();
    }

    /** Send a wave across the room: phone n lights up n steps after the first. */
    wave() {
        if (!this.active || this.count === 0)
            return false;
        const step = Math.round(Math.min(220, Math.max(40, 1800 / this.count)));
        this._waveId++;
        this._relay.publish(`${this._base}/go`, JSON.stringify({id: this._waveId, step}));
        this.waveStart = now() + 0.15;
        this.waveStep = step / 1000;
        return true;
    }

    // ------------------------------------------------------------ messages

    _announce() {
        if (!this.active || this._ctlTimer)
            return;
        // several phones often join at once: gather them into one announcement
        this._ctlTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._ctlTimer = 0;
            const seats = {};
            for (const [pid, p] of this.people)
                seats[pid] = p.seat;
            this._relay?.publish(`${this._base}/ctl`, JSON.stringify({
                mode: this.mode, labels: this.labels, n: this.count, seats,
            }), true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _message(topic, payload) {
        const pid = topic.slice(topic.lastIndexOf('/') + 1);
        if (!/^[A-Za-z0-9_-]{1,24}$/.test(pid))
            return;
        let msg;
        try {
            msg = JSON.parse(payload);
        } catch (_e) {
            return;
        }
        if (!msg || typeof msg !== 'object')
            return;
        const t = now();
        if (msg.t === 'bye') {
            if (this.people.delete(pid)) {
                this._announce();
                this.onChanged?.();
            }
            return;
        }
        let person = this.people.get(pid);
        if (!person) {
            if (this.people.size >= 500)
                return;
            person = {seat: this._seats++, seen: t, spike: -10, spikes: [], choice: -1};
            this.people.set(pid, person);
            this._announce();
            this.onChanged?.();
        }
        person.seen = t;
        if (msg.t !== 'tap')
            return;
        const taps = Math.max(1, Math.min(5, Number(msg.n) || 1));
        person.spike = t;
        person.spikes.push(t);
        if (person.spikes.length > 40)
            person.spikes.shift();
        this.totalSpikes += taps;
        if (this.mode === 'vote' && this.winner < 0) {
            const choice = msg.c === 1 ? 1 : 0;
            person.choice = choice;
            this.evidence[choice] += taps / (Math.max(3, this.count) * VOTE_TAPS);
            if (this.evidence[choice] >= 1) {
                this.evidence[choice] = 1;
                this.winner = choice;
                this.wonAt = t;
                this.onChanged?.();
            }
        }
    }

    // ------------------------------------------------------------ each frame

    tick(dt) {
        const t = now();
        let left = false;
        for (const [pid, p] of this.people) {
            if (t - p.seen > GONE_AFTER) {
                this.people.delete(pid);
                left = true;
            }
        }
        if (left) {
            this._announce();
            this.onChanged?.();
        }

        if (this.mode === 'free') {
            let together = 0;
            for (const p of this.people.values()) {
                if (t - p.spike <= SYNC_WINDOW)
                    together++;
            }
            const fraction = this.count ? together / this.count : 0;
            this.sync += (fraction - this.sync) * Math.min(1, dt * 10);
            if (this.count >= 3 && fraction >= SYNC_NEEDED && t - this.syncedAt > 1.2)
                this.syncedAt = t;
        } else {
            this.sync = 0;
        }

        if (this.mode === 'vote') {
            if (this.winner >= 0) {
                if (t - this.wonAt > 5) {
                    this.winner = -1;
                    this.evidence = [0, 0];
                    this.onChanged?.();
                }
            } else {
                const keep = Math.exp(-dt / VOTE_LEAK);
                this.evidence[0] *= keep;
                this.evidence[1] *= keep;
            }
        }
    }

    /** 0..1: how lit a neuron is right now. */
    glow(person, t) {
        let g = Math.exp(-(t - person.spike) / 0.18);
        if (this.waveStart) {
            const at = this.waveStart + person.seat * this.waveStep;
            if (t >= at)
                g = Math.max(g, Math.exp(-(t - at) / 0.25));
        }
        return g;
    }
}
