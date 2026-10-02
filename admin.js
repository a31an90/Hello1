(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, '');
      else if (v !== false && v != null) n.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  };
  const show = (node, msg) => { node.textContent = msg || ''; node.hidden = !msg; };
  const fmtWhen = (iso) => iso ? new Date(iso).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
  const timeLabel = (t) => { const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  const dateLabel = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'long' });

  let csrf = null, settings = null, refreshTimer = null, currentDetail = null;

  async function api(path, { method = 'GET', body } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers['X-CSRF-Token'] = csrf || '';
    let res;
    try { res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' }); }
    catch { throw { code: 'NETWORK', message: 'Connection problem. Check your signal and try again.' }; }
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (res.status === 401 && path !== '/api/admin/login') { showLogin(); }
    if (!res.ok) throw { code: data.error?.code || 'SERVER', message: data.error?.message || 'Something went wrong.' };
    return data;
  }

  // ---------- auth ----------
  function showLogin() {
    clearInterval(refreshTimer);
    $('#app-view').hidden = true; $('#login-view').hidden = false;
    if ($('#detail').open) $('#detail').close();
    $('#l-user').focus();
  }
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', e.target); btn.disabled = true;
    try {
      const r = await api('/api/admin/login', { method: 'POST', body: { username: $('#l-user').value, password: $('#l-pass').value } });
      $('#l-pass').value = ''; show($('#login-error'), '');
      start(r);
    } catch (err) { show($('#login-error'), err.message); }
    finally { btn.disabled = false; }
  });
  $('#logout-btn').addEventListener('click', async () => {
    try { await api('/api/admin/logout', { method: 'POST', body: {} }); } catch { /* ignore */ }
    csrf = null; showLogin();
  });

  async function start(sessionInfo) {
    csrf = sessionInfo.csrfToken;
    $('#a-user').textContent = sessionInfo.username;
    $('#login-view').hidden = true; $('#app-view').hidden = false;
    await loadSettings();
    await refreshAll();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => { if (!document.hidden && !$('#detail').open) refreshAll(true); }, 30000);
  }

  // ---------- data ----------
  async function loadSettings() {
    settings = await api('/api/admin/settings');
    const allTimes = [...settings.timeSlots.morning, ...settings.timeSlots.evening];
    const fill = (sel, items, keepFirst) => {
      const cur = sel.value;
      const first = keepFirst ? sel.options[0] : null;
      sel.replaceChildren(...(first ? [first] : []), ...items.map(([v, t]) => el('option', { value: v, text: t })));
      if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
    };
    const dates = settings.eventDates.map((d) => [d, dateLabel(d)]);
    const routes = settings.routes.map((r) => [r.code, r.label]);
    const times = allTimes.map((t) => [t, timeLabel(t)]);
    fill($('#f-date'), dates, true); fill($('#f-route'), routes, true); fill($('#f-time'), times, true);
    fill($('#board-date'), dates, false); fill($('#a-date'), dates, false); fill($('#a-route'), routes, false); fill($('#a-time'), times, false);
    renderSettings();
  }
  async function refreshAll(quiet) {
    try {
      await Promise.all([loadSummary(), loadBookings(), $('#panel-slots').hidden ? null : loadBoard()]);
    } catch (err) { if (!quiet) console.warn(err); }
  }
  async function loadSummary() {
    const s = await api('/api/admin/summary');
    $('#s-active').textContent = s.activeBookings;
    $('#s-avail').textContent = s.availableSlots;
    $('#s-booked').textContent = s.bookedSlots;
    $('#s-cancelled').textContent = s.cancelled;
    $('#s-avail-sub').textContent = `Bookable now, ${s.closedSlots} closed`;
    $('#s-booked-sub').textContent = `of ${s.totalSlots} slots`;
  }

  // ---------- bookings table ----------
  let searchTimer = null;
  $('#filters').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadBookings, 250); });
  $('#filters').addEventListener('submit', (e) => e.preventDefault());
  async function loadBookings() {
    const p = new URLSearchParams();
    const add = (k, v) => { if (v) p.set(k, v); };
    add('q', $('#q').value.trim()); add('date', $('#f-date').value); add('route', $('#f-route').value);
    add('time', $('#f-time').value); add('status', $('#f-status').value);
    const { bookings } = await api('/api/admin/bookings?' + p);
    const tbody = $('#b-rows');
    tbody.replaceChildren(...bookings.map(row));
    $('#b-empty').hidden = bookings.length > 0;
    $('#b-count').textContent = bookings.length ? `${bookings.length} booking${bookings.length === 1 ? '' : 's'}` : '';
  }
  function row(b) {
    const tr = el('tr', { class: b.status === 'CANCELLED' ? 'is-cancelled' : '', tabindex: '0', 'aria-label': `Open ${b.bookingId}` },
      el('td', { 'data-k': 'id', text: b.bookingId }),
      el('td', { 'data-k': 'status' }, el('span', { class: `pill pill-${b.status}`, text: b.status })),
      el('td', { 'data-k': 'name', text: b.passengerName }),
      el('td', { 'data-k': 'phone', text: b.phone }),
      el('td', { 'data-k': 'date', text: `${b.weekday.slice(0, 3)} ${b.dateLabel}` }),
      el('td', { 'data-k': 'route', text: b.routeLabel }),
      el('td', { 'data-k': 'time', text: b.timeLabel }),
      el('td', { 'data-k': 'fare', text: `RM${b.fare}` }),
      el('td', { 'data-k': 'created', text: fmtWhen(b.createdAt) }),
      el('td', { 'data-k': 'act' }, el('button', { type: 'button', class: 'row-btn', text: 'View' })));
    // Desktop column order differs from card order; move status after time on wide screens.
    const statusTd = tr.children[1];
    tr.insertBefore(statusTd, tr.children[8]);
    const open = () => openDetail(b.bookingId);
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    return tr;
  }

  // ---------- detail ----------
  async function openDetail(bid) {
    try {
      const { booking } = await api(`/api/admin/bookings/${encodeURIComponent(bid)}`);
      renderDetail(booking);
      if (!$('#detail').open) $('#detail').showModal();
    } catch (err) { alert(err.message); }
  }
  function renderDetail(b) {
    currentDetail = b;
    $('#d-title').textContent = b.bookingId;
    const pill = $('#d-status'); pill.className = `pill pill-${b.status}`; pill.textContent = b.status;
    const dl = $('#d-fields'); dl.replaceChildren();
    const rows = [
      ['Passenger', b.passengerName], ['Phone', b.phone], ['Date', `${b.weekday}, ${b.dateLabel}`], ['Route', b.routeLabel],
      ['Pickup time', b.timeLabel], ['Fare', `RM${b.fare}`], ['Citizen confirmed', b.citizenshipConfirmed ? 'Yes' : 'No'],
      ['Source', b.source === 'admin' ? 'Added by admin' : 'Website'], ['Created', fmtWhen(b.createdAt)],
    ];
    if (b.status === 'CANCELLED') rows.push(['Cancelled', `${fmtWhen(b.cancelledAt)} (${b.cancelledBy || ''})`], ['Reason', b.cancelledReason || '']);
    for (const [k, v] of rows) dl.append(el('dt', { text: k }), el('dd', { text: v }));
    const slotNote = $('#d-slot');
    if (b.status === 'CANCELLED') {
      slotNote.hidden = false;
      slotNote.textContent = b.slotNowHeldBy ? `This slot has since been booked by ${b.slotNowHeldBy}.` : 'This slot is open for booking again.';
    } else slotNote.hidden = true;

    const acts = $('#d-actions'); acts.replaceChildren();
    show($('#d-error'), '');
    if (b.status === 'CONFIRMED') {
      acts.append(
        el('button', { type: 'button', class: 'btn btn-reopen btn-block', text: 'Reopen slot', onclick: () => reopen(b.date, b.route, b.pickupTime || b.time, b.bookingId) }),
        el('button', { type: 'button', class: 'btn btn-outline btn-block', text: 'Cancel booking', onclick: () => cancelBooking(b) }),
      );
    } else if (!b.slotNowHeldBy) {
      acts.append(el('button', { type: 'button', class: 'btn btn-outline btn-block', text: 'Change status to confirmed', onclick: () => reconfirm(b) }));
    }
    $('#d-notes').value = b.adminNotes || '';
    $('#d-history').replaceChildren(...(b.history || []).map((h) => el('li', { text: `${fmtWhen(h.at)} — ${h.action.replace(/_/g, ' ')} by ${h.actor}${h.detail ? ` (${h.detail})` : ''}` })));
  }
  $('#d-close').addEventListener('click', () => $('#detail').close());
  $('#d-save-notes').addEventListener('click', async () => {
    try {
      const { booking } = await api(`/api/admin/bookings/${currentDetail.bookingId}/notes`, { method: 'POST', body: { notes: $('#d-notes').value } });
      renderDetail(booking);
    } catch (err) { show($('#d-error'), err.message); }
  });

  function confirmDialog(message, yesLabel, { reason = false } = {}) {
    return new Promise((resolve) => {
      const d = $('#confirm');
      $('#c-msg').textContent = message; $('#c-yes').textContent = yesLabel;
      $('#c-reason-wrap').hidden = !reason; $('#c-reason').value = '';
      const done = (ok) => { d.close(); $('#c-yes').onclick = null; $('#c-no').onclick = null; resolve(ok ? { reason: $('#c-reason').value } : null); };
      $('#c-yes').onclick = () => done(true);
      $('#c-no').onclick = () => done(false);
      d.addEventListener('cancel', () => resolve(null), { once: true });
      d.showModal();
      $('#c-no').focus();
    });
  }
  async function cancelBooking(b) {
    const ok = await confirmDialog(`Cancel ${b.bookingId}?\n${b.passengerName}, ${b.dateLabel} ${b.timeLabel}\nThe slot will be released for other customers.`, 'Yes, cancel booking', { reason: true });
    if (!ok) return;
    try {
      const { booking } = await api(`/api/admin/bookings/${b.bookingId}/status`, { method: 'POST', body: { status: 'CANCELLED', reason: ok.reason } });
      renderDetail(booking); refreshAll(true);
    } catch (err) { show($('#d-error'), err.message); }
  }
  async function reconfirm(b) {
    const ok = await confirmDialog(`Change ${b.bookingId} back to confirmed?\nThis takes the slot again.`, 'Yes, confirm booking');
    if (!ok) return;
    try {
      const { booking } = await api(`/api/admin/bookings/${b.bookingId}/status`, { method: 'POST', body: { status: 'CONFIRMED' } });
      renderDetail(booking); refreshAll(true);
    } catch (err) { show($('#d-error'), err.message); }
  }
  async function reopen(date, route, time, bid) {
    const r = settings.routes.find((x) => x.code === route);
    const ok = await confirmDialog(`Reopen ${dateLabel(date)}, ${r ? r.label : route}, ${timeLabel(time)}?\n${bid ? `${bid} will be cancelled (record kept) and ` : ''}the slot becomes AVAILABLE to customers.`, 'Yes, reopen slot');
    if (!ok) return;
    try {
      await api('/api/admin/slots/reopen', { method: 'POST', body: { date, route, time } });
      if ($('#detail').open && currentDetail && currentDetail.bookingId === bid) openDetail(bid);
      refreshAll(true); loadBoard();
    } catch (err) { if ($('#detail').open) show($('#d-error'), err.message); else alert(err.message); }
  }

  // ---------- slot board ----------
  $('#board-date').addEventListener('change', loadBoard);
  async function loadBoard() {
    const date = $('#board-date').value;
    if (!date) return;
    const { routes } = await api(`/api/admin/slots?date=${encodeURIComponent(date)}`);
    const board = $('#board');
    board.replaceChildren(...routes.map((r) => el('section', { class: 'board-col' },
      el('h3', { text: r.label }),
      el('h4', { text: 'Morning' }), ...r.morning.map((s) => slotRow(date, r.route, s)),
      el('h4', { text: 'Evening' }), ...r.evening.map((s) => slotRow(date, r.route, s)))));
  }
  function slotRow(date, route, s) {
    let action;
    if (s.status === 'BOOKED') {
      action = el('button', { type: 'button', class: 'btn btn-reopen', text: 'Reopen slot', onclick: () => reopen(date, route, s.time, s.booking.bookingId) });
    } else {
      action = el('button', { type: 'button', class: 'btn btn-quiet', text: 'Add', onclick: () => prefillAdd(date, route, s.time) });
    }
    const who = s.booking
      ? el('button', { type: 'button', class: 'bslot-who', onclick: () => openDetail(s.booking.bookingId) }, el('b', { text: s.booking.passengerName }), `${s.booking.bookingId}, ${s.booking.phone}`)
      : el('span', { class: `pill pill-${s.status}`, text: s.status });
    return el('div', { class: 'bslot' }, el('span', { class: 'bslot-time', text: s.label }), who, action);
  }
  function prefillAdd(date, route, time) {
    $('#a-date').value = date; $('#a-route').value = route; $('#a-time').value = time;
    selectTab('tab-add'); $('#a-name').focus();
  }

  // ---------- add booking ----------
  $('#add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    show($('#add-error'), ''); show($('#add-ok'), '');
    const btn = $('button[type=submit]', e.target); btn.disabled = true;
    try {
      const { booking } = await api('/api/admin/bookings', {
        method: 'POST',
        body: {
          name: $('#a-name').value, phone: $('#a-phone').value, date: $('#a-date').value, route: $('#a-route').value,
          time: $('#a-time').value, citizen: $('#a-citizen').checked, overrideCutoff: $('#a-override').checked,
        },
      });
      show($('#add-ok'), `Booking ${booking.bookingId} created for ${booking.passengerName}, ${booking.dateLabel} ${booking.timeLabel}.`);
      $('#a-name').value = ''; $('#a-phone').value = ''; $('#a-citizen').checked = false; $('#a-override').checked = false;
      refreshAll(true);
    } catch (err) { show($('#add-error'), err.message); }
    finally { btn.disabled = false; }
  });

  // ---------- settings ----------
  let draftDates = [];
  function renderSettings() {
    draftDates = [...settings.eventDates];
    renderDateList();
    const box = $('#notes-fields'); box.replaceChildren();
    for (const r of settings.routes) {
      const id = `note-${r.code}`;
      box.append(el('div', { class: 'field' }, el('label', { for: id, text: r.label }),
        el('textarea', { id, maxlength: '300', 'data-route': r.code })));
      $(`#${id}`, box).value = settings.pickupNotes[r.code] || '';
    }
    $('#max-phone').value = settings.maxActivePerPhone;
  }
  function renderDateList() {
    $('#date-list').replaceChildren(...draftDates.map((d) => el('li', {}, dateLabel(d) + ` (${d})`,
      el('button', { type: 'button', text: 'Remove', onclick: () => { draftDates = draftDates.filter((x) => x !== d); renderDateList(); } }))));
  }
  $('#add-date').addEventListener('click', () => {
    const v = $('#new-date').value;
    if (v && !draftDates.includes(v)) { draftDates.push(v); draftDates.sort(); renderDateList(); }
    $('#new-date').value = '';
  });
  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    show($('#settings-error'), ''); show($('#settings-ok'), '');
    const pickupNotes = {};
    $$('#notes-fields textarea').forEach((t) => { pickupNotes[t.dataset.route] = t.value; });
    try {
      settings = await api('/api/admin/settings', { method: 'PUT', body: { eventDates: draftDates, pickupNotes, maxActivePerPhone: Number($('#max-phone').value) } });
      await loadSettings();
      show($('#settings-ok'), 'Settings saved. The booking site shows the changes immediately.');
      refreshAll(true);
    } catch (err) { show($('#settings-error'), err.message); }
  });
  $('#pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    show($('#pw-error'), ''); show($('#pw-ok'), '');
    try {
      await api('/api/admin/password', { method: 'POST', body: { currentPassword: $('#pw-cur').value, newPassword: $('#pw-new').value } });
      $('#pw-cur').value = ''; $('#pw-new').value = '';
      show($('#pw-ok'), 'Password changed. Other devices have been signed out.');
    } catch (err) { show($('#pw-error'), err.message); }
  });

  // ---------- tabs ----------
  function selectTab(id) {
    for (const t of $$('[role=tab]')) {
      const on = t.id === id;
      t.setAttribute('aria-selected', String(on));
      $('#' + t.getAttribute('aria-controls')).hidden = !on;
    }
    if (id === 'tab-slots') loadBoard();
  }
  $$('[role=tab]').forEach((t) => t.addEventListener('click', () => selectTab(t.id)));

  // ---------- boot ----------
  (async () => {
    try { start(await api('/api/admin/session')); }
    catch { showLogin(); }
  })();
})();
