import {createClient} from '@libsql/client';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {afterEach, describe, expect, it} from 'vitest';

const directories: string[] = [];
afterEach(async () => {await Promise.all(directories.splice(0).map(path => rm(path, {recursive: true, force: true})));});

function run(url: string) {
  return spawnSync(process.execPath, ['scripts/verify-autobrush-readiness.mjs'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 20_000,
    env: {...process.env, TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: 'test-only', APP_ORGANIZATION_ID: 'avenue-z'},
  });
}

async function fixture(change: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'autobrush-readiness-'));
  directories.push(directory);
  const url = `file:${join(directory, 'readiness.db')}`, db = createClient({url});
  await db.executeMultiple(`
    CREATE TABLE clients (organizationId TEXT,id TEXT,name TEXT,timezone TEXT,currency TEXT,version INTEGER);
    CREATE TABLE connections (organizationId TEXT,clientId TEXT,id TEXT,provider TEXT,enabled INTEGER,lastSuccess TEXT,coverageThrough TEXT,pollMinutes INTEGER,version INTEGER);
    CREATE TABLE provider_credentials (organizationId TEXT,clientId TEXT,provider TEXT,updatedAt TEXT);
    CREATE TABLE current_snapshots (organizationId TEXT,clientId TEXT,sourceId TEXT,date TEXT);
    CREATE TABLE reviews (organizationId TEXT,clientId TEXT,storeDate TEXT,createdAt TEXT,current INTEGER);
    CREATE TABLE qualifications (organizationId TEXT,clientId TEXT,sourceId TEXT,connectionVersion INTEGER,clientVersion INTEGER,version INTEGER,payload TEXT,createdAt TEXT);
    INSERT INTO clients VALUES ('avenue-z','autobrush','Autobrush','America/New_York','USD',1);
  `);
  const now = new Date().toISOString();
  for (const provider of ['shopify', 'loop', 'meta', 'motion', 'intelligems', 'northbeam', 'ga4']) {
    const id = `autobrush-${provider}`;
    await db.execute({sql: 'INSERT INTO connections VALUES (?,?,?,?,?,?,?,?,?)', args: ['avenue-z', 'autobrush', id, id, 1, now, '2025-01-01T00:00:00Z', 60, 1]});
    await db.execute({sql: 'INSERT INTO current_snapshots VALUES (?,?,?,?)', args: ['avenue-z', 'autobrush', id, '2025-01-01']});
    const payload = {clientId: 'autobrush', timezone: 'America/New_York', currency: 'USD', paginationComplete: true, reconciled: true, hourlyGrain: true, requiresHourly: true, channels: ['meta'], requiredChannels: ['meta'], dimensions: ['market'], requiredDimensions: ['market'], ...change};
    await db.execute({sql: 'INSERT INTO qualifications VALUES (?,?,?,?,?,?,?,?)', args: ['avenue-z', 'autobrush', id, 1, 1, 1, JSON.stringify(payload), now]});
  }
  db.close();
  return url;
}

describe('Autobrush stored setup diagnostic', () => {
  it('sanitizes database-constructor errors including private URL text', () => {
    const marker = 'private-test-marker', result = run(`invalid://${marker}`);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(marker);
    expect(JSON.parse(result.stdout)).toMatchObject({handoverVerified: false, setupChecksPassed: false});
  });

  it('never certifies stale or one-day history from a recent polling timestamp', async () => {
    const result = run(await fixture()), report = JSON.parse(result.stdout);
    expect(result.status).toBe(2);
    expect(report).toMatchObject({setupChecksPassed: true, handoverVerified: false});
    expect(report.providers).toHaveLength(7);
    expect(report.providers[0]).toMatchObject({authorizationStored: false, scheduledIngestionRecorded: true});
    expect(result.stdout).not.toMatch(/"(?:ready|liveIngestionVerified|currentQualification)"/);
  });

  it.each([
    {hourlyGrain: false},
    {channels: []},
    {dimensions: []},
    {requiredChannels: null},
    {requiredDimensions: 'market'},
    {clientId: 'beam'},
    {paginationComplete: false},
    {reconciled: false},
  ])('rejects incomplete recorded qualification requirements: %j', async change => {
    const result = run(await fixture(change)), report = JSON.parse(result.stdout);
    expect(result.status).toBe(2);
    expect(report).toMatchObject({setupChecksPassed: false, handoverVerified: false});
    expect(report.providers.every((provider: {scheduledIngestionRecorded: boolean}) => !provider.scheduledIngestionRecorded)).toBe(true);
  });
});
