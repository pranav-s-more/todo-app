require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let todos = [];
let nextId = 1;

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
  const { text } = req.body;

  if (!text) {
    log("WARN", "POST /api/todos | Empty todo received");
    return res.status(400).json({ message: "Todo text is required" });
  }

  const todo = {
    id: nextId++,
    text,
    done: false
  };

  todos.push(todo);

  log(
    "INFO",
    `POST /api/todos | Todo Created | id=${todo.id} | text="${todo.text}"`
  );

  res.status(201).json(todo);
});

// PATCH - toggle done
app.patch('/api/todos/:id', (req, res) => {
  const id = parseInt(req.params.id);

  const todo = todos.find(t => t.id === id);

  if (!todo) {
    log("ERROR", `PATCH /api/todos/${id} | Todo not found`);
    return res.status(404).json({ message: "Todo not found" });
  }

  todo.done = !todo.done;

  log(
    "INFO",
    `PATCH /api/todos/${id} | done=${todo.done}`
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

  todos = todos.filter(t => t.id !== id);

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