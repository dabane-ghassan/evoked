// The few MQTT 3.1.1 packets Evoked needs, as plain functions on bytes.
// No imports, so the same file runs in GNOME Shell (over Soup) and in the phone's browser.

const enc = new TextEncoder();
const dec = new TextDecoder();

function str(s) {
    const b = enc.encode(s);
    return [b.length >> 8, b.length & 255, ...b];
}

function packet(type, flags, body) {
    const length = [];
    let n = body.length;
    do {
        let digit = n % 128;
        n = Math.floor(n / 128);
        if (n > 0)
            digit |= 128;
        length.push(digit);
    } while (n > 0);
    return Uint8Array.from([(type << 4) | flags, ...length, ...body]);
}

/** will: {topic, payload} published by the server if this client vanishes. */
export function connectPacket(clientId, keepAlive = 30, will = null) {
    let flags = 0x02;            // clean session
    const payload = [...str(clientId)];
    if (will) {
        flags |= 0x04;
        payload.push(...str(will.topic), ...str(will.payload));
    }
    return packet(1, 0, [...str('MQTT'), 4, flags, keepAlive >> 8, keepAlive & 255, ...payload]);
}

export function subscribePacket(id, topic) {
    return packet(8, 2, [id >> 8, id & 255, ...str(topic), 0]);
}

export function publishPacket(topic, payload, retain = false) {
    return packet(3, retain ? 1 : 0, [...str(topic), ...enc.encode(payload)]);
}

export const PING = Uint8Array.from([0xc0, 0]);
export const DISCONNECT = Uint8Array.from([0xe0, 0]);

/** Feed it bytes as they arrive; it returns the complete packets found so far. */
export class Parser {
    constructor() {
        this._buf = new Uint8Array(0);
    }

    push(chunk) {
        const joined = new Uint8Array(this._buf.length + chunk.length);
        joined.set(this._buf);
        joined.set(chunk, this._buf.length);
        this._buf = joined;

        const out = [];
        for (;;) {
            const buf = this._buf;
            if (buf.length < 2)
                break;
            let length = 0;
            let shift = 0;
            let at = 1;
            let complete = false;
            while (at < buf.length && at <= 4) {
                const digit = buf[at++];
                length += (digit & 127) << shift;
                shift += 7;
                if (!(digit & 128)) {
                    complete = true;
                    break;
                }
            }
            if (!complete || buf.length < at + length)
                break;
            const type = buf[0] >> 4;
            const body = buf.subarray(at, at + length);
            if (type === 3) {
                const qos = (buf[0] >> 1) & 3;
                const topicLength = (body[0] << 8) | body[1];
                const topic = dec.decode(body.subarray(2, 2 + topicLength));
                const payload = dec.decode(body.subarray(2 + topicLength + (qos ? 2 : 0)));
                out.push({type: 'publish', topic, payload});
            } else if (type === 2) {
                out.push({type: 'connack', code: body[1]});
            } else if (type === 9) {
                out.push({type: 'suback'});
            } else if (type === 13) {
                out.push({type: 'pong'});
            }
            this._buf = buf.slice(at + length);
        }
        return out;
    }
}
