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

  // `places` holds the city keys of an open group panel (a pin with several people).
  const state = { memberId: null, places: null, query: '', showPhotos: false };
  let lastSelectAt = 0;

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

  /* --- pins: nearby cities share one pin until the camera is close enough to tell them apart --- */

  const PIN_GAP_PX = 26; // closer than this on screen and two cities merge
  const MIN_ALTITUDE = 0.1;
  const toRad = Math.PI / 180;

  /** Great-circle distance in degrees. */
  function arcDeg(a, b) {
    const dLat = (b.lat - a.lat) * toRad;
    const dLng = (b.lng - a.lng) * toRad;
    const x =
      Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
    return (2 * Math.asin(Math.min(1, Math.sqrt(x)))) / toRad;
  }

  /** Degrees of arc that PIN_GAP_PX spans at the centre of the view, per unit of camera altitude. */
  function mergeDegPerAltitude() {
    const focalPx = innerHeight / 2 / Math.tan((globe.camera().fov / 2) * toRad);
    return PIN_GAP_PX / focalPx / toRad;
  }

  const placesBySize = [...locationList].sort(
    (a, b) => b.members.length - a.members.length || a.city.localeCompare(b.city) || a.key.localeCompare(b.key),
  );
  const clusterCache = new Map();
  const clusterOfPlace = new Map();
  let clusters = [];
  let clusterSignature = null;

  function makeCluster(key, places) {
    const clusterMembers = places.flatMap((p) => p.members);
    const count = clusterMembers.length;
    const [main] = places;
    const cities = places.map((p) => p.city);
    const label =
      count === 1 ? clusterMembers[0].name : places.length === 1 ? main.city : `${main.city} +${places.length - 1}`;
    const spoken =
      count === 1
        ? `${clusterMembers[0].name}, ${main.city}`
        : `${cities.join(' and ')}, ${count} people`;

    const el = h(
      'div',
      { class: `pin${count > 1 ? ' multi' : ''}` },
      h(
        'button',
        {
          class: 'pin-dot',
          'aria-label': spoken,
          onclick: () => {
            if (count === 1) selectMember(clusterMembers[0].id);
            else selectGroup(places.map((p) => p.key));
          },
        },
        count > 1 ? String(count) : null,
      ),
      h('span', { class: 'pin-label mono' }, label),
    );
    el.style.pointerEvents = 'auto';
    // The globe listens for pointer events on the shared container and would treat a press on a
    // pin as a click on the globe underneath it, which clears the selection a frame later.
    for (const type of ['pointerdown', 'pointerup', 'click']) {
      el.addEventListener(type, (e) => e.stopPropagation());
    }

    return {
      key,
      places,
      members: clusterMembers,
      lat: places.reduce((sum, p) => sum + p.lat * p.members.length, 0) / count,
      lng: places.reduce((sum, p) => sum + p.lng * p.members.length, 0) / count,
      el,
    };
  }

  function markPins() {
    const member = membersById.get(state.memberId);
    const active = new Set(member ? [member.locationKey] : (state.places ?? []));
    for (const cluster of clusters) {
      cluster.el.classList.toggle('active', cluster.places.some((p) => active.has(p.key)));
    }
  }

  /** Regroup cities for the given camera altitude; touches the globe only when the grouping changes. */
  function recluster(altitude) {
    const limit = altitude * mergeDegPerAltitude();
    const groups = [];
    for (const place of placesBySize) {
      const home = groups.find((group) => arcDeg(group[0], place) < limit);
      if (home) home.push(place);
      else groups.push([place]);
    }
    const signature = groups.map((g) => g.map((p) => p.key).join('|')).join(';');
    if (signature === clusterSignature) return;
    clusterSignature = signature;

    clusters = groups.map((group) => {
      const key = group.map((p) => p.key).join('|');
      if (!clusterCache.has(key)) clusterCache.set(key, makeCluster(key, group));
      return clusterCache.get(key);
    });
    clusterOfPlace.clear();
    for (const cluster of clusters) {
      cluster.el.classList.remove('hover');
      for (const place of cluster.places) clusterOfPlace.set(place.key, cluster);
    }
    globe.htmlElementsData(clusters).ringsData(clusters);
    markPins();
  }

  /** How close the camera must be for every one of these cities to get its own pin. */
  function altitudeToSeparate(places, others = locationList) {
    let nearest = Infinity;
    for (const place of places) {
      for (const other of others) {
        if (other !== place) nearest = Math.min(nearest, arcDeg(place, other));
      }
    }
    const cap = isNarrow() ? 1.4 : FOCUS_ALTITUDE;
    return Math.max(MIN_ALTITUDE, Math.min(cap, (nearest / mergeDegPerAltitude()) * 0.8));
  }

  /* --- globe --- */

  const hub = locationList.reduce((a, b) => (b.members.length > a.members.length ? b : a));
  const arcs = locationList
    .filter((loc) => loc !== hub)
    .map((loc) => ({ startLat: hub.lat, startLng: hub.lng, endLat: loc.lat, endLng: loc.lng }));

  const globe = new Globe($('#globe'), {
    // The library's intro animation scales the scene up from zero, and pin visibility is worked out
    // against that shrunken scene and not refreshed until the camera moves, hiding off-centre pins.
    animateIn: false,
  })
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
    .htmlElement((d) => d.el)
    .htmlAltitude(0.012)
    .htmlElementVisibilityModifier((el, visible) => {
      el.style.opacity = visible ? '1' : '0';
      el.style.pointerEvents = visible ? 'auto' : 'none';
    })
    .onGlobeClick(() => {
      // Ignore a globe click that lands right after a selection was made.
      if (performance.now() - lastSelectAt > 400) clearSelection();
    })
    .pointOfView(homeView(), 0);

  recluster(homeView().altitude);
  globe.onZoom(({ altitude }) => recluster(altitude));

  // Re-apply the view once the first frame is drawn so pin visibility is recalculated. Skipped when
  // a profile link is already flying the camera somewhere, which recalculates it anyway.
  requestAnimationFrame(() => {
    if (!state.memberId && !state.places) globe.pointOfView(homeView(), 0);
  });

  const material = globe.globeMaterial();
  material.color.set('#050b1d');
  material.emissive.set('#071a3a');
  material.emissiveIntensity = 0.55;
  material.shininess = 6;

  const controls = globe.controls();
  controls.enableDamping = true;
  controls.minDistance = globe.getGlobeRadius() * (1 + MIN_ALTITUDE * 0.8);
  controls.maxDistance = 520;

  const fit = () => {
    globe.width(innerWidth).height(innerHeight);
    recluster(globe.pointOfView().altitude);
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
        onmouseenter: () => clusterOfPlace.get(member.locationKey)?.el.classList.add('hover'),
        onmouseleave: () => clusterOfPlace.get(member.locationKey)?.el.classList.remove('hover'),
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
    const item = h('li', {}, personButton(member, [member.role, place(member)].filter(Boolean).join(' · ')));
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

  /** Up to four extra photos, shown on the back of the profile card. */
  function photosOf(member) {
    return (member.photos ?? [])
      .map((src) => {
        try {
          return safeUrl(new URL(src, location.href).href);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .slice(0, 4);
  }

  const flipButton = (label) =>
    h('button', { class: 'flip-btn', onclick: () => flip() }, h('span', { 'aria-hidden': 'true' }, '⟲'), label);

  function renderPhotos(member, photos) {
    return [
      closeButton(),
      h(
        'div',
        { class: 'profile-head' },
        avatar(member),
        h('div', {}, h('h2', {}, member.name), h('p', { class: 'mono' }, 'Photos')),
      ),
      h(
        'div',
        { class: `photos n${photos.length}` },
        photos.map((src, i) =>
          h(
            'button',
            {
              class: 'photo',
              'aria-label': `Enlarge photo ${i + 1} of ${photos.length}`,
              onclick: (e) => openLightbox(photos, i, member.name, e.currentTarget),
            },
            h('img', { src, alt: `${member.name}, photo ${i + 1}`, loading: 'lazy' }),
          ),
        ),
      ),
      flipButton('Back to profile'),
    ];
  }

  function renderMember(member) {
    const photos = photosOf(member);
    if (state.showPhotos && photos.length > 0) return renderPhotos(member, photos);

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
        h('div', {}, h('h2', {}, member.name), member.role && h('p', { class: 'profile-role' }, member.role)),
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
      photos.length > 0 && flipButton(photos.length === 1 ? 'View photo' : `View ${photos.length} photos`),
      others.length > 0 && h('h3', { class: 'section-label mono' }, `Also in ${member.city}`),
      others.length > 0 &&
        h('ul', { class: 'detail-list' }, others.map((m) => h('li', {}, personButton(m, m.role ?? place(m))))),
    ];
  }

  function renderGroup(places) {
    const single = places.length === 1;
    const people = places.flatMap((p) => p.members).sort((a, b) => a.name.localeCompare(b.name));
    const title = single
      ? place(places[0])
      : places.length === 2
        ? places.map((p) => p.city).join(' + ')
        : `${places.length} nearby cities`;
    return [
      closeButton(),
      h(
        'div',
        { class: 'loc-head' },
        h('h2', {}, title),
        h('p', { class: 'mono' }, [single && places[0].country, `${people.length} people`].filter(Boolean).join(' · ')),
      ),
      h('h3', { class: 'section-label mono' }, 'Based here'),
      h(
        'ul',
        { class: 'detail-list' },
        people.map((m) =>
          h('li', {}, personButton(m, single ? (m.role ?? place(m)) : [m.role, m.city].filter(Boolean).join(' · '))),
        ),
      ),
    ];
  }

  const selectedPlaces = () => (state.places ?? []).map((key) => locations.get(key)).filter(Boolean);

  function fillDetail() {
    const member = membersById.get(state.memberId);
    const places = selectedPlaces();
    if (!member && places.length === 0) return;
    detail.replaceChildren(...(member ? renderMember(member) : renderGroup(places)).filter(Boolean));
    detail.scrollTop = 0;
  }

  /* --- photo lightbox --- */

  const lightbox = { photos: [], index: 0, name: '', opener: null };
  const lightboxImg = h('img', { alt: '' });
  const lightboxCount = h('span', { class: 'mono' });
  const lightboxPrev = h('button', { class: 'lb-nav prev', 'aria-label': 'Previous photo', onclick: () => stepLightbox(-1) }, '‹');
  const lightboxNext = h('button', { class: 'lb-nav next', 'aria-label': 'Next photo', onclick: () => stepLightbox(1) }, '›');
  const lightboxClose = h('button', { class: 'lb-close', 'aria-label': 'Close photo', onclick: () => closeLightbox() }, '×');
  const lightboxEl = h(
    'div',
    {
      id: 'lightbox',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Photo viewer',
      hidden: true,
      // a click on the backdrop closes; clicks on the photo or buttons don't
      onclick: (e) => e.target === lightboxEl && closeLightbox(),
    },
    lightboxClose,
    lightboxPrev,
    h('figure', {}, lightboxImg, h('figcaption', {}, lightboxCount)),
    lightboxNext,
  );
  document.body.append(lightboxEl);

  const lightboxOpen = () => !lightboxEl.hidden;

  function showLightboxPhoto() {
    const { photos, index, name } = lightbox;
    lightboxImg.src = photos[index];
    lightboxImg.alt = `${name}, photo ${index + 1}`;
    lightboxCount.textContent = `${name} · ${index + 1} / ${photos.length}`;
    lightboxPrev.hidden = lightboxNext.hidden = photos.length < 2;
  }

  function openLightbox(photos, index, name, opener) {
    Object.assign(lightbox, { photos, index, name, opener });
    showLightboxPhoto();
    lightboxEl.hidden = false;
    lightboxClose.focus();
  }

  function stepLightbox(delta) {
    const count = lightbox.photos.length;
    lightbox.index = (lightbox.index + delta + count) % count;
    showLightboxPhoto();
  }

  function closeLightbox() {
    if (!lightboxOpen()) return;
    lightboxEl.hidden = true;
    lightboxImg.removeAttribute('src');
    if (lightbox.opener?.isConnected) lightbox.opener.focus({ preventScroll: true });
  }

  /** Turn the card edge-on, swap profile and photos while it can't be seen, then turn it back. */
  let flipping = false;
  async function flip() {
    if (flipping) return;
    flipping = true;
    const turn = (from, to, easing, fill = 'none') =>
      detail.animate(
        [from, to].map((deg) => ({ transform: `perspective(1400px) rotateY(${deg}deg)` })),
        { duration: 230, easing, fill },
      );
    try {
      const out = reducedMotion ? null : turn(0, 90, 'ease-in', 'forwards');
      await out?.finished;
      state.showPhotos = !state.showPhotos;
      fillDetail();
      if (out) {
        const back = turn(-90, 0, 'ease-out');
        out.cancel();
        await back.finished;
      }
      detail.querySelector('.flip-btn')?.focus({ preventScroll: true });
    } catch {
      // An interrupted animation rejects; the card is already showing the right side.
    } finally {
      flipping = false;
    }
  }

  function render() {
    state.showPhotos = false;
    const open = membersById.has(state.memberId) || selectedPlaces().length > 0;

    for (const [id, item] of rosterItems) {
      item.firstChild.classList.toggle('active', id === state.memberId);
    }
    markPins();

    detail.hidden = !open;
    document.body.classList.toggle('has-detail', open);
    if (!open) return;
    fillDetail();
    // restart the entrance animation
    detail.style.animation = 'none';
    void detail.offsetWidth;
    detail.style.animation = '';
  }

  function closeRoster() {
    $('#roster').classList.remove('open');
    $('#roster-toggle').setAttribute('aria-expanded', 'false');
  }

  function flyTo({ lat, lng }, altitude) {
    // On phones the profile sheet covers the lower part of the screen, so aim a little south.
    const aimLat = isNarrow() ? lat - 10 * altitude : lat;
    globe.pointOfView({ lat: aimLat, lng, altitude }, ms(1300));
  }

  function setHash(value) {
    const url = value ? `#${value}` : location.pathname + location.search;
    history.replaceState(null, '', url);
  }

  function selectMember(id) {
    const member = membersById.get(id);
    if (!member) return;
    state.memberId = id;
    state.places = null;
    lastSelectAt = performance.now();
    setHash(id);
    closeRoster();
    render();
    rosterItems.get(id).scrollIntoView({ block: 'nearest' });
    const home = locations.get(member.locationKey);
    // Zoom far enough that this person's city has a pin of its own.
    flyTo(home, altitudeToSeparate([home]));
  }

  /** Open the list of people behind a pin that stands for several of them. */
  function selectGroup(placeKeys) {
    const places = placeKeys.map((key) => locations.get(key)).filter(Boolean);
    if (places.length === 0) return;
    state.memberId = null;
    state.places = places.map((p) => p.key);
    lastSelectAt = performance.now();
    setHash('');
    closeRoster();
    render();
    const cluster = clusterCache.get(state.places.join('|')) ?? places[0];
    // A pin covering several cities zooms in until they come apart.
    flyTo(cluster, places.length > 1 ? altitudeToSeparate(places, places) : altitudeToSeparate(places));
  }

  function clearSelection() {
    if (!state.memberId && !state.places) return;
    state.memberId = null;
    state.places = null;
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

  // A trackpad pinch arrives as a ctrl+wheel event. Over the canvas the globe handles it, but over a
  // pin or a panel the browser would magnify the whole page instead, pushing the panels off screen.
  const canvas = globe.renderer().domElement;
  addEventListener(
    'wheel',
    (e) => {
      // If the page is already magnified, a pinch-out anywhere must reach the browser so it can undo
      // that. Keep it away from the globe, which would otherwise swallow it.
      if (e.ctrlKey && e.deltaY > 0 && window.visualViewport?.scale > 1.01) {
        e.stopImmediatePropagation();
        return;
      }
      if (e.target === canvas) return;
      const overPin = e.target instanceof Element && e.target.closest('.pin');
      if (overPin) {
        // Pins float above the globe, so scrolling or pinching on one should zoom the globe.
        e.preventDefault();
        canvas.dispatchEvent(
          new WheelEvent('wheel', {
            deltaX: e.deltaX,
            deltaY: e.deltaY,
            deltaMode: e.deltaMode,
            clientX: e.clientX,
            clientY: e.clientY,
            ctrlKey: e.ctrlKey,
            bubbles: true,
            cancelable: true,
          }),
        );
      } else if (e.ctrlKey) {
        e.preventDefault();
      }
    },
    { passive: false, capture: true },
  );
  // Safari reports pinches as gesture events rather than ctrl+wheel. Block its page magnification
  // and turn the pinch into globe zoom instead.
  let gestureScale = 1;
  document.addEventListener(
    'gesturestart',
    (e) => {
      e.preventDefault();
      gestureScale = 1;
    },
    { passive: false },
  );
  document.addEventListener(
    'gesturechange',
    (e) => {
      e.preventDefault();
      const deltaY = (gestureScale - e.scale) * 400;
      gestureScale = e.scale;
      canvas.dispatchEvent(
        new WheelEvent('wheel', { deltaY, clientX: e.clientX, clientY: e.clientY, bubbles: true, cancelable: true }),
      );
    },
    { passive: false },
  );

  // If the page still ends up magnified (a pinch the handlers above could not intercept), the panels
  // hang off the edges of the window. Say so, since a small magnification is easy to miss.
  const viewport = window.visualViewport;
  if (viewport) {
    const notice = h('div', { id: 'zoom-notice', class: 'mono', role: 'status', hidden: true });
    document.body.append(notice);
    const checkMagnification = () => {
      const magnified = viewport.scale > 1.01;
      notice.hidden = !magnified;
      if (!magnified) return;
      notice.textContent = `Page magnified to ${Math.round(viewport.scale * 100)}% · pinch out to reset`;
      // Fixed elements follow the layout viewport, so place the notice inside the visible part.
      notice.style.left = `${viewport.offsetLeft + viewport.width / 2}px`;
      notice.style.top = `${viewport.offsetTop + 10 / viewport.scale}px`;
      notice.style.scale = String(1 / viewport.scale);
    };
    viewport.addEventListener('resize', checkMagnification);
    viewport.addEventListener('scroll', checkMagnification);
    checkMagnification();
  }

  addEventListener('keydown', (e) => {
    if (lightboxOpen()) {
      // The viewer is modal: it takes Escape and the arrows, and swallows the page shortcuts.
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowLeft') stepLightbox(-1);
      else if (e.key === 'ArrowRight') stepLightbox(1);
      else if (e.key === 'Tab') {
        // keep Tab inside the viewer
        const stops = [lightboxClose, lightboxPrev, lightboxNext].filter((el) => !el.hidden);
        const next = stops[(stops.indexOf(document.activeElement) + (e.shiftKey ? -1 : 1) + stops.length) % stops.length];
        next.focus();
      } else return;
      e.preventDefault();
      return;
    }
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
