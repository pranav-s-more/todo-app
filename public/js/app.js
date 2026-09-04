/* Taskolab multi-user workspace client. Authentication and authorization are enforced by the API. */
const state = {
  token: localStorage.getItem('taskolab.authToken'),
  user: null,
  workspaces: [],
  currentWorkspace: null,
  members: [],
  todos: [],
  activity: [],
  filter: 'all',
  expandedGroups: new Set(),
  todoToDelete: null,
  parentForSubtask: null,
  parentToComplete: null,
  todoToEdit: null,
  memberToRemove: null,
  workspaceLoadVersion: 0
};

const byId = id => document.getElementById(id);
const authView = byId('auth-view');
const appView = byId('app-view');
const status = byId('status');
const authStatus = byId('auth-status');
const memberStatus = byId('member-status');
const deleteModal = byId('delete-modal');
const subtaskModal = byId('subtask-modal');
const editModal = byId('edit-modal');
const pendingModal = byId('pending-modal');
const dueDateModal = byId('due-date-modal');
const workspaceModal = byId('workspace-modal');
const membersModal = byId('members-modal');
const removeMemberModal = byId('remove-member-modal');
const assignmentPickerIds = ['task-assignment-picker', 'subtask-assignment-picker', 'edit-assignment-picker'];
const assignmentStatuses = [
  { value: 'not_started', label: 'Not started' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'completed', label: 'Completed' }
];

class ApiError extends Error {
  constructor(message, statusCode, payload) {
    super(message);
    this.statusCode = statusCode;
    this.payload = payload;
  }
}

function getCollection(payload, keys = []) {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function valueOrEmpty(value) {
  return value === null || value === undefined ? '' : String(value);
}

function sameId(left, right) {
  return String(left) === String(right);
}

function getUserId(member) {
  return member?.userId ?? member?.user_id ?? member?.user?.id ?? member?.id ?? null;
}

function getMemberName(member) {
  return member?.name || member?.displayName || member?.userName || member?.user?.name || member?.email || member?.user?.email || 'Workspace member';
}

function getMemberEmail(member) {
  return member?.email || member?.user?.email || '';
}

function getMemberRole(member) {
  return member?.role || member?.membershipRole || 'member';
}

function getAssigneeId(todo) {
  return todo?.assigneeId ?? todo?.assignee_id ?? todo?.assignee?.id ?? null;
}

function getAssigneeName(todo) {
  return todo?.assigneeName || todo?.assignee_name || todo?.assignee?.name || todo?.assignee?.email || '';
}

function getAssignmentUserId(assignment) {
  return assignment?.userId ?? assignment?.user_id ?? assignment?.user?.id ?? assignment?.id ?? null;
}

function getAssignmentName(assignment) {
  const userId = getAssignmentUserId(assignment);
  const member = state.members.find(item => sameId(getUserId(item), userId));
  return assignment?.name || assignment?.displayName || assignment?.userName || assignment?.user?.name || assignment?.email || assignment?.user?.email || (member ? getMemberName(member) : 'Workspace member');
}

function normalizeAssignmentStatus(value) {
  const normalized = String(value || '').toLowerCase().replace(/[\s-]+/g, '_');
  return assignmentStatuses.some(status => status.value === normalized) ? normalized : 'not_started';
}

function getAssignmentStatus(assignment) {
  return normalizeAssignmentStatus(assignment?.status ?? assignment?.assignmentStatus ?? assignment?.assignment_status);
}

function getTaskAssignments(todo) {
  if (Array.isArray(todo?.assignments) && (todo.assignments.length || !getAssigneeId(todo))) return todo.assignments;
  const legacyAssigneeId = getAssigneeId(todo);
  if (legacyAssigneeId === null || legacyAssigneeId === undefined || legacyAssigneeId === '') return [];
  return [{
    userId: legacyAssigneeId,
    name: getAssigneeName(todo),
    status: todo?.assignmentStatus || todo?.assignment_status || (todo?.done ? 'completed' : 'not_started')
  }];
}

function numericAssignmentCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function getAssignmentSummary(todo) {
  const assignments = getTaskAssignments(todo);
  const supplied = todo?.assignmentSummary || todo?.assignment_summary || {};
  const total = numericAssignmentCount(supplied.total) || assignments.length;
  const completed = numericAssignmentCount(supplied.completed) || assignments.filter(assignment => getAssignmentStatus(assignment) === 'completed').length;
  const inProgress = numericAssignmentCount(supplied.inProgress ?? supplied.in_progress) || assignments.filter(assignment => getAssignmentStatus(assignment) === 'in_progress').length;
  const notStarted = Math.max(0, total - completed - inProgress);
  let overallStatus = normalizeAssignmentStatus(supplied.overallStatus ?? supplied.overall_status);
  if (!total) overallStatus = 'unassigned';
  else if (completed === total) overallStatus = 'completed';
  else if (inProgress || (completed && notStarted)) overallStatus = 'in_progress';
  else overallStatus = 'not_started';
  return { total, completed, inProgress, notStarted, overallStatus };
}

function assignmentStatusLabel(status) {
  return assignmentStatuses.find(item => item.value === normalizeAssignmentStatus(status))?.label || 'Not started';
}

function currentUserAssignment(todo) {
  return getTaskAssignments(todo).find(assignment => sameId(getAssignmentUserId(assignment), state.user?.id)) || null;
}

function taskParentId(todo) {
  return todo?.parentId ?? todo?.parent_id ?? null;
}

function taskDueDate(todo) {
  return todo?.dueDate ?? todo?.due_date ?? null;
}

function currentRole() {
  return state.currentWorkspace?.role || state.currentWorkspace?.membershipRole || state.currentWorkspace?.memberRole || '';
}

function canEditWorkspace() {
  return !['viewer', 'read-only', 'readonly'].includes(String(currentRole()).toLowerCase());
}

function canManageMembers() {
  return ['owner', 'admin'].includes(String(currentRole()).toLowerCase());
}

function setMessage(element, message = '', type = 'error') {
  element.textContent = message;
  element.classList.toggle('success', type === 'success' && Boolean(message));
}

function showError(message = '') {
  setMessage(status, message);
}

function userFacingError(error, fallback) {
  if (error?.statusCode === 401) return 'Your session has expired. Please sign in again.';
  if (error?.statusCode === 403) return 'You do not have permission to perform that action in this workspace.';
  if (error?.statusCode === 409) return error.message || 'This action conflicts with the current workspace state. Refresh and try again.';
  return error?.message || fallback;
}

function firstLetter(value = '?') {
  return String(value).trim().charAt(0).toUpperCase() || '?';
}

function formatDate(dateValue) {
  if (!dateValue) return '';
  const parsed = new Date(`${String(dateValue).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return String(dateValue);
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatDateTime(dateValue) {
  if (!dateValue) return 'Recently';
  const parsed = new Date(dateValue);
  if (Number.isNaN(parsed.getTime())) return String(dateValue);
  const seconds = Math.floor((Date.now() - parsed.getTime()) / 1000);
  if (seconds >= 0 && seconds < 60) return 'Just now';
  if (seconds >= 60 && seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds >= 3600 && seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: parsed.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
}

function isChildOf(todo, parentId) {
  const childParentId = taskParentId(todo);
  return childParentId !== null && childParentId !== undefined && sameId(childParentId, parentId);
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.token) headers.set('Authorization', `Bearer ${state.token}`);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');

  let response;
  try {
    response = await fetch(path, { method: options.method || 'GET', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  } catch {
    throw new ApiError('Could not reach Taskolab. Check your connection and try again.', 0);
  }

  const contentType = response.headers.get('content-type') || '';
  let payload = null;
  try { payload = contentType.includes('application/json') ? await response.json() : await response.text(); }
  catch { payload = null; }

  if (!response.ok) {
    const message = typeof payload === 'object' && payload ? payload.message || payload.error || `Request failed (${response.status})` : `Request failed (${response.status})`;
    if (response.status === 401 && state.token && !options.keepSessionOnUnauthorized) {
      clearSession('Your session has expired. Please sign in again.');
    }
    throw new ApiError(message, response.status, payload);
  }
  return payload;
}

function setSession(payload) {
  const token = payload?.token || payload?.accessToken || payload?.access_token;
  const user = payload?.user || payload?.account || payload;
  if (!token || !user?.id) throw new Error('Taskolab did not return a valid sign-in session.');
  state.token = token;
  state.user = user;
  localStorage.setItem('taskolab.authToken', token);
}

function clearSession(message = '') {
  state.token = null;
  state.user = null;
  state.workspaces = [];
  state.currentWorkspace = null;
  state.members = [];
  state.todos = [];
  state.activity = [];
  localStorage.removeItem('taskolab.authToken');
  appView.hidden = true;
  authView.hidden = false;
  closeAllModals();
  setMessage(authStatus, message);
}

function updateUserHeader() {
  const name = state.user?.name || state.user?.displayName || state.user?.email || 'Your account';
  const email = state.user?.email || '';
  byId('user-name').textContent = name;
  byId('user-email').textContent = email;
  byId('user-avatar').textContent = firstLetter(name);
}

function showApplication() {
  authView.hidden = true;
  appView.hidden = false;
  updateUserHeader();
}

function toggleAuthenticationForm(showRegister) {
  byId('login-form').hidden = showRegister;
  byId('register-form').hidden = !showRegister;
  byId('auth-title').textContent = showRegister ? 'Create your Taskolab account' : 'Sign in to your workspace';
  byId('auth-description').textContent = showRegister ? 'Start with a private workspace, then add your team when you are ready.' : 'Use your account to continue where your team left off.';
  byId('auth-switch-copy').textContent = showRegister ? 'Already have an account?' : 'New to Taskolab?';
  byId('auth-switch').textContent = showRegister ? 'Sign in' : 'Create an account';
  setMessage(authStatus);
  (showRegister ? byId('register-name') : byId('login-email')).focus();
}

async function handleLogin(event) {
  event.preventDefault();
  setMessage(authStatus);
  const submit = event.submitter || event.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const payload = await request('/api/auth/login', { method: 'POST', keepSessionOnUnauthorized: true, body: { email: byId('login-email').value.trim(), password: byId('login-password').value } });
    setSession(payload);
    byId('login-form').reset();
    await startAuthenticatedExperience();
  } catch (error) {
    setMessage(authStatus, error.message || 'Could not sign in.');
  } finally { submit.disabled = false; }
}

async function handleRegister(event) {
  event.preventDefault();
  setMessage(authStatus);
  const submit = event.submitter || event.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const payload = await request('/api/auth/register', { method: 'POST', keepSessionOnUnauthorized: true, body: { name: byId('register-name').value.trim(), email: byId('register-email').value.trim(), password: byId('register-password').value } });
    setSession(payload);
    byId('register-form').reset();
    await startAuthenticatedExperience();
  } catch (error) {
    setMessage(authStatus, error.message || 'Could not create the account.');
  } finally { submit.disabled = false; }
}

async function handleLogout() {
  try { await request('/api/auth/logout', { method: 'POST', keepSessionOnUnauthorized: true }); }
  catch { /* The local session is still safely removed below. */ }
  clearSession('You have been signed out.');
}

function workspaceId(workspace) {
  return workspace?.id ?? workspace?.workspaceId ?? workspace?.workspace_id;
}

function workspaceName(workspace) {
  return workspace?.name || workspace?.title || 'Untitled workspace';
}

function workspaceDescription(workspace) {
  return workspace?.description || workspace?.summary || '';
}

function renderWorkspaceList() {
  const list = byId('workspace-list');
  list.innerHTML = '';
  const noWorkspaces = state.workspaces.length === 0;
  byId('open-workspace-modal-empty').hidden = !noWorkspaces;
  state.workspaces.forEach(workspace => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'workspace-button';
    button.classList.toggle('active', sameId(workspaceId(workspace), workspaceId(state.currentWorkspace)));
    const icon = document.createElement('span');
    icon.className = 'workspace-icon';
    icon.textContent = firstLetter(workspaceName(workspace));
    const copy = document.createElement('span');
    copy.className = 'workspace-button-copy';
    const name = document.createElement('strong');
    name.textContent = workspaceName(workspace);
    const role = document.createElement('small');
    role.textContent = workspace.role ? `${workspace.role} access` : 'Workspace';
    copy.append(name, role);
    button.append(icon, copy);
    button.addEventListener('click', () => selectWorkspace(workspaceId(workspace)));
    list.appendChild(button);
  });
}

function renderWorkspaceShell() {
  const hasWorkspace = Boolean(state.currentWorkspace);
  byId('workspace-empty').hidden = hasWorkspace;
  byId('workspace-content').hidden = !hasWorkspace;
  if (!hasWorkspace) return;
  const workspace = state.currentWorkspace;
  byId('workspace-title').textContent = workspaceName(workspace);
  byId('workspace-description').textContent = workspaceDescription(workspace);
  const role = currentRole();
  byId('workspace-role').textContent = role ? `${role} access` : 'Workspace';
  byId('member-count').textContent = valueOrEmpty((workspace.memberCount ?? workspace.member_count ?? state.members.length) || 1);
  const membersButton = byId('open-members-modal');
  membersButton.hidden = !canManageMembers();
  renderComposerPermission();
}

function renderComposerPermission() {
  const canEdit = canEditWorkspace();
  byId('todo-form').querySelectorAll('input, select, button').forEach(control => { control.disabled = !canEdit; });
  if (!canEditWorkspace()) showError('You have viewer access to this workspace. Ask an owner or admin if you need to make changes.');
  else if (status.textContent.startsWith('You have viewer')) showError();
}

async function loadWorkspaces(preferredWorkspaceId = null) {
  const payload = await request('/api/workspaces');
  state.workspaces = getCollection(payload, ['workspaces', 'items', 'data']);
  const storedId = localStorage.getItem('taskolab.lastWorkspaceId');
  const targetId = preferredWorkspaceId ?? workspaceId(state.currentWorkspace) ?? storedId;
  const selected = state.workspaces.find(workspace => sameId(workspaceId(workspace), targetId)) || state.workspaces[0] || null;
  state.currentWorkspace = selected;
  renderWorkspaceList();
  renderWorkspaceShell();
  if (selected) await loadWorkspaceDetails(workspaceId(selected));
  else {
    state.todos = [];
    state.members = [];
    state.activity = [];
    renderTodos();
    renderActivity();
  }
}

async function selectWorkspace(id) {
  const selected = state.workspaces.find(workspace => sameId(workspaceId(workspace), id));
  if (!selected || sameId(workspaceId(selected), workspaceId(state.currentWorkspace))) {
    byId('workspace-sidebar').classList.remove('is-open');
    byId('mobile-workspace-toggle').setAttribute('aria-expanded', 'false');
    return;
  }
  state.currentWorkspace = selected;
  state.todos = [];
  state.members = [];
  state.activity = [];
  localStorage.setItem('taskolab.lastWorkspaceId', workspaceId(selected));
  renderWorkspaceList();
  renderWorkspaceShell();
  renderTodos();
  renderActivity();
  byId('workspace-sidebar').classList.remove('is-open');
  byId('mobile-workspace-toggle').setAttribute('aria-expanded', 'false');
  await loadWorkspaceDetails(workspaceId(selected));
}

async function loadWorkspaceDetails(id) {
  const requestVersion = ++state.workspaceLoadVersion;
  showError();
  try {
    const [members, todos, activity] = await Promise.all([
      request(`/api/workspaces/${encodeURIComponent(id)}/members`),
      request(`/api/workspaces/${encodeURIComponent(id)}/tasks`),
      request(`/api/workspaces/${encodeURIComponent(id)}/activity`)
    ]);
    if (requestVersion !== state.workspaceLoadVersion || !sameId(id, workspaceId(state.currentWorkspace))) return;
    state.members = getCollection(members, ['members', 'items', 'data']);
    state.todos = getCollection(todos, ['tasks', 'todos', 'items', 'data']);
    state.activity = getCollection(activity, ['activity', 'events', 'items', 'data']);
    renderWorkspaceShell();
    populateAssigneeSelects();
    renderMembers();
    renderTodos();
    renderActivity();
  } catch (error) {
    if (requestVersion !== state.workspaceLoadVersion) return;
    showError(error.message || 'Could not load this workspace.');
  }
}

function selectedAssignmentIds(pickerId) {
  const picker = byId(pickerId);
  if (!picker) return [];
  return [...picker.querySelectorAll('input[type="checkbox"]:checked')]
    .map(input => Number(input.value))
    .filter(id => Number.isSafeInteger(id) && id > 0);
}

function renderAssignmentPicker(pickerId, selectedIds = []) {
  const picker = byId(pickerId);
  if (!picker) return;
  const options = picker.querySelector('.assignment-options');
  options.innerHTML = '';
  const selected = new Set(selectedIds.map(String));
  if (!state.members.length) {
    const empty = document.createElement('p');
    empty.className = 'assignment-empty';
    empty.textContent = 'Add workspace members before assigning work.';
    options.appendChild(empty);
    return;
  }
  state.members.forEach(member => {
    const memberId = getUserId(member);
    if (memberId === null || memberId === undefined) return;
    const label = document.createElement('label');
    label.className = 'assignment-option';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = String(memberId);
    input.checked = selected.has(String(memberId));
    input.disabled = !canEditWorkspace();
    input.setAttribute('aria-label', `Assign ${getMemberName(member)}`);
    label.append(input, document.createTextNode(getMemberName(member)));
    options.appendChild(label);
  });
}

function populateAssigneeSelects(selectedByPicker = {}) {
  assignmentPickerIds.forEach(pickerId => {
    const selected = Array.isArray(selectedByPicker[pickerId]) ? selectedByPicker[pickerId] : selectedAssignmentIds(pickerId);
    renderAssignmentPicker(pickerId, selected);
  });
}

function assignmentSummaryText(summary) {
  if (!summary.total) return '';
  if (summary.completed === summary.total) return `All ${summary.total} complete`;
  const parts = [];
  if (summary.completed) parts.push(`${summary.completed}/${summary.total} complete`);
  if (summary.inProgress) parts.push(`${summary.inProgress} in progress`);
  if (summary.notStarted && !summary.completed && !summary.inProgress) parts.push(`${summary.notStarted} not started`);
  if (summary.notStarted && (summary.completed || summary.inProgress)) parts.push(`${summary.notStarted} not started`);
  return parts.join(' · ');
}

function appendAssignmentMeta(meta, todo) {
  const assignments = getTaskAssignments(todo);
  if (!assignments.length) return;
  const assignees = document.createElement('span');
  assignees.className = 'assignees';
  assignees.title = assignments.map(assignment => `${getAssignmentName(assignment)}: ${assignmentStatusLabel(getAssignmentStatus(assignment))}`).join('\n');
  const avatars = document.createElement('span');
  avatars.className = 'assignee-avatars';
  assignments.slice(0, 3).forEach(assignment => {
    const avatar = document.createElement('span');
    avatar.className = 'mini-avatar';
    avatar.textContent = firstLetter(getAssignmentName(assignment));
    avatars.appendChild(avatar);
  });
  assignees.appendChild(avatars);
  if (assignments.length > 3) {
    const more = document.createElement('span');
    more.className = 'assignee-more';
    more.textContent = `+${assignments.length - 3}`;
    assignees.appendChild(more);
  }
  const summary = getAssignmentSummary(todo);
  const summaryElement = document.createElement('span');
  summaryElement.className = `assignment-summary ${summary.overallStatus === 'completed' ? 'is-complete' : summary.overallStatus === 'in_progress' ? 'is-in-progress' : ''}`;
  summaryElement.textContent = assignmentSummaryText(summary);
  assignees.appendChild(summaryElement);
  meta.appendChild(assignees);
}

function createOwnAssignmentProgressControl(todo) {
  const assignment = currentUserAssignment(todo);
  if (!assignment) return null;
  const control = document.createElement('div');
  control.className = 'assignment-progress';
  const label = document.createElement('span');
  label.className = 'assignment-progress-label';
  label.textContent = 'My work';
  const select = document.createElement('select');
  select.setAttribute('aria-label', `My work status for ${todo.text || 'task'}`);
  assignmentStatuses.forEach(optionValue => {
    const option = document.createElement('option');
    option.value = optionValue.value;
    option.textContent = optionValue.label;
    select.appendChild(option);
  });
  select.value = getAssignmentStatus(assignment);
  select.addEventListener('change', () => updateOwnAssignmentStatus(todo, select.value, select));
  control.append(label, select);
  return control;
}

function createTeamStatusDetails(todo) {
  const assignments = getTaskAssignments(todo);
  if (assignments.length < 2) return null;
  const summary = getAssignmentSummary(todo);
  const details = document.createElement('details');
  details.className = 'assignment-status-details';
  // Two or three people is the common case and is useful to see immediately.
  // Larger teams remain compact until the manager expands their status list.
  details.open = assignments.length <= 3;
  const heading = document.createElement('summary');
  heading.textContent = `Team status · ${assignmentSummaryText(summary)}`;
  const list = document.createElement('div');
  list.className = 'assignment-status-list';
  assignments.forEach(assignment => {
    const status = getAssignmentStatus(assignment);
    const chip = document.createElement('span');
    chip.className = `assignment-status-chip ${status}`;
    chip.textContent = `${getAssignmentName(assignment)}: ${assignmentStatusLabel(status)}`;
    list.appendChild(chip);
  });
  details.append(heading, list);
  return details;
}

function renderTodos() {
  const list = byId('list');
  list.innerHTML = '';
  if (!state.currentWorkspace) return;
  const search = byId('search').value.trim().toLowerCase();
  const roots = state.todos.filter(todo => !taskParentId(todo));
  const isFamilyComplete = todo => Boolean(todo.done) && state.todos.filter(child => isChildOf(child, todo.id)).every(child => Boolean(child.done));
  const matchesSearch = todo => String(todo.text || '').toLowerCase().includes(search) || state.todos.some(child => isChildOf(child, todo.id) && String(child.text || '').toLowerCase().includes(search));
  const visibleTodos = roots.filter(todo => matchesSearch(todo) && (state.filter === 'all' || (state.filter === 'done' ? isFamilyComplete(todo) : !isFamilyComplete(todo))));

  if (!visibleTodos.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = search ? 'No tasks match your search.' : state.filter === 'done' ? 'No completed task groups yet.' : 'No tasks here yet. Add the first one above.';
    list.appendChild(empty);
    return;
  }
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
  if (state.filter === 'all') {
    appendSection('To do', activeTodos);
    appendSection('Completed', completedTodos);
  } else {
    appendSection(state.filter === 'active' ? 'To do' : 'Completed', visibleTodos);
  }
}

function renderTodo(todo) {
  const item = createTaskItem(todo, false);
  const subtasks = state.todos.filter(child => isChildOf(child, todo.id));
  if (subtasks.length) {
    item.classList.add('group');
    const parentRow = document.createElement('div');
    parentRow.className = 'group-parent';
    while (item.firstChild) parentRow.appendChild(item.firstChild);
    const details = document.createElement('details');
    details.className = 'group-children';
    details.open = state.expandedGroups.has(String(todo.id));
    const summary = document.createElement('summary');
    summary.className = 'subtask-heading';
    summary.textContent = `${subtasks.length} subtask${subtasks.length === 1 ? '' : 's'}`;
    const childList = document.createElement('ul');
    childList.className = 'subtask-list';
    subtasks.forEach(child => childList.appendChild(createTaskItem(child, true)));
    details.addEventListener('toggle', () => {
      if (details.open) state.expandedGroups.add(String(todo.id));
      else state.expandedGroups.delete(String(todo.id));
    });
    details.append(summary, childList);
    item.append(parentRow, details);
  }
  byId('list').appendChild(item);
}

function createTaskItem(todo, isSubtask) {
  const item = document.createElement('li');
  item.className = todo.done ? 'done' : '';
  const check = document.createElement('input');
  check.className = 'check';
  check.type = 'checkbox';
  check.checked = Boolean(todo.done);
  check.setAttribute('aria-label', 'Mark task complete');
  check.disabled = !canEditWorkspace();
  check.addEventListener('click', event => toggleTask(todo, event));

  const task = document.createElement('div');
  task.className = 'task';
  const text = document.createElement('span');
  text.className = 'task-text';
  text.textContent = todo.text || 'Untitled task';
  const meta = document.createElement('div');
  meta.className = 'meta';
  const kind = document.createElement('span');
  kind.className = 'subtask-kind';
  kind.textContent = isSubtask ? 'Subtask' : 'Task';
  const priority = document.createElement('span');
  priority.className = `badge ${todo.priority || 'medium'}`;
  priority.textContent = todo.priority || 'medium';
  meta.append(kind, priority);
  const dueDate = taskDueDate(todo);
  if (dueDate) {
    const due = document.createElement('span');
    due.textContent = `Due ${formatDate(dueDate)}`;
    meta.appendChild(due);
  }
  appendAssignmentMeta(meta, todo);
  task.append(text, meta);
  const personalProgress = createOwnAssignmentProgressControl(todo);
  if (personalProgress) task.appendChild(personalProgress);
  const teamProgress = createTeamStatusDetails(todo);
  if (teamProgress) task.appendChild(teamProgress);

  const actions = document.createElement('div');
  actions.className = 'actions';
  if (canEditWorkspace()) {
    const prioritySelect = document.createElement('select');
    prioritySelect.className = 'priority-select';
    prioritySelect.setAttribute('aria-label', 'Change priority');
    ['high', 'medium', 'low'].forEach(value => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value.charAt(0).toUpperCase() + value.slice(1);
      prioritySelect.appendChild(option);
    });
    prioritySelect.value = todo.priority || 'medium';
    prioritySelect.addEventListener('change', event => updateTask(todo.id, { priority: event.target.value }));
    actions.appendChild(prioritySelect);
    if (!isSubtask) actions.appendChild(actionButton('Subtask', 'Add subtask', () => openSubtaskModal(todo)));
    actions.appendChild(actionButton('Edit', 'Edit task', () => openEditModal(todo)));
    actions.appendChild(actionButton('Delete', 'Delete task', () => openDeleteModal(todo.id)));
  }
  item.append(check, task, actions);
  return item;
}

function actionButton(label, ariaLabel, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon';
  button.textContent = label;
  button.setAttribute('aria-label', ariaLabel);
  button.addEventListener('click', handler);
  return button;
}

function currentWorkspacePath() {
  const id = workspaceId(state.currentWorkspace);
  if (id === null || id === undefined) throw new Error('Choose a workspace first.');
  return `/api/workspaces/${encodeURIComponent(id)}`;
}

async function loadTasksAndActivity() {
  if (!state.currentWorkspace) return;
  const id = workspaceId(state.currentWorkspace);
  const [todos, activity] = await Promise.all([
    request(`${currentWorkspacePath()}/tasks`),
    request(`${currentWorkspacePath()}/activity`)
  ]);
  if (!sameId(id, workspaceId(state.currentWorkspace))) return;
  state.todos = getCollection(todos, ['tasks', 'todos', 'items', 'data']);
  state.activity = getCollection(activity, ['activity', 'events', 'items', 'data']);
  renderTodos();
  renderActivity();
}

async function addTodo(event) {
  event.preventDefault();
  if (!canEditWorkspace()) return;
  const input = byId('new-task');
  const submit = event.submitter || event.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const assigneeIds = selectedAssignmentIds('task-assignment-picker');
    await request(`${currentWorkspacePath()}/tasks`, { method: 'POST', body: { text: input.value, priority: byId('priority').value, dueDate: byId('due-date').value || null, assigneeIds } });
    byId('todo-form').reset();
    populateAssigneeSelects();
    showError();
    await loadTasksAndActivity();
  } catch (error) { showError(userFacingError(error, 'Could not add the task.')); }
  finally { submit.disabled = false; }
}

async function updateTask(id, changes) {
  try {
    await request(`${currentWorkspacePath()}/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: changes });
    showError();
    await loadTasksAndActivity();
  } catch (error) {
    if (error.statusCode === 409 && error.payload?.pendingSubtasks) {
      state.parentToComplete = id;
      byId('pending-message').textContent = `${error.payload.pendingSubtasks} subtask${error.payload.pendingSubtasks === 1 ? ' is' : 's are'} still pending. You can complete the parent anyway or keep working on them first.`;
      openModal(pendingModal, byId('cancel-pending'));
      return;
    }
    showError(userFacingError(error, 'Could not save that change.'));
  }
}

async function updateOwnAssignmentStatus(todo, status, control) {
  const assignment = currentUserAssignment(todo);
  const userId = getAssignmentUserId(assignment);
  if (userId === null || userId === undefined) return;
  const previousStatus = getAssignmentStatus(assignment);
  control.disabled = true;
  try {
    await request(`${currentWorkspacePath()}/tasks/${encodeURIComponent(todo.id)}/assignments/${encodeURIComponent(userId)}`, { method: 'PATCH', body: { status } });
    showError();
    await loadTasksAndActivity();
  } catch (error) {
    if (control.isConnected) control.value = previousStatus;
    showError(userFacingError(error, 'Could not update your work status.'));
  } finally {
    if (control.isConnected) control.disabled = false;
  }
}

function toggleTask(todo, event) {
  const pendingSubtasks = state.todos.filter(child => isChildOf(child, todo.id) && !child.done);
  if (!todo.done && pendingSubtasks.length) {
    event.preventDefault();
    event.target.checked = false;
    state.parentToComplete = todo.id;
    byId('pending-message').textContent = `${pendingSubtasks.length} subtask${pendingSubtasks.length === 1 ? ' is' : 's are'} still pending. You can finish the group anyway or keep working on them first.`;
    openModal(pendingModal, byId('cancel-pending'));
    return;
  }
  updateTask(todo.id, { done: !todo.done });
}

function openDeleteModal(id) {
  state.todoToDelete = id;
  const pendingSubtasks = state.todos.filter(todo => isChildOf(todo, id) && !todo.done);
  if (pendingSubtasks.length) {
    byId('delete-title').textContent = 'Delete group with pending subtasks?';
    byId('delete-message').textContent = `${pendingSubtasks.length} subtask${pendingSubtasks.length === 1 ? ' is' : 's are'} still unfinished. Deleting this group permanently removes the parent task and every subtask.`;
    byId('confirm-delete').textContent = 'Delete group';
  } else {
    byId('delete-title').textContent = 'Delete task?';
    byId('delete-message').textContent = 'This task will be permanently removed from this workspace.';
    byId('confirm-delete').textContent = 'Delete task';
  }
  openModal(deleteModal, byId('cancel-delete'));
}

function closeDeleteModal() {
  state.todoToDelete = null;
  closeModal(deleteModal);
}

async function deleteTodo() {
  if (state.todoToDelete === null) return;
  const id = state.todoToDelete;
  closeDeleteModal();
  try {
    await request(`${currentWorkspacePath()}/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
    showError();
    await loadTasksAndActivity();
  } catch (error) { showError(userFacingError(error, 'Could not delete the task.')); }
}

function openEditModal(todo) {
  state.todoToEdit = todo;
  byId('edit-text').value = todo.text || '';
  byId('edit-priority').value = todo.priority || 'medium';
  byId('edit-due-date').value = taskDueDate(todo) || '';
  populateAssigneeSelects({ 'edit-assignment-picker': getTaskAssignments(todo).map(getAssignmentUserId) });
  openModal(editModal, byId('edit-text'));
}

function closeEditModal() {
  state.todoToEdit = null;
  closeModal(editModal);
}

async function saveEdit(event) {
  event.preventDefault();
  if (!state.todoToEdit) return;
  const todo = state.todoToEdit;
  const dueDate = byId('edit-due-date').value || null;
  const parentId = taskParentId(todo);
  if (parentId && dueDate) {
    const parent = state.todos.find(item => sameId(item.id, parentId));
    if (parent && taskDueDate(parent) && dueDate > taskDueDate(parent)) {
      showDueDateWarning(taskDueDate(parent));
      return;
    }
  }
  const submit = event.submitter || event.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    await request(`${currentWorkspacePath()}/tasks/${encodeURIComponent(todo.id)}`, { method: 'PATCH', body: { text: byId('edit-text').value.trim(), priority: byId('edit-priority').value, dueDate, assigneeIds: selectedAssignmentIds('edit-assignment-picker') } });
    closeEditModal();
    showError();
    await loadTasksAndActivity();
  } catch (error) { showError(userFacingError(error, 'Could not save task changes.')); }
  finally { submit.disabled = false; }
}

function openSubtaskModal(parent) {
  state.parentForSubtask = parent.id;
  byId('subtask-parent').textContent = `Add a step under "${parent.text}".`;
  byId('subtask-form').reset();
  populateAssigneeSelects({ 'subtask-assignment-picker': [] });
  openModal(subtaskModal, byId('subtask-text'));
}

function closeSubtaskModal() {
  state.parentForSubtask = null;
  byId('subtask-form').reset();
  populateAssigneeSelects();
  closeModal(subtaskModal);
}

async function addSubtask(event) {
  event.preventDefault();
  if (state.parentForSubtask === null) return;
  const dueDate = byId('subtask-due-date').value || null;
  const parent = state.todos.find(todo => sameId(todo.id, state.parentForSubtask));
  if (parent && taskDueDate(parent) && dueDate && dueDate > taskDueDate(parent)) {
    showDueDateWarning(taskDueDate(parent));
    return;
  }
  const submit = event.submitter || event.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const assigneeIds = selectedAssignmentIds('subtask-assignment-picker');
    await request(`${currentWorkspacePath()}/tasks`, { method: 'POST', body: { text: byId('subtask-text').value, priority: byId('subtask-priority').value, dueDate, parentId: state.parentForSubtask, assigneeIds } });
    state.expandedGroups.add(String(state.parentForSubtask));
    closeSubtaskModal();
    showError();
    await loadTasksAndActivity();
  } catch (error) { showError(userFacingError(error, 'Could not add the subtask.')); }
  finally { submit.disabled = false; }
}

function closePendingModal() {
  state.parentToComplete = null;
  closeModal(pendingModal);
}

function completeParentAnyway() {
  if (state.parentToComplete === null) return;
  const id = state.parentToComplete;
  closePendingModal();
  updateTask(id, { done: true, forceComplete: true });
}

function showDueDateWarning(parentDueDate) {
  byId('due-date-message').textContent = `This subtask must be due on or before its parent task's deadline of ${new Date(`${parentDueDate}T00:00:00`).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}.`;
  openModal(dueDateModal, byId('close-due-date-warning'));
}

function closeDueDateWarning() {
  closeModal(dueDateModal);
  const target = !editModal.hidden ? byId('edit-due-date') : byId('subtask-due-date');
  target.focus();
}

function openWorkspaceModal() {
  byId('workspace-form').reset();
  openModal(workspaceModal, byId('workspace-name-input'));
}

async function createWorkspace(event) {
  event.preventDefault();
  const submit = event.submitter || event.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const workspace = await request('/api/workspaces', { method: 'POST', body: { name: byId('workspace-name-input').value.trim(), description: byId('workspace-description-input').value.trim() || null } });
    closeModal(workspaceModal);
    const created = workspace?.workspace || workspace;
    await loadWorkspaces(workspaceId(created));
  } catch (error) { showError(error.message || 'Could not create the workspace.'); }
  finally { submit.disabled = false; }
}

function renderMembers() {
  const list = byId('member-list');
  list.innerHTML = '';
  if (!state.members.length) {
    const empty = document.createElement('p');
    empty.className = 'activity-empty';
    empty.textContent = 'No members are available yet.';
    list.appendChild(empty);
    return;
  }
  state.members.forEach(member => {
    const row = document.createElement('div');
    row.className = 'member-row';
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.textContent = firstLetter(getMemberName(member));
    const copy = document.createElement('span');
    copy.className = 'member-copy';
    const name = document.createElement('strong');
    name.textContent = getMemberName(member);
    const emailAndRole = document.createElement('small');
    emailAndRole.textContent = `${getMemberEmail(member) || 'No email'} - ${getMemberRole(member)}`;
    copy.append(name, emailAndRole);
    row.append(avatar, copy);
    if (canManageMembers() && getMemberRole(member) !== 'owner') {
      const roleSelect = document.createElement('select');
      ['admin', 'editor', 'viewer'].forEach(role => {
        const option = document.createElement('option');
        option.value = role;
        option.textContent = role.charAt(0).toUpperCase() + role.slice(1);
        roleSelect.appendChild(option);
      });
      roleSelect.value = getMemberRole(member);
      roleSelect.addEventListener('change', () => updateMemberRole(member, roleSelect.value));
      row.appendChild(roleSelect);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove-member';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => openRemoveMemberModal(member));
      row.appendChild(remove);
    }
    list.appendChild(row);
  });
  byId('member-count').textContent = state.members.length || 1;
}

async function openMembersModal() {
  if (!canManageMembers()) return;
  setMessage(memberStatus);
  renderMembers();
  openModal(membersModal, byId('invite-email'));
}

async function inviteMember(event) {
  event.preventDefault();
  const submit = event.submitter || event.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true;
  setMessage(memberStatus);
  try {
    await request(`${currentWorkspacePath()}/members`, { method: 'POST', body: { email: byId('invite-email').value.trim(), role: byId('invite-role').value } });
    byId('invite-member-form').reset();
    setMessage(memberStatus, 'Member added to this workspace.', 'success');
    await refreshMembersAndActivity();
  } catch (error) { setMessage(memberStatus, error.message || 'Could not add that member.'); }
  finally { submit.disabled = false; }
}

async function updateMemberRole(member, role) {
  setMessage(memberStatus);
  try {
    await request(`${currentWorkspacePath()}/members/${encodeURIComponent(getUserId(member))}`, { method: 'PATCH', body: { role } });
    setMessage(memberStatus, 'Member role updated.', 'success');
    await refreshMembersAndActivity();
  } catch (error) { setMessage(memberStatus, error.message || 'Could not update the member role.'); }
}

function openRemoveMemberModal(member) {
  state.memberToRemove = member;
  byId('remove-member-message').textContent = `Remove ${getMemberName(member)} from this workspace? They will no longer be able to view or update its tasks.`;
  openModal(removeMemberModal, byId('cancel-remove-member'));
}

function closeRemoveMemberModal() {
  state.memberToRemove = null;
  closeModal(removeMemberModal);
}

async function removeMember() {
  const member = state.memberToRemove;
  if (!member) return;
  const memberName = getMemberName(member);
  closeRemoveMemberModal();
  setMessage(memberStatus);
  try {
    await request(`${currentWorkspacePath()}/members/${encodeURIComponent(getUserId(member))}`, { method: 'DELETE' });
    setMessage(memberStatus, 'Member removed.', 'success');
    await refreshMembersAndActivity();
  } catch (error) { setMessage(memberStatus, userFacingError(error, `Could not remove ${memberName}.`)); }
}

async function refreshMembersAndActivity() {
  const [members, todos, activity] = await Promise.all([
    request(`${currentWorkspacePath()}/members`),
    request(`${currentWorkspacePath()}/tasks`),
    request(`${currentWorkspacePath()}/activity`)
  ]);
  state.members = getCollection(members, ['members', 'items', 'data']);
  state.todos = getCollection(todos, ['tasks', 'todos', 'items', 'data']);
  state.activity = getCollection(activity, ['activity', 'events', 'items', 'data']);
  populateAssigneeSelects();
  renderMembers();
  renderWorkspaceShell();
  renderTodos();
  renderActivity();
}

function renderActivity() {
  const list = byId('activity-list');
  list.innerHTML = '';
  if (!state.currentWorkspace) return;
  if (!state.activity.length) {
    const empty = document.createElement('p');
    empty.className = 'activity-empty';
    empty.textContent = 'Activity will appear here as your team works.';
    list.appendChild(empty);
    return;
  }
  state.activity.forEach(activity => {
    const item = document.createElement('article');
    item.className = 'activity-item';
    const icon = document.createElement('span');
    icon.className = 'activity-icon';
    icon.textContent = activity.icon || (activity.type === 'task_completed' ? '✓' : '◷');
    const copy = document.createElement('div');
    copy.className = 'activity-copy';
    const description = document.createElement('p');
    const actor = activity.actorName || activity.actor?.name || activity.userName || activity.user?.name || '';
    const message = activity.message || activity.description || activity.summary || activity.action || 'updated the workspace';
    if (actor) {
      const actorStrong = document.createElement('strong');
      actorStrong.textContent = actor;
      description.append(actorStrong, document.createTextNode(` ${message}`));
    } else description.textContent = message;
    const time = document.createElement('time');
    const rawTime = activity.createdAt || activity.created_at || activity.timestamp;
    time.dateTime = rawTime || '';
    time.textContent = formatDateTime(rawTime);
    copy.append(description, time);
    item.append(icon, copy);
    list.appendChild(item);
  });
}

function openActivityPanel() {
  byId('activity-panel').classList.remove('is-collapsed');
  byId('open-activity-panel').setAttribute('aria-expanded', 'true');
}

function closeActivityPanel() {
  byId('activity-panel').classList.add('is-collapsed');
  byId('open-activity-panel').setAttribute('aria-expanded', 'false');
}

function openModal(modal, focusTarget) {
  modal.hidden = false;
  window.setTimeout(() => focusTarget?.focus(), 0);
}

function closeModal(modal) {
  modal.hidden = true;
}

function closeAllModals() {
  [deleteModal, subtaskModal, editModal, pendingModal, dueDateModal, workspaceModal, membersModal, removeMemberModal].forEach(closeModal);
}

function closeModalOnBackdrop(event, modal, close) {
  if (event.target === modal) close();
}

async function startAuthenticatedExperience() {
  showApplication();
  try {
    await loadWorkspaces();
  } catch (error) {
    showError(error.message || 'Could not load your workspaces.');
  }
}

function registerEventListeners() {
  byId('auth-switch').addEventListener('click', () => toggleAuthenticationForm(byId('register-form').hidden));
  byId('login-form').addEventListener('submit', handleLogin);
  byId('register-form').addEventListener('submit', handleRegister);
  byId('logout-button').addEventListener('click', handleLogout);
  byId('user-menu').addEventListener('click', () => {
    const popover = byId('user-menu-popover');
    popover.hidden = !popover.hidden;
    byId('user-menu').setAttribute('aria-expanded', String(!popover.hidden));
  });
  document.addEventListener('click', event => {
    const menu = byId('user-menu');
    const popover = byId('user-menu-popover');
    if (!menu.contains(event.target) && !popover.contains(event.target)) {
      popover.hidden = true;
      menu.setAttribute('aria-expanded', 'false');
    }
  });
  byId('mobile-workspace-toggle').addEventListener('click', () => {
    const sidebar = byId('workspace-sidebar');
    sidebar.classList.toggle('is-open');
    byId('mobile-workspace-toggle').setAttribute('aria-expanded', String(sidebar.classList.contains('is-open')));
  });
  byId('open-workspace-modal').addEventListener('click', openWorkspaceModal);
  byId('open-workspace-modal-empty').addEventListener('click', openWorkspaceModal);
  byId('create-first-workspace').addEventListener('click', openWorkspaceModal);
  byId('workspace-form').addEventListener('submit', createWorkspace);
  byId('cancel-workspace').addEventListener('click', () => closeModal(workspaceModal));
  byId('todo-form').addEventListener('submit', addTodo);
  byId('search').addEventListener('input', renderTodos);
  document.querySelectorAll('.filter').forEach(button => button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    document.querySelectorAll('.filter').forEach(item => item.classList.toggle('active', item === button));
    renderTodos();
  }));
  byId('confirm-delete').addEventListener('click', deleteTodo);
  byId('cancel-delete').addEventListener('click', closeDeleteModal);
  byId('subtask-form').addEventListener('submit', addSubtask);
  byId('cancel-subtask').addEventListener('click', closeSubtaskModal);
  byId('edit-form').addEventListener('submit', saveEdit);
  byId('cancel-edit').addEventListener('click', closeEditModal);
  byId('cancel-pending').addEventListener('click', closePendingModal);
  byId('confirm-parent-complete').addEventListener('click', completeParentAnyway);
  byId('close-due-date-warning').addEventListener('click', closeDueDateWarning);
  byId('open-members-modal').addEventListener('click', openMembersModal);
  byId('close-members-modal').addEventListener('click', () => closeModal(membersModal));
  byId('confirm-remove-member').addEventListener('click', removeMember);
  byId('cancel-remove-member').addEventListener('click', closeRemoveMemberModal);
  byId('invite-member-form').addEventListener('submit', inviteMember);
  byId('open-activity-panel').addEventListener('click', openActivityPanel);
  byId('close-activity-panel').addEventListener('click', closeActivityPanel);
  deleteModal.addEventListener('click', event => closeModalOnBackdrop(event, deleteModal, closeDeleteModal));
  subtaskModal.addEventListener('click', event => closeModalOnBackdrop(event, subtaskModal, closeSubtaskModal));
  editModal.addEventListener('click', event => closeModalOnBackdrop(event, editModal, closeEditModal));
  pendingModal.addEventListener('click', event => closeModalOnBackdrop(event, pendingModal, closePendingModal));
  dueDateModal.addEventListener('click', event => closeModalOnBackdrop(event, dueDateModal, closeDueDateWarning));
  workspaceModal.addEventListener('click', event => closeModalOnBackdrop(event, workspaceModal, () => closeModal(workspaceModal)));
  membersModal.addEventListener('click', event => closeModalOnBackdrop(event, membersModal, () => closeModal(membersModal)));
  removeMemberModal.addEventListener('click', event => closeModalOnBackdrop(event, removeMemberModal, closeRemoveMemberModal));
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (!removeMemberModal.hidden) closeRemoveMemberModal();
    else if (!dueDateModal.hidden) closeDueDateWarning();
    else if (!deleteModal.hidden) closeDeleteModal();
    else if (!subtaskModal.hidden) closeSubtaskModal();
    else if (!editModal.hidden) closeEditModal();
    else if (!pendingModal.hidden) closePendingModal();
    else if (!workspaceModal.hidden) closeModal(workspaceModal);
    else if (!membersModal.hidden) closeModal(membersModal);
    else if (!byId('user-menu-popover').hidden) byId('user-menu-popover').hidden = true;
  });
}

async function bootstrap() {
  registerEventListeners();
  if (!state.token) {
    authView.hidden = false;
    return;
  }
  try {
    const payload = await request('/api/auth/me', { keepSessionOnUnauthorized: true });
    state.user = payload?.user || payload?.account || payload;
    if (!state.user?.id) throw new Error('Your session is not valid.');
    await startAuthenticatedExperience();
  } catch {
    clearSession('Your session has expired. Please sign in again.');
  }
}

bootstrap();
