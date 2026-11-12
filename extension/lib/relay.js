// Connection to the relay server: MQTT over a WebSocket, reconnecting on its own.

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {connectPacket, subscribePacket, publishPacket, PING, DISCONNECT, Parser} from './mqtt-core.js';

const KEEP_ALIVE = 30;

export class Relay {
    /** handlers: onMessage(topic, payload), onState('connecting' | 'online' | 'offline') */
    constructor(url, handlers) {
        this._url = url;
        this._handlers = handlers;
        this._session = new Soup.Session({timeout: 15});
        this._topics = new Set();
        this._retained = new Map();     // topic -> payload, sent again after a reconnect
        this._conn = null;
        this._online = false;
        this._closed = false;
        this._retry = 0;
        this._ping = 0;
        this._backoff = 1;
        this._open();
    }

    get online() {
        return this._online;
    }

    _state(state) {
        this._online = state === 'online';
        this._handlers.onState?.(state);
    }

    _open() {
        if (this._closed)
            return;
        this._state('connecting');
        let message;
        try {
            message = Soup.Message.new('GET', this._url);
        } catch (_e) {
            message = null;
        }
        if (!message) {
            this._state('offline');
            return;
        }
        this._session.websocket_connect_async(message, null, ['mqtt'], GLib.PRIORITY_DEFAULT, null, (session, result) => {
            let conn;
            try {
                conn = session.websocket_connect_finish(result);
            } catch (_e) {
                this._lost();
                return;
            }
            if (this._closed) {
                conn.close(Soup.WebsocketCloseCode.NORMAL, null);
                return;
            }
            this._conn = conn;
            const parser = new Parser();
            conn.connect('message', (_c, _type, bytes) => {
                for (const p of parser.push(bytes.toArray()))
                    this._packet(p);
            });
            conn.connect('closed', () => this._lost(conn));
            conn.connect('error', () => this._lost(conn));
            this._send(connectPacket(`evoked-${GLib.uuid_string_random().slice(0, 12)}`, KEEP_ALIVE));
        });
    }

    _packet(p) {
        if (p.type === 'connack') {
            if (p.code !== 0) {
                this._lost(this._conn);
                return;
            }
            this._backoff = 1;
            let id = 1;
            for (const topic of this._topics)
                this._send(subscribePacket(id++, topic));
            for (const [topic, payload] of this._retained)
                this._send(publishPacket(topic, payload, true));
            if (!this._ping) {
                this._ping = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, Math.floor(KEEP_ALIVE * 0.6), () => {
                    this._send(PING);
                    return GLib.SOURCE_CONTINUE;
                });
            }
            this._state('online');
        } else if (p.type === 'publish') {
            this._handlers.onMessage?.(p.topic, p.payload);
        }
    }

    _send(bytes) {
        if (!this._conn || this._conn.get_state() !== Soup.WebsocketState.OPEN)
            return false;
        try {
            this._conn.send_message(Soup.WebsocketDataType.BINARY, new GLib.Bytes(bytes));
            return true;
        } catch (_e) {
            return false;
        }
    }

    _lost(conn = null) {
        if (conn && conn !== this._conn)
            return;
        this._conn = null;
        if (this._ping) {
            GLib.source_remove(this._ping);
            this._ping = 0;
        }
        if (this._closed)
            return;
        this._state('offline');
        if (!this._retry) {
            this._retry = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._backoff, () => {
                this._retry = 0;
                this._open();
                return GLib.SOURCE_REMOVE;
            });
            this._backoff = Math.min(15, this._backoff * 2);
        }
    }

    subscribe(topic) {
        this._topics.add(topic);
        if (this._online)
            this._send(subscribePacket(this._topics.size, topic));
    }

    /** retain: the server keeps the latest value and hands it to anyone who joins later. */
    publish(topic, payload, retain = false) {
        if (retain)
            this._retained.set(topic, payload);
        return this._online && this._send(publishPacket(topic, payload, retain));
    }

    close() {
        this._closed = true;
        if (this._retry)
            GLib.source_remove(this._retry);
        if (this._ping)
            GLib.source_remove(this._ping);
        this._retry = this._ping = 0;
        if (this._conn) {
            // clear what we left on the server, then say goodbye
            for (const topic of this._retained.keys())
                this._send(publishPacket(topic, '', true));
            this._send(DISCONNECT);
            try {
                this._conn.close(Soup.WebsocketCloseCode.NORMAL, null);
            } catch (_e) {
                // already closed
            }
        }
        this._conn = null;
        this._online = false;
    }
}
