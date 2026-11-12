// The Evoked app window: switch the two features on and off, run the audience session,
// and change the settings.

import Adw from 'gi://Adw';
import Cairo from 'cairo';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {Engine} from './engine.js';

const CSS = `
@define-color accent_bg_color #5B45E0;
@define-color accent_color #6E59F0;
@define-color accent_fg_color #ffffff;
.evoked-hero { border-radius: 26px; }
.evoked-big { font-weight: 800; font-size: 1.5em; letter-spacing: -0.02em; }
.evoked-code { font-weight: 800; font-size: 2.2em; letter-spacing: 0.18em; color: #5B45E0; }
.evoked-pill { border-radius: 999px; padding: 10px 22px; font-weight: 700; }
.evoked-notice { border-radius: 18px; padding: 14px 16px; background: alpha(#5B45E0, 0.12); }
`;
const CSS_VARS = `
window.evoked { --accent-bg-color: #5B45E0; --accent-color: #6E59F0; --accent-fg-color: #ffffff; }
`;
const MODES = [['free', 'Free firing'], ['wave', 'Wave'], ['vote', 'Vote']];
const CORNERS = [['bottom-right', 'Bottom right'], ['bottom-left', 'Bottom left'], ['top-right', 'Top right'], ['top-left', 'Top left']];
const GOLDEN = 2.399963;

/** A patch of neurons that light up: with the audience's taps when a session runs, idly otherwise. */
class Hero {
    constructor() {
        this.widget = new Gtk.DrawingArea({content_height: 210, hexpand: true, css_classes: ['evoked-hero']});
        this.widget.set_draw_func((_a, cr, w, h) => this._draw(cr, w, h));
        this._cells = Array.from({length: 46}, (_v, i) => ({i, lit: -10}));
        this.activity = 0.6;    // spikes per second across the patch
        this._last = GLib.get_monotonic_time() / 1e6;
        this.widget.add_tick_callback(() => {
            const t = GLib.get_monotonic_time() / 1e6;
            const dt = Math.min(0.1, t - this._last);
            this._last = t;
            if (Math.random() < this.activity * dt)
                this._cells[Math.floor(Math.random() * this._cells.length)].lit = t;
            this.widget.queue_draw();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _draw(cr, w, h) {
        const t = GLib.get_monotonic_time() / 1e6;
        const r = 26;
        cr.newSubPath();
        cr.arc(w - r, r, r, -Math.PI / 2, 0);
        cr.arc(w - r, h - r, r, 0, Math.PI / 2);
        cr.arc(r, h - r, r, Math.PI / 2, Math.PI);
        cr.arc(r, r, r, Math.PI, 1.5 * Math.PI);
        cr.closePath();
        cr.clip();
        cr.setSourceRGB(0.078, 0.067, 0.169);
        cr.paint();
        const n = this._cells.length;
        cr.setLineCap(Cairo.LineCap.ROUND);
        for (const cell of this._cells) {
            const d = Math.sqrt((cell.i + 0.5) / n);
            const x = w / 2 + d * w * 0.46 * Math.cos(cell.i * GOLDEN);
            const y = h / 2 + d * h * 0.44 * Math.sin(cell.i * GOLDEN);
            const glow = Math.exp(-(t - cell.lit) / 0.35);
            const mix = (a, b) => a + (b - a) * glow;
            const color = [mix(0.42, 0.239), mix(0.40, 1.0), mix(0.62, 0.635)];
            const size = 7;
            cr.setSourceRGBA(...color, 0.9);
            cr.setLineWidth(1.6);
            for (let k = 0; k < 5; k++) {
                const a = cell.i + k * 2 * Math.PI / 5;
                cr.moveTo(x + Math.cos(a) * size * 0.8, y + Math.sin(a) * size * 0.8);
                cr.lineTo(x + Math.cos(a) * size * 1.9, y + Math.sin(a) * size * 1.9);
            }
            cr.stroke();
            if (glow > 0.03) {
                cr.setSourceRGBA(0.239, 1.0, 0.635, 0.25 * glow);
                cr.arc(x, y, size * (1.6 + 1.4 * glow), 0, 2 * Math.PI);
                cr.fill();
            }
            cr.setSourceRGB(...color);
            cr.arc(x, y, size, 0, 2 * Math.PI);
            cr.fill();
        }
    }
}

function combo(title, options, get, set, subtitle = '') {
    const row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(options.map(o => o[1]))});
    const sync = () => {
        const i = options.findIndex(o => o[0] === get());
        if (i >= 0 && row.selected !== i)
            row.selected = i;
    };
    sync();
    row.connect('notify::selected', () => {
        const value = options[row.selected]?.[0];
        if (value && value !== get())
            set(value);
    });
    row._sync = sync;
    return row;
}

function slider(settings, key, title, lo, hi, step, subtitle = '') {
    const row = new Adw.ActionRow({title, subtitle});
    const scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, lo, hi, step);
    scale.set_draw_value(false);
    scale.set_size_request(240, -1);
    scale.set_valign(Gtk.Align.CENTER);
    settings.bind(key, scale.get_adjustment(), 'value', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(scale);
    return row;
}

function entry(settings, key, title) {
    const row = new Adw.EntryRow({title, text: settings.get_string(key), show_apply_button: true});
    row.connect('apply', () => settings.set_string(key, row.text.trim()));
    return row;
}

export function buildAppWindow(app, path, version, settings) {
    const display = Gdk.Display.get_default();
    const provider = new Gtk.CssProvider();
    const css = CSS + (Gtk.get_minor_version() >= 16 ? CSS_VARS : '');
    if (provider.load_from_string)
        provider.load_from_string(css);
    else
        provider.load_from_data(css, -1);
    Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

    const window = new Adw.ApplicationWindow({application: app, title: 'Evoked', default_width: 640, default_height: 860});
    window.add_css_class('evoked');
    const toasts = new Adw.ToastOverlay();
    const toast = (title, timeout = 4) => toasts.add_toast(new Adw.Toast({title, timeout}));
    const engine = new Engine();
    window.connect('close-request', () => {
        engine.destroy();
        return false;
    });

    const page = new Adw.PreferencesPage();

    // ---------------------------------------------------------- hero
    const top = new Adw.PreferencesGroup();
    const hero = new Hero();
    top.add(hero.widget);
    const setup = new Gtk.Label({
        label: 'One more step: log out and back in once, so GNOME can load Evoked. After that it is ready whenever you are.',
        wrap: true, xalign: 0, css_classes: ['evoked-notice'], margin_top: 14, visible: false,
    });
    top.add(setup);
    page.add(top);

    // ---------------------------------------------------------- room neuron
    const roomGroup = new Adw.PreferencesGroup({
        title: 'Room neuron',
        description: 'A neuron in the corner of your slides that fires when the room gets loud: clapping, laughter, a lively question.',
    });
    const roomSwitch = new Adw.SwitchRow({title: 'Listen to the room'});
    roomGroup.add(roomSwitch);
    roomGroup.add(slider(settings, 'sensitivity', 'Sensitivity', 0.2, 4, 0.1, 'Turn it up in a big hall, down if your own voice sets it off.'));
    const rasterRow = new Adw.ActionRow({title: 'The raster of this talk', subtitle: 'Every spike so far, on one timeline. A good last slide.'});
    const showRaster = new Gtk.Button({label: 'Show', valign: Gtk.Align.CENTER});
    const saveRaster = new Gtk.Button({label: 'Save picture', valign: Gtk.Align.CENTER});
    const newTalk = new Gtk.Button({label: 'New talk', valign: Gtk.Align.CENTER, css_classes: ['flat']});
    rasterRow.add_suffix(newTalk);
    rasterRow.add_suffix(saveRaster);
    rasterRow.add_suffix(showRaster);
    roomGroup.add(rasterRow);
    page.add(roomGroup);

    // ---------------------------------------------------------- audience brain
    const brainGroup = new Adw.PreferencesGroup({
        title: 'Audience brain',
        description: 'Every phone in the room becomes one neuron on your slides. People scan a code; there is nothing to install.',
    });
    const brainSwitch = new Adw.SwitchRow({title: 'Run a session'});
    brainGroup.add(brainSwitch);
    const session = new Adw.ActionRow({title: 'Not running', subtitle: 'Start a session to get a join code.'});
    const code = new Gtk.Label({css_classes: ['evoked-code'], valign: Gtk.Align.CENTER, selectable: true});
    session.add_suffix(code);
    brainGroup.add(session);
    const joinSwitch = new Adw.SwitchRow({title: 'Show the join code on screen', subtitle: 'A large QR code over your slides, until you hide it.'});
    brainGroup.add(joinSwitch);
    const mode = combo('What the room does', MODES, () => engine.state?.brain.mode ?? 'free', value => engine.call('Mode', value));
    brainGroup.add(mode);
    const modeHelp = new Adw.ActionRow({title: ''});
    const wave = new Gtk.Button({label: 'Send a wave', valign: Gtk.Align.CENTER, css_classes: ['suggested-action', 'evoked-pill'], visible: false});
    modeHelp.add_suffix(wave);
    brainGroup.add(modeHelp);
    const labelA = new Adw.EntryRow({title: 'First choice', text: settings.get_strv('vote-labels')[0] ?? 'A', show_apply_button: true});
    const labelB = new Adw.EntryRow({title: 'Second choice', text: settings.get_strv('vote-labels')[1] ?? 'B', show_apply_button: true});
    const applyLabels = () => settings.set_strv('vote-labels', [labelA.text.trim() || 'A', labelB.text.trim() || 'B']);
    labelA.connect('apply', applyLabels);
    labelB.connect('apply', applyLabels);
    brainGroup.add(labelA);
    brainGroup.add(labelB);
    page.add(brainGroup);

    // ---------------------------------------------------------- settings
    const look = new Adw.PreferencesGroup({title: 'On screen'});
    look.add(combo('Corner', CORNERS, () => settings.get_string('corner'), value => settings.set_string('corner', value)));
    look.add(slider(settings, 'panel-scale', 'Size', 0.6, 2, 0.05));
    page.add(look);

    const keys = new Adw.PreferencesGroup({title: 'Shortcuts', description: 'They work while you present, over fullscreen slides.'});
    for (const [key, label] of [['room-shortcut', 'Room neuron on or off'], ['brain-shortcut', 'Audience brain on or off'],
        ['join-shortcut', 'Show or hide the join code'], ['wave-shortcut', 'Send a wave'], ['raster-shortcut', 'Show or hide the raster']]) {
        const row = new Adw.ActionRow({title: label});
        row.add_suffix(new Gtk.ShortcutLabel({accelerator: settings.get_strv(key)[0] ?? '', disabled_text: 'Off', valign: Gtk.Align.CENTER}));
        keys.add(row);
    }
    page.add(keys);

    const advanced = new Adw.PreferencesGroup({
        title: 'Connection',
        description: 'Phones reach your laptop through a relay server on the internet. Only taps travel through it: ' +
            'a random id and which button was pressed. The microphone is never sent anywhere; only its loudness is measured, on this computer.',
    });
    advanced.add(entry(settings, 'relay-url', 'Relay server (MQTT over WebSocket)'));
    advanced.add(entry(settings, 'join-url', 'Join page'));
    const reset = new Adw.ActionRow({title: 'Use the default relay and join page', activatable: true});
    reset.connect('activated', () => {
        settings.reset('relay-url');
        settings.reset('join-url');
        toast('Back to the defaults. Restart the session to use them.');
    });
    advanced.add(reset);
    page.add(advanced);

    const about = new Adw.PreferencesGroup({title: 'About'});
    const link = (title, subtitle, uri) => {
        const row = new Adw.ActionRow({title, subtitle, activatable: true});
        row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
        row.connect('activated', () => Gtk.show_uri(window, uri, Gdk.CURRENT_TIME));
        return row;
    };
    about.add(new Adw.ActionRow({title: 'Evoked', subtitle: `Version ${version ?? '1.0.0'}. Free and open source, MIT license.`}));
    about.add(link('Website', 'dabane-ghassan.github.io/evoked', 'https://dabane-ghassan.github.io/evoked/'));
    about.add(link('Source code', 'github.com/dabane-ghassan/evoked', 'https://github.com/dabane-ghassan/evoked'));
    about.add(link('Manicule', 'Its sibling: a little hand on a stick for pointing at your slides.', 'https://dabane-ghassan.github.io/manicule/'));
    const update = new Adw.ActionRow({title: 'Update Evoked', subtitle: 'Downloads and installs the latest version. Same as running “evoked update”.', activatable: true});
    const spinner = new Gtk.Spinner({visible: false});
    update.add_suffix(spinner);
    update.connect('activated', () => {
        if (spinner.visible)
            return;
        spinner.visible = true;
        spinner.start();
        const done = message => {
            spinner.stop();
            spinner.visible = false;
            toast(message, 8);
        };
        try {
            const url = 'https://raw.githubusercontent.com/dabane-ghassan/evoked/main/install.sh';
            const proc = Gio.Subprocess.new(['sh', '-c', `curl -fsSL ${url} | sh`],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.wait_check_async(null, (_p, result) => {
                try {
                    proc.wait_check_finish(result);
                    done('Updated. Log out and back in to start using the new version.');
                } catch (_e) {
                    done('The update did not finish. Check your connection and try again.');
                }
            });
        } catch (_e) {
            done('Could not start the update.');
        }
    });
    about.add(update);
    page.add(about);

    // ---------------------------------------------------------- behaviour
    let syncing = false;
    let lastSpikes = 0;
    const sync = s => {
        syncing = true;
        const ready = s !== null;
        setup.visible = !ready;
        for (const w of [roomSwitch, brainSwitch, showRaster, saveRaster, newTalk])
            w.sensitive = ready;
        const room = s?.room;
        const brain = s?.brain;
        roomSwitch.active = !!room?.active;
        roomSwitch.subtitle = !room?.active ? 'Off'
            : room.audio === 'ok' ? `Listening. ${room.spikes} spikes in ${Math.floor(room.seconds / 60)} min ${room.seconds % 60} s.`
                : room.audio === 'missing' ? 'gst-launch-1.0 is not installed, so the microphone cannot be heard. Install GStreamer’s tools.'
                    : room.audio === 'error' ? 'No microphone answered. Check the input device in Settings, Sound.'
                        : 'Starting…';
        showRaster.label = s?.rasterVisible ? 'Hide' : 'Show';

        const running = !!brain?.active;
        brainSwitch.active = running;
        joinSwitch.sensitive = running;
        joinSwitch.active = !!brain?.joinVisible;
        mode.sensitive = running;
        mode._sync();
        code.label = running ? brain.code : '';
        if (running) {
            const people = brain.people === 1 ? '1 neuron' : `${brain.people} neurons`;
            session.title = brain.relay === 'online' ? `${people} in the room`
                : brain.relay === 'connecting' ? 'Connecting to the relay…' : 'Cannot reach the relay. Retrying…';
            session.subtitle = brain.join;
        } else {
            session.title = 'Not running';
            session.subtitle = 'Start a session to get a join code.';
        }
        const m = brain?.mode ?? 'free';
        modeHelp.title = {
            free: 'Every tap is a spike. See if the room can fire in sync.',
            wave: 'Phones light up one after another, like a travelling wave.',
            vote: 'Two choices race to a line, pushed by taps. First to reach it wins.',
        }[m];
        wave.visible = m === 'wave';
        wave.sensitive = running && brain.people > 0;
        labelA.visible = labelB.visible = m === 'vote';

        // the patch of neurons in the header follows the audience when there is one
        const spikes = (brain?.spikes ?? 0) + (room?.spikes ?? 0);
        hero.activity = running || room?.active ? Math.min(30, 0.3 + (spikes - lastSpikes) * 1.5) : 0.6;
        lastSpikes = spikes;
        syncing = false;
    };
    roomSwitch.connect('notify::active', () => !syncing && engine.call('Room', roomSwitch.active ? 'on' : 'off'));
    brainSwitch.connect('notify::active', () => !syncing && engine.call('Brain', brainSwitch.active ? 'on' : 'off'));
    joinSwitch.connect('notify::active', () => !syncing && engine.call('Join', joinSwitch.active ? 'on' : 'off'));
    showRaster.connect('clicked', () => engine.call('Raster', 'toggle'));
    newTalk.connect('clicked', () => engine.call('NewTalk', null, () => toast('A new talk: the count starts from zero.')));
    saveRaster.connect('clicked', () => engine.call('SaveRaster', null, saved => toast(saved ? `Saved to ${saved}` : 'Could not save the picture.', 6)));
    wave.connect('clicked', () => engine.call('Wave'));
    engine.watch(sync);

    const view = new Adw.ToolbarView({content: page});
    view.add_top_bar(new Adw.HeaderBar());
    toasts.set_child(view);
    window.set_content(toasts);
    return window;
}
