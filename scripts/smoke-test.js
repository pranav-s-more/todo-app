#!/usr/bin/env node

/*
 * A no-dependency smoke test for a running Taskolab deployment.
 *
 * Default checks are read-only: health, unauthenticated API protection, and
 * security response headers. Set both SMOKE_TEST_EMAIL and
 * SMOKE_TEST_PASSWORD to enable additional read-only authenticated checks.
 * The script deliberately never creates, updates, or deletes application data.
 */

const baseUrl = (process.env.BASE_URL || 'http://localhost:5000').replace(/\/+$/, '');
const timeoutMs = Number(process.env.FETCH_TIMEOUT_MS || 10_000);
const testEmail = process.env.SMOKE_TEST_EMAIL;
const testPassword = process.env.SMOKE_TEST_PASSWORD;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`Usage: node scripts/smoke-test.js

Environment variables:
  BASE_URL                 Target URL (default: http://localhost:5000)
  FETCH_TIMEOUT_MS         Per-request timeout in milliseconds (default: 10000)
  SMOKE_TEST_EMAIL         Optional dedicated test-account email
  SMOKE_TEST_PASSWORD      Optional dedicated test-account password

Without test credentials, only read-only health, security-header, and anonymous
authorization checks run. With both credentials, the script adds read-only
authenticated checks for the current user, workspaces, tasks, and activity.`);
  process.exit(0);
}

if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  throw new Error('FETCH_TIMEOUT_MS must be a positive number of milliseconds');
}

if (Boolean(testEmail) !== Boolean(testPassword)) {
  throw new Error('Set both SMOKE_TEST_EMAIL and SMOKE_TEST_PASSWORD, or neither');
}

function displayPath(path) {
  try { return new URL(path, baseUrl).pathname; }
  catch { return path; }
}

async function request(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: { Accept: 'application/json', ...(options.headers || {}) },
      signal: controller.signal,
    });
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json') ? await response.json() : await response.text();
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

async function main() {
  console.log(`Taskolab smoke test: ${baseUrl}`);

  await check('health endpoint', async () => {
    const { response, body } = await request('/health');
    expect(response.status === 200, `GET /health returned HTTP ${response.status}`);
    expect(body && body.status === 'ok', 'health response did not report status "ok"');
    expect(body.service === 'taskolab', 'health response did not identify Taskolab');
    expect(response.headers.get('x-content-type-options') === 'nosniff', 'missing Helmet nosniff header');
  });

  await check('protected workspace API rejects anonymous requests', async () => {
    const { response } = await request('/api/workspaces');
    expect(response.status === 401, `GET /api/workspaces without a token returned HTTP ${response.status}, expected 401`);
  });

  if (!testEmail) {
    console.log('INFO  Authenticated checks skipped. Set SMOKE_TEST_EMAIL and SMOKE_TEST_PASSWORD to enable them.');
    return;
  }

  let token;
  await check('login with dedicated smoke-test account', async () => {
    const { response, body } = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, password: testPassword }),
    });
    expect(response.status === 200, `POST /api/auth/login returned HTTP ${response.status}`);
    expect(typeof body?.token === 'string' && body.token.length > 20, 'login did not return a usable token');
    expect(body?.user?.email === testEmail.trim().toLowerCase(), 'login returned an unexpected user');
    token = body.token;
  });

  if (!token) return;
  const authorization = { Authorization: `Bearer ${token}` };

  await check('current-user endpoint', async () => {
    const { response, body } = await request('/api/auth/me', { headers: authorization });
    expect(response.status === 200, `GET /api/auth/me returned HTTP ${response.status}`);
    expect(body?.user?.email === testEmail.trim().toLowerCase(), 'current-user response did not match the smoke-test account');
  });

  let workspace;
  await check('workspace list endpoint', async () => {
    const { response, body } = await request('/api/workspaces', { headers: authorization });
    expect(response.status === 200, `GET /api/workspaces returned HTTP ${response.status}`);
    expect(Array.isArray(body?.workspaces), 'workspace list did not return a workspaces array');
    workspace = body.workspaces[0];
  });

  if (!workspace?.id) {
    console.log('INFO  Task and activity checks skipped because the smoke-test account has no workspace.');
    return;
  }

  await check('workspace task list endpoint', async () => {
    const path = `/api/workspaces/${encodeURIComponent(workspace.id)}/tasks`;
    const { response, body } = await request(path, { headers: authorization });
    expect(response.status === 200, `GET ${displayPath(path)} returned HTTP ${response.status}`);
    expect(Array.isArray(body?.tasks), 'task list did not return a tasks array');
    body.tasks.forEach((task, index) => {
      expect(Array.isArray(task?.assignments), `task ${index + 1} did not return an assignments array`);
      expect(task?.assignmentSummary && typeof task.assignmentSummary === 'object', `task ${index + 1} did not return an assignment summary`);
      expect(Number(task.assignmentSummary.total) === task.assignments.length, `task ${index + 1} assignment summary total did not match assignments`);
    });
  });

  await check('workspace activity endpoint', async () => {
    const path = `/api/workspaces/${encodeURIComponent(workspace.id)}/activity?limit=5`;
    const { response, body } = await request(path, { headers: authorization });
    expect(response.status === 200, `GET ${displayPath(path)} returned HTTP ${response.status}`);
    expect(Array.isArray(body?.activity), 'activity endpoint did not return an activity array');
  });
}

main().catch(error => {
  console.error(`FAIL  Smoke test could not run: ${error.name === 'AbortError' ? `request timed out after ${timeoutMs}ms` : error.message}`);
  process.exitCode = 1;
});
