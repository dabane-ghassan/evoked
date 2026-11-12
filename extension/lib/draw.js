// Small cairo helpers shared by the panels.

export const INK = [0.078, 0.067, 0.169];        // #14112B, the card
export const MINT = [0.239, 1.0, 0.635];         // #3DFFA2, a spike
export const PINK = [1.0, 0.310, 0.639];         // #FF4FA3
export const AMBER = [1.0, 0.82, 0.25];
export const PAPER = [0.957, 0.945, 1.0];        // #F4F1FF, text on the card

export function roundRect(cr, x, y, w, h, r) {
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

export function mix(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** A neuron seen from above: a soma with a few dendrites. `glow` 0..1 lights it up. */
export function neuron(cr, x, y, r, glow, color = MINT, seed = 0) {
    const lit = mix([0.42, 0.40, 0.62], color, Math.min(1, glow));
    cr.setLineCap(1);
    cr.setSourceRGBA(...lit, 0.9);
    cr.setLineWidth(Math.max(1, r * 0.22));
    for (let i = 0; i < 5; i++) {
        const a = seed + i * 2 * Math.PI / 5 + 0.4 * Math.sin(seed * 3 + i);
        cr.moveTo(x + Math.cos(a) * r * 0.8, y + Math.sin(a) * r * 0.8);
        cr.lineTo(x + Math.cos(a) * r * 1.9, y + Math.sin(a) * r * 1.9);
    }
    cr.stroke();
    if (glow > 0.02) {
        cr.setSourceRGBA(...color, 0.28 * glow);
        cr.arc(x, y, r * (1.5 + 1.2 * glow), 0, 2 * Math.PI);
        cr.fill();
    }
    cr.setSourceRGB(...lit);
    cr.arc(x, y, r, 0, 2 * Math.PI);
    cr.fill();
    cr.setSourceRGBA(1, 1, 1, 0.25 + 0.5 * glow);
    cr.arc(x - r * 0.3, y - r * 0.3, r * 0.28, 0, 2 * Math.PI);
    cr.fill();
}
