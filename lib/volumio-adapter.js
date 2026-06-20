'use strict';

var childProcess = require('child_process');

function VolumioAdapter(options) {
  this.commandRouter = options.commandRouter;
  this.logger = options.logger;
  this.children = new Set();
  this.stopping = false;
  this.execTimeoutMs = options.execTimeoutMs || 5000;
}

VolumioAdapter.prototype.stop = function () {
  this.stopping = true;
  this.children.forEach(function (child) {
    try { child.kill('SIGTERM'); } catch (ignore) {}
  });
  this.children.clear();
};

VolumioAdapter.prototype.start = function () {
  this.stopping = false;
};

VolumioAdapter.prototype.snapshot = async function (withMdns) {
  var service = await this._serviceStatus();
  var playback = this._playbackState();
  var airplayPluginEnabled = this._airplayPluginEnabled();
  var onDemand = process.env.SHAIRPORT_SYNC_ON_DEMAND === 'true';
  var result = {
    service: service,
    activePlayback: playback.service === 'airplay_emulation' &&
      (playback.status === 'play' || playback.status === 'pause'),
    airplayPluginEnabled: airplayPluginEnabled,
    onDemand: onDemand,
    pluginStopping: this.stopping,
    rebooting: await this._isRebooting(),
    mdnsAvailable: false,
    mdnsAdvertised: null
  };

  if (withMdns && service.activeState === 'active') {
    var mdns = await this._mdnsStatus();
    result.mdnsAvailable = mdns.available;
    result.mdnsAdvertised = mdns.advertised;
  }
  return result;
};

VolumioAdapter.prototype.restartReceiver = function () {
  if (this.stopping) {
    return Promise.reject(new Error('Plugin is stopping'));
  }

  try {
    // This is Volumio's normal path. It regenerates /tmp/shairport-sync.conf
    // and then restarts only shairport-sync.service.
    var response = this.commandRouter.executeOnPlugin(
      'music_service',
      'airplay_emulation',
      'startShairportSync',
      ''
    );
    return Promise.resolve(response);
  } catch (error) {
    return Promise.reject(new Error('Volumio AirPlay restart call failed: ' + error.message));
  }
};

VolumioAdapter.prototype._serviceStatus = async function () {
  try {
    var output = await this._execFile('/bin/systemctl', [
      'show',
      'shairport-sync.service',
      '--no-page',
      '--property=ActiveState,SubState,Result,MainPID,ExecMainStatus,NRestarts'
    ]);
    var values = parseKeyValues(output.stdout);
    var status = {
      activeState: values.ActiveState || 'unknown',
      subState: values.SubState || 'unknown',
      result: values.Result || '',
      mainPid: Number(values.MainPID || 0),
      execMainStatus: Number(values.ExecMainStatus || 0),
      nRestarts: Number(values.NRestarts || 0),
      processState: null,
      commandTimedOut: false
    };
    if (status.mainPid > 0) {
      status.processState = await this._processState(status.mainPid);
    }
    return status;
  } catch (error) {
    return {
      activeState: 'unknown',
      subState: 'unknown',
      result: 'check-error',
      mainPid: 0,
      execMainStatus: 0,
      processState: null,
      commandTimedOut: error.code === 'ETIMEDOUT'
    };
  }
};

VolumioAdapter.prototype._processState = async function (pid) {
  try {
    var output = await this._execFile('/bin/ps', ['-o', 'stat=', '-p', String(pid)]);
    return output.stdout.trim().charAt(0) || null;
  } catch (error) {
    return null;
  }
};

VolumioAdapter.prototype._playbackState = function () {
  try {
    return this.commandRouter.stateMachine.getState() || {};
  } catch (error) {
    return {};
  }
};

VolumioAdapter.prototype._airplayPluginEnabled = function () {
  try {
    if (typeof this.commandRouter.getPluginEnabled === 'function') {
      return this.commandRouter.getPluginEnabled('music_service', 'airplay_emulation') !== false;
    }
    var plugin = this.commandRouter.pluginManager.getPlugin('music_service', 'airplay_emulation');
    return Boolean(plugin);
  } catch (error) {
    // Avoid disabling protection merely because an older Volumio release lacks
    // the convenience method. The service state still gates all recovery.
    return true;
  }
};

VolumioAdapter.prototype._isRebooting = async function () {
  try {
    var output = await this._execFile('/bin/systemctl', ['is-system-running']);
    var state = output.stdout.trim();
    return state === 'stopping' || state === 'offline';
  } catch (error) {
    return false;
  }
};

VolumioAdapter.prototype._mdnsStatus = async function () {
  try {
    var playerName = '';
    try {
      playerName = String(this.commandRouter.sharedVars.get('system.name') || '').toLowerCase();
    } catch (ignore) {}
    var output = await this._execFile('/usr/bin/avahi-browse', [
      '--parsable',
      '--terminate',
      '_raop._tcp'
    ]);
    var lines = output.stdout.split('\n').filter(function (line) {
      return line.charAt(0) === '=';
    });
    var advertised = lines.some(function (line) {
      if (!playerName) return true;
      var fields = line.split(';');
      var serviceName = String(fields[3] || '').toLowerCase();
      return serviceName === playerName || serviceName.endsWith('@' + playerName);
    });
    return { available: true, advertised: advertised };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { available: false, advertised: null };
    }
    return { available: true, advertised: false };
  }
};

VolumioAdapter.prototype._execFile = function (file, args) {
  var self = this;
  return new Promise(function (resolve, reject) {
    if (self.stopping) {
      reject(new Error('Plugin is stopping'));
      return;
    }
    var child = childProcess.execFile(file, args, {
      timeout: self.execTimeoutMs,
      maxBuffer: 128 * 1024,
      encoding: 'utf8'
    }, function (error, stdout, stderr) {
      self.children.delete(child);
      if (error) {
        reject(error);
      } else {
        resolve({ stdout: stdout, stderr: stderr });
      }
    });
    self.children.add(child);
  });
};

function parseKeyValues(text) {
  var result = {};
  String(text || '').split('\n').forEach(function (line) {
    var index = line.indexOf('=');
    if (index > 0) {
      result[line.slice(0, index)] = line.slice(index + 1);
    }
  });
  return result;
}

module.exports = {
  VolumioAdapter: VolumioAdapter,
  parseKeyValues: parseKeyValues
};
