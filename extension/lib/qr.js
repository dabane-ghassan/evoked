// A small QR code encoder: text in, a square grid of dark and light modules out.
// Byte mode, error correction level M, versions 1 to 9 (up to 180 bytes), which is plenty
// for a join link. No dependencies, so the same file runs in GNOME Shell and in a browser.

// per version: [error-correction bytes per block, blocks in group 1, data bytes each, blocks in group 2, data bytes each]
const BLOCKS = [
    null,
    [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0],
    [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37],
];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46]];

// arithmetic in GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100)
        x ^= 0x11d;
}
for (let i = 255; i < 512; i++)
    EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function generator(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
        const next = new Array(poly.length + 1).fill(0);
        for (let j = 0; j < poly.length; j++) {
            next[j] ^= poly[j];
            next[j + 1] ^= mul(poly[j], EXP[i]);
        }
        poly = next;
    }
    return poly.slice(1);        // without the leading 1
}

function remainder(data, gen) {
    const out = new Array(gen.length).fill(0);
    for (const byte of data) {
        const factor = byte ^ out.shift();
        out.push(0);
        for (let i = 0; i < gen.length; i++)
            out[i] ^= mul(gen[i], factor);
    }
    return out;
}

function dataCapacity(version) {
    const [, n1, d1, n2, d2] = BLOCKS[version];
    return n1 * d1 + n2 * d2;
}

function codewords(bytes, version) {
    const capacity = dataCapacity(version);
    const bits = [];
    const put = (value, length) => {
        for (let i = length - 1; i >= 0; i--)
            bits.push((value >> i) & 1);
    };
    put(0b0100, 4);              // byte mode
    put(bytes.length, 8);
    for (const b of bytes)
        put(b, 8);
    put(0, Math.min(4, capacity * 8 - bits.length));
    while (bits.length % 8)
        bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8)
        data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11)
        data.push(pad);

    // split into blocks, add error correction to each, then interleave
    const [ec, n1, d1, n2, d2] = BLOCKS[version];
    const gen = generator(ec);
    const blocks = [];
    let at = 0;
    for (const [count, size] of [[n1, d1], [n2, d2]]) {
        for (let i = 0; i < count; i++) {
            const block = data.slice(at, at + size);
            at += size;
            blocks.push({data: block, ec: remainder(block, gen)});
        }
    }
    const out = [];
    for (let i = 0; i < Math.max(d1, d2); i++) {
        for (const b of blocks) {
            if (i < b.data.length)
                out.push(b.data[i]);
        }
    }
    for (let i = 0; i < ec; i++) {
        for (const b of blocks)
            out.push(b.ec[i]);
    }
    return out;
}

function bch(value, poly, degree) {
    let rem = value;
    for (let i = 0; i < degree; i++)
        rem = (rem << 1) ^ ((rem >> (degree - 1)) & 1 ? poly : 0);
    return rem & ((1 << degree) - 1);
}

const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (_x, y) => y % 2 === 0,
    x => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
    (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
    (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
];

function penalty(m) {
    const n = m.length;
    let score = 0;
    const line = get => {
        for (let a = 0; a < n; a++) {
            let run = 1;
            for (let b = 1; b <= n; b++) {
                if (b < n && get(a, b) === get(a, b - 1)) {
                    run++;
                } else {
                    if (run >= 5)
                        score += run - 2;
                    run = 1;
                }
            }
            // finder-like pattern 1011101 with four light modules on either side
            for (let b = 0; b + 10 < n; b++) {
                const s = [];
                for (let k = 0; k < 11; k++)
                    s.push(get(a, b + k) ? 1 : 0);
                const t = s.join('');
                if (t === '10111010000' || t === '00001011101')
                    score += 40;
            }
        }
    };
    line((a, b) => m[a][b]);
    line((a, b) => m[b][a]);
    let dark = 0;
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            if (m[y][x])
                dark++;
            if (x + 1 < n && y + 1 < n && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1])
                score += 3;
        }
    }
    score += Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10;
    return score;
}

/** Returns an array of rows, each an array of booleans (true = dark). */
export function qrMatrix(text) {
    const bytes = Array.from(new TextEncoder().encode(text));
    let version = 1;
    while (version <= 9 && bytes.length > dataCapacity(version) - 2)
        version++;
    if (version > 9)
        throw new Error('Text is too long for a QR code here.');
    const n = version * 4 + 17;
    const grid = Array.from({length: n}, () => new Array(n).fill(false));
    const fixed = Array.from({length: n}, () => new Array(n).fill(false));
    const set = (x, y, dark) => {
        grid[y][x] = dark;
        fixed[y][x] = true;
    };

    const finder = (cx, cy) => {
        for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
                const x = cx + dx;
                const y = cy + dy;
                if (x < 0 || y < 0 || x >= n || y >= n)
                    continue;
                const d = Math.max(Math.abs(dx), Math.abs(dy));
                set(x, y, d !== 2 && d !== 4);
            }
        }
    };
    finder(3, 3);
    finder(n - 4, 3);
    finder(3, n - 4);
    for (let i = 8; i < n - 8; i++) {
        set(i, 6, i % 2 === 0);
        set(6, i, i % 2 === 0);
    }
    const centres = ALIGN[version];
    for (const cy of centres) {
        for (const cx of centres) {
            if ((cx === 6 && cy === 6) || (cx === 6 && cy === n - 7) || (cx === n - 7 && cy === 6))
                continue;
            for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++)
                    set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
            }
        }
    }
    set(8, n - 8, true);         // the one module that is always dark

    const format = mask => {
        const data = mask;       // level M is 00 in the top two bits
        const value = ((data << 10) | bch(data, 0x537, 10)) ^ 0x5412;
        const bit = i => ((value >> i) & 1) === 1;
        for (let i = 0; i <= 5; i++)
            set(8, i, bit(i));
        set(8, 7, bit(6));
        set(8, 8, bit(7));
        set(7, 8, bit(8));
        for (let i = 9; i < 15; i++)
            set(14 - i, 8, bit(i));
        for (let i = 0; i < 8; i++)
            set(n - 1 - i, 8, bit(i));
        for (let i = 8; i < 15; i++)
            set(8, n - 15 + i, bit(i));
        set(8, n - 8, true);
    };
    format(0);                   // reserve the format area before placing data
    if (version >= 7) {
        const value = (version << 12) | bch(version, 0x1f25, 12);
        for (let i = 0; i < 18; i++) {
            const dark = ((value >> i) & 1) === 1;
            const a = n - 11 + (i % 3);
            const b = Math.floor(i / 3);
            set(a, b, dark);
            set(b, a, dark);
        }
    }

    // lay the bits out in the zigzag, right to left, skipping the fixed modules
    const words = codewords(bytes, version);
    let index = 0;
    for (let right = n - 1; right >= 1; right -= 2) {
        if (right === 6)
            right = 5;
        for (let step = 0; step < n; step++) {
            for (let j = 0; j < 2; j++) {
                const x = right - j;
                const upward = ((right + 1) & 2) === 0;
                const y = upward ? n - 1 - step : step;
                if (fixed[y][x])
                    continue;
                const bit = index < words.length * 8 ? (words[index >> 3] >> (7 - (index & 7))) & 1 : 0;
                grid[y][x] = bit === 1;
                index++;
            }
        }
    }

    let best = null;
    for (let mask = 0; mask < 8; mask++) {
        const trial = grid.map(row => row.slice());
        for (let y = 0; y < n; y++) {
            for (let x = 0; x < n; x++) {
                if (!fixed[y][x] && MASKS[mask](x, y))
                    trial[y][x] = !trial[y][x];
            }
        }
        // write this mask's format bits, copy the fixed modules across, then put the grid back
        const saved = grid.map(row => row.slice());
        format(mask);
        for (let y = 0; y < n; y++) {
            for (let x = 0; x < n; x++) {
                if (fixed[y][x])
                    trial[y][x] = grid[y][x];
            }
        }
        for (let y = 0; y < n; y++)
            grid[y] = saved[y];
        const score = penalty(trial);
        if (!best || score < best.score)
            best = {score, matrix: trial};
    }
    return best.matrix;
}
