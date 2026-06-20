'use strict';

var assert = require('assert');
var AirplayWatchdog = require('../lib/watchdog').AirplayWatchdog;

var tests = [];

function test(name, fn) {
  tests.push({ name: name, fn: fn });
}

function healthy(overrides) {
  return Object.assign({
    activeState: 'active',
    subState: 'running',
    result: 'success',
    mainPid: 123,
    execMainStatus: 0,
    processState: 'S'
  }, overrides || {});
}

function failed(overrides) {
  return Object.assign({
    activeState: 'failed',
    subState: 'failed',
    result: 'exit-code',
    mainPid: 0,
    execMainStatus: 1,
    processState: null
  }, overrides || {});
}

function snapshot(service, overrides) {
  return Object.assign({
    service: service,
    activePlayback: false,
    airplayPluginEnabled: true,
    onDemand: false,
    pluginStopping: false,
    rebooting: false,
    mdnsAvailable: false,
    mdnsAdvertised: null
  }, overrides || {});
}

function FakeAdapter(snapshots, restartError) {
  this.snapshots = snapshots.slice();
  this.restartError = restartError;
  this.restarts = 0;
}

FakeAdapter.prototype.snapshot = function () {
  if (!this.snapshots.length) throw new Error('No fake snapshot available');
  return Promise.resolve(this.snapshots.shift());
};

FakeAdapter.prototype.restartReceiver = function () {
  this.restarts += 1;
  if (this.restartError) return Promise.reject(this.restartError);
  return Promise.resolve();
};

function fixture(snapshots, settings, restartError) {
  var time = 1000000;
  var adapter = new FakeAdapter(snapshots, restartError);
  var watchdog = new AirplayWatchdog({
    adapter: adapter,
    now: function () { return time; },
    sleep: function () { return Promise.resolve(); },
    settings: Object.assign({
      unhealthyThreshold: 2,
      mdnsFailureThreshold: 3,
      verificationDelayMs: 0,
      baseBackoffMs: 100,
      maxBackoffMs: 1000,
      rollingWindowMs: 10000,
      rollingRestartLimit: 3,
      cooldownMs: 5000
    }, settings || {})
  });
  watchdog.start();
  return {
    adapter: adapter,
    watchdog: watchdog,
    advance: function (ms) { time += ms; },
    now: function () { return time; }
  };
}

test('healthy service is left alone', async function () {
  var f = fixture([snapshot(healthy())]);
  var result = await f.watchdog.check();
  assert.strictEqual(result.reason, 'healthy');
  assert.strictEqual(f.adapter.restarts, 0);
});

test('one unexpected crash is confirmed then recovered', async function () {
  var f = fixture([
    snapshot(failed()),
    snapshot(failed()),
    snapshot(healthy())
  ]);
  assert.strictEqual((await f.watchdog.check()).reason, 'service-failed-unconfirmed');
  var result = await f.watchdog.check();
  assert.strictEqual(result.action, 'recovered');
  assert.strictEqual(result.verified, true);
  assert.strictEqual(f.adapter.restarts, 1);
});

test('failed restart is recorded and backed off', async function () {
  var f = fixture([
    snapshot(failed()),
    snapshot(failed())
  ], null, new Error('restart denied'));
  await f.watchdog.check();
  var result = await f.watchdog.check();
  assert.strictEqual(result.action, 'recover-failed');
  assert.strictEqual(f.adapter.restarts, 1);
  assert.ok(f.watchdog.nextAttemptAt > f.now());
  assert.strictEqual(f.watchdog.getStatus().status.reason, 'restart-failed');
});

test('repeated crashes enter exponential backoff and cooldown', async function () {
  var snapshots = [];
  for (var i = 0; i < 9; i += 1) snapshots.push(snapshot(failed()));
  snapshots.splice(2, 0, snapshot(failed()));
  snapshots.splice(5, 0, snapshot(failed()));
  snapshots.splice(8, 0, snapshot(failed()));
  var f = fixture(snapshots, { unhealthyThreshold: 1 });

  var first = await f.watchdog.check();
  assert.strictEqual(first.action, 'recovered');
  f.advance(100);
  var second = await f.watchdog.check();
  assert.strictEqual(second.action, 'recovered');
  f.advance(200);
  var third = await f.watchdog.check();
  assert.strictEqual(third.action, 'recovered');
  f.advance(400);
  var limited = await f.watchdog.check();
  assert.strictEqual(limited.state, 'cooldown');
  assert.strictEqual(limited.reason, 'rolling-restart-limit');
  assert.strictEqual(f.adapter.restarts, 3);
});

test('intentional shutdown and on-demand idle are not restarted', async function () {
  var cleanStop = healthy({
    activeState: 'inactive',
    subState: 'dead',
    mainPid: 0,
    processState: null
  });
  var f = fixture([
    snapshot(cleanStop, { pluginStopping: true }),
    snapshot(cleanStop, { onDemand: true })
  ]);
  assert.strictEqual((await f.watchdog.check()).reason, 'intentional-lifecycle-state');
  assert.strictEqual((await f.watchdog.check()).reason, 'on-demand-intentional-stop');
  assert.strictEqual(f.adapter.restarts, 0);
});

test('active healthy AirPlay playback is never interrupted', async function () {
  var f = fixture([
    snapshot(healthy(), {
      activePlayback: true,
      mdnsAvailable: true,
      mdnsAdvertised: false
    })
  ], { mdnsCheckEnabled: true, mdnsFailureThreshold: 1 });
  var result = await f.watchdog.check();
  assert.strictEqual(result.reason, 'mdns-missing-active-playback');
  assert.strictEqual(f.adapter.restarts, 0);
});

test('ambiguous process stall during active playback is not restarted', async function () {
  var f = fixture([
    snapshot(healthy({ processState: 'D' }), { activePlayback: true })
  ], { unhealthyThreshold: 1 });
  var result = await f.watchdog.check();
  assert.strictEqual(result.reason, 'active-playback-health-ambiguous');
  assert.strictEqual(f.adapter.restarts, 0);
});

test('plugin disable and uninstall stop all watchdog actions', async function () {
  var f = fixture([
    snapshot(failed(), { airplayPluginEnabled: false })
  ], { unhealthyThreshold: 1 });
  assert.strictEqual((await f.watchdog.check()).reason, 'intentional-lifecycle-state');
  f.watchdog.stop();
  assert.strictEqual((await f.watchdog.check()).reason, 'watchdog-stopped');
  assert.strictEqual(f.adapter.restarts, 0);
});

test('missing mDNS advertisement is confirmed and repaired', async function () {
  var missing = snapshot(healthy(), {
    mdnsAvailable: true,
    mdnsAdvertised: false
  });
  var f = fixture([
    missing,
    missing,
    missing,
    snapshot(healthy(), { mdnsAvailable: true, mdnsAdvertised: true })
  ], {
    mdnsCheckEnabled: true,
    mdnsFailureThreshold: 3
  });
  await f.watchdog.check();
  await f.watchdog.check();
  var result = await f.watchdog.check();
  assert.strictEqual(result.action, 'recovered');
  assert.strictEqual(result.verified, true);
  assert.strictEqual(f.adapter.restarts, 1);
});

test('clean inactive service gets a grace period before recovery', async function () {
  var cleanStop = healthy({
    activeState: 'inactive',
    subState: 'dead',
    mainPid: 0,
    processState: null
  });
  var f = fixture([
    snapshot(cleanStop),
    snapshot(cleanStop),
    snapshot(cleanStop),
    snapshot(healthy())
  ], {
    cleanInactiveGraceMs: 1000,
    unhealthyThreshold: 1
  });
  assert.strictEqual((await f.watchdog.check()).reason, 'clean-stop-grace-period');
  f.advance(500);
  assert.strictEqual((await f.watchdog.check()).reason, 'clean-stop-grace-period');
  f.advance(500);
  assert.strictEqual((await f.watchdog.check()).action, 'recovered');
});

(async function run() {
  var failures = 0;
  for (var i = 0; i < tests.length; i += 1) {
    try {
      await tests[i].fn();
      process.stdout.write('ok - ' + tests[i].name + '\n');
    } catch (error) {
      failures += 1;
      process.stderr.write('not ok - ' + tests[i].name + '\n');
      process.stderr.write(String(error.stack || error) + '\n');
    }
  }
  process.stdout.write('\n' + (tests.length - failures) + '/' + tests.length + ' tests passed\n');
  process.exitCode = failures ? 1 : 0;
}());
