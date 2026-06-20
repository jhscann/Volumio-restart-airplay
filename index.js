'use strict';

var libQ = require('kew');
var Watchdog = require('./lib/watchdog').AirplayWatchdog;
var VolumioAdapter = require('./lib/volumio-adapter').VolumioAdapter;

module.exports = ControllerAirplayWatchdog;

function ControllerAirplayWatchdog(context) {
  this.context = context;
  this.commandRouter = context.coreCommand;
  this.logger = context.logger;
  this.configManager = context.configManager;
  this.timer = null;
  this.startupTimer = null;
  this.stopping = false;
  this.adapter = null;
  this.watchdog = null;
}

ControllerAirplayWatchdog.prototype.onVolumioStart = function () {
  var configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
  this.config = new (require('v-conf'))();
  this.config.loadFile(configFile);
  return libQ.resolve();
};

ControllerAirplayWatchdog.prototype.onStart = function () {
  this.stopping = false;
  this.adapter = new VolumioAdapter({
    commandRouter: this.commandRouter,
    logger: this.logger
  });
  this.adapter.start();
  this.watchdog = new Watchdog({
    adapter: this.adapter,
    settings: this._settings(),
    log: this._log.bind(this)
  });
  this.watchdog.start();
  this._schedule();
  this._checkSoon();
  this.logger.info('[AirPlay Watchdog] started');
  return libQ.resolve();
};

ControllerAirplayWatchdog.prototype.onStop = function () {
  this.stopping = true;
  if (this.timer) {
    clearInterval(this.timer);
    this.timer = null;
  }
  if (this.startupTimer) {
    clearTimeout(this.startupTimer);
    this.startupTimer = null;
  }
  if (this.watchdog) {
    this.watchdog.stop();
  }
  if (this.adapter) {
    this.adapter.stop();
  }
  this.logger.info('[AirPlay Watchdog] stopped; timers and subprocesses cleaned up');
  return libQ.resolve();
};

ControllerAirplayWatchdog.prototype.onRestart = function () {
  return this.onStop().then(this.onStart.bind(this));
};

ControllerAirplayWatchdog.prototype.onInstall = function () {
  return libQ.resolve();
};

ControllerAirplayWatchdog.prototype.onUninstall = function () {
  return this.onStop();
};

ControllerAirplayWatchdog.prototype.onVolumioReboot = function () {
  return this.onStop();
};

ControllerAirplayWatchdog.prototype.getConfigurationFiles = function () {
  return ['config.json'];
};

ControllerAirplayWatchdog.prototype.getUIConfig = function () {
  var self = this;
  var language = this.commandRouter.sharedVars.get('language_code') || 'en';
  return this.commandRouter.i18nJson(
    __dirname + '/i18n/strings_' + language + '.json',
    __dirname + '/i18n/strings_en.json',
    __dirname + '/UIConfig.json'
  ).then(function (ui) {
    var settings = self._settings();
    ui.sections[0].content[0].value = settings.watchdogEnabled;
    ui.sections[0].content[1].value = {
      value: settings.checkIntervalSeconds,
      label: formatInterval(settings.checkIntervalSeconds)
    };
    ui.sections[0].content[2].value = settings.automaticRecovery;
    ui.sections[0].content[3].value = settings.mdnsCheckEnabled;

    var summary = self._statusSummary();
    ui.sections[1].content[0].label = 'Current status: ' + summary.current;
    ui.sections[1].content[0].doc = summary.current;
    ui.sections[1].content[1].label = 'Recent restart history: ' + summary.history;
    ui.sections[1].content[1].doc = summary.history;
    return ui;
  });
};

ControllerAirplayWatchdog.prototype.saveSettings = function (data) {
  var interval = data.checkIntervalSeconds;
  if (interval && typeof interval === 'object') interval = interval.value;
  interval = Number(interval);
  if ([15, 30, 60, 120].indexOf(interval) === -1) interval = 30;

  this.config.set('watchdogEnabled', Boolean(data.watchdogEnabled));
  this.config.set('checkIntervalSeconds', interval);
  this.config.set('automaticRecovery', Boolean(data.automaticRecovery));
  this.config.set('mdnsCheckEnabled', Boolean(data.mdnsCheckEnabled));

  if (this.watchdog) {
    this.watchdog.updateSettings(this._settings());
    this._schedule();
    this._checkSoon();
  }
  this.commandRouter.pushToastMessage('success', 'AirPlay Watchdog', 'Settings saved');
  return libQ.resolve({});
};

ControllerAirplayWatchdog.prototype.manualRestart = function () {
  var self = this;
  if (!this.watchdog || this.stopping) {
    this.commandRouter.pushToastMessage('error', 'AirPlay Watchdog', 'Plugin is not running');
    return libQ.reject(new Error('Plugin is not running'));
  }
  return Promise.resolve(this.watchdog.manualRestart()).then(function (result) {
    if (result.verified) {
      self.commandRouter.pushToastMessage('success', 'AirPlay Watchdog',
        'AirPlay receiver restarted and verified');
    } else {
      self.commandRouter.pushToastMessage('warning', 'AirPlay Watchdog',
        'Restart requested, but verification did not pass');
    }
    return result;
  });
};

ControllerAirplayWatchdog.prototype._settings = function () {
  return {
    watchdogEnabled: configBoolean(this.config, 'watchdogEnabled', true),
    checkIntervalSeconds: configNumber(this.config, 'checkIntervalSeconds', 30),
    automaticRecovery: configBoolean(this.config, 'automaticRecovery', true),
    mdnsCheckEnabled: configBoolean(this.config, 'mdnsCheckEnabled', false)
  };
};

ControllerAirplayWatchdog.prototype._schedule = function () {
  var self = this;
  if (this.timer) clearInterval(this.timer);
  this.timer = null;
  var settings = this._settings();
  if (!settings.watchdogEnabled || this.stopping) return;
  this.timer = setInterval(function () {
    self._runCheck();
  }, settings.checkIntervalSeconds * 1000);
};

ControllerAirplayWatchdog.prototype._checkSoon = function () {
  var self = this;
  if (!this._settings().watchdogEnabled || this.stopping) return;
  if (this.startupTimer) clearTimeout(this.startupTimer);
  this.startupTimer = setTimeout(function () {
    self.startupTimer = null;
    if (!self.stopping) self._runCheck();
  }, 2000);
};

ControllerAirplayWatchdog.prototype._runCheck = function () {
  if (!this.watchdog || this.stopping || !this._settings().watchdogEnabled) return;
  this.watchdog.check().catch(function () {});
};

ControllerAirplayWatchdog.prototype._log = function (level, message) {
  var method = typeof this.logger[level] === 'function' ? level : 'info';
  this.logger[method]('[AirPlay Watchdog] ' + message);
};

ControllerAirplayWatchdog.prototype._statusSummary = function () {
  if (!this.watchdog) {
    return { current: 'Plugin is not running', history: 'No restart attempts' };
  }
  var data = this.watchdog.getStatus();
  var status = data.status;
  var current = status.state + ': ' + status.reason;
  if (status.service) {
    current += ' (service=' + status.service.active + '/' + status.service.sub +
      ', pid=' + status.service.pid + ')';
  }
  if (status.backoff) current += '; ' + status.backoff;

  var history = data.history.filter(function (item) {
    return item.result !== 'started';
  }).slice(0, 5).map(function (item) {
    return new Date(item.at).toLocaleString() + ': ' + item.reason + ' — ' + item.result;
  }).join('\n');
  return { current: current, history: history || 'No restart attempts' };
};

function configBoolean(config, name, fallback) {
  var value = config.get(name);
  return typeof value === 'boolean' ? value : fallback;
}

function configNumber(config, name, fallback) {
  var value = Number(config.get(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function formatInterval(seconds) {
  return seconds >= 60 ? (seconds / 60) + (seconds === 60 ? ' minute' : ' minutes') :
    seconds + ' seconds';
}
