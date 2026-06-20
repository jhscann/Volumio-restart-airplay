'use strict';

var DEFAULTS = {
  automaticRecovery: true,
  mdnsCheckEnabled: false,
  unhealthyThreshold: 2,
  mdnsFailureThreshold: 3,
  cleanInactiveGraceMs: 60000,
  baseBackoffMs: 15000,
  maxBackoffMs: 300000,
  rollingWindowMs: 900000,
  rollingRestartLimit: 3,
  cooldownMs: 1800000,
  verificationDelayMs: 5000,
  healthyResetMs: 600000
};

function AirplayWatchdog(options) {
  options = options || {};
  this.adapter = options.adapter;
  this.log = options.log || function () {};
  this.now = options.now || Date.now;
  this.sleep = options.sleep || function (ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  };
  this.settings = Object.assign({}, DEFAULTS, options.settings || {});
  this.running = false;
  this.checkInProgress = false;
  this.recoveryInProgress = false;
  this.failureCount = 0;
  this.mdnsFailureCount = 0;
  this.cleanInactiveSince = null;
  this.lastHealthyAt = null;
  this.nextAttemptAt = 0;
  this.cooldownUntil = 0;
  this.restartTimes = [];
  this.history = [];
  this.status = {
    state: 'idle',
    reason: 'Not checked yet',
    service: null,
    verification: null,
    backoff: null,
    checkedAt: null
  };
}

AirplayWatchdog.prototype.start = function () {
  this.running = true;
};

AirplayWatchdog.prototype.stop = function () {
  this.running = false;
};

AirplayWatchdog.prototype.updateSettings = function (settings) {
  this.settings = Object.assign({}, this.settings, settings || {});
};

AirplayWatchdog.prototype.getStatus = function () {
  return {
    status: Object.assign({}, this.status),
    history: this.history.slice(),
    restartTimes: this.restartTimes.slice(),
    nextAttemptAt: this.nextAttemptAt,
    cooldownUntil: this.cooldownUntil
  };
};

AirplayWatchdog.prototype._record = function (event) {
  var entry = Object.assign({ at: this.now() }, event);
  this.history.unshift(entry);
  this.history = this.history.slice(0, 10);
};

AirplayWatchdog.prototype._setStatus = function (state, reason, snapshot, extra) {
  this.status = Object.assign({
    state: state,
    reason: reason,
    service: snapshot ? summariseService(snapshot.service) : null,
    verification: null,
    backoff: null,
    checkedAt: this.now()
  }, extra || {});
};

AirplayWatchdog.prototype.check = async function () {
  if (!this.running || this.checkInProgress) {
    return { action: 'skipped', reason: this.running ? 'check-in-progress' : 'watchdog-stopped' };
  }

  this.checkInProgress = true;
  try {
    var snapshot = await this.adapter.snapshot(this.settings.mdnsCheckEnabled);
    var decision = this.evaluate(snapshot);
    this._logDecision(decision, snapshot);

    if (decision.action === 'recover') {
      return await this._recover(decision.reason, snapshot, false);
    }

    this._setStatus(decision.state, decision.reason, snapshot, {
      backoff: decision.backoff || null
    });
    return decision;
  } catch (error) {
    this._setStatus('degraded', 'health-check-error', null, {
      verification: error.message
    });
    this.log('warn', 'failure reason=health-check-error result=' + safeMessage(error));
    return { action: 'defer', reason: 'health-check-error' };
  } finally {
    this.checkInProgress = false;
  }
};

AirplayWatchdog.prototype.evaluate = function (snapshot) {
  var now = this.now();
  var service = snapshot.service || {};

  if (snapshot.pluginStopping || snapshot.rebooting || !snapshot.airplayPluginEnabled) {
    this._resetFailures();
    return { action: 'none', state: 'suppressed', reason: 'intentional-lifecycle-state' };
  }

  if (serviceHealthy(service)) {
    var previouslyHealthyAt = this.lastHealthyAt;
    this.cleanInactiveSince = null;
    this.failureCount = 0;
    this.lastHealthyAt = now;

    if (this.settings.mdnsCheckEnabled && snapshot.mdnsAvailable && snapshot.mdnsAdvertised === false) {
      this.mdnsFailureCount += 1;
      if (snapshot.activePlayback) {
        return { action: 'none', state: 'streaming', reason: 'mdns-missing-active-playback' };
      }
      if (this.mdnsFailureCount >= this.settings.mdnsFailureThreshold) {
        return this._recoveryDecision('mdns-advertisement-missing', snapshot);
      }
      return { action: 'none', state: 'degraded', reason: 'mdns-missing-unconfirmed' };
    }

    this.mdnsFailureCount = 0;
    if (previouslyHealthyAt && now - previouslyHealthyAt >= this.settings.healthyResetMs) {
      this.restartTimes = [];
      this.nextAttemptAt = 0;
    }
    return {
      action: 'none',
      state: snapshot.activePlayback ? 'streaming' : 'healthy',
      reason: snapshot.activePlayback ? 'healthy-active-playback' : 'healthy'
    };
  }

  this.mdnsFailureCount = 0;

  // A live process may briefly enter uninterruptible I/O while ALSA is active.
  // Never turn that ambiguous signal into a playback interruption. A service
  // that has actually failed is no longer an active session and is recoverable.
  if (snapshot.activePlayback &&
      service.activeState === 'active' &&
      Number(service.mainPid) > 0) {
    return { action: 'none', state: 'streaming', reason: 'active-playback-health-ambiguous' };
  }

  if (isTransitional(service)) {
    this.failureCount = 0;
    this.cleanInactiveSince = null;
    return { action: 'none', state: 'transitioning', reason: 'service-transition-in-progress' };
  }

  if (isCleanInactive(service)) {
    if (snapshot.onDemand) {
      this._resetFailures();
      return { action: 'none', state: 'idle', reason: 'on-demand-intentional-stop' };
    }
    if (this.cleanInactiveSince === null) {
      this.cleanInactiveSince = now;
      return { action: 'none', state: 'degraded', reason: 'clean-stop-grace-period' };
    }
    if (now - this.cleanInactiveSince < this.settings.cleanInactiveGraceMs) {
      return { action: 'none', state: 'degraded', reason: 'clean-stop-grace-period' };
    }
  } else {
    this.cleanInactiveSince = null;
  }

  this.failureCount += 1;
  if (this.failureCount < this.settings.unhealthyThreshold) {
    return { action: 'none', state: 'degraded', reason: failureReason(service) + '-unconfirmed' };
  }

  return this._recoveryDecision(failureReason(service), snapshot);
};

AirplayWatchdog.prototype._recoveryDecision = function (reason) {
  var now = this.now();
  this._pruneRestarts(now);

  if (!this.settings.automaticRecovery) {
    return { action: 'none', state: 'degraded', reason: reason + '-automatic-recovery-disabled' };
  }
  if (now < this.cooldownUntil) {
    return {
      action: 'none',
      state: 'cooldown',
      reason: reason,
      backoff: 'cooldown until ' + new Date(this.cooldownUntil).toISOString()
    };
  }
  if (this.restartTimes.length >= this.settings.rollingRestartLimit) {
    this.cooldownUntil = now + this.settings.cooldownMs;
    return {
      action: 'none',
      state: 'cooldown',
      reason: 'rolling-restart-limit',
      backoff: 'cooldown until ' + new Date(this.cooldownUntil).toISOString()
    };
  }
  if (now < this.nextAttemptAt) {
    return {
      action: 'none',
      state: 'backoff',
      reason: reason,
      backoff: 'next attempt ' + new Date(this.nextAttemptAt).toISOString()
    };
  }
  return { action: 'recover', state: 'recovering', reason: reason };
};

AirplayWatchdog.prototype.manualRestart = async function () {
  if (!this.running) {
    throw new Error('Watchdog plugin is stopped');
  }
  return this._recover('manual-request', null, true);
};

AirplayWatchdog.prototype._recover = async function (reason, snapshot, manual) {
  if (this.recoveryInProgress) {
    return { action: 'skipped', reason: 'recovery-in-progress' };
  }

  this.recoveryInProgress = true;
  var now = this.now();
  var attempt = this.restartTimes.length + 1;
  this.log('warn', 'failure reason=' + reason + ' service=' +
    JSON.stringify(snapshot ? summariseService(snapshot.service) : null) +
    ' restart_attempt=' + attempt + ' manual=' + manual);
  this._record({ reason: reason, attempt: attempt, manual: manual, result: 'started' });

  try {
    await this.adapter.restartReceiver(reason);
    await this.sleep(this.settings.verificationDelayMs);
    var verification = await this.adapter.snapshot(this.settings.mdnsCheckEnabled);
    var processHealthy = serviceHealthy(verification.service);
    var advertisementHealthy = !this.settings.mdnsCheckEnabled ||
      !verification.mdnsAvailable || verification.mdnsAdvertised !== false;
    var verified = processHealthy && advertisementHealthy;

    if (!manual) {
      this.restartTimes.push(now);
      var exponent = Math.max(0, this.restartTimes.length - 1);
      this.nextAttemptAt = now + Math.min(
        this.settings.maxBackoffMs,
        this.settings.baseBackoffMs * Math.pow(2, exponent)
      );
    }

    this.failureCount = verified ? 0 : this.failureCount;
    this.mdnsFailureCount = verified ? 0 : this.mdnsFailureCount;
    this.cleanInactiveSince = null;
    this._record({
      reason: reason,
      attempt: attempt,
      manual: manual,
      result: verified ? 'verified' : 'verification-failed'
    });
    this._setStatus(verified ? 'healthy' : 'degraded',
      verified ? 'recovery-verified' : 'recovery-verification-failed',
      verification, {
        verification: verified ? 'service and configured checks passed' : 'health checks did not pass',
        backoff: manual ? null : 'next automatic attempt no earlier than ' +
          new Date(this.nextAttemptAt).toISOString()
      });
    this.log(verified ? 'info' : 'error',
      'verification result=' + (verified ? 'healthy' : 'failed') +
      ' service=' + JSON.stringify(summariseService(verification.service)) +
      ' backoff=' + (manual ? 'manual-none' : this.nextAttemptAt));
    return { action: 'recovered', reason: reason, verified: verified };
  } catch (error) {
    if (!manual) {
      this.restartTimes.push(now);
      this.nextAttemptAt = now + Math.min(
        this.settings.maxBackoffMs,
        this.settings.baseBackoffMs * Math.pow(2, Math.max(0, this.restartTimes.length - 1))
      );
    }
    this._record({
      reason: reason,
      attempt: attempt,
      manual: manual,
      result: 'restart-failed',
      error: safeMessage(error)
    });
    this._setStatus('degraded', 'restart-failed', snapshot, {
      verification: safeMessage(error),
      backoff: manual ? null : 'next automatic attempt no earlier than ' +
        new Date(this.nextAttemptAt).toISOString()
    });
    this.log('error', 'restart_attempt=' + attempt + ' result=failed error=' +
      safeMessage(error) + ' backoff=' + (manual ? 'manual-none' : this.nextAttemptAt));
    return { action: 'recover-failed', reason: reason, error: error };
  } finally {
    this.recoveryInProgress = false;
  }
};

AirplayWatchdog.prototype._pruneRestarts = function (now) {
  var oldest = now - this.settings.rollingWindowMs;
  this.restartTimes = this.restartTimes.filter(function (time) { return time >= oldest; });
};

AirplayWatchdog.prototype._resetFailures = function () {
  this.failureCount = 0;
  this.mdnsFailureCount = 0;
  this.cleanInactiveSince = null;
};

AirplayWatchdog.prototype._logDecision = function (decision, snapshot) {
  if (decision.reason === 'healthy' || decision.reason === 'healthy-active-playback') {
    return;
  }
  this.log(decision.state === 'degraded' ? 'warn' : 'info',
    'failure reason=' + decision.reason +
    ' service=' + JSON.stringify(summariseService(snapshot.service)) +
    ' action=' + decision.action +
    ' backoff=' + (decision.backoff || 'none'));
};

function serviceHealthy(service) {
  return service &&
    service.activeState === 'active' &&
    service.subState === 'running' &&
    Number(service.mainPid) > 0 &&
    service.processState !== 'Z' &&
    service.processState !== 'D' &&
    service.commandTimedOut !== true;
}

function isTransitional(service) {
  return service && (
    service.activeState === 'activating' ||
    service.activeState === 'deactivating' ||
    service.subState === 'start-pre' ||
    service.subState === 'stop-sigterm'
  );
}

function isCleanInactive(service) {
  return service &&
    service.activeState === 'inactive' &&
    (!service.result || service.result === 'success') &&
    Number(service.execMainStatus || 0) === 0;
}

function failureReason(service) {
  if (!service) return 'service-state-unavailable';
  if (service.commandTimedOut) return 'service-check-timeout';
  if (service.activeState === 'failed' || (service.result && service.result !== 'success')) {
    return 'service-failed';
  }
  if (service.processState === 'Z') return 'process-zombie';
  if (service.processState === 'D') return 'process-uninterruptible';
  if (service.activeState === 'active' && Number(service.mainPid) <= 0) return 'main-process-missing';
  if (isCleanInactive(service)) return 'unexpected-clean-stop';
  return 'service-unhealthy';
}

function summariseService(service) {
  if (!service) return null;
  return {
    active: service.activeState,
    sub: service.subState,
    result: service.result,
    pid: Number(service.mainPid || 0),
    exit: Number(service.execMainStatus || 0),
    process: service.processState || null
  };
}

function safeMessage(error) {
  return String(error && error.message ? error.message : error).replace(/\s+/g, ' ').slice(0, 300);
}

module.exports = {
  AirplayWatchdog: AirplayWatchdog,
  DEFAULTS: DEFAULTS,
  serviceHealthy: serviceHealthy,
  failureReason: failureReason
};
