// Evoked: see what your talk evokes in the room.
// https://github.com/dabane-ghassan/evoked

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Brain, MODES} from './lib/brain.js';
import {Room} from './lib/room.js';
import {Stage} from './lib/stage.js';

const BUS_PATH = '/io/github/dabane_ghassan/Evoked';
const BUS_IFACE = 'io.github.dabane_ghassan.Evoked';
const XML = `
<node>
  <interface name="${BUS_IFACE}">
    <method name="Room"><arg type="s" direction="in" name="value"/></method>
    <method name="Brain"><arg type="s" direction="in" name="value"/></method>
    <method name="Mode"><arg type="s" direction="in" name="mode"/><arg type="b" direction="out" name="ok"/></method>
    <method name="Wave"><arg type="b" direction="out" name="sent"/></method>
    <method name="Join"><arg type="s" direction="in" name="value"/></method>
    <method name="Raster"><arg type="s" direction="in" name="value"/></method>
    <method name="SaveRaster"><arg type="s" direction="out" name="path"/></method>
    <method name="NewTalk"/>
    <method name="GetState"><arg type="s" direction="out" name="json"/></method>
    <signal name="StateChanged"><arg type="s" name="json"/></signal>
  </interface>
</node>`;

const MODE_TITLES = {free: 'Free firing', wave: 'Wave', vote: 'Vote'};
const flip = (value, current) => value === 'on' ? true : value === 'off' ? false : !current;

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'Evoked');
        this._ext = ext;
        const icon = name => Gio.icon_new_for_string(GLib.build_filenamev([ext.path, 'assets', name]));
        this._off = icon('evoked-symbolic.svg');
        this._on = icon('evoked-on-symbolic.svg');
        this._icon = new St.Icon({gicon: this._off, style_class: 'system-status-icon'});
        this.add_child(this._icon);

        this._room = new PopupMenu.PopupSwitchMenuItem('Room neuron', false);
        this._room.connect('toggled', (_i, on) => ext.setRoom(on));
        this.menu.addMenuItem(this._room);

        this._brain = new PopupMenu.PopupSwitchMenuItem('Audience brain', false);
        this._brain.connect('toggled', (_i, on) => ext.setBrain(on));
        this.menu.addMenuItem(this._brain);

        this._join = new PopupMenu.PopupSwitchMenuItem('Show the join code', false);
        this._join.connect('toggled', (_i, on) => ext.brain.setJoinVisible(on));
        this.menu.addMenuItem(this._join);

        this._mode = new PopupMenu.PopupSubMenuMenuItem('Mode');
        this._modeItems = new Map();
        for (const mode of MODES) {
            const item = new PopupMenu.PopupMenuItem(MODE_TITLES[mode]);
            item.connect('activate', () => ext.brain.setMode(mode));
            this._modeItems.set(mode, item);
            this._mode.menu.addMenuItem(item);
        }
        this.menu.addMenuItem(this._mode);
        this._wave = this.menu.addAction('Send a wave', () => ext.brain.wave());

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._raster = this.menu.addAction('Show the raster of this talk', () => ext.setRaster(!ext.stage.summaryVisible));
        this.menu.addAction('Save the raster as a picture', () => ext.saveRaster());
        this.menu.addAction('Start a new talk', () => ext.newTalk());
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Open Evoked…', () => ext.openApp());
        this.menu.connect('open-state-changed', (_m, open) => open && this.sync());
        this.sync();
    }

    sync() {
        const {room, brain, stage} = this._ext;
        this._icon.gicon = room.active || brain.active ? this._on : this._off;
        this._room.setToggleState(room.active);
        this._brain.setToggleState(brain.active);
        this._join.setToggleState(brain.joinVisible);
        this._join.setSensitive(brain.active);
        this._mode.setSensitive(brain.active);
        this._mode.label.text = `Mode: ${MODE_TITLES[brain.mode]}`;
        this._wave.setSensitive(brain.active && brain.count > 0);
        for (const [mode, item] of this._modeItems)
            item.setOrnament(mode === brain.mode ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
        this._raster.label.text = stage.summaryVisible ? 'Hide the raster of this talk' : 'Show the raster of this talk';
    }
});

export default class EvokedExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this.room = new Room(this._settings);
        this.brain = new Brain(this._settings);
        this.stage = new Stage(this._settings, this.room, this.brain);

        this._dbus = Gio.DBusExportedObject.wrapJSObject(XML, this);
        this._dbus.export(Gio.DBus.session, BUS_PATH);
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        const changed = () => this._changed();
        this.room.onChanged = changed;
        this.brain.onChanged = changed;

        this._shortcuts = {
            'room-shortcut': () => this.setRoom(!this.room.active),
            'brain-shortcut': () => this.setBrain(!this.brain.active),
            'join-shortcut': () => this.brain.active && this.brain.setJoinVisible(!this.brain.joinVisible),
            'wave-shortcut': () => this.brain.wave(),
            'raster-shortcut': () => this.setRaster(!this.stage.summaryVisible),
        };
        for (const [name, handler] of Object.entries(this._shortcuts)) {
            Main.wm.addKeybinding(name, this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP, handler);
        }
    }

    disable() {
        // Also runs when the screen locks: the microphone listener and the session stop.
        for (const name of Object.keys(this._shortcuts))
            Main.wm.removeKeybinding(name);
        this.room.onChanged = null;
        this.brain.destroy();
        this.room.destroy();
        this.stage.destroy();
        this._dbus.unexport();
        this._indicator.destroy();
        this._indicator = this._dbus = this.stage = this.room = this.brain = this._settings = null;
    }

    _changed() {
        this.stage?.sync();
        this._indicator?.sync();
        try {
            this._dbus?.emit_signal('StateChanged', new GLib.Variant('(s)', [this.GetState()]));
        } catch (_e) {
            // nobody listening
        }
    }

    setRoom(on) {
        if (on)
            this.room.start();
        else
            this.room.stop();
    }

    setBrain(on) {
        if (on)
            this.brain.start();
        else
            this.brain.stop();
    }

    setRaster(on) {
        this.stage.summaryVisible = on;
        this._changed();
    }

    saveRaster() {
        const path = this.stage.saveSummary();
        if (path)
            Main.notify('Evoked', `Saved the raster of this talk to ${path}`);
        return path ?? '';
    }

    newTalk() {
        this.room.resetTalk();
        if (this.room.active)
            this.room.started = Date.now() / 1000;
        this._changed();
    }

    openApp() {
        try {
            Gio.Subprocess.new(['gjs', '-m', GLib.build_filenamev([this.path, 'app.js'])], Gio.SubprocessFlags.NONE);
        } catch (_e) {
            this.openPreferences();
        }
    }

    // ------------------------------------------------------------ D-Bus

    Room(value) { this.setRoom(flip(value, this.room.active)); }
    Brain(value) { this.setBrain(flip(value, this.brain.active)); }
    Join(value) { this.brain.active && this.brain.setJoinVisible(flip(value, this.brain.joinVisible)); }
    Raster(value) { this.setRaster(flip(value, this.stage.summaryVisible)); }
    SaveRaster() { return this.saveRaster(); }
    NewTalk() { this.newTalk(); }
    Wave() { return this.brain.wave(); }

    Mode(mode) {
        if (!MODES.includes(mode))
            return false;
        this.brain.setMode(mode);
        return true;
    }

    GetState() {
        const {room, brain} = this;
        return JSON.stringify({
            room: {active: room.active, audio: room.audio, rate: room.rate, spikes: room.total, seconds: room.seconds},
            brain: {
                active: brain.active, code: brain.room, mode: brain.mode, people: brain.count,
                relay: brain.relayState, join: brain.active ? brain.joinUrl : '', joinVisible: brain.joinVisible,
                labels: brain.labels, spikes: brain.totalSpikes, winner: brain.winner,
            },
            rasterVisible: this.stage.summaryVisible,
        });
    }
}
