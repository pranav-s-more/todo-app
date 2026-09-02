let todos = [];
let filter = 'all';
const expandedGroups = new Set();
let todoToDelete = null;
let parentForSubtask = null;
let parentToComplete = null;
const status = document.getElementById('status');
const deleteModal = document.getElementById('delete-modal');
const subtaskModal = document.getElementById('subtask-modal');
const pendingModal = document.getElementById('pending-modal');
const dueDateModal = document.getElementById('due-date-modal');

function showError(message = '') { status.textContent = message; }
function isChildOf(todo, parentId) { return Number(todo.parentId) === Number(parentId); }
function renderTodos() {
  const search = document.getElementById('search').value.toLowerCase();
  const roots = todos.filter(todo => !todo.parentId);
  const isFamilyComplete = todo => todo.done && todos.filter(child => isChildOf(child, todo.id)).every(child => child.done);
  const matchesSearch = todo => todo.text.toLowerCase().includes(search) || todos.some(child => isChildOf(child, todo.id) && child.text.toLowerCase().includes(search));
  const visibleTodos = roots.filter(todo => matchesSearch(todo) && (filter === 'all' || (filter === 'done' ? isFamilyComplete(todo) : !isFamilyComplete(todo))));

  const list = document.getElementById('list');
  list.innerHTML = '';

  if (!visibleTodos.length) { list.innerHTML = '<li class="empty">No tasks here yet.</li>'; return; }
  const activeTodos = visibleTodos.filter(todo => !isFamilyComplete(todo));
  const completedTodos = visibleTodos.filter(isFamilyComplete);
  const appendSection = (title, items) => {
    if (!items.length) return;
    const heading = document.createElement('li');
    heading.className = 'section-heading';
    heading.textContent = title;
    list.appendChild(heading);
    items.forEach(renderTodo);
  };

  if (filter === 'all') {
    appendSection('To do', activeTodos);
    appendSection('Completed', completedTodos);
  } else {
    appendSection(filter === 'active' ? 'To do' : 'Completed', visibleTodos);
  }
}

function renderTodo(t) {
  const li = createTaskItem(t, false);
  const subtasks = todos.filter(child => isChildOf(child, t.id));
  if (subtasks.length) {
    li.classList.add('group');
    const parentRow = document.createElement('div');
    parentRow.className = 'group-parent';
    while (li.firstChild) parentRow.appendChild(li.firstChild);
    const heading = document.createElement('summary');
    heading.className = 'subtask-heading';
    heading.textContent = `${subtasks.length} subtask${subtasks.length === 1 ? '' : 's'}`;
    const subtaskList = document.createElement('ul');
    subtaskList.className = 'subtask-list';
    subtasks.forEach(child => subtaskList.appendChild(createTaskItem(child, true)));
    const childrenSection = document.createElement('details');
    childrenSection.className = 'group-children';
    childrenSection.open = expandedGroups.has(t.id);
    childrenSection.addEventListener('toggle', () => {
      if (childrenSection.open) expandedGroups.add(t.id);
      else expandedGroups.delete(t.id);
    });
    childrenSection.append(heading, subtaskList);
    li.append(parentRow, childrenSection);
  }
  document.getElementById('list').appendChild(li);
}

function createTaskItem(t, isSubtask) {
  const li = document.createElement('li');
  li.className = t.done ? 'done' : '';
  li.innerHTML = `<input class="check" type="checkbox" aria-label="Mark task complete" ${t.done ? 'checked' : ''}><div class="task"><span class="task-text"></span><div class="meta">${isSubtask ? '<span class="subtask-kind">Subtask</span>' : '<span class="subtask-kind">Task</span>'}<span class="badge ${t.priority || 'medium'}">${t.priority || 'medium'}</span>${t.dueDate ? `<span>Due ${new Date(t.dueDate + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>` : ''}</div></div><div class="actions"><select class="priority-select" aria-label="Change priority"><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select>${isSubtask ? '' : '<button class="icon subtask" aria-label="Add subtask">Subtask</button>'}<button class="icon edit" aria-label="Edit task">Edit</button><button class="icon delete" aria-label="Delete task">Delete</button></div>`;
  li.querySelector('.task-text').textContent = t.text;
  li.querySelector('.priority-select').value = t.priority || 'medium';
  li.querySelector('.check').addEventListener('click', event => toggleTask(t, event));
  li.querySelector('.priority-select').addEventListener('change', event => updateTodo(t.id, { priority: event.target.value }));
  if (!isSubtask) li.querySelector('.subtask').addEventListener('click', () => openSubtaskModal(t));
  li.querySelector('.edit').addEventListener('click', () => editTodo(t));
  li.querySelector('.delete').addEventListener('click', () => openDeleteModal(t.id));
  return li;
}

async function loadTodos() {
  try {
    const res = await fetch('/api/todos');
    if (!res.ok) throw new Error();
    todos = await res.json();
    renderTodos();
  } catch {
    showError('Could not load your tasks.');
  }
}

async function addTodo(event) {
  event.preventDefault();
  const input = document.getElementById('new-task');
  try {
    const response = await fetch('/api/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: input.value,
        priority: document.getElementById('priority').value,
        dueDate: document.getElementById('due-date').value || null
      })
    });
    if (!response.ok) throw new Error();
    document.getElementById('todo-form').reset();
    showError();
    await loadTodos();
  } catch {
    showError('Could not add the task. Please try again.');
  }
}

async function updateTodo(id, changes) {
  try {
    const response = await fetch(`/api/todos/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes)
    });
    if (!response.ok) throw new Error();
    showError();
    await loadTodos();
  } catch {
    showError('Could not save that change.');
  }
}

function toggleTask(todo, event) {
  const pendingSubtasks = todos.filter(child => isChildOf(child, todo.id) && !child.done);
  if (!todo.done && pendingSubtasks.length) {
    event.preventDefault();
    event.target.checked = false;
    parentToComplete = todo.id;
    document.getElementById('pending-message').textContent = `${pendingSubtasks.length} subtask${pendingSubtasks.length === 1 ? ' is' : 's are'} still pending. You can finish the group anyway or keep working on them first.`;
    pendingModal.hidden = false;
    document.getElementById('cancel-pending').focus();
    return;
  }
  updateTodo(todo.id, { done: !todo.done });
}

function openDeleteModal(id) {
  todoToDelete = id;
  const pendingSubtasks = todos.filter(todo => isChildOf(todo, id) && !todo.done);
  const title = document.getElementById('delete-title');
  const message = document.getElementById('delete-message');
  const confirmButton = document.getElementById('confirm-delete');
  if (pendingSubtasks.length) {
    title.textContent = 'Delete group with pending subtasks?';
    message.textContent = `${pendingSubtasks.length} subtask${pendingSubtasks.length === 1 ? ' is' : 's are'} still unfinished. Deleting this group permanently removes the parent task and every subtask.`;
    confirmButton.textContent = 'Delete group';
  } else {
    title.textContent = 'Delete task?';
    message.textContent = 'This task will be permanently removed from your list.';
    confirmButton.textContent = 'Delete task';
  }
  deleteModal.hidden = false;
  document.getElementById('cancel-delete').focus();
}

function closeDeleteModal() {
  todoToDelete = null;
  deleteModal.hidden = true;
}

async function deleteTodo() {
  if (todoToDelete === null) return;
  const id = todoToDelete;
  closeDeleteModal();
  try {
    const response = await fetch(`/api/todos/${id}`, { method: 'DELETE' });
    if (!response.ok) throw new Error();
    showError();
    await loadTodos();
  } catch {
    showError('Could not delete the task.');
  }
}

function editTodo(todo) {
  const text = prompt('Update task', todo.text);
  if (text !== null && text.trim()) updateTodo(todo.id, { text: text.trim() });
}

function openSubtaskModal(parent) {
  parentForSubtask = parent.id;
  document.getElementById('subtask-parent').textContent = `Add a step under “${parent.text}”.`;
  subtaskModal.hidden = false;
  document.getElementById('subtask-text').focus();
}

function closeSubtaskModal() {
  parentForSubtask = null;
  subtaskModal.hidden = true;
  document.getElementById('subtask-form').reset();
}

function closePendingModal() {
  parentToComplete = null;
  pendingModal.hidden = true;
}

function completeParentAnyway() {
  if (parentToComplete === null) return;
  const id = parentToComplete;
  closePendingModal();
  updateTodo(id, { done: true, forceComplete: true });
}

function showDueDateWarning(parentDueDate) {
  document.getElementById('due-date-message').textContent = `This subtask must be due on or before its parent task’s deadline of ${new Date(parentDueDate + 'T00:00:00').toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}.`;
  dueDateModal.hidden = false;
  document.getElementById('close-due-date-warning').focus();
}

function closeDueDateWarning() {
  dueDateModal.hidden = true;
  document.getElementById('subtask-due-date').focus();
}

async function addSubtask(event) {
  event.preventDefault();
  if (parentForSubtask === null) return;
  const dueDate = document.getElementById('subtask-due-date').value || null;
  const parent = todos.find(todo => Number(todo.id) === Number(parentForSubtask));
  if (parent && parent.dueDate && dueDate && dueDate > parent.dueDate) {
    showDueDateWarning(parent.dueDate);
    return;
  }
  try {
    const response = await fetch('/api/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: document.getElementById('subtask-text').value,
        priority: document.getElementById('subtask-priority').value,
        dueDate,
        parentId: parentForSubtask
      })
    });
    if (!response.ok) throw new Error();
    closeSubtaskModal();
    showError();
    await loadTodos();
  } catch {
    showError('Could not add the subtask.');
  }
}

document.getElementById('todo-form').addEventListener('submit', addTodo);
document.getElementById('search').addEventListener('input', renderTodos);
document.querySelectorAll('.filter').forEach(button => button.addEventListener('click', () => {
  filter = button.dataset.filter;
  document.querySelectorAll('.filter').forEach(item => item.classList.toggle('active', item === button));
  renderTodos();
}));
document.getElementById('confirm-delete').addEventListener('click', deleteTodo);
document.getElementById('cancel-delete').addEventListener('click', closeDeleteModal);
document.getElementById('subtask-form').addEventListener('submit', addSubtask);
document.getElementById('cancel-subtask').addEventListener('click', closeSubtaskModal);
document.getElementById('cancel-pending').addEventListener('click', closePendingModal);
document.getElementById('confirm-parent-complete').addEventListener('click', completeParentAnyway);
document.getElementById('close-due-date-warning').addEventListener('click', closeDueDateWarning);
deleteModal.addEventListener('click', event => { if (event.target === deleteModal) closeDeleteModal(); });
subtaskModal.addEventListener('click', event => { if (event.target === subtaskModal) closeSubtaskModal(); });
pendingModal.addEventListener('click', event => { if (event.target === pendingModal) closePendingModal(); });
dueDateModal.addEventListener('click', event => { if (event.target === dueDateModal) closeDueDateWarning(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (!deleteModal.hidden) closeDeleteModal();
    if (!subtaskModal.hidden) closeSubtaskModal();
    if (!pendingModal.hidden) closePendingModal();
    if (!dueDateModal.hidden) closeDueDateWarning();
  }
});

loadTodos();
