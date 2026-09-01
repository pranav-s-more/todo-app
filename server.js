require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const dataDirectory = path.join(__dirname, 'data');
const dataFile = path.join(dataDirectory, 'todos.json');

function loadTodos() {
  try {
    if (!fs.existsSync(dataFile)) return [];
    const savedTodos = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    return Array.isArray(savedTodos) ? savedTodos : [];
  } catch (error) {
    log('ERROR', `Could not read saved todos: ${error.message}`);
    return [];
  }
}

function saveTodos() {
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify(todos, null, 2));
}

let todos = loadTodos();
let nextId = todos.reduce((highestId, todo) => Math.max(highestId, todo.id || 0), 0) + 1;

// Helper function for logging
function log(level, message) {
  console.log(`[${new Date().toISOString()}] [${level}] ${message}`);
}

// GET all todos
app.get('/api/todos', (req, res) => {
  log("INFO", `GET /api/todos | Total Todos = ${todos.length}`);
  res.json(todos);
});

// POST - add a new todo
app.post('/api/todos', (req, res) => {
  const { text, priority = 'medium', dueDate = null, parentId = null } = req.body;
  const cleanedText = typeof text === 'string' ? text.trim() : '';

  if (!cleanedText) {
    log("WARN", "POST /api/todos | Empty todo received");
    return res.status(400).json({ message: "Todo text is required" });
  }

  if (!['low', 'medium', 'high'].includes(priority)) {
    return res.status(400).json({ message: 'Priority must be low, medium, or high' });
  }

  if (parentId !== null) {
    const parent = todos.find(todo => todo.id === Number(parentId));
    if (!parent || parent.parentId) {
      return res.status(400).json({ message: 'A subtask must belong to a top-level task' });
    }
    if (parent.dueDate && dueDate && dueDate > parent.dueDate) {
      return res.status(400).json({ message: 'A subtask due date cannot be later than its parent task due date' });
    }
  }

  const todo = {
    id: nextId++,
    text: cleanedText,
    done: false,
    priority,
    dueDate,
    parentId: parentId === null ? null : Number(parentId)
  };

  todos.push(todo);
  saveTodos();

  log(
    "INFO",
    `POST /api/todos | Todo Created | id=${todo.id} | text="${todo.text}"`
  );

  res.status(201).json(todo);
});

// PATCH - update a todo
app.patch('/api/todos/:id', (req, res) => {
  const id = parseInt(req.params.id);

  const todo = todos.find(t => t.id === id);

  if (!todo) {
    log("ERROR", `PATCH /api/todos/${id} | Todo not found`);
    return res.status(404).json({ message: "Todo not found" });
  }

  const { text, done, priority, dueDate, forceComplete = false } = req.body;

  if (text !== undefined) {
    const cleanedText = typeof text === 'string' ? text.trim() : '';
    if (!cleanedText) return res.status(400).json({ message: 'Todo text is required' });
    todo.text = cleanedText;
  }
  if (done !== undefined) {
    if (typeof done !== 'boolean') return res.status(400).json({ message: 'Done must be true or false' });
    const pendingSubtasks = todos.filter(item => Number(item.parentId) === id && !item.done);
    if (done && !todo.done && pendingSubtasks.length && !forceComplete) {
      return res.status(409).json({
        message: 'This task still has pending subtasks',
        pendingSubtasks: pendingSubtasks.length
      });
    }
    todo.done = done;
  }
  if (priority !== undefined) {
    if (!['low', 'medium', 'high'].includes(priority)) {
      return res.status(400).json({ message: 'Priority must be low, medium, or high' });
    }
    todo.priority = priority;
  }
  if (dueDate !== undefined) todo.dueDate = dueDate || null;
  saveTodos();

  log(
    "INFO",
    `PATCH /api/todos/${id} | Todo updated`
  );

  res.json(todo);
});

// DELETE
app.delete('/api/todos/:id', (req, res) => {
  const id = parseInt(req.params.id);

  const todo = todos.find(t => t.id === id);

  if (!todo) {
    log("ERROR", `DELETE /api/todos/${id} | Todo not found`);
    return res.status(404).json({ message: "Todo not found" });
  }

  todos = todos.filter(t => t.id !== id && t.parentId !== id);
  saveTodos();

  log(
    "INFO",
    `DELETE /api/todos/${id} | Todo Deleted`
  );

  res.json({ message: "Deleted" });
});

// Start Server
app.listen(PORT, () => {
  log("INFO", `Server started successfully on http://localhost:${PORT}`);
});
