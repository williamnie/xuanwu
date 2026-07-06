#!/usr/bin/env node

const token = process.env.FIXTURE_INBOX_TOKEN || '';
const [command] = process.argv.slice(2);

if (command === 'health') {
  if (!token) {
    console.error('missing FIXTURE_INBOX_TOKEN');
    process.exit(20);
  }
  console.log(JSON.stringify({ ok: true, connector: 'fixture-local-inbox' }));
  process.exit(0);
}

if (command === 'sync') {
  const cursor = argValue('--cursor') || '';
  console.log(JSON.stringify({
    items: [{ id: 'fixture-1', title: 'Fixture inbox item', cursor }],
    next_cursor: cursor ? `${cursor}-next` : 'fixture-cursor-1'
  }));
  process.exit(0);
}

console.error(`unknown command: ${command || ''}`.trim());
process.exit(64);

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || '' : '';
}
