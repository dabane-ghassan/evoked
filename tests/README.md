# Tests

`python3 tests/run.py` (or `make test`) starts a private, headless GNOME Shell, loads the
extension from this checkout and plays a talk at it:

- the **room neuron** hears a scripted "microphone" (`fake-mic.py` prints loudness in the same
  format as the real listener), so quiet, applause and adaptation can be checked exactly;
- the **audience brain** connects to a local relay server (mosquitto) and twelve simulated
  phones (`fake-phone.js`) join, tap, vote and leave;
- if Node and Playwright are installed, the **real join page** is opened in headless Chrome as
  three more phones, and tapped;
- the QR code is read back off a screenshot with `zbarimg`, when that is installed.

Screenshots are saved to `tests/out/`. Nothing touches your own session or settings.

You need `gnome-shell`, `gjs`, GTK 4 and `mosquitto` (or set `EVOKED_TEST_RELAY=ws://host:port`
to use a relay that is already running). In a container, start a system bus first with
`dbus-daemon --system --fork`.

What these tests cannot show: a real microphone in a real room, real phones on a real network,
and the public relay server. Those need a person.
