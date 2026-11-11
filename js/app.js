/* global Globe */

const TEAM_URL = 'data/team.json';
const COUNTRIES_URL = 'vendor/countries.geojson';

// Continental US, slightly pulled back so Canada and Mexico frame it.
const HOME = { lat: 38, lng: -97 };
const FOCUS_ALTITUDE = 0.75;

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const isNarrow = () => innerWidth <= 760;
const homeView = () => ({ ...HOME, altitude: isNarrow() ? 2.7 : 1.75 });
const ms = (n) => (reducedMotion ? 0 : n);

const $ = (sel) => document.querySelector(sel);

/** Tiny DOM builder. Strings become text nodes, so team data is never parsed as HTML. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style') el.style.cssText = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child);
  }
  return el;
}

function hue(text) {
  let n = 0;
  for (const ch of text) n = (n * 31 + ch.codePointAt(0)) >>> 0;
  return 165 + (n % 120); // cyan through violet
}

function initials(name) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts.at(-1)[0] : '')).toUpperCase();
}

function safeUrl(url) {
  try {
    const parsed = new URL(url);
    return ['https:', 'http:', 'mailto:'].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function avatar(member, large = false) {
  const img = member.avatar && safeUrl(new URL(member.avatar, location.href).href);
  return h(
    'span',
    {
      class: `avatar${large ? ' lg' : ''}`,
      style: `--hue:${hue(member.name)}${img ? `;background-image:url("${encodeURI(img)}")` : ''}`,
      'aria-hidden': 'true',
    },
    img ? null : initials(member.name),
  );
}

function localTime(timezone) {
  try {
    return new Intl.DateTimeFormat([], {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: timezone,
    }).format(new Date());
  } catch {
    return 'Unknown';
  }
}

function coords({ lat, lng }) {
  const fmt = (v, pos, neg) => `${Math.abs(v).toFixed(2)}° ${v >= 0 ? pos : neg}`;
  return `${fmt(lat, 'N', 'S')}, ${fmt(lng, 'E', 'W')}`;
}

const place = (m) => [m.city, m.region].filter(Boolean).join(', ');

/* ---------- data ---------- */

function buildLocations(members) {
  const byKey = new Map();
  for (const member of members) {
    const key = `${member.lat.toFixed(1)},${member.lng.toFixed(1)}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        lat: member.lat,
        lng: member.lng,
        city: member.city,
        region: member.region,
        country: member.country,
        members: [],
      });
    }
    byKey.get(key).members.push(member);
    member.locationKey = key;
  }
  return byKey;
}

/* ---------- starfield ---------- */

function drawStars() {
  const canvas = $('#stars');
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  const ctx = canvas.getContext('2d');
  // Deterministic so a resize doesn't reshuffle the sky.
  let seed = 1337;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const count = Math.round((innerWidth * innerHeight) / 5200);
  for (let i = 0; i < count; i++) {
    const r = rand() ** 3 * 1.3 * dpr + 0.3;
    ctx.fillStyle = `rgba(${200 + rand() * 55}, ${220 + rand() * 35}, 255, ${0.15 + rand() * 0.6})`;
    ctx.beginPath();
    ctx.arc(rand() * canvas.width, rand() * canvas.height, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/* ---------- app ---------- */

async function main() {
  const [data, countries] = await Promise.all(
    [TEAM_URL, COUNTRIES_URL].map(async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return res.json();
    }),
  );

  const members = data.members
    .filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lng))
    .sort((a, b) => a.name.localeCompare(b.name));
  const membersById = new Map(members.map((m) => [m.id, m]));
  const locations = buildLocations(members);
  const locationList = [...locations.values()];

  const state = { memberId: null, locationKey: null, query: '' };

  /* --- header --- */

  if (data.team?.name) {
    $('#team-name').textContent = data.team.name;
    document.title = data.team.name;
  }
  if (data.team?.tagline) $('#team-tagline').textContent = data.team.tagline;

  const stat = (label, value) => h('div', {}, h('dd', {}, String(value)), h('dt', {}, label));
  $('#stats').append(
    stat('People', members.length),
    stat('Cities', locationList.length),
    stat('Countries', new Set(members.map((m) => m.country)).size),
    stat('Time zones', new Set(members.map((m) => m.timezone)).size),
  );

  /* --- pins --- */

  for (const loc of locationList) {
    const count = loc.members.length;
    const label = count > 1 ? `${loc.city}, ${count} people` : `${loc.members[0].name}, ${loc.city}`;
    loc.el = h(
      'div',
      { class: `pin${count > 1 ? ' multi' : ''}` },
      h(
        'button',
        {
          class: 'pin-dot',
          'aria-label': label,
          onclick: (e) => {
            e.stopPropagation();
            if (count === 1) selectMember(loc.members[0].id);
            else selectLocation(loc.key);
          },
        },
        count > 1 ? String(count) : null,
      ),
      h('span', { class: 'pin-label mono' }, count > 1 ? loc.city : loc.members[0].name),
    );
    loc.el.style.pointerEvents = 'auto';
  }

  /* --- globe --- */

  const hub = locationList.reduce((a, b) => (b.members.length > a.members.length ? b : a));
  const arcs = locationList
    .filter((loc) => loc !== hub)
    .map((loc) => ({ startLat: hub.lat, startLng: hub.lng, endLat: loc.lat, endLng: loc.lng }));

  const globe = new Globe($('#globe'), { animateIn: !reducedMotion })
    .backgroundColor('rgba(0,0,0,0)')
    .showAtmosphere(true)
    .atmosphereColor('#3fd9ff')
    .atmosphereAltitude(0.2)
    // land as a dot matrix
    .hexPolygonsData(countries.features)
    .hexPolygonResolution(3)
    .hexPolygonMargin(0.55)
    .hexPolygonUseDots(true)
    .hexPolygonAltitude(0.004)
    .hexPolygonColor(() => 'rgba(88, 196, 255, 0.62)')
    // pulses under each pin
    .ringsData(locationList)
    .ringColor(() => (t) => `rgba(77, 232, 255, ${(1 - t) * 0.8})`)
    .ringMaxRadius((d) => 2.2 + Math.min(d.members.length, 4) * 0.5)
    .ringPropagationSpeed(1.4)
    .ringRepeatPeriod(reducedMotion ? 0 : 1600)
    .ringAltitude(0.006)
    // links from the largest hub
    .arcsData(arcs)
    .arcColor(() => ['rgba(77, 232, 255, 0.75)', 'rgba(139, 123, 255, 0.75)'])
    .arcStroke(0.28)
    .arcAltitudeAutoScale(0.32)
    .arcDashLength(0.45)
    .arcDashGap(0.25)
    .arcDashAnimateTime(reducedMotion ? 0 : 4200)
    // clickable pins
    .htmlElementsData(locationList)
    .htmlElement((d) => d.el)
    .htmlAltitude(0.012)
    .htmlElementVisibilityModifier((el, visible) => {
      el.style.opacity = visible ? '1' : '0';
      el.style.pointerEvents = visible ? 'auto' : 'none';
    })
    .onGlobeClick(() => clearSelection())
    .pointOfView(homeView(), 0);

  const material = globe.globeMaterial();
  material.color.set('#050b1d');
  material.emissive.set('#071a3a');
  material.emissiveIntensity = 0.55;
  material.shininess = 6;

  const controls = globe.controls();
  controls.enableDamping = true;
  controls.minDistance = 130;
  controls.maxDistance = 520;

  const fit = () => {
    globe.width(innerWidth).height(innerHeight);
    drawStars();
  };
  addEventListener('resize', fit);
  fit();

  /* --- roster --- */

  const rosterList = $('#roster-list');
  const rosterItems = new Map();

  function personButton(member, sub) {
    return h(
      'button',
      {
        class: 'person',
        onclick: () => selectMember(member.id),
        onmouseenter: () => locations.get(member.locationKey).el.classList.add('hover'),
        onmouseleave: () => locations.get(member.locationKey).el.classList.remove('hover'),
      },
      avatar(member),
      h(
        'span',
        { class: 'person-text' },
        h('div', { class: 'person-name' }, member.name),
        h('div', { class: 'person-sub' }, sub),
      ),
    );
  }

  for (const member of members) {
    const item = h('li', {}, personButton(member, `${member.role} · ${member.city}`));
    rosterItems.set(member.id, item);
    rosterList.append(item);
  }

  function applyFilter() {
    const q = state.query.trim().toLowerCase();
    let shown = 0;
    for (const member of members) {
      const haystack = [member.name, member.role, member.team, member.city, member.region, member.country]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      const match = !q || q.split(/\s+/).every((term) => haystack.includes(term));
      rosterItems.get(member.id).hidden = !match;
      if (match) shown++;
    }
    $('#roster-empty').hidden = shown > 0;
  }

  /* --- detail panel --- */

  const detail = $('#detail');
  const closeButton = () =>
    h('button', { class: 'close', 'aria-label': 'Close', onclick: () => clearSelection() }, '×');

  function field(label, value, id) {
    return h('div', {}, h('dt', { class: 'mono' }, label), h('dd', { id }, value));
  }

  function renderMember(member) {
    const others = locations.get(member.locationKey).members.filter((m) => m !== member);
    const links = [
      member.email && ['Email', safeUrl(`mailto:${member.email}`)],
      ...Object.entries(member.links ?? {}).map(([name, url]) => [
        name === 'github' ? 'GitHub' : name === 'linkedin' ? 'LinkedIn' : name,
        safeUrl(url),
      ]),
    ].filter((link) => link && link[1]);

    return [
      closeButton(),
      h(
        'div',
        { class: 'profile-head' },
        avatar(member, true),
        h('div', {}, h('h2', {}, member.name), h('p', { class: 'profile-role' }, member.role)),
      ),
      member.team && h('span', { class: 'chip mono' }, member.team),
      h(
        'dl',
        { class: 'fields' },
        field('Location', [place(member), member.country].filter(Boolean).join(' · ')),
        field('Local time', localTime(member.timezone), 'local-time'),
        field('Coordinates', coords(member)),
        field('Time zone', member.timezone ?? 'Unknown'),
      ),
      member.bio && h('p', { class: 'bio' }, member.bio),
      links.length > 0 &&
        h(
          'div',
          { class: 'links' },
          links.map(([name, url]) =>
            h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, name),
          ),
        ),
      others.length > 0 && h('h3', { class: 'section-label mono' }, `Also in ${member.city}`),
      others.length > 0 &&
        h('ul', { class: 'detail-list' }, others.map((m) => h('li', {}, personButton(m, m.role)))),
    ];
  }

  function renderLocation(loc) {
    return [
      closeButton(),
      h(
        'div',
        { class: 'loc-head' },
        h('h2', {}, place(loc)),
        h('p', { class: 'mono' }, `${loc.country} · ${loc.members.length} people`),
      ),
      h('h3', { class: 'section-label mono' }, 'Based here'),
      h('ul', { class: 'detail-list' }, loc.members.map((m) => h('li', {}, personButton(m, m.role)))),
    ];
  }

  function render() {
    const member = membersById.get(state.memberId);
    const loc = locations.get(member ? member.locationKey : state.locationKey);

    for (const [id, item] of rosterItems) {
      item.firstChild.classList.toggle('active', id === state.memberId);
    }
    for (const l of locationList) l.el.classList.toggle('active', l === loc);

    detail.hidden = !loc;
    document.body.classList.toggle('has-detail', Boolean(loc));
    if (!loc) return;
    detail.replaceChildren(...(member ? renderMember(member) : renderLocation(loc)).filter(Boolean));
    detail.scrollTop = 0;
    // restart the entrance animation
    detail.style.animation = 'none';
    void detail.offsetWidth;
    detail.style.animation = '';
  }

  function closeRoster() {
    $('#roster').classList.remove('open');
    $('#roster-toggle').setAttribute('aria-expanded', 'false');
  }

  function flyTo(loc) {
    // On phones the profile sheet covers the lower part of the screen, so aim a little south.
    const lat = isNarrow() ? loc.lat - 14 : loc.lat;
    globe.pointOfView({ lat, lng: loc.lng, altitude: isNarrow() ? 1.4 : FOCUS_ALTITUDE }, ms(1300));
  }

  function setHash(value) {
    const url = value ? `#${value}` : location.pathname + location.search;
    history.replaceState(null, '', url);
  }

  function selectMember(id, { fly = true } = {}) {
    const member = membersById.get(id);
    if (!member) return;
    state.memberId = id;
    state.locationKey = member.locationKey;
    setHash(id);
    closeRoster();
    render();
    rosterItems.get(id).scrollIntoView({ block: 'nearest' });
    if (fly) flyTo(locations.get(member.locationKey));
  }

  function selectLocation(key) {
    const loc = locations.get(key);
    if (!loc) return;
    state.memberId = null;
    state.locationKey = key;
    setHash('');
    closeRoster();
    render();
    flyTo(loc);
  }

  function clearSelection() {
    if (!state.memberId && !state.locationKey) return;
    state.memberId = null;
    state.locationKey = null;
    setHash('');
    render();
  }

  /* --- wiring --- */

  const search = $('#search');
  search.addEventListener('input', () => {
    state.query = search.value;
    applyFilter();
  });

  $('#recenter').addEventListener('click', () => {
    clearSelection();
    globe.pointOfView(homeView(), ms(1200));
  });

  $('#roster-toggle').addEventListener('click', (e) => {
    const open = $('#roster').classList.toggle('open');
    e.currentTarget.setAttribute('aria-expanded', String(open));
  });

  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (document.activeElement === search && search.value) {
        search.value = state.query = '';
        applyFilter();
      } else {
        clearSelection();
        closeRoster();
      }
    } else if (e.key === '/' && document.activeElement !== search) {
      e.preventDefault();
      $('#roster').classList.add('open');
      search.focus();
    }
  });

  addEventListener('hashchange', () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (membersById.has(id)) selectMember(id);
  });

  const tick = () => {
    $('#utc').textContent = `UTC ${new Date().toISOString().slice(11, 16)}`;
    const member = membersById.get(state.memberId);
    const timeEl = document.getElementById('local-time');
    if (member && timeEl) timeEl.textContent = localTime(member.timezone);
  };
  tick();
  setInterval(tick, 15_000);

  // Deep link: /#maya-chen opens that profile.
  const initial = decodeURIComponent(location.hash.slice(1));
  if (membersById.has(initial)) selectMember(initial);

  $('#loader').classList.add('done');
}

main().catch((err) => {
  console.error(err);
  const loader = $('#loader');
  loader.classList.add('error');
  loader.firstElementChild.textContent = `Could not load the team map: ${err.message}`;
});
