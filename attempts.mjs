// Tracks concurrent attempts without serializing, queuing or capping requests.
// Only recovery probes are single-flight; ordinary healthy traffic stays parallel.
export class Attempts {
  constructor(queue, { recoveryProbeMs = 60000 } = {}) {
    if (!Number.isSafeInteger(recoveryProbeMs) || recoveryProbeMs < 0) throw new Error('恢复复核间隔必须是非负整数');
    this.queue = queue; this.recoveryProbeMs = recoveryProbeMs;
    this.active = new Map(); this.probing = false; this.nextProbeAt = 0;
  }
  next(seen, scope) {
    let attempt = this.queue.next(seen, scope);
    if (!attempt && this.recoveryProbeMs && !this.probing && this.queue.now() >= this.nextProbeAt) {
      attempt = this.queue.nextRecovery(seen, scope);
    }
    if (!attempt) return;
    if (attempt.recovery) {
      attempt.recovery.probing = true;
      attempt.recovery.probeAfter = this.queue.now() + this.recoveryProbeMs;
      this.probing = true;
      this.nextProbeAt = this.queue.now() + Math.min(15000, this.recoveryProbeMs);
    }
    const inFlight = (this.active.get(attempt.id) || 0) + 1;
    this.active.set(attempt.id, inFlight);
    let released = false;
    return { attempt, inFlight, release: () => {
      if (released) return;
      released = true;
      const left = (this.active.get(attempt.id) || 1) - 1;
      if (left) this.active.set(attempt.id, left); else this.active.delete(attempt.id);
      if (attempt.recovery) { attempt.recovery.probing = false; this.probing = false; }
    } };
  }
}
