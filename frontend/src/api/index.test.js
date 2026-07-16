import assert from 'node:assert/strict';
import test from 'node:test';

import { assistantApi } from './assistant.js';
import { automationApi } from './automation.js';
import { api as compatibilityApi } from './client.js';
import { connectorsApi } from './connectors.js';
import { eventsApi } from './events.js';
import { api } from './index.js';
import { projectsApi } from './projects.js';
import { runsApi } from './runs.js';
import { systemApi } from './system.js';
import { workApi } from './work.js';

test('flat compatibility client delegates every method to one domain source of truth', () => {
  const domains = [
    systemApi,
    projectsApi,
    workApi,
    runsApi,
    assistantApi,
    automationApi,
    connectorsApi,
    eventsApi,
  ];
  const entries = domains.flatMap(domain => Object.entries(domain));

  assert.equal(entries.length, 135);
  assert.equal(new Set(entries.map(([name]) => name)).size, entries.length);
  for (const [name, implementation] of entries) {
    assert.equal(api[name], implementation, name);
  }
  assert.equal(Object.keys(api).length, entries.length);
  assert.equal(compatibilityApi, api);
});
