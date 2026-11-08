import { normalizeOrder, orderApps, moveApp } from './order.js';
import { initWallpapers } from './wallpaper.js';

const $ = selector => document.querySelector(selector);
const activeStatuses = new Set(['starting', 'running', 'restarting', 'stopping']);
let apps = [];
let menuId = null;
let connected = true;
let refreshing = false;
let renderKey = '';
let issuesKey = '';
let actionVersion = 0;
let offlineMessage = 'Offline · run localhost to reopen';
const busy = new Set();
const pendingWindows = new Map();
const orderKey = 'localhost.app-order.v1';
let savedOrder = [];
try { savedOrder = normalizeOrder(JSON.parse(localStorage.getItem(orderKey))); } catch { /* Storage may be unavailable. */ }
let drag = null;
let suppressClickUntil = 0;

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function notice(message, persistent = false) {
  $('#notice').textContent = message;
  $('#notice').hidden = false;
  clearTimeout(notice.timer);
  if (!persistent) notice.timer = setTimeout(() => { $('#notice').hidden = true; }, 7000);
}
async function api(path, method = 'GET') {
  const response = await fetch(path, {
    method,
    headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {},
    body: method === 'POST' ? '{}' : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || data.app?.error || 'Could not complete that action.');
  return data;
}
function initials(name) {
  return name.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[\s_-]+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
}
function saveOrder(order) {
  savedOrder = normalizeOrder(order);
  try { localStorage.setItem(orderKey, JSON.stringify(savedOrder)); }
  catch { notice('Order saved for this visit. Browser storage is unavailable.'); }
}
function gridOrder() { return [...$('#app-grid').children].map(tile => tile.dataset.appId); }
function arrangeTiles(order) {
  const grid = $('#app-grid');
  const tiles = new Map([...grid.children].map(tile => [tile.dataset.appId, tile]));
  for (const id of order) if (tiles.has(id)) grid.append(tiles.get(id));
}
function positionGhost() {
  if (drag?.ghost) drag.ghost.style.transform = `translate(${drag.x - drag.offsetX}px, ${drag.y - drag.offsetY}px) scale(1.06)`;
}
function moveOver(x, y) {
  const target = document.elementFromPoint(x, y)?.closest('.app-tile');
  if (!target || target.dataset.appId === drag.id) return;
  arrangeTiles(moveApp(gridOrder(), drag.id, target.dataset.appId));
}
function scrollDrag() {
  if (!drag?.active) return;
  const edge = 70;
  const speed = drag.y < edge ? -Math.ceil((edge - drag.y) / 6) : drag.y > innerHeight - edge ? Math.ceil((drag.y - innerHeight + edge) / 6) : 0;
  if (speed) { window.scrollBy(0, speed); moveOver(drag.x, drag.y); }
  drag.frame = requestAnimationFrame(scrollDrag);
}
function finishDrag(cancelled = false) {
  if (!drag) return;
  const current = drag;
  drag = null;
  cancelAnimationFrame(current.frame);
  current.ghost?.remove();
  current.tile.classList.remove('dragging');
  document.body.classList.remove('reordering');
  if ($('#app-grid').hasPointerCapture(current.pointerId)) $('#app-grid').releasePointerCapture(current.pointerId);
  if (current.active) {
    suppressClickUntil = Date.now() + 400;
    if (cancelled) arrangeTiles(current.originalOrder);
    else { saveOrder(gridOrder()); $('#announcement').textContent = `${current.name} moved.`; }
  }
  // Let the click following a simple tap finish before a poll replaces its node.
  setTimeout(() => { if (!drag) { renderKey = ''; render(); } }, 0);
}
function dragMove(event) {
  if (!drag || drag.pointerId !== event.pointerId) return;
  drag.x = event.clientX; drag.y = event.clientY;
  if (!drag.active && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 8) return;
  event.preventDefault();
  if (!drag.active) {
    drag.active = true;
    // Capture on the grid: it stays in place while its app tiles are reordered.
    $('#app-grid').setPointerCapture(event.pointerId);
    drag.ghost = drag.tile.querySelector('.app-icon').cloneNode(true);
    drag.ghost.classList.add('drag-ghost');
    drag.ghost.style.width = `${drag.rect.width}px`;
    drag.ghost.style.height = `${drag.rect.height}px`;
    document.body.append(drag.ghost);
    drag.tile.classList.add('dragging');
    document.body.classList.add('reordering');
    drag.frame = requestAnimationFrame(scrollDrag);
  }
  positionGhost();
  moveOver(drag.x, drag.y);
}
function bindDragging(area, tile, app) {
  area.addEventListener('dragstart', event => event.preventDefault());
  area.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary || drag || busy.has('all')) return;
    const handle = event.target.closest('button');
    if (!handle || handle.disabled) return;
    const rect = area.getBoundingClientRect();
    drag = { id: app.id, name: app.name, tile, handle, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, rect, originalOrder: gridOrder(), active: false };
  });
  area.addEventListener('click', event => {
    if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  area.addEventListener('contextmenu', event => { event.preventDefault(); finishDrag(true); showMenu(app.id); });
  area.addEventListener('keydown', event => {
    if (!event.altKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const order = gridOrder();
    const columns = getComputedStyle($('#app-grid')).gridTemplateColumns.split(' ').filter(size => parseFloat(size) > 0).length || 1;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key];
    const index = order.indexOf(app.id);
    const destination = Math.max(0, Math.min(order.length - 1, index + step));
    saveOrder(moveApp(order, app.id, order[destination]));
    renderKey = ''; render();
    $('#announcement').textContent = `${app.name}, position ${destination + 1} of ${order.length}.`;
  });
}
function render() {
  if (drag) return;
  const key = JSON.stringify([apps, savedOrder, [...busy], connected]);
  if (key === renderKey) return;
  renderKey = key;
  document.body.classList.toggle('offline', !connected);
  const focused = document.activeElement?.dataset?.focusKey;
  $('#stop-all').disabled = !connected || busy.has('all');
  $('#stop-all').setAttribute('aria-busy', String(busy.has('all')));
  const grid = $('#app-grid');
  grid.replaceChildren();
  for (const app of orderApps(apps, savedOrder)) {
    const tile = node('article', 'app-tile');
    tile.dataset.appId = app.id;
    const area = node('div', 'icon-area');
    const launch = node('button', 'launch-button');
    const action = app.isSelf || app.status === 'error' || activeStatuses.has(app.status) ? 'Options for' : 'Restart and open';
    launch.setAttribute('aria-label', `${action} ${app.name}`);
    launch.title = app.error || `${app.name} · ${connected ? app.status : 'offline'}`;
    launch.dataset.focusKey = `${app.id}-launch`;
    launch.setAttribute('aria-description', 'Drag to rearrange, or hold Alt and use the arrow keys.');
    launch.disabled = !connected || busy.has(app.id) || busy.has('all');
    const icon = node('span', 'app-icon');
    icon.style.setProperty('--icon-color', app.color);
    if (app.icon) {
      const image = node('img');
      image.src = app.icon; image.alt = ''; image.loading = 'lazy'; image.draggable = false;
      image.addEventListener('error', () => image.replaceWith(document.createTextNode(app.emoji || initials(app.name))));
      icon.append(image);
    } else icon.append(document.createTextNode(app.emoji || initials(app.name)));
    if (connected && (app.status !== 'stopped' || busy.has(app.id))) icon.append(node('span', `status-dot ${busy.has(app.id) ? 'starting' : app.status}`));
    icon.setAttribute('aria-hidden', 'true');
    launch.append(icon);
    launch.addEventListener('click', () => {
      if (activeStatuses.has(app.status) || app.isSelf || app.status === 'error') showMenu(app.id);
      else launchApp(app);
    });
    area.append(launch);
    if (activeStatuses.has(app.status) && connected) {
      const stop = node('button', 'tile-stop');
      stop.append($('#stop-all svg').cloneNode(true));
      if (icon.querySelector('.status-dot')) stop.append(icon.querySelector('.status-dot').cloneNode(true));
      stop.dataset.focusKey = `${app.id}-stop`;
      stop.setAttribute('aria-label', `Shut down ${app.name}`);
      stop.title = `Shut down ${app.name}`;
      stop.disabled = busy.has(app.id) || busy.has('all');
      if (!stop.disabled) area.classList.add('has-stop');
      stop.addEventListener('click', event => {
        // A touch tap opens controls; hovering with a pointer exposes direct stop.
        if (event.pointerType === 'touch') showMenu(app.id);
        else stopApp(app);
      });
      area.append(stop);
    }
    bindDragging(area, tile, app);
    tile.append(area, node('span', 'app-name', app.name));
    grid.append(tile);
  }
  if (focused) grid.querySelector(`[data-focus-key="${focused}"]`)?.focus({ preventScroll: true });
}
document.addEventListener('keydown', event => { if (event.key === 'Escape' && drag) { event.preventDefault(); finishDrag(true); } });
document.addEventListener('pointermove', dragMove, { passive: false });
document.addEventListener('pointerup', event => { if (drag?.pointerId === event.pointerId) finishDrag(); });
document.addEventListener('pointercancel', event => { if (drag?.pointerId === event.pointerId) finishDrag(true); });
$('#app-grid').addEventListener('lostpointercapture', event => { if (event.target === $('#app-grid') && drag?.pointerId === event.pointerId) finishDrag(true); });
window.addEventListener('blur', () => finishDrag(true));
window.addEventListener('storage', event => {
  if (event.key !== orderKey || drag) return;
  try { savedOrder = normalizeOrder(JSON.parse(event.newValue)); render(); } catch { /* Ignore invalid data. */ }
});
function closePending(id) {
  const pending = pendingWindows.get(id);
  pending?.window?.close();
  pendingWindows.delete(id);
}
function markShutdown() {
  for (const id of pendingWindows.keys()) closePending(id);
  apps = apps.map(app => ({ ...app, status: 'stopped', pid: null }));
  connected = false;
  offlineMessage = 'Stopped · run localhost to reopen';
  $('#app-menu').close();
  notice(offlineMessage, true);
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  const version = actionVersion;
  try {
    const data = await api('/api/apps');
    if (version !== actionVersion) return;
    if (!connected) $('#notice').hidden = true;
    connected = true;
    apps = data.apps;
    const nextIssuesKey = JSON.stringify(data.issues);
    if (nextIssuesKey !== issuesKey) {
      issuesKey = nextIssuesKey;
      $('#issues-button').hidden = !data.issues.length;
      $('#issues').replaceChildren(...data.issues.map(issue => node('p', '', `${issue.project}: ${issue.message}`)));
    }
    for (const [id, pending] of pendingWindows) {
      const app = apps.find(item => item.id === id);
      if (app?.status === 'running') {
        if (pending.window && !pending.window.closed) pending.window.location.replace(app.url);
        else { showMenu(id); notice(`${app.name} is ready. Tap Open.`); }
        pendingWindows.delete(id);
      } else if (!app || ['error', 'stopped'].includes(app.status) || Date.now() - pending.at > 180_000) {
        closePending(id);
        notice(app?.error || 'App did not start.');
      }
    }
    render();
    if ($('#app-menu').open) await updateMenu();
  } catch {
    if (version !== actionVersion) return;
    connected = false;
    notice(offlineMessage, true);
    render();
    if ($('#app-menu').open) updateMenu();
  } finally { refreshing = false; }
}
async function launchApp(app) {
  if (app.isSelf) { showMenu(app.id); return; }
  if (!connected || busy.has(app.id) || busy.has('all')) return;
  const tab = window.open('about:blank', '_blank');
  if (tab) {
    tab.opener = null;
    tab.document.title = app.name;
    tab.document.body.textContent = `${app.name}…`;
    tab.document.body.style.cssText = 'font:16px -apple-system,sans-serif;padding:10vh 8vw;background:#f3f3f0;color:#30362f';
  }
  $('#app-menu').close();
  busy.add(app.id); actionVersion++; render();
  try {
    const { app: updated } = await api(`/api/apps/${app.id}/launch`, 'POST');
    apps = apps.map(item => item.id === app.id ? updated : item);
    pendingWindows.set(app.id, { window: tab, at: Date.now() });
  } catch (error) { tab?.close(); notice(error.message); }
  finally { busy.delete(app.id); actionVersion++; render(); await refresh(); }
}
async function stopApp(app) {
  if (!connected || busy.has(app.id) || busy.has('all')) return;
  busy.add(app.id);
  if (app.isSelf) busy.add('all');
  actionVersion++; render();
  try {
    const { app: updated } = await api(`/api/apps/${app.id}/stop`, 'POST');
    apps = apps.map(item => item.id === app.id ? updated : item);
    closePending(app.id);
    if (app.isSelf) markShutdown();
  } catch (error) { notice(error.message); }
  finally {
    busy.delete(app.id);
    if (app.isSelf) busy.delete('all');
    actionVersion++; render();
    if (connected) await refresh();
  }
}
function showMenu(id) {
  menuId = id;
  $('#output').open = false;
  $('#logs').textContent = '';
  if (!$('#app-menu').open) $('#app-menu').showModal();
  updateMenu();
}
async function updateMenu() {
  const id = menuId;
  const app = apps.find(item => item.id === id);
  if (!app) { $('#app-menu').close(); return; }
  $('#menu-name').textContent = app.name;
  $('#menu-launch').hidden = !!app.isSelf;
  $('#menu-launch').disabled = !connected || busy.has(id) || busy.has('all');
  $('#menu-open').hidden = app.isSelf || app.status !== 'running' || !connected;
  $('#menu-open').href = app.url;
  $('#menu-stop').disabled = !connected || !activeStatuses.has(app.status) || busy.has(id) || busy.has('all');
  $('#output').hidden = !!app.isSelf;
  $('#app-error').hidden = !app.error;
  $('#app-error').textContent = app.error || '';
  if (!app.isSelf && $('#output').open && connected) {
    try {
      const { logs } = await api(`/api/apps/${id}/logs`);
      if (id !== menuId) return;
      const el = $('#logs');
      const bottom = el.scrollHeight - el.clientHeight - el.scrollTop < 35;
      el.textContent = logs.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') || 'No output.';
      if (bottom) el.scrollTop = el.scrollHeight;
    } catch (error) { $('#logs').textContent = error.message; }
  }
}
$('#menu-launch').addEventListener('click', () => { const app = apps.find(item => item.id === menuId); if (app) launchApp(app); });
$('#menu-stop').addEventListener('click', () => { const app = apps.find(item => item.id === menuId); if (app) stopApp(app); });
$('#output').addEventListener('toggle', () => { if ($('#output').open) updateMenu(); });
$('#issues-button').addEventListener('click', () => $('#issues-dialog').showModal());
for (const close of document.querySelectorAll('[data-close]')) close.addEventListener('click', () => close.closest('dialog').close());
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
}
$('#stop-all').addEventListener('click', async () => {
  if (!connected || busy.has('all')) return;
  busy.add('all'); actionVersion++; render();
  try {
    await api('/api/shutdown', 'POST');
    markShutdown();
  } catch (error) { notice(error.message); }
  finally { busy.delete('all'); actionVersion++; render(); if (connected) await refresh(); }
});
initWallpapers(notice).catch(error => notice(error.message));
refresh();
setInterval(refresh, 1500);
