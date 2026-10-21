// ══════════════════════════════════════════════════════════════
//  Skoolyst FB Groups Poster  —  background.js  v7.2 (text + image + MCQ polls)
//  Features:
//    • Group Lists (named, max 20 groups each)
//    • Daily Rotation: one list per day, pointer advances each run
//    • Smart Schedule: runs when system starts if time has passed
//    • Full History/Records per session
//    • Auto-reset when all lists complete
// ══════════════════════════════════════════════════════════════

const SK = {
  LISTS:     'sk_lists',       // Array of group lists
  SCHEDULE:  'sk_schedule',    // { enabled, hour, minute, nextRunAt, currentListIndex, nextListId }
  SESSION:   'sk_session',     // Active session
  HISTORY:   'sk_history',     // Array of completed session records
  POST:      'sk_post',        // { message, imageUrl, imageBase64, delay }
};

let isRunning = false;

// ── Startup: check if a scheduled run is due ─────────────────
chrome.runtime.onStartup.addListener(async () => {
  console.log('[Skoolyst BG] Browser started — checking schedule...');
  await checkAndRunSchedule();
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Skoolyst BG] v6.0 installed');
  setupAlarm();
});

// Check schedule every 5 minutes via alarm
async function setupAlarm() {
  await chrome.alarms.clearAll();
  chrome.alarms.create('scheduleCheck', { periodInMinutes: 5 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'scheduleCheck') {
    await checkAndRunSchedule();
  }
});

// ── Schedule Check ────────────────────────────────────────────
async function checkAndRunSchedule() {
  if (isRunning) return;
  const data = await chrome.storage.local.get([SK.SCHEDULE, SK.LISTS, SK.POST]);
  const schedule = data[SK.SCHEDULE];
  if (!schedule || !schedule.enabled) return;

  const now = Date.now();
  if (!schedule.nextRunAt || now < schedule.nextRunAt) return;

  const lists = data[SK.LISTS] || [];
  if (lists.length === 0) return;

  const post = getNextPendingPost(data[SK.POST]);
  if (!post) {
    console.log('[Skoolyst BG] No pending queued post configured, skipping scheduled run');
    return;
  }

  console.log('[Skoolyst BG] Scheduled run triggered!');
  await runNextList(lists, schedule, { ...post, delay: data[SK.POST]?.delay || 10 });
}

// ── Rotation pointer helper (ID based) ───────────────────────
// Starts at schedule.nextListId (falls back to the first list) and walks forward,
// wrapping around, until it finds a list that still has pending groups.
function getNextRotationList(lists, schedule) {
  const n = lists.length;
  if (n === 0) return null;
  let start = lists.findIndex(l => l.id === (schedule && schedule.nextListId));
  if (start === -1) start = 0;
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    if (getPendingGroups(lists[i]).length > 0) return { list: lists[i], index: i };
  }
  return null;
}

// ── Run the next list in rotation ────────────────────────────
async function runNextList(lists, schedule, post) {
  // Pointer is tracked by list ID (schedule.nextListId), NOT by an index into a
  // filtered array — completed lists drop out of the "pending" filter, which
  // used to shift the index and make rotation skip lists.
  const picked = getNextRotationList(lists, schedule);
  if (!picked) {
    console.log('[Skoolyst BG] No lists with groups found');
    return;
  }
  const actualIndex = picked.index;          // position in the FULL lists array
  const chosenList  = picked.list;

  console.log(`[Skoolyst BG] Running list ${actualIndex + 1}/${lists.length}: "${chosenList.name}"`);

  const pendingGroups = getPendingGroups(chosenList);

  const session = {
    id:          Date.now(),
    listName:    chosenList.name,
    listIndex:   actualIndex,
    listId:      chosenList.id,
    groups:      pendingGroups.map(g => ({
      name:    g.name,
      url:     g.url,
      groupId: g.groupId,
      status:  'pending',
      error:   null,
      sourceGroupId: g.groupId
    })),
    postId:      post.id || null,
    postIndex:   post.postIndex ?? null,
    message:     post.message,
    imageUrl:    post.imageUrl    || '',
    imageBase64: post.imageBase64 || '',
    postType:    post.type === 'poll' ? 'poll' : 'text',
    pollOptions: post.pollOptions || [],
    delay:       post.delay       || 10,
    startedAt:   Date.now(),
    scheduledRun: true,
    autoPostQueue: true
  };

  await markQueuedPostProcessing(post.id);
  await chrome.storage.local.set({ [SK.SESSION]: session });

  // Advance pointer for next time
  // Next pointer = the list right after the chosen one in the FULL order.
  // (If it has no pending groups, getNextRotationList skips forward to the next one that has.)
  const nextIndex   = (actualIndex + 1) % lists.length;
  const wasLastList = actualIndex === lists.length - 1;

  // Calculate next run time: same time next day from NOW
  const nextRunAt = Date.now() + 24 * 60 * 60 * 1000;

  const updatedSchedule = {
    ...schedule,
    currentListIndex: nextIndex,
    nextListId:       lists[nextIndex].id,
    lastRunAt:        Date.now(),
    nextRunAt:        nextRunAt,
    lastListName:     chosenList.name,
    cycleComplete:    wasLastList
  };
  await chrome.storage.local.set({ [SK.SCHEDULE]: updatedSchedule });

  notifyPopup({ action: 'scheduledRunStarted', listName: chosenList.name, listIndex: actualIndex });
  await startSessionInBackground(session);
}

// ── Message handler from popup ────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'ping') {
    sendResponse({ status: 'alive' }); return true;
  }
  if (message.action === 'startSession') {
    startSessionInBackground(message.session)
      .catch(err => console.error('[Skoolyst BG] Session error:', err));
    sendResponse({ ok: true }); return true;
  }
  if (message.action === 'stopSession') {
    isRunning = false; sendResponse({ ok: true }); return true;
  }
  if (message.action === 'getStatus') {
    sendResponse({ isRunning }); return true;
  }
  if (message.action === 'runListNow') {
    (async () => {
      const data = await chrome.storage.local.get([SK.LISTS, SK.SCHEDULE, SK.POST]);
      const lists = data[SK.LISTS] || [];
      const schedule = data[SK.SCHEDULE] || { currentListIndex: 0 };
      const post = getNextPendingPost(data[SK.POST]);
      if (!post) { sendResponse({ ok: false, error: 'No pending queued post set' }); return; }
      await runNextList(lists, schedule, { ...post, delay: data[SK.POST]?.delay || 10 });
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (message.action === 'setupAlarm') {
    setupAlarm();
    sendResponse({ ok: true }); return true;
  }
  return true;
});

// ── Session Runner ────────────────────────────────────────────
async function startSessionInBackground(session) {
  if (isRunning) {
    console.log('[Skoolyst BG] Already running');
    return;
  }
  isRunning = true;
  console.log(`[Skoolyst BG] Session started: "${session.listName}" — ${session.groups.length} groups`);

  for (let i = 0; i < session.groups.length; i++) {
    if (!isRunning) { console.log('[Skoolyst BG] Stopped by user'); break; }
    const g = session.groups[i];
    if (g.status === 'done' || g.status === 'failed') { continue; }

    g.status = 'processing';
    await saveSession(session);
    notifyPopup({ action: 'sessionUpdate', session });
    console.log(`[Skoolyst BG] Posting ${i + 1}/${session.groups.length}: ${g.name}`);

    try {
      const result = await handlePostToGroup({
        url:         g.url,
        message:     session.message,
        imageUrl:    session.imageUrl    || '',
        imageBase64: session.imageBase64 || '',
        postType:    session.postType    || 'text',
        pollOptions: session.pollOptions || []
      });
      g.status = (result && result.success) ? 'done' : 'failed';
      if (!result?.success) g.error = result?.error || 'Unknown error';
    } catch (err) {
      g.status = 'failed';
      g.error  = err.message;
    }

    await saveSession(session);
    notifyPopup({ action: 'sessionUpdate', session });

    if (isRunning && i < session.groups.length - 1) {
      const delaySec = session.delay || 10;
      console.log(`[Skoolyst BG] Waiting ${delaySec}s...`);
      await sleep(delaySec * 1000);
    }
  }

  isRunning = false;

  const done   = session.groups.filter(g => g.status === 'done').length;
  const failed = session.groups.filter(g => g.status === 'failed').length;

  const sourceListUpdated = await updateSourceListUrlStatuses(session);
  // await updatePostQueueAfterSession(session, failed);

  // Save to history
  const historyRecord = {
    id:        session.id || Date.now(),
    listName:  session.listName  || 'Manual Session',
    listIndex: session.listIndex ?? null,
    startedAt: session.startedAt || Date.now(),
    endedAt:   Date.now(),
    totalGroups: session.groups.length,
    done,
    failed,
    scheduledRun: session.scheduledRun || false,
    groups: session.groups.map(g => ({
      name:   g.name,
      url:    g.url,
      status: g.status,
      error:  g.error || null
    }))
  };

  const histData = await chrome.storage.local.get(SK.HISTORY);
  const history  = histData[SK.HISTORY] || [];
  history.unshift(historyRecord); // newest first
  // Keep last 50 records
  if (history.length > 50) history.splice(50);
  await chrome.storage.local.set({ [SK.HISTORY]: history });

  notifyPopup({ action: 'sessionComplete', done, failed, session, historyRecord });
  console.log(`[Skoolyst BG] Session complete: ${done} done, ${failed} failed`);

  // if (session.autoPostQueue && failed === 0 && sourceListUpdated) {
  //   await startNextQueuedPost(session);
  // }

  if (session.autoPostQueue && sourceListUpdated) {
    await continueQueuedFlow(session, failed);
  } else {
    await updatePostQueueAfterSession(session, failed, false);
  }
}



function getPendingGroups(list) {
  return (list.groups || []).filter(g => normalizeGroupStatus(g.status) === 'pending');
}

function normalizeGroupStatus(status) {
  return ['pending', 'success', 'rejected'].includes(status) ? status : 'pending';
}

function normalizePostData(raw) {
  const base = raw || {};
  const posts = Array.isArray(base.posts) ? base.posts : [];
  if (posts.length === 0 && base.message) {
    posts.push({
      id: Date.now(),
      message: base.message,
      imageUrl: base.imageUrl || '',
      imageBase64: base.imageBase64 || '',
      status: 'pending',
      addedAt: Date.now()
    });
  }
  return { ...base, posts, delay: base.delay || 10 };
}

function getNextPendingPost(rawPostData) {
  const data = normalizePostData(rawPostData);
  const postIndex = (data.posts || []).findIndex(p => p.status === 'pending');
  return postIndex === -1 ? null : { ...data.posts[postIndex], postIndex };
}

async function markQueuedPostProcessing(postId) {
  if (!postId) return;
  const data = await chrome.storage.local.get(SK.POST);
  const postData = normalizePostData(data[SK.POST]);
  const post = postData.posts.find(p => p.id === postId);
  if (!post) return;
  post.status = 'processing';
  post.startedAt = Date.now();
  await chrome.storage.local.set({ [SK.POST]: postData });
}

// async function updatePostQueueAfterSession(session, failed) {
  async function updatePostQueueAfterSession(session, failed, allListsDone) {
  if (!session.postId) return;
  const data = await chrome.storage.local.get(SK.POST);
  const postData = normalizePostData(data[SK.POST]);
  const post = postData.posts.find(p => p.id === session.postId);
  if (!post) return;
  // if (failed === 0) {
  if (failed === 0 && allListsDone) {
    post.status = 'posted';
    post.postedAt = Date.now();
  } else {
    post.status = 'processing';
  }
  await chrome.storage.local.set({ [SK.POST]: postData });
}

async function updateSourceListUrlStatuses(session) {
  const data = await chrome.storage.local.get(SK.LISTS);
  const lists = data[SK.LISTS] || [];
  const list = session.listId
    ? lists.find(l => l.id === session.listId)
    : lists[session.listIndex];
  if (!list?.groups?.length) return false;

  session.groups.forEach(resultGroup => {
    const source = list.groups.find(g =>
      (resultGroup.sourceGroupId && g.groupId === resultGroup.sourceGroupId) ||
      g.url === resultGroup.url
    );
    if (!source) return;
    source.status = resultGroup.status === 'done' ? 'success' : 'rejected';
    source.lastPostedAt = Date.now();
    source.lastError = resultGroup.status === 'failed' ? (resultGroup.error || 'Unknown error') : null;
  });

  await chrome.storage.local.set({ [SK.LISTS]: lists });
  return true;
}

// ── Queue continuation ──────────────────────────────────────────
// Desired flow: Post #1 runs across List 1 -> List 2 -> List 3 (in order).
// Only once EVERY list has been used for Post #1 do we roll over to
// Post #2, reset every list's groups back to "pending", and repeat the
// same List 1 -> List 2 -> List 3 sweep for Post #2, and so on.
async function continueQueuedFlow(session, failed) {
  if (failed > 0) {
    await updatePostQueueAfterSession(session, failed, false);
    return;
  }

  const data = await chrome.storage.local.get([SK.POST, SK.LISTS]);
  const postData = normalizePostData(data[SK.POST]);
  const currentPost = postData.posts.find(p => p.id === session.postId);
  if (!currentPost) return;

  const remainingLists = (data[SK.LISTS] || []).filter(l => getPendingGroups(l).length > 0);
  if (remainingLists.length > 0) {
    // Same post continues on to the next list that still has pending groups.
    currentPost.status = 'processing';
    await chrome.storage.local.set({ [SK.POST]: postData });
    await startQueuedPostForList(currentPost, remainingLists[0], postData, session);
    return;
  }

  // Every list has now been posted to with the current post — mark it done
  // and move the whole queue on to the next pending post, starting again
  // from the first list.
  await updatePostQueueAfterSession(session, 0, true);
  await advanceToNextQueuedPost(session);
}

// Start `post` on `list`, reusing timing/context from `previousSession`.
async function startQueuedPostForList(post, list, postData, previousSession) {
  const pendingGroups = getPendingGroups(list);
  if (pendingGroups.length === 0) return;

  const nextSession = {
    id: Date.now(),
    listName: list.name,
    listIndex: (await chrome.storage.local.get(SK.LISTS))[SK.LISTS]?.findIndex(l => l.id === list.id) ?? null,
    listId: list.id,
    postId: post.id,
    postIndex: postData.posts.findIndex(p => p.id === post.id),
    groups: pendingGroups.map(g => ({
      name: g.name,
      url: g.url,
      groupId: g.groupId,
      status: 'pending',
      error: null,
      sourceGroupId: g.groupId
    })),
    message: post.message,
    imageUrl: post.imageUrl || '',
    imageBase64: post.imageBase64 || '',
    postType: post.type === 'poll' ? 'poll' : 'text',
    pollOptions: post.pollOptions || [],
    delay: postData.delay || previousSession.delay || 10,
    startedAt: Date.now(),
    scheduledRun: previousSession.scheduledRun || false,
    autoPostQueue: true
  };

  await chrome.storage.local.set({ [SK.SESSION]: nextSession });
  notifyPopup({ action: 'queuedRunStarted', listName: list.name, postIndex: nextSession.postIndex });
  await startSessionInBackground(nextSession);
}

// Reset every list's groups back to pending, then kick off the next
// pending post (if any) starting from the first list again.
async function advanceToNextQueuedPost(previousSession) {
  const data = await chrome.storage.local.get([SK.POST, SK.LISTS]);
  const postData = normalizePostData(data[SK.POST]);
  const lists = data[SK.LISTS] || [];

  const nextPost = getNextPendingPost(postData);
  if (!nextPost) {
    console.log('[Skoolyst BG] All queued posts have been completed.');
    notifyPopup({ action: 'postQueueComplete' });
    return;
  }
  if (lists.length === 0) return;

  // Reset ALL lists so the next post sweeps through every group again.
  lists.forEach(l => {
    (l.groups || []).forEach(g => {
      g.status = 'pending';
      g.lastError = null;
    });
  });
  await chrome.storage.local.set({ [SK.LISTS]: lists });

  nextPost.status = 'processing';
  nextPost.startedAt = Date.now();
  await chrome.storage.local.set({ [SK.POST]: postData });

  await startQueuedPostForList(nextPost, lists[0], postData, previousSession);
}


function notifyPopup(msg) { chrome.runtime.sendMessage(msg).catch(() => {}); }
async function saveSession(session) { await chrome.storage.local.set({ [SK.SESSION]: session }); }

// ── Post to one group (tab open → inject → post → close) ─────
async function handlePostToGroup({ url, message, imageUrl, imageBase64, postType, pollOptions }) {
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url, active: true });
    await waitForTabLoad(tab.id, 35000);
    await sleep(4000);

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: startPosting,
      args: [message, imageUrl || '', imageBase64 || '', postType === 'poll' ? (pollOptions || []) : []]
    });

    const result = await pollForResult(tab.id, 90000);
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    if (tab) {
      await sleep(3000);
      try { await chrome.tabs.remove(tab.id); } catch {}
    }
  }
}

async function pollForResult(tabId, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await sleep(2000);
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => window.__skoolystResult || null
      });
      const result = results?.[0]?.result;
      if (result && result.done) return { success: result.success, error: result.error };

      const logResults = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => { const logs = window.__skoolystLog || []; window.__skoolystLog = []; return logs; }
      });
      (logResults?.[0]?.result || []).forEach(l => console.log('[Skoolyst PAGE]', l));
    } catch (e) {
      console.log('[Skoolyst BG] Poll error:', e.message);
      break;
    }
  }
  return { success: false, error: 'Timeout' };
}

// ══════════════════════════════════════════════════════════════
//  Injected into FB page (unchanged from v5 — proven working)
// ══════════════════════════════════════════════════════════════
function startPosting(postMessage, imageUrl, imageBase64, pollOptions) {
  if (window.__skoolystRunning) return;
  window.__skoolystRunning = true;
  window.__skoolystResult  = null;
  window.__skoolystLog     = [];
  window.__skoolystPostClicked = false;

  function log(msg) { console.log('[Skoolyst]', msg); (window.__skoolystLog = window.__skoolystLog || []).push(msg); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function isVisible(el) {
    if (!el) return false;
    try {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    } catch { return false; }
  }

  async function findComposerTrigger(timeout) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const dialog = document.querySelector('[role="dialog"]');
      if (dialog) {
        const lex = dialog.querySelector('[data-lexical-editor="true"][contenteditable="true"]');
        if (lex && isVisible(lex)) { log('Dialog already open'); return { _alreadyOpen: true }; }
      }
      for (const sel of [
        '[aria-label="Write something to this group..."]',
        '[aria-label="Write something..."]',
        '[aria-label="Create a public post\u2026"]',
        '[aria-label="Create a post"]',
      ]) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (!el.closest('[role="dialog"]') && isVisible(el)) { log('Trigger: ' + sel); return el; }
        }
      }
      for (const span of document.querySelectorAll('span')) {
        if (span.closest('[role="dialog"]')) continue;
        const txt = span.textContent?.trim();
        if (txt === 'Write something...' || txt === 'Write something to this group...') {
          let el = span;
          for (let i = 0; i < 10; i++) {
            el = el.parentElement;
            if (!el) break;
            if (el.getAttribute('role') === 'button' || el.getAttribute('tabindex') === '0') { log('Trigger via span'); return el; }
          }
          return span.parentElement || span;
        }
      }
      await sleep(500);
    }
    return null;
  }

  async function findTextBox(timeout) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const lex = document.querySelector('[role="dialog"] [data-lexical-editor="true"][contenteditable="true"]');
      if (lex && isVisible(lex)) { log('Textbox: lexical'); return lex; }
      for (const sel of [
        '[role="dialog"] [aria-placeholder="Create a public post\u2026"]',
        '[role="dialog"] [aria-placeholder="Create a public post..."]',
        '[role="dialog"] [aria-placeholder="Write something to this group..."]',
        '[role="dialog"] [aria-placeholder="What\'s on your mind?"]',
      ]) {
        const el = document.querySelector(sel);
        if (el && isVisible(el)) { log('Textbox: ' + sel); return el; }
      }
      const dialog = document.querySelector('[role="dialog"]');
      if (dialog) {
        const boxes = Array.from(dialog.querySelectorAll('[contenteditable="true"]'))
          .filter(el => isVisible(el))
          .filter(el => {
            const p = (el.getAttribute('aria-placeholder') || '').toLowerCase();
            const l = (el.getAttribute('aria-label') || '').toLowerCase();
            return !p.includes('comment') && !p.includes('reply') && !l.includes('comment');
          });
        if (boxes.length > 0) {
          const largest = boxes.reduce((a, b) => {
            const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
            return ra.width * ra.height > rb.width * rb.height ? a : b;
          });
          log('Textbox: largest'); return largest;
        }
      }
      await sleep(500);
    }
    return null;
  }

  async function insertTextWithFormatting(el, text) {
    el.focus(); await sleep(300);
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a', ctrlKey: true, keyCode: 65 }));
    await sleep(100);
    document.execCommand('selectAll', false, null); await sleep(100);
    document.execCommand('delete', false, null); await sleep(200);
    el.focus(); await sleep(200);
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
      await sleep(600);
      if ((el.innerText || el.textContent || '').trim().length > 0) { log('Text: paste OK'); return true; }
    } catch(e) { log('Text paste err: ' + e.message); }
    try {
      document.execCommand('selectAll', false, null); document.execCommand('delete', false, null);
      await sleep(200); el.focus();
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].length > 0) document.execCommand('insertText', false, lines[i]);
        if (i < lines.length - 1) {
          el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13 }));
          el.dispatchEvent(new KeyboardEvent('keyup',   { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13 }));
          await sleep(50);
        }
      }
      await sleep(400);
      if ((el.innerText || el.textContent || '').trim().length > 0) { log('Text: line-by-line OK'); return true; }
    } catch(e) { log('Text line-by-line err: ' + e.message); }
    return false;
  }

  async function attachImageViaClipboardPaste(imgUrl, imgBase64, textBox) {
    if (!imgBase64 && !imgUrl) return true;
    log('Attaching image...');
    let blob = null;
    try {
      if (imgBase64 && imgBase64.startsWith('data:')) {
        const arr = imgBase64.split(','), mime = arr[0].match(/:(.*?);/)[1];
        const bstr = atob(arr[1]), u8 = new Uint8Array(bstr.length);
        for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
        blob = new Blob([u8], { type: mime });
      } else if (imgUrl) {
        blob = await fetch(imgUrl).then(r => r.blob());
      }
    } catch(e) { log('Blob err: ' + e.message); return false; }
    if (!blob) return false;
    textBox.click(); textBox.focus();
    try {
      const sel = window.getSelection(), range = document.createRange();
      range.selectNodeContents(textBox); range.collapse(false);
      sel.removeAllRanges(); sel.addRange(range);
    } catch(e) {}
    await sleep(300);
    try {
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'skoolyst-image.jpg', { type: blob.type || 'image/jpeg' }));
      textBox.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
      await sleep(2000);
      const dlg = document.querySelector('[role="dialog"]');
      if (dlg && dlg.querySelector('img[src*="blob:"], img[src*="data:"], [data-visualcompletion="media-vc-image"]')) {
        log('Image confirmed'); return true;
      }
    } catch(e) { log('Image paste err: ' + e.message); }
    try {
      const dialog = document.querySelector('[role="dialog"]') || document.body;
      const dt2 = new DataTransfer();
      dt2.items.add(new File([blob], 'skoolyst-image.jpg', { type: blob.type || 'image/jpeg' }));
      dialog.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt2 }));
      await sleep(2000);
    } catch(e) {}
    log('Image paste done (unconfirmed)');
    return true;
  }


  // ═══════════ POLL SUPPORT (v7.1) ═══════════
  function fireClick(el) {
    try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mousedown',     { bubbles: true, cancelable: true }));
    el.dispatchEvent(new PointerEvent('pointerup',   { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseup',       { bubbles: true, cancelable: true }));
    try { el.click(); } catch (e) {}   // exactly ONE click (a 2nd synthetic click = double action)
  }

  // The REAL "Create post" modal (page can contain several role=dialog nodes)
  function getComposerDialog() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(isVisible);
    const txt = d => (d.innerText || '');
    return dialogs.find(d => /add poll/i.test(txt(d)))
        || dialogs.find(d => /create post/i.test(txt(d)))
        || dialogs.find(d => d.querySelector('[data-lexical-editor="true"]'))
        || dialogs[dialogs.length - 1] || null;
  }

  function findButtonByText(texts, scope, partial) {
    const wanted = texts.map(t => t.toLowerCase());
    const root = scope === 'dialog' ? getComposerDialog() : document;
    if (!root) return null;
    const cands = root.querySelectorAll('[role="button"], div[tabindex="0"], a[role="button"], button');
    for (const el of cands) {
      if (scope === 'page' && el.closest('[role="dialog"]')) continue;
      if (!isVisible(el) || el.getAttribute('aria-disabled') === 'true') continue;
      const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
      const txt  = (el.innerText || el.textContent || '').trim().toLowerCase();
      const hit = v => v && (partial ? wanted.some(w => v.includes(w)) : wanted.includes(v));
      if (hit(aria) || hit(txt)) return el;
    }
    return null;
  }

  async function openPollComposer() {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      const btn = findButtonByText(['Poll'], 'page');
      if (btn) { log('Poll button found on page'); fireClick(btn); await sleep(2500); return true; }
      await sleep(600);
    }
    log('Poll button not on page — trying via composer dialog');
    const trigger = await findComposerTrigger(8000);
    if (!trigger) return false;
    if (!trigger._alreadyOpen) { fireClick(trigger); await sleep(3000); }
    let pbtn = findButtonByText(['Poll'], 'dialog');
    if (!pbtn) {
      const more = findButtonByText(['More', 'More options'], 'dialog');
      if (more) { fireClick(more); await sleep(1200); pbtn = findButtonByText(['Poll'], 'dialog') || findButtonByText(['Poll'], 'page'); }
    }
    if (!pbtn) return false;
    fireClick(pbtn); await sleep(2000);
    return true;
  }

  // Wait until poll UI ("Add poll" / "Option 1") is really inside the modal
  async function waitForPollUi(timeout) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const d = getComposerDialog();
      if (d && /option\s*1/i.test(d.innerText || '')) return true;
      await sleep(500);
    }
    return false;
  }

  // Poll option fields: located via their "Option N" label/placeholder; works for
  // <input>, <textarea> and contenteditable fields.
  function getPollFields() {
    const dlg = getComposerDialog();
    if (!dlg) return [];
    const FIELD = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"], [role="textbox"]';
    const notMain = el => !el.closest('[data-lexical-editor="true"]') && !el.matches('[data-lexical-editor="true"]');
    const fields = [];
    const add = f => { if (f && !fields.includes(f)) fields.push(f); };

    // 1) attribute based (aria-label / placeholder = "Option N")
    dlg.querySelectorAll(FIELD).forEach(f => {
      if (!notMain(f)) return;
      const hint = (f.getAttribute('aria-label') || '') + ' ' + (f.getAttribute('placeholder') || '') + ' ' + (f.getAttribute('aria-placeholder') || '');
      if (/^\s*option\s*\d+\s*$/i.test(hint.trim()) || /option\s*\d+/i.test(hint)) add(f);
    });

    // 2) visible label text "Option N" -> nearest single field around it
    if (fields.length === 0) {
      const labels = Array.from(dlg.querySelectorAll('span, div, label'))
        .filter(el => el.children.length === 0 && /^option\s*\d+$/i.test((el.textContent || '').trim()));
      for (const lab of labels) {
        let node = lab;
        for (let up = 0; up < 7 && node; up++) {
          node = node.parentElement;
          if (!node) break;
          const cands = Array.from(node.querySelectorAll(FIELD)).filter(notMain);
          if (cands.length === 1) { add(cands[0]); break; }
          if (cands.length > 1) break;       // ambiguous container, stop
        }
      }
    }
    // sort in DOM order (top → bottom)
    fields.sort((a, c) => a.getBoundingClientRect().top - c.getBoundingClientRect().top);
    return fields;
  }

  function describeDialog() {
    const d = getComposerDialog();
    if (!d) return 'no-dialog (dialogs on page: ' + document.querySelectorAll('[role="dialog"]').length + ')';
    return 'inputs:' + d.querySelectorAll('input').length + ' textareas:' + d.querySelectorAll('textarea').length +
           ' editable:' + d.querySelectorAll('[contenteditable="true"]').length + ' textboxes:' + d.querySelectorAll('[role="textbox"]').length;
  }

  async function setFieldValue(f, val) {
    f.focus(); try { f.click(); } catch (e) {} await sleep(150);
    const isInput = f.tagName === 'INPUT' || f.tagName === 'TEXTAREA';
    const read = () => isInput ? f.value : (f.innerText || f.textContent || '');
    if (isInput) {
      try { f.select(); document.execCommand('insertText', false, val); } catch (e) {}
      if (f.value !== val) {
        const proto = f.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(f, val);
        f.dispatchEvent(new Event('input',  { bubbles: true }));
        f.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } else {
      try {
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        document.execCommand('insertText', false, val);
      } catch (e) {}
      if (!read().trim()) {
        try {
          const dt = new DataTransfer(); dt.setData('text/plain', val);
          f.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
        } catch (e) {}
      }
    }
    await sleep(250);
    return read().trim() === val.trim();
  }

  async function fillPollOptions(options) {
    if (!(await waitForPollUi(8000))) log('Poll UI text not detected yet — continuing anyway');
    for (let guard = 0; guard < 15; guard++) {
      if (getPollFields().length >= options.length) break;
      const add = findButtonByText(['Add Option'], 'dialog', true);
      if (!add) { log('Add Option button not found'); break; }
      fireClick(add); await sleep(800);
    }
    let fields = getPollFields();
    if (fields.length < options.length) {
      return { ok: false, error: 'Poll option inputs not found (' + fields.length + '/' + options.length + ') [' + describeDialog() + ']' };
    }
    for (let i = 0; i < options.length; i++) {
      fields = getPollFields();               // re-query (React may re-render)
      const okSet = await setFieldValue(fields[i], options[i]);
      log('Option ' + (i + 1) + (okSet ? ' set' : ' NOT set') + ': ' + options[i]);
      if (!okSet) return { ok: false, error: 'Could not type poll option ' + (i + 1) + ' [' + describeDialog() + ']' };
    }
    // remove leftover EMPTY rows (MCQ with fewer than 3 options)
    fields = getPollFields();
    for (let i = fields.length - 1; i >= options.length; i--) {
      let rm = null, node = fields[i];
      for (let up = 0; up < 6 && node && !rm; up++) {
        node = node.parentElement;
        rm = node && Array.from(node.querySelectorAll('[role="button"]')).find(x =>
          isVisible(x) && /remove|delete|clear|close/i.test(x.getAttribute('aria-label') || ''));
      }
      if (rm) { fireClick(rm); await sleep(500); } else { log('Could not remove empty option ' + (i + 1)); }
    }
    return { ok: true };
  }

  // Type the poll question into the main composer (Lexical) and VERIFY it stuck
  async function typePollQuestion(question) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const dlg = getComposerDialog();
      const box = (dlg && dlg.querySelector('[data-lexical-editor="true"][contenteditable="true"]')) || await findTextBox(6000);
      if (!box) { await sleep(800); continue; }
      box.click(); box.focus(); await sleep(300);
      await insertTextWithFormatting(box, question);
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(900);
      const cur = (box.innerText || box.textContent || '').replace(/\s+/g, ' ').trim();
      const probe = question.replace(/\s+/g, ' ').trim().slice(0, 15);
      if (cur.includes(probe)) { log('Question typed (attempt ' + attempt + ')'); return true; }
      log('Question not retained, retry ' + attempt + ' — box text: "' + cur.slice(0, 30) + '"');
      try { document.execCommand('insertText', false, question); } catch (e) {}
      await sleep(900);
      const cur2 = (box.innerText || box.textContent || '').replace(/\s+/g, ' ').trim();
      if (cur2.includes(probe)) { log('Question typed via insertText'); return true; }
    }
    return false;
  }

  // Clicks Post EXACTLY ONCE per page run. A second click would publish a duplicate
  // (poll modals stay open until Facebook responds, so a re-click creates another poll).
  async function clickPostButton(timeout) {
    if (window.__skoolystPostClicked) { log('Post already clicked — skipping'); return true; }
    const press = async (btn) => {
      window.__skoolystPostClicked = true;          // set BEFORE clicking: no path can click twice
      log('Clicking Post (once)');
      btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      btn.dispatchEvent(new MouseEvent('mousedown',     { bubbles: true, cancelable: true }));
      await sleep(120);
      btn.dispatchEvent(new PointerEvent('pointerup',   { bubbles: true, cancelable: true }));
      btn.dispatchEvent(new MouseEvent('mouseup',       { bubbles: true, cancelable: true }));
      btn.click();                                     // the only click event
      return true;
    };
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const dlg = getComposerDialog();
      const scope = dlg || document;
      const allPostBtns = Array.from(scope.querySelectorAll('[aria-label="Post"][role="button"]'));
      for (const btn of allPostBtns) {
        if (!isVisible(btn) || btn.getAttribute('aria-disabled') === 'true') continue;
        return await press(btn);
      }
      for (const btn of scope.querySelectorAll('[role="button"]')) {
        if (!isVisible(btn) || btn.getAttribute('aria-disabled') === 'true') continue;
        for (const span of btn.querySelectorAll('span')) {
          if (span.children.length === 0 && span.textContent?.trim() === 'Post') {
            const lbl = btn.getAttribute('aria-label') || '';
            if (lbl && lbl !== 'Post') continue;
            return await press(btn);
          }
        }
      }
      await sleep(600);
    }
    return false;   // never force-click a disabled button
  }

  (async () => {
    try {
      log('=== Starting: ' + window.location.href);
      const isPoll = Array.isArray(pollOptions) && pollOptions.length >= 2;
      if (isPoll) {
        log('MODE: POLL with ' + pollOptions.length + ' options');
        const opened = await openPollComposer();
        if (!opened) { window.__skoolystResult = { done: true, success: false, error: 'Poll button not found (group may not allow polls)' }; return; }
      } else {
        const trigger = await findComposerTrigger(15000);
        if (!trigger) { window.__skoolystResult = { done: true, success: false, error: 'Write something button not found' }; return; }
        if (!trigger._alreadyOpen) { trigger.click(); await sleep(3000); }
      }

      let textBox = null;
      if (isPoll) {
        // 1) options first (modal fully rendered), 2) question last, 3) verify
        const pr = await fillPollOptions(pollOptions);
        if (!pr.ok) { window.__skoolystResult = { done: true, success: false, error: pr.error }; return; }
        await sleep(600);
        const qok = await typePollQuestion(postMessage);
        if (!qok) { window.__skoolystResult = { done: true, success: false, error: 'Poll question text not retained [' + describeDialog() + ']' }; return; }
        await sleep(800);
      } else {
        textBox = await findTextBox(12000);
        if (!textBox) { window.__skoolystResult = { done: true, success: false, error: 'Post editor not found' }; return; }

        textBox.click(); await sleep(400);
        const ok = await insertTextWithFormatting(textBox, postMessage);
        if (!ok) { window.__skoolystResult = { done: true, success: false, error: 'Could not type text' }; return; }
        textBox.dispatchEvent(new Event('input',  { bubbles: true }));
        textBox.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(1000);

        if (imageUrl || imageBase64) {
          await attachImageViaClipboardPaste(imageUrl, imageBase64, textBox);
          await sleep(2000);
        }

        textBox.click(); textBox.focus();
        textBox.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(800);
      }

      const clicked = await clickPostButton(15000);
      if (!clicked) { window.__skoolystResult = { done: true, success: false, error: 'Post button not found' }; return; }

      const postStart = Date.now();
      while (Date.now() - postStart < 20000) {
        await sleep(800);
        if (!document.querySelector('[role="dialog"]')) {
          log('Done!'); window.__skoolystResult = { done: true, success: true }; window.__skoolystRunning = false; return;
        }
      }
      window.__skoolystResult = { done: true, success: true }; window.__skoolystRunning = false;
    } catch (err) {
      log('FATAL: ' + err.message);
      window.__skoolystResult = { done: true, success: false, error: err.message }; window.__skoolystRunning = false;
    }
  })();
}

// ── Utilities ─────────────────────────────────────────────────
function waitForTabLoad(tabId, timeout) {
  return new Promise(resolve => {
    const deadline = Date.now() + timeout;
    function check() {
      if (Date.now() > deadline) { resolve(); return; }
      chrome.tabs.get(tabId, tab => {
        if (chrome.runtime.lastError || !tab) { resolve(); return; }
        if (tab.status === 'complete') resolve();
        else setTimeout(check, 800);
      });
    }
    setTimeout(check, 1500);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
