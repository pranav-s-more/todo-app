require('dotenv').config({ quiet: true });

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const app = express();
const PORT = Number(process.env.PORT || 5000);
const databaseName = process.env.DB_NAME || 'todo_app';
const jwtSecret = process.env.JWT_SECRET;
const jwtExpiresIn = process.env.JWT_EXPIRES_IN || '8h';
const appOrigin = process.env.APP_ORIGIN || `http://localhost:${PORT}`;
const dataFile = path.join(__dirname, 'data', 'todos.json');
const logsDirectory = path.join(__dirname, 'logs');
const logFile = path.join(logsDirectory, 'app.log');
const VALID_PRIORITIES = new Set(['low', 'medium', 'high']);
const VALID_ROLES = new Set(['admin', 'editor', 'viewer']);
const VALID_ASSIGNMENT_STATUSES = new Set(['not_started', 'in_progress', 'completed']);
const WRITE_ROLES = new Set(['owner', 'admin', 'editor']);
const ADMIN_ROLES = new Set(['owner', 'admin']);
let db;
let httpServer;

if (!/^[A-Za-z0-9_]+$/.test(databaseName)) throw new Error('DB_NAME may contain only letters, numbers, and underscores');
if (!jwtSecret || jwtSecret.length < 32) throw new Error('JWT_SECRET must be configured with a unique value of at least 32 characters before Taskolab can start');

app.disable('x-powered-by');
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: { useDefaults: true, directives: { 'script-src': ["'self'"], 'style-src': ["'self'"], 'img-src': ["'self'", 'data:'], 'connect-src': ["'self'"] } },
}));
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && origin === appOrigin) {
    res.setHeader('Access-Control-Allow-Origin', appOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: 'Too many sign-in attempts. Please wait 15 minutes and try again.' },
});

function log(level, event, fields = {}) {
  const safeFields = JSON.stringify(fields, (_, value) => typeof value === 'string' && value.length > 300 ? `${value.slice(0, 300)}…` : value);
  const entry = `[${new Date().toISOString()}] [${level}] ${event} ${safeFields}`;
  console.log(entry);
  try { fs.mkdirSync(logsDirectory, { recursive: true }); fs.appendFileSync(logFile, `${entry}\n`); }
  catch (error) { console.error(`Could not write to log file: ${error.message}`); }
}

function databaseConfig(includeDatabase = true) {
  // DB_APP_* is the restricted runtime identity. DB_USER/DB_PASSWORD remain a
  // backwards-compatible local-development fallback for the pre-multi-user setup.
  return {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_APP_USER || process.env.DB_USER || 'root',
    password: process.env.DB_APP_PASSWORD || process.env.DB_PASSWORD || '',
    ...(includeDatabase ? { database: databaseName } : {}),
    dateStrings: true,
  };
}

function bootstrapDatabaseConfig() {
  return {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    dateStrings: true,
  };
}

class ApiError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function cleanText(value, field = 'Value', maxLength = 200) {
  if (typeof value !== 'string') throw new ApiError(400, `${field} is required`);
  const cleaned = value.trim();
  if (!cleaned) throw new ApiError(400, `${field} is required`);
  if (cleaned.length > maxLength) throw new ApiError(400, `${field} must be ${maxLength} characters or fewer`);
  return cleaned;
}
function optionalText(value, maxLength = 500) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new ApiError(400, 'Description must be text');
  const cleaned = value.trim();
  if (cleaned.length > maxLength) throw new ApiError(400, `Description must be ${maxLength} characters or fewer`);
  return cleaned || null;
}
function validDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new ApiError(400, 'Due date must be a valid YYYY-MM-DD date');
  return value;
}
function validId(value, field = 'ID') { const id = Number(value); if (!Number.isSafeInteger(id) || id <= 0) throw new ApiError(400, `Invalid ${field}`); return id; }
function validPriority(value) { if (!VALID_PRIORITIES.has(value)) throw new ApiError(400, 'Priority must be low, medium, or high'); return value; }
function validAssignmentStatus(value) {
  if (typeof value !== 'string' || !VALID_ASSIGNMENT_STATUSES.has(value)) {
    throw new ApiError(400, 'Assignment status must be not_started, in_progress, or completed');
  }
  return value;
}
function normalizeEmail(value) {
  if (typeof value !== 'string') throw new ApiError(400, 'Email is required');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, 'Enter a valid email address');
  return email;
}
function safeJson(value) { try { return JSON.parse(value); } catch { return null; } }
function mapUser(row) { return { id: row.id, name: row.name, email: row.email, createdAt: row.created_at }; }
function mapAssignment(row) {
  return { userId: row.user_id, name: row.name, email: row.email, status: row.status, assignedAt: row.created_at, updatedAt: row.updated_at };
}
function summarizeAssignments(assignments) {
  const summary = { total: assignments.length, notStarted: 0, inProgress: 0, completed: 0, overallStatus: 'unassigned' };
  for (const assignment of assignments) {
    if (assignment.status === 'not_started') summary.notStarted += 1;
    else if (assignment.status === 'in_progress') summary.inProgress += 1;
    else if (assignment.status === 'completed') summary.completed += 1;
  }
  // The task's global `done` flag remains independent. This is only the
  // aggregate view of the people assigned to the task.
  if (!summary.total) summary.overallStatus = 'unassigned';
  else if (summary.completed === summary.total) summary.overallStatus = 'completed';
  else if (summary.inProgress || (summary.completed && summary.notStarted)) summary.overallStatus = 'in_progress';
  else summary.overallStatus = 'not_started';
  return summary;
}
function mapTask(row, assignments = []) { return { id: row.id, text: row.text, done: Boolean(row.done), priority: row.priority, dueDate: row.due_date, parentId: row.parent_id, workspaceId: row.workspace_id, assigneeId: row.assignee_user_id, assigneeName: row.assignee_name || null, assignments, assignmentSummary: summarizeAssignments(assignments), createdByUserId: row.created_by_user_id, createdByName: row.created_by_name || null, createdAt: row.created_at, updatedAt: row.updated_at }; }
function mapActivity(row) { return { id: row.id, type: row.event_type, entityType: row.entity_type, entityId: row.entity_id, actorName: row.actor_name || 'System', message: row.message, icon: row.icon, details: typeof row.details === 'string' ? safeJson(row.details) : row.details, createdAt: row.created_at }; }

async function tableColumnExists(table, column) {
  const [rows] = await db.query('SELECT 1 FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ? LIMIT 1', [databaseName, table, column]);
  return Boolean(rows.length);
}
async function constraintExists(name) {
  const [rows] = await db.query('SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema = ? AND constraint_name = ? LIMIT 1', [databaseName, name]);
  return Boolean(rows.length);
}
async function indexExists(table, name) {
  const [rows] = await db.query('SELECT 1 FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? AND index_name = ? LIMIT 1', [databaseName, table, name]);
  return Boolean(rows.length);
}
async function ensureColumn(table, column, definition) { if (!(await tableColumnExists(table, column))) await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`); }
async function ensureIndex(table, name, definition) { if (!(await indexExists(table, name))) await db.query(`CREATE INDEX \`${name}\` ON \`${table}\` ${definition}`); }
async function ensureForeignKey(table, name, definition) { if (!(await constraintExists(name))) await db.query(`ALTER TABLE \`${table}\` ADD CONSTRAINT \`${name}\` ${definition}`); }

async function initializeDatabase() {
  const usingDedicatedDatabaseUser = Boolean(process.env.DB_APP_USER && process.env.DB_APP_PASSWORD);
  if (!usingDedicatedDatabaseUser) {
    const bootstrap = await mysql.createConnection(bootstrapDatabaseConfig());
    await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await bootstrap.end();
    log('WARN', 'database_root_fallback_enabled', { message: 'Use DB_APP_USER and DB_APP_PASSWORD for the non-root runtime identity' });
  }
  db = mysql.createPool({ ...databaseConfig(), waitForConnections: true, connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10), queueLimit: 0 });
  await db.query(`CREATE TABLE IF NOT EXISTS users (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT, name VARCHAR(100) NOT NULL, email VARCHAR(254) NOT NULL, password_hash VARCHAR(255) NOT NULL,
    token_version INT UNSIGNED NOT NULL DEFAULT 0, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id), UNIQUE KEY uq_users_email (email)
  ) ENGINE=InnoDB`);
  await db.query(`CREATE TABLE IF NOT EXISTS workspaces (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT, name VARCHAR(120) NOT NULL, description VARCHAR(500) NULL, created_by_user_id INT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id), CONSTRAINT fk_workspaces_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`);
  await db.query(`CREATE TABLE IF NOT EXISTS workspace_members (
    workspace_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL, role ENUM('owner', 'admin', 'editor', 'viewer') NOT NULL DEFAULT 'viewer', created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (workspace_id, user_id), CONSTRAINT fk_workspace_members_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CONSTRAINT fk_workspace_members_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  await db.query(`CREATE TABLE IF NOT EXISTS activity_log (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, workspace_id INT UNSIGNED NOT NULL, actor_user_id INT UNSIGNED NULL,
    event_type VARCHAR(64) NOT NULL, entity_type VARCHAR(64) NOT NULL, entity_id INT UNSIGNED NULL, message VARCHAR(500) NOT NULL, icon VARCHAR(12) NULL, details JSON NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (id),
    CONSTRAINT fk_activity_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CONSTRAINT fk_activity_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`);
  await db.query(`CREATE TABLE IF NOT EXISTS todos (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT, text VARCHAR(200) NOT NULL, done BOOLEAN NOT NULL DEFAULT FALSE, priority ENUM('low', 'medium', 'high') NOT NULL DEFAULT 'medium', due_date DATE NULL, parent_id INT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id), CONSTRAINT fk_todos_parent FOREIGN KEY (parent_id) REFERENCES todos(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  await ensureColumn('todos', 'workspace_id', 'INT UNSIGNED NULL AFTER parent_id');
  await ensureColumn('todos', 'created_by_user_id', 'INT UNSIGNED NULL AFTER workspace_id');
  await ensureColumn('todos', 'assignee_user_id', 'INT UNSIGNED NULL AFTER created_by_user_id');
  await ensureForeignKey('todos', 'fk_todos_workspace', 'FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE');
  await ensureForeignKey('todos', 'fk_todos_creator', 'FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL');
  await ensureForeignKey('todos', 'fk_todos_assignee', 'FOREIGN KEY (assignee_user_id) REFERENCES users(id) ON DELETE SET NULL');
  await ensureIndex('todos', 'idx_todos_workspace_parent', '(workspace_id, parent_id)');
  await ensureIndex('todos', 'idx_todos_workspace_done', '(workspace_id, done)');
  await db.query(`CREATE TABLE IF NOT EXISTS task_assignments (
    task_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL,
    status ENUM('not_started', 'in_progress', 'completed') NOT NULL DEFAULT 'not_started',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (task_id, user_id),
    CONSTRAINT fk_task_assignments_task FOREIGN KEY (task_id) REFERENCES todos(id) ON DELETE CASCADE,
    CONSTRAINT fk_task_assignments_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  await ensureIndex('task_assignments', 'idx_task_assignments_user_status', '(user_id, status)');
  await ensureIndex('activity_log', 'idx_activity_workspace_created', '(workspace_id, created_at)');
  await migrateJsonTodos();
  await migrateLegacyTaskAssignments();
}

async function migrateJsonTodos() {
  const [[{ total }]] = await db.query('SELECT COUNT(*) AS total FROM todos');
  if (total || !fs.existsSync(dataFile)) return;
  let savedTodos;
  try { savedTodos = JSON.parse(fs.readFileSync(dataFile, 'utf8')); }
  catch (error) { log('WARN', 'json_migration_skipped', { reason: error.message }); return; }
  if (!Array.isArray(savedTodos) || !savedTodos.length) return;
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    for (const todo of savedTodos) {
      await connection.query('INSERT INTO todos (id, text, done, priority, due_date, parent_id) VALUES (?, ?, ?, ?, ?, ?)', [todo.id, String(todo.text || '').slice(0, 200), Boolean(todo.done), VALID_PRIORITIES.has(todo.priority) ? todo.priority : 'medium', todo.dueDate || null, todo.parentId || null]);
    }
    await connection.commit();
    log('INFO', 'json_tasks_migrated', { count: savedTodos.length });
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

async function migrateLegacyTaskAssignments() {
  // `todos.assignee_user_id` was the original single-assignee field. Keep it
  // for old clients, while seeding the new many-to-many rows once per task/user.
  // Joining workspace_members prevents an orphaned legacy value from granting
  // a removed or unrelated user access to a task.
  const [result] = await db.query(`INSERT IGNORE INTO task_assignments (task_id, user_id, status)
    SELECT t.id, t.assignee_user_id, 'not_started'
    FROM todos t
    JOIN workspace_members wm ON wm.workspace_id = t.workspace_id AND wm.user_id = t.assignee_user_id
    WHERE t.assignee_user_id IS NOT NULL`);
  if (result.affectedRows) log('INFO', 'legacy_task_assignments_migrated', { count: result.affectedRows });
}

async function recordActivity(connection, { workspaceId, actorUserId = null, type, entityType, entityId = null, message, icon = '◷', details = null }) {
  await connection.query('INSERT INTO activity_log (workspace_id, actor_user_id, event_type, entity_type, entity_id, message, icon, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [workspaceId, actorUserId, type, entityType, entityId, message, icon, details ? JSON.stringify(details) : null]);
}
async function createWorkspaceForUser(connection, userId, name, description = null, activityMessage = 'created this workspace') {
  const [result] = await connection.query('INSERT INTO workspaces (name, description, created_by_user_id) VALUES (?, ?, ?)', [name, description, userId]);
  const workspaceId = result.insertId;
  await connection.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')", [workspaceId, userId]);
  await recordActivity(connection, { workspaceId, actorUserId: userId, type: 'workspace_created', entityType: 'workspace', entityId: workspaceId, message: activityMessage, icon: '✦' });
  return workspaceId;
}
async function provisionFirstWorkspace(connection, user) {
  // Lock unclaimed legacy rows so two simultaneous first registrations cannot
  // both create an "Imported tasks" workspace for the same data.
  const [legacyTasks] = await connection.query('SELECT id FROM todos WHERE workspace_id IS NULL FOR UPDATE');
  const legacyCount = legacyTasks.length;
  if (legacyCount) {
    const workspaceId = await createWorkspaceForUser(connection, user.id, 'Imported tasks', 'Tasks preserved from the single-user Taskolab workspace.', 'claimed imported tasks');
    await connection.query('UPDATE todos SET workspace_id = ?, created_by_user_id = ? WHERE workspace_id IS NULL', [workspaceId, user.id]);
    await recordActivity(connection, { workspaceId, actorUserId: user.id, type: 'legacy_tasks_imported', entityType: 'task', message: `imported ${legacyCount} existing task${legacyCount === 1 ? '' : 's'}`, icon: '↳', details: { count: legacyCount } });
    return workspaceId;
  }
  return createWorkspaceForUser(connection, user.id, `${user.name}'s Workspace`, 'Your private Taskolab workspace. Add registered teammates when you are ready.');
}
function issueToken(user) { return jwt.sign({ sub: String(user.id), tokenVersion: user.token_version }, jwtSecret, { algorithm: 'HS256', expiresIn: jwtExpiresIn, issuer: 'taskolab', audience: 'taskolab-web', jwtid: crypto.randomUUID() }); }

const authenticate = asyncRoute(async (req, res, next) => {
  const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  if (!match) throw new ApiError(401, 'Sign in is required');
  let claims;
  try { claims = jwt.verify(match[1], jwtSecret, { algorithms: ['HS256'], issuer: 'taskolab', audience: 'taskolab-web' }); }
  catch { throw new ApiError(401, 'Your session is invalid or has expired'); }
  const userId = validId(claims.sub, 'session');
  const [rows] = await db.query('SELECT id, name, email, token_version, created_at FROM users WHERE id = ? LIMIT 1', [userId]);
  if (!rows.length || Number(rows[0].token_version) !== Number(claims.tokenVersion)) throw new ApiError(401, 'Your session is no longer active');
  req.user = rows[0];
  return next();
});
async function workspaceAccess(workspaceId, userId) {
  const [rows] = await db.query(`SELECT w.id, w.name, w.description, wm.role FROM workspaces w LEFT JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = ? WHERE w.id = ? LIMIT 1`, [userId, workspaceId]);
  const workspace = rows[0];
  if (!workspace) throw new ApiError(404, 'Workspace not found');
  if (!workspace.role) throw new ApiError(403, 'You do not have access to this workspace');
  return workspace;
}
function requireRole(workspace, allowedRoles) { if (!allowedRoles.has(workspace.role)) throw new ApiError(403, 'Your workspace role does not allow this action'); }
function hasBodyField(body, field) { return Object.prototype.hasOwnProperty.call(body || {}, field); }

async function resolveAssigneeIds(connection, workspaceId, body) {
  const hasMultipleAssignees = hasBodyField(body, 'assigneeIds');
  const hasLegacyAssignee = hasBodyField(body, 'assigneeId');
  if (!hasMultipleAssignees && !hasLegacyAssignee) return null;
  if (hasMultipleAssignees && hasLegacyAssignee) throw new ApiError(400, 'Use assigneeIds instead of assigneeId when assigning multiple people');

  let rawIds;
  if (hasMultipleAssignees) {
    if (!Array.isArray(body.assigneeIds)) throw new ApiError(400, 'assigneeIds must be an array of workspace member IDs');
    if (body.assigneeIds.length > 100) throw new ApiError(400, 'A task can have at most 100 assignees');
    rawIds = body.assigneeIds;
  } else {
    rawIds = body.assigneeId === null || body.assigneeId === undefined || body.assigneeId === '' ? [] : [body.assigneeId];
  }

  const assigneeIds = [...new Set(rawIds.map(value => validId(value, 'assignee')))];
  if (!assigneeIds.length) return assigneeIds;
  const [members] = await connection.query('SELECT user_id FROM workspace_members WHERE workspace_id = ? AND user_id IN (?)', [workspaceId, assigneeIds]);
  if (members.length !== assigneeIds.length) throw new ApiError(400, 'Every assignee must be a member of this workspace');
  return assigneeIds;
}

async function replaceTaskAssignments(connection, workspaceId, taskId, assigneeIds) {
  const [existingRows] = await connection.query('SELECT user_id FROM task_assignments WHERE task_id = ? FOR UPDATE', [taskId]);
  const existingIds = existingRows.map(row => Number(row.user_id));
  const removedIds = existingIds.filter(userId => !assigneeIds.includes(userId));
  const addedIds = assigneeIds.filter(userId => !existingIds.includes(userId));

  if (removedIds.length) await connection.query('DELETE FROM task_assignments WHERE task_id = ? AND user_id IN (?)', [taskId, removedIds]);
  if (addedIds.length) await connection.query('INSERT INTO task_assignments (task_id, user_id, status) VALUES ?', [addedIds.map(userId => [taskId, userId, 'not_started'])]);

  // Keep the original field aligned with the first person for older clients
  // that have not yet moved to the assignments array.
  await connection.query('UPDATE todos SET assignee_user_id = ? WHERE id = ? AND workspace_id = ?', [assigneeIds[0] || null, taskId, workspaceId]);
  return { addedIds, removedIds };
}

async function getTask(connection, workspaceId, taskId) {
  const [rows] = await connection.query('SELECT id, text, done, priority, due_date, parent_id, workspace_id, created_by_user_id, assignee_user_id FROM todos WHERE id = ? AND workspace_id = ? LIMIT 1', [taskId, workspaceId]);
  if (!rows.length) throw new ApiError(404, 'Task not found');
  return rows[0];
}

async function fetchMappedTasks(connection, workspaceId, taskId = null) {
  const taskParams = taskId === null ? [workspaceId] : [workspaceId, taskId];
  const taskCondition = taskId === null ? '' : 'AND t.id = ?';
  const [taskRows] = await connection.query(`SELECT t.id, t.text, t.done, t.priority, t.due_date, t.parent_id, t.workspace_id, t.created_by_user_id, t.assignee_user_id, t.created_at, t.updated_at, assignee.name AS assignee_name, creator.name AS created_by_name FROM todos t LEFT JOIN users assignee ON assignee.id = t.assignee_user_id LEFT JOIN users creator ON creator.id = t.created_by_user_id WHERE t.workspace_id = ? ${taskCondition} ORDER BY COALESCE(t.parent_id, t.id), t.parent_id IS NOT NULL, t.id`, taskParams);
  if (!taskRows.length) return [];

  const taskIds = taskRows.map(row => row.id);
  const [assignmentRows] = await connection.query(`SELECT ta.task_id, ta.user_id, ta.status, ta.created_at, ta.updated_at, u.name, u.email FROM task_assignments ta JOIN users u ON u.id = ta.user_id JOIN workspace_members wm ON wm.workspace_id = ? AND wm.user_id = ta.user_id WHERE ta.task_id IN (?) ORDER BY ta.task_id, ta.created_at, ta.user_id`, [workspaceId, taskIds]);
  const assignmentsByTask = new Map();
  assignmentRows.forEach(row => {
    const assignments = assignmentsByTask.get(row.task_id) || [];
    assignments.push(mapAssignment(row));
    assignmentsByTask.set(row.task_id, assignments);
  });

  return taskRows.map(row => {
    const assignments = assignmentsByTask.get(row.id) || [];
    const primaryAssignment = assignments[0];
    return mapTask(primaryAssignment ? { ...row, assignee_user_id: primaryAssignment.userId, assignee_name: primaryAssignment.name } : row, assignments);
  });
}

async function fetchMappedTask(connection, workspaceId, taskId) {
  const tasks = await fetchMappedTasks(connection, workspaceId, taskId);
  if (!tasks.length) throw new ApiError(404, 'Task not found');
  return tasks[0];
}

app.get('/health', asyncRoute(async (req, res) => { await db.query('SELECT 1'); res.json({ status: 'ok', service: 'taskolab', timestamp: new Date().toISOString() }); }));

app.post('/api/auth/register', authLimiter, asyncRoute(async (req, res) => {
  const name = cleanText(req.body.name, 'Name', 100); const email = normalizeEmail(req.body.email); const password = req.body.password;
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw new ApiError(400, 'Password must be between 8 and 128 characters');
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [existing] = await connection.query('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
    if (existing.length) throw new ApiError(409, 'An account with this email already exists');
    const [result] = await connection.query('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)', [name, email, await bcrypt.hash(password, 12)]);
    const user = { id: result.insertId, name, email, token_version: 0, created_at: new Date().toISOString() };
    await provisionFirstWorkspace(connection, user);
    await connection.commit();
    log('INFO', 'account_registered', { userId: user.id });
    res.status(201).json({ token: issueToken(user), user: mapUser(user) });
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}));
app.post('/api/auth/login', authLimiter, asyncRoute(async (req, res) => {
  const email = normalizeEmail(req.body.email); const password = req.body.password;
  if (typeof password !== 'string') throw new ApiError(400, 'Password is required');
  const [rows] = await db.query('SELECT id, name, email, password_hash, token_version, created_at FROM users WHERE email = ? LIMIT 1', [email]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    log('WARN', 'login_rejected', { emailHash: crypto.createHash('sha256').update(email).digest('hex').slice(0, 12) });
    throw new ApiError(401, 'Email or password is incorrect');
  }
  log('INFO', 'account_logged_in', { userId: user.id }); res.json({ token: issueToken(user), user: mapUser(user) });
}));
app.post('/api/auth/logout', authenticate, asyncRoute(async (req, res) => { await db.query('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [req.user.id]); log('INFO', 'account_logged_out', { userId: req.user.id }); res.status(204).end(); }));
app.get('/api/auth/me', authenticate, (req, res) => res.json({ user: mapUser(req.user) }));

app.get('/api/workspaces', authenticate, asyncRoute(async (req, res) => {
  const [rows] = await db.query(`SELECT w.id, w.name, w.description, wm.role, w.created_at, w.updated_at, COUNT(all_members.user_id) AS member_count FROM workspaces w JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = ? LEFT JOIN workspace_members all_members ON all_members.workspace_id = w.id GROUP BY w.id, w.name, w.description, wm.role, w.created_at, w.updated_at ORDER BY w.updated_at DESC, w.id DESC`, [req.user.id]);
  res.json({ workspaces: rows.map(row => ({ id: row.id, name: row.name, description: row.description, role: row.role, memberCount: Number(row.member_count), createdAt: row.created_at, updatedAt: row.updated_at })) });
}));
app.post('/api/workspaces', authenticate, asyncRoute(async (req, res) => {
  const name = cleanText(req.body.name, 'Workspace name', 120); const description = optionalText(req.body.description, 500); const connection = await db.getConnection();
  try {
    await connection.beginTransaction(); const workspaceId = await createWorkspaceForUser(connection, req.user.id, name, description); await connection.commit();
    const [rows] = await db.query('SELECT id, name, description, created_at, updated_at FROM workspaces WHERE id = ?', [workspaceId]);
    log('INFO', 'workspace_created', { workspaceId, userId: req.user.id }); res.status(201).json({ ...rows[0], role: 'owner', memberCount: 1 });
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}));
app.patch('/api/workspaces/:workspaceId', authenticate, asyncRoute(async (req, res) => {
  const workspaceId = validId(req.params.workspaceId, 'workspace ID'); const workspace = await workspaceAccess(workspaceId, req.user.id); requireRole(workspace, ADMIN_ROLES);
  const fields = []; const values = [];
  if (req.body.name !== undefined) { fields.push('name = ?'); values.push(cleanText(req.body.name, 'Workspace name', 120)); }
  if (req.body.description !== undefined) { fields.push('description = ?'); values.push(optionalText(req.body.description, 500)); }
  if (!fields.length) throw new ApiError(400, 'Provide a workspace name or description to update');
  await db.query(`UPDATE workspaces SET ${fields.join(', ')} WHERE id = ?`, [...values, workspaceId]);
  await recordActivity(db, { workspaceId, actorUserId: req.user.id, type: 'workspace_updated', entityType: 'workspace', entityId: workspaceId, message: 'updated workspace details', icon: '✎' });
  const [rows] = await db.query('SELECT id, name, description, created_at, updated_at FROM workspaces WHERE id = ?', [workspaceId]); res.json({ ...rows[0], role: workspace.role });
}));
app.delete('/api/workspaces/:workspaceId', authenticate, asyncRoute(async (req, res) => {
  const workspaceId = validId(req.params.workspaceId, 'workspace ID'); const workspace = await workspaceAccess(workspaceId, req.user.id);
  if (workspace.role !== 'owner') throw new ApiError(403, 'Only the workspace owner can delete a workspace');
  await db.query('DELETE FROM workspaces WHERE id = ?', [workspaceId]); log('WARN', 'workspace_deleted', { workspaceId, userId: req.user.id }); res.status(204).end();
}));

app.get('/api/workspaces/:workspaceId/members', authenticate, asyncRoute(async (req, res) => {
  const workspaceId = validId(req.params.workspaceId, 'workspace ID'); await workspaceAccess(workspaceId, req.user.id);
  const [rows] = await db.query(`SELECT wm.user_id, wm.role, wm.created_at, u.name, u.email FROM workspace_members wm JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = ? ORDER BY FIELD(wm.role, 'owner', 'admin', 'editor', 'viewer'), u.name`, [workspaceId]);
  res.json({ members: rows.map(row => ({ userId: row.user_id, name: row.name, email: row.email, role: row.role, joinedAt: row.created_at })) });
}));
app.post('/api/workspaces/:workspaceId/members', authenticate, asyncRoute(async (req, res) => {
  const workspaceId = validId(req.params.workspaceId, 'workspace ID'); const workspace = await workspaceAccess(workspaceId, req.user.id); requireRole(workspace, ADMIN_ROLES);
  const email = normalizeEmail(req.body.email); const role = req.body.role || 'viewer'; if (!VALID_ROLES.has(role)) throw new ApiError(400, 'Member role must be admin, editor, or viewer');
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction(); const [users] = await connection.query('SELECT id, name, email FROM users WHERE email = ? LIMIT 1', [email]);
    if (!users.length) throw new ApiError(404, 'This person needs a Taskolab account before they can be added');
    const member = users[0]; const [existing] = await connection.query('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ? LIMIT 1', [workspaceId, member.id]);
    if (existing.length) throw new ApiError(409, 'This person is already a member of the workspace');
    await connection.query('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)', [workspaceId, member.id, role]);
    await recordActivity(connection, { workspaceId, actorUserId: req.user.id, type: 'member_added', entityType: 'member', entityId: member.id, message: `added ${member.name} as ${role}`, icon: '♙', details: { memberId: member.id, role } });
    await connection.commit(); res.status(201).json({ userId: member.id, name: member.name, email: member.email, role });
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}));
app.patch('/api/workspaces/:workspaceId/members/:userId', authenticate, asyncRoute(async (req, res) => {
  const workspaceId = validId(req.params.workspaceId, 'workspace ID'); const targetUserId = validId(req.params.userId, 'user ID'); const workspace = await workspaceAccess(workspaceId, req.user.id); requireRole(workspace, ADMIN_ROLES);
  const role = req.body.role; if (!VALID_ROLES.has(role)) throw new ApiError(400, 'Member role must be admin, editor, or viewer');
  const [members] = await db.query('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ? LIMIT 1', [workspaceId, targetUserId]);
  if (!members.length) throw new ApiError(404, 'Workspace member not found'); if (members[0].role === 'owner') throw new ApiError(400, 'The workspace owner role cannot be changed'); if (workspace.role === 'admin' && role === 'admin') throw new ApiError(403, 'Only the workspace owner can grant admin access');
  await db.query('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?', [role, workspaceId, targetUserId]);
  const [users] = await db.query('SELECT name, email FROM users WHERE id = ?', [targetUserId]); await recordActivity(db, { workspaceId, actorUserId: req.user.id, type: 'member_role_changed', entityType: 'member', entityId: targetUserId, message: `changed ${users[0].name}'s role to ${role}`, icon: '♙', details: { role } });
  res.json({ userId: targetUserId, name: users[0].name, email: users[0].email, role });
}));
app.delete('/api/workspaces/:workspaceId/members/:userId', authenticate, asyncRoute(async (req, res) => {
  const workspaceId = validId(req.params.workspaceId, 'workspace ID'); const targetUserId = validId(req.params.userId, 'user ID'); const workspace = await workspaceAccess(workspaceId, req.user.id); requireRole(workspace, ADMIN_ROLES);
  const [members] = await db.query('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ? LIMIT 1', [workspaceId, targetUserId]);
  if (!members.length) throw new ApiError(404, 'Workspace member not found'); if (members[0].role === 'owner') throw new ApiError(400, 'The workspace owner cannot be removed'); if (workspace.role === 'admin' && targetUserId !== req.user.id) throw new ApiError(403, 'Only the workspace owner can remove other members');
  const [users] = await db.query('SELECT name FROM users WHERE id = ?', [targetUserId]);
  // Membership removal must also revoke the former member's personal task
  // progress record; otherwise a removed user would remain shown on the task.
  await db.query('DELETE ta FROM task_assignments ta INNER JOIN todos t ON t.id = ta.task_id WHERE t.workspace_id = ? AND ta.user_id = ?', [workspaceId, targetUserId]);
  await db.query('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [workspaceId, targetUserId]);
  await db.query('UPDATE todos SET assignee_user_id = NULL WHERE workspace_id = ? AND assignee_user_id = ?', [workspaceId, targetUserId]);
  await recordActivity(db, { workspaceId, actorUserId: req.user.id, type: 'member_removed', entityType: 'member', entityId: targetUserId, message: `removed ${users[0].name} from the workspace`, icon: '♙' }); res.status(204).end();
}));

app.get('/api/workspaces/:workspaceId/tasks', authenticate, asyncRoute(async (req, res) => {
  const workspaceId = validId(req.params.workspaceId, 'workspace ID'); await workspaceAccess(workspaceId, req.user.id);
  res.json({ tasks: await fetchMappedTasks(db, workspaceId) });
}));
app.post('/api/workspaces/:workspaceId/tasks', authenticate, asyncRoute(async (req, res) => {
  const workspaceId = validId(req.params.workspaceId, 'workspace ID'); const workspace = await workspaceAccess(workspaceId, req.user.id); requireRole(workspace, WRITE_ROLES);
  const text = cleanText(req.body.text, 'Task text', 200); const priority = validPriority(req.body.priority || 'medium'); const dueDate = validDate(req.body.dueDate); const parentId = req.body.parentId === null || req.body.parentId === undefined || req.body.parentId === '' ? null : validId(req.body.parentId, 'parent task ID');
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    if (parentId) { const parent = await getTask(connection, workspaceId, parentId); if (parent.parent_id !== null) throw new ApiError(400, 'A subtask must belong to a top-level task'); if (parent.due_date && dueDate && dueDate > parent.due_date) throw new ApiError(400, 'A subtask due date cannot be later than its parent task due date'); }
    const assigneeIds = (await resolveAssigneeIds(connection, workspaceId, req.body)) || [];
    const [result] = await connection.query('INSERT INTO todos (text, done, priority, due_date, parent_id, workspace_id, created_by_user_id, assignee_user_id) VALUES (?, FALSE, ?, ?, ?, ?, ?, ?)', [text, priority, dueDate, parentId, workspaceId, req.user.id, assigneeIds[0] || null]);
    const taskId = result.insertId;
    await replaceTaskAssignments(connection, workspaceId, taskId, assigneeIds);
    await recordActivity(connection, { workspaceId, actorUserId: req.user.id, type: parentId ? 'subtask_created' : 'task_created', entityType: 'task', entityId: taskId, message: `${parentId ? 'added a subtask' : 'created a task'}: ${text}`, icon: '＋', details: { parentId, assigneeIds } });
    const task = await fetchMappedTask(connection, workspaceId, taskId); await connection.commit(); res.status(201).json(task);
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}));
app.patch('/api/workspaces/:workspaceId/tasks/:taskId', authenticate, asyncRoute(async (req, res) => {
  const workspaceId = validId(req.params.workspaceId, 'workspace ID'); const taskId = validId(req.params.taskId, 'task ID'); const workspace = await workspaceAccess(workspaceId, req.user.id); requireRole(workspace, WRITE_ROLES);
  const { text, done, priority, dueDate, forceComplete = false } = req.body;
  const hasAssignmentUpdate = hasBodyField(req.body, 'assigneeIds') || hasBodyField(req.body, 'assigneeId');
  if (done !== undefined && typeof done !== 'boolean') throw new ApiError(400, 'Done must be true or false'); if (priority !== undefined) validPriority(priority); const normalizedDate = dueDate !== undefined ? validDate(dueDate) : undefined;
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction(); const task = await getTask(connection, workspaceId, taskId);
    const assigneeIds = hasAssignmentUpdate ? await resolveAssigneeIds(connection, workspaceId, req.body) : null;
    if (done && !task.done && !forceComplete) { const [[{ total }]] = await connection.query('SELECT COUNT(*) AS total FROM todos WHERE workspace_id = ? AND parent_id = ? AND done = FALSE', [workspaceId, taskId]); if (total) throw new ApiError(409, 'This task still has pending subtasks', { pendingSubtasks: Number(total) }); }
    if (normalizedDate !== undefined) {
      if (task.parent_id) { const parent = await getTask(connection, workspaceId, task.parent_id); if (parent.due_date && normalizedDate && normalizedDate > parent.due_date) throw new ApiError(400, 'A subtask due date cannot be later than its parent task due date'); }
      else if (normalizedDate) { const [[{ latestChildDate }]] = await connection.query('SELECT MAX(due_date) AS latestChildDate FROM todos WHERE workspace_id = ? AND parent_id = ?', [workspaceId, taskId]); if (latestChildDate && normalizedDate < latestChildDate) throw new ApiError(400, 'A parent due date cannot be earlier than a subtask due date'); }
    }
    const fields = []; const values = []; const changed = [];
    if (text !== undefined) { fields.push('text = ?'); values.push(cleanText(text, 'Task text', 200)); changed.push('title'); }
    if (done !== undefined) { fields.push('done = ?'); values.push(done); changed.push(done ? 'completed task' : 'reopened task'); }
    if (priority !== undefined) { fields.push('priority = ?'); values.push(priority); changed.push('priority'); }
    if (normalizedDate !== undefined) { fields.push('due_date = ?'); values.push(normalizedDate); changed.push('due date'); }
    if (!fields.length && assigneeIds === null) throw new ApiError(400, 'Provide at least one task field or assignee update');
    if (fields.length) await connection.query(`UPDATE todos SET ${fields.join(', ')} WHERE id = ? AND workspace_id = ?`, [...values, taskId, workspaceId]);
    const assignmentChanges = assigneeIds === null ? null : await replaceTaskAssignments(connection, workspaceId, taskId, assigneeIds);
    if (assignmentChanges) changed.push('assignees');
    const updated = await fetchMappedTask(connection, workspaceId, taskId);
    const message = done === true ? `completed task: ${updated.text}` : done === false ? `reopened task: ${updated.text}` : `updated ${changed.join(', ')} on task: ${updated.text}`;
    await recordActivity(connection, { workspaceId, actorUserId: req.user.id, type: done === true ? 'task_completed' : assignmentChanges ? 'task_assignments_updated' : 'task_updated', entityType: 'task', entityId: taskId, message, icon: done === true ? '✓' : '✎', details: { changed, assignmentChanges } });
    await connection.commit(); res.json(updated);
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}));
app.patch('/api/workspaces/:workspaceId/tasks/:taskId/assignments/:userId', authenticate, asyncRoute(async (req, res) => {
  const workspaceId = validId(req.params.workspaceId, 'workspace ID');
  const taskId = validId(req.params.taskId, 'task ID');
  const targetUserId = validId(req.params.userId, 'user ID');
  const workspace = await workspaceAccess(workspaceId, req.user.id);
  const isOwnAssignment = targetUserId === req.user.id;
  if (!isOwnAssignment) requireRole(workspace, WRITE_ROLES);
  const status = validAssignmentStatus(req.body.status);
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const task = await getTask(connection, workspaceId, taskId);
    const [assignmentRows] = await connection.query(`SELECT ta.user_id FROM task_assignments ta JOIN workspace_members wm ON wm.workspace_id = ? AND wm.user_id = ta.user_id WHERE ta.task_id = ? AND ta.user_id = ? FOR UPDATE`, [workspaceId, taskId, targetUserId]);
    if (!assignmentRows.length) {
      throw new ApiError(isOwnAssignment ? 403 : 404, isOwnAssignment ? 'You are not assigned to this task' : 'Task assignment not found');
    }
    await connection.query('UPDATE task_assignments SET status = ? WHERE task_id = ? AND user_id = ?', [status, taskId, targetUserId]);
    const updatedTask = await fetchMappedTask(connection, workspaceId, taskId);
    const updatedAssignment = updatedTask.assignments.find(assignment => Number(assignment.userId) === targetUserId);
    const statusLabel = status.replace('_', ' ');
    const message = isOwnAssignment ? `updated their work status to ${statusLabel} on task: ${task.text}` : `updated ${updatedAssignment.name}'s work status to ${statusLabel} on task: ${task.text}`;
    await recordActivity(connection, { workspaceId, actorUserId: req.user.id, type: 'assignment_status_updated', entityType: 'task_assignment', entityId: taskId, message, icon: '◷', details: { userId: targetUserId, status } });
    await connection.commit();
    res.json({ task: updatedTask, assignment: updatedAssignment });
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}));
app.delete('/api/workspaces/:workspaceId/tasks/:taskId', authenticate, asyncRoute(async (req, res) => {
  const workspaceId = validId(req.params.workspaceId, 'workspace ID'); const taskId = validId(req.params.taskId, 'task ID'); const workspace = await workspaceAccess(workspaceId, req.user.id); requireRole(workspace, WRITE_ROLES);
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction(); const task = await getTask(connection, workspaceId, taskId); const [[{ childCount }]] = await connection.query('SELECT COUNT(*) AS childCount FROM todos WHERE workspace_id = ? AND parent_id = ?', [workspaceId, taskId]);
    await connection.query('DELETE FROM todos WHERE id = ? AND workspace_id = ?', [taskId, workspaceId]); await recordActivity(connection, { workspaceId, actorUserId: req.user.id, type: 'task_deleted', entityType: 'task', entityId: taskId, message: `deleted task${childCount ? ' group' : ''}: ${task.text}`, icon: '×', details: { deletedSubtasks: Number(childCount) } });
    await connection.commit(); res.status(204).end();
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}));
app.get('/api/workspaces/:workspaceId/activity', authenticate, asyncRoute(async (req, res) => {
  const workspaceId = validId(req.params.workspaceId, 'workspace ID'); await workspaceAccess(workspaceId, req.user.id); const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const [rows] = await db.query(`SELECT a.id, a.event_type, a.entity_type, a.entity_id, a.message, a.icon, a.details, a.created_at, u.name AS actor_name FROM activity_log a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.workspace_id = ? ORDER BY a.id DESC LIMIT ?`, [workspaceId, limit]);
  res.json({ activity: rows.map(mapActivity) });
}));

app.get('/api/todos', authenticate, asyncRoute(async (req, res) => {
  const workspaceId = validId(req.query.workspaceId, 'workspace ID'); await workspaceAccess(workspaceId, req.user.id);
  res.json(await fetchMappedTasks(db, workspaceId));
}));

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '1h', etag: true }));
app.use((req, res) => req.path.startsWith('/api/') ? res.status(404).json({ message: 'API route not found' }) : res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
  const malformedJson = error?.type === 'entity.parse.failed';
  const status = error instanceof ApiError ? error.status : malformedJson ? 400 : 500;
  const message = error instanceof ApiError ? error.message : malformedJson ? 'Request body must be valid JSON' : 'Something went wrong. Please try again.';
  const requestId = crypto.randomUUID();
  if (status >= 500) log('ERROR', 'request_failed', { requestId, method: req.method, path: req.path, message: error.message }); else log('WARN', 'request_rejected', { requestId, method: req.method, path: req.path, status });
  res.status(status).json({ message, ...(error instanceof ApiError ? error.extra : {}), ...(status >= 500 ? { requestId } : {}) });
});
async function shutdown(signal) {
  log('INFO', 'shutdown_requested', { signal }); if (httpServer) await new Promise(resolve => httpServer.close(resolve)); if (db) await db.end(); process.exit(0);
}
initializeDatabase().then(() => { httpServer = app.listen(PORT, () => log('INFO', 'server_started', { port: PORT })); }).catch(error => { log('ERROR', 'database_initialization_failed', { message: error.message }); process.exit(1); });
process.on('SIGTERM', () => { shutdown('SIGTERM').catch(error => { console.error(error); process.exit(1); }); });
process.on('SIGINT', () => { shutdown('SIGINT').catch(error => { console.error(error); process.exit(1); }); });
