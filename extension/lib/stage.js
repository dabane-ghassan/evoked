// Everything Evoked shows on screen: the room neuron and the audience brain in a corner,
// the join card with its QR code, and the raster of the talk.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {boxProps, setUnredirect} from './compat.js';
import {AMBER, INK, MINT, PAPER, PINK, mix, neuron, roundRect} from './draw.js';
import {qrMatrix} from './qr.js';

const ROOM_W = 340;
const ROOM_H = 104;
const BRAIN_W = 340;
const BRAIN_H = 236;
const QR_SIZE = 330;
export const SUMMARY_W = 860;
export const SUMMARY_H = 400;
const GOLDEN = 2.399963;        // the golden angle, for packing neurons into a disc

// Sizes of the text and boxes, in design pixels (as on a 1080p screen at 100%). Everything is
// laid out and drawn at its final size on screen; nothing is ever stretched after drawing,
// which is what keeps it sharp on large and HiDPI screens.
const STYLE = {
    corner: u => `spacing: ${10 * u}px;`,
    card: u => `border-radius: ${20 * u}px; padding: ${12 * u}px ${14 * u}px; border-width: ${Math.max(1, u)}px; ` +
        `box-shadow: 0 ${10 * u}px ${30 * u}px rgba(0, 0, 0, 0.35);`,
    head: u => `spacing: ${12 * u}px; padding-bottom: ${4 * u}px;`,
    title: u => `font-size: ${13 * u}px;`,
    value: u => `font-size: ${13 * u}px;`,
    join: u => `border-radius: ${34 * u}px; padding: ${26 * u}px ${34 * u}px ${24 * u}px; spacing: ${6 * u}px; ` +
        `border-width: ${Math.max(1, u)}px; box-shadow: 0 ${10 * u}px ${30 * u}px rgba(0, 0, 0, 0.35);`,
    joinTitle: u => `font-size: ${30 * u}px; padding-bottom: ${12 * u}px;`,
    joinUrl: u => `font-size: ${17 * u}px; padding-top: ${14 * u}px;`,
    joinCode: u => `font-size: ${46 * u}px;`,
    joinCount: u => `font-size: ${14 * u}px;`,
};

const now = () => GLib.get_monotonic_time() / 1e6;
const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Draw the raster of a talk. Shared by the on-screen card and the saved picture. */
export function drawSummary(cr, w, h, room) {
    roundRect(cr, 0, 0, w, h, 28);
    cr.setSourceRGB(...INK);
    cr.fill();

    const log = room.log;
    const seconds = Math.max(log.length, 1);
    const text = (s, x, y, size, color = PAPER, bold = false, alpha = 1) => {
        cr.selectFontFace('Cantarell', Cairo.FontSlant.NORMAL, bold ? Cairo.FontWeight.BOLD : Cairo.FontWeight.NORMAL);
        cr.setFontSize(size);
        cr.setSourceRGBA(...color, alpha);
        cr.moveTo(x, y);
        cr.showText(s);
    };

    // how busy each second was, smoothed over five seconds
    const rate = log.map((_v, i) => {
        let sum = 0;
        let n = 0;
        for (let k = Math.max(0, i - 2); k <= Math.min(log.length - 1, i + 2); k++) {
            sum += log[k];
            n++;
        }
        return n ? sum / n : 0;
    });
    const top = Math.max(4, ...rate);

    // the three busiest moments, at least twenty seconds apart
    const peaks = [];
    const order = rate.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
    for (const [v, i] of order) {
        if (v <= 0 || peaks.length === 3)
            break;
        if (peaks.every(p => Math.abs(p - i) > 20))
            peaks.push(i);
    }

    text('The raster of this talk', 36, 62, 30, PAPER, true);
    const minutes = Math.round(seconds / 60);
    const length = seconds < 90 ? `${seconds} seconds` : `${minutes} minutes`;
    const busiest = peaks.length ? `, busiest at ${clock(peaks[0])}` : '';
    text(`${length}, ${room.total} spikes${busiest}`, 36, 94, 17, PAPER, false, 0.7);

    const x0 = 36;
    const x1 = w - 36;
    const yBase = h - 88;
    const yTop = 132;
    const xAt = s => x0 + (x1 - x0) * s / seconds;

    // firing rate as a filled curve
    cr.moveTo(x0, yBase);
    rate.forEach((v, i) => cr.lineTo(xAt(i + 0.5), yBase - (yBase - yTop) * v / top));
    cr.lineTo(x1, yBase);
    cr.closePath();
    cr.setSourceRGBA(...MINT, 0.28);
    cr.fillPreserve();
    cr.setSourceRGB(...MINT);
    cr.setLineWidth(2);
    cr.stroke();

    // the raster itself: one tick per second that had spikes, taller for more
    cr.setLineWidth(Math.max(1, Math.min(3, (x1 - x0) / seconds * 0.7)));
    cr.setSourceRGBA(...PAPER, 0.9);
    log.forEach((v, i) => {
        if (v <= 0)
            return;
        const x = xAt(i + 0.5);
        cr.moveTo(x, yBase + 14);
        cr.lineTo(x, yBase + 14 + Math.min(26, 6 + v * 2));
    });
    cr.stroke();

    cr.setSourceRGBA(...PAPER, 0.3);
    cr.setLineWidth(1);
    cr.moveTo(x0, yBase + 0.5);
    cr.lineTo(x1, yBase + 0.5);
    cr.stroke();
    const stepMin = seconds > 3600 ? 10 : seconds > 900 ? 5 : seconds > 240 ? 1 : 0;
    if (stepMin) {
        for (let m = 0; m * 60 <= seconds; m += stepMin)
            text(`${m} min`, xAt(m * 60), h - 24, 13, PAPER, false, 0.55);
    } else {
        for (let s = 0; s <= seconds; s += Math.max(10, Math.ceil(seconds / 6 / 10) * 10))
            text(`${s} s`, xAt(s), h - 24, 13, PAPER, false, 0.55);
    }

    peaks.forEach((i, rank) => {
        const x = xAt(i + 0.5);
        const y = yBase - (yBase - yTop) * rate[i] / top;
        cr.setSourceRGB(...(rank === 0 ? AMBER : PINK));
        cr.arc(x, y, 5, 0, 2 * Math.PI);
        cr.fill();
        text(clock(i), Math.min(x + 9, x1 - 44), Math.max(yTop - 6, y - 8), 14, rank === 0 ? AMBER : PINK, true);
    });
}

function card(title) {
    const box = new St.BoxLayout(boxProps(true, {style_class: 'evoked-card'}));
    const head = new St.BoxLayout({style_class: 'evoked-head'});
    const name = new St.Label({text: title, style_class: 'evoked-title', y_align: Clutter.ActorAlign.CENTER});
    const value = new St.Label({text: '', style_class: 'evoked-value', x_expand: true,
        x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER});
    head.add_child(name);
    head.add_child(value);
    box.add_child(head);
    return {box, head, name, value};
}

export class Stage {
    constructor(settings, room, brain) {
        this._settings = settings;
        this._room = room;
        this._brain = brain;
        this.summaryVisible = false;
        this._qrFor = null;
        this._lastLabels = 0;
        this._lastTick = now();
        this._unit = 1;         // stage pixels per design pixel, for the corner panels
        this._joinUnit = 1;
        this._sumUnit = 1;
        this._styled = null;

        this._group = new Clutter.Actor({reactive: false, name: 'evoked-stage', visible: false});
        Main.layoutManager.uiGroup.add_child(this._group);

        this._corner = new St.BoxLayout(boxProps(true, {style_class: 'evoked-corner'}));
        this._group.add_child(this._corner);

        this._brainCard = card('Audience brain');
        this._brainArea = new St.DrawingArea({width: BRAIN_W, height: BRAIN_H});
        this._brainArea.connect('repaint', a => this._paintBrain(a));
        this._brainCard.box.add_child(this._brainArea);
        this._corner.add_child(this._brainCard.box);

        this._roomCard = card('Room');
        this._roomArea = new St.DrawingArea({width: ROOM_W, height: ROOM_H});
        this._roomArea.connect('repaint', a => this._paintRoom(a));
        this._roomCard.box.add_child(this._roomArea);
        this._corner.add_child(this._roomCard.box);

        // the join card: a QR code big enough to scan from the back of the room
        this._join = new St.BoxLayout(boxProps(true, {style_class: 'evoked-card evoked-join'}));
        this._joinTitle = new St.Label({text: 'Be a neuron', style_class: 'evoked-join-title', x_align: Clutter.ActorAlign.CENTER});
        this._join.add_child(this._joinTitle);
        this._qrArea = new St.DrawingArea({width: QR_SIZE, height: QR_SIZE, x_align: Clutter.ActorAlign.CENTER});
        this._qrArea.connect('repaint', a => this._paintQr(a));
        this._join.add_child(this._qrArea);
        this._joinUrl = new St.Label({style_class: 'evoked-join-url', x_align: Clutter.ActorAlign.CENTER});
        this._joinCode = new St.Label({style_class: 'evoked-join-code', x_align: Clutter.ActorAlign.CENTER});
        this._joinCount = new St.Label({style_class: 'evoked-join-count', x_align: Clutter.ActorAlign.CENTER});
        this._join.add_child(this._joinUrl);
        this._join.add_child(this._joinCode);
        this._join.add_child(this._joinCount);
        this._group.add_child(this._join);

        this._summary = new St.DrawingArea({width: SUMMARY_W, height: SUMMARY_H});
        this._summary.connect('repaint', a => {
            const cr = a.get_context();
            cr.scale(this._sumUnit, this._sumUnit);
            drawSummary(cr, SUMMARY_W, SUMMARY_H, this._room);
            cr.$dispose();
        });
        this._group.add_child(this._summary);

        this._timeline = new Clutter.Timeline({actor: this._group, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._frame());
        this._settingsId = settings.connect('changed', (_s, key) => {
            if (key === 'corner' || key === 'panel-scale')
                this._place();
        });
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._place());
        this.sync();
    }

    /** Show what should be showing; stop drawing frames when nothing is. */
    sync() {
        const room = this._room.active;
        const brain = this._brain.active;
        const join = brain && this._brain.joinVisible;
        this._roomCard.box.visible = room;
        this._brainCard.box.visible = brain && !join;
        this._corner.visible = this._roomCard.box.visible || this._brainCard.box.visible;
        this._join.visible = join;
        this._summary.visible = this.summaryVisible;
        const any = this._corner.visible || join || this.summaryVisible;
        if (any === this._group.visible) {
            if (any)
                this._place();
            return;
        }
        this._group.visible = any;
        setUnredirect(any);
        if (any) {
            this._lastTick = now();
            this._timeline.start();
            this._labels();
            this._place();
        } else {
            this._timeline.stop();
        }
    }

    /** Size every panel for this screen, then put it in place. */
    _place() {
        const m = Main.layoutManager.primaryMonitor;
        if (!m)
            return;
        // stage pixels per design pixel: bigger on bigger screens, and the user's own size setting
        const unit = this._settings.get_double('panel-scale') * Math.max(0.7, m.height / 1080);
        // the join card and the raster are big: keep them on screen
        const joinUnit = Math.min(unit, (m.width - 40) / 420, (m.height - 80) / 600);
        const sumUnit = Math.min(unit, (m.width - 40) / SUMMARY_W, (m.height - 80) / SUMMARY_H);
        this._restyle(unit, joinUnit, sumUnit);

        const margin = Math.round(18 * unit);
        const corner = this._settings.get_string('corner');
        const right = corner.endsWith('right');
        const bottom = corner.startsWith('bottom');
        const [, w] = this._corner.get_preferred_width(-1);
        const [, h] = this._corner.get_preferred_height(-1);
        this._corner.set_position(
            Math.round(right ? m.x + m.width - w - margin : m.x + margin),
            Math.round(bottom ? m.y + m.height - h - margin : m.y + margin + Main.panel.height));

        for (const actor of [this._join, this._summary]) {
            const [, aw] = actor.get_preferred_width(-1);
            const [, ah] = actor.get_preferred_height(-1);
            actor.set_position(Math.round(m.x + (m.width - aw) / 2), Math.round(m.y + (m.height - ah) / 2));
        }
    }

    _restyle(unit, joinUnit, sumUnit) {
        const key = `${unit}/${joinUnit}/${sumUnit}`;
        if (key === this._styled)
            return;
        this._styled = key;
        this._unit = unit;
        this._joinUnit = joinUnit;
        this._sumUnit = sumUnit;
        // St multiplies CSS pixels by the desktop's scale factor itself, so divide it out
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
        const css = (style, u) => style(u / sf);
        this._corner.style = css(STYLE.corner, unit);
        for (const c of [this._roomCard, this._brainCard]) {
            c.box.style = css(STYLE.card, unit);
            c.head.style = css(STYLE.head, unit);
            c.name.style = css(STYLE.title, unit);
            c.value.style = css(STYLE.value, unit);
        }
        this._roomArea.set_size(Math.round(ROOM_W * unit), Math.round(ROOM_H * unit));
        this._brainArea.set_size(Math.round(BRAIN_W * unit), Math.round(BRAIN_H * unit));

        this._join.style = css(STYLE.join, joinUnit);
        this._joinTitle.style = css(STYLE.joinTitle, joinUnit);
        this._joinUrl.style = css(STYLE.joinUrl, joinUnit);
        this._joinCode.style = css(STYLE.joinCode, joinUnit);
        this._joinCount.style = css(STYLE.joinCount, joinUnit);
        this._qrArea.set_size(Math.round(QR_SIZE * joinUnit), Math.round(QR_SIZE * joinUnit));

        this._summary.set_size(Math.round(SUMMARY_W * sumUnit), Math.round(SUMMARY_H * sumUnit));
        for (const area of [this._roomArea, this._brainArea, this._qrArea, this._summary])
            area.queue_repaint();
    }

    _frame() {
        const ui = Main.layoutManager.uiGroup;
        if (ui.get_last_child() !== this._group)
            ui.set_child_above_sibling(this._group, null);
        const t = now();
        const dt = Math.min(0.1, t - this._lastTick);
        this._lastTick = t;
        if (this._brain.active)
            this._brain.tick(dt);
        if (this._roomCard.box.visible)
            this._roomArea.queue_repaint();
        if (this._brainCard.box.visible)
            this._brainArea.queue_repaint();
        if (t - this._lastLabels > 0.25) {
            this._lastLabels = t;
            this._labels();
        }
    }

    _labels() {
        const room = this._room;
        const status = {
            starting: 'listening…', missing: 'gst-launch-1.0 not found', error: 'no microphone', off: '',
        }[room.audio];
        this._roomCard.value.text = status ?? `${room.rate} spikes/s`;

        const brain = this._brain;
        const t = now();
        const n = brain.count;
        const people = n === 1 ? '1 neuron' : `${n} neurons`;
        let value;
        if (brain.relayState !== 'online')
            value = brain.relayState === 'connecting' ? 'connecting…' : 'offline, retrying';
        else if (n === 0)
            value = `join with code ${brain.room}`;
        else if (brain.mode === 'vote')
            value = brain.winner >= 0 ? `${brain.labels[brain.winner]} wins` : `${people}, voting`;
        else if (brain.mode === 'free' && t - brain.syncedAt < 1.5)
            value = 'in sync!';
        else
            value = people;
        this._brainCard.value.text = value;

        if (this._join.visible) {
            const url = brain.joinUrl;
            if (url !== this._qrFor) {
                this._qrFor = url;
                try {
                    this._qr = qrMatrix(url);
                } catch (_e) {
                    this._qr = null;
                }
                this._qrArea.queue_repaint();
                this._joinUrl.text = url.replace(/^https?:\/\//, '').replace(/[#?].*$/, '');
                this._joinCode.text = brain.room.split('').join(' ');
                this._place();
            }
            this._joinCount.text = brain.relayState !== 'online' ? 'connecting…'
                : n === 0 ? 'scan, or open the link and type the code' : `${people} joined`;
        }
        if (this.summaryVisible)
            this._summary.queue_repaint();
    }

    // ------------------------------------------------------------ painting

    _paintRoom(area) {
        const cr = area.get_context();
        cr.scale(this._unit, this._unit);
        const room = this._room;
        const t = now();
        const w = ROOM_W;
        const h = ROOM_H;
        const glow = Math.exp(-(t - room.lastSpike) / 0.12);
        const base = h - 26;

        // axon from the neuron into the trace
        cr.setSourceRGBA(...mix([0.42, 0.40, 0.62], MINT, glow), 0.9);
        cr.setLineWidth(3);
        cr.moveTo(46, 50);
        cr.curveTo(70, 50, 70, base, 92, base);
        cr.stroke();
        neuron(cr, 44, 50, 15, glow, MINT, 0.6);

        // how loud the room is, under the neuron
        const loud = Math.max(0, Math.min(1, (room.level + 70) / 60));
        cr.setSourceRGBA(...PAPER, 0.18);
        roundRect(cr, 14, h - 12, 60, 5, 2.5);
        cr.fill();
        cr.setSourceRGBA(...PAPER, 0.75);
        roundRect(cr, 14, h - 12, Math.max(5, 60 * loud), 5, 2.5);
        cr.fill();

        // membrane potential, oldest on the left
        const n = room.trace.length;
        const x0 = 92;
        const x1 = w - 10;
        const amp = base - 34;
        cr.setLineWidth(1.6);
        cr.setLineJoin(1);
        cr.setSourceRGBA(...PAPER, 0.85);
        for (let i = 0; i < n; i++) {
            const k = (room.traceAt + 1 + i) % n;
            const x = x0 + (x1 - x0) * i / (n - 1);
            const y = base - Math.min(1, room.trace[k]) * amp;
            if (i === 0)
                cr.moveTo(x, y);
            else
                cr.lineTo(x, y);
        }
        cr.stroke();
        cr.setSourceRGB(...MINT);
        cr.setLineWidth(1.5);
        for (let i = 0; i < n; i++) {
            const k = (room.traceAt + 1 + i) % n;
            if (!room.traceSpike[k])
                continue;
            const x = x0 + (x1 - x0) * i / (n - 1);
            cr.moveTo(x, base);
            cr.lineTo(x, 8);
        }
        cr.stroke();
        cr.$dispose();
    }

    _paintBrain(area) {
        const cr = area.get_context();
        cr.scale(this._unit, this._unit);
        const brain = this._brain;
        const t = now();
        const w = BRAIN_W;
        const h = BRAIN_H;
        const vote = brain.mode === 'vote';
        const cx = w / 2;
        const cy = vote ? h / 2 - 4 : h / 2 - 10;
        const R = vote ? 84 : 92;

        const seats = Math.max(8, ...Array.from(brain.people.values(), p => p.seat + 1));
        const r = Math.max(3.2, Math.min(11, R / Math.sqrt(seats) * 0.5));
        const at = seat => {
            const d = R * Math.sqrt((seat + 0.5) / seats);
            return [cx + d * Math.cos(seat * GOLDEN), cy + d * Math.sin(seat * GOLDEN)];
        };

        // empty seats, faintly, so the room can see there is space for them
        const taken = new Set(Array.from(brain.people.values(), p => p.seat));
        cr.setSourceRGBA(...PAPER, 0.10);
        for (let s = 0; s < seats; s++) {
            if (taken.has(s))
                continue;
            const [x, y] = at(s);
            cr.arc(x, y, r * 0.7, 0, 2 * Math.PI);
            cr.fill();
        }

        if (brain.mode === 'free' && t - brain.syncedAt < 1.2) {
            const k = (t - brain.syncedAt) / 1.2;
            cr.setSourceRGBA(...AMBER, 0.8 * (1 - k));
            cr.setLineWidth(4);
            cr.arc(cx, cy, R * (0.5 + 0.75 * k), 0, 2 * Math.PI);
            cr.stroke();
        }

        for (const p of brain.people.values()) {
            const [x, y] = at(p.seat);
            const color = vote ? (p.choice === 1 ? PINK : p.choice === 0 ? MINT : PAPER) : MINT;
            neuron(cr, x, y, r, brain.glow(p, t), color, p.seat);
        }

        if (vote) {
            // two accumulators racing to the line at the top
            const top = 22;
            const bottom = h - 22;
            [[18, MINT, 0], [w - 34, PINK, 1]].forEach(([x, color, i]) => {
                cr.setSourceRGBA(...PAPER, 0.14);
                roundRect(cr, x, top, 16, bottom - top, 8);
                cr.fill();
                const e = Math.min(1, brain.evidence[i]);
                if (e > 0.01) {
                    const won = brain.winner === i;
                    cr.setSourceRGBA(...color, won ? 0.65 + 0.35 * Math.sin(t * 14) ** 2 : 1);
                    roundRect(cr, x, bottom - (bottom - top) * e, 16, Math.max(16, (bottom - top) * e), 8);
                    cr.fill();
                }
            });
            cr.setSourceRGBA(...PAPER, 0.6);
            cr.setLineWidth(2);
            cr.setDash([5, 5], 0);
            cr.moveTo(10, top);
            cr.lineTo(w - 10, top);
            cr.stroke();
            cr.setDash([], 0);
        } else if (brain.mode === 'free') {
            // how much of the room fired together just now
            const bw = 180;
            cr.setSourceRGBA(...PAPER, 0.16);
            roundRect(cr, cx - bw / 2, h - 14, bw, 6, 3);
            cr.fill();
            cr.setSourceRGB(...mix(MINT, AMBER, Math.min(1, brain.sync / 0.7)));
            roundRect(cr, cx - bw / 2, h - 14, Math.max(6, bw * Math.min(1, brain.sync)), 6, 3);
            cr.fill();
        }
        cr.$dispose();
    }

    _paintQr(area) {
        const cr = area.get_context();
        cr.scale(this._joinUnit, this._joinUnit);
        roundRect(cr, 0, 0, QR_SIZE, QR_SIZE, 22);
        cr.setSourceRGB(1, 1, 1);
        cr.fill();
        const m = this._qr;
        if (m) {
            const quiet = 3;
            // whole screen pixels per module, so the code stays crisp and easy to scan
            const px = Math.max(1, Math.floor(QR_SIZE * this._joinUnit / (m.length + 2 * quiet)));
            const cell = px / this._joinUnit;
            const offset = (QR_SIZE - cell * (m.length + 2 * quiet)) / 2;
            cr.translate(Math.round(offset * this._joinUnit) / this._joinUnit, Math.round(offset * this._joinUnit) / this._joinUnit);
            cr.setSourceRGB(...INK);
            for (let y = 0; y < m.length; y++) {
                for (let x = 0; x < m.length; x++) {
                    if (m[y][x])
                        cr.rectangle((x + quiet) * cell, (y + quiet) * cell, cell, cell);
                }
            }
            cr.fill();
        }
        cr.$dispose();
    }

    /** Save the raster of the talk as a picture; returns the path, or null. */
    saveSummary() {
        const dir = GLib.build_filenamev([
            GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) ?? GLib.get_home_dir(), 'Evoked']);
        try {
            GLib.mkdir_with_parents(dir, 0o755);
            const stamp = GLib.DateTime.new_now_local().format('%Y-%m-%d-%H%M');
            const path = GLib.build_filenamev([dir, `talk-${stamp}.png`]);
            const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, SUMMARY_W * 2, SUMMARY_H * 2);
            const cr = new Cairo.Context(surface);
            cr.scale(2, 2);
            drawSummary(cr, SUMMARY_W, SUMMARY_H, this._room);
            cr.$dispose();
            surface.writeToPNG(path);
            return path;
        } catch (e) {
            console.warn(`Evoked: could not save the raster: ${e.message}`);
            return null;
        }
    }

    destroy() {
        this._timeline.stop();
        if (this._group.visible)
            setUnredirect(false);
        this._settings.disconnect(this._settingsId);
        Main.layoutManager.disconnect(this._monitorsId);
        this._group.destroy();
    }
}
