// A stand-in for an audience member's phone, for the tests.
//   gjs -m tests/fake-phone.js <relay url> <room> <phone id>
// Reads commands on stdin, one per line:  hi | tap [choice] | bye | quit
// Prints what the presenter sends:        ctl {...}  /  go {...}
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const {Relay} = await import(`file://${here}/../extension/lib/relay.js`);

const [url, room, pid] = ARGV;
const base = `evoked/1/${room}`;
const loop = new GLib.MainLoop(null, false);
const queue = [];
const relay = new Relay(url, {
    onMessage: (topic, payload) => print(`${topic.slice(base.length + 1)} ${payload}`),
    onState: state => {
        printerr(`state ${state}`);
        if (state === 'online') {
            while (queue.length)
                relay.publish(...queue.shift());
        }
    },
});
relay.subscribe(`${base}/ctl`);
relay.subscribe(`${base}/go`);
const send = message => {
    const args = [`${base}/up/${pid}`, JSON.stringify(message)];
    if (relay.online)
        relay.publish(...args);
    else
        queue.push(args);
};

let UnixInput;
try {
    UnixInput = (await import('gi://GioUnix')).default.InputStream;
} catch (_e) {
    UnixInput = Gio.UnixInputStream;
}
const stdin = new Gio.DataInputStream({base_stream: new UnixInput({fd: 0, close_fd: false})});
const read = () => stdin.read_line_async(GLib.PRIORITY_DEFAULT, null, (s, res) => {
    const [line] = s.read_line_finish_utf8(res);
    if (line === null || line === 'quit') {
        relay.close();
        loop.quit();
        return;
    }
    const [cmd, arg] = line.trim().split(' ');
    if (cmd === 'hi')
        send({t: 'hi'});
    else if (cmd === 'tap')
        send({t: 'tap', n: 1, c: arg ? Number(arg) : 0});
    else if (cmd === 'bye')
        send({t: 'bye'});
    read();
});
read();
loop.run();
