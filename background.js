// ══════════════════════════════════════════════════════════════
//  Skoolyst FB Groups Poster  —  background.js  v6.0
//  Features:
//    • Group Lists (named, max 20 groups each)
//    • Daily Rotation: one list per day, pointer advances each run
//    • Smart Schedule: runs when system starts if time has passed
//    • Full History/Records per session
//    • Auto-reset when all lists complete
// ══════════════════════════════════════════════════════════════

const SK = {
  LISTS:     'sk_lists',       // Array of group lists
  SCHEDULE:  'sk_schedule',    // { enabled, hour, minute, nextRunAt, currentListIndex }
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

// ── Run the next list in rotation ────────────────────────────
async function runNextList(lists, schedule, post) {
  const listIndex = schedule.currentListIndex || 0;
  const validLists = lists.filter(l => getPendingGroups(l).length > 0);
  if (validLists.length === 0) {
    console.log('[Skoolyst BG] No lists with groups found');
    return;
  }

  // Wrap index
  const actualIndex = listIndex % validLists.length;
  const chosenList  = validLists[actualIndex];

  console.log(`[Skoolyst BG] Running list ${actualIndex + 1}/${validLists.length}: "${chosenList.name}"`);

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
    delay:       post.delay       || 10,
    startedAt:   Date.now(),
    scheduledRun: true,
    autoPostQueue: true
  };

  await markQueuedPostProcessing(post.id);
  await chrome.storage.local.set({ [SK.SESSION]: session });

  // Advance pointer for next time
  const nextIndex = (actualIndex + 1) % validLists.length;
  const wasLastList = nextIndex === 0;

  // Calculate next run time: same time next day from NOW
  const nextRunAt = Date.now() + 24 * 60 * 60 * 1000;

  const updatedSchedule = {
    ...schedule,
    currentListIndex: nextIndex,
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
        imageBase64: session.imageBase64 || ''
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
async function handlePostToGroup({ url, message, imageUrl, imageBase64 }) {
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url, active: true });
    await waitForTabLoad(tab.id, 35000);
    await sleep(4000);

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: startPosting,
      args: [message, imageUrl || '', imageBase64 || '']
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
function startPosting(postMessage, imageUrl, imageBase64) {
  if (window.__skoolystRunning) return;
  window.__skoolystRunning = true;
  window.__skoolystResult  = null;
  window.__skoolystLog     = [];

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

  async function clickPostButton(timeout) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const allPostBtns = Array.from(document.querySelectorAll('[aria-label="Post"][role="button"]'));
      for (const btn of allPostBtns) {
        if (!isVisible(btn) || btn.getAttribute('aria-disabled') === 'true') continue;
        log('Clicking Post');
        btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        btn.dispatchEvent(new MouseEvent('mousedown',     { bubbles: true, cancelable: true }));
        await sleep(120);
        btn.dispatchEvent(new PointerEvent('pointerup',   { bubbles: true, cancelable: true }));
        btn.dispatchEvent(new MouseEvent('mouseup',       { bubbles: true, cancelable: true }));
        btn.dispatchEvent(new MouseEvent('click',         { bubbles: true, cancelable: true }));
        btn.click(); return true;
      }
      for (const btn of document.querySelectorAll('[role="button"]')) {
        if (!isVisible(btn) || btn.getAttribute('aria-disabled') === 'true') continue;
        for (const span of btn.querySelectorAll('span')) {
          if (span.children.length === 0 && span.textContent?.trim() === 'Post') {
            const lbl = btn.getAttribute('aria-label') || '';
            if (lbl && lbl !== 'Post') continue;
            btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); await sleep(120);
            btn.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true }));
            btn.dispatchEvent(new MouseEvent('click',     { bubbles: true }));
            btn.click(); return true;
          }
        }
      }
      await sleep(600);
    }
    const last = document.querySelector('[aria-label="Post"][role="button"]');
    if (last) { last.click(); return true; }
    return false;
  }

  (async () => {
    try {
      log('=== Starting: ' + window.location.href);
      const trigger = await findComposerTrigger(15000);
      if (!trigger) { window.__skoolystResult = { done: true, success: false, error: 'Write something button not found' }; return; }
      if (!trigger._alreadyOpen) { trigger.click(); await sleep(3000); }

      const textBox = await findTextBox(12000);
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

      const clicked = await clickPostButton(15000);
      if (!clicked) { window.__skoolystResult = { done: true, success: false, error: 'Post button not found' }; return; }

      const postStart = Date.now();
      while (Date.now() - postStart < 10000) {
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
