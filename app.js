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

  const state = {
    config: null, step: 1,
    name: '', phone: '', citizen: false,
    route: null, date: null, time: null,
    slots: null, requestKey: null, submitting: false, pollTimer: null,
  };

  // ---------- helpers ----------
  async function api(path, body) {
    const opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
    let res;
    try { res = await fetch(path, opts); } catch {
      throw { code: 'NETWORK', message: 'Connection problem. Check your mobile signal and try again.' };
    }
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) throw { code: data.error?.code || 'SERVER', message: data.error?.message || 'Something went wrong. Please try again.' };
    return data;
  }
  function normalizePhone(input) {
    let s = String(input || '').replace(/[\s\-().]/g, '');
    if (s.startsWith('+')) s = s.slice(1);
    if (s.startsWith('60')) s = '0' + s.slice(2);
    return /^01(?:1\d{8}|[02-9]\d{7})$/.test(s) ? s : null;
  }
  const fmtPhone = (s) => `${s.slice(0, 3)}-${s.slice(3)}`;
  const route = (code) => state.config?.routes.find((r) => r.code === code);
  const dateInfo = (d) => state.config?.dates.find((x) => x.date === d);
  const timeLabel = (t) => {
    const [h, m] = t.split(':').map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);
  function showError(node, msg) { node.textContent = msg; node.hidden = !msg; }
  function fillReview(dl, rows) {
    dl.replaceChildren();
    for (const [k, v] of rows) dl.append(el('dt', { text: k }), el('dd', { text: v }));
  }
  const waLink = (text) => `https://wa.me/${state.config?.whatsapp || '60148154572'}${text ? `?text=${encodeURIComponent(text)}` : ''}`;

  // ---------- wizard ----------
  const wizard = $('#wizard');
  const steps = $$('.step', wizard);

  function goTo(n, { focus = true } = {}) {
    state.step = n;
    for (const s of steps) s.hidden = Number(s.dataset.step) !== n;
    for (const li of $$('.progress li', wizard)) {
      const k = Number(li.dataset.step);
      li.classList.toggle('done', k < n);
      if (k === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    }
    if (n === 4) { loadSlots(); startPolling(); } else stopPolling();
    if (n === 5) renderReview();
    if (focus) {
      const title = $(`.step[data-step="${n}"] .step-title`, wizard);
      if (title) { title.setAttribute('tabindex', '-1'); title.focus({ preventScroll: true }); }
      const top = $('#book').getBoundingClientRect().top;
      if (top < -40 || top > window.innerHeight * 0.5) $('#book-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
  $$('.js-back', wizard).forEach((b) => b.addEventListener('click', () => goTo(Math.max(1, state.step - 1))));

  // Step 1: details
  const fName = $('#f-name'), fPhone = $('#f-phone');
  const citizenBoxes = $$('.js-citizen');
  citizenBoxes.forEach((cb) => cb.addEventListener('change', () => {
    state.citizen = cb.checked;
    citizenBoxes.forEach((o) => { o.checked = state.citizen; });
    if (state.citizen) { showError($('#e-citizen'), ''); showError($('#review-error'), ''); }
  }));
  $('#step-details').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = fName.value.replace(/\s+/g, ' ').trim();
    const phone = normalizePhone(fPhone.value);
    let ok = true;
    if (name.length < 2) { showError($('#e-name'), 'Please enter your full name.'); fName.setAttribute('aria-invalid', 'true'); ok = false; }
    else { showError($('#e-name'), ''); fName.removeAttribute('aria-invalid'); }
    if (!phone) {
      showError($('#e-phone'), fPhone.value.trim() ? 'Please enter a valid Malaysian mobile number, for example 012-3456789.' : 'Please enter your phone number.');
      fPhone.setAttribute('aria-invalid', 'true'); ok = false;
    } else { showError($('#e-phone'), ''); fPhone.removeAttribute('aria-invalid'); }
    if (!state.citizen) { showError($('#e-citizen'), 'Please confirm that you are a Malaysian citizen to continue.'); ok = false; }
    if (!ok) { ($('[aria-invalid="true"]', e.target) || $('#f-citizen')).focus(); return; }
    state.name = name; state.phone = phone;
    fPhone.value = fmtPhone(phone);
    goTo(2);
  });

  // Step 2: route
  function renderRoutes() {
    const box = $('#route-options');
    box.replaceChildren();
    state.config.routes.forEach((r, i) => {
      const input = el('input', { type: 'radio', name: 'route', value: r.code, checked: state.route === r.code });
      input.addEventListener('change', () => {
        if (state.route !== r.code) state.time = null;
        state.route = r.code;
        setTimeout(() => goTo(3), 180);
      });
      box.append(el('label', { class: 'choice' }, input,
        el('span', { class: 'choice-body' },
          el('span', { class: 'choice-kicker', text: `Route 0${i + 1}` }),
          el('span', { class: 'choice-main' }, r.from, el('span', { class: 'arrow', 'aria-label': 'to', text: ' → ' }), r.to))));
    });
  }

  // Step 3: date
  function renderDates() {
    const box = $('#date-options');
    box.replaceChildren();
    for (const d of state.config.dates) {
      const input = el('input', { type: 'radio', name: 'date', value: d.date, checked: state.date === d.date, disabled: !d.open });
      input.addEventListener('change', () => {
        if (state.date !== d.date) state.time = null;
        state.date = d.date;
        setTimeout(() => goTo(4), 180);
      });
      box.append(el('label', { class: 'choice' }, input,
        el('span', { class: 'choice-body' },
          el('span', { class: 'choice-kicker', text: d.weekday }),
          el('span', { class: 'choice-main', text: d.label }),
          el('span', { class: 'choice-sub', text: d.open ? 'Open for booking' : 'Booking closed' }))));
    }
  }

  // Step 4: time
  const STATE_TEXT = { AVAILABLE: 'Available', BOOKED: 'Booked', CLOSED: 'Booking closed' };
  async function loadSlots({ quiet = false } = {}) {
    if (!state.route || !state.date) return goTo(!state.route ? 2 : 3);
    const r = route(state.route), d = dateInfo(state.date);
    $('#time-context').textContent = `${r.from} → ${r.to}, ${d.weekday} ${d.label}`;
    if (!quiet) { $('#slot-groups').setAttribute('aria-busy', 'true'); }
    try {
      const data = await api(`/api/availability?date=${encodeURIComponent(state.date)}&route=${encodeURIComponent(state.route)}`);
      if (state.step !== 4) return;
      state.slots = data;
      if (state.time) {
        const cur = [...data.morning, ...data.evening].find((s) => s.time === state.time);
        if (!cur || cur.status !== 'AVAILABLE') {
          state.time = null;
          showError($('#slot-msg'), cur?.status === 'CLOSED'
            ? 'Booking is closed for this time slot.\nBookings close 1 hour before pickup.'
            : 'This slot is no longer available.\nPlease select another time.');
        }
      }
      renderSlots();
    } catch (err) {
      if (!quiet) showError($('#slot-msg'), err.message);
    } finally {
      $('#slot-groups').removeAttribute('aria-busy');
    }
  }
  function renderSlots() {
    const box = $('#slot-groups');
    box.replaceChildren();
    const groups = [['Morning', state.slots.morning], ['Evening', state.slots.evening]];
    let available = 0;
    for (const [title, list] of groups) {
      if (!list.length) continue;
      const grid = el('div', { class: 'slots' });
      for (const s of list) {
        if (s.status === 'AVAILABLE') available++;
        const btn = el('button', {
          type: 'button',
          class: `slot${s.status === 'BOOKED' ? ' is-booked' : ''}`,
          disabled: s.status !== 'AVAILABLE',
          'aria-pressed': s.status === 'AVAILABLE' ? String(state.time === s.time) : false,
          'aria-label': `${s.label}, ${STATE_TEXT[s.status]}`,
        }, el('span', { class: 'slot-time', text: s.label }), el('span', { class: 'slot-state', text: STATE_TEXT[s.status] }));
        btn.addEventListener('click', () => {
          state.time = s.time;
          showError($('#slot-msg'), '');
          $$('.slot[aria-pressed]', box).forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
          $('#time-next').disabled = false;
          setTimeout(() => { if (state.step === 4 && state.time === s.time) { state.requestKey = uuid(); goTo(5); } }, 260);
        });
        grid.append(btn);
      }
      box.append(el('section', { class: 'slot-group' }, el('h4', { text: title }), grid));
    }
    $('#slot-empty').hidden = available > 0;
    $('#time-next').disabled = !state.time;
  }
  function startPolling() { stopPolling(); state.pollTimer = setInterval(() => { if (!document.hidden) loadSlots({ quiet: true }); }, 20000); }
  function stopPolling() { clearInterval(state.pollTimer); state.pollTimer = null; }
  $('#time-next').addEventListener('click', () => { if (state.time) { state.requestKey = uuid(); goTo(5); } });

  // Step 5: review + confirm
  function renderReview() {
    const r = route(state.route), d = dateInfo(state.date);
    fillReview($('#review'), [
      ['Passenger', state.name], ['Phone', fmtPhone(state.phone)], ['Route', `${r.from} → ${r.to}`],
      ['Date', `${d.weekday}, ${d.label}`], ['Pickup', timeLabel(state.time)], ['Fare', `RM${state.config.fare}`],
      ['Payment', 'After reaching destination'],
    ]);
    showError($('#review-error'), '');
  }
  const confirmBtn = $('#confirm-btn');
  confirmBtn.addEventListener('click', async () => {
    if (state.submitting) return;
    if (!state.citizen) { showError($('#review-error'), 'Please confirm that you are a Malaysian citizen.'); $('#f-citizen-2').focus(); return; }
    state.submitting = true; confirmBtn.disabled = true; confirmBtn.textContent = 'Confirming…';
    try {
      const { booking } = await api('/api/bookings', {
        name: state.name, phone: state.phone, date: state.date, route: state.route, time: state.time,
        citizen: true, requestKey: state.requestKey,
      });
      showConfirmation(booking);
    } catch (err) {
      if (err.code === 'SLOT_TAKEN' || err.code === 'BOOKING_CLOSED') {
        state.time = null;
        goTo(4);
        showError($('#slot-msg'), err.code === 'SLOT_TAKEN'
          ? 'Sorry, this slot has just been booked by another customer.\nPlease select another available time.'
          : 'Booking is closed for this time slot.\nBookings close 1 hour before pickup.');
      } else if (err.code === 'INVALID_PHONE' || err.code === 'INVALID_NAME') {
        goTo(1); showError($(err.code === 'INVALID_PHONE' ? '#e-phone' : '#e-name'), err.message);
      } else {
        showError($('#review-error'), err.message);
      }
    } finally {
      state.submitting = false; confirmBtn.disabled = false; confirmBtn.textContent = 'Confirm booking';
    }
  });

  // Confirmation
  let lastBooking = null;
  function showConfirmation(b) {
    lastBooking = b;
    try { localStorage.setItem('bfms_last', JSON.stringify({ bookingId: b.bookingId, phone: b.phone })); } catch { /* private mode */ }
    wizard.hidden = true;
    const c = $('#confirmed');
    $('#c-id').textContent = b.bookingId;
    fillReview($('#c-details'), [
      ['Passenger', b.passengerName], ['Phone', b.phone], ['Date', `${b.weekday}, ${b.dateLabel}`],
      ['Route', `${b.from} → ${b.to}`], ['Pickup time', b.timeLabel], ['Fare', `RM${b.fare}`],
      ['Payment', 'Pay after reaching destination'],
    ]);
    $('#c-pickup-note').textContent = b.pickupNote ? `Pickup point: ${b.pickupNote}` : 'Exact pickup point instructions will be provided separately.';
    const ret = state.config.routes.find((r) => r.code !== b.route);
    $('#return-btn').textContent = `Book the return trip (${ret.from} → ${ret.to})`;
    c.hidden = false;
    $('#book-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
    c.focus({ preventScroll: true });
    prefillCancel();
  }
  $('#copy-id').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#c-id').textContent); $('#copy-id').textContent = 'Copied'; }
    catch { $('#copy-id').textContent = 'Press and hold the ID to copy'; }
    setTimeout(() => { $('#copy-id').textContent = 'Copy ID'; }, 2000);
  });
  function resetWizard({ keepPerson = false, routeCode = null, date = null } = {}) {
    $('#confirmed').hidden = true; wizard.hidden = false;
    state.route = routeCode; state.date = date; state.time = null; state.requestKey = null; state.slots = null;
    if (!keepPerson) {
      state.name = ''; state.phone = ''; state.citizen = false;
      fName.value = ''; fPhone.value = ''; citizenBoxes.forEach((c) => { c.checked = false; });
    }
    renderRoutes(); renderDates();
  }
  $('#done-btn').addEventListener('click', () => { resetWizard(); goTo(1, { focus: false }); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  $('#return-btn').addEventListener('click', () => {
    const b = lastBooking;
    const ret = state.config.routes.find((r) => r.code !== b.route);
    resetWizard({ keepPerson: true, routeCode: ret.code, date: b.date });
    state.citizen = true; citizenBoxes.forEach((c) => { c.checked = true; });
    goTo(4);
  });

  // ---------- cancellation ----------
  const cancel = { bookingId: null, phone: null };
  function prefillCancel() {
    try {
      const last = JSON.parse(localStorage.getItem('bfms_last') || 'null');
      if (last && !$('#x-id').value) { $('#x-id').value = last.bookingId; $('#x-phone').value = last.phone; }
    } catch { /* ignore */ }
  }
  $('#cancel-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#x-id').value.trim(), phone = $('#x-phone').value.trim();
    if (!id || !phone) return showError($('#cancel-error'), 'Please complete all required fields.');
    const btn = $('button[type=submit]', e.target);
    btn.disabled = true;
    try {
      const { booking } = await api('/api/bookings/find', { bookingId: id, phone });
      showError($('#cancel-error'), '');
      if (booking.status === 'CANCELLED') {
        return showCancelDone(`${booking.bookingId} was already cancelled.`);
      }
      cancel.bookingId = booking.bookingId; cancel.phone = phone;
      fillReview($('#cancel-details'), [
        ['Booking ID', booking.bookingId], ['Passenger', booking.passengerName], ['Date', `${booking.weekday}, ${booking.dateLabel}`],
        ['Route', `${booking.from} → ${booking.to}`], ['Pickup', booking.timeLabel],
      ]);
      $('#cancel-form').hidden = true; $('#cancel-confirm').hidden = false;
      $('#cancel-yes').focus();
    } catch (err) {
      showError($('#cancel-error'), err.code === 'NOT_FOUND'
        ? "We couldn't find a matching booking.\nPlease check your Booking ID and phone number." : err.message);
    } finally { btn.disabled = false; }
  });
  $('#cancel-keep').addEventListener('click', () => { $('#cancel-confirm').hidden = true; $('#cancel-form').hidden = false; });
  $('#cancel-yes').addEventListener('click', async () => {
    const btn = $('#cancel-yes'); btn.disabled = true;
    try {
      const { booking } = await api('/api/bookings/cancel', { bookingId: cancel.bookingId, phone: cancel.phone });
      try { localStorage.removeItem('bfms_last'); } catch { /* ignore */ }
      showCancelDone(`${booking.bookingId} has been cancelled and the slot is released. No charge applies.`);
      if (state.step === 4) loadSlots({ quiet: true });
    } catch (err) {
      showError($('#cancel-error-2'), err.message);
    } finally { btn.disabled = false; }
  });
  function showCancelDone(text) {
    $('#cancel-form').hidden = true; $('#cancel-confirm').hidden = true;
    $('#cancel-done-text').textContent = text; $('#cancel-done').hidden = false; $('#cancel-done').focus();
  }
  $('#cancel-reset').addEventListener('click', () => {
    $('#cancel-done').hidden = true; $('#cancel-form').hidden = false;
    $('#x-id').value = ''; $('#x-phone').value = '';
  });

  // ---------- quick answers ----------
  const FAQ = [
    ['How much is the shuttle?', 'The shuttle fare is RM30 per person per trip.'],
    ['Is helmet provided?', 'Yes. A helmet is provided for the passenger.'],
    ['Do you provide raincoats?', 'Yes. A raincoat will be provided if it rains.'],
    ['Can foreigners book?', 'Sorry, this shuttle service is exclusively available for Malaysian citizens.'],
    ['How many people can ride?', 'Each booking is for 1 passenger and 1 motorcycle trip.'],
    ['Where can I take the shuttle?', 'The service operates between Petronas SIC and Mitsui Outlet Park.'],
    ['When do I pay?', 'Payment is made after reaching the drop-off point. Cash, online transfer or QR payment are accepted.'],
    ['Can I cancel my booking?', 'Yes. You can cancel your booking using your Booking ID and the phone number used during booking.'],
    ['I have another question', 'No problem. Please contact our team directly on WhatsApp and we will assist you.'],
  ];
  const fab = $('#fab'), panel = $('#assistant'), log = $('#assistant-log');
  for (const [q, a] of FAQ) {
    $('#assistant-qs').append(el('button', {
      type: 'button', text: q,
      onclick: () => {
        log.append(el('p', { class: 'bubble bubble-me', text: q }), el('p', { class: 'bubble bubble-them', text: a }));
        log.scrollTop = log.scrollHeight;
      },
    }));
  }
  function setAssistant(open) {
    panel.hidden = !open; fab.setAttribute('aria-expanded', String(open)); fab.hidden = open;
    if (open) $('#assistant-close').focus(); else fab.focus();
  }
  fab.addEventListener('click', () => setAssistant(true));
  $('#assistant-close').addEventListener('click', () => setAssistant(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) setAssistant(false); });

  // ---------- sticky CTA ----------
  const sticky = $('#sticky-cta');
  if ('IntersectionObserver' in window) {
    const seen = new Map();
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) seen.set(en.target.id, en.isIntersecting);
      const show = !seen.get('hero-book') && !seen.get('book');
      sticky.classList.toggle('show', show);
    }, { threshold: 0 });
    io.observe($('#hero-book')); io.observe($('#book'));
  }

  // ---------- boot ----------
  async function boot() {
    prefillCancel();
    try {
      state.config = await api('/api/config');
    } catch (err) {
      const box = $('.step[data-step="1"]');
      box.prepend(el('p', { class: 'form-error', role: 'alert', text: `Booking is temporarily unavailable. ${err.message} You can also WhatsApp us.` }));
      return;
    }
    $$('.js-wa').forEach((a) => { a.href = waLink('Hi, I have a question about the Bahrain F1 Motorcycle Shuttle.'); });
    for (const r of state.config.routes) {
      const n = $(`[data-route-note="${r.code}"]`);
      if (n) n.textContent = r.pickupNote ? `Pickup point: ${r.pickupNote}` : 'Exact pickup point instructions will be provided separately.';
    }
    renderRoutes(); renderDates();
    goTo(1, { focus: false });
  }
  boot();
})();
