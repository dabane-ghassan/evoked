// GNOME's own "extension settings" entry point: it just opens the Evoked app.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class EvokedPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({description: 'Evoked has its own window. Find it in your apps, or open it here.'});
        const row = new Adw.ActionRow({title: 'Open Evoked', activatable: true});
        row.connect('activated', () => {
            Gio.Subprocess.new(['gjs', '-m', GLib.build_filenamev([this.path, 'app.js'])], Gio.SubprocessFlags.NONE);
            window.close();
        });
        group.add(row);
        page.add(group);
        window.add(page);
    }
}
