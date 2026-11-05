import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Attempts } from '../attempts.mjs';
import { KeyQueue } from '../server.mjs';
const next = (tracker, scope = 'chat') => tracker.next(new Set(), scope);

test('healthy FIFO head accepts concurrent callers without a limit, waiting, or load balancing', () => {
  const q = new KeyQueue(['a','b']); const tracker = new Attempts(q);
  const leases = Array.from({ length: 100 }, () => next(tracker));
  assert.ok(leases.every(l => l.attempt.key === 'a' && !l.attempt.recovery));
  assert.equal(leases.at(-1).inFlight, 100);
  for (const lease of leases) { lease.release(); lease.release(); }
  assert.equal(tracker.active.size, 0);
});

test('soft long cooldown permits one recovery; success invalidates stale failures and preserves FIFO', () => {
  let now = 0;
  const q = new KeyQueue(['a'], { now: () => now, recoveryProbeMs: 100, balanceCooldownMs: 10000 });
  const old = q.next(new Set(), 'chat'); q.fail(old, { status: 429, kind: 'balance' });
  const tracker = new Attempts(q, { recoveryProbeMs: 100 });
  assert.equal(next(tracker), undefined); now = 100;
  const probe = next(tracker); assert.ok(probe.attempt.recovery);
  assert.equal(next(tracker), undefined);
  assert.equal(q.recovered(probe.attempt), true); probe.release();
  const normal = next(tracker); assert.equal(normal.attempt.recovery, undefined);
  assert.equal(q.fail(old, { status: 401 }), null); normal.release();
  assert.equal(q.cooling('chat').length, 0);
});

test('failed and cancelled probes retain cooldown and space later recovery attempts', () => {
  let now = 0; const q = new KeyQueue(['a'], { now: () => now, recoveryProbeMs: 100 });
  q.fail(q.next(new Set(), 'chat'), { status: 429, kind: 'quota' });
  const tracker = new Attempts(q, { recoveryProbeMs: 100 });
  now = 100; const probe = next(tracker); probe.release();
  assert.equal(q.cooling('chat').length, 1); assert.equal(next(tracker), undefined);
  now = 200; const again = next(tracker);
  q.fail(again.attempt, { status: 429, kind: 'quota' }); again.release();
  assert.equal(q.cooling('chat').length, 1); assert.equal(next(tracker), undefined);
});

test('authentication and explicit official Retry-After/reset deadlines are never probed early', () => {
  for (const failure of [{ status: 401 }, { status: 429, kind: 'quota', retryAfterMs: 10000 },
    { status: 429, kind: 'quota', resetAfterMs: 10000 }]) {
    let now = 0; const q = new KeyQueue(['a'], { now: () => now, recoveryProbeMs: 100 });
    q.fail(q.next(new Set(), 'chat'), failure); now = 500;
    assert.equal(q.nextRecovery(new Set(), 'chat'), undefined);
    assert.equal(next(new Attempts(q, { recoveryProbeMs: 100 })), undefined);
  }
});

test('recovery is single-flight per provider, scoped, and can be disabled', () => {
  let now = 0; const q = new KeyQueue(['a'], { now: () => now, recoveryProbeMs: 100 });
  for (const scope of ['generation','count_tokens']) q.fail(q.next(new Set(), scope), { status: 429, kind: 'quota' });
  now = 100;
  const tracker = new Attempts(q, { recoveryProbeMs: 100 });
  const probe = next(tracker, 'count_tokens'); assert.equal(next(tracker, 'generation'), undefined);
  assert.equal(q.recovered(probe.attempt), true); probe.release();
  assert.equal(q.next(new Set(), 'generation'), undefined);
  assert.equal(next(new Attempts(q, { recoveryProbeMs: 0 }), 'generation'), undefined);
});

test('a healthy candidate remains preferred over any recovery candidate, regardless of active count', () => {
  let now = 0; const q = new KeyQueue(['a','b'], { now: () => now, recoveryProbeMs: 100 });
  q.fail(q.next(new Set(), 'chat'), { status: 429, kind: 'balance' }); now = 100;
  const tracker = new Attempts(q, { recoveryProbeMs: 100 });
  const leases = Array.from({ length: 20 }, () => next(tracker));
  assert.ok(leases.every(l => l.attempt.key === 'b')); for (const l of leases) l.release();
});
