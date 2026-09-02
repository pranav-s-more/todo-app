require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const mysql = require('mysql2/promise');

const app = express();
const PORT = process.env.PORT || 5000;
const dataFile = path.join(__dirname, 'data', 'todos.json');
const logsDirectory = path.join(__dirname, 'logs');
const logFile = path.join(logsDirectory, 'app.log');
const databaseName = process.env.DB_NAME || 'todo_app';
let db;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (error) {
    log('ERROR', `GET /health | ${error.message}`);
    res.status(503).json({ status: 'unavailable' });
  }
});

function log(level, message) {
  const entry = `[${new Date().toISOString()}] [${level}] ${message}`;
  console.log(entry);
  try { fs.mkdirSync(logsDirectory, { recursive: true }); fs.appendFileSync(logFile, `${entry}\n`); }
  catch (error) { console.error(`Could not write to log file: ${error.message}`); }
}

function config(includeDatabase = true) {
  return { host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', ...(includeDatabase ? { database: databaseName } : {}), dateStrings: true };
}
function mapTodo(row) { return { id: row.id, text: row.text, done: Boolean(row.done), priority: row.priority, dueDate: row.due_date, parentId: row.parent_id }; }
function validPriority(priority) { return ['low', 'medium', 'high'].includes(priority); }

async function initializeDatabase() {
  if (!/^[A-Za-z0-9_]+$/.test(databaseName)) throw new Error('DB_NAME may contain only letters, numbers, and underscores');
  const bootstrap = await mysql.createConnection(config(false));
  await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await bootstrap.end();
  db = mysql.createPool({ ...config(), waitForConnections: true, connectionLimit: 10 });
  await db.query(`CREATE TABLE IF NOT EXISTS todos (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    text VARCHAR(200) NOT NULL,
    done BOOLEAN NOT NULL DEFAULT FALSE,
    priority ENUM('low', 'medium', 'high') NOT NULL DEFAULT 'medium',
    due_date DATE NULL,
    parent_id INT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT fk_todos_parent FOREIGN KEY (parent_id) REFERENCES todos(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  await migrateJsonTodos();
}

async function migrateJsonTodos() {
  const [[{ total }]] = await db.query('SELECT COUNT(*) AS total FROM todos');
  if (total || !fs.existsSync(dataFile)) return;
  let savedTodos;
  try { savedTodos = JSON.parse(fs.readFileSync(dataFile, 'utf8')); }
  catch (error) { log('WARN', `Skipped JSON migration: ${error.message}`); return; }
  if (!Array.isArray(savedTodos) || !savedTodos.length) return;
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    for (const todo of savedTodos) {
      await connection.query('INSERT INTO todos (id, text, done, priority, due_date, parent_id) VALUES (?, ?, ?, ?, ?, ?)', [todo.id, todo.text, Boolean(todo.done), validPriority(todo.priority) ? todo.priority : 'medium', todo.dueDate || null, todo.parentId || null]);
    }
    await connection.commit();
    log('INFO', `Migrated ${savedTodos.length} task(s) from data/todos.json to MySQL`);
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

app.get('/api/todos', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, text, done, priority, due_date, parent_id FROM todos ORDER BY id');
    log('INFO', `GET /api/todos | Total tasks = ${rows.length}`);
    res.json(rows.map(mapTodo));
  } catch (error) { log('ERROR', `GET /api/todos | ${error.message}`); res.status(500).json({ message: 'Could not load tasks' }); }
});

app.post('/api/todos', async (req, res) => {
  const { text, priority = 'medium', dueDate = null, parentId = null } = req.body;
  const cleanedText = typeof text === 'string' ? text.trim() : '';
  if (!cleanedText) return res.status(400).json({ message: 'Task text is required' });
  if (!validPriority(priority)) return res.status(400).json({ message: 'Priority must be low, medium, or high' });
  try {
    if (parentId !== null) {
      const [parents] = await db.query('SELECT id, parent_id, due_date FROM todos WHERE id = ?', [parentId]);
      const parent = parents[0];
      if (!parent || parent.parent_id !== null) return res.status(400).json({ message: 'A subtask must belong to a top-level task' });
      if (parent.due_date && dueDate && dueDate > parent.due_date) return res.status(400).json({ message: 'A subtask due date cannot be later than its parent task due date' });
    }
    const [result] = await db.query('INSERT INTO todos (text, done, priority, due_date, parent_id) VALUES (?, FALSE, ?, ?, ?)', [cleanedText, priority, dueDate || null, parentId || null]);
    const [rows] = await db.query('SELECT id, text, done, priority, due_date, parent_id FROM todos WHERE id = ?', [result.insertId]);
    const todo = mapTodo(rows[0]);
    log('INFO', `POST /api/todos | Task created | id=${todo.id} | text="${todo.text}"`);
    res.status(201).json(todo);
  } catch (error) { log('ERROR', `POST /api/todos | ${error.message}`); res.status(500).json({ message: 'Could not create task' }); }
});

app.patch('/api/todos/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { text, done, priority, dueDate, forceComplete = false } = req.body;
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid task id' });
  if (text !== undefined && !String(text).trim()) return res.status(400).json({ message: 'Task text is required' });
  if (done !== undefined && typeof done !== 'boolean') return res.status(400).json({ message: 'Done must be true or false' });
  if (priority !== undefined && !validPriority(priority)) return res.status(400).json({ message: 'Priority must be low, medium, or high' });
  try {
    const [found] = await db.query('SELECT id, done, parent_id FROM todos WHERE id = ?', [id]);
    const todo = found[0];
    if (!todo) return res.status(404).json({ message: 'Task not found' });
    if (done && !todo.done && !forceComplete) {
      const [[{ total }]] = await db.query('SELECT COUNT(*) AS total FROM todos WHERE parent_id = ? AND done = FALSE', [id]);
      if (total) return res.status(409).json({ message: 'This task still has pending subtasks', pendingSubtasks: total });
    }
    if (dueDate !== undefined) {
      if (todo.parent_id) {
        const [parents] = await db.query('SELECT due_date FROM todos WHERE id = ?', [todo.parent_id]);
        if (parents[0].due_date && dueDate && dueDate > parents[0].due_date) return res.status(400).json({ message: 'A subtask due date cannot be later than its parent task due date' });
      } else if (dueDate) {
        const [[{ latestChildDate }]] = await db.query('SELECT MAX(due_date) AS latestChildDate FROM todos WHERE parent_id = ?', [id]);
        if (latestChildDate && dueDate < latestChildDate) return res.status(400).json({ message: 'A parent due date cannot be earlier than a subtask due date' });
      }
    }
    const fields = []; const values = [];
    if (text !== undefined) { fields.push('text = ?'); values.push(String(text).trim()); }
    if (done !== undefined) { fields.push('done = ?'); values.push(done); }
    if (priority !== undefined) { fields.push('priority = ?'); values.push(priority); }
    if (dueDate !== undefined) { fields.push('due_date = ?'); values.push(dueDate || null); }
    if (fields.length) await db.query(`UPDATE todos SET ${fields.join(', ')} WHERE id = ?`, [...values, id]);
    const [rows] = await db.query('SELECT id, text, done, priority, due_date, parent_id FROM todos WHERE id = ?', [id]);
    log('INFO', `PATCH /api/todos/${id} | Task updated`);
    res.json(mapTodo(rows[0]));
  } catch (error) { log('ERROR', `PATCH /api/todos/${id} | ${error.message}`); res.status(500).json({ message: 'Could not update task' }); }
});

app.delete('/api/todos/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const [result] = await db.query('DELETE FROM todos WHERE id = ?', [id]);
    if (!result.affectedRows) return res.status(404).json({ message: 'Task not found' });
    log('INFO', `DELETE /api/todos/${id} | Task deleted`);
    res.json({ message: 'Deleted' });
  } catch (error) { log('ERROR', `DELETE /api/todos/${id} | ${error.message}`); res.status(500).json({ message: 'Could not delete task' }); }
});

initializeDatabase()
  .then(() => app.listen(PORT, () => log('INFO', `Server started successfully on http://localhost:${PORT}`)))
  .catch(error => { log('ERROR', `Could not connect to MySQL: ${error.message}`); process.exit(1); });
