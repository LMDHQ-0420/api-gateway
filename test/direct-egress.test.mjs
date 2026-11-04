import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('optional Linux direct egress DNS, NIC binding, allowlist and binary forwarding', t => {
  if (process.platform !== 'linux') return t.skip('Linux-only optional direct egress');
  const result = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'test', '-p', 'direct_egress_test.py'], { encoding: 'utf8', timeout: 15000 });
  if (result.error?.code === 'ENOENT') return t.skip('Python3 is optional for direct egress');
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
