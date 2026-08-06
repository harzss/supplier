import assert from 'node:assert/strict';
import test from 'node:test';

import { assertStagingMaintenanceRuntime } from './staging-maintenance-runtime.mjs';

const GIT_SHA = 'a'.repeat(40);

test('accepts only the marked Linux maintenance runtime with a full Git SHA', () => {
  const environment = {
    SUPPLIER_STAGING_MAINTENANCE_GIT_SHA: GIT_SHA,
    SUPPLIER_STAGING_MAINTENANCE_IMAGE: '1',
  };
  assert.deepEqual(assertStagingMaintenanceRuntime(environment, 'linux'), { gitSha: GIT_SHA });

  for (const [candidateEnvironment, platform] of [
    [environment, 'darwin'],
    [{ ...environment, SUPPLIER_STAGING_MAINTENANCE_IMAGE: '0' }, 'linux'],
    [{ ...environment, SUPPLIER_STAGING_MAINTENANCE_GIT_SHA: 'short' }, 'linux'],
    [{}, 'linux'],
  ]) {
    assert.throws(
      () => assertStagingMaintenanceRuntime(candidateEnvironment, platform),
      /verified Linux staging-maintenance image/,
    );
  }
});
