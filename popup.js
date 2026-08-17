// ════════════════════════════════════════════════════════════════
//  Skoolyst FB Groups Poster — popup.js  v6.0
//  Features: Group Lists, Daily Rotation, Schedule, History
// ════════════════════════════════════════════════════════════════

const SK = {
  LISTS:    'sk_lists',
  SCHEDULE: 'sk_schedule',
  SESSION:  'sk_session',
  HISTORY:  'sk_history',
  POST:     'sk_post',
};

const MAX_GROUPS_PER_LIST = 20;

let lists    = [];   // Array of { id, name, groups: [{ name, url, groupId, status }] }
let schedule = {};   // { enabled, hour, minute, nextRunAt, currentListIndex, lastRunAt, lastListName }
let session  = null;
let history  = [];
let postData = { message: '', imageUrl: '', imageBase64: '', delay: 10, posts: [] };
let isRunning = false;
let editingPostId = null;

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadAll();
  setupTabs();
  setupPostTab();
  setupListsTab();
  setupScheduleTab();
  setupStatusTab();
  setupHistoryTab();
  checkResumeSession();
  renderAll();
  listenToBackground();
  syncRunningState();
});

// ── Background messages ──────────────────────────────────────
function listenToBackground() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'sessionUpdate') {
      session = message.session;
      renderStatus();
    }
    if (message.action === 'sessionComplete') {
      session    = message.session;
      isRunning  = false;
      setRunningUI(false);
      document.getElementById('currentGroupText').textContent =
        `✅ Complete! ${message.done} done, ${message.failed} failed.`;
      renderStatus();
      loadHistory().then(renderHistory);
      refreshListsFromStorage().then(() => { renderLists(); renderPostTab(); renderScheduleTab(); });
      const listLabel = session.listName ? `\nList: "${session.listName}"` : '';
      alert(`✅ Posting Complete!${listLabel}\n\nSuccessful: ${message.done}\nFailed: ${message.failed}\n\nHistory tab mein full record dekho.`);
    }
    if (message.action === 'queuedRunStarted') {
      isRunning = true;
      setRunningUI(true);
      document.getElementById('currentGroupText').textContent =
        `🔁 Starting queued post #${message.postIndex + 1} for "${message.listName}"...`;
      switchTab('status');
      loadPostData().then(renderPostQueue);
    }
    if (message.action === 'scheduledRunStarted') {
      document.getElementById('scheduledAlert').style.display = 'block';
      document.getElementById('scheduledAlertText').textContent =
        `"${message.listName}" (List ${message.listIndex + 1}) post ho rahi hai...`;
      setRunningUI(true);
      switchTab('status');
    }
  });
}

async function syncRunningState() {
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'getStatus' });
    if (resp && resp.isRunning) {
      isRunning = true;
      setRunningUI(true);
      document.getElementById('currentGroupText').textContent = '⚡ Session running in background...';
    }
  } catch {}
}

// ── Storage ──────────────────────────────────────────────────
async function loadAll() {
  const data = await chrome.storage.local.get([
    SK.LISTS, SK.SCHEDULE, SK.SESSION, SK.HISTORY, SK.POST
  ]);
  lists    = data[SK.LISTS]    || [];
  schedule = data[SK.SCHEDULE] || { enabled: false, hour: 8, minute: 0, currentListIndex: 0 };
  session  = data[SK.SESSION]  || null;
  history  = data[SK.HISTORY]  || [];
  postData = normalizePostData(data[SK.POST]);

  document.getElementById('postMessage').value      = postData.message  || '';
  document.getElementById('imageUrl').value         = postData.imageUrl || '';
  document.getElementById('delaySlider').value      = postData.delay    || 10;
  document.getElementById('delayValue').textContent = (postData.delay || 10) + 's';
  if (postData.imageBase64) {
    document.getElementById('imagePreview').src           = postData.imageBase64;
    document.getElementById('imagePreview').style.display = 'block';
  }
  updateCharCount();
  renderPostQueue();
}

async function loadHistory() {
  const data = await chrome.storage.local.get(SK.HISTORY);
  history = data[SK.HISTORY] || [];
}

async function loadPostData() {
  const data = await chrome.storage.local.get(SK.POST);
  postData = normalizePostData(data[SK.POST]);
}

async function saveLists()   { await chrome.storage.local.set({ [SK.LISTS]:    lists });    }
async function savePost()    { await chrome.storage.local.set({ [SK.POST]:     postData }); }
async function saveSchedule(){ await chrome.storage.local.set({ [SK.SCHEDULE]: schedule }); }

// ── Tabs ─────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  const btn = document.querySelector(`[data-tab="${tabName}"]`);
  const panel = document.getElementById('tab-' + tabName);
  if (btn) btn.classList.add('active');
  if (panel) panel.classList.add('active');

  if (tabName === 'status')   renderStatus();
  if (tabName === 'history')  renderHistory();
  if (tabName === 'schedule') renderScheduleTab();
  if (tabName === 'lists')    renderLists();
  if (tabName === 'post')     renderPostTab();
}

// ════════════════════════════════════════════════════════════════
//  POST TAB
// ════════════════════════════════════════════════════════════════
function setupPostTab() {
  document.getElementById('postMessage').addEventListener('input', () => {
    postData.message = document.getElementById('postMessage').value;
    updateCharCount(); savePost();
  });
  document.getElementById('imageUrl').addEventListener('input', (e) => {
    postData.imageUrl = e.target.value; postData.imageBase64 = '';
    document.getElementById('imagePreview').style.display = 'none';
    savePost();
  });
  document.getElementById('imageFile').addEventListener('change', (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      postData.imageBase64 = ev.target.result; postData.imageUrl = '';
      document.getElementById('imageUrl').value            = '';
      document.getElementById('imagePreview').src          = ev.target.result;
      document.getElementById('imagePreview').style.display = 'block';
      savePost();
    };
    reader.readAsDataURL(file);
  });
  document.getElementById('delaySlider').addEventListener('input', (e) => {
    postData.delay = parseInt(e.target.value);
    document.getElementById('delayValue').textContent = e.target.value + 's';
    savePost();
  });
  document.getElementById('selectListForPost').addEventListener('change', updateSelectedListInfo);
  document.getElementById('btnStart').addEventListener('click', startPosting);
  document.getElementById('btnStop').addEventListener('click', stopPosting);
  document.getElementById('btnResume')?.addEventListener('click', resumePosting);
  document.getElementById('btnFresh')?.addEventListener('click', startFresh);
  document.getElementById('btnRunNext').addEventListener('click', runNextListNow);
  document.getElementById('btnAddPostToQueue').addEventListener('click', savePostQueueDraft);
  document.getElementById('btnClearPostImage').addEventListener('click', clearPostImageDraft);
  document.getElementById('btnCancelPostEdit').addEventListener('click', cancelPostEdit);
  document.getElementById('btnResetPostQueue').addEventListener('click', resetPostQueue);
  document.getElementById('postQueueList').addEventListener('click', handlePostQueueClick);
}

function renderPostTab() {
  // Populate list selector
  const sel = document.getElementById('selectListForPost');
  const prev = sel.value;
  sel.innerHTML = '<option value="">-- List select karo --</option>';
  lists.forEach((l, i) => {
    const isCurrent = i === (schedule.currentListIndex || 0) % (lists.length || 1);
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `${l.name} (${getPendingGroups(l).length} pending / ${l.groups.length} total)${isCurrent ? ' ← Next' : ''}`;
    sel.appendChild(opt);
  });
  if (prev !== '') sel.value = prev;
  updateSelectedListInfo();
  updateNextListPreview();
  renderPostQueue();
}

function updateSelectedListInfo() {
  const sel = document.getElementById('selectListForPost');
  const info = document.getElementById('selectedListInfo');
  const idx = parseInt(sel.value);
  if (isNaN(idx) || !lists[idx]) {
    info.textContent = 'No list selected'; return;
  }
  const l = lists[idx];
  info.textContent = `"${l.name}" — ${getPendingGroups(l).length} pending groups will be posted (${l.groups.length} total)`;
}

function updateNextListPreview() {
  const el = document.getElementById('nextListPreview');
  const validLists = lists.filter(l => getPendingGroups(l).length > 0);
  if (validLists.length === 0) {
    el.textContent = 'Koi list nahi — pehle Lists tab mein groups add karo'; return;
  }
  const idx = (schedule.currentListIndex || 0) % validLists.length;
  const next = validLists[idx];
  const nextRunAt = schedule.nextRunAt;
  const timeStr = nextRunAt ? formatDateTime(nextRunAt) : 'Abhi chalao';
  el.innerHTML = `<strong>${next.name}</strong> (${getPendingGroups(next).length} pending groups) — Scheduled: ${timeStr}`;
}

function updateCharCount() {
  const len = document.getElementById('postMessage').value.length;
  document.getElementById('charCount').textContent = len + ' characters';
}


function normalizePostData(raw) {
  const base = raw || {};
  const posts = Array.isArray(base.posts) ? base.posts : [];
  const migratedPosts = posts.map(normalizeQueuedPost).filter(p => p.message);
  if (migratedPosts.length === 0 && base.message) {
    migratedPosts.push(normalizeQueuedPost({
      id: Date.now(),
      message: base.message,
      imageUrl: base.imageUrl || '',
      imageBase64: base.imageBase64 || '',
      status: 'pending',
      addedAt: Date.now()
    }));
  }
  return {
    message: base.message || '',
    imageUrl: base.imageUrl || '',
    imageBase64: base.imageBase64 || '',
    delay: base.delay || 10,
    posts: migratedPosts
  };
}

function normalizeQueuedPost(post) {
  return {
    id: post.id || Math.floor(Date.now() + Math.random() * 1000),
    message: post.message || '',
    imageUrl: post.imageUrl || '',
    imageBase64: post.imageBase64 || '',
    status: ['pending', 'processing', 'posted'].includes(post.status) ? post.status : 'pending',
    addedAt: post.addedAt || Date.now(),
    startedAt: post.startedAt || null,
    postedAt: post.postedAt || null
  };
}

async function syncDraftPost() {
  postData.message = document.getElementById('postMessage').value.trim();
  postData.imageUrl = document.getElementById('imageUrl').value.trim();
  await savePost();
}

async function ensureDraftPostQueued() {
  const message = document.getElementById('postMessage').value.trim();
  if ((postData.posts || []).some(p => p.status === 'pending')) return;
  if (!message) return;
  postData.posts = postData.posts || [];
  postData.posts.push(normalizeQueuedPost({
    message,
    imageUrl: postData.imageUrl || '',
    imageBase64: postData.imageBase64 || '',
    status: 'pending',
    addedAt: Date.now()
  }));
  await savePost();
  renderPostQueue();
}

function getNextPendingPost() {
  return (postData.posts || []).find(p => p.status === 'pending');
}

async function savePostQueueDraft() {
  const message = document.getElementById('postMessage').value.trim();
  if (!message) { alert('Post message likhna zaroori hai!'); return; }
  postData.posts = postData.posts || [];

  if (editingPostId) {
    const post = postData.posts.find(p => p.id === editingPostId);
    if (!post) { cancelPostEdit(); return; }
    post.message = message;
    post.imageUrl = postData.imageUrl || '';
    post.imageBase64 = postData.imageBase64 || '';
    if (post.status === 'posted') {
      post.status = 'pending';
      post.postedAt = null;
    }
  } else {
    postData.posts.push(normalizeQueuedPost({
      message,
      imageUrl: postData.imageUrl || '',
      imageBase64: postData.imageBase64 || '',
      status: 'pending',
      addedAt: Date.now()
    }));
  }

  clearPostDraftFields();
  await savePost();
  renderPostQueue();
}

function clearPostDraftFields() {
  editingPostId = null;
  postData.message = '';
  postData.imageUrl = '';
  postData.imageBase64 = '';
  document.getElementById('postMessage').value = '';
  document.getElementById('imageUrl').value = '';
  document.getElementById('imageFile').value = '';
  document.getElementById('imagePreview').style.display = 'none';
  document.getElementById('btnAddPostToQueue').textContent = '➕ Add Post to Queue';
  document.getElementById('btnCancelPostEdit').style.display = 'none';
  updateCharCount();
}

async function clearPostImageDraft() {
  postData.imageUrl = '';
  postData.imageBase64 = '';
  document.getElementById('imageUrl').value = '';
  document.getElementById('imageFile').value = '';
  document.getElementById('imagePreview').style.display = 'none';
  await savePost();
}

function cancelPostEdit() {
  clearPostDraftFields();
}

async function resetPostQueue() {
  if (!confirm('Sab queued posts ko pending kar dein? Posted posts dobara chal sakti hain.')) return;
  (postData.posts || []).forEach(p => { p.status = 'pending'; p.startedAt = null; p.postedAt = null; });
  await savePost();
  renderPostQueue();
}

async function handlePostQueueClick(e) {
  const btn = e.target.closest('[data-post-action]');
  if (!btn) return;
  const id = Number(btn.dataset.postId);
  const post = (postData.posts || []).find(p => p.id === id);
  if (!post) return;
  if (btn.dataset.postAction === 'edit') {
    loadPostIntoEditor(post);
    return;
  }
  if (btn.dataset.postAction === 'moveup') {
    moveQueuedPost(id, -1);
  }
  if (btn.dataset.postAction === 'movedown') {
    moveQueuedPost(id, 1);
  }
  if (btn.dataset.postAction === 'remove') {
    if (!confirm('Yeh post queue se remove karo?')) return;
    postData.posts = postData.posts.filter(p => p.id !== id);
  }
  if (btn.dataset.postAction === 'pending') {
    post.status = 'pending'; post.startedAt = null; post.postedAt = null;
  }
  await savePost();
  renderPostQueue();
}

function moveQueuedPost(postId, direction) {
  const idx = (postData.posts || []).findIndex(p => p.id === postId);
  const nextIdx = idx + direction;
  if (idx === -1 || nextIdx < 0 || nextIdx >= postData.posts.length) return;
  [postData.posts[idx], postData.posts[nextIdx]] = [postData.posts[nextIdx], postData.posts[idx]];
}

function loadPostIntoEditor(post) {
  editingPostId = post.id;
  postData.message = post.message || '';
  postData.imageUrl = post.imageUrl || '';
  postData.imageBase64 = post.imageBase64 || '';
  document.getElementById('postMessage').value = postData.message;
  document.getElementById('imageUrl').value = postData.imageUrl;
  if (postData.imageBase64) {
    document.getElementById('imagePreview').src = postData.imageBase64;
    document.getElementById('imagePreview').style.display = 'block';
  } else {
    document.getElementById('imagePreview').style.display = 'none';
  }
  document.getElementById('btnAddPostToQueue').textContent = '💾 Update Queued Post';
  document.getElementById('btnCancelPostEdit').style.display = 'inline-flex';
  updateCharCount();
}

function renderPostQueue() {
  const container = document.getElementById('postQueueList');
  if (!container) return;
  const posts = postData.posts || [];
  if (posts.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding:12px"><div class="icon">📝</div>Koi queued post nahi.<br>Message/image add karke queue mein save karo.</div>';
    return;
  }
  container.innerHTML = posts.map((post, index) => `
    <div class="post-queue-item">
      <div class="flex gap-2" style="justify-content:space-between;align-items:flex-start">
        <div style="min-width:0;flex:1">
          <div class="post-queue-message">Order #${index + 1}: ${escHtml(post.message)}</div>
          <div class="text-sm mt-2">${post.imageBase64 || post.imageUrl ? '🖼️ Image attached' : 'No image'}${post.postedAt ? ` · Posted: ${formatDateTime(post.postedAt)}` : ''}</div>
        </div>
        <span class="status-badge post-status-${post.status}">${post.status === 'posted' ? 'Posted successfully' : post.status}</span>
      </div>
      <div class="flex gap-2 mt-2" style="flex-wrap:wrap">
        <button class="btn btn-secondary btn-sm" data-post-action="moveup" data-post-id="${post.id}" ${index===0?'disabled':''}>↑ Up</button>
        <button class="btn btn-secondary btn-sm" data-post-action="movedown" data-post-id="${post.id}" ${index===posts.length-1?'disabled':''}>↓ Down</button>
        <button class="btn btn-primary btn-sm" data-post-action="edit" data-post-id="${post.id}">Edit</button>
        <button class="btn btn-secondary btn-sm" data-post-action="pending" data-post-id="${post.id}">Mark Pending</button>
        <button class="btn btn-danger btn-sm" data-post-action="remove" data-post-id="${post.id}">Remove</button>
      </div>
    </div>`).join('');
}

// ── Resume session check ──────────────────────────────────────
function checkResumeSession() {
  if (!session?.groups?.length) return;
  const remaining = session.groups.filter(g => g.status === 'pending' || g.status === 'processing');
  if (remaining.length === 0) return;
  const done = session.groups.filter(g => g.status === 'done').length;
  document.getElementById('resumeAlert').style.display = 'block';
  document.getElementById('resumeInfo').textContent =
    `${session.listName ? `"${session.listName}" — ` : ''}${done}/${session.groups.length} done, ${remaining.length} baki.`;
}

async function startFresh() {
  session = null;
  await chrome.storage.local.set({ [SK.SESSION]: null });
  document.getElementById('resumeAlert').style.display = 'none';
  startPosting();
}

async function resumePosting() {
  document.getElementById('resumeAlert').style.display = 'none';
  if (session?.groups) {
    session.groups.forEach(g => { if (g.status === 'processing') g.status = 'pending'; });
    await chrome.storage.local.set({ [SK.SESSION]: session });
  }
  await chrome.runtime.sendMessage({ action: 'startSession', session });
  isRunning = true;
  setRunningUI(true);
  switchTab('status');
  renderStatus();
}

// ── Manual Start Posting (specific list) ────────────────────
async function startPosting() {
  await syncDraftPost();
  await ensureDraftPostQueued();
  const nextPost = getNextPendingPost();
  if (!nextPost) { alert('Queue mein koi pending post nahi. Pehle post add karo ya Reset Queue dabao.'); return; }

  const selIdx = parseInt(document.getElementById('selectListForPost').value);
  if (isNaN(selIdx) || !lists[selIdx]) {
    alert('Pehle koi list select karo!'); return;
  }
  const chosenList = lists[selIdx];
  const pendingGroups = getPendingGroups(chosenList);
  if (chosenList.groups.length === 0) {
    alert(`"${chosenList.name}" mein koi group nahi. Pehle groups add karo.`); return;
  }
  if (pendingGroups.length === 0) {
    alert(`"${chosenList.name}" mein pending groups nahi. Failed URLs approve karo ya statuses reset karo.`); return;
  }

  session = {
    id:        Date.now(),
    listName:  chosenList.name,
    listIndex: selIdx,
    listId:    chosenList.id,
    groups:    pendingGroups.map(g => ({
      name:    g.name,
      url:     g.url,
      groupId: g.groupId,
      status:  'pending',
      error:   null,
      sourceGroupId: g.groupId
    })),
    postId:      nextPost.id,
    postIndex:   postData.posts.findIndex(p => p.id === nextPost.id),
    message:     nextPost.message,
    imageUrl:    nextPost.imageUrl    || '',
    imageBase64: nextPost.imageBase64 || '',
    delay:       postData.delay       || 10,
    startedAt:   Date.now(),
    scheduledRun: false,
    autoPostQueue: true
  };

  nextPost.status = 'processing';
  nextPost.startedAt = Date.now();
  await savePost();
  renderPostQueue();
  await chrome.storage.local.set({ [SK.SESSION]: session });
  await chrome.runtime.sendMessage({ action: 'startSession', session });
  isRunning = true;
  setRunningUI(true);
  switchTab('status');
  renderStatus();
}

async function stopPosting() {
  await chrome.runtime.sendMessage({ action: 'stopSession' });
  isRunning = false;
  setRunningUI(false);
  document.getElementById('currentGroupText').textContent = '⏹ Stopped. Resume later.';
}

async function runNextListNow() {
  await syncDraftPost();
  await ensureDraftPostQueued();
  if (!getNextPendingPost()) { alert('Queue mein koi pending post nahi. Pehle post add karo ya Reset Queue dabao.'); return; }
  if (lists.filter(l => getPendingGroups(l).length > 0).length === 0) {
    alert('Koi list nahi. Lists tab mein groups add karo.'); return;
  }
  const validLists = lists.filter(l => getPendingGroups(l).length > 0);
  const idx = (schedule.currentListIndex || 0) % validLists.length;
  if (!confirm(`Abhi "${validLists[idx].name}" (${getPendingGroups(validLists[idx]).length} pending groups) run karein?\n\nRotation pointer next list par move ho jayega.`)) return;

  const resp = await chrome.runtime.sendMessage({ action: 'runListNow' });
  if (resp && !resp.ok) { alert('Error: ' + resp.error); return; }
  isRunning = true;
  setRunningUI(true);
  switchTab('status');
  // Reload schedule to reflect updated pointer
  const data = await chrome.storage.local.get(SK.SCHEDULE);
  schedule = data[SK.SCHEDULE] || schedule;
  renderScheduleTab();
}

function setRunningUI(running) {
  document.getElementById('btnStart').style.display     = running ? 'none'   : 'flex';
  document.getElementById('btnStop').style.display      = running ? 'flex'   : 'none';
  document.getElementById('runningPulse').style.display = running ? 'inline-block' : 'none';
  document.getElementById('headerStatus').textContent   = running ? '🟢 Running' : 'Ready';
}

// ════════════════════════════════════════════════════════════════
//  LISTS TAB
// ════════════════════════════════════════════════════════════════
// Each list: { id, name, groups: [{ name, url, groupId, addedAt }] }

function setupListsTab() {
  document.getElementById('btnCreateList').addEventListener('click', createList);
  document.getElementById('newListName').addEventListener('keypress', e => {
    if (e.key === 'Enter') createList();
  });
  document.getElementById('btnExportAllLists').addEventListener('click', exportAllLists);
  document.getElementById('btnImportLists').addEventListener('click', () => {
    document.getElementById('importListsFile').click();
  });
  document.getElementById('importListsFile').addEventListener('change', importLists);

  // Single persistent event delegation — survives innerHTML re-renders
  setupListsDelegation();
}

function createList() {
  const name = document.getElementById('newListName').value.trim();
  if (!name) { alert('List ka naam dalo!'); return; }
  if (lists.find(l => l.name.toLowerCase() === name.toLowerCase())) {
    alert('Iss naam ki list pehle se hai!'); return;
  }
  lists.push({ id: Date.now(), name, groups: [] });
  document.getElementById('newListName').value = '';
  saveLists();
  renderLists();
  renderPostTab();
}

function deleteList(listId) {
  const l = lists.find(x => x.id === listId);
  if (!l) return;
  if (!confirm(`"${l.name}" delete karo? Sab groups bhi delete ho jayenge!`)) return;
  lists = lists.filter(x => x.id !== listId);
  saveLists();
  renderLists();
  renderPostTab();
}

function renameList(listId) {
  const l = lists.find(x => x.id === listId);
  if (!l) return;
  const newName = prompt('Naya naam:', l.name);
  if (!newName || !newName.trim()) return;
  l.name = newName.trim();
  saveLists();
  renderLists();
  renderPostTab();
}

function addGroupToList(listId) {
  const l = lists.find(x => x.id === listId);
  if (!l) return;
  if (l.groups.length >= MAX_GROUPS_PER_LIST) {
    alert(`Maximum ${MAX_GROUPS_PER_LIST} groups per list. Naya list banao!`); return;
  }
  const name = document.getElementById(`gname_${listId}`).value.trim();
  const url  = document.getElementById(`gurl_${listId}`).value.trim();
  if (!url) { alert('Group URL dalo!'); return; }

  const normalized = normalizeUrl(url);
  const groupId    = extractGroupId(normalized);
  if (!groupId) { alert('Invalid Facebook group URL!\n\nURL mein /groups/ hona chahiye.'); return; }
  if (l.groups.find(g => extractGroupId(g.url) === groupId)) {
    alert('Yeh group is list mein pehle se hai!'); return;
  }

  l.groups.push({
    name:    name || ('Group ' + (l.groups.length + 1)),
    url:     normalized,
    groupId: groupId,
    status:  'pending',
    addedAt: Date.now()
  });

  document.getElementById(`gname_${listId}`).value = '';
  document.getElementById(`gurl_${listId}`).value  = '';
  saveLists();
  renderLists();
  renderPostTab();
}

function bulkAddToList(listId) {
  const l = lists.find(x => x.id === listId);
  if (!l) return;
  const raw   = document.getElementById(`gbulk_${listId}`).value.trim();
  const lines = raw.split('\n').map(x => x.trim()).filter(Boolean);
  let added = 0;
  for (const line of lines) {
    if (l.groups.length >= MAX_GROUPS_PER_LIST) { break; }
    const normalized = normalizeUrl(line);
    const groupId    = extractGroupId(normalized);
    if (!groupId) continue;
    if (l.groups.find(g => extractGroupId(g.url) === groupId)) continue;
    l.groups.push({ name: 'Group ' + (l.groups.length + 1), url: normalized, groupId, status: 'pending', addedAt: Date.now() });
    added++;
  }
  document.getElementById(`gbulk_${listId}`).value = '';
  saveLists();
  renderLists();
  renderPostTab();
  alert(added > 0 ? `${added} group(s) add hue!` : 'Koi naya group nahi (duplicates ya invalid URLs).');
}

function removeGroupFromList(listId, groupIndex) {
  const l = lists.find(x => x.id === listId);
  if (!l) return;
  if (!confirm(`"${l.groups[groupIndex].name}" remove karo?`)) return;
  l.groups.splice(groupIndex, 1);
  saveLists();
  renderLists();
  renderPostTab();
}

function moveGroupInList(listId, idx, dir) {
  const l = lists.find(x => x.id === listId);
  if (!l) return;
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= l.groups.length) return;
  [l.groups[idx], l.groups[newIdx]] = [l.groups[newIdx], l.groups[idx]];
  saveLists();
  renderLists();
}

function moveList(listIdx, dir) {
  const newIdx = listIdx + dir;
  if (newIdx < 0 || newIdx >= lists.length) return;
  [lists[listIdx], lists[newIdx]] = [lists[newIdx], lists[listIdx]];
  saveLists();
  renderLists();
  renderPostTab();
}

function toggleListBody(listId) {
  const body = document.getElementById('listbody_' + listId);
  if (!body) return;
  const isOpen = body.classList.contains('open');
  body.classList.toggle('open', !isOpen);
}

function renderLists() {
  const container = document.getElementById('listsContainer');
  if (lists.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="icon">📋</div>Koi list nahi bani.<br>Upar se banao.</div>`;
    return;
  }

  const validLists = lists.filter(l => getPendingGroups(l).length > 0);
  const currentIdx = validLists.length > 0
    ? (schedule.currentListIndex || 0) % validLists.length
    : -1;

  container.innerHTML = lists.map((l, listIdx) => {
    const validIdx  = validLists.findIndex(vl => vl.id === l.id);
    const isCurrent = validIdx !== -1 && validIdx === currentIdx;
    const isNext    = validIdx !== -1 && validIdx === ((currentIdx + 1) % validLists.length) && validLists.length > 1;
    const slotsFull = l.groups.length >= MAX_GROUPS_PER_LIST;
    const lid       = l.id;

    const groupRows = l.groups.length === 0
      ? `<div class="text-sm text-center" style="padding:12px;color:#65676b">Koi group nahi. Neeche add karo.</div>`
      : l.groups.map((g, gi) => `
        <div class="group-item">
          <div class="group-num">${gi + 1}</div>
          <div class="group-info">
            <div class="group-name-text">${escHtml(g.name)}</div>
            <div class="group-url-text">${escHtml(g.url)}</div>
          </div>
          <span class="status-badge url-status-${normalizeGroupStatus(g.status)}">${normalizeGroupStatus(g.status)}</span>
          <div class="flex gap-2" style="flex-shrink:0">
            <button class="btn btn-secondary btn-sm" data-action="mgup"   data-lid="${lid}" data-gi="${gi}" ${gi===0?'disabled':''}>↑</button>
            <button class="btn btn-secondary btn-sm" data-action="mgdown" data-lid="${lid}" data-gi="${gi}" ${gi===l.groups.length-1?'disabled':''}>↓</button>
            <button class="btn btn-danger btn-sm"    data-action="rmg"    data-lid="${lid}" data-gi="${gi}">✕</button>
          </div>
        </div>`).join('');

    const addForm = slotsFull
      ? `<div class="alert alert-warning" style="margin-top:8px;font-size:11px;">⚠️ Maximum ${MAX_GROUPS_PER_LIST} groups full. Naya list banao!</div>`
      : `<hr class="section-sep">
         <div style="font-size:11px;font-weight:700;color:#65676b;margin-bottom:6px;">➕ GROUP ADD KARO (${l.groups.length}/${MAX_GROUPS_PER_LIST})</div>
         <div class="add-row">
           <input type="text" id="gname_${lid}" placeholder="Group name" style="flex:0.8" />
           <input type="url"  id="gurl_${lid}"  placeholder="facebook.com/groups/..." style="flex:1.2" />
           <button class="btn btn-primary btn-sm" data-action="addg" data-lid="${lid}">Add</button>
         </div>
         <details style="margin-top:6px">
           <summary style="font-size:11px;cursor:pointer;color:#65676b;user-select:none">📋 Bulk add (multiple URLs)</summary>
           <textarea id="gbulk_${lid}" placeholder="Ek line pe ek URL:&#10;https://www.facebook.com/groups/123&#10;https://www.facebook.com/groups/456" style="min-height:55px;margin-top:6px;font-size:12px;width:100%"></textarea>
           <button class="btn btn-secondary btn-sm mt-2" data-action="bulkg" data-lid="${lid}">Add All</button>
         </details>`;

    return `
    <div class="list-card">
      <div class="list-card-header" data-action="toggle" data-lid="${lid}" style="cursor:pointer">
        <div style="flex:1;min-width:0">
          <div class="list-name" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            ${escHtml(l.name)}
            ${isCurrent ? '<span class="current-badge">Today\'s List</span>' : ''}
            ${isNext    ? '<span class="next-up-badge">Next</span>'         : ''}
          </div>
          <div class="list-meta">${getListStatusSummary(l)} — Click to expand/collapse</div>
        </div>
        <div class="flex gap-2" style="flex-shrink:0;margin-left:6px">
          <button class="btn btn-secondary btn-sm" data-action="mlup"   data-li="${listIdx}" ${listIdx===0?'disabled':''}>↑</button>
          <button class="btn btn-secondary btn-sm" data-action="mldown" data-li="${listIdx}" ${listIdx===lists.length-1?'disabled':''}>↓</button>
          <button class="btn btn-secondary btn-sm" data-action="reseturlstatus" data-lid="${lid}">↺ Status</button>
          <button class="btn btn-secondary btn-sm" data-action="rename" data-lid="${lid}">✏</button>
          <button class="btn btn-danger btn-sm"    data-action="del"    data-lid="${lid}">🗑</button>
        </div>
      </div>
      <div class="list-card-body" id="listbody_${lid}">
        ${renderRejectedUrls(l, lid)}
        ${groupRows}
        ${addForm}
      </div>
    </div>`;
  }).join('');
}

function setupListsDelegation() {
  // Attach a persistent delegated listener that survives re-renders
  const container = document.getElementById('listsContainer');
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    const action = btn.dataset.action;
    const lid    = btn.dataset.lid !== undefined ? Number(btn.dataset.lid) : null;
    const li     = btn.dataset.li  !== undefined ? Number(btn.dataset.li)  : null;
    const gi     = btn.dataset.gi  !== undefined ? Number(btn.dataset.gi)  : null;

    switch (action) {
      case 'toggle': e.stopPropagation(); toggleListBody(lid); break;
      case 'del':    e.stopPropagation(); deleteList(lid);     break;
      case 'rename': e.stopPropagation(); renameList(lid);     break;
      case 'mlup':   e.stopPropagation(); moveList(li, -1);    break;
      case 'mldown': e.stopPropagation(); moveList(li,  1);    break;
      case 'addg':   e.stopPropagation(); addGroupToList(lid); break;
      case 'bulkg':  e.stopPropagation(); bulkAddToList(lid);  break;
      case 'mgup':   e.stopPropagation(); moveGroupInList(lid, gi, -1); break;
      case 'mgdown': e.stopPropagation(); moveGroupInList(lid, gi,  1); break;
      case 'rmg':    e.stopPropagation(); removeGroupFromList(lid, gi); break;
      case 'approve': e.stopPropagation(); setGroupUrlStatus(lid, gi, 'pending'); break;
      case 'reject':  e.stopPropagation(); setGroupUrlStatus(lid, gi, 'rejected'); break;
      case 'reseturlstatus': e.stopPropagation(); resetListUrlStatuses(lid); break;
    }
  });
}


function getPendingGroups(list) {
  return (list.groups || []).filter(g => normalizeGroupStatus(g.status) === 'pending');
}

function normalizeGroupStatus(status) {
  return ['pending', 'success', 'rejected'].includes(status) ? status : 'pending';
}

function getListStatusSummary(list) {
  const groups = list.groups || [];
  const counts = groups.reduce((acc, g) => {
    acc[normalizeGroupStatus(g.status)]++;
    return acc;
  }, { pending: 0, success: 0, rejected: 0 });
  return `${groups.length}/${MAX_GROUPS_PER_LIST} groups · ✅ ${counts.success} success · ⏳ ${counts.pending} pending · ❌ ${counts.rejected} rejected`;
}

function renderRejectedUrls(list, listId) {
  const rejected = (list.groups || [])
    .map((g, index) => ({ ...g, index }))
    .filter(g => normalizeGroupStatus(g.status) === 'rejected');
  if (rejected.length === 0) return '';
  return `
    <div class="alert alert-danger" style="margin-bottom:8px;">
      <strong>❌ Failed / Rejected URLs (${rejected.length})</strong>
      <div class="text-sm" style="margin-top:3px;color:#721c24">Approve = pending retry mein wapis, Remove = list se delete.</div>
    </div>
    ${rejected.map(g => `
      <div class="group-item rejected-review-item">
        <div class="group-num" style="background:#fa3e3e">${g.index + 1}</div>
        <div class="group-info">
          <div class="group-name-text">${escHtml(g.name)}</div>
          <div class="group-url-text">${escHtml(g.url)}</div>
        </div>
        <span class="status-badge url-status-rejected">rejected</span>
        <button class="btn btn-success btn-sm" data-action="approve" data-lid="${listId}" data-gi="${g.index}">Approve</button>
        <button class="btn btn-danger btn-sm" data-action="rmg" data-lid="${listId}" data-gi="${g.index}">Remove</button>
      </div>`).join('')}`;
}

async function resetListUrlStatuses(listId) {
  const l = lists.find(x => x.id === listId);
  if (!l) return;
  if (!confirm(`"${l.name}" ke sab URL statuses pending kar dein?`)) return;
  l.groups.forEach(g => { g.status = 'pending'; g.lastError = null; });
  await saveLists();
  renderLists();
  renderPostTab();
  renderScheduleTab();
}

async function setGroupUrlStatus(listId, groupIndex, status) {
  const l = lists.find(x => x.id === listId);
  if (!l || !l.groups[groupIndex]) return;
  l.groups[groupIndex].status = normalizeGroupStatus(status);
  await saveLists();
  renderLists();
  renderPostTab();
  renderScheduleTab();
}

// ── Export / Import ──────────────────────────────────────────
function exportAllLists() {
  const blob = new Blob([JSON.stringify(lists, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'skoolyst-group-lists.json'; a.click();
  URL.revokeObjectURL(url);
}

function importLists(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async (ev) => {
    try {
      const imported = JSON.parse(ev.target.result);
      if (!Array.isArray(imported)) { alert('Invalid JSON: array expected.'); return; }
      let addedLists = 0;
      imported.forEach(item => {
        if (!item.name || !Array.isArray(item.groups)) return;
        if (lists.find(l => l.name.toLowerCase() === item.name.toLowerCase())) return;
        lists.push({
          id:     Math.floor(Date.now() + Math.random() * 1000),
          name:   item.name,
          groups: (item.groups || []).slice(0, MAX_GROUPS_PER_LIST).map(g => ({
            name:    g.name || 'Group',
            url:     normalizeUrl(g.url || ''),
            groupId: extractGroupId(g.url || '') || '',
            status:  normalizeGroupStatus(g.status),
            addedAt: Date.now()
          })).filter(g => g.groupId)
        });
        addedLists++;
      });
      await saveLists();
      renderLists();
      renderPostTab();
      alert(`${addedLists} list(s) import ho gaye!`);
    } catch { alert('JSON parse error.'); }
  };
  reader.readAsText(file);
  e.target.value = '';
}

// ════════════════════════════════════════════════════════════════
//  SCHEDULE TAB
// ════════════════════════════════════════════════════════════════
function setupScheduleTab() {
  document.getElementById('scheduleEnabled').addEventListener('change', (e) => {
    document.getElementById('scheduleTimeRow').style.display = e.target.checked ? 'block' : 'none';
    document.getElementById('scheduleToggleLabel').textContent = e.target.checked ? 'Auto-Run: ON ✅' : 'Auto-Run: OFF';
  });
  document.getElementById('btnSaveSchedule').addEventListener('click', saveScheduleSettings);
  document.getElementById('btnResetPointer').addEventListener('click', resetPointer);
  document.getElementById('btnSkipList').addEventListener('click', skipList);
}

async function saveScheduleSettings() {
  const enabled = document.getElementById('scheduleEnabled').checked;
  const hour    = parseInt(document.getElementById('schedHour').value)   || 8;
  const minute  = parseInt(document.getElementById('schedMinute').value) || 0;

  // Calculate next run: today at configured time, or tomorrow if already past
  let nextRunAt = null;
  if (enabled) {
    const now  = new Date();
    const next = new Date();
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    nextRunAt = next.getTime();
  }

  schedule = {
    ...schedule,
    enabled,
    hour,
    minute,
    nextRunAt,
    currentListIndex: schedule.currentListIndex || 0
  };
  await saveSchedule();
  // Tell background to reset alarm
  await chrome.runtime.sendMessage({ action: 'setupAlarm' });
  renderScheduleTab();
  alert(enabled
    ? `✅ Schedule saved!\nNext run: ${formatDateTime(nextRunAt)}\nList: "${getNextListName()}"`
    : 'Schedule OFF kar diya.'
  );
}

function getNextListName() {
  const validLists = lists.filter(l => getPendingGroups(l).length > 0);
  if (validLists.length === 0) return 'No lists';
  const idx = (schedule.currentListIndex || 0) % validLists.length;
  return validLists[idx].name;
}

async function resetPointer() {
  if (!confirm('Rotation pointer reset karein? Wapis pehli list se shuru hoga.')) return;
  schedule.currentListIndex = 0;
  await saveSchedule();
  renderScheduleTab();
  renderPostTab();
}

async function skipList() {
  const validLists = lists.filter(l => getPendingGroups(l).length > 0);
  if (validLists.length === 0) { alert('Koi list nahi.'); return; }
  const cur = (schedule.currentListIndex || 0) % validLists.length;
  const next = (cur + 1) % validLists.length;
  if (!confirm(`"${validLists[cur].name}" skip karein?\nNext: "${validLists[next].name}"`)) return;
  schedule.currentListIndex = next;
  await saveSchedule();
  renderScheduleTab();
  renderPostTab();
}

function renderScheduleTab() {
  // Toggle state
  document.getElementById('scheduleEnabled').checked = !!schedule.enabled;
  document.getElementById('scheduleTimeRow').style.display = schedule.enabled ? 'block' : 'none';
  document.getElementById('scheduleToggleLabel').textContent = schedule.enabled ? 'Auto-Run: ON ✅' : 'Auto-Run: OFF';
  document.getElementById('schedHour').value   = schedule.hour   ?? 8;
  document.getElementById('schedMinute').value = schedule.minute ?? 0;

  // Rotation info
  const validLists = lists.filter(l => getPendingGroups(l).length > 0);
  const total = validLists.length;

  if (total === 0) {
    document.getElementById('nextListName').textContent = 'Koi list nahi';
    document.getElementById('nextRunTime').textContent  = 'Lists tab mein groups add karo';
    document.getElementById('rotationPointerInfo').textContent = 'No lists configured';
  } else {
    const idx   = (schedule.currentListIndex || 0) % total;
    const next  = validLists[idx];
    document.getElementById('nextListName').textContent = next.name + ` (${getPendingGroups(next).length} pending groups)`;
    document.getElementById('nextRunTime').textContent  = schedule.enabled && schedule.nextRunAt
      ? `Next run: ${formatDateTime(schedule.nextRunAt)}`
      : schedule.enabled ? 'Will run on next browser startup' : 'Auto-run OFF — Manual sirf';
    document.getElementById('rotationPointerInfo').textContent =
      `List ${idx + 1} of ${total}: "${next.name}"`;
  }

  // Last run info
  const lastRunCard = document.getElementById('lastRunCard');
  if (schedule.lastRunAt) {
    lastRunCard.style.display = 'block';
    document.getElementById('lastRunInfo').innerHTML = `
      <div class="text-sm">
        <strong>List:</strong> ${escHtml(schedule.lastListName || 'Unknown')}<br>
        <strong>Time:</strong> ${formatDateTime(schedule.lastRunAt)}<br>
        ${schedule.cycleComplete ? '<span style="color:#42b72a;font-weight:700">✅ Ek cycle complete! Wapis List 1 se shuru hoga.</span>' : ''}
      </div>`;
  } else {
    lastRunCard.style.display = 'none';
  }
}


async function refreshListsFromStorage() {
  const data = await chrome.storage.local.get(SK.LISTS);
  lists = data[SK.LISTS] || [];
}

// ════════════════════════════════════════════════════════════════
//  STATUS TAB
// ════════════════════════════════════════════════════════════════
function setupStatusTab() {
  document.getElementById('btnResetStatus').addEventListener('click', async () => {
    if (!confirm('Sab statuses reset karein to pending?')) return;
    if (session?.groups) {
      session.groups.forEach(g => { g.status = 'pending'; g.error = null; });
      await chrome.storage.local.set({ [SK.SESSION]: session });
      renderStatus();
    }
  });
}

function renderStatus() {
  const progressCard = document.getElementById('progressCard');
  const statsRow     = document.getElementById('statsRow');
  const statusList   = document.getElementById('statusList');

  if (!session?.groups?.length) {
    progressCard.style.display = 'none';
    statsRow.style.display     = 'none';
    statusList.innerHTML = `<div class="empty-state"><div class="icon">📊</div>Koi session nahi.<br>Post tab se posting shuru karo.</div>`;
    return;
  }

  progressCard.style.display = 'block';
  statsRow.style.display     = 'flex';

  if (session.listName) {
    document.getElementById('sessionListBadge').textContent  = `📋 ${session.listName}`;
    document.getElementById('sessionListBadge').style.display = 'inline-block';
  }

  const total   = session.groups.length;
  const done    = session.groups.filter(g => g.status === 'done').length;
  const failed  = session.groups.filter(g => g.status === 'failed').length;
  const pending = session.groups.filter(g => g.status === 'pending' || g.status === 'processing').length;
  const pct     = total > 0 ? Math.round(((done + failed) / total) * 100) : 0;

  document.getElementById('progressBar').style.width  = pct + '%';
  document.getElementById('progressText').textContent = `${done + failed} / ${total} processed`;
  document.getElementById('statDone').textContent    = done;
  document.getElementById('statFailed').textContent  = failed;
  document.getElementById('statPending').textContent = pending;

  statusList.innerHTML = session.groups.map((g, i) => `
    <div class="group-item" style="margin-bottom:5px;">
      <div class="group-num" style="background:${statusColor(g.status)}">${i + 1}</div>
      <div class="group-info">
        <div class="group-name-text">${escHtml(g.name)}</div>
        <div class="group-url-text">${escHtml(g.url)}</div>
        ${g.error ? `<div style="font-size:10px;color:#fa3e3e;margin-top:2px;">⚠ ${escHtml(g.error)}</div>` : ''}
      </div>
      <span class="status-badge status-${g.status}">${g.status}</span>
    </div>`).join('');
}

function statusColor(s) {
  return { pending:'#65676b', processing:'#f7b928', done:'#42b72a', failed:'#fa3e3e' }[s] || '#65676b';
}

// ════════════════════════════════════════════════════════════════
//  HISTORY TAB
// ════════════════════════════════════════════════════════════════
function setupHistoryTab() {
  document.getElementById('btnClearHistory').addEventListener('click', async () => {
    if (!confirm('Poori history delete karein?')) return;
    history = [];
    await chrome.storage.local.set({ [SK.HISTORY]: [] });
    renderHistory();
  });
}

function renderHistory() {
  const container = document.getElementById('historyContainer');
  if (history.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="icon">🗓</div>Koi history nahi.<br>Posting ke baad yahan records aayenge.</div>`;
    return;
  }

  container.innerHTML = history.map((rec, i) => {
    const date     = formatDateTime(rec.startedAt);
    const duration = rec.endedAt ? Math.round((rec.endedAt - rec.startedAt) / 60000) : '?';
    const isAuto   = rec.scheduledRun ? '🤖 Auto' : '👤 Manual';

    return `
    <div class="history-item">
      <div class="history-header" onclick="toggleHistory(${i})">
        <div>
          <div class="history-title">${escHtml(rec.listName || 'Session')} <span style="font-size:10px;color:#65676b;font-weight:400">${isAuto}</span></div>
          <div class="history-meta">${date} · ${duration} min</div>
        </div>
        <div class="history-stats">
          <span class="stat-pill stat-done">✅ ${rec.done}</span>
          <span class="stat-pill stat-failed">❌ ${rec.failed}</span>
        </div>
      </div>
      <div class="history-body" id="hbody_${i}">
        ${(rec.groups || []).map((g, gi) => `
          <div class="group-item" style="margin-bottom:4px">
            <div class="group-num" style="background:${g.status==='done'?'#42b72a':'#fa3e3e'}">${gi+1}</div>
            <div class="group-info">
              <div class="group-name-text">${escHtml(g.name)}</div>
              ${g.error ? `<div style="font-size:10px;color:#fa3e3e">⚠ ${escHtml(g.error)}</div>` : ''}
            </div>
            <span class="status-badge status-${g.status}">${g.status}</span>
          </div>`).join('')}
      </div>
    </div>`;
  }).join('');
}

window.toggleHistory = function(i) {
  const body = document.getElementById(`hbody_${i}`);
  if (body) body.classList.toggle('open');
};

// ════════════════════════════════════════════════════════════════
//  RENDER ALL
// ════════════════════════════════════════════════════════════════
function renderAll() {
  renderLists();
  renderPostTab();
  renderScheduleTab();
  renderStatus();
  renderHistory();
}

// ── Utilities ─────────────────────────────────────────────────
function normalizeUrl(url) {
  url = url.trim();
  if (!url) return url;
  if (!url.startsWith('http')) url = 'https://' + url;
  return url.replace(/\/$/, '');
}

function extractGroupId(url) {
  const match = (url || '').match(/facebook\.com\/groups\/([^/?#]+)/);
  return match ? match[1] : null;
}

function formatDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString('en-PK', { day:'2-digit', month:'short', year:'numeric' }) +
    ' ' + d.toLocaleTimeString('en-PK', { hour:'2-digit', minute:'2-digit' });
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
