# AirPlay Watchdog for Volumio

AirPlay Watchdog monitors Volumio's built-in `shairport-sync.service` and performs
bounded recovery after a confirmed unexpected failure. It is deliberately
conservative: it does not replace Volumio's AirPlay plugin, edit its
configuration, expose a network endpoint, or restart Avahi.

## Architecture

The plugin has three small layers:

- `index.js` implements the normal Volumio plugin lifecycle and settings UI.
- `lib/volumio-adapter.js` gathers read-only systemd, process, playback and
  optional Avahi state. Recovery is requested through Volumio's built-in
  `music_service/airplay_emulation.startShairportSync` method.
- `lib/watchdog.js` is a testable state machine. It confirms failures, respects
  intentional lifecycle states and on-demand AirPlay, applies exponential
  backoff, limits restarts in a rolling window, enters cooldown, and verifies
  recovery.

Defaults are a 30-second interval, two failed checks before service recovery,
three failed advertisement checks, at most three automatic restarts in 15
minutes, and a 30-minute cooldown. The optional mDNS check is off by default.

An active, healthy AirPlay session is never restarted. A missing advertisement
is only repaired after repeated failures and only while AirPlay is inactive.
The repair restarts Shairport alone through Volumio; it does not bounce
`avahi-daemon` or any unrelated service.

## Volumio compatibility assumptions

This release targets Volumio 3 on Buster and Bookworm with Node.js 14 or newer.
It follows the AirPlay lifecycle in the official `volumio3-backend` source as
inspected on June 20, 2026 (backend commit
`9938d7179e3b7c4e41f3e2d60c255985cff08fee`):

- Volumio owns `/tmp/shairport-sync.conf`.
- Volumio starts and gracefully restarts Shairport through the built-in
  `airplay_emulation` plugin.
- `SHAIRPORT_SYNC_ON_DEMAND=true` permits an intentionally inactive receiver.
- A normal AirPlay stop may use `USR2` followed by a receiver restart.

The watchdog treats clean stops as intentional for a grace period and never
starts an idle on-demand receiver. It uses standard systemd properties available
on current Volumio 3 images. If `avahi-browse` is unavailable, the optional mDNS
test is reported unavailable and is not used to trigger recovery.

## Install

Copy this directory to a Volumio device, then from inside it run:

```sh
volumio plugin install
```

Enable **AirPlay Watchdog** under Plugins → System Controller, then open its
settings. No extra packages, service units, custom HTTP endpoints, or remote
command facilities are installed.

For development, Volumio's standard upload flow can also be used:

```sh
volumio plugin package
```

## Test and validate

On a development machine with Node.js 14 or newer:

```sh
npm install
npm run validate
```

The automated state-machine suite covers healthy service, unexpected crash,
failed restart, repeated crash/backoff/cooldown, intentional stop, active AirPlay
playback, plugin disable/stop, missing mDNS advertisement, and clean-stop grace.

On a Volumio test device, verify the package and UI, then safely exercise a
failure while no AirPlay session is active:

```sh
sudo systemctl kill --signal=SIGKILL shairport-sync.service
```

Do not run fault-injection commands during playback. Confirm that the watchdog
waits for confirmation, invokes Volumio recovery, and reports verification.
Also test with `SHAIRPORT_SYNC_ON_DEMAND=true` if the target release uses that
mode; an idle clean stop must remain stopped.

## Logs and diagnostics

Watch all Volumio logs and filter the watchdog:

```sh
journalctl -fu volumio | grep --line-buffered "AirPlay Watchdog"
```

Inspect the receiver service:

```sh
journalctl -fu shairport-sync.service
systemctl status shairport-sync.service
systemctl show shairport-sync.service \
  -p ActiveState -p SubState -p Result -p MainPID -p ExecMainStatus -p NRestarts
```

Inspect local AirPlay advertisements:

```sh
avahi-browse --parsable --terminate _raop._tcp
```

Logs contain the failure reason, compact service state, restart attempt,
verification result, and current backoff or cooldown.

## Permissions

No new sudoers rule is required. Health checks (`systemctl show`, `ps`, and
optional `avahi-browse`) are unprivileged. Recovery calls Volumio's built-in
AirPlay plugin, which already uses Volumio's established permission to restart
`shairport-sync.service`.

If a customized image removes that existing permission, fix the image's normal
Volumio/Shairport integration rather than granting this plugin broad sudo.

## Safe rollback

1. Disable **AirPlay Watchdog** in the Volumio plugin UI. Its timers and active
   subprocesses are stopped immediately.
2. Confirm AirPlay still behaves normally through Volumio's built-in AirPlay
   plugin.
3. Uninstall AirPlay Watchdog from the plugin UI, or run:

   ```sh
   volumio plugin uninstall airplay_watchdog
   ```

Uninstalling removes only this plugin. It does not alter
`shairport-sync.service`, Avahi, Volumio's AirPlay configuration, or sudoers.

## Upstream references

- [Volumio developer documentation](https://developers.volumio.com/)
- [Volumio 3 backend AirPlay implementation](https://github.com/volumio/volumio3-backend/blob/master/app/plugins/music_service/airplay_emulation/index.js)
- [Volumio plugin sources](https://github.com/volumio/volumio-plugins-sources)
- [Shairport Sync](https://github.com/mikebrady/shairport-sync)
