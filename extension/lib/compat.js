// Small shims so one code base runs on GNOME Shell 45 through 51.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

export function getSeat() {
    // Clutter.get_default_backend() was removed in GNOME 51.
    const backend = Clutter.get_default_backend
        ? Clutter.get_default_backend()
        : global.stage.context.get_backend();
    return backend.get_default_seat();
}

const hasOrientation = !!GObject.Object.find_property.call(St.BoxLayout, 'orientation');

/** St.BoxLayout's `vertical` was replaced by `orientation` (deprecated in 48, removed in 51). */
export function boxProps(vertical, props = {}) {
    if (hasOrientation)
        return {...props, orientation: vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL};
    return {...props, vertical};
}

export function setUnredirect(disabled) {
    // Keeps fullscreen windows composited so the overlay can be drawn above them (matters on X11).
    try {
        if (global.compositor?.disable_unredirect) {
            if (disabled)
                global.compositor.disable_unredirect();
            else
                global.compositor.enable_unredirect();
        } else if (Meta.disable_unredirect_for_display) {
            if (disabled)
                Meta.disable_unredirect_for_display(global.display);
            else
                Meta.enable_unredirect_for_display(global.display);
        }
    } catch (e) {
        console.warn(`Evoked: unredirect toggle failed: ${e.message}`);
    }
}

export function scaleFactor() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
}
