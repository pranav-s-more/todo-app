const express = require('express');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
let todos = [];
let nextId = 1;

// GET all todos
app.get('/api/todos', (req, res) => {
  res.json(todos);
});

// POST - add a new todo
app.post('/api/todos', (req, res) => {
  const { text } = req.body;
  const todo = { id: nextId++, text, done: false };
  todos.push(todo);
  res.status(201).json(todo);
 console.log(
  `[INFO] Todo created | id=${todo.id} | text="${todo.text}"`
);
});
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
// PATCH - toggle done
app.patch('/api/todos/:id', (req, res) => {
  const id = parseInt(req.params.id); // :id comes from the URL
  const todo = todos.find(t => t.id === id);
  todo.done = !todo.done; 
  res.json(todo);
});

// DELETE
app.delete('/api/todos/:id', (req, res) => {
  const id = parseInt(req.params.id);
 todos = todos.filter(t => t.id !== id); // keep everything EXCEPT the one with this id
  res.json({ message: 'Deleted' });
  console.log(`todo deleted`);
});