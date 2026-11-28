'use strict';
// The live map of a raid. The map is a picture of the location from above, which the game plugin took in the game and
// the server keeps in tiles; the markers are what the plugin reports from the raid. A place is [east, north] in
// metres, the game's own, and every tile covers a known square of ground, so markers land where they are. The page
// only looks: it sends nothing to the game, and its options are its own (kept in this browser).
(() => {
  const $ = id => document.getElementById(id);
  // Raid recording (the History tab, replays): build.ps1 sets this false for a release without it, and then nothing of
  // it is on the page (everything marked data-rec in index.html is hidden).
  const RECORDING = true;
  if (!RECORDING) document.documentElement.classList.add('norec');
  // The page's own folder (/satellite/: index.html's <base>), and whether this is the raid history page under it
  // (/satellite/raids/..., see "the raid history page"): the same page, laid out for the raids recorded, with no
  // live game. The history page never opens the live stream, so a raid isn't watched (reported faster) for it.
  const ROOT = new URL('.', document.baseURI).pathname;
  const HIST = RECORDING && /^raids(\/|$)/.test(location.pathname.slice(ROOT.length));
  if (HIST) document.documentElement.classList.add('hist');
  // where this page keeps its settings (see read)
  const STORE = HIST ? 'satelliteHistory' : 'livemap';
  // the page's own words, in the language picked (see lang.js), before anything else is written
  window.fumsLangs.translatePage(document.body);
  // What a thing says when pointed at, in a box of the page's own (#hoverTip), not the browser's slow plain one. Every
  // "title" on the page, now or later, is moved to data-hint as it's pointed at (and kept there when it changes while
  // pointed at), so the browser never shows its own. The first comes after a moment; moving on to the next while one is
  // showing, at once. Not on a touch screen.
  const titleOf = el => el.getAttribute('title') || el.dataset.hint || '';
  {
    const box = document.createElement('div');
    box.id = 'hoverTip';
    box.hidden = true;
    box.setAttribute('role', 'tooltip');
    document.body.appendChild(box);
    let owner = null, timer = 0, warmUntil = 0, px = 0, py = 0;
    const take = el => {
      const t = el.getAttribute('title');
      if (t === null) return;
      el.removeAttribute('title');
      if (t) el.dataset.hint = t; else delete el.dataset.hint;
      // (an icon without words still has a name for a screen reader)
      if (t && !el.getAttribute('aria-label') && !el.textContent.trim()) el.setAttribute('aria-label', t);
    };
    const place = () => {
      if (!owner) return;
      const r = owner.getBoundingClientRect(), w = box.offsetWidth, h = box.offsetHeight, W = window.innerWidth, H = window.innerHeight;
      // under what's pointed at (a tall one: under the pointer), or over it when there's no room under it
      const tall = r.height > 48;
      let x = (tall || r.width > 260 ? px : r.left + r.width / 2) - w / 2, y = tall ? py + 20 : r.bottom + 6;
      if (y + h > H - 6) y = (tall ? py - 12 : r.top - 6) - h;
      box.style.left = Math.round(Math.max(6, Math.min(W - w - 6, x))) + 'px';
      box.style.top = Math.round(Math.max(6, y)) + 'px';
    };
    const show = () => {
      if (!owner || !owner.isConnected) { hide(); return; }
      const text = owner.dataset.hint;
      if (!text) { hide(); return; }
      box.textContent = text;
      box.hidden = false;
      place();
    };
    function hide() {
      clearTimeout(timer);
      if (!box.hidden) warmUntil = performance.now() + 350;
      box.hidden = true;
      owner = null;
    }
    document.addEventListener('pointerover', e => {
      if (e.pointerType === 'touch') return;
      px = e.clientX; py = e.clientY;
      // every title from here up is taken, so no outer one shows the browser's box either
      for (let el = e.target; el && el.nodeType === 1; el = el.parentElement) take(el);
      const el = e.target.closest && e.target.closest('[data-hint]');
      if (el === owner) return;
      const warm = !box.hidden || performance.now() < warmUntil;
      hide();
      if (!el) return;
      owner = el;
      if (warm) show(); else timer = setTimeout(show, 280);
    }, true);
    document.addEventListener('pointermove', e => { px = e.clientX; py = e.clientY; if (!box.hidden && owner && owner.getBoundingClientRect().height > 48) place(); }, true);
    document.addEventListener('pointerout', e => { if (owner && !(e.relatedTarget && owner.contains(e.relatedTarget))) hide(); }, true);
    for (const kind of ['pointerdown', 'wheel', 'keydown']) document.addEventListener(kind, () => { hide(); warmUntil = 0; }, true);
    window.addEventListener('scroll', () => hide(), true);
    window.addEventListener('blur', () => hide());
    // a title set again while it's pointed at (a switch greyed, a count changed): taken, and the box says the new one
    new MutationObserver(list => {
      for (const r of list) {
        if (!owner || !(r.target === owner || r.target.contains(owner)) || r.target.getAttribute('title') === null) continue;
        take(r.target);
        if (!box.hidden) show();
      }
    }).observe(document.body, { attributes: true, attributeFilter: ['title'], subtree: true });
  }
  const stage = $('stage');
  const layersEl = $('layers');
  const canvas = $('markers');
  const ctx = canvas.getContext('2d');
  const RAD = Math.PI / 180;
  const FONT = getComputedStyle(document.documentElement).getPropertyValue('--font') || 'sans-serif';

  // the page's address ending in ?debug: a line at the bottom left says what the floor display goes by
  const DEBUG = new URLSearchParams(location.search).has('debug');
  // ?fake=team: three made-up friends walk about near the player (two people and a bot), to see how a team looks.
  // Only on this page, only while the address says so; nothing is sent anywhere.
  const FAKE_TEAM = new URLSearchParams(location.search).get('fake') === 'team';
  function fakeTeam(at, now) {
    const who = [['Tester_Anna', 34, 9, 0], ['Tester_Borys', 51, 16, 2.1], ['Tester_Bot', 12, 26, 4.2]];
    return who.map(([name, level, far, phase], i) => {
      const turn = now / 9000 * (i % 2 ? -1 : 1) + phase;
      return { id: -9001 - i, c: 'Friendly Player', t: name, p: [at[0] + Math.cos(turn) * far, at[1] + Math.sin(turn) * far, at[2]],
        r: ((i % 2 ? -1 : 1) * -turn * 180 / Math.PI + (i % 2 ? 180 : 0)) % 360, dyn: 1, lv: level, g: 'fake-team', pid: 'fake' + i,
        df: i === 2 ? 'hard' : undefined, ly: i === 2 ? 'FollowerLayer' : undefined };
    });
  }
  let debugAt = 0;
  // the notice shut with its ×: kept shut until it says something else (a percentage going up isn't that)
  let noticeShut = '';
  const noticeKey = m => String(m || '').replace(/\d+%/g, '');

  const ZOOM_MIN_DIVIDER = 1.1;
  // as close as it goes: screen pixels to a metre
  const ZOOM_CLOSEST = 48;
  // Markers grow with the zoom (Settings > Markers, off to begin with): markers, loot and their labels grow as the
  // map is zoomed in and shrink as it's zoomed out, as the map itself does, only less (to the power ZOOM_GROW) and
  // within limits so they stay readable. ZOOM_PLAIN pixels to the metre (between following outdoors and indoors) is
  // Marker size as set: further out they're a little smaller, and only right in do they reach the most.
  const ZOOM_PLAIN = 5, ZOOM_GROW = 0.45, ZOOM_SCALE = [0.6, 1.5];
  const zoomScale = () => prefs.worldScale !== true ? 1 : Math.min(ZOOM_SCALE[1], Math.max(ZOOM_SCALE[0], Math.pow(zoom / ZOOM_PLAIN, ZOOM_GROW)));

  // a lock, by its kind (KeycardDoor: "Keycard door")
  const lockName = kind => T({ Door: 'Door', Trunk: 'Trunk', KeycardDoor: 'Keycard door', Switch: 'lock|Switch', DoorSwitch: 'Door switch' }[kind] || 'Lock');
  // the game's names for its locations
  const PLACES = {
    bigmap: T('Customs'), factory4_day: T('Factory'), factory4_night: T('Factory (night)'), Woods: T('Woods'), Shoreline: T('Shoreline'),
    Interchange: T('Interchange'), RezervBase: T('Reserve'), laboratory: T('The Lab'), Lighthouse: T('Lighthouse'),
    TarkovStreets: T('Streets of Tarkov'), Sandbox: T('Ground Zero'), Sandbox_high: T('Ground Zero (21+)'), Labyrinth: T('The Labyrinth'),
    // (SageSPT's Tutorial-Backport: the 1.0 tutorial as a location of its own)
    Sandbox_start: T('Tutorial')
  };
  // A map is kept by its location id; when a mod swapped in another version of the location, the version follows a
  // "~" ("Interchange~backport"). The location alone is what quests and the map's turn go by.
  // A map can also come for a season with snow on the ground (the season add-ons): "<map>@snow" for winter (all under
  // snow), "<map>@lateautumn" and "<map>@earlyspring" (patches of it). One is shown in place of the map in a raid of
  // its season ("sea" in the report), when it's installed.
  const SEASON_MAPS = { Winter: '@snow', AutumnLate: '@lateautumn', SpringEarly: '@earlyspring' };
  const SEASON_NAMES = { '@snow': T('snow'), '@lateautumn': T('late autumn'), '@earlyspring': T('early spring') };
  const seasonOf = loc => Object.values(SEASON_MAPS).find(s => String(loc || '').endsWith(s)) || '';
  const isSnow = loc => !!seasonOf(loc);
  const noSnow = loc => { const s = seasonOf(loc); return s ? String(loc).slice(0, -s.length) : String(loc || ''); };
  const baseOf = loc => noSnow(loc).split('~')[0];
  const sameLoc = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
  // the places, raid loot and loot spawns of a map are the same in every season: the server sends them without one
  const sameMap = (a, b) => !!a && !!b && noSnow(a) === noSnow(b);
  // The map shown for a location: its snow map in a snowy raid, when there is one; its own; or, for a version of it
  // (Interchange~backport) that isn't here, the location's own map, so the raid is still shown (maps come in add-ons,
  // and one may not be installed); null: none.
  const raidSeason = () => !!report && !!report.raid && SEASON_MAPS[report.sea] || '';
  const plainMapFor = loc => maps.find(m => m.loc === loc) || (String(loc || '').includes('~') && maps.find(m => m.loc === baseOf(loc))) || null;
  const mapFor = loc => {
    const plain = plainMapFor(loc);
    const season = raidSeason();
    if (plain && season && !isSnow(loc)) return maps.find(m => m.loc === plain.loc + season) || plain;
    return plain;
  };
  // the location a raid's things are shown on: its map's (see mapFor)
  const shownLoc = loc => (mapFor(loc) || { loc }).loc;
  // the add-on a location's map comes in, when it's one there is but isn't installed (the server tells these apart
  // by the raid's scenes); null: none
  const addonFor = loc => addons.find(a => a.loc === loc) || null;
  // a version told only by its scenes, which no map or add-on has: kept by their hash (8 hex digits)
  const unknownVersion = loc => /^[0-9a-f]{8}$/.test(noSnow(loc).split('~')[1] || '');
  // a version's name without its map's in front ("Customs - Classic" on Customs: "Classic")
  function variantShort(title, vname) {
    const v = String(vname || '');
    for (const name of [title, String(title).replace(/\s*\(.*\)$/, '')]) if (name && v.toLowerCase().startsWith(name.toLowerCase() + ' - ')) return v.slice(name.length + 3);
    return v;
  }
  // a map's name: as captured (the game's name for a mod's own location, the version's name), or else as known here
  const placeName = loc => {
    const known = maps.find(m => m.loc === loc);
    if (known) return known.name;
    const addon = addonFor(loc);
    if (addon) { const title = PLACES[addon.base] || addon.name || addon.base || baseOf(loc), short = variantShort(title, addon.vname); return title + (short ? ' (' + short + ')' : ''); }
    const base = baseOf(loc), version = noSnow(loc).split('~')[1];
    return locationName(base) + (version ? ' (' + (/^[0-9a-f]{8}$/.test(version) ? T('another version') : version) + ')' : '');
  };
  // a location's name, whichever version: for quests, which go by the location
  const locationName = base => {
    const captured = maps.find(m => sameLoc(m.base, base));
    return PLACES[base] || (captured && captured.title) || base;
  };

  // how each kind of marker is drawn; a later one is drawn over an earlier one
  const KINDS = {
    'Extract': { name: T('Extracts'), col: '#3ddc5a', shape: 'exit', size: 1, label: true, order: 0 },
    'Transit': { name: T('Transits'), col: '#40d8f0', shape: 'transit', size: 1, label: true, order: 0.1 },
    'Corpse': { name: T('Corpses'), col: '#a9b1bd', shape: 'cross', size: 0.8, order: 1 },
    'Other AI': { name: T('Other AI'), col: '#6f7684', shape: 'arrow', size: 0.95, order: 2 },
    'Scav': { name: T('Scavs'), col: '#f2e24a', shape: 'arrow', size: 1, order: 2 },
    'Smuggler': { name: T('Smugglers'), col: '#5b9bf0', shape: 'arrow', size: 1, order: 3 },
    'Raider': { name: T('Raiders'), col: '#ff7a45', shape: 'arrow', size: 1.05, order: 4 },
    'Rogue': { name: T('Rogues'), col: '#b8e04a', shape: 'arrow', size: 1.05, order: 4 },
    'Black Division': { name: T('Black Division'), col: '#36393f', shape: 'arrow', size: 1.05, order: 5 },
    'RUAF': { name: 'RUAF', col: '#7da35f', shape: 'arrow', size: 1.05, order: 5 },
    'RUAF Remnant': { name: T('RUAF remnant'), col: '#f08e75', shape: 'arrow', size: 1.05, order: 5 },
    'UNTAR': { name: 'UNTAR', col: '#8ec9ff', shape: 'arrow', size: 1.05, order: 5 },
    'ISB': { name: T('ISB special forces'), col: '#5c6cff', shape: 'arrow', size: 1.05, order: 5 },
    'ISB WT': { name: T('ISB White Tusks'), col: '#f4ead2', shape: 'arrow', size: 1.1, label: true, order: 5.5 },
    'Bloodhound': { name: T('Bloodhounds'), col: '#e0457b', shape: 'arrow', size: 1.05, order: 4 },
    'Mercenary': { name: T('Mercenaries'), col: '#d9b23a', shape: 'arrow', size: 1.05, order: 5 },
    'Combine': { name: T('Combine'), col: '#6f8fb8', shape: 'arrow', size: 1.05, order: 5 },
    'Civilian': { name: T('Civilians'), col: '#adebe1', shape: 'arrow', size: 0.9, order: 2 },
    'Infected': { name: T('Infected'), col: '#b84a32', shape: 'arrow', size: 1, order: 3 },
    'Sniper': { name: T('Sniper scavs'), col: '#fff6c8', shape: 'arrow', size: 1, order: 3 },
    'Enemy Player': { name: T('Enemy PMCs'), col: '#ff5148', shape: 'arrow', size: 1, order: 4 },
    'Guard': { name: T('Guards'), col: '#ff8fa8', shape: 'arrow', size: 1.05, label: true, order: 5 },
    'Cultist': { name: T('Cultists'), col: '#b06fa8', shape: 'arrow', size: 1.05, order: 5 },
    'Goon': { name: T('Goons'), col: '#33d6c0', shape: 'arrow', size: 1.15, label: true, order: 6 },
    'Boss': { name: T('Bosses'), col: '#c77dff', shape: 'arrow', size: 1.15, label: true, order: 7 },
    'Friendly Player': { name: T('Friendly players'), col: '#ffc299', shape: 'arrow', size: 1.1, label: true, order: 8 },
    'BTR': { name: T('BTR'), col: '#a3c45c', shape: 'btr', size: 1, label: true, order: 8.5 },
    'Airdrop': { name: T('Airdrops'), col: '#ff4fd8', shape: 'drop', size: 1.15, label: true, order: 8.4 },
    'Main Player': { name: T('Player'), col: '#39ff14', shape: 'arrow', size: 1.3, order: 9 }
  };
  const OTHER = { col: '#ccd5df', shape: 'dot', size: 0.8, order: 1 };
  // A colour too dark to make out on the dark map and page (Black Division's charcoal, or one picked): outlined in
  // light grey, not black, and written in light grey wherever it'd be text or a thin line
  const LIGHT_EDGE = '#c8ccd4';
  const darkCol = col => {
    if (typeof col !== 'string' || !/^#[0-9a-f]{6}$/i.test(col)) return false;
    // by its brightest part, so a deep red (the minefields') stays red
    const n = parseInt(col.slice(1), 16);
    return Math.max(n >> 16, n >> 8 & 255, n & 255) < 96;
  };
  const edgeOf = col => darkCol(col) ? LIGHT_EDGE : '#000';
  const inkOf = col => darkCol(col) ? LIGHT_EDGE : col;
  const paintSwatch = (el, col) => { el.style.background = col; el.style.boxShadow = darkCol(col) ? '0 0 0 1px ' + LIGHT_EDGE : ''; };
  // the deadly ground at a location's edge, drawn on the map itself; claymores that lie together make a minefield
  const MINE_REACH = 2.5;       // metres around a claymore drawn as dangerous
  const MINE_TOGETHER = 40;     // claymores this close are one field
  const ZONES = {
    mine: { name: T('Minefields'), col: '#b01010', label: T('Mines') },
    sniper: { name: T('Sniper zones'), col: '#e8ff3a', label: T('zone|Sniper'), hatch: true }
  };
  // an extract: closed, wants something of you first, open, a secret one not found yet
  const EXIT_COL = ['#d8504a', '#e8c547', '#3ddc5a', '#b48cff'];
  // What lies about and where things stand: each a layer that can be turned off on the page. server: the layer of
  // the server's config.jsonc that holds it.
  const LAYERS = {
    quest: { name: T('Quest items'), col: '#ffbf00', server: 'loose' },
    questZones: { name: T('Quest places'), col: '#ffbf00', server: null },
    firItems: { name: T('Found-in-raid needs'), col: '#f5a3ff', server: 'loose' },
    btrRoad: { name: T('BTR road and stops'), col: '#a3c45c', server: null },
    loose: { name: T('Loose loot'), col: '#6fd38f', server: 'loose' },
    lootSpawns: { name: T('Loot spawn points'), col: '#e6d38a', server: 'loose' },
    boxes: { name: T('Containers'), col: '#b07d4a', server: 'contents' },
    bodies: { name: T('Corpse loot'), col: '#a9b1bd', server: 'contents' },
    locks: { name: T('Locked doors'), col: '#ff9a00', server: 'locks' },
    switches: { name: T('Switches'), col: '#5fd0c8', server: 'switches' },
    spawnPmc: { name: T('PMC spawns'), col: '#ff5148', server: 'spawns' },
    spawnScav: { name: T('Scav spawns'), col: '#f2e24a', server: 'spawns' },
    spawnBoss: { name: T('Boss spawns'), col: '#c77dff', server: 'spawns' }
  };
  // worth, in roubles, and the colour it's drawn in: the first one it's under
  const WORTH = [[10000, '#aab4c0'], [30000, '#7fd36b'], [70000, '#4aa8ff'], [150000, '#c77dff'], [Infinity, '#ffb13d']];
  const worthCol = v => WORTH.find(w => v < w[0])[1];
  // (grouped by hand: toLocaleString takes a hundred times as long, and this is asked for a lot)
  const roubles = v => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' ₽';
  // a worth in short ("394k", "1.2M"), and only roughly ("~400k"): to the nearest thousand, ten thousand, fifty
  // thousand or hundred thousand, as it grows
  const shortWorth = v => v >= 1e6 ? (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : v >= 1000 ? Math.round(v / 1000) + 'k' : String(Math.round(v));
  const rough = v => {
    const step = v < 10000 ? 1000 : v < 100000 ? 10000 : v < 1000000 ? 50000 : 100000;
    return '~' + shortWorth(Math.max(step, Math.round(v / step) * step));
  };
  // what a container is drawn with, by its sort (the server's "c" for its template)
  const BOX_GLYPH = {
    safe: 'i:boxSafe', register: 'i:boxRegister', drawer: 'i:boxDrawer', bag: 'i:boxBag', jacket: 'i:boxJacket',
    tools: 'i:boxTools', pc: 'i:boxPc', grenade: 'i:boxGrenade', weapon: 'i:boxWeapon', med: 'i:boxMed',
    food: 'i:boxFood', cache: 'i:boxCache', body: 'i:boxBody', crate: 'i:boxCrate'
  };
  // a lock, by what it's on
  const LOCK_GLYPH = { Door: 'i:lock', Trunk: 'i:trunk', KeycardDoor: 'i:keycard' };
  // a room's light switch, by its id or name ("switch_custom_Light_00012"), as the plugin tells them too;
  // every other switch is a power switch (a lever, a gate's switch, the power for an extract)
  const LIGHT_SWITCH = /(^|[^a-z])lights?([^a-z]|$)/i;
  const lightSwitch = d => LIGHT_SWITCH.test(d.id || '') || LIGHT_SWITCH.test(d.nm || '');
  // whether somebody switched one during a raid: one told again standing other than it first did (each is told as it
  // stands when the raid begins, so having switches is no news)
  function switchFlipped(r) {
    const first = new Map();
    for (const e of r.events) {
      if (e.k !== 'switch' || !e.d || !e.d.id || lightSwitch(e.d)) continue;
      if (!first.has(e.d.id)) first.set(e.d.id, e.d.st);
      else if (first.get(e.d.id) !== e.d.st) return true;
    }
    return false;
  }
  // things the game counts among its switches that aren't one anybody looks for (Interchange's "urinal (3)")
  const NOT_A_SWITCH = /urinal|toilet|sink|shower/i;
  // a switch's own name, plainly: "reserve_electric_switcher_lever" is "reserve electric switcher lever"
  // what a switch is, by its name or id, the first that fits (in English too, for a search): Kiba's alarm on
  // Interchange ("Node_Alarm_Kiba"), its saferoom's reader, Reserve's lever for an extract ("autoId_00632_EXFIL"),
  // its hermetic door ("Node_GatesButton"), D-2's power ("autoId_00000_D2_LEVER")
  const SWITCH_KINDS = [
    [/alarm/i, T('Alarm switch'), 'Alarm switch'], [/keycard/i, T('Keycard reader'), 'Keycard reader'],
    [/exfil|extract/i, T('Extract switch'), 'Extract switch'], [/door|shutter|gate/i, T('Door switch'), 'Door switch'],
    [/lever|electric|power/i, T('Power switch'), 'Power switch'], [/button|panel|console|reset|interval/i, T('Button'), 'Button']
  ];
  const switchKind = w => w.light ? [T('Light switch'), 'Light switch']
    : (SWITCH_KINDS.find(k => k[0].test((w.nm || '') + ' ' + w.id)) || [null, T('Switch'), 'Switch']).slice(1);
  const switchPlain = w =>String(w.nm && !/^switch$/i.test(w.nm) ? w.nm : w.id || '').replace(/[_\s]*\(?\d+\)?$/, '').replace(/_+/g, ' ').trim().slice(0, 48);
  const SPAWN_LETTER = { spawnPmc: 'P', spawnScav: 'S', spawnBoss: 'B' };
  // what they're called in English too, for a search
  const SPAWN_EN = { spawnPmc: 'PMC spawn', spawnScav: 'Scav spawn', spawnBoss: 'Boss spawn' };

  // A search box with an ✕ in it, shown while there's something typed, that empties it (as typing would: its input
  // event); its box is given back to be put where the box would go (one already on the page is wrapped where it is)
  function clearable(input) {
    const box = document.createElement('span'), x = document.createElement('button');
    box.className = 'clearable';
    x.type = 'button';
    x.className = 'clearX';
    x.textContent = '✕';
    x.title = T('Clear the search');
    x.setAttribute('aria-label', T('Clear the search'));
    x.hidden = !input.value;
    if (input.parentNode) input.parentNode.insertBefore(box, input);
    box.append(input, x);
    for (const kind of ['input', 'keyup', 'change']) input.addEventListener(kind, () => { x.hidden = !input.value; });
    x.onclick = e => { e.preventDefault(); e.stopPropagation(); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); x.hidden = true; input.focus(); };
    return box;
  }

  // ---- what the page remembers ---------------------------------------------------------------------------------
  // spanIn, spanOut: how close auto zoom goes indoors and outdoors, as metres across the screen's short side
  // hide, show: marker kinds turned off and on here. player: whose game to show, { sid, name }; none: whoever is playing
  // floor: 'auto' (the one the player is on), 0 (the view from above) or a floor's number
  const SPAN_IN = [10, 120], SPAN_OUT = [40, 900];
  // worth: loose loot and containers worth less than this many roubles are left off (quest items never are)
  // wishOnly: only loot on the player's wishlist, whatever it's worth and whatever its kind (quest items still show)
  // itemNames: loose loot named up close. allNames: every player and bot named.
  // myQuests: only quest items and places of the quests the player has started
  // (what a page starts with, the first time it's opened, is how the mod ships: the author's own page as of 1.0.0)
  const prefs = Object.assign({ follow: true, autoZoom: false, spanIn: 120, spanOut: 400, scale: 1, zoom: 0.32, map: '',
    hide: [], show: [], player: null, floor: 'auto', worth: 0, wishOnly: false, heat: false, lootFloats: true, trails: true, killLines: true, floorOnly: false, hitFlash: true, switches: true, orbitMain: true, orbitRush: true, orbitTactics: true, recSign: true, orbitField: false, squadMarks: true, grenades: true, phobosField: false, minimap: true, killKeep: false, trailMs: 60000, itemNames: true, modTints: false, names: 'all', closeSpan: 250, myExits: true, goneExits: false, secretExits: false, allCorpses: true, botKills: false, lootSprees: true, edgeExits: true, doorEvents: true, teamNames: true, squadCols: false, actionIcons: true, mapDifficulty: true, mapPersonality: true, tacticWords: true, floorGrey: true, keyStates: false,
    myQuests: true, otherLoot: 30, floorDim: 70, insideMine: true, insideLook: true, lookSpan: 220, pressOpen: true, squadParts: true, edge: true, corpseKind: true, botDetails: true, botDiff: true, botSAIN: true, botORBIT: true, botCOMET: true, botLoot: true, edgeQuests: true, myName: true, shots: true, health: true, eventsKind: 'all', feed: true, feedMine: true, feedPmc: true, feedBoss: true, feedAi: true, orbitLines: true, areaPmc: false, lootArea: false, squadPane: true,
    rosterShut: [], rosterGhosts: 'in', rosterHp: true, rosterDoing: true, rosterSlim: false, mapDoing: true, healthAll: true,
    orbitNames: false, orbitHear: true, orbitFights: true, lootCell: 60, areaR: 70, roofLoot: true, roofTotals: true, roofTotalsUnder: false, feedNames: 'all', feedBg: 70, feedRows: 5,
    feedPos: 'free', feedAt: { l: false, t: false, x: 0.143, y: 0.0064 }, eventsPos: { x: 0.135, y: 0.039, v: 2 }, keepZoom: true, feedKeep: true, feedFolded: false, feedBox: true, textScale: 0.9, mapLight: 100, alertSound: false, seenDead: true,
    alerts: [], has: null, seenInfected: false, rosterNear: false, bestMore: false, lootOff: [], boxOff: [], containerStyle: 'icon', containerScale: 1, peek: true, rosterFog: false,
    latin: true, botShape: 'arrow', meShape: 'arrow', hpTab: 'events', hpEventsAll: true, hpActions: false, hpGestures: true, floatWorth: 0, chaseRing: true, nameScale: .8, doingScale: 1, tipGear: true, tipCarry: true, secureShown: false, wishMarks: true, modTeams: true, worldScale: false, sizeByKind: false,
    // the menu's groups, open or folded
    groups: { labels: true, show: true, key: true, quests: true, view: true, loot: true, alerts: true, roster: true, lootKinds: true, lootMore: true, lootKey: true,
      rosterMore: true, who: true, layout: true, spawnKinds: false, rosterRows: true, bots: true, orbitMap: false, feed: true, areas: false, boxKinds: true,
      lootRoofs: true, colors: true, phone: true, screen: true } }, read());
  // lootOff: the kinds of loot left off (see LOOT_KINDS). peek: what's in containers, bodies, airdrops and on bots is
  // shown. rosterFog: the Raid list names everyone seen this raid but not who's still alive. latin: names written in
  // Cyrillic are shown in Latin letters (bosses by their English names)
  // botShape, meShape: how bots, and you and your friends, are drawn (see MARKER_SHAPES)
  for (const k of ['botShape', 'meShape']) if (!['arrow', 'disc', 'dart', 'drop', 'chevron', 'cone', 'dot'].includes(prefs[k])) prefs[k] = 'arrow';
  if (!Array.isArray(prefs.lootOff)) prefs.lootOff = [];
  // boxOff: the sorts of container left off the map (see BOX_GLYPH)
  if (prefs.containerStyle !== 'square') prefs.containerStyle = 'icon';
  prefs.containerScale = Math.max(.5, Math.min(2, Number(prefs.containerScale) || 1));
  if (!Array.isArray(prefs.boxOff)) prefs.boxOff = [];
  // rosterShut: the groups of the Raid list folded away (a kind, or 'Ghosts'). rosterGhosts: ORBIT's ghosts in a group
  // of their own ('own'), with their kind ('in') or not listed ('hide'). lootCell, areaR: how big a rough area of loot
  // and of a PMC is, in metres. feedNames: whose names the kill feed gives. feedBg: how dark its background is, percent
  if (!Array.isArray(prefs.rosterShut)) prefs.rosterShut = ['Ghosts'];
  // areaKinds: the kinds shown only as a rough area (before this: PMCs alone, areaPmc)
  if (!Array.isArray(prefs.areaKinds)) prefs.areaKinds = prefs.areaPmc ? ['Enemy Player'] : [];
  delete prefs.areaPmc;
  // the Loot tab's Explorer: where its items are from ('real': this raid, 'can': what can spawn), of which kind ('' any,
  // a kind of LOOT_KINDS, or 'quest'), of the wishlist ('' any, 'all' on it, or one of its groups '0'..'4'), in what
  // order, and whether the whole list is shown
  if (!['real', 'can'].includes(prefs.exFrom)) prefs.exFrom = 'real';
  if (typeof prefs.exKind !== 'string') prefs.exKind = '';
  if (!['', 'all', '0', '1', '2', '3', '4'].includes(prefs.exWish)) prefs.exWish = '';
  if (!['worth', 'total', 'name', 'count', 'chance'].includes(prefs.exSort)) prefs.exSort = 'worth';
  if (typeof prefs.exMore !== 'boolean') prefs.exMore = false;
  if (!['own', 'in', 'hide'].includes(prefs.rosterGhosts)) prefs.rosterGhosts = 'in';
  if (!['all', 'victim', 'kinds'].includes(prefs.feedNames)) prefs.feedNames = 'all';
  prefs.lootCell = Math.min(150, Math.max(20, +prefs.lootCell || 60));
  prefs.areaR = Math.min(200, Math.max(30, +prefs.areaR || 70));
  prefs.feedBg = Math.min(100, Math.max(0, Number.isFinite(+prefs.feedBg) ? +prefs.feedBg : 30));
  // feedRows: how many kills the feed shows at once, at most. (feedOnlyMine and rosterTags: switches before 1.0.0,
  // dropped: the four kill feed switches and One line each say the same)
  delete prefs.feedOnlyMine;
  delete prefs.rosterTags;
  // textScale: the names and words on the map, apart from the markers. mapLight: how bright the map picture is, percent.
  // alertSound: a sound with each alert
  prefs.textScale = Math.min(2.4, Math.max(0.6, +prefs.textScale || 1));
  // nameScale, doingScale: names under markers, and what a bot is doing under its name, each on top of textScale
  prefs.nameScale = Math.min(2, Math.max(0.5, +prefs.nameScale || .8));
  prefs.doingScale = Math.min(2, Math.max(0.5, +prefs.doingScale || 1));
  // floatWorth: what a pick-up written on the map must be worth, apart from Worth at least (a page from before 1.1.0
  // may say -1, "as Worth at least": it takes what that's set to now)
  prefs.floatWorth = Number.isFinite(+prefs.floatWorth) && +prefs.floatWorth >= 0 ? +prefs.floatWorth : Math.max(0, +prefs.worth || 0);
  prefs.mapLight = Math.min(100, Math.max(30, +prefs.mapLight || 100));
  prefs.alertSound = prefs.alertSound === true;
  prefs.feedRows = [3, 5, 8, 12].includes(+prefs.feedRows) ? +prefs.feedRows : 5;
  // feedPos: the corner the feed sits in (auto: the bottom one on the menu's side)
  // ('free': where it was dragged to, feedAt: { l, t, x, y }: grows from its left or right, top or bottom edge, that
  // edge x and y of the window's width and height in from it)
  if (!['auto', 'bl', 'br', 'tl', 'tr', 'free'].includes(prefs.feedPos)) prefs.feedPos = 'auto';
  if (!prefs.feedAt || !Number.isFinite(prefs.feedAt.x) || !Number.isFinite(prefs.feedAt.y)) { prefs.feedAt = null; if (prefs.feedPos === 'free') prefs.feedPos = 'auto'; }
  if (prefs.phoneLight === undefined) prefs.phoneLight = true;
  // awake: the screen is asked to stay on while the page is in front. speed: the speed numbers are shown
  if (prefs.awake === undefined) prefs.awake = true;
  // rosterNear: the Raid list is in order of distance from the player. bestMore: its best loot lists 30, not 12
  // otherLoot: how strongly loot on another floor than the player is drawn, in percent (0: not at all)
  // insideMine: the inside of the building the player is in is shown. insideLook: and of the one in the middle of the
  // screen while looking about.
  // Extracts shows every extract of the location; in a raid, the player's own by their state and the rest hollow.
  // myExits: only the player's own, in a raid. goneExits: the ones that are no longer there (a car that never came,
  // or that left with someone) are still shown, in red. (Before 1.0.0: allExits and openExits, read once.)
  delete prefs.allExits;
  delete prefs.openExits;
  delete prefs.refollow;
  if (typeof prefs.myExits !== 'boolean') prefs.myExits = true;
  if (typeof prefs.goneExits !== 'boolean') prefs.goneExits = false;
  // secretExits: the secret extracts not found yet (their note not picked up) are shown too, in purple; found ones
  // always are
  if (typeof prefs.secretExits !== 'boolean') prefs.secretExits = false;
  // corpseKind: a body says what it was
  // alerts: the kinds that are announced once seen. has: the kinds only a mod brings that this game has
  const LOOK_SPAN = [60, 500];
  prefs.lookSpan = Math.min(LOOK_SPAN[1], Math.max(LOOK_SPAN[0], +prefs.lookSpan || 220));
  if (typeof prefs.pressOpen !== 'boolean') prefs.pressOpen = true;
  prefs.otherLoot = Math.min(100, Math.max(0, Number.isFinite(+prefs.otherLoot) ? +prefs.otherLoot : 30));
  if (typeof prefs.wishOnly !== 'boolean') prefs.wishOnly = false;
  if (typeof prefs.myQuestItems !== 'boolean') prefs.myQuestItems = prefs.myQuests !== false;
  if (typeof prefs.myQuestPlaces !== 'boolean') prefs.myQuestPlaces = prefs.myQuests !== false;
  if (typeof prefs.friendQuests !== 'boolean') prefs.friendQuests = true;
  if (!Array.isArray(prefs.alerts)) prefs.alerts = [];
  if (!Array.isArray(prefs.has)) prefs.has = null;
  if (!Array.isArray(prefs.brains)) prefs.brains = null;
  delete prefs.zin;
  delete prefs.zout;
  // 'some' and 'players' keep their original combinations in existing settings and presets.
  const botNameModes = ['none', 'pmc', 'other', 'all', 'some', 'players'];
  if (prefs.allNames) prefs.names = 'all';
  delete prefs.allNames;
  if (!botNameModes.includes(prefs.names)) prefs.names = 'all';
  // closeSpan: item names, and every container, show once the screen's short side is this many metres or fewer
  const CLOSE_SPAN = [20, 400];
  prefs.closeSpan = Math.min(CLOSE_SPAN[1], Math.max(CLOSE_SPAN[0], +prefs.closeSpan || 250));
  const clampSpan = (v, range, fallback) => Math.min(range[1], Math.max(range[0], +v || fallback));
  prefs.spanIn = clampSpan(prefs.spanIn, SPAN_IN, 120);
  prefs.spanOut = clampSpan(prefs.spanOut, SPAN_OUT, 400);
  if (!Array.isArray(prefs.hide)) prefs.hide = [];
  if (!Array.isArray(prefs.show)) prefs.show = [];
  if (!prefs.player || typeof prefs.player.sid !== 'string') prefs.player = null;
  const hidden = new Set(prefs.hide);
  // The history page shows everybody to begin with: who the live map has switched off, shown as a rough area or
  // listed without who's alive is the live map's own choice, not the recording's. (Changed here, it stays on this
  // page: save() writes none of these back from the history page.)
  if (HIST) {
    for (const k of Object.keys(KINDS)) hidden.delete(k);
    prefs.areaKinds = [];
    prefs.rosterFog = false;
    hidden.delete('Layer bodies');
  }
  // cols: the marker colours picked in Settings, Colours, over the usual ones ({ 'Scav': '#rrggbb', 'Layer quest': ... })
  if (!prefs.cols || typeof prefs.cols !== 'object' || Array.isArray(prefs.cols)) prefs.cols = {};
  // the page's own two colours, picked there too: its highlights (switches, buttons, the tab shown) and what's behind
  // everything; as 'Page primary' and 'Page secondary' in cols
  const PAGE = { primary: { name: T('Highlights'), col: '#7b9cff' }, secondary: { name: T('Background'), col: '#0c0c12' } };
  const COL_HOME = { 'Page primary': PAGE.primary.col, 'Page secondary': PAGE.secondary.col };
  for (const k of Object.keys(KINDS)) COL_HOME[k] = KINDS[k].col;
  for (const k of Object.keys(LAYERS)) COL_HOME['Layer ' + k] = LAYERS[k].col;
  for (const k of Object.keys(ZONES)) COL_HOME['Zone ' + k] = ZONES[k].col;
  // The player is never black: Firefox's colour window says black as it opens, and an older page kept that. A black
  // player is never what was picked, so it's never kept, however it got there (see setCol and save too).
  const NOT_BLACK = ['Main Player'];
  const blackRefused = (key, col) => NOT_BLACK.includes(key) && hex6(col) === '#000000';
  for (const key of NOT_BLACK) if (blackRefused(key, prefs.cols[key])) delete prefs.cols[key];
  for (const key of Object.keys(prefs.cols)) {
    const look = colLook(key), col = hex6(prefs.cols[key]);
    if (look && col) look.col = col;
    else delete prefs.cols[key];
  }
  // what a colour key is drawn by: a kind, 'Layer <name>' or 'Zone <name>'
  function colLook(key) {
    return key.startsWith('Page ') ? PAGE[key.slice(5)] : key.startsWith('Layer ') ? LAYERS[key.slice(6)] : key.startsWith('Zone ') ? ZONES[key.slice(5)] : KINDS[key];
  }
  // '#abc', 'abc', '#AABBCC' or 'aabbcc' as '#aabbcc'; anything else null
  function hex6(v) {
    let s = String(v == null ? '' : v).trim().toLowerCase();
    if (!s.startsWith('#')) s = '#' + s;
    if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    return /^#[0-9a-f]{6}$/.test(s) ? s : null;
  }
  // The page's colours, as picked: the highlight and its tints; the background, the panels a shade off it, and on a
  // light one dark words. Neither picked: the stylesheet's own.
  function paintPage() {
    const root = document.documentElement.style;
    const set = (k, v) => v ? root.setProperty(k, v) : root.removeProperty(k);
    const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    const lum = c => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
    const a = prefs.cols['Page primary'], b = prefs.cols['Page secondary'];
    const back = rgb(b || PAGE.secondary.col), light = lum(back) > 0.5;
    set('--accent', a);
    set('--accent-soft', a && 'rgba(' + rgb(a).join(', ') + ', 0.15)');
    set('--line-strong', a && 'rgba(' + rgb(a).join(', ') + ', 0.55)');
    // the words on a highlight: dark on a light one, light on a dark one
    const ink = lum(rgb(a || PAGE.primary.col)) > 0.5 ? (light ? '#0c0c12' : b || null) : '#ffffff';
    set('--ink', a || b ? ink : null);
    const panel = b && back.map(c => Math.round(light ? c * 0.95 : c + (255 - c) * 0.05)).join(', ');
    set('--bg', b);
    set('--panel', b && 'rgba(' + panel + ', 0.86)');
    set('--panel-solid', b && 'rgba(' + panel + ', 0.97)');
    set('--text', b && light ? '#16171c' : null);
    set('--bright', b && light ? '#000000' : null);
    set('--dim', b && light ? '#4f5562' : null);
    set('--line', b && light ? 'rgba(0, 0, 0, 0.14)' : null);
    set('--hover', b && light ? 'rgba(0, 0, 0, 0.06)' : null);
  }
  paintPage();
  // The mouse pointer (Settings > Screen > Cursor): each a set from Kenney's Cursor Pack in web/cursors (CC0), as the
  // arrow, the hand over what can be pressed and the hand dragging the map, each with the pixel it points with.
  // 'satellite' is the stylesheet's own (idle.png, hand.png); 'system' the computer's own pointers.
  const CURSORS = {
    arrow: [[10, 6], [8, 2], [16, 16]], sharp: [[4, 2], [8, 4], [16, 16]], small: [[10, 6], [9, 5], [16, 16]],
    toon: [[4, 2], [8, 2], [16, 16]], gauntlet: [[4, 3], [2, 1], [16, 16]], large: [[19, 12], [15, 4], [32, 32]]
  };
  // the pictures themselves, in the page (see the stylesheet's own: never a picture still on its way)
  const CURSOR_PICS = {
    arrow: { idle: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABKklEQVRYhe2WwW2EMBBFX6TcKcElOB1QwpZACZTgElyC0wEl2B1QAqQCSvg5ZFkZskpQ1utL+JIP+DA8/T/MAKdOnTqmDhiACLjaL3eAdmcEmloAE6BhGOS9V9M0K8QCtDUABGjVOI4yxuRu9FUBJGlZFl0ulxxi4ImRfANY5ZzLISbAVgWQpBjjvi+6qgBrJNba3I1QFWBV3/f7T7VIJIcBJCmEsI+kLoAkTdOUO/GjXksQAszzzDzPpJRIKd2uS9Q+5ECMcT+ui03KwxG0bZsPpmLaAIQQZK39zYUizbcBcM5txm8I4S5ENg+KLarANlsBMsbc7f4shmJLqrkWc9dj+MpY3vub9V3X7Rvwqf8Lljuu8IfN+PIAhAfesucEvAMfD9Q8deof6hOsnwryWFSzPAAAAABJRU5ErkJggg==', hand: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAABGdBTUEAALGPC/xhBQAAAGNQTFRFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHx8fDw8PPz8/r6+vz8/Pb29vX19fj4+PT09PLy8vf39/39/f7+/vn5+fv7+/AAAA////DYTeEgAAABB0Uk5TH9/Pb08Pry+fj1/vfz+/ACsvpPYAAAEISURBVDjLldPZeoQgDAVgZ9wF0s7UcYfj+z9lNVCxil3ObX4/JCTR2y+J/giiqiTK1CUoBTjxBUiA5sOYAVBhkEHPa1rIMAC4Po+4/Qzm5/kMBgRjgcZdyoLoTkRqByo0FkwP+FQepMBkxfDshsGseQGp70PhrrFPg9KDBN0JjBCpb7XAeBId/4UDJdoT0CAPcvQnMAGRA6q4I3iGtKDia7/CZywgF4+2ngOpAQYU+NjGga2N1+CiXkMwEF9vecyAjEGBPnzG+zodfAv0enm/YyParZPKzXSvp29d4PGyrY6XCSLu1riry+NmpTHs/Buje1c/rF6ebQN3S8K7qZYVpELK/L/Le51PBtlY9mTYyj4AAAAASUVORK5CYII=', grab: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAABGdBTUEAALGPC/xhBQAAAGNQTFRFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAz8/PLy8vj4+P7+/vT09P39/fv7+/n5+fb29vDw8PHx8fX19fr6+vf39/Pz8/AAAA////n8emXQAAABB0Uk5Tb7+vT4+f7w8v389fH38/AJSR+VgAAADuSURBVDjLxZPLloMgEERNMiIvdR5GRcXi/78ykIgiMCe7mVr0pm+fhqIo2jcq/hioRF3XQja20hwgGQ59RIAbu2DSWq+YtR53YgOa5/D0Y6wGVxYQGQA325x1920OrWgC4ILZRFohAgC4x4DeDvECOD5jYAEPgBJDDBgFuQM3gjEBZhQeaJDp+x3Fc4E2GQEe4OhzwMsJB7B3wDW/YgLdAAG1pP0ebL9mCajEyg71YZRg+EpuGRhls0Si57qr01u0LSUnt/sJvDpHzkZi9OcYOoDROJOCAKuTcuG6VmloZekDy0v6S+wbJ/mvXy+nB/9TVAQYONXMAAAAAElFTkSuQmCC' },
    sharp: { idle: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABQUlEQVRYhe3XwW2EMBAF0I+UOyVQAiVQwpZACVsCdGA6QFRACbAVkA4oYbaDn0ucOMQLBsycdiRLHKzxwzBmAN7xN24AZgAE0ANItRfnYgiAQgsgAGiMoYiwLEsXUmoACIBuGGNcxF0dQJJt27qIVh1AktM0MU1Ti7js5XwJ8CCmKxCrAJKc55l5nruIXBVAkiLiIiQmIghgEUVRuIibKsBG7LNiN8CDMOoAMt5ZcRjgQRwq01MA8vxZcRrgQVTqAJLs+94C5q1FkwUAJPegXydOflIna/M+9iYex3FzTtM09vJzT+7NR7Co+ZCx2U0F70Bd1+i6DgCeAXf2BNAAeITmB1Z2YFHjUb+Am4BFWV3aG/4DiAizLFNpx7wA57s/XL048N2WD8NAkqyqyj1MVH5QKhwspdgIwe+2R+l03rEWX2YsXZU7iKZYAAAAAElFTkSuQmCC', hand: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAABGdBTUEAALGPC/xhBQAAAGNQTFRFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAT09PHx8fn5+f39/fLy8vX19fb29vf39/z8/P7+/vj4+PDw8Pv7+/r6+vPz8/AAAA////R5gMtgAAABB0Uk5TDz8fzy+vj+9Pn39v31+/AIpdPiYAAADsSURBVDjLxZNbl4IwDIRRQeh1VeSilE7+/69cehRs6qm+7c5rv9Nkkknx80XF3wGmslZ9ABSCVB7Q6IceNg8ALd2AMgtY3Ik6HD/0cCaaUWeBAhiJzpC7RkobZBKbFTqiAZEaDjSYiKj33g/D7Fq6QyeTrDFTrAk7DgicGNBDcKAEbjHQPi29lqXDKCJdYTigcGXABdUGFMIGYxxYJr8B5uGc26AIqJPybz8A7+9LD3YDNDrn3MgBD5n2MPmokgP2L5ulWPanA7M2Ok7PcLBUNwLwSyU3d1jzl8Re6XXbMncX5gAc7HH/D6eX1S9UW04FBwdA+QAAAABJRU5ErkJggg==', grab: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAABGdBTUEAALGPC/xhBQAAAGBQTFRFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA7+/vf39/b29vT09Pr6+vz8/P39/fj4+PLy8vHx8fn5+fX19fPz8/Dw8Pv7+/AAAA////E/uRlwAAAA90Uk5TT2+PLx/vD89ff6+/3z8AT34gawAAAMlJREFUOMvVk8kSgyAQRFHjxmLivgDN//9lsMooIFU520d4xUxPD6T5I/I8oGJAmXIgT6IAxaUkAEi5n6pV64/cRrOC+cALWKRCbw5pcB8QkMYTEAKtDywQQYnFBzbUHpBxjB6gkbtAbQ34L5j5qEEOD+3bxGuQqAerHtQF5hugkTo95JBjAExuiYZwqCFssnJtFmVATL9ZkytJt49BHQ9cQMGxnferCtPch2kD7WzceuoUQIv7wgh+bksp4itXVJQxRuvs2R8noi91AUmEYAFMOQAAAABJRU5ErkJggg==' },
    small: { idle: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA+klEQVRYhe2WwRHCIBBFPzZACZZACSnBEpIOKMESLCElaAcpgRIogXTwPRgcxKjESdaDvJm97n8zsAtApVIp4whgmKr5RTizOkkKeAB0zrHv+1SiB6AlBAiAEecctdZR4iwh8SBAkt57GmOihAOwFxUgyRBCKhEAGFGBKNG2bXovDqICLySsqEDEWrvZmBYJkJwbU1mBGYmjuABJDsMQBfyn5qpQACQXWSt1b/02Y7eoa8I4jui6Dkqp2Zq4fNs/ZfYImqbJH6i8HFZa008CycitFlIskNzyTddvSgDAEEL+ErYS4cBtq+Xnu9qSKUFPgXGuxT4ilcp/cAWokp6w3TPm0gAAAABJRU5ErkJggg==', hand: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAABGdBTUEAALGPC/xhBQAAAGNQTFRFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA39/fLy8vX19fn5+fT09PDw8Pb29vHx8fj4+Pv7+/7+/vr6+vz8/Pf39/Pz8/AAAA////tzc9bgAAABB0Uk5Tr2/vT1/Pvy8PH3/fj58/APK3gjMAAADaSURBVDjLzdPdsoIgFIZh987SRLRdaf6AL/d/lUkSg+xhOu075ZlhsdYiaz8k+ybQSAF1GuS8UqdACfd5nKFIgB/uZo1GJkCFtkBB2TY2MTiwWGAeuMgyKlKgLBjgsayBUwRqehNkhPMeFHQhMD1V1CjBHIILYg/O2fZQnz+aENS28ikEN9fVzFVA12sVgsm9YwNHriYOBADUJzDF57N7xvsKHYNlV+QBFq2HcfrfSj/NLYM7V917d3yj8qqSv+uobvb+K34xdktb5kc/7tRWNxLESRbf+bNSeQJ8ck3LJv41AwAAAABJRU5ErkJggg==', grab: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAABGdBTUEAALGPC/xhBQAAAF1QTFRFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAz8/P39/fHx8fDw8Pb29vf39/Pz8/X19f7+/vj4+PLy8vn5+fr6+vv7+/AAAA////7hJQLQAAAA90Uk5Tz48fTz8vr99fD5+/f+8AphdAVwAAAK9JREFUOMvlk9kOgyAQRW2tG1tbl7owd/7/M6WLCmjSD/AkvJAT5oYLiflDckbhogEUbonqQBBSYkVXsVAl7/2J+WGZ7yNULOSoLU09f2n3gobljRZ5LBQgT6A1xCKkn/kbNcpQ0Gh6XxiWGT/hhpEDCEUkdLGgA+EaRWALGWYQwOiH6OKQRmm8/AP0rovMMwbsb9KY0k2ZiGhonq7Oo7rV1qU6fg+Za1xKodLz/YsZER9EDgI2dGgAAAAASUVORK5CYII=' },
    toon: { idle: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAABGdBTUEAALGPC/xhBQAAAGNQTFRFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAT09Pr6+vHx8fn5+fb29vz8/Pj4+P39/fv7+/Ly8vPz8/X19fDw8Pf39/7+/vAAAA////hUkL9wAAABB0Uk5Tj29Pr18vH7+ff+/P3w8/AK5QtPIAAAETSURBVDjLlZPbmoMgDIStVlEEulateGJ8/6dckGqN1XZ3bvN/OUyS4PZFwV8AmTLGokzJMyDHUyK9qAMgw73Quqw6T+XpJaGAQDF56Ud/n6ErAYBpI6PHDkKeA04tFC1RfwYiPGh8BJd0iorE632TIToC2HEFKRFjoCXKAWDJxknAUMKMFgnkxmq9H9SMAM8WIMU4vanprevSAxn66UBNC+YBtRtjJQbIGUi82fVboc46Ol+UcF5WQLPrdMlwu2Lo3J5pCrP24OZw50QNs3GerEcrlXKVyg3Qg8e7q1YYzCbud07OPnp10S8rJUCyDmLzh0ePk+Fn6S8+/CzJnetFizw+eb34+Rvy9DdDYcPqv8/7Ub8qDVZlSNwk+QAAAABJRU5ErkJggg==', hand: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAABGdBTUEAALGPC/xhBQAAAGNQTFRFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHx8fDw8PPz8/r6+vz8/Pb29vX19fj4+PT09PLy8vf39/39/f7+/vn5+fv7+/AAAA////DYTeEgAAABB0Uk5TH9/Pb08Pry+fj1/vfz+/ACsvpPYAAAEISURBVDjLldPZeoQgDAVgZ9wF0s7UcYfj+z9lNVCxil3ObX4/JCTR2y+J/giiqiTK1CUoBTjxBUiA5sOYAVBhkEHPa1rIMAC4Po+4/Qzm5/kMBgRjgcZdyoLoTkRqByo0FkwP+FQepMBkxfDshsGseQGp70PhrrFPg9KDBN0JjBCpb7XAeBId/4UDJdoT0CAPcvQnMAGRA6q4I3iGtKDia7/CZywgF4+2ngOpAQYU+NjGga2N1+CiXkMwEF9vecyAjEGBPnzG+zodfAv0enm/YyParZPKzXSvp29d4PGyrY6XCSLu1riry+NmpTHs/Buje1c/rF6ebQN3S8K7qZYVpELK/L/Le51PBtlY9mTYyj4AAAAASUVORK5CYII=', grab: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAABGdBTUEAALGPC/xhBQAAAGNQTFRFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAz8/PLy8vj4+P7+/vT09P39/fv7+/n5+fb29vDw8PHx8fX19fr6+vf39/Pz8/AAAA////n8emXQAAABB0Uk5Tb7+vT4+f7w8v389fH38/AJSR+VgAAADuSURBVDjLxZPLloMgEERNMiIvdR5GRcXi/78ykIgiMCe7mVr0pm+fhqIo2jcq/hioRF3XQja20hwgGQ59RIAbu2DSWq+YtR53YgOa5/D0Y6wGVxYQGQA325x1920OrWgC4ILZRFohAgC4x4DeDvECOD5jYAEPgBJDDBgFuQM3gjEBZhQeaJDp+x3Fc4E2GQEe4OhzwMsJB7B3wDW/YgLdAAG1pP0ebL9mCajEyg71YZRg+EpuGRhls0Si57qr01u0LSUnt/sJvDpHzkZi9OcYOoDROJOCAKuTcuG6VmloZekDy0v6S+wbJ/mvXy+nB/9TVAQYONXMAAAAAElFTkSuQmCC' },
    gauntlet: { idle: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAABGdBTUEAALGPC/xhBQAAAG9QTFRFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAj4+PT09Pf39/29vbX19fLy8vr6+v2NjY+Pj46+vr8vLyPz8/0tLSDw8PHx8fn5+fb29vz8/P7+/v39/fzMzMAAAA////3KknjQAAAA50Uk5TH4+vb78/31/vzw+fLwBgKHyKAAAA40lEQVQ4y7XT2RaCMAwEUDf24r6ztUz+/xttUDQcor7oPHHKZQgUJvmXTH4CTAJkwQcQgxPO0zcgAFyzLaDXeGAAS2SrHddEqXKLEEviNLWviTMzAnOU9Eh18TWJrGGQAk0vyNXloKZ7Dxm2JLJfcY0RIEBhpSC3LpHJN5mgomEcQgki7Lrl8+bcC0CCNL6PeWjbw1EDfsyaV0+tjzsqwKDorruyuCqgH7OraDUQ4fKq0IAf0/G69ecbDeTT+5ikPyYfvHZMB/kC+8/Ajyk2xI7B49N8ZjYCZiHPD7b7/3/Wn8ENxmRP338BgM8AAAAASUVORK5CYII=', hand: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAABGdBTUEAALGPC/xhBQAAAVxQTFRFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAqKioJycngICAa2trenp6LCwsfn5+ZWVlw8PDJiYmGhoaHh4erKyspaWlDAwMn5+fVFRUOjo6/v7+mpqasbGx+/v7kJCQpqamvLy89vb2m5ubt7e3ubm59PT0MzMz8vLyg4ODc3NzmZmZGRkZDg4OOTk5+vr6Ly8vTExMX19fb29vT09P8fHxZmZm7e3t9/f37u7u9fX1/Pz8v7+/Pz8/DQ0Ns7Oz6+vr8/PzjIyM/f39f39/7Ozs29vb0NDQzc3NDw8P19fX4uLi1NTUzs7O6urq6enp3d3d4eHh2dnZr6+vHx8f09PT0dHR+fn58PDw1tbW2NjY3Nzc5+fn5eXl5OTk4ODg3t7e0tLS1dXV2tra39/f4+Pjz8/P6Ojo5ubm7+/vzMzMAAAA////w/2QKQAAABB0Uk5T339fbw+Pz0+vP58vH++/AFvDjWkAAAHfSURBVDjLhZPpV9pAFMWjbAkkM3bfV2tb7b661g1EBLRUC22TNlFBpSAhufP/n9OZAHYGjsf7Kefc37nvzXsvGr1AGjV1QnTjfMC0wKVlYoQQ8ZnMDAE6HDs7D0njKgDYjLEHFWy9fPEs/8R+BJhDQMCB4vOZtYK3uul3Tx/CkqtoBAvs8ZQ7XVhaLde69SU3mFcILQNcd1devQnK1XrDY0KLSMrPTAFzu95y1W8ExchngYOEBNCUhWu8uO+ygTpSoxwwY8CNI49JWoCulADuuLLPggoyZwDBrJ1tM1WlswjxCjYqHhHrAwZyI/b62vJTID1IcIbsz0Gt3jid3EA6HvWQhJPLObzRxaiRda/qd492j9v5DSTj0T2QwRorHcZWyrW68E8OWzYnTDEHahoGn4uhY7ZY2BTxP9s/DlsH+3dv861o/6cet5AX8cLf/vXt717z5i0QCaAJvPX78dz//afzNctvTQJSeMfjhX+wv9fkfvgFmgwY+NSLF/7O9zDcAuQeKMXH45OoPI/n/ntgjCqAhSg+Kh+GpWiYCkBwrzWI5/WjYStAAld5fK/8h/4yFGAMV3rxpdeANU5HAAOXmjsTl+fu87mnTToKxK3+Vqy0fJPyqMTiSCKl/N0X6B9xHOH3W6F8BQAAAABJRU5ErkJggg==', grab: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAABGdBTUEAALGPC/xhBQAAAWhQTFRFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKCgogoKCb29vj4+PTU1Nbm5uwsLCxcXFJycnGhoaOzs7Xl5eTExMrq6ukpKSlJSUKioqDAwMp6envr6+srKyLy8vDg4OnJyck5OTVlZWo6OjqKiovLy89PT0gICAMzMzOjo6jY2N/Pz8Z2dnxsbGmZmZGRkZr6+vqqqqDQ0Nn5+f8fHx8PDwtra29vb2/v7+ZmZm9fX1jIyM7u7u/f398vLyzMzM+Pj4Hx8fT09PHR0dPz8/9/f3+fn5+/v7f39/8/Pzzc3N3Nzcv7+/0tLSz8/Pzs7O7Ozs09PT0dHR5eXl7e3t4eHh4+Pj4ODg3t7e1dXVDw8P2NjY1tbW0NDQ19fX39/f4uLi2dnZ29vb5+fn6+vr5OTkX19f2tra3d3d6enp6urq1NTU6Ojo5ubm7+/vAAAA////J4p8DAAAABB0Uk5Tb0/fj19/P68Pzx8vv++fAIDFUDwAAAHjSURBVDjLhZPpV9NAFMXTNdskQdx3RQX3XUF2BITuxQpV6tKg0EJpbZvkzr/vTJOSTDke7od8yP2d++a9mSdZZ0iyNJkQOf1/QDPAFE/G2Vc2CTG1EUDG5nSljVCGLgLANKV01s518k/s7O1b2RGCAR4D1p7OrJTnH99z3P4dIHoiiWCcLhULi+W51WrX7c4VvYyQIenA9UL+2bpX7R318iyMejmoSqRN3cCNxnyt53Q3qC9vE4kIYCkGrrUc16MnqgB6CCgq6+3RboFGVAIJARP2+UrmVdSnnn0SIVnANvtTEQA6CzkC0NNi55SGgIr2qP160XsImAEQwwhRXK/2HHdqEqbit5kEMqG9Vq61ukfucWPhw2BevFLawIODwN/wuL/74/vB3/uM0AaApatBmaWVVR5/zP3D5s2r7Fb8syoyYOfapbe1FvcbP3997jT365evgATNWGnCH8sbP577e7/7X/5cwrBbJi1l4qXjlz9s7nN/ZxlxKfI2NGQH8dyvf/22vfWRXVoUYEP1y7N47r8DUpYAqFhg8X75nU+lwTAFgGAiiGf+sj9sAUjgYmcvKP8+uAwBSKHtxz9/wfYjaZ0C0hir92fOXbjLRjLcMAFQjOF2hQsoAFaMz5MkYsJ2n6F/D5nrbs+c8cIAAAAASUVORK5CYII=' },
    large: { idle: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAAABGdBTUEAALGPC/xhBQAAAGBQTFRFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAj4+PT09PX19ff39/n5+fHx8fr6+vz8/PLy8vb29v39/f7+/vDw8PPz8/v7+/AAAA////QhuJ3QAAAA90Uk5TT5+PX78fr98vf+/Pbw8AvrqYMwAAAURJREFUWMPtltuWgjAMRbmqBcoo4IVKk///y7FolcVgG8LbrOaFB1c32W2oJ6o3VhQAAfBvATLJsl2aswGygLEqJiB/rQfYSRYghnftDxyAaWDQP3eqxh+AWacQ1UDUWASgqYam8R2AmqThANA0XACShhtA0PAA/Bo+AOLNreEH4NmpQQBgf3VoUABODRrAagjJBViNUnIBVkPwAU+NYgMAe/PbFsBlG0C3ndlFFkA1x+51TzI3cbD3bME8Rv3t/eQ9GFsQ+cpR7mcHUK37mC7XYdLCaWmInID2MXd6NkQVFaBRHc1z3kJJAZQwqbNnDJcA1RTQzU6SlA9sC+OztctPQFWoZWz+oMu0TmwLqn3eJhCty0jSrGmwv93BkVlcIUtMtwP2YnVK+6QdgCzixLzUfoNJzsyJh/hxFlkqQ1YOgADw1i9XzBN/ZZRL0AAAAABJRU5ErkJggg==', hand: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAAABGdBTUEAALGPC/xhBQAAAGNQTFRFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHx8fj4+PLy8vT09Pb29vr6+vPz8/z8/Pn5+f39/fX19f7+/vv7+/Dw8Pf39/AAAA////I/L0jAAAABB0Uk5Tr59PH3/PD19vj98/L7/vAGFgATcAAAJKSURBVFjD5ZfbgoIgEIbRSkWFtszME/D+T7kOpnLSYPdu978qk6+B+WcAdP2l0N8D4AsHkfRngJTwRZcyHFDkXBEtQwEZ1+VH2ACxHDWyYdLrDp/zMICM/9GLWQ/4hkMABYx4iVWSkAQAoun9Tih6Tg+yAACd3m9VwA1yGQCAiNXxoocnp18AROW1jEhNQq8Baq9MaotY6yGM0yMwU1IU5zMhVBoljw7S+NQBkMmcXAyDclLuG0lLg2i4WzR1AvD0E9NDuO8QeOkCnKYfvnTAbX79WbHb0My5HToZg7MaYbKDbgU2lZYwJAnZXjl34rMqLQQFkEA1958B/aiGoHYkpNfjrl6QSxcgta3gVKtWiQqAORhW2F8F7OrKkW2F3TnkLkBsW8EtWMbYtS9QywpuQZUgFwB7WqHdGqYOKD2toDRMBVDgueRfQcu49YO17n2s0C/NZgWo+5qPFbplDmgz4SoWYucZkMjJd++iF555oBsAjgVf/qNB8I8rQO6LtQgGlAsg8lx7E1AsABoegB4Bt3YlPzNfVUBgALWWhR8AOs0HvlVsdIRiBRDPKt4tJmnkIB89166IViePrf/4Ztsg0VZLI+tDAiBaS8PzKbNjs4bjaG6LDZV+gI0N/P5ojicQmW09JuYhoNrJbAMppI6dKbUOM51rUYZRmYDRlcvsLIUWlL2uvTwe8PTTlSdZwtERLRuN8Qd3ppi+EdW70mt2Pzxk2VGc3Sesy8n71pZgag3Ps6BrX5Lp2SVx+L2xzN5h5Lg4/Yurb7C+Ae2BcQ7NXSPKAAAAAElFTkSuQmCC', grab: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAAABGdBTUEAALGPC/xhBQAAAGNQTFRFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAj4+PX19fr6+vz8/PLy8vDw8PHx8fb29v39/fn5+fT09P7+/vPz8/v7+/f39/AAAA////wPVr6gAAABB0Uk5Tnx9v318vT4+vz+9/Pw+/APYd37wAAAHySURBVFjD7ZfZkoMgEEVxNyomatwX+P+vHBaToIJ0JjVPk/tEBTglvcANun4o9AX8L0CQvQlwogvhSvI08+NEjlEIBeCI6JVjEABfiEkXfA7AfpznuXk/+4ZTQKysXDrKVA1sOJRiWIjffTMgU/fPdNVMhsewqtmEZwRk6pdOVKeSTwUGQCBy1RTLsrQNWbQAemdLUj0Ai/13ua5bRj1gMQN8vr+gFp0AkPHgquZdIhVAzjNnBXS8lsyA2Qqg/KBYC+A1cLMDJrYs1AJSNtPaATyKSAsIX0k8U7U9gwJw+MxoJzRsmasBYNEHPewM3hHgiw6uKwpK5KsdHgBXlDEgi2seoj3A42U4gvbTXq0l9F4AhUa+eAfgJxgoVLylsy0gBvWBGoQdANgHSiI1gP5TQAsGFEcAb6TmrRgEW0BAYL0sVR/TKAoJGoVSvdWQ0susFDpoCA6lfF1f4wFYiMGxnVNJuP22ndnDJk1EBenmSPu0YZ8jaktPDcYr7XkrjLZeVp8mpLEHreVhMr1ML2tTnpYASZwThyKfaANhbG0O5VlRuruha2uyC4DWpcmKanZl3fXT6lxcq81ba7Ie+lmI+ZWpeRgfLwMYTTcxWrwUg5xqkGt3J5ED9sobvycN6tEmW8x2mOarUBpm338sX8DfAn4AxaBbZjATF9IAAAAASUVORK5CYII=' }
  };
  if (prefs.cursor !== 'system' && !CURSORS[prefs.cursor]) prefs.cursor = 'satellite';
  function paintCursor() {
    const root = document.documentElement.style, set = CURSORS[prefs.cursor];
    const at = (part, spot, then) => 'url("' + (CURSOR_PICS[prefs.cursor] || {})[part] + '") ' + spot[0] + ' ' + spot[1] + ', ' + then;
    const want = prefs.cursor === 'system' ? { '--cur': 'default', '--cur-hand': 'pointer', '--cur-grab': 'grabbing', '--cur-text': 'text' }
      : set ? { '--cur': at('idle', set[0], 'default'), '--cur-hand': at('hand', set[1], 'pointer'), '--cur-grab': at('grab', set[2], 'grabbing'), '--cur-text': at('idle', set[0], 'text') }
      : null;
    for (const k of ['--cur', '--cur-hand', '--cur-grab', '--cur-text']) { if (want) root.setProperty(k, want[k]); else root.removeProperty(k); }
  }
  paintCursor();
  $('optCursor').value = prefs.cursor;
  $('optCursor').onchange = e => { prefs.cursor = e.target.value; save(); paintCursor(); };
  // The live map and the raid history page keep their settings apart: the live map's as "livemap", the history
  // page's as "satelliteHistory", so neither changes the other. Only the language is one for both (lang.js reads it
  // from the live map's). The first time the history page is opened after they were split, it takes over only what
  // was its own of the settings they shared (a replay's speed, its panels, trails, minimap and kill marks).
  function read() {
    try {
      const own = localStorage.getItem(STORE);
      if (!HIST) return JSON.parse(own || '{}') || {};
      const live = JSON.parse(localStorage.getItem('livemap') || '{}') || {};
      let mine = own ? JSON.parse(own) || {} : null;
      if (!mine) {
        mine = {};
        for (const k of Object.keys(live)) {
          if (/^hp/.test(k) || ['mapDifficulty', 'mapPersonality', 'minimap', 'killKeep', 'trailMs', 'eventsKind', 'mapDoing', 'orbitMain', 'orbitRush', 'orbitLines', 'orbitNames', 'orbitHear', 'orbitFights'].includes(k)) mine[k] = live[k];
        }
      }
      // Earlier builds kept the replay name filter in hpBotNames alongside live settings.
      if (mine.hpBotNames !== undefined) {
        if (mine.names === undefined) mine.names = mine.hpBotNames;
        delete mine.hpBotNames;
      }
      if (live.lang) mine.lang = live.lang;
      else delete mine.lang;
      return mine;
    } catch (e) { return {}; }
  }
  function save() {
    try {
      for (const key of NOT_BLACK) if (prefs.cols && blackRefused(key, prefs.cols[key])) delete prefs.cols[key];
      localStorage.setItem(STORE, JSON.stringify(prefs));
      // (a language picked on the history page: the live map's too, as that's where lang.js reads it)
      if (HIST) {
        const live = JSON.parse(localStorage.getItem('livemap') || '{}') || {};
        if (live.lang !== prefs.lang) {
          if (prefs.lang) live.lang = prefs.lang;
          else delete live.lang;
          localStorage.setItem('livemap', JSON.stringify(live));
        }
      }
    } catch (e) { /* private window */ }
  }

  // ---- state ---------------------------------------------------------------------------------------------------
  let maps = [];
  // the add-ons there are that aren't installed: [{ loc, base, name, vname, zip }]
  let addons = [];
  let mapsPrint = '';
  // the stream brings the games, the maps' mark and the loot (see listen): nothing to keep asking for meanwhile
  let streamUp = false;
  let mapsAsked = false;
  let map = null;
  let vw = 1, vh = 1;
  let zoom = 1, zoomTarget = 1, zoomMin = 1, zoomMax = 10;
  let panX = 0, panY = 0;
  let zoomAt = null;            // the screen point a zoom holds still
  let dirty = true;

  let sid = '';                 // whose game
  let streamFor = null;         // the game the server is asked to pass on ('' : every game)
  const sessions = new Map();   // id -> { heard, raid }
  let games = [];               // the games the server hears from: { sid, name, raid }
  let report = null;            // that game's last full report
  let heard = 0;                // when it was last heard from
  let live = [];                // its markers, in drawing order
  let liveById = new Map();
  let me = null;                // the player: { x, y, z } wanted, { cx, cy, cz } drawn, in: under a roof
  let raidKey = '';
  let pointed = null;
  let drawn = [];
  let serverLost = false;
  let zoomState = null;         // auto zoom: true indoors, false outdoors, null not applied yet
  let stateWanted = null, stateSince = 0;
  let tiles = [];               // the map's tiles: { img, col, row, at, want }
  let tilesPrint = '';
  // the floor shown: of one building (place), over the view from above; place 0 is none
  let floorShown = { place: 0, n: 0 };
  let floorWantKey = '0:0', floorSince = 0;
  let floorEl = null;           // that floor's own tiles, cut to the building's shape
  let floorTiles = [];
  let floorEdge = [];           // the outline of where that floor is: [east, north, east, north] lines
  let floorOwn = [];            // in a building: the outline of the floor shown itself, where it's less than the building
  let period = 100;             // milliseconds between the game's reports, about
  let told = 0;
  let places = null;            // where things stand on the map shown: { loc, boxes, locks, spawns, names }
  let lootTable = null;         // where loot can spawn on it and what, from the server's loot tables (see readSpawns)
  let lootAsked = '', lootAskedAt = -1e9;
  let placesAsked = '', placesAskedAt = 0;
  // the server said it has none for that map: not asked again until the maps change (loadMaps)
  let placesNone = false, lootNone = false;
  let things = null;            // what lies about in the raid shown: { loc, loose, inside, open, names }
  let thingsWanted = 0, thingsHave = -1, thingsAsking = false, thingsTriedAt = 0;
  let thingsDrawn = [];         // what of it is on the screen, to point at: { x, y, r, tip }
  let thingsPut = [];
  let corpsesNow = null;        // the corpses, each marker with the body it left (see drawThings); null: markers only
  let tipFor = null;
  // the player's started quests: { sid, list: [{ id, name, trader, loc, goals }], zones: { zone id: quest name }, names }
  let quests = null;
  // a recorded raid being played back (see "raid history"): the live game is set aside meanwhile
  let replay = null;
  const REPLAY_SID = 'replay';
  // the items on the player's wishlist (a Set of templates; null while not known, or from a server that doesn't say),
  // and the same as text, so what's worked out from it is worked out again when it changes
  // wishGroup: tpl -> its wishlist group, as the game numbers them (0 Tasks, 1 Hideout, 2 Barter, 3 Equipment, 4 Other);
  // empty from a server that doesn't say
  let wish = null, wishPrint = '', wishGroup = new Map();
  // the player's keys (with the quests): key template -> 1 with them, 2 in their stash
  let myKeys = {}, myKeysPrint = '';
  let questsAsking = false, questsAskedAt = -1e9, questsFor = '';
  let questsPrint = null;
  let find = '';                // what the search box asks for, lower case; '' for nothing
  // The menu: one panel with a tab each for the raid, its loot, the quests, the map and the settings.
  // (raid history has a page of its own, with its own settings: the live map's menu has no tab for it)
  const TABS = ['raid', 'loot', 'quests', 'map', 'presets', 'settings'];
  let tab = TABS.includes(prefs.tab) ? prefs.tab : 'raid';
  // A phone, upright or on its side: the menu is a sheet (from the bottom, or down the right), and the map's buttons
  // are round ones down its right edge (see placeQuick).
  const phone = window.matchMedia('(max-width: 700px), (max-height: 520px)');
  // (the map picker says "Connecting…" at once: see mapBtnSays)
  if (!HIST) document.getElementById('mapBtnText').textContent = T('Connecting…');
  // how many pixels are drawn to a point of the screen. A phone's has three or four, and drawing every one each
  // frame is slow there: two at most, unless "Lighter drawing on a phone" is off
  const pixelRatio = () => {
    const real = window.devicePixelRatio || 1;
    return phone.matches && prefs.phoneLight !== false ? Math.min(2, real) : real;
  };
  // how much of the screen that sheet covers, in pixels: what's followed is kept in the middle of the rest
  let cover = { r: 0, b: 0 };
  let flash = null;             // a spot just gone to, ringed for a moment: { x, y, at }
  // Following is what the player asked for (prefs.follow) and is kept; dragging the map, or going to look at
  // something, only sets it aside (roaming) until Follow is pressed again or the player has walked on.
  let roaming = false, roamFrom = null;
  const following = () => prefs.follow && !roaming;
  function roam() {
    if (!prefs.follow || roaming) return;
    keepFollowZoom();
    roaming = true;
    roamFrom = me ? [me.x, me.y] : null;
    dirty = true;
  }
  // Somebody else followed: a bot pressed on the map or in the Raid list. Kept until the map is dragged, something
  // else is pressed, or they're gone from the raid; then the map goes back to following the player (when it does).
  let chased = null;
  // A building pressed on the map: looked inside (its floors shown) until somewhere off it is pressed or the map goes
  // back to the player. hovered: the building under the pointer that a press would open; both as places (BUILDING+i).
  let opened = 0, hovered = 0;
  // the building the player is in, when its inside was pressed away: not shown again until they leave it
  let insideShut = 0, insideShutAt = null;
  // the building in the middle of the screen, when its inside was pressed away: not shown again until the middle is
  // on another building (or none), or it's pressed
  let lookShut = 0;
  // a floor stepped to with the badge's arrows: { place, n }, kept while that building is the one shown
  let floorPick = null;
  // every building outlined (see drawHovered): while the button or B is held; a quick press leaves them outlined
  // until a building is pressed, or the button (or B) again
  let revealHeld = false, revealOn = false, revealDownAt = 0;
  const revealing = () => revealHeld || revealOn;
  const revealSet = on => { revealOn = on; $('reveal').classList.toggle('on', on); dirty = true; };
  function revealDown() {
    if (revealHeld) return;
    revealHeld = true;
    revealDownAt = performance.now();
    dirty = true;
  }
  // let go: a quick press switches the outlines on (or off again), a long hold is over
  function revealUp() {
    if (!revealHeld) return;
    revealHeld = false;
    revealSet(performance.now() - revealDownAt < 400 ? !revealOn : false);
  }
  // how far (metres) the player walks before a look about ends and the map is back on them
  const WALK_BACK = 1.5;
  function chase(id) {
    if (chased === id) return;
    if (chased === null && id !== null) keepFollowZoom();
    chased = id;
    rosterPrint = null;
    dirty = true;
    if (id === null) backToPlayer();
    // (a replay's Why tab: about the one followed now)
    if (HIST && prefs.hpTab === 'bots') hpSideShow();
    if (HIST && replay && prefs.hpActions) showActionOverlay(replay);
  }
  // The zoom the player was being followed at, before the map was taken off them (a drag, a look at something,
  // somebody else followed): put back when it returns to them. Without auto zoom only; with it, the zoom is the one
  // for indoors or outdoors, as ever.
  let followZoom = null;
  function keepFollowZoom() {
    if (followZoom === null && prefs.follow && !roaming && chased === null) followZoom = zoomTarget;
  }
  function backToPlayer() {
    if (!prefs.follow || roaming || chased !== null) return;
    if (followZoom !== null && !prefs.autoZoom && !prefs.keepZoom) { zoomTarget = followZoom; zoomAt = null; }
    if (prefs.autoZoom && !prefs.keepZoom) zoomState = null;
    followZoom = null;
    dirty = true;
  }

  // ---- places --------------------------------------------------------------------------------------------------
  // The map can be turned a quarter at a time (turn: degrees anticlockwise), so it's the way up the maps people know
  // have it. The game's own x runs east and its z north; each location is turned as tarkov.dev turns it.
  const TURNS = {
    bigmap: 180, factory4_day: 90, factory4_night: 90, Interchange: 180, laboratory: 270, Labyrinth: 270, Lighthouse: 180,
    RezervBase: 180, Sandbox: 180, Sandbox_high: 180, Shoreline: 180, TarkovStreets: 180, Woods: 180
  };
  let turn = 0;
  const turnFor = loc => {
    const picked = prefs.turns && prefs.turns[loc];
    return [0, 90, 180, 270].includes(picked) ? picked : TURNS[baseOf(loc)] || 0;
  };
  // the game's [east, north] as the screen has it, turned, and back
  function spin(x, y) {
    return turn === 90 ? [-y, x] : turn === 180 ? [-x, -y] : turn === 270 ? [y, -x] : [x, y];
  }
  function unspin(a, b) {
    return turn === 90 ? [b, -a] : turn === 180 ? [-a, -b] : turn === 270 ? [-b, a] : [a, b];
  }
  // the map's edges, turned: { min: { x, y }, max: { x, y } }
  function view() {
    const a = spin(map.min.x, map.min.y), b = spin(map.max.x, map.max.y);
    return { min: { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]) }, max: { x: Math.max(a[0], b[0]), y: Math.max(a[1], b[1]) } };
  }
  function toScreen(x, y) {
    const [a, b] = spin(x, y);
    return [vw / 2 + panX + zoom * a, vh / 2 + panY - zoom * b];
  }
  function toMap(sx, sy) {
    return unspin((sx - vw / 2 - panX) / zoom, -(sy - vh / 2 - panY) / zoom);
  }
  function centreOn(x, y) {
    const [a, b] = spin(x, y);
    const nx = -zoom * a - cover.r / 2, ny = zoom * b - cover.b / 2;
    // (drawn again only when that moves the map: following somebody standing still, every frame, kept it drawn
    // sixty times a second for nothing. Within a little over half a pixel is where it is already: the map is put on
    // whole pixels once it's still, see frame)
    if (Math.abs(nx - panX) < 0.6 && Math.abs(ny - panY) < 0.6) return;
    panX = nx;
    panY = ny;
    dirty = true;
  }
  function setZoomLimits() {
    if (!map) return;
    const v = view();
    zoomMin = Math.min(vw / (v.max.x - v.min.x), vh / (v.max.y - v.min.y)) / ZOOM_MIN_DIVIDER;
    zoomMax = Math.max(zoomMin * 10, ZOOM_CLOSEST);
  }
  // The map can't be moved off the screen: no more than a thin strip of nothing shows past its edge, and a map
  // smaller than the screen sits in the middle.
  function keepOnMap() {
    if (!map) return;
    const slack = 48;
    const v = view();
    // (the map stays in the middle of the screen whether the menu is open or not: opening it doesn't move the map.)
    // But it can be dragged on until its edge is clear of what's laid over it (the menu, the Raid list, the bar along
    // the top, a phone's sheet), so no part of it is stuck underneath.
    const { left, right, top, bottom } = overMap();
    // Along each way: smaller than the room between them, it's held between the middle of the screen and the middle
    // of that room; bigger, its edges are kept clear of them, the middle of the screen always allowed too. The two
    // meet where the map is just as big as the room, so zooming across that size never makes it jump (it did: from
    // the screen's middle to the room's, half the difference of what's laid over each side).
    const keep = (p, mid, lo, hi) => lo >= hi
      ? Math.min(Math.max(p, Math.min(mid, (lo + hi) / 2)), Math.max(mid, (lo + hi) / 2))
      : Math.min(Math.max(p, Math.min(lo, mid)), Math.max(hi, mid));
    panX = keep(panX, -zoom * (v.min.x + v.max.x) / 2, vw / 2 - slack - right - zoom * v.max.x, slack - vw / 2 + left - zoom * v.min.x);
    panY = keep(panY, zoom * (v.min.y + v.max.y) / 2, vh / 2 - slack - bottom + zoom * v.min.y, slack - vh / 2 + top + zoom * v.max.y);
  }
  // how far in from each side of the screen what's laid over the map reaches (pixels); measured at most four times a
  // second, as measuring makes the page lay itself out
  let overAt = -1e9, overWas = null;
  function overMap() {
    const now = performance.now();
    if (overWas && now - overAt < 250) return overWas;
    overAt = now;
    const out = overWas = { left: 0, right: 0, top: 0, bottom: 0 };
    for (const id of ['panel', 'side', 'bar']) {
      const el = $(id);
      if (!el || el.hidden) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      // across the screen (most of its width): along the top or the bottom (a phone's sheet); else down one side
      if (r.width > vw * 0.6) {
        if (r.top + r.height / 2 < vh / 2) out.top = Math.max(out.top, r.bottom);
        else out.bottom = Math.max(out.bottom, vh - r.top);
      } else if (r.left + r.width / 2 > vw / 2) out.right = Math.max(out.right, vw - r.left);
      else out.left = Math.max(out.left, r.right);
    }
    out.bottom = Math.max(out.bottom, cover.b);
    return out;
  }
  // the part of the map that's on the screen, in screen pixels
  function mapBox() {
    const v = view();
    const left = vw / 2 + panX + zoom * v.min.x, right = vw / 2 + panX + zoom * v.max.x;
    const top = vh / 2 + panY - zoom * v.max.y, bottom = vh / 2 + panY - zoom * v.min.y;
    return { left: Math.max(0, left), top: Math.max(0, top), right: Math.min(vw, right), bottom: Math.min(vh, bottom) };
  }
  // turns the map, keeping what's in the middle of the screen there
  function setTurn(next) {
    if (!map || next === turn) return;
    const mid = toMap(vw / 2, vh / 2);
    turn = next;
    setZoomLimits();
    zoom = zoomTarget = Math.min(Math.max(zoomTarget, zoomMin), zoomMax);
    centreOn(mid[0], mid[1]);
    tilesPrint = '';
  }
  function wholeMap() {
    if (!map) return;
    roam();
    zoom = zoomTarget = zoomMin;
    centreOn((map.min.x + map.max.x) / 2, (map.min.y + map.max.y) / 2);
  }
  function zoomBy(times, sx, sy) {
    zoomTarget = Math.min(Math.max(zoomTarget * times, zoomMin), zoomMax);
    // (about the middle while somebody is followed: held at the pointer, the zoom moved the map one way and keeping
    // them in the middle the other, frame by frame, and it shook)
    zoomAt = (following() && inRaidHere()) || chased !== null ? null : [sx, sy];
    // with auto zoom on, zooming by hand while the player is followed says how close "indoors" or "outdoors" is;
    // zooming while looking about doesn't
    if (autoZooming() && zoomState !== null && chased === null) {
      const key = zoomState ? 'spanIn' : 'spanOut';
      prefs[key] = clampSpan(Math.min(vw, vh) / zoomTarget, zoomState ? SPAN_IN : SPAN_OUT, prefs[key]);
      showSpans();
    } else prefs.zoom = (zoomTarget - zoomMin) / (zoomMax - zoomMin);
    // (kept once the wheel has stopped, not at every turn of it: each save writes every setting, and a zoom going on
    // stuttered)
    clearTimeout(zoomBy.saving);
    zoomBy.saving = setTimeout(save, 400);
  }
  // the zoom sliders: closer to the right
  function showSpans() {
    $('optSpanIn').value = -prefs.spanIn;
    $('optSpanOut').value = -prefs.spanOut;
    $('spanInText').textContent = Math.round(prefs.spanIn) + ' m';
    $('spanOutText').textContent = Math.round(prefs.spanOut) + ' m';
  }
  function autoZooming() {
    return prefs.autoZoom && !prefs.keepZoom && following() && chased === null && !!me && me.in !== undefined && inRaidHere();
  }
  // so many metres across the screen's short side: 30 indoors and 180 outdoors, until set otherwise
  function stateZoom(inside) {
    const z = Math.min(vw, vh) / (inside ? prefs.spanIn : prefs.spanOut);
    return Math.min(Math.max(z, zoomMin), zoomMax);
  }

  // ---- the maps ------------------------------------------------------------------------------------------------
  // {"loc","v","min":[east,north],"tile","px","cols","rows"}: tile is a tile's side in metres; column 0 is the
  // westernmost, row 0 the southernmost
  // "small": every tile is there a second time, small ("_s"). "floors": what's under the roofs, see readFloors.
  function readMap(raw) {
    const ok = raw && typeof raw.loc === 'string' && Array.isArray(raw.min) && raw.tile > 0 && raw.cols > 0 && raw.rows > 0;
    if (!ok) return null;
    const zones = (Array.isArray(raw.zones) ? raw.zones : []).filter(z => z && Array.isArray(z.p) && z.p.length);
    // "base": the location; "name": the game's name for it; "vname": the version's, when a mod swapped one in
    const base = typeof raw.base === 'string' && raw.base ? raw.base : baseOf(raw.loc);
    const version = noSnow(raw.loc).split('~')[1];
    // a version known only by its scenes is kept by their hash (8 hex digits)
    const vname = typeof raw.vname === 'string' && raw.vname ? raw.vname
      : /^[0-9a-f]{8}$/.test(version || '') ? T('another version') : version || '';
    const title = PLACES[base] || (typeof raw.name === 'string' && raw.name ? T(raw.name) : base);
    // (MapVariants names a version after its map, "Customs - Classic": said as Customs (Classic))
    const short = variantShort(title, vname);
    return {
      loc: raw.loc, v: raw.v, base, title, vname, name: title + (short ? ' (' + short + ')' : ''), tile: raw.tile, cols: raw.cols, rows: raw.rows,
      small: !!raw.small, floors: readFloors(raw.floors),
      rawZones: zones.filter(z => z.k !== 'claymore' && !z.off),
      zones: zoneAreas(zones.filter(z => z.k !== 'claymore' && !z.off)),
      fields: mineFields(zones.filter(z => z.k === 'claymore').map(z => z.p[0])),
      min: { x: raw.min[0], y: raw.min[1] },
      max: { x: raw.min[0] + raw.cols * raw.tile, y: raw.min[1] + raw.rows * raw.tile }
    };
  }

  // Zones of one kind that overlap, as one area: { k, flare, zones: [{ p, q }], x, y } (x, y: the middle of where
  // it kills). A zone the game had switched off isn't one.
  function zoneAreas(zones) {
    const box = z => {
      const xs = z.p.map(p => p[0]), ys = z.p.map(p => p[1]);
      return [Math.min(...xs) - 2, Math.min(...ys) - 2, Math.max(...xs) + 2, Math.max(...ys) + 2];
    };
    const boxes = zones.map(box);
    const group = zones.map((z, i) => i);
    const root = i => { while (group[i] !== i) i = group[i] = group[group[i]]; return i; };
    for (let i = 0; i < zones.length; i++) {
      for (let j = i + 1; j < zones.length; j++) {
        const a = boxes[i], b = boxes[j];
        const same = zones[i].k === zones[j].k && !!zones[i].flare === !!zones[j].flare;
        if (same && a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]) group[root(i)] = root(j);
      }
    }
    const areas = new Map();
    zones.forEach((z, i) => {
      const r = root(i);
      if (!areas.has(r)) areas.set(r, { k: z.k, flare: !!z.flare, zones: [] });
      // where it kills: outlines the game decided spot by spot (newer captures; none: nowhere), else a rectangle
      const kill = Array.isArray(z.kill) ? z.kill.filter(loop => Array.isArray(loop) && loop.length > 2)
        : [Array.isArray(z.q) && z.q.length ? z.q : z.p];
      areas.get(r).zones.push({ p: z.p, kill });
    });
    return [...areas.values()].map(area => {
      const killing = area.zones.flatMap(z => z.kill).flat();
      const all = killing.length ? killing : area.zones.flatMap(z => z.p);
      const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
      return Object.assign(area, { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 });
    });
  }

  // Claymores that lie near one another, as fields: { mines: [[east, north], ..], x, y } (x, y: the middle)
  function mineFields(points) {
    const group = points.map((p, i) => i);
    const root = i => { while (group[i] !== i) i = group[i] = group[group[i]]; return i; };
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        if (Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]) < MINE_TOGETHER) group[root(i)] = root(j);
      }
    }
    const fields = new Map();
    points.forEach((p, i) => {
      const r = root(i);
      if (!fields.has(r)) fields.set(r, []);
      fields.get(r).push(p);
    });
    return [...fields.values()].map(mines => ({
      mines, x: mines.reduce((s, p) => s + p[0], 0) / mines.length, y: mines.reduce((s, p) => s + p[1], 0) / mines.length
    }));
  }

  // {"n","cell","min":[east,north],"wide","tall","grid":[place,squares,..],"levels":[[height,..],..],"tiles":[[tile,..],..]}
  // The ground is cut into squares of "cell" metres, row by row from the south-west; grid says which roofed place
  // each is in (0: out in the open) as runs of the same place. levels: each place's floors' heights, lowest first.
  // tiles: for each floor, the tiles that have a picture of it ("_f<floor>"). has (newer captures): which floors each
  // square has ground on, one bit each, as runs like grid's.
  function readFloors(raw) {
    const ok = raw && raw.n > 0 && raw.cell > 0 && raw.wide > 0 && raw.tall > 0 && raw.wide * raw.tall < 5e7
      && Array.isArray(raw.min) && Array.isArray(raw.grid) && Array.isArray(raw.levels) && Array.isArray(raw.tiles);
    if (!ok) return null;
    const unpack = runs => {
      const squares = new Uint32Array(raw.wide * raw.tall);
      let at = 0;
      for (let i = 0; i + 1 < runs.length && at < squares.length; i += 2) {
        const run = Math.max(0, runs[i + 1] | 0);
        if (runs[i]) squares.fill(runs[i], at, at + run);
        at += run;
      }
      return squares;
    };
    return {
      n: raw.n, cell: raw.cell, x: raw.min[0], y: raw.min[1], wide: raw.wide, tall: raw.tall, grid: unpack(raw.grid),
      squares: Array.isArray(raw.has) ? unpack(raw.has) : null, levels: raw.levels, boxes: new Map(), buildings: readBuildings(raw.buildings),
      has: raw.tiles.map(list => new Set(Array.isArray(list) ? list : []))
    };
  }
  // "buildings" (newer maps): [{"l":[loop,..],"parts":[{"n","h","t","a","l":[loop,..]},..]},..]. Each building's
  // footprint, and each floor's part of it: the floor's number (as its pictures are numbered), the floor's height,
  // its ceiling's, its size in square metres. A loop is [east, north, east, north, ..]. Where a map has them they're
  // gone by instead of the squares: they follow the walls, keep two buildings side by side apart, and leave out what
  // is only a roof (a canopy, a gantry).
  function readBuildings(raw) {
    if (!Array.isArray(raw)) return null;
    const loops = l => (Array.isArray(l) ? l : []).filter(p => Array.isArray(p) && p.length >= 6 && p.every(Number.isFinite));
    const boxOf = l => {
      const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (const loop of l) {
        for (let i = 0; i + 1 < loop.length; i += 2) {
          box.x0 = Math.min(box.x0, loop[i]); box.x1 = Math.max(box.x1, loop[i]);
          box.y0 = Math.min(box.y0, loop[i + 1]); box.y1 = Math.max(box.y1, loop[i + 1]);
        }
      }
      return box;
    };
    const out = [];
    for (const b of raw) {
      const l = loops(b && b.l), parts = [];
      for (const p of (b && Array.isArray(b.parts) ? b.parts : [])) {
        const pl = loops(p && p.l);
        if (pl.length && p.n > 0 && Number.isFinite(p.h)) parts.push({ n: p.n | 0, h: p.h, t: Number.isFinite(p.t) ? p.t : p.h + 3, a: +p.a || 0, l: pl, box: boxOf(pl) });
      }
      // (with the ground round it and the floor one walks into from there, as the capture measured them: see floorName)
      if (l.length && parts.length) out.push({ l, parts, box: boxOf(l), size: loopsArea(l), floors: [...new Set(parts.map(p => p.n))].sort((a, b) => a - b),
        g: Number.isFinite(b.g) ? b.g : undefined, gn: Number.isFinite(b.gn) && b.gn > 0 ? b.gn | 0 : undefined });
    }
    return out.length ? out : null;
  }
  // a building's number as a "place" (see floorShown): this and up, so it's never taken for a place of the squares
  const BUILDING = 1000000;
  // whether a spot is within loops (a loop within a loop is a hole)
  function inLoops(loops, x, y) {
    let inside = false;
    for (const loop of loops) {
      for (let i = 0, j = loop.length - 2; i < loop.length; j = i, i += 2) {
        const ay = loop[i + 1], by = loop[j + 1];
        if ((ay > y) !== (by > y) && x < loop[i] + (loop[j] - loop[i]) * (y - ay) / (by - ay)) inside = !inside;
      }
    }
    return inside;
  }
  const inBox = (box, x, y) => x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;
  // the ground loops cover, in square metres (a hole's loop runs the other way round, so it takes its area off)
  function loopsArea(loops) {
    let a = 0;
    for (const loop of loops) for (let i = 0, j = loop.length - 2; i < loop.length; j = i, i += 2) a += loop[j] * loop[i + 1] - loop[i] * loop[j + 1];
    return Math.abs(a / 2);
  }
  // The building a spot is within the walls of, as a place; 0: none. Buildings can lie over one another (Ground
  // Zero's car park is one of its own, under the towers round its plaza): the smallest there is taken, or, given a
  // height (somebody's), the smallest with a floor they're on.
  function buildingAt(x, y, z) {
    const list = map && map.floors && map.floors.buildings;
    if (!list) return 0;
    // best: any; near: one with a floor they're taken to be on; on: one with a floor right under their feet there
    let best = 0, near = 0, on = 0;
    const smaller = (i, than) => !than || list[i].size < list[than - BUILDING].size;
    for (let i = 0; i < list.length; i++) {
      if (!inBox(list[i].box, x, y) || !inLoops(list[i].l, x, y)) continue;
      if (smaller(i, best)) best = BUILDING + i;
      if (z === undefined || !buildingFloor(BUILDING + i, x, y, z)) continue;
      if (smaller(i, near)) near = BUILDING + i;
      if (smaller(i, on) && list[i].parts.some(p => p.h <= z + 1 && z < p.t - 0.1 && inBox(p.box, x, y) && inLoops(p.l, x, y))) on = BUILDING + i;
    }
    return on || near || best;
  }
  // The floor of a building that somebody at a spot in it, at a height, is on; 0: not in it (on its roof, under it).
  // Of the floors with a part at that spot, the highest whose floor is under their feet, or no more than a step
  // over them (on the stairs up, the floor above takes over a metre under it).
  function buildingFloor(place, x, y, z) {
    const b = map && map.floors && map.floors.buildings && map.floors.buildings[place - BUILDING];
    if (!b) return 0;
    const under = list => list.reduce((best, p) => p.h <= z + 1 && (!best || p.h > best.h) ? p : best, null);
    const here = under(b.parts.filter(p => inBox(p.box, x, y) && inLoops(p.l, x, y)));
    // over its ceiling is on the roof
    if (here) return z >= here.t - 0.1 ? 0 : here.n;
    // on no floor's part: in a doorway, on the stairs, on a ledge over a hall
    const near = under(b.parts);
    if (near) return z >= Math.max(...b.parts.map(p => p.t)) - 0.1 ? 0 : near.n;
    const lowest = b.parts.reduce((low, p) => p.h < low.h ? p : low);
    return z > lowest.h - 1.5 ? lowest.n : 0;
  }
  // the floor a building is looked at on when nobody's in it: its biggest
  function mainFloor(place) {
    const b = map.floors.buildings[place - BUILDING];
    return b.parts.reduce((big, p) => p.a > big.a ? p : big).n;
  }

  // ---- kinds of loot, names ------------------------------------------------------------------------------------
  // The kinds loot can be switched by, as the server sorts items by the game's handbook ("g" in an item's names entry).
  const LOOT_KINDS = [['weapons', T('Weapons')], ['mods', T('Weapon parts')], ['ammo', T('Ammo')], ['gear', T('Gear')], ['meds', T('Medical')],
    ['food', T('Provisions')], ['keys', T('Keys')], ['valuables', T('Valuables')], ['electronics', T('Electronics')], ['tools', T('Tools, materials')],
    ['household', T('Household, other')], ['info', T('Info, maps')], ['money', T('Money')], ['special', T('Special')], ['other', T('Anything else')]];
  // whether only what's on the player's wishlist is shown (once the wishlist is known)
  const wishOnly = () => !!prefs.wishOnly && !!wish;
  // what loot has to be worth to be shown: anything, while only the wishlist is shown
  const minWorth = () => wishOnly() ? 0 : prefs.worth;
  // what the loot shown hangs on, as text: what's worked out from it is worked out again when this changes
  const lootPrint = () => prefs.lootOff.join(',') + (wishOnly() ? '|wish:' + wishPrint : '');
  // what a list says of the items it leaves out: of kinds switched off, or not on the wishlist
  const notShown = n => wishOnly() ? T('{n} not on your wishlist', { n }) : T('{n} of kinds not shown', { n });
  // whether an item is of a kind that's shown (quest items always are; an item the server hasn't sorted counts as
  // "anything else"). While only the wishlist is shown, it's whether it's on the wishlist, whatever its kind.
  const kindOn = (names, tpl) => {
    const entry = names[tpl] || {};
    // an item picked by its whole name (from the search's list or the Explorer) is found whatever its kind
    if (findExact && (findHits(entry.n) || findHits(entry.s))) return true;
    if (wishOnly()) return !!entry.q || wish.has(tpl);
    if (!prefs.lootOff.length) return true;
    return !!entry.q || !prefs.lootOff.includes(entry.g || 'other');
  };

  // Names in Cyrillic, in Latin letters: the bosses by the names players know them by, everyone else letter by letter.
  const BOSS_NAMES = { 'решала': 'Reshala', 'килла': 'Killa', 'глухарь': 'Glukhar', 'штурман': 'Shturman', 'санитар': 'Sanitar',
    'тагилла': 'Tagilla', 'зрячий': 'Zryachiy', 'кабан': 'Kaban', 'коллонтай': 'Kollontay', 'рыцарь': 'Knight', 'птичий глаз': 'Birdeye',
    'биг пайп': 'Big Pipe', 'партизан': 'Partisan', 'дед мороз': 'Ded Moroz' };
  const LATIN = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
    н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y',
    ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g' };
  function latin(text) {
    if (!prefs.latin || !text || !/[\u0400-\u04ff]/.test(text)) return text;
    const boss = BOSS_NAMES[text.trim().toLowerCase()];
    if (boss) return boss;
    let out = '';
    for (const ch of text) {
      const low = ch.toLowerCase();
      const to = LATIN[low];
      if (to === undefined) { out += ch; continue; }
      out += ch !== low && to ? to[0].toUpperCase() + to.slice(1) : to;
    }
    return out;
  }

  // the roofed place a spot is in; 0 out in the open
  function placeAt(x, y) {
    const f = map && map.floors;
    if (!f) return 0;
    const cx = Math.floor((x - f.x) / f.cell), cy = Math.floor((y - f.y) / f.cell);
    if (cx < 0 || cy < 0 || cx >= f.wide || cy >= f.tall) return 0;
    return f.grid[cy * f.wide + cx];
  }
  // the squares a place covers, first to last column and row
  function placeBox(place) {
    const f = map.floors;
    if (f.boxes.has(place)) return f.boxes.get(place);
    const box = { c0: Infinity, c1: -1, r0: Infinity, r1: -1 };
    for (let i = 0; i < f.grid.length; i++) {
      if (f.grid[i] !== place) continue;
      const cx = i % f.wide, cy = (i - cx) / f.wide;
      box.c0 = Math.min(box.c0, cx); box.c1 = Math.max(box.c1, cx);
      box.r0 = Math.min(box.r0, cy); box.r1 = Math.max(box.r1, cy);
    }
    f.boxes.set(place, box);
    return box;
  }
  // the roofed place somebody indoors is in: the one their square is in, else the nearest within a few metres (the
  // squares are coarse, and a doorway may fall just outside)
  function placeNear(x, y) {
    const f = map && map.floors;
    if (!f) return 0;
    const here = placeAt(x, y);
    if (here) return here;
    let best = 0, bestFar = Infinity;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const p = placeAt(x + dx * f.cell, y + dy * f.cell);
        const far = dx * dx + dy * dy;
        if (p && far < bestFar) { best = p; bestFar = far; }
      }
    }
    return best;
  }
  // The building the player is inside; 0 in the open. Where the game says indoors, the nearest roofed place. The game
  // says outdoors in some buildings (the dorms on Customs), so a building with more than one floor also counts when
  // the player stands on a square that has ground on the floor their height makes: that leaves out awnings and
  // arcades, which have one floor, and roofs, which are above the top floor. Either way the player has to be standing
  // on that floor: within a square of ground it has, at about its height. Under a train wagon by a warehouse on
  // Customs the game says indoors, and the warehouse a few metres off was shown, floor 1, with the player outside it.
  // (who: the player, or a bot being followed: {x, y, z, in})
  function placeInside(who = me) {
    const f = map && map.floors;
    if (!f || !who) return 0;
    if (f.buildings) {
      // within a building's walls, on one of its floors: the game's word isn't needed, a shelter isn't a building
      const b = buildingAt(who.x, who.y, who.z);
      return b && buildingFloor(b, who.x, who.y, who.z) ? b : 0;
    }
    const indoors = who.in !== false;
    // where the game says indoors, a doorway may fall a square outside the building's squares
    const place = placeAt(who.x, who.y) || (indoors ? placeNear(who.x, who.y) : 0);
    const levels = place ? f.levels[place - 1] : null;
    if (!Array.isArray(levels) || !levels.length || (!indoors && levels.length < 2)) return 0;
    const n = floorOf(place, who.z);
    if (!n) return 0;
    // on the floor: not a metre under it (a cellar's floor is the lowest there is), nor far above it (on the stairs
    // up, the floor above takes over at a metre under it). Outdoors under a wagon is well under a building's ground floor.
    if (!indoors && who.z < levels[n - 1] - 1) return 0;
    // Nor, outdoors, well above the top floor: on a bridge's deck, 2.4 m over the road under it (Customs), the road's
    // "floor" was shown. Between two floors is the stairs, and stays.
    if (!indoors && n === levels.length && who.z > levels[n - 1] + 1.2) return 0;
    if (f.squares) {
      const cx = Math.floor((who.x - f.x) / f.cell), cy = Math.floor((who.y - f.y) / f.cell);
      const bit = 1 << (n - 1);
      const has = (x, y) => x >= 0 && y >= 0 && x < f.wide && y < f.tall && f.grid[y * f.wide + x] === place && !!(f.squares[y * f.wide + x] & bit);
      let near = has(cx, cy);
      // indoors: a square beside one with that floor will do (2 m, a doorway); outdoors only the square itself
      for (let dy = -1; indoors && !near && dy <= 1; dy++) for (let dx = -1; !near && dx <= 1; dx++) near = has(cx + dx, cy + dy);
      if (!near) return 0;
      if (indoors && who.z < levels[n - 1] - 1.5) return 0;
    }
    return place;
  }
  // Whether something is on another floor than the player: 1 above, -1 below, 0 not. Inside a building with floors,
  // its floor against the player's; out in the open it's the same level however the ground rises and falls, unless
  // the player is up a building's floors (or down in its cellar).
  function otherFloor(x, y, z) {
    const f = map && map.floors;
    if (!f) return 0;
    // A floor of a building is shown (the player's, one stepped to, or of a building looked into): what's in that
    // building goes by the floor shown, in a raid or out of one.
    const b = f.buildings && floorShown.place >= BUILDING && floorShown.n > 0 ? f.buildings[floorShown.place - BUILDING] : null;
    if (b && inBox(b.box, x, y) && inLoops(b.l, x, y)) {
      if (buildingFloor(floorShown.place, x, y, z) === floorShown.n) return 0;
      const shown = b.parts.filter(p => p.n === floorShown.n);
      return shown.length && z < Math.min(...shown.map(p => p.h)) ? -1 : 1;
    }
    if (!me || !inRaidHere()) return 0;
    const many = p => p && Array.isArray(f.levels[p - 1]) && f.levels[p - 1].length > 1;
    const there = placeAt(x, y);
    if (many(there)) {
      const a = floorOf(there, z), b = floorOf(there, me.cz);
      return a === b ? 0 : z > me.cz ? 1 : -1;
    }
    const mine = placeNear(me.cx, me.cy);
    if (many(mine) && (me.in !== false || (f.buildings ? !!placeInside() : placeInside() === mine)) && floorOf(mine, me.cz) !== 1 && Math.abs(z - me.cz) > 2.5) return z > me.cz ? 1 : -1;
    return 0;
  }
  function floorOf(place, height) {
    const f = map && map.floors;
    if (!f || !place) return 0;
    const levels = f.levels[place - 1];
    if (!Array.isArray(levels) || !levels.length || height > levels[levels.length - 1] + 2.6) return 0;
    let on = 1;
    for (let i = 1; i < levels.length; i++) if (levels[i] <= height + 1) on = i + 1;
    return on;
  }
  function listFloors() {
    const f = map && map.floors;
    $('floorRow').hidden = !f;
    const pick = $('optFloor');
    pick.textContent = '';
    if (!f) return;
    const rows = [['auto', T('Auto: the player\'s')], ['0', T('From above')]];
    for (let n = f.n; n >= 1; n--) rows.push([String(n), T('Floor {n}', { n })]);
    for (const [value, text] of rows) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = text;
      pick.appendChild(o);
    }
    pick.value = String(prefs.floor);
    if (pick.value !== String(prefs.floor)) pick.value = 'auto';
  }

  // A tile's picture: of floor n (0: the view from above), where the tile has one; small unless asked for big.
  function tileSrc(t, big, n) {
    const f = map.floors;
    const of = n > 0 && f && f.has[n - 1] && f.has[n - 1].has(t.at) ? '_f' + n : '';
    return 'map/' + encodeURIComponent(map.loc) + '/' + map.v + '/' + t.col + '_' + t.row + of + (big || !map.small ? '' : '_s') + '.jpg';
  }
  // A tile is laid a little over its square, so no line shows between two: by two pixels of the screen, however far
  // the map is zoomed. It's stretched about its middle, so nothing on it is more than a pixel from where it belongs.
  // It's put there and sized by a transform, its own box being TILE_BOX pixels square (see livemap.css): the browser
  // rounds a picture's box to whole pixels before the map's zoom is applied, and a pixel there is a metre, so an
  // overlap given as left, top and width was rounded away and the ground behind showed through between the tiles.
  const TILE_BOX = 1024;
  let lapShown = 0;
  const lapNow = () => Math.min(map.tile / 8, 2 / zoom);
  function layTile(img) {
    const lap = lapShown || lapNow();
    img.style.transform = 'translate(' + (img.bx - lap / 2) + 'px,' + (img.by - lap / 2) + 'px) scale(' + (map.tile + lap) / TILE_BOX + ')';
  }
  // laid again once the zoom has changed enough to tell. While it zooms, only once it has doubled or halved: laying
  // every tile again makes the browser draw the whole map again, and mid-zoom (every fifth more or less) it stuttered;
  // the zoom settled, it's laid again as it should be, when the map is drawn sharp anyway.
  function layTiles() {
    const lap = lapNow();
    if (lapShown && (layersEl.classList.contains('zooming') ? lap < lapShown * 2 && lap > lapShown / 2 : Math.abs(lap - lapShown) < lapShown * 0.2)) return;
    lapShown = lap;
    for (const t of tiles) layTile(t.img);
    for (const t of floorTiles) layTile(t.img);
  }
  // the pictures fetched ahead while the map zooms (see refreshTiles), by their address, and what they were for
  let tilesAhead = '';
  // big pictures arrived, waiting to be swapped in: six a frame
  const swapsDue = [];
  function swapSome() { for (const f of swapsDue.splice(0, 6)) f(); if (swapsDue.length) requestAnimationFrame(swapSome); }
  const aheadImgs = new Map();
  // Every tile shows its small picture; the ones in view show the big one once the map is close enough to tell.
  // A picture is swapped once the new one has arrived, so nothing flickers.
  function refreshTiles() {
    if (!map) return;
    // (not swapped in while it zooms: a picture swapped in makes the browser draw the map again, and mid-zoom it
    // stuttered. The small pictures stretch meanwhile, and the big ones the zoom is heading for are fetched and
    // unpacked, not shown; once it has settled they're swapped in at once, as it's drawn sharp, with nothing left
    // to wait for. A map just opened has none yet: those are put in at once.)
    const moving = !!tilesPrint && layersEl.classList.contains('zooming');
    const big = !map.small || zoom * map.tile * (pixelRatio()) > 330;
    // the ground the screen's corners show, whichever way the map is turned
    const corners = [toMap(0, 0), toMap(vw, 0), toMap(0, vh), toMap(vw, vh)];
    const a = [Math.min(...corners.map(c => c[0])), Math.min(...corners.map(c => c[1]))];
    const b = [Math.max(...corners.map(c => c[0])), Math.max(...corners.map(c => c[1]))];
    const col0 = Math.floor((a[0] - map.min.x) / map.tile - 0.5), col1 = Math.floor((b[0] - map.min.x) / map.tile + 0.5);
    const row0 = Math.floor((a[1] - map.min.y) / map.tile - 0.5), row1 = Math.floor((b[1] - map.min.y) / map.tile + 0.5);
    const print = [map.loc, map.v, big, col0, col1, row0, row1, floorShown.place, floorShown.n].join();
    if (print === tilesPrint) return;
    const all = tiles.map(t => [t, 0]).concat(floorTiles.map(t => [t, t.n || floorShown.n]));
    if (moving) {
      if (print === tilesAhead) return;
      tilesAhead = print;
      for (const [t, n] of all) {
        const near = t.col >= col0 && t.col <= col1 && t.row >= row0 && t.row <= row1;
        const want = tileSrc(t, !map.small || (big && near), n);
        if (t.want === want || aheadImgs.has(want)) continue;
        // (kept a while, so the picture stays unpacked till it's wanted; the oldest let go past a few screens' worth)
        const pre = new Image();
        pre.src = want;
        if (pre.decode) pre.decode().catch(() => {});
        aheadImgs.set(want, pre);
        if (aheadImgs.size > 160) aheadImgs.delete(aheadImgs.keys().next().value);
      }
      return;
    }
    tilesPrint = print;
    for (const [t, n] of all) {
      const near = t.col >= col0 && t.col <= col1 && t.row >= row0 && t.row <= row1;
      const want = tileSrc(t, !map.small || (big && near), n);
      if (t.want === want) continue;
      const first = !t.want;
      t.want = want;
      if (first) { t.img.src = want; continue; }
      // (unpacked before it's swapped in, away from the page's drawing: swapped in packed, it was unpacked as the map
      // was drawn, and a zoom going on stuttered)
      const next = new Image();
      next.src = want;
      // (a few a frame: dozens swapped in at once as a zoom settled held the page up for a sixth of a second)
      const swap = () => { swapsDue.push(() => { if (t.want === want) t.img.src = want; }); if (swapsDue.length === 1) requestAnimationFrame(swapSome); };
      if (next.decode) next.decode().then(swap, swap); else next.onload = swap;
    }
  }

  // Shows floor n of one roofed place: that floor's pictures, cut to the place's shape, over the rest of the map
  // dimmed, with the floor's own outline drawn round it. Place 0: the plain view from above.
  // the badge: which of the floors (lowest first) is shown, and arrows to the next one up or down
  // (counted among the floors that look different; a floor shown that isn't one of them, the player's on a landing,
  // counts as the one under it)
  function floorLabel(n, floors) {
    const i = Math.max(1, floors.filter(k => k <= n).length);
    const picked = prefs.floor !== 'auto' || (floorPick && floorPick.n === n);
    $('floorText').textContent = T('Floor {n} of {of}', { n: i, of: Math.max(1, floors.length) });
    // picked by hand: shown by its colour, not by more words, so the arrows either side never move
    $('floorText').classList.toggle('picked', picked);
    $('floorDown').disabled = !floors.some(k => k < n);
    $('floorUp').disabled = !floors.some(k => k > n);
    // A few floors: each a button by its name, the one shown lit (the same however it came to be shown), pressed to
    // go straight to it, and Auto (the floor whoever is followed is on), itself lit while it's the one choosing,
    // however many there are: past what fits, the row scrolls sideways, the floor shown
    // kept in sight. One: only its name, nothing to pick.
    const place = floorShown.place, named = floors.length >= 1, pick = $('floorPick');
    $('floorBadge').classList.toggle('named', named);
    pick.textContent = '';
    if (!named) return;
    if (floors.length === 1) {
      const only = mk('button', 'on only', floorName(place, floors[0]));
      only.type = 'button';
      only.tabIndex = -1;
      const h = floorHeight(place, floors[0]);
      if (Number.isFinite(h)) only.title = T('{h} m up', { h: h.toFixed(1) });
      pick.appendChild(only);
      return;
    }
    const auto = mk('button', 'auto' + (picked ? '' : ' on'), T('Auto'));
    auto.type = 'button';
    auto.title = T('The floor of whoever is followed');
    auto.onclick = () => $('floorText').onclick();
    pick.appendChild(auto);
    for (const k of floors) {
      const b = mk('button', k === n ? 'on' : '', floorName(place, k));
      b.type = 'button';
      const h = floorHeight(place, k);
      if (Number.isFinite(h)) b.title = T('{h} m up', { h: h.toFixed(1) });
      b.onclick = () => { floorPick = { place, n: k }; setFloor(place, k); };
      pick.appendChild(b);
    }
    // the floor shown in sight, in a row too long for the screen (the row only, never the page)
    const lit = pick.querySelector('button.on:not(.auto)');
    if (lit && pick.scrollWidth > pick.clientWidth) {
      const left = lit.offsetLeft - pick.offsetLeft, right = left + lit.offsetWidth;
      if (left < pick.scrollLeft) pick.scrollLeft = left - 4;
      else if (right > pick.scrollLeft + pick.clientWidth) pick.scrollLeft = right - pick.clientWidth + 4;
    }
  }
  // How high a floor of a place is (m): an outdoor place's own height for it, a building's from its parts on it.
  function floorHeight(place, n) {
    const f = map && map.floors;
    if (!f || !place) return NaN;
    if (place < BUILDING) return (f.levels[place - 1] || [])[n - 1];
    const b = f.buildings && f.buildings[place - BUILDING], hs = b ? b.parts.filter(p => p.n === n && Number.isFinite(p.h)).map(p => p.h) : [];
    return hs.length ? Math.min(...hs) : NaN;
  }
  // The height a floor of a place mostly is (m): of a building, its biggest part's, not a landing's or a step's under it
  function floorLevel(place, n) {
    const f = map && map.floors;
    if (!f || !place || place < BUILDING) return floorHeight(place, n);
    const b = f.buildings && f.buildings[place - BUILDING];
    let best = null;
    if (b) for (const p of b.parts) if (p.n === n && Number.isFinite(p.h) && (!best || p.a > best.a)) best = p;
    return best ? best.h : NaN;
  }
  // The ground round a building: the middle height of the spawn points and extracts nearest it outside it (up to 8,
  // within 60 m of it). A map has one ground height (mapGround), but Lighthouse's water treatment stands by the sea
  // 10 m under it: against the map's, its floors all came out as basements. NaN with fewer than 3 round it (Factory's
  // building is the whole map): the map's ground then.
  const groundNear = new Map();
  function localGround(place) {
    const f = map && map.floors, b = place >= BUILDING && f && f.buildings && f.buildings[place - BUILDING];
    if (!b || !b.l || !b.l[0] || !places || !sameMap(places.loc, map.loc)) return NaN;
    const key = map.loc + '|' + map.v + '|' + place;
    if (groundNear.has(key)) return groundNear.get(key);
    const ring = b.l[0];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < ring.length; i += 2) {
      x0 = Math.min(x0, ring[i]); x1 = Math.max(x1, ring[i]); y0 = Math.min(y0, ring[i + 1]); y1 = Math.max(y1, ring[i + 1]);
    }
    const inside = (x, y) => {
      let c = false;
      for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
        const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
    const near = [];
    for (const s of (places.spawns || []).concat(places.exits || [])) {
      const p = s && s.p;
      if (!p || !Number.isFinite(p[2])) continue;
      const d = Math.hypot(Math.max(0, x0 - p[0], p[0] - x1), Math.max(0, y0 - p[1], p[1] - y1));
      if (d <= 60 && !inside(p[0], p[1])) near.push([d, p[2]]);
    }
    near.sort((a, c) => a[0] - c[0]);
    const hs = near.slice(0, 8).map(x => x[1]).sort((a, c) => a - c);
    // (only where they agree: the middle half within 3 m, not some on a cliff over it and some down by the water)
    const q = hs.length >> 2, middle = hs.slice(q, hs.length - q);
    const h = hs.length >= 3 && middle[middle.length - 1] - middle[0] <= 3 ? hs[hs.length >> 1] : NaN;
    groundNear.set(key, h);
    return h;
  }
  // What's underground is called on each map (the rest: Basement); the floors above go by storeys of about 3.4 m.
  const FLOOR_UNDER = { factory4_day: 'Tunnels', factory4_night: 'Tunnels', RezervBase: 'Bunker', Interchange: 'Parking', Woods: 'Bunker', Sandbox: 'Underground', Sandbox_high: 'Underground' };
  const STOREY = 3.4;
  // maps played underground, all of them (named from the level the spawn points are on), and a ship's (decks)
  const FLOOR_BELOW = new Set(['laboratory', 'Labyrinth', 'Terminal']);
  const FLOOR_DECKS = new Set(['icebreaker']);
  // the middle height of the map's spawn points (NaN: none known)
  let spawnsOf = { loc: '', h: NaN };
  function spawnGround() {
    if (!places || !sameMap(places.loc, map.loc)) return NaN;
    if (spawnsOf.loc === places.loc) return spawnsOf.h;
    const hs = (places.spawns || []).map(s => s && s.p && s.p[2]).filter(Number.isFinite).sort((a, b) => a - b);
    spawnsOf = { loc: places.loc, h: hs.length ? hs[hs.length >> 1] : NaN };
    return spawnsOf.h;
  }
  // (2nd, 3rd in English; in another language only the number, which its own words for "{n} floor" put in place)
  const ordinal = n => window.fumsLangs && fumsLangs.code !== 'en' ? String(n) : n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
  let groundOf = { loc: '', h: NaN };
  // the height of the map's ground: where its extracts are (the middle one), else the lowest floor of most places
  function mapGround() {
    if (groundOf.loc === map.loc + '|' + (places ? 1 : 0)) return groundOf.h;
    const mid = list => { const s = list.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
    let h = places && sameMap(places.loc, map.loc) ? mid(places.exits.map(e => e.p[2])) : NaN;
    if (!Number.isFinite(h)) h = mid((map.floors.levels || []).map(l => Array.isArray(l) ? l[0] : NaN));
    groundOf = { loc: map.loc + '|' + (places ? 1 : 0), h };
    return h;
  }
  // A capture that saw a floor under the whole map (one of Factory's has one 15 m under its tunnels): the lowest
  // level of nearly every place (3 in 4) at one height, 10 m or more under the next floor up wherever there is one.
  // Its height (NaN: none), left out of the floors to step to.
  let undersideOf = { v: '', h: NaN };
  function mapUnderside() {
    const f = map && map.floors, key = map ? map.loc + '|' + map.v : '';
    if (undersideOf.v === key) return undersideOf.h;
    let h = NaN;
    const levels = f ? (f.levels || []).filter(l => Array.isArray(l) && l.length) : [];
    if (levels.length >= 2) {
      const lows = levels.map(l => l[0]), near = x => lows.filter(y => Math.abs(y - x) <= 0.3).length;
      const most = lows.reduce((a, b) => near(b) > near(a) ? b : a);
      const gaps = levels.filter(l => Math.abs(l[0] - most) <= 0.3 && l.length > 1).map(l => l[1] - l[0]);
      if (near(most) >= levels.length * 0.75 && gaps.every(g => g >= 10)) h = most;
    }
    undersideOf = { v: key, h };
    return h;
  }
  // A floor's name: Ground floor, 2nd floor, 3rd floor... or what's underground on that map (Tunnels on Factory,
  // Bunker on Reserve), "lower" for a second level down, numbered from the top where there are more.
  // A storey is as high as the place's own: the middle of the steps between its floors above ground (3.4 m with one
  // floor; Interchange's mall is about 7 m, Streets' flats 3 m), so tall storeys aren't counted as two. Each floor is
  // counted from the one under it: one storey up, more only for a step of 1.75 storeys or more (floors in between
  // that nobody walks on, a tower's top over its foot), so none is skipped for a tall ground floor. A step of under
  // 2.2 m (a split level) is the same storey, "upper". Each floor's height is the one it mostly is (floorLevel).
  function floorName(place, n) {
    const hs = floorsOf(place).map(k => [k, floorLevel(place, k)]).filter(x => Number.isFinite(x[1])).sort((a, b) => a[1] - b[1]);
    const loc = String(map.loc).replace(/[~@].*$/, '');
    // a ship's levels are its decks, from the bottom
    if (FLOOR_DECKS.has(loc)) return T('Deck {n}', { n: 1 + hs.findIndex(x => x[0] === n) });
    // the ground round the building as the scanner measured it ("g": the walkable ground in the open round it, see
    // tools/outlines.js), else as the spawn points round it have it, else the map's. A map played underground
    // (Labs, the Labyrinth, Terminal) is named from the level its spawn points are on, not the ground over it all.
    const below = FLOOR_BELOW.has(loc);
    const bd = place >= BUILDING && map.floors.buildings && map.floors.buildings[place - BUILDING], measured = !below && !!bd && Number.isFinite(bd.g);
    const h = floorLevel(place, n), near = below ? spawnGround() : measured ? bd.g : localGround(place), g = Number.isFinite(near) ? near : mapGround();
    if (!Number.isFinite(h) || !hs.length) return T('Floor {n}', { n });
    // the place's ground floor: the one nearest the ground, not under it
    const up = hs.filter(x => !Number.isFinite(g) || x[1] >= g - 2.5), kind = FLOOR_UNDER[String(map.loc).replace(/[~@].*$/, '')];
    let ground = up.length ? up.reduce((a, b) => Math.abs(b[1] - g) < Math.abs(a[1] - g) || !Number.isFinite(g) && b[1] < a[1] ? b : a)[1] : NaN;
    // Every floor under the ground: with the ground round it measured, it's all underground (a bunker). Without, only
    // on a map with things underground (a bunker, a car park), with the spawn points round it 3.5 m or more over all of
    // it; anywhere else it's a building on lower ground (by the sea, down a slope) and its lowest floor is its ground floor.
    if (!Number.isFinite(ground)) ground = measured || kind && Number.isFinite(near) && hs[hs.length - 1][1] <= near - 3.5 ? Infinity : hs[0][1];
    // Where the capture found the floor one walks into from the ground outside ("gn", see tools/outlines.js), that's
    // the ground floor, whatever the ground's height says: under it is underground, over it the storeys.
    const entry = !below && bd && Number.isFinite(bd.gn) ? floorLevel(place, bd.gn) : NaN;
    if (Number.isFinite(entry)) ground = entry;
    // (the ground not measured round it: a level under 3 m below the ground floor is part of it, not a basement, as
    // the space under the Labyrinth's floor plates)
    if (h < ground - 1.8 && !measured && !Number.isFinite(entry) && ground - h < 3) return T('{name} (lower)', { name: T('Ground floor') });
    if (h < ground - 1.8) {
      const under = T(kind || 'Basement');
      // nearest the ground first
      const below = hs.filter(x => x[1] < ground - 1.8).sort((a, b) => b[1] - a[1]), i = below.findIndex(x => x[0] === n);
      if (i <= 0) return under;
      return below.length === 2 ? T('{name} (lower)', { name: under }) : T('{name} {n}', { name: under, n: i + 1 });
    }
    const above = hs.filter(x => x[1] >= ground - 1.8);
    const mid = list => { const s = list.slice().sort((a, b) => a - b); return s[s.length >> 1]; };
    // (a split level's step, under 2.2 m, isn't a storey)
    const steps = above.slice(1).map((x, i) => x[1] - above[i][1]).filter(d => d >= 2.2);
    const high = steps.length ? Math.min(8, Math.max(2.8, mid(steps))) : STOREY;
    let storey = 0, under = ground, split = false;
    for (const [k, kh] of above) {
      split = storey > 0 && kh - under < 2.2;
      if (!split) storey = storey ? storey + (kh - under < 1.75 * high ? 1 : Math.round((kh - under) / high)) : 1 + Math.max(0, Math.round((kh - ground) / high));
      under = kh;
      if (k === n) break;
    }
    const name = storey === 1 ? T('Ground floor') : T('{n} floor', { n: ordinal(storey) });
    return split ? T('{name} (upper)', { name }) : name;
  }
  // The floors of a place worth stepping to, lowest first. Of a building, the ones that look different: not a scrap
  // (a landing, a split level's step: under 15 m2, or under 4% of its biggest floor), and, once its pictures have been
  // compared (see compareFloors), not the same picture as the floor under it. Its biggest floor always counts.
  // (the capture's floor under the whole map, if it has one, isn't a floor to step to where there are real ones)
  function floorsOf(place) {
    const all = floorsSeen(place), under = mapUnderside();
    if (!Number.isFinite(under)) return all;
    const kept = all.filter(n => !(Math.abs(floorHeight(place, n) - under) <= 0.5));
    return kept.length ? kept : all;
  }
  function floorsSeen(place) {
    const f = map && map.floors;
    if (!f || !place) return [];
    if (place < BUILDING) return (f.levels[place - 1] || []).map((_, i) => i + 1);
    const b = f.buildings && f.buildings[place - BUILDING];
    if (!b) return [];
    if (b.seen && b.seen.v === map.v) return b.seen.list;
    const area = new Map();
    for (const p of b.parts) area.set(p.n, (area.get(p.n) || 0) + p.a);
    const most = Math.max(...area.values());
    const big = mainFloor(place);
    const list = b.floors.filter(m => m === big || area.get(m) >= Math.max(15, most * 0.04));
    if (!b.comparing || b.comparing !== map.v) {
      b.comparing = map.v;
      compareFloors(place, b, list, big);
    }
    return list;
  }
  // How alike two floors' pictures are, within the upper one's own floor: the mean difference of red, green and blue
  // (0 to 255). The storeys of a stairwell or a tower, captured alike, come to under 1 (Streets: 0.0 to 0.9 against
  // 1.1 and up for a floor with anything new on it).
  const SAME_FLOOR = 1;
  // Compares each floor's small pictures with the last different floor's under it, and keeps the floors that differ;
  // the badge counts those once it's done.
  async function compareFloors(place, b, list, big) {
    const v = map.v, loc = map.loc;
    const { x0, y0, x1, y1 } = b.box;
    const K = Math.min(2, 1024 / Math.max(x1 - x0, y1 - y0, 1));
    const W = Math.max(1, Math.ceil((x1 - x0) * K)), H = Math.max(1, Math.ceil((y1 - y0) * K));
    const c0 = Math.max(0, Math.floor((x0 - map.min.x) / map.tile)), c1 = Math.min(map.cols - 1, Math.floor((x1 - map.min.x) / map.tile));
    const r0 = Math.max(0, Math.floor((y0 - map.min.y) / map.tile)), r1 = Math.min(map.rows - 1, Math.floor((y1 - map.min.y) / map.tile));
    const load = src => new Promise(ok => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ok(null); i.src = src; });
    const canvas = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c.getContext('2d', { willReadFrequently: true }); };
    const picture = async m => {
      const g = canvas();
      for (let r = r0; r <= r1; r++) {
        for (let col = c0; col <= c1; col++) {
          const img = await load(tileSrc({ col, row: r, at: r * map.cols + col }, false, m));
          if (img) g.drawImage(img, (map.min.x + col * map.tile - x0) * K, (y1 - (map.min.y + (r + 1) * map.tile)) * K, map.tile * K, map.tile * K);
        }
      }
      return g.getImageData(0, 0, W, H).data;
    };
    const ownFloor = m => {
      const g = canvas();
      g.fillStyle = '#fff';
      g.beginPath();
      for (const p of b.parts) {
        if (p.n !== m) continue;
        for (const l of p.l) {
          for (let i = 0; i + 1 < l.length; i += 2) {
            const px = (l[i] - x0) * K, py = (y1 - l[i + 1]) * K;
            if (i) g.lineTo(px, py); else g.moveTo(px, py);
          }
          g.closePath();
        }
      }
      g.fill('evenodd');
      return g.getImageData(0, 0, W, H).data;
    };
    try {
      const kept = [];
      let under = null;
      for (const m of list) {
        const pic = await picture(m);
        if (!map || map.loc !== loc || map.v !== v) return;
        let same = false;
        if (under && m !== big) {
          const mask = ownFloor(m);
          let sum = 0, n = 0;
          for (let i = 0; i < mask.length; i += 4) {
            if (mask[i + 3] < 128) continue;
            n++;
            sum += (Math.abs(pic[i] - under[i]) + Math.abs(pic[i + 1] - under[i + 1]) + Math.abs(pic[i + 2] - under[i + 2])) / 3;
          }
          same = n > 0 && sum / n < SAME_FLOOR;
        }
        if (same) continue;
        kept.push(m);
        under = pic;
      }
      b.seen = { v, list: kept };
      if (floorShown.place === place) floorLabel(floorShown.n, floorsOf(place));
    } catch (e) {
      // (pictures that can't be read: every floor that isn't a scrap counts)
      b.seen = { v, list };
    }
  }
  // a floor up (1) or down (-1) in the building shown, of the ones that look different; kept until another building
  // is shown
  function stepFloor(d) {
    const place = floorShown.place, has = floorsOf(place), n = floorShown.n;
    const to = d > 0 ? has.find(k => k > n) : [...has].reverse().find(k => k < n);
    if (to === undefined) return;
    floorPick = { place, n: to };
    setFloor(place, to);
  }

  function setFloor(place, n) {
    const f = map && map.floors;
    floorShown = { place, n };
    tilesPrint = '';
    floorTiles = [];
    floorEdge = [];
    floorOwn = [];
    floorEl.textContent = '';
    const on = !!(f && place > 0 && n > 0);
    floorEl.hidden = !on;
    layersEl.classList.toggle('dim', on);
    if ($('floorShade')) $('floorShade').hidden = !on;
    dirty = true;
    const badge = $('floorBadge');
    badge.hidden = !on;
    if (!on) return;
    if (place >= BUILDING) {
      showBuilding(f.buildings[place - BUILDING], n);
      return;
    }
    floorLabel(n, floorsOf(place));

    const box = placeBox(place);
    const left = f.x + box.c0 * f.cell, right = f.x + (box.c1 + 1) * f.cell;
    const bottom = f.y + box.r0 * f.cell, top = f.y + (box.r1 + 1) * f.cell;
    Object.assign(floorEl.style, { left: left + 'px', top: -top + 'px', width: (right - left) + 'px', height: (top - bottom) + 'px' });

    // the squares that have this floor (all of the place's, when the capture doesn't say), as tidy outlines
    const bit = 1 << (n - 1);
    let byFloor = !!f.squares;
    if (byFloor) {
      let any = false;
      for (let cy = box.r0; cy <= box.r1 && !any; cy++) {
        for (let cx = box.c0; cx <= box.c1 && !any; cx++) any = f.grid[cy * f.wide + cx] === place && !!(f.squares[cy * f.wide + cx] & bit);
      }
      byFloor = any;
    }
    const inside = (cx, cy) => cx >= 0 && cy >= 0 && cx < f.wide && cy < f.tall && f.grid[cy * f.wide + cx] === place
      && (!byFloor || !!(f.squares[cy * f.wide + cx] & bit));
    const loops = tidyLoops(squareOutline(inside, box), f.cell);

    // that shape, eight pixels to a square so its edge stays sharp: the floor's pictures show through it only, so
    // what's lit and what's outlined are the same
    const S = 8, w = box.c1 - box.c0 + 1, h = box.r1 - box.r0 + 1;
    const shape = document.createElement('canvas');
    shape.width = w * S;
    shape.height = h * S;
    const g = shape.getContext('2d');
    g.fillStyle = '#fff';
    g.beginPath();
    for (const loop of loops) {
      loop.forEach((p, i) => {
        const px = (p[0] - box.c0) * S, py = (box.r1 + 1 - p[1]) * S;
        if (i) g.lineTo(px, py); else g.moveTo(px, py);
      });
      g.closePath();
    }
    g.fill('nonzero');
    const url = 'url(' + shape.toDataURL() + ')';
    floorEl.style.webkitMaskImage = url;
    floorEl.style.maskImage = url;

    // the map's tiles under it, again, placed within it
    const col0 = Math.max(0, Math.floor((left - map.min.x) / map.tile)), col1 = Math.min(map.cols - 1, Math.floor((right - map.min.x - 1e-6) / map.tile));
    const row0 = Math.max(0, Math.floor((bottom - map.min.y) / map.tile)), row1 = Math.min(map.rows - 1, Math.floor((top - map.min.y - 1e-6) / map.tile));
    for (let row = row0; row <= row1; row++) {
      for (let col = col0; col <= col1; col++) {
        const img = new Image();
        img.alt = '';
        img.draggable = false;
        img.decoding = 'async';
        img.bx = (map.min.x + col * map.tile - left);
        img.by = (top - (map.min.y + (row + 1) * map.tile));
        layTile(img);
        floorEl.appendChild(img);
        floorTiles.push({ img, col, row, at: row * map.cols + col, want: '' });
      }
    }

    floorEdge = loops.map(loop => loop.map(p => [f.x + p[0] * f.cell, f.y + p[1] * f.cell]));
  }

  // A building on floor n: within its footprint, each spot shows the picture of the floor that's seen there. That's
  // floor n where the building has it; where it hasn't (the building is on split levels, or a hall is two floors
  // high) the nearest floor under it, looked down on, else the nearest over it. The other floors' pictures are a
  // little darker. The footprint is what's outlined.
  function showBuilding(b, n) {
    floorLabel(n, floorsOf(floorShown.place));
    const left = b.box.x0, right = b.box.x1, bottom = b.box.y0, top = b.box.y1;
    Object.assign(floorEl.style, { left: left + 'px', top: -top + 'px', width: (right - left) + 'px', height: (top - bottom) + 'px' });
    floorEl.style.webkitMaskImage = 'none';
    floorEl.style.maskImage = 'none';
    // the shapes are drawn eight pixels to a metre (fewer for a very big building), so their edges stay sharp
    const S = Math.min(8, 2048 / Math.max(right - left, top - bottom, 1));
    const w = Math.max(1, Math.ceil((right - left) * S)), h = Math.max(1, Math.ceil((top - bottom) * S));
    const fill = (g, loops) => {
      g.beginPath();
      for (const loop of loops) {
        for (let i = 0; i + 1 < loop.length; i += 2) {
          const px = (loop[i] - left) * S, py = (top - loop[i + 1]) * S;
          if (i) g.lineTo(px, py); else g.moveTo(px, py);
        }
        g.closePath();
      }
      g.fill('evenodd');
    };
    const col0 = Math.max(0, Math.floor((left - map.min.x) / map.tile)), col1 = Math.min(map.cols - 1, Math.floor((right - map.min.x - 1e-6) / map.tile));
    const row0 = Math.max(0, Math.floor((bottom - map.min.y) / map.tile)), row1 = Math.min(map.rows - 1, Math.floor((top - map.min.y - 1e-6) / map.tile));
    // floor m's pictures, showing through the loops given but not through the ones already shown
    const layer = (m, show, shown, under) => {
      const shape = document.createElement('canvas');
      shape.width = w;
      shape.height = h;
      const g = shape.getContext('2d');
      g.fillStyle = '#fff';
      fill(g, show);
      g.globalCompositeOperation = 'destination-out';
      for (const loops of shown) fill(g, loops);
      // and only on the squares that have that floor: elsewhere its picture is the view from above (on Labs, the glass
      // roof over the basement's halls), left to the layer under it all
      const sq = map.floors.squares, f = map.floors;
      if (sq && !under) {
        const bit = 1 << (m - 1), c0 = Math.max(0, Math.floor((left - f.x) / f.cell)), c1 = Math.min(f.wide - 1, Math.floor((right - f.x) / f.cell));
        const r0 = Math.max(0, Math.floor((bottom - f.y) / f.cell)), r1 = Math.min(f.tall - 1, Math.floor((top - f.y) / f.cell));
        g.globalCompositeOperation = 'destination-in';
        g.beginPath();
        for (let cy = r0; cy <= r1; cy++) {
          for (let cx = c0; cx <= c1; cx++) {
            if (!(sq[cy * f.wide + cx] & bit)) continue;
            // (a little over each square, so neighbours meet with no seam)
            g.rect((f.x + cx * f.cell - left) * S - 0.5, (top - (f.y + (cy + 1) * f.cell)) * S - 0.5, f.cell * S + 1, f.cell * S + 1);
          }
        }
        g.fillStyle = '#fff';
        g.fill();
      }
      const el = document.createElement('div');
      // (under it all: dimmed like another floor, since a floor's picture is the view from above wherever that floor
      // isn't, and would show the roof over it in full colour)
      el.className = m === n && !under ? 'floorPart' : 'floorPart other';
      const url = 'url(' + shape.toDataURL() + ')';
      el.style.webkitMaskImage = url;
      el.style.maskImage = url;
      for (let row = row0; row <= row1; row++) {
        for (let col = col0; col <= col1; col++) {
          const img = new Image();
          img.alt = '';
          img.draggable = false;
          img.decoding = 'async';
          img.bx = (map.min.x + col * map.tile - left);
          img.by = (top - (map.min.y + (row + 1) * map.tile));
          layTile(img);
          el.appendChild(img);
          floorTiles.push({ img, col, row, at: row * map.cols + col, want: '', n: m });
        }
      }
      floorEl.appendChild(el);
    };
    // under everything, floor n over the whole footprint: what shows in the walls and between two floors' parts
    layer(n, b.l, [], true);
    const shown = [];
    for (const m of [n, ...b.floors.filter(k => k < n).reverse(), ...b.floors.filter(k => k > n)]) {
      const loops = b.parts.filter(p => p.n === m).flatMap(p => p.l);
      if (!loops.length) continue;
      layer(m, loops, shown);
      shown.push(loops);
    }
    const points = loop => {
      const list = [];
      for (let i = 0; i + 1 < loop.length; i += 2) list.push([loop[i], loop[i + 1]]);
      return list;
    };
    floorEdge = b.l.map(points);
    // the floor shown itself, outlined in its own colour where it covers less of the building (the tunnels under
    // Factory, a bunker under Reserve): what's round it in the building is another floor, darkened
    const own = b.parts.filter(p => p.n === n), ownArea = own.reduce((a, p) => a + (p.a || 0), 0);
    floorOwn = own.length && ownArea < b.size * 0.85 ? own.flatMap(p => p.l).map(points) : [];
  }

  // A floor's outlines without the bits that only look like noise: a scrap of floor under 40 m2 (a porch, a pipe
  // bridge's foot) and a hole in the floor under 400 m2 (a stairwell, a gap the capture left). A loop's area is
  // positive round floor and negative round a hole. Everything is kept when nothing else would be left.
  function tidyLoops(loops, cell) {
    const area = loop => {
      let a = 0;
      for (let i = 0; i < loop.length; i++) {
        const p = loop[i], q = loop[(i + 1) % loop.length];
        a += p[0] * q[1] - q[0] * p[1];
      }
      return a / 2 * cell * cell;
    };
    const kept = loops.filter(loop => { const a = area(loop); return a >= 40 || a <= -400; });
    return kept.some(loop => area(loop) > 0) ? kept : loops;
  }

  // A floor's outline, square cornered. The capture's 2 m squares turn a wall into stairs and leave stray squares
  // as nubs and notches, and straightening the stairs gave slanting edges where the building has none. So the
  // squares are looked at turned the way the building stands (the turn that fits its edge in the smallest box), a
  // lone square sticking out or cut in is smoothed away, and the outline is traced along those turned axes: every
  // edge runs along or across the building and meets the next one square. Loops of [column, row] corners (not whole
  // numbers when turned), the inside on the left.
  function squareOutline(inside, box) {
    const edge = [];
    for (let cy = box.r0; cy <= box.r1; cy++) {
      for (let cx = box.c0; cx <= box.c1; cx++) {
        if (inside(cx, cy) && !(inside(cx - 1, cy) && inside(cx + 1, cy) && inside(cx, cy - 1) && inside(cx, cy + 1))) {
          edge.push([cx, cy], [cx + 1, cy], [cx, cy + 1], [cx + 1, cy + 1]);
        }
      }
    }
    if (!edge.length) return [];
    const spread = deg => {
      const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const [x, y] of edge) {
        const u = x * c + y * s, v = y * c - x * s;
        if (u < u0) u0 = u;
        if (u > u1) u1 = u;
        if (v < v0) v0 = v;
        if (v > v1) v1 = v;
      }
      return { area: (u1 - u0) * (v1 - v0), u0, u1, v0, v1, c, s };
    };
    // which way the building stands: the way of its long walls, found from its outline straightened (the 2 m
    // squares make a slanting wall into stairs, straightening makes them a slant again), each wall counting by its
    // length squared. The map's own axes when that's within three degrees (a lean that small is the squares' noise),
    // or they hold most of the walls.
    const ow = box.c1 - box.c0 + 3, oh = box.r1 - box.r0 + 3;
    const walls = [];
    for (const loop of traceSquares((i, j) => inside(box.c0 - 1 + i, box.r0 - 1 + j), ow, oh)) {
      const l = straighten(loop, 1);
      for (let k = 0; k < l.length; k++) {
        const p = l[k], q = l[(k + 1) % l.length], dx = q[0] - p[0], dy = q[1] - p[1], size = Math.hypot(dx, dy);
        if (size >= 3) walls.push([((Math.atan2(dy, dx) * 180 / Math.PI) % 90 + 90) % 90, size * size]);
      }
    }
    const apart = (x, y) => ((x - y + 45) % 90 + 90) % 90 - 45;
    let deg = 0;
    if (walls.length) {
      let top = -1, peak = 0;
      for (let t = 0; t < 90; t += 0.5) {
        let sum = 0;
        for (const [w, n] of walls) if (Math.abs(apart(w, t)) <= 1.5) sum += n;
        if (sum > top) { top = sum; peak = t; }
      }
      let sum = 0, n = 0, square = 0;
      for (const [w, m] of walls) {
        const d = apart(w, peak);
        if (Math.abs(d) <= 1) { sum += d * m; n += m; }
        if (Math.abs(apart(w, 0)) <= 1.5) square += m;
      }
      deg = peak + (n ? sum / n : 0);
      if (deg > 45) deg -= 90;
      if (Math.abs(deg) < 3 || square >= top * 0.6) deg = 0;
    }
    const turn = spread(deg);
    const { c, s } = turn;

    // the squares again, on a grid turned that way: u along, v across
    const U0 = Math.floor(turn.u0) - 1, V0 = Math.floor(turn.v0) - 1;
    const W = Math.ceil(turn.u1) - U0 + 2, H = Math.ceil(turn.v1) - V0 + 2;
    let on = new Uint8Array(W * H);
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const u = U0 + i + 0.5, v = V0 + j + 0.5;
        on[j * W + i] = inside(Math.floor(u * c - v * s), Math.floor(u * s + v * c)) ? 1 : 0;
      }
    }
    const at = (i, j) => i >= 0 && j >= 0 && i < W && j < H && on[j * W + i] === 1 ? 1 : 0;

    // a square with one side or none on the floor goes, a gap with three or four sides on it is filled
    for (let pass = 0; pass < 6; pass++) {
      const next = on.slice();
      let changed = false;
      for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
          const n = at(i - 1, j) + at(i + 1, j) + at(i, j - 1) + at(i, j + 1);
          const k = j * W + i;
          if (on[k] && n <= 1) { next[k] = 0; changed = true; }
          else if (!on[k] && n >= 3) { next[k] = 1; changed = true; }
        }
      }
      on = next;
      if (!changed) break;
    }

    // trace it, keep only the corners, and turn them back
    const back = (i, j) => {
      const u = U0 + i, v = V0 + j;
      return [u * c - v * s, u * s + v * c];
    };
    return traceSquares(at, W, H).map(flatten).map(unstair).filter(loop => loop.length > 2).map(loop => loop.map(p => back(p[0], p[1])));
  }

  // A loop of corners straightened (Douglas-Peucker) where it strays less than `most` from a straight line.
  function straighten(loop, most) {
    if (loop.length < 5) return loop;
    // split the loop at the corner farthest from its first, and straighten each half
    let far = 0, best = -1;
    for (let i = 1; i < loop.length; i++) {
      const d = (loop[i][0] - loop[0][0]) ** 2 + (loop[i][1] - loop[0][1]) ** 2;
      if (d > best) { best = d; far = i; }
    }
    const half = pts => {
      const keep = new Uint8Array(pts.length);
      keep[0] = keep[pts.length - 1] = 1;
      const todo = [[0, pts.length - 1]];
      while (todo.length) {
        const [i, j] = todo.pop();
        const [ax, ay] = pts[i], dx = pts[j][0] - ax, dy = pts[j][1] - ay, len = Math.hypot(dx, dy) || 1;
        let worst = -1, at = -1;
        for (let k = i + 1; k < j; k++) {
          const d = Math.abs((pts[k][0] - ax) * dy - (pts[k][1] - ay) * dx) / len;
          if (d > worst) { worst = d; at = k; }
        }
        if (worst > most) { keep[at] = 1; todo.push([i, at], [at, j]); }
      }
      return pts.filter((p, k) => keep[k]);
    };
    const a = half(loop.slice(0, far + 1)), b = half(loop.slice(far).concat([loop[0]]));
    return a.slice(0, -1).concat(b.slice(0, -1));
  }

  // A square-cornered loop with its stairs made slants again: five or more short edges in a row turning left,
  // right, left and so on, every other one a single square (the risers) and the rest four squares or less (the
  // treads), are a wall at a slant to the building, and go straight from the first corner to the last. A
  // crenellated edge (left, left, right, right) and a real corner of the building (no run of single squares) stay.
  function unstair(pts) {
    const n = pts.length;
    if (n < 6) return pts;
    const size = e => Math.abs(pts[(e + 1) % n][0] - pts[e][0]) + Math.abs(pts[(e + 1) % n][1] - pts[e][1]);
    const short = e => size(e) <= 4;
    const turn = k => {
      const a = pts[(k + n - 1) % n], p = pts[k], b = pts[(k + 1) % n];
      return Math.sign((p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]));
    };
    let s = -1;
    for (let e = 0; e < n && s < 0; e++) if (!short(e)) s = e;
    if (s < 0) return pts;
    const keep = new Uint8Array(n).fill(1);
    let start = 0, count = 0, last = 0;
    const end = () => {
      let odd = true, even = true;
      for (let q = 0; q < count; q++) {
        if (size((start + q) % n) !== 1) { if (q % 2) odd = false; else even = false; }
      }
      if (count >= 5 && (odd || even)) for (let q = 1; q < count; q++) keep[(start + q) % n] = 0;
      count = 0;
      last = 0;
    };
    for (let m = 1; m <= n; m++) {
      const e = (s + m) % n;
      if (!short(e)) { end(); continue; }
      if (count) {
        const t = turn(e);
        if (last && t === last) end();
        else { last = t; count++; continue; }
      }
      start = e;
      count = 1;
    }
    end();
    return pts.filter((p, k) => keep[k]);
  }

  // A square-cornered loop without its shallow nubs and dents: where the edge steps out (or in) by one square and
  // back again within five, it's straightened through. Stairs, which step the same way twice, are left alone.
  function flatten(loop) {
    const len = (p, q) => Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]);
    const corner = (a, p, b) => (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]) !== 0;
    let pts = loop.slice();
    for (let changed = true, guard = 0; changed && guard < 1000; guard++) {
      changed = false;
      const n = pts.length;
      if (n < 6) break;
      for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n], c = pts[(i + 2) % n], d = pts[(i + 3) % n];
        if (len(a, b) !== 1 || len(c, d) !== 1 || len(b, c) > 5) continue;
        // out by one and back by one: a to b and c to d point opposite ways
        if ((b[0] - a[0]) !== -(d[0] - c[0]) || (b[1] - a[1]) !== -(d[1] - c[1])) continue;
        const drop = new Set([(i + 1) % n, (i + 2) % n]);
        pts = pts.filter((p, k) => !drop.has(k));
        pts = pts.filter((p, k) => corner(pts[(k + pts.length - 1) % pts.length], p, pts[(k + 1) % pts.length]));
        changed = true;
        break;
      }
    }
    return pts;
  }

  // The outline of a set of squares (inside(column, row), 0 to wide and tall), as closed loops of square corners
  // [column, row] with the inside on the left, a corner kept only where the edge turns.
  function traceSquares(inside, wide, tall) {
    const from = new Map();
    const id = (x, y) => x * 65536 + y;
    const add = (x0, y0, x1, y1) => {
      const k = id(x0, y0);
      if (!from.has(k)) from.set(k, []);
      from.get(k).push([x1, y1]);
    };
    for (let cy = 0; cy < tall; cy++) {
      for (let cx = 0; cx < wide; cx++) {
        if (!inside(cx, cy)) continue;
        if (!inside(cx, cy - 1)) add(cx, cy, cx + 1, cy);
        if (!inside(cx + 1, cy)) add(cx + 1, cy, cx + 1, cy + 1);
        if (!inside(cx, cy + 1)) add(cx + 1, cy + 1, cx, cy + 1);
        if (!inside(cx - 1, cy)) add(cx, cy + 1, cx, cy);
      }
    }
    const loops = [];
    for (const [start, outs] of from) {
      while (outs.length) {
        const loop = [];
        let k = start;
        for (let guard = 0; guard < 1e6; guard++) {
          const list = from.get(k);
          if (!list || !list.length) break;
          loop.push([Math.floor(k / 65536), k % 65536]);
          const to = list.pop();
          k = id(to[0], to[1]);
          if (k === start) break;
        }
        const corners = loop.filter((p, i) => {
          const a = loop[(i + loop.length - 1) % loop.length], b = loop[(i + 1) % loop.length];
          return (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]) !== 0;
        });
        if (corners.length > 2) loops.push(corners);
      }
    }
    return loops;
  }

  function drawFloorEdge() {
    if (!floorEdge.length) return;
    ctx.save();
    ctx.beginPath();
    for (const loop of floorEdge) {
      loop.forEach((p, i) => {
        const s = toScreen(p[0], p[1]);
        if (i) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]);
      });
      ctx.closePath();
    }
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineWidth = 4.5;
    ctx.stroke();
    ctx.strokeStyle = '#5fd4ff';
    ctx.lineWidth = 2;
    ctx.stroke();
    if (floorOwn.length) {
      ctx.beginPath();
      for (const loop of floorOwn) {
        loop.forEach((p, i) => {
          const s = toScreen(p[0], p[1]);
          if (i) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]);
        });
        ctx.closePath();
      }
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 3.5;
      ctx.stroke();
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }

  // the building under the pointer that can be pressed open: greyed over, with a solid outline (a dashed one crawls as the map zooms)
  function drawHovered() {
    const list = map.floors && map.floors.buildings;
    if (list && revealing()) {
      ctx.save();
      ctx.beginPath();
      list.forEach((b, i) => {
        if (BUILDING + i === floorShown.place) return;
        for (const loop of b.l) {
          for (let k = 0; k + 1 < loop.length; k += 2) {
            const s = toScreen(loop[k], loop[k + 1]);
            if (k) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]);
          }
          ctx.closePath();
        }
      });
      ctx.fillStyle = 'rgba(160,166,172,0.2)';
      ctx.fill('evenodd');
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.lineWidth = 3.5;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(240,242,244,0.9)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    }
    const b = hovered && list ? list[hovered - BUILDING] : null;
    if (!b) return;
    ctx.save();
    ctx.beginPath();
    for (const loop of b.l) {
      for (let i = 0; i + 1 < loop.length; i += 2) {
        const s = toScreen(loop[i], loop[i + 1]);
        if (i) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]);
      }
      ctx.closePath();
    }
    ctx.fillStyle = 'rgba(160,166,172,0.32)';
    ctx.fill('evenodd');
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(240,242,244,0.95)';
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.restore();
  }

  function showMap(next, keepPlace) {
    if (!next || next === map) return;
    map = next;
    layersEl.textContent = '';
    tiles = [];
    tilesPrint = '';
    lapShown = 0;
    for (let row = 0; row < map.rows; row++) {
      for (let col = 0; col < map.cols; col++) {
        const img = new Image();
        img.alt = '';
        img.draggable = false;
        img.decoding = 'async';
        img.bx = (map.min.x + col * map.tile);
        img.by = -(map.min.y + (row + 1) * map.tile);
        layTile(img);
        layersEl.appendChild(img);
        tiles.push({ img, col, row, at: row * map.cols + col, want: '' });
      }
    }
    // over the map while a floor is shown, under that floor: the rest of the map darkened (Settings > View > "Map round
    // a floor"), one layer for the whole map so moving and zooming cost nothing more
    const shade = document.createElement('div'), pad = map.tile * 2;
    shade.id = 'floorShade';
    shade.hidden = true;
    Object.assign(shade.style, { left: (map.min.x - pad) + 'px', top: (-(map.min.y + map.rows * map.tile) - pad) + 'px',
      width: (map.cols * map.tile + 2 * pad) + 'px', height: (map.rows * map.tile + 2 * pad) + 'px' });
    layersEl.appendChild(shade);
    floorEl = document.createElement('div');
    floorEl.id = 'floorLayer';
    floorEl.hidden = true;
    layersEl.appendChild(floorEl);
    floorShown = { place: 0, n: 0 };
    floorWantKey = '0:0';
    floorTiles = [];
    floorEdge = [];
    opened = 0;
    lookShut = 0;
    hovered = 0;
    floorPick = null;
    stage.classList.remove('canOpen');
    $('reveal').hidden = !(prefs.pressOpen && map.floors && map.floors.buildings);
    layersEl.classList.remove('dim');
    $('floorBadge').hidden = true;
    places = null;
    lootTable = null;
    lootAsked = '';
    loadPlaces(true);
    loadSpawns();
    listFloors();
    turn = turnFor(map.loc);
    $('optTurn').value = prefs.turns && prefs.turns[map.loc] !== undefined ? String(prefs.turns[map.loc]) : 'auto';
    setZoomLimits();
    $('map').value = map.loc;
    mapBtnSays();
    if (!keepPlace) {
      zoom = zoomTarget = zoomMin;
      centreOn((map.min.x + map.max.x) / 2, (map.min.y + map.max.y) / 2);
    }
    pointed = null;
    dirty = true;
  }

  // ---- what lies about, and where things stand -------------------------------------------------------------------
  // The places on a location (containers, locks, spawn points), kept by the server since a raid there; asked for
  // when a map is shown, and again now and then while there are none.
  async function loadPlaces(force) {
    if (!map) return;
    const loc = map.loc, now = performance.now();
    if (!force && placesAsked === loc && (places || placesNone || now - placesAskedAt < 15000)) return;
    placesAsked = loc;
    placesAskedAt = now;
    try {
      const answer = await (await fetch('api/places?loc=' + encodeURIComponent(loc))).json();
      if (!map || map.loc !== loc) return;
      placesNone = !!(answer && answer.none);
      places = answer && !answer.none ? readPlaces(answer) : null;
      addMore();
      placeZones();
      dirty = true;
    } catch (e) { /* asked again in a while */ }
  }
  const list = v => Array.isArray(v) ? v : [];
  // a container of a sort switched off under Loot > Filters > Kinds of container
  const boxHidden = b => prefs.boxOff.length > 0 && prefs.boxOff.includes(((places && places.names || {})[b.tpl] || {}).c || 'crate');
  // what one of a thing that can spawn is worth; money comes in stacks of no set size, so its price is said to be for one
  const canWorth = (tn, tpl) => roubles((tn[tpl] || {}).p || 0) + ((tn[tpl] || {}).g === 'money' ? ' ' + T('each') : '');
  const at3 = p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
  // Where loot can spawn on the map shown, and what: asked for once the layer is switched on. Nothing to do with a
  // raid: it's what the server rolls each raid's loot from.
  async function loadSpawns() {
    if (!map || isHidden('Layer lootSpawns')) return;
    const loc = map.loc, now = performance.now();
    if (lootAsked === loc && (lootTable || lootNone || now - lootAskedAt < 15000)) return;
    lootAsked = loc;
    lootAskedAt = now;
    try {
      const answer = await (await fetch('api/spawns?loc=' + encodeURIComponent(loc))).json();
      if (!map || map.loc !== loc) return;
      lootNone = !!(answer && answer.none);
      lootTable = answer && !answer.none ? readSpawns(answer, map) : null;
      bestPrint = bestCanPrint = null;
      dirty = true;
    } catch (e) { /* asked again in a while */ }
  }
  // {loc, loose:[[east,north,height,chance,[[tpl,share],..]],..], boxes:{containerTpl:[[tpl,chance],..]},
  //  boxChance:{containerId:chance}, names}: each point with what it can spawn, its dearest first ("best": that one's worth)
  function readSpawns(raw, on) {
    const names = raw.names || {};
    const worth = tpl => (names[tpl] || {}).p || 0;
    // the ground the map's picture covers: a point off it is in no part of the map there is to show (Factory's loot
    // table has a hundred-odd south-east of the building, drawn over nothing)
    const inside = !on || !on.min || !(on.tile > 0) ? () => true
      : (x, y) => x >= on.min.x - 2 && y >= on.min.y - 2 && x <= on.min.x + on.cols * on.tile + 2 && y <= on.min.y + on.rows * on.tile + 2;
    const points = list(raw.loose).filter(p => Array.isArray(p) && p.length >= 5 && [p[0], p[1], p[2], p[3]].every(Number.isFinite) && Array.isArray(p[4]))
      // (a point at 0 never spawns: one the server can't reach, as a second point under another's id)
      .filter(p => !(p[3] <= 0) && inside(p[0], p[1]))
      .map(p => ({ x: p[0], y: p[1], z: p[2], chance: p[3], items: p[4].filter(i => Array.isArray(i) && typeof i[0] === 'string').sort((a, b) => worth(b[0]) - worth(a[0])) }));
    // each point's kind: the kind of loot that's at least half of what it spawns, else "mixed"; and of each kind, how
    // many points and what they spawn most (each item's shares added up)
    const kinds = new Map();
    for (const pt of points) {
      const by = new Map();
      for (const i of pt.items) {
        const g = (names[i[0]] || {}).g || 'other';
        by.set(g, (by.get(g) || 0) + (+i[1] || 0));
      }
      let top = 'mixed', most = 0;
      for (const [g, share] of by) if (share > most) { most = share; top = g; }
      pt.kind = most >= 0.5 && SPAWN_KINDS[top] ? top : 'mixed';
      // a point that spawns nothing but quest items is a quest item's: drawn and switched as those are
      pt.quest = pt.items.length > 0 && pt.items.every(i => !!(names[i[0]] || {}).q);
      if (pt.quest) pt.kind = 'quest';
      let k = kinds.get(pt.kind);
      if (!k) kinds.set(pt.kind, k = { kind: pt.kind, count: 0, items: new Map() });
      k.count++;
      for (const i of pt.items) k.items.set(i[0], (k.items.get(i[0]) || 0) + (+i[1] || 0));
    }
    return { loc: raw.loc, names, points, kinds, boxes: raw.boxes || {}, boxChance: raw.boxChance || {} };
  }
  // A loot spawn point's kind, by what it mostly spawns (the kinds of loot, see LOOT_KINDS): a name, and what it is
  const SPAWN_KINDS = {
    electronics: [T('Tech'), T('Electronics: wires, circuit boards, drives, graphics cards, batteries and the like.')],
    meds: [T('Medical'), T('Medicine and medical supplies: kits, injectors, LEDX and the like.')],
    valuables: [T('Valuables'), T('Gold, figurines, watches, bitcoin and other things worth selling.')],
    keys: [T('Key'), T('Keys and keycards.')],
    info: [T('Intel'), T('Intelligence folders, diaries, flash drives, maps.')],
    mods: [T('Weapon parts'), T('Sights, grips, magazines, barrels and other attachments.')],
    ammo: [T('Ammo'), T('Rounds and ammo packs.')],
    food: [T('Provisions'), T('Food and drink.')],
    weapons: [T('Weapon'), T('Guns and melee weapons.')],
    gear: [T('Gear'), T('Armour, helmets, rigs, bags, headsets and clothing.')],
    tools: [T('Tools, materials'), T('Tools, screws, tape, hoses, building materials.')],
    household: [T('Household junk'), T('Cleaning supplies, fuel, flammables and other household barter items.')],
    money: [T('Money'), T('Roubles, dollars, euros.')],
    special: [T('Special'), T('Special equipment: markers, signal jammers, radios.')],
    quest: [T('Quest item'), T('Things quests send you for: they lie in the same place every raid.')],
    other: [T('Other'), T('Things the server has no kind for.')],
    mixed: [T('Mixed'), T('No one kind: a bit of everything.')],
  };
  // What a spawn point of each kind is drawn with, once zoomed in: a picture of our own, in lines, so it's told
  // from a container (a solid picture on a square). Each is drawn in a box 24 across: [path, 'f' filled, 'e' filled
  // with its inner shapes cut out, or 's' in outline].
  const ring = (x, y, r) => 'M' + (x - r) + ' ' + y + 'a' + r + ' ' + r + ' 0 1 0 ' + 2 * r + ' 0a' + r + ' ' + r + ' 0 1 0 ' + -2 * r + ' 0z';
  const ICONS = {
    // a tick, as the game marks an item found in raid (loot a started quest wants found in raid)
    fir: [['M5.5 12.8l4.3 4.2L18.8 7.2', 's']],
    // a five-pointed star, put in the middle by its points (a font's ★ sits a little off, and differently in each)
    star: [['M12 2.5L14.78 9.18L21.99 9.76L16.49 14.46L18.17 21.5L12 17.73L5.83 21.5L7.51 14.46L2.01 9.76L9.22 9.18Z', 'f']],
    // a cross
    meds: [['M9 3h6v6h6v6h-6v6H9v-6H3V9h6z', 'f']],
    // a cartridge, stood up
    // three rounds side by side
    ammo: [['M6 4c1.6 1.6 2 3.6 2 6h-4c0-2.4 .4-4.4 2-6zM4 11.5h4V20h-4zM12 4c1.6 1.6 2 3.6 2 6h-4c0-2.4 .4-4.4 2-6zM10 11.5h4V20h-4zM18 4c1.6 1.6 2 3.6 2 6h-4c0-2.4 .4-4.4 2-6zM16 11.5h4V20h-4z', 'f']],
    // a pistol
    weapons: [['M2.500 6h18.500v4.500h-7.500l-1.200 2.500H9.800L8.500 19.500H4l1.600-9H2.500z', 'f']],
    // a nut
    mods: [['M12 2.500l8.200 4.750v9.500L12 21.500l-8.200-4.750v-9.500z', 's'], [ring(12, 12, 3.200), 's']],
    // a helmet
    // an armoured vest: shoulder straps, a scooped neck, two pouches cut out of the front
    gear: [['M6.5 3h3c0 1.700 1 2.800 2.500 2.800S14.500 4.700 14.500 3h3l2 5.500-2 1.500V21h-11V10l-2-1.500zM8.300 13.200h3v4h-3zM12.700 13.200h3v4h-3z', 'f']],
    // a chip
    electronics: [['M7 7h10v10H7z', 's'], ['M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4', 's']],
    // a cut stone
    valuables: [['M6.500 4h11l4.500 6L12 21 2 10z', 's'], ['M2 10h20M9 4l3 6 3-6', 's']],
    // a key
    keys: [[ring(8, 8, 4.500), 's'], ['M11.200 11.200l9.300 9.300M16 16l2.500-2.500M19 19l2.500-2.500', 's']],
    // a folder
    info: [['M2.500 5.500h6.500l2 2.500h10.500v11.500h-19z', 's'], ['M2.500 11h19', 's']],
    // a tin
    food: [['M5.500 6.500c0-1.700 2.900-3 6.500-3s6.500 1.300 6.500 3v11c0 1.700-2.900 3-6.500 3s-6.500-1.300-6.500-3z', 's'], ['M5.500 6.500c0 1.700 2.900 3 6.500 3s6.500-1.300 6.500-3', 's']],
    // a hammer
    tools: [['M4 3.500h10.500l4 3.500h-4v1.500H4z', 'f'], ['M8.500 8.500h3.500v12.500H8.500z', 'f']],
    // a bottle
    household: [['M9.500 2.500h5v3l2.500 3.500v12h-10V9l2.500-3.500z', 's'], ['M7 13.500h10', 's']],
    // a banknote
    money: [['M2 6.500h20v11H2z', 's'], [ring(12, 12, 2.700), 's'], ['M5.500 10v4M18.500 10v4', 's']],
    // a radio
    special: [['M7 9.500h10v11.500H7z', 's'], ['M10 9.500V3M10.500 13.500h3M14.500 3.500c2 .800 3.500 2.300 4 4.500', 's']],
    // containers: a safe, a till, a filing cabinet, a holdall, a jacket, a toolbox, a computer, a grenade, a long
    // box with a rifle in it, a medical case, a ration box, a barrel's lid from above (a buried cache), a skull, a
    // crate: solid shapes with the detail cut out of them
    boxSafe: [['M3 2.5h18v16.5h-18zM5.9 10.7a4.6 4.6 0 1 0 9.2 0a4.6 4.6 0 1 0 -9.2 0zM8.2 10.7a2.3 2.3 0 1 0 4.6 0a2.3 2.3 0 1 0 -4.6 0zM17 7.7h1.7v6h-1.7z','e'],['M4.5 19h4v2.3h-4zM15.5 19h4v2.3h-4z','f']],
    boxRegister: [['M2.5 15h19v6.5h-19zM9.5 17.6h5v1.4h-5z','e'],['M4.800 14l2.400-7.800h9.600l2.400 7.800zM8.6 8h1.5v1.5h-1.5zM11.25 8h1.5v1.5h-1.5zM13.9 8h1.5v1.5h-1.5zM8 10.8h1.5v1.5h-1.5zM11.25 10.8h1.5v1.5h-1.5zM14.5 10.8h1.5v1.5h-1.5z','e'],['M12 1.8h7.5v3.4h-7.5z','f']],
    boxDrawer: [['M4.5 2.5h15v17h-15zM4.5 10.4h15v1.200h-15zM9.500 5.800h5v1.600h-5zM9.500 14.500h5v1.600h-5z','e'],['M5.500 19.500h2.800v2.200H5.500zM15.700 19.500h2.800v2.200h-2.800z','f']],
    boxBag: [['M1.800 13a4 4 0 0 1 4-4h12.400a4 4 0 0 1 4 4v3.500a4 4 0 0 1-4 4H5.800a4 4 0 0 1-4-4zM5.6 9h1.4v11.5h-1.4zM17 9h1.4v11.5h-1.4z','e'],['M8.500 9C8.500 4 15.500 4 15.500 9','s']],
    boxJacket: [['M8.500 2.300l3.500 3 3.500-3 5 2.700 2.200 8.500-3.200 1.200-1-3.700v10.700h-13V11l-1 3.700-3.200-1.200L3.500 5zM11.4 7h1.2v14.7h-1.2z','e']],
    boxTools: [['M2.3 10.3h19.4v10.4h-19.4zM10.2 12.6h3.6v3.4h-3.6z','e'],['M3.6 8h16.8v1.5h-16.8z','f'],['M8.500 8V5.300h7V8','s']],
    boxPc: [['M6 1.8h12v20.4h-12zM8.3 4.2h7.4v1.6h-7.4zM8.3 7.2h7.4v1.6h-7.4zM10 16.6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0z','e']],
    boxGrenade: [['M5.5 15.200a6.500 6.500 0 1 0 13 0a6.500 6.500 0 1 0-13 0z','f'],['M9.800 4.800h4.400v4.400H9.800z','f'],['M14 4.800h5v7.200h-1.900V6.700H14z','f'],['M4.800 6.800a2.200 2.200 0 1 0 4.400 0a2.200 2.200 0 1 0-4.400 0z','s']],
    boxWeapon: [['M2 4.500h20v15H2zM4 6.500h16v11H4z','e'],['M6 8.800h12v3.200h-5l-.900 1.600h-1.900l-.800 2.900H6.600l1-4.500H6z','f']],
    boxMed: [['M3.500 7h17a1.500 1.500 0 0 1 1.500 1.500v11a1.500 1.500 0 0 1-1.500 1.500h-17A1.500 1.500 0 0 1 2 19.500v-11A1.500 1.500 0 0 1 3.500 7zM10.500 9.700h3v3h3v3h-3v3h-3v-3h-3v-3h3z','e'],['M9 7V4.300h6V7','s']],
    boxFood: [['M3 11.2h18v10h-18zM8 14.4h8v3h-8z','e'],['M11.300 10L9.500 5.500H1.800L3.300 10zM12.700 10l1.800-4.500h7.700L20.700 10z','f']],
    boxCache: [['M2.5999999999999996 12a9.4 9.4 0 1 0 18.8 0a9.4 9.4 0 1 0 -18.8 0zM4.6 12a7.4 7.4 0 1 0 14.8 0a7.4 7.4 0 1 0 -14.8 0z','e'],['M6.2 12a5.8 5.8 0 1 0 11.6 0a5.8 5.8 0 1 0 -11.6 0zM12.8 9.9a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0z','e']],
    boxBody: [['M7.800 7.300a4.200 4.200 0 1 0 8.400 0a4.200 4.200 0 1 0-8.400 0z','f'],['M3.500 21.500c0-5.200 3.600-8.300 8.500-8.300s8.500 3.100 8.500 8.300z','f']],
    // a wooden crate: a square frame braced corner to corner both ways
    boxCrate: [['M2.500 2.500h19v19h-19zM5.200 5.200h13.600v13.600H5.200z','e'],['M4.600 6.300L6.300 4.600 19.400 17.700 17.700 19.400z','f'],['M17.700 4.600L19.400 6.300 6.300 19.400 4.600 17.700z','f']],
    // a padlock, shut and open; a car (a locked trunk); a keycard; the BTR's stop, a sign on a post
    lock: [['M5.500 11h13v9.500h-13z', 's'], ['M8.500 11V8a3.500 3.500 0 0 1 7 0v3', 's'], [ring(12, 15.500, 1.500), 'f']],
    unlocked: [['M5.500 11h13v9.500h-13z', 's'], ['M8.500 11V7.500a3.500 3.500 0 0 1 6.800-1.200', 's'], [ring(12, 15.500, 1.500), 'f']],
    trunk: [['M2.500 16.500v-4l2.500-1 2.500-4.500h8l3 4.500 3 1v4z', 's'], [ring(7.500, 17, 2) + ring(16.500, 17, 2), 'f'], ['M8.500 11.500h7', 's']],
    keycard: [['M2.500 5.500h19v13h-19z', 's'], ['M2.500 8.500h19v3h-19z', 'f'], ['M5.500 15h5', 's']],
    stop: [['M12 21.500V10.500', 's'], ['M6.500 3h11v7.500h-11z', 's'], ['M9 6.800h6', 's']],
    // a switch: the sign for power; a room's light switch: a bulb
    power: [['M7.100 6.600a7.500 7.500 0 1 0 9.800 0', 's'], ['M12 2.800v8.700', 's']],
    bulb: [['M12 2.800a6 6 0 0 0-3.600 10.800c.700.500 1.100 1.300 1.100 2.100v.600h5v-.600c0-.800.400-1.600 1.100-2.100A6 6 0 0 0 12 2.800z', 's'], ['M9.500 19.200h5M10.500 21.700h3', 's']],
    // a die
    // a die showing five: a solid rounded face, its pips cut out
    mixed: [['M6.5 3.5h11a3 3 0 0 1 3 3v11a3 3 0 0 1-3 3h-11a3 3 0 0 1-3-3v-11a3 3 0 0 1 3-3z' + ring(8.2, 8.2, 1.5) + ring(15.8, 8.2, 1.5) + ring(12, 12, 1.5) + ring(8.2, 15.8, 1.5) + ring(15.8, 15.8, 1.5), 'f']],
  };
  const SPAWN_GLYPH = {
    electronics: 'i:electronics', meds: 'i:meds', valuables: 'i:valuables', keys: 'i:keys', info: 'i:info', mods: 'i:mods', ammo: 'i:ammo',
    food: 'i:food', weapons: 'i:weapons', gear: 'i:gear', tools: 'i:tools', household: 'i:household', money: 'i:money', special: 'i:special',
    other: '?', mixed: 'i:mixed'
  };
  const SPAWN_INK = '#f4f5f6';
  // a lock's key: with the player, in their stash, not had (see My keys)
  const KEY_WITH = '#7dff8a', KEY_STASH = '#ffc94d', KEY_NONE = '#50535e';
  // from how far out they have their pictures: the screen's short side this many metres across, or fewer
  const SPAWN_PICTURES = 320;
  const spawnKindName = kind => (SPAWN_KINDS[kind] || SPAWN_KINDS.mixed)[0];
  // the box of the map's spawn kinds: while the spawn points are shown
  let spawnIndexFor = null;
  function showSpawnIndex() {
    const table = lootTable && map && sameMap(lootTable.loc, map.loc) && !isHidden('Layer lootSpawns') ? lootTable : null;
    const box = $('spawnIndex');
    if (table === spawnIndexFor) return;
    spawnIndexFor = table;
    box.hidden = !table;
    if (!table) return;
    const list = $('spawnKinds');
    list.textContent = '';
    const tn = table.names;
    for (const k of [...table.kinds.values()].sort((a, b) => b.count - a.count)) {
      const row = document.createElement('div');
      row.className = 'kind';
      const name = document.createElement('b');
      name.textContent = T('{kind} spawn', { kind: spawnKindName(k.kind) });
      const count = document.createElement('em');
      count.textContent = '×' + k.count;
      const about = document.createElement('p');
      about.textContent = (SPAWN_KINDS[k.kind] || SPAWN_KINDS.mixed)[1];
      const usual = document.createElement('p');
      // of a kind's points, only what is of that kind: a money point can also spawn a few rounds, which aren't money
      const own = [...k.items].filter(([tpl]) => !SPAWN_KINDS[k.kind] || k.kind === 'mixed' || ((tn[tpl] || {}).g || 'other') === k.kind);
      usual.textContent = T('Here mostly:') + ' ' + (own.length ? own : [...k.items]).sort((a, b) => b[1] - a[1]).slice(0, 6)
        .map(([tpl]) => (tn[tpl] || {}).s || (tn[tpl] || {}).n || tpl).join(', ');
      row.append(count, name, about, usual);
      list.appendChild(row);
    }
  }
  // ---- search ----
  // What players call things, to what the game calls them (lower case; any of them will do)
  const FIND_SLANG = {
    btc: ['bitcoin'], bitcoin: ['bitcoin'], gpu: ['graphics card'], vpx: ['vpx flash storage'], usb: ['flash drive'], hdd: ['hard drive', 'hdd'],
    ssd: ['ssd'], intel: ['intelligence'], folder: ['intelligence folder'], lion: ['bronze lion'], horse: ['horse figurine'],
    cat: ['cat figurine'], rolex: ['roler'], skull: ['skull ring'], chain: ['gold chain'], tg: ['terragroup'], nvg: ['night vision'],
    mag: ['magazine'], mags: ['magazine'], defib: ['defibrillator'], aesa: ['phased array'], phase: ['phased array'], tp: ['toilet paper'],
    rr: ['red rebel'], wd40: ['wd-40'], gp: ['gp coin'], gpcoin: ['gp coin'], tushonka: ['beef stew'], tush: ['beef stew'], beef: ['beef stew'],
    labs: ['labs', 'laboratory'], keycard: ['keycard', 'access card'], card: ['keycard', 'card'], cms: ['cms surgical'], surv: ['surv12'],
    ifak: ['ifak'], afak: ['afak'], meds: ['medical'], ammo: ['ammo', 'cartridge', 'round'], m4: ['m4a1'], ak: ['ak-'], moonshine: ['moonshine'],
    bolts: ['bolts'], nuts: ['nuts'], fuel: ['fuel conditioner', 'fuel'], tank: ['tank battery'], ofz: ['ofz'], lvndmark: ['lvndmark'],
    sicc: ['sicc'], kappa: ['kappa'], gas: ['gas analyzer'], vase: ['vase'], dvd: ['dvd'], cpu: ['cpu fan', 'pc cpu'], ram: ['ram'],
    eagle: ['eagle'], prokill: ['prokill'], mule: ['mule'], propital: ['propital'], etg: ['etg'], salewa: ['salewa'], grizzly: ['grizzly'],
  };
  // a name made plain: lower case, in words of letters or of numbers (0.2BTC: 0 2 btc)
  const plain = text => String(text || '').toLowerCase().replace(/([0-9])([a-zа-яё])|([a-zа-яё])([0-9])/g, '$1$3 $2$4').replace(/[^a-z0-9а-яё]+/g, ' ').trim();
  // how many letters apart two words are (a letter changed, added, dropped, or two swapped), up to most (more: most + 1)
  function apart(a, b, most) {
    if (Math.abs(a.length - b.length) > most) return most + 1;
    let before = null, row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      let low = i;
      for (let j = 1; j <= b.length; j++) {
        next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (before && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) next[j] = Math.min(next[j], before[j - 2] + 1);
        low = Math.min(low, next[j]);
      }
      if (low > most) return most + 1;
      before = row;
      row = next;
    }
    return row[b.length];
  }
  // Whether a name is what's searched for: every word searched for is in it, in any order: at the start of one of its
  // words (a short one: gpu isn't in Magpul) or, five letters or more, anywhere; as players call it (btc: bitcoin); run
  // over its words (m4: M4A1); or a letter off (two from ten letters) in a longer word (bitcion). Kept per name.
  // findExact: a name picked from the list, found by that name only
  let findWords = [], findMemo = new Map(), findExact = '';
  function setFind(text, exact) {
    find = text.trim().toLowerCase();
    findMemo = new Map();
    findExact = exact ? plain(find) : '';
    // (its words as typed: m4 stays one word, to be found run over a name's words)
    const typed = find.replace(/[^a-z0-9а-яё]+/g, ' ').trim();
    findWords = typed.split(' ').filter(Boolean).map(w => ({ w, also: (FIND_SLANG[w] || []).map(plain) }));
  }
  function findHits(text) {
    if (!text || !findWords.length) return false;
    let yes = findMemo.get(text);
    if (yes !== undefined) return yes;
    const name = plain(text), words = name.split(' ');
    if (findExact) {
      findMemo.set(text, yes = name === findExact);
      return yes;
    }
    // the name run together from each word on
    const runs = words.map((_, i) => words.slice(i).join(''));
    const starts = t => (' ' + name).includes(' ' + t) || runs.some(r => r.startsWith(t.replace(/ /g, '')));
    yes = findWords.every(({ w, also }) => {
      if (starts(w) || (w.length >= 5 && name.replace(/ /g, '').includes(w)) || also.some(starts)) return true;
      if (w.length < 5) return false;
      const most = w.length >= 10 ? 2 : 1;
      return words.some(n => apart(w, n.slice(0, w.length + most), most) <= most);
    });
    findMemo.set(text, yes);
    return yes;
  }
  // what was found, by name and kind, under the box: { label, kind, spots: [[east, north],..] }
  let findShown = '', findNext = new Map();
  // The list's tabs: what was found, by what it is. findGroup: the tab shown ('all': every one); it goes back to all
  // when a search finds nothing under it.
  const FIND_GROUPS = [['all', T('All')], ['items', T('Items')], ['objects', T('Objects')], ['spawns', T('Spawns')], ['quests', T('Quests')], ['extracts', T('Extracts')]];
  let findGroup = 'all';
  function showFindList(results, looking) {
    const list = $('findList');
    const open = looking && findOpen;
    const all = !open ? [] : [...results.values()];
    const counts = {};
    for (const r of all) counts[r.group] = (counts[r.group] || 0) + 1;
    if (findGroup !== 'all' && !counts[findGroup]) findGroup = 'all';
    const tabs = FIND_GROUPS.filter(([g]) => g === 'all' || counts[g]);
    const rows = all.filter(r => findGroup === 'all' || r.group === findGroup)
      .sort((a, b) => b.spots.length - a.spots.length || a.label.localeCompare(b.label)).slice(0, 40);
    const print = open ? find + '|' + findGroup + '|' + tabs.map(t => t[0] + (counts[t[0]] || 0)).join() + '|' + rows.map(r => r.kind + r.label + r.spots.length).join('|') : '';
    if (print === findShown) return;
    findShown = print;
    list.hidden = !open;
    if (!open) return;
    const box = $('findBox').getBoundingClientRect();
    list.style.left = Math.max(8, box.left) + 'px';
    list.style.top = (box.bottom + 6) + 'px';
    list.style.width = Math.min(window.innerWidth - 16, Math.max(box.width, 320)) + 'px';
    list.textContent = '';
    // the tabs, when what was found is of more than one kind
    if (tabs.length > 2) {
      const bar = document.createElement('div');
      bar.className = 'tabs';
      for (const [g, name] of tabs) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'tab' + (g === findGroup ? ' on' : '');
        tab.textContent = name + (g === 'all' ? '' : ' ' + counts[g]);
        // the box keeps the keyboard
        tab.onpointerdown = e => e.preventDefault();
        tab.onclick = () => { findGroup = g; findShown = ''; dirty = true; };
        bar.appendChild(tab);
      }
      list.appendChild(bar);
    }
    if (!rows.length) {
      const none = document.createElement('div');
      none.className = 'none';
      none.textContent = map ? T('Nothing found for "{find}" on this map', { find }) : T('Nothing found for "{find}"', { find });
      list.appendChild(none);
      return;
    }
    for (const r of rows) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'hit';
      const name = document.createElement('b');
      name.textContent = r.label;
      const kind = document.createElement('small');
      kind.textContent = r.kind;
      const count = document.createElement('em');
      count.textContent = r.spots.length > 1 ? '×' + r.spots.length : '';
      row.append(name, kind, count);
      row.title = r.spots.length > 1 ? T('Go to the nearest; press again for the next') : T('Go there');
      // the box keeps the keyboard
      row.onpointerdown = e => e.preventDefault();
      row.onclick = () => {
        // that one, by its whole name, is what's searched for now: nothing else is drawn
        if (!findExact) {
          $('find').value = r.label;
          setFind(r.label, true);
          dirty = true;
        }
        // the nearest to the middle of the screen first, then on round them nearest first
        const key = r.kind + '|' + r.label;
        const mid = toMap(vw / 2, vh / 2);
        const order = r.spots.slice().sort((a, b) => Math.hypot(a[0] - mid[0], a[1] - mid[1]) - Math.hypot(b[0] - mid[0], b[1] - mid[1]));
        const was = findNext.get(key);
        const step = was && was.n === r.spots.length ? was : { n: r.spots.length, seen: new Set() };
        let spot = order.find(p => !step.seen.has(p[0] + ',' + p[1]));
        if (!spot) { step.seen.clear(); spot = order[0]; }
        step.seen.add(spot[0] + ',' + spot[1]);
        findNext.set(key, step);
        goTo(spot[0], spot[1]);
      };
      list.appendChild(row);
    }
  }
  let findOpen = false;

  // a chance, as people say it
  // the boss waves' roles, as players know them (the bosses by name, the rest by their kind); one not here, by its role
  const ROLE_NAMES = { bossBully: 'Reshala', bossKilla: 'Killa', bossKillaAgro: 'Killa', bossKojaniy: 'Shturman', bossGluhar: 'Glukhar',
    bossSanitar: 'Sanitar', bossTagilla: 'Tagilla', bossTagillaAgro: 'Tagilla', bossKnight: 'Knight, Big Pipe, Birdeye', bossZryachiy: 'Zryachiy',
    bossBoar: 'Kaban', bossKolontay: 'Kollontay', bossPartisan: 'Partisan', gifter: 'Ded Moroz', sectantPriest: T('Cultists'),
    pmcBot: T('Raiders'), exUsec: T('Rogues'), arenaFighterEvent: 'Bloodhounds', ravangeZryachiyEvent: 'Zryachiy' };
  // a role the page leaves out of a spawn point's list: the waves of PMCs and scavs, and the infected
  const ROLE_SKIP = /^(pmc(BEAR|USEC)|assault|marksman|cursedAssault|infected)/i;
  // a zone's name, said plainly: "ZoneSubCommand" is "Sub command"
  const zoneName = z => String(z).replace(/^Zone_?/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ')
    .replace(/^(.)(.*)$/, (m, a, b) => a.toUpperCase() + b.toLowerCase());
  // who can spawn at a boss spawn point (in its zone), likeliest first, as "name · chance" lines
  const bossesAt = (bosses, zone) => {
    const seen = new Map();
    for (const [role, chance, zones] of bosses || []) {
      if (!zone || !zones.includes(zone) || ROLE_SKIP.test(role)) continue;
      const name = ROLE_NAMES[role] || role;
      seen.set(name, Math.max(seen.get(name) || 0, chance));
    }
    return [...seen].sort((a, b) => b[1] - a[1]).map(([name, chance]) => '   ' + name + ' · ' + percent(chance));
  };
  const percent = p => p >= 0.995 ? '100%' : p >= 0.1 ? Math.round(p * 100) + '%' : p >= 0.001 ? (p * 100).toFixed(1) + '%' : '<0.1%';
  function readPlaces(raw) {
    // who the location's boss waves can bring, how likely, and at which zones: [[role, chance, [zone, ..]], ..]
    const bosses = list(raw.bosses).filter(b => Array.isArray(b) && typeof b[0] === 'string' && Array.isArray(b[2]));
    // A boss spawn: a point the game marks for bosses, in a zone a boss wave of this location uses. The game marks
    // many more (Customs has them at the customs sheds, where no boss is sent): those are what else they're marked as.
    const bossZones = new Set(bosses.filter(b => !ROLE_SKIP.test(b[0])).flatMap(b => b[2]));
    const spawnKind = s => /Boss/.test(s.cat || '') && bossZones.has(s.zone) ? 'spawnBoss'
      : /Player/.test(s.cat || '') && !/^Savage$/.test(s.sides || '') ? 'spawnPmc' : 'spawnScav';
    return {
      loc: raw.loc, names: raw.names || {},
      boxes: list(raw.boxes).filter(b => at3(b.p) && b.id),
      locks: list(raw.locks).filter(l => at3(l.p) && l.key),
      // the game's switches that are in the scene (not one left switched off in it); others it has are left out
      // till it's known what they are
      switches: list(raw.switches).filter(w => at3(w.p) && typeof w.id === 'string' && w.id && w.t === 'Switch' && w.on !== 0 && !NOT_A_SWITCH.test(w.nm || ''))
        // or by what it's in: one or two have an id that doesn't say (Customs' power plant basement: "switch_develop_00000")
        .map(w => Object.assign(w, { light: LIGHT_SWITCH.test(w.id + ' ' + (w.nm || '')) || /Toggle_Light_Switch/i.test(w.up || '') })),
      spawns: list(raw.spawns).filter(s => at3(s.p)).map(s => Object.assign(s, { kind: spawnKind(s) })),
      zones: list(raw.zones).filter(z => at3(z.p) && typeof z.id === 'string'),
      exits: list(raw.exits).filter(e => at3(e.p) && typeof e.name === 'string'),
      stops: list(raw.stops).filter(s => at3(s.p)),
      route: oneRoad(list(raw.route).filter(line => Array.isArray(line) && line.length > 1)),
      bosses
    };
  }

  // The game keeps the BTR's road as one path per trip between two stops, so most stretches of road come several
  // times over, and their dashes, not lined up, draw as a solid line. This keeps each stretch once: every path is
  // cut into points a metre and a half apart, and only the runs that don't lie on a path already kept are added.
  function oneRoad(lines) {
    const STEP = 1.5, NEAR = 3, CELL = 4;
    const kept = new Map();
    const key = (x, y) => Math.floor(x / CELL) + ',' + Math.floor(y / CELL);
    const taken = p => {
      const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const q of kept.get((cx + dx) + ',' + (cy + dy)) || []) {
          if (Math.hypot(q[0] - p[0], q[1] - p[1]) < NEAR) return true;
        }
      }
      return false;
    };
    const keep = p => { const k = key(p[0], p[1]); if (!kept.has(k)) kept.set(k, []); kept.get(k).push(p); };
    const road = [];
    for (const line of lines) {
      const pts = [];
      line.forEach((p, i) => {
        if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return;
        const last = pts[pts.length - 1];
        if (last) {
          const n = Math.ceil(Math.hypot(p[0] - last[0], p[1] - last[1]) / STEP);
          for (let j = 1; j < n; j++) pts.push([last[0] + (p[0] - last[0]) * j / n, last[1] + (p[1] - last[1]) * j / n]);
        }
        pts.push([p[0], p[1]]);
      });
      // decide first, then remember, so a path doesn't count as lying on itself
      const free = pts.map(p => !taken(p));
      let run = null;
      pts.forEach((p, i) => {
        if (free[i]) {
          if (!run) { run = i ? [pts[i - 1]] : []; road.push(run); }
          run.push(p);
        } else if (run) { run.push(p); run = null; }
      });
      pts.forEach((p, i) => { if (free[i]) keep(p); });
    }
    return road.filter(run => run.length > 1);
  }

  // Where the BTR stops inside a sniper's ground (the train depot on Woods), the yard it brings you to is free to walk
  // about, while the roads in through the minefields stay covered. So, near a stop, a sniper zone isn't drawn when it
  // holds the stop or the yard's containers (two or more); the ones over the roads in, with nothing to loot, are.
  // The map's zones are sorted again once its places (with the stops and containers) are in.
  function placeZones() {
    if (!map) return;
    const here = places && sameMap(places.loc, map.loc) ? places : null;
    const stops = here ? here.stops : [];
    const boxes = here ? here.boxes : [];
    const near = (p, z, by) => {
      const xs = z.p.map(q => q[0]), ys = z.p.map(q => q[1]);
      return p[0] > Math.min(...xs) - by && p[0] < Math.max(...xs) + by && p[1] > Math.min(...ys) - by && p[1] < Math.max(...ys) + by;
    };
    const inside = (p, poly) => {
      let yes = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) yes = !yes;
      }
      return yes;
    };
    const kills = z => Array.isArray(z.kill) && z.kill.length ? z.kill : [z.p];
    const within = (p, z) => kills(z).some(loop => inside(p, loop));
    const yard = z => z.k === 'sniper' && stops.some(s => near(s.p, z, 120))
      && (stops.some(s => within(s.p, z)) || boxes.filter(b => within(b.p, z)).length >= 2);
    map.zones = zoneAreas(map.rawZones.filter(z => !yard(z)));
    dirty = true;
  }

  // The player's started quests, and where every quest sends you: asked for when the game shown changes, and again
  // every little while (the profile changes after each raid).
  async function loadQuests(force) {
    // the stream brings them while it's up (see listen)
    if (streamUp && questsFor === sid) return;
    const now = performance.now();
    // a few seconds apart at the most, and every twenty while nothing changed
    const gap = force || questsFor !== sid ? 3000 : 20000;
    if (questsAsking || now - questsAskedAt < gap) return;
    questsAsking = true;
    questsAskedAt = now;
    const whose = sid;
    try {
      const answer = await (await fetch('api/quests' + (whose ? '?session=' + encodeURIComponent(whose) : ''))).json();
      if (whose === sid) takeQuests(answer, whose);
    } catch (e) { /* asked again in a while */ } finally {
      questsAsking = false;
    }
  }
  // the quests as the stream brings them: the game shown's
  function streamQuests(answer) {
    if (answer && answer.sid && answer.sid !== sid) return;
    takeQuests(answer, sid);
  }
  // Started quests as the page marks them: only true quest items count (the ones that exist for a quest alone, picked
  // up where the quest says). Ordinary items a quest wants are loot like any other here, and a goal that is only about
  // them isn't listed (what's wanted found in raid is marked apart: see firOf).
  const questList = (raw, names) => list(raw).filter(q => q && typeof q.name === 'string').map(q => Object.assign({}, q, {
    goals: list(q.goals).map(g => {
      const asked = list(g.items);
      const items = asked.filter(tpl => (names[tpl] || {}).q);
      return Object.assign({}, g, { items, plain: asked.length > 0 && !items.length && !list(g.zones).length });
    }).filter(g => !g.plain)
  })).filter(q => q.goals.length);
  // the ordinary items started quests want found in raid: tpl -> [quest, goal, whose ('' the player's own)]
  const firOf = (raw, names, who, into) => {
    for (const q of list(raw)) {
      for (const g of list(q && q.goals)) {
        if (!g || !g.fir) continue;
        for (const tpl of list(g.items)) if (!(names[tpl] || {}).q && !into.has(tpl)) into.set(tpl, [q, g, who]);
      }
    }
    return into;
  };
  function takeQuests(answer, whose) {
    questsFor = whose;
    const names = answer && answer.names || {};
    quests = answer && !answer.none ? {
      sid: answer.sid,
      list: questList(answer.quests, names),
      fir: firOf(answer.quests, names, '', new Map()),
      // the other players in the same Fika raid, and their quests
      friends: list(answer.friends).filter(f => f && typeof f.sid === 'string').map(f => {
        const who = typeof f.name === 'string' && f.name ? latin(f.name) : T('A friend');
        return { sid: f.sid, who, list: questList(f.quests, names), fir: firOf(f.quests, names, who, new Map()) };
      }),
      zones: answer.zones || {}, names
    } : null;
    const wished = answer && Array.isArray(answer.wish) ? answer.wish.filter(t => typeof t === 'string').sort() : null;
    wish = wished ? new Set(wished) : null;
    myKeys = answer && answer.keys && typeof answer.keys === 'object' ? answer.keys : {};
    myKeysPrint = Object.keys(myKeys).sort().map(k => k + myKeys[k]).join(',');
    wishPrint = wished ? wished.join(',') : '';
    wishGroup = new Map(answer && answer.wishG && typeof answer.wishG === 'object' ? Object.entries(answer.wishG).filter(([, g]) => Number.isInteger(g)) : []);
    dirty = true;
  }
  // What the started quests want: { items: tpl -> [quest, goal], zones: zone id -> [quest, goal] }; the same of the
  // friends in the raid (fItems, fZones: [quest, goal, whose], with "Friends' quests" on); and fir: tpl -> [quest, goal,
  // whose], the ordinary items wanted found in raid, the friends' too with that on.
  function questWants() {
    const items = new Map(), zones = new Map(), fItems = new Map(), fZones = new Map(), fir = new Map();
    for (const q of quests ? quests.list : []) {
      for (const goal of q.goals) {
        for (const tpl of list(goal.items)) if (!items.has(tpl)) items.set(tpl, [q, goal]);
        for (const z of list(goal.zones)) if (!zones.has(z)) zones.set(z, [q, goal]);
      }
    }
    if (quests) for (const [tpl, w] of quests.fir) fir.set(tpl, w);
    for (const f of quests && prefs.friendQuests ? quests.friends : []) {
      for (const q of f.list) {
        for (const goal of q.goals) {
          for (const tpl of list(goal.items)) if (!items.has(tpl) && !fItems.has(tpl)) fItems.set(tpl, [q, goal, f.who]);
          for (const z of list(goal.zones)) if (!zones.has(z) && !fZones.has(z)) fZones.set(z, [q, goal, f.who]);
        }
      }
      for (const [tpl, w] of f.fir) if (!fir.has(tpl)) fir.set(tpl, w);
    }
    return { items, zones, fItems, fZones, fir };
  }

  // What lies about in the raid: asked for when the game says it changed, one question at a time.
  async function loadThings() {
    if (thingsAsking || !sid) return;
    thingsAsking = true;
    thingsTriedAt = performance.now();
    const want = thingsWanted, whose = sid;
    try {
      const answer = await (await fetch('api/things?session=' + encodeURIComponent(whose))).json();
      if (whose === sid) takeThings(answer);
      thingsHave = want;
    } catch (e) { /* asked again at the next change */ } finally {
      thingsAsking = false;
      if (thingsHave !== thingsWanted) setTimeout(loadThings, 300);
    }
  }
  function takeThings(answer) {
    if (!answer || answer.none) return;
    things = readThings(answer);
    addMore();
    dirty = true;
    if (!places || !sameMap(places.loc, things.loc)) loadPlaces(false);
  }
  // the loot as the stream brings it (see listen): the game shown's, numbered as its reports number it
  function streamThings(answer) {
    if (!answer || answer.sid !== sid) return;
    takeThings(answer);
    if (Number.isFinite(answer.v)) thingsHave = Math.max(thingsHave, answer.v);
  }
  function readThings(raw) {
    const names = raw.names || {};
    const loose = list(raw.loose).filter(r => Array.isArray(r) && r.length >= 7).map(r => ({
      id: r[0], tpl: r[1], x: r[2], y: r[3], z: r[4], n: r[5] || 1,
      q: !!r[6] || !!(names[r[1]] || {}).q, worth: ((names[r[1]] || {}).p || 0) * (r[5] || 1)
    }));
    // the bodies, each a container of what it wears and carries: [id, east, north, height, name, side, kp, profile];
    // kp is 1 for a body a person playing killed; profile is whose it was, as its corpse marker's "pid" (an older
    // plugin sends neither: the marker is then found by name or nearness, and says who killed it)
    const bodies = list(raw.bodies).filter(r => Array.isArray(r) && r.length >= 4 && [r[1], r[2], r[3]].every(Number.isFinite))
      .map(r => ({ id: r[0], p: [r[1], r[2], r[3]], who: latin(r[4] || ''), whoRaw: r[4] || '', side: r[5] || '', kp: r[6] === 1, pid: r[7] || '', was: r[8] || '' }));
    // have: the containers this raid has (an older plugin doesn't say: null, and every one is drawn)
    // more: the raid's containers and quest places the map's places.json doesn't have (a cache that spawns by chance, a
    // quest place a mod adds), added to the places (see addMore)
    const more = raw.more ? { boxes: list(raw.more.boxes).filter(b => at3(b.p) && b.id), zones: list(raw.more.zones).filter(z => at3(z.p) && typeof z.id === 'string') } : null;
    return { loc: shownLoc(raw.loc), loose, inside: raw.inside || {}, carried: raw.carried || {}, open: new Set(list(raw.open)), names, bodies,
      have: Array.isArray(raw.have) ? new Set(raw.have) : null, more };
  }
  // The raid's own containers and quest places, added to the map's places when they're of the same map: each once.
  // The raid's own say goes over places.json's: some of a location's containers have other ids from raid to raid
  // (about 150 of Streets'), so one of places.json's ids can be another container in this raid. The server sends the
  // ones that are somewhere else (things.more), and a replay has all of its raid's (replay.spots, recorded as it
  // loaded): each is moved to where the raid had it, and moved back once another raid's are what's shown.
  function addMore() {
    if (!places) return;
    const more = things && things.more && sameMap(places.loc, things.loc) ? things.more : null;
    const spots = replay && replay.spots && sameMap(places.loc, replay.spots.loc) ? replay.spots : null;
    if (places.moreFrom === more && places.spotsFrom === spots) return;
    if (!places.byId) {
      places.byId = new Map();
      for (const b of places.boxes) places.byId.set(b.id, b);
      for (const z of places.zones) places.byId.set(z.id, z);
      places.moved = [];
    }
    // (another replay's, or an earlier report's: back where places.json has them first)
    for (let i = places.moved.length - 1; i >= 0; i--) places.moved[i][0].p = places.moved[i][1];
    places.moved = [];
    places.moreFrom = more;
    places.spotsFrom = spots;
    const ids = places.byId, names = things ? things.names : {};
    const put = (b, list) => {
      if (!b || !b.id || !at3(b.p)) return;
      const had = ids.get(b.id);
      if (!had) {
        ids.set(b.id, b);
        list.push(b);
        if (b.tpl && !places.names[b.tpl] && names[b.tpl]) places.names[b.tpl] = names[b.tpl];
      } else if (had.p !== b.p && had.p.some((v, i) => Math.abs(v - b.p[i]) > 0.5)) {
        places.moved.push([had, had.p]);
        had.p = b.p;
      }
    };
    for (const b of spots ? spots.boxes : []) put(b, places.boxes);
    if (more) {
      for (const b of more.boxes || []) put(b, places.boxes);
      for (const z of more.zones || []) put(z, places.zones);
    }
    dirty = true;
  }

  // A small picture, drawn once and kept: a glyph (an emoji, a letter or one of our pictures) on a badge, round,
  // square, a diamond or a hexagon ('hex'), with a black halo so it stands out on any ground.
  const badges = new Map();
  function badge(glyph, fill, rim, ink, form, size) {
    const ratio = pixelRatio();
    const px = Math.max(form === 'tile' ? 2 : 6, Math.round(size * ratio));
    const key = [glyph, fill, rim, ink, form, px].join('|');
    let c = badges.get(key);
    if (c) return c;
    if (badges.size > 600) badges.clear();
    const m = Math.ceil(px * 0.3) + 2;
    c = document.createElement('canvas');
    c.width = c.height = px + 2 * m;
    const g = c.getContext('2d');
    const mid = c.width / 2, half = px / 2;
    g.beginPath();
    if (form === 'round') g.arc(mid, mid, half, 0, Math.PI * 2);
    else if (form === 'diamond') {
      g.moveTo(mid, mid - half * 1.25); g.lineTo(mid + half * 1.25, mid); g.lineTo(mid, mid + half * 1.25); g.lineTo(mid - half * 1.25, mid);
      g.closePath();
    } else if (form === 'hex') {
      const d = half * 1.14;
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 6 + i * Math.PI / 3;
        if (i) g.lineTo(mid + d * Math.cos(a), mid + d * Math.sin(a)); else g.moveTo(mid + d * Math.cos(a), mid + d * Math.sin(a));
      }
      g.closePath();
    } else if (form === 'tile') g.rect(mid - half, mid - half, px, px);
    else if (g.roundRect) g.roundRect(mid - half, mid - half, px, px, px * 0.24);
    else g.rect(mid - half, mid - half, px, px);
    g.lineJoin = 'round';
    g.lineWidth = Math.max(3, px * 0.3);
    g.strokeStyle = 'rgba(0,0,0,0.8)';
    g.stroke();
    g.fillStyle = fill;
    g.fill();
    g.lineWidth = Math.max(1.5, px * 0.13);
    g.strokeStyle = rim;
    g.stroke();
    const icon = typeof glyph === 'string' && glyph.startsWith('i:') ? ICONS[glyph.slice(2)] : null;
    if (icon) {
      // one of our own pictures (see ICONS), in the ink's colour
      const k = px * (form === 'diamond' ? 0.6 : form === 'hex' ? 0.68 : 0.76) / 24;
      g.save();
      g.translate(mid - 12 * k, mid - 12 * k);
      g.scale(k, k);
      g.lineWidth = 2.2;
      g.lineCap = g.lineJoin = 'round';
      g.strokeStyle = g.fillStyle = ink;
      for (const [d, how] of icon) { const p = new Path2D(d); if (how === 'e') g.fill(p, 'evenodd'); else if (how === 'f') g.fill(p); else g.stroke(p); }
      g.restore();
    } else if (glyph) {
      const letter = /^[A-Za-z!?★]$/.test(glyph);
      g.font = (letter ? 'bold ' : '') + Math.round(px * (letter ? 0.7 : 0.62)) + 'px '
        + (letter ? FONT : '"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif');
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = ink;
      g.fillText(glyph, mid, mid + px * 0.05);
    }
    badges.set(key, c);
    return c;
  }

  // Draws the layers, under the markers: spawn points, every extract, locks, containers, quest places, loose loot.
  // What's on another floor than the player is fainter. Each is kept in thingsDrawn, so pointing at it says what it
  // is. While the search box has something in it, only what it finds is drawn, ringed.
  let holdMemo = { key: null, by: new Map() };
  // the places and items of the player's started quests that are off the screen (see drawEdge)
  let questOff = [];
  function drawThings(scale) {
    const LOOT_CELL = prefs.lootCell;
    thingsDrawn = [];
    thingsPut = [];
    questOff = [];
    corpsesNow = null;
    showSpawnIndex();
    let found = 0;
    const looking = find.length >= 2;
    const results = new Map();
    // something found: by its name and what it is, with where it is, and which of the list's tabs it's under
    // (FIND_GROUPS)
    const note = (label, kind, p, group) => {
      if (!looking || !label) return;
      const key = kind + '|' + label;
      let r = results.get(key);
      if (!r) results.set(key, r = { label, kind, group: group || 'items', spots: [] });
      r.spots.push([p[0], p[1]]);
    };
    const tell = () => {
      const text = looking ? (found ? T('{n} found', { n: found }) : T('Nothing found')) : '';
      if ($('findCount').textContent !== text) $('findCount').textContent = text;
      $('findClear').hidden = !find;
      $('findBox').classList.toggle('has', !!find);
      showFindList(results, looking);
    };
    if (!map) return tell();
    const raidHere = inRaidHere();
    const loot = raidHere && things && sameMap(things.loc, map.loc) ? things : null;
    const shown = places && sameMap(places.loc, map.loc) ? places : null;
    if (!shown && !loot) return tell();
    const names = Object.assign({}, quests ? quests.names : {}, shown ? shown.names : {}, loot ? loot.names : {});
    const nameOf = tpl => (names[tpl] || {}).n || tpl;
    // the colour another mod gives an item's name in the game, for its tooltip's title (Mods' name colours)
    const tintOf = tpl => prefs.modTints && (names[tpl] || {}).t || '';
    const worthOf = (tpl, n) => ((names[tpl] || {}).p || 0) * (n || 1);
    const hits = findHits;
    // what a kind of container can hold that's searched for, by name (kept while the search stays as it is)
    const holdKey = find + '|' + findExact + '|' + lootPrint() + '|' + (lootTable ? lootTable.loc : '');
    if (holdMemo.key !== holdKey) holdMemo = { key: holdKey, by: new Map() };
    const canHold = (table, tpl) => {
      let names = holdMemo.by.get(tpl);
      if (names) return names;
      const tn = table.names;
      names = (table.boxes[tpl] || []).filter(i => kindOn(tn, i[0]) && (hits((tn[i[0]] || {}).n) || hits((tn[i[0]] || {}).s))).map(i => (tn[i[0]] || {}).n || i[0]);
      holdMemo.by.set(tpl, names);
      return names;
    };
    const itemHits = tpl => hits((names[tpl] || {}).n) || hits((names[tpl] || {}).s);
    const wants = questWants();
    // only the quests the player has started (once they're known): their items, and the places they send you
    const mine = prefs.myQuestItems && !!quests;
    const minePlaces = prefs.myQuestPlaces && !!quests;
    // loot on another floor than the player: fainter, or not drawn at all (a search still finds it)
    const faint = prefs.otherLoot / 100;
    const onScreen = (x, y) => {
      const s = toScreen(x, y);
      return s[0] > -30 && s[1] > -30 && s[0] < vw + 30 && s[1] < vh + 30 ? s : null;
    };
    // on another floor than the player (a place [east, north, height])
    // The building (or roofed place) whose floor is shown. With "Loot under roofs at full strength", only what's in
    // it goes by floors; everything else is seen from above, and drawn as strongly as what lies in the open.
    const shownIn = floorShown.n > 0 ? floorShown.place : 0;
    const shownB = shownIn >= BUILDING && map.floors && map.floors.buildings ? map.floors.buildings[shownIn - BUILDING] : null;
    const inShown = p => shownB ? inBox(shownB.box, p[0], p[1]) && inLoops(shownB.l, p[0], p[1]) : shownIn > 0 && placeAt(p[0], p[1]) === shownIn;
    const away = p => (prefs.roofLoot === false || inShown(p)) && otherFloor(p[0], p[1], p[2]) !== 0;
    // What the loot in each building seen from above is worth, of what's shown: written over it, so a building needn't
    // be looked into to know it's worth going in. (Which building a thing is in is worked out once.)
    const roofs = new Map();
    const blds = prefs.roofTotals !== false && map.floors && map.floors.buildings ? map.floors.buildings : null;
    const inBuilding = (thing, p, worth, box) => {
      if (!blds || !(worth > 0)) return;
      if (thing.bFor !== blds) { thing.bFor = blds; thing.bAt = buildingAt(p[0], p[1], p[2]); }
      if (!thing.bAt || thing.bAt === shownIn) return;
      let t = roofs.get(thing.bAt);
      if (!t) roofs.set(thing.bAt, t = { worth: 0, best: 0, loose: 0, boxes: 0 });
      t.worth += worth;
      t.best = Math.max(t.best, worth);
      if (box) t.boxes++; else t.loose++;
    };
    const gone = p => !looking && faint <= 0 && away(p);
    const close = Math.min(vw, vh) / zoom <= prefs.closeSpan;
    const size = Math.min(22, Math.max(12, 6 + zoom * 2.2)) * scale;
    const r = Math.max(2.5, 3.6 * scale);
    const ratio = pixelRatio();
    const put = (s, p, picture) => {
      const w = picture.width / ratio;
      ctx.globalAlpha = away(p) ? Math.max(0.15, faint) : 1;
      ctx.drawImage(picture, s[0] - w / 2, s[1] - w / 2, w, w);
      ctx.globalAlpha = 1;
      // where it is, for a press on it (see pressed: one on another floor of the building shown goes to that floor)
      thingsPut.push({ x: s[0], y: s[1], r: w / 2, p });
    };
    const ring = (s, radius, col = LAYERS.quest.col) => {
      ctx.beginPath();
      ctx.arc(s[0], s[1], radius, 0, Math.PI * 2);
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#000';
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.strokeStyle = col;
      ctx.stroke();
    };
    // On the player's wishlist (Loot > Mark wishlist items): a star by it and a ring round it, in WISH_COL, shown
    // whatever it's worth; a container or body holding one the same
    const wished = tpl => prefs.wishMarks !== false && !!wish && wish.has(tpl);
    const star = (s, radius) => wishStar(s[0] + radius * 0.72, s[1] - radius * 0.72, Math.max(4.5, radius * 0.42));
    // what's wanted found in raid is marked (its own switch, "Found-in-raid needs")
    const firOn = !isHidden('Layer firItems');
    const wantedFor = tpl => mine && (wants.items.has(tpl) || wants.fItems.has(tpl));
    // said after an item in a list: wanted for a quest, or wanted found in raid
    // (as words the tip knows, not shown as they are: 'quest' is a Quest tag, 'fir' a FIR one; see showTip)
    const tagOf = tpl => (wantedFor(tpl) ? ' · quest' : firOn && wants.fir.has(tpl) ? ' · fir' : '') + (wished(tpl) ? ' · wish' : '');
    ctx.save();
    ctx.lineJoin = 'round';

    if (shown) {
      // the BTR's road, a solid line (dashes crawl as the map zooms), and its stops
      if (!looking && !isHidden('Layer btrRoad') && (shown.route.length || shown.stops.length)) {
        ctx.save();
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (const line of shown.route) {
          line.forEach((p, i) => {
            const s = toScreen(p[0], p[1]);
            if (i) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]);
          });
        }
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.lineWidth = 5;
        ctx.stroke();
        ctx.strokeStyle = LAYERS.btrRoad.col;
        ctx.lineWidth = 2.4;
        ctx.stroke();
        ctx.restore();
        for (const stop of shown.stops) {
          const s = onScreen(stop.p[0], stop.p[1]);
          if (!s) continue;
          put(s, stop.p, badge('i:stop', '#1a1a24', LAYERS.btrRoad.col, SPAWN_INK, 'round', size));
          thingsDrawn.push({ x: s[0], y: s[1], r: size / 2, tip: { title: T('BTR stop'), lines: [] } });
        }
      }

      // the spawn points; while searching, the ones found: by what they are ("PMC spawn") or by a boss that can
      // spawn there ("Reshala")
      for (const sp of shown.spawns) {
        const title = sp.kind === 'spawnPmc' ? T('PMC spawn') : sp.kind === 'spawnScav' ? T('Scav spawn') : sp.kind === 'spawnBoss' ? T('Boss spawn') : T('Spawn');
        // what spawns there (the bosses of the zone, with their chances), where it is and, for a PMC, the entry
        const who = sp.kind === 'spawnBoss' ? bossesAt(shown.bosses, sp.zone) : [];
        let match = false;
        if (looking) {
          const boss = who.map(l => l.trim().split(' · ')[0]).find(n => hits(n));
          match = !!boss || hits(title) || hits(SPAWN_EN[sp.kind] || 'Spawn');
          if (!match) continue;
          found++;
          note(boss || title, T('Spawn'), sp.p, 'spawns');
        } else if (isHidden('Layer ' + sp.kind)) continue;
        const s = onScreen(sp.p[0], sp.p[1]);
        if (!s) continue;
        put(s, sp.p, badge(SPAWN_LETTER[sp.kind], LAYERS[sp.kind].col, '#0c0c12', '#0c0c12', 'round', size * 0.95));
        if (match) ring(s, size * 0.85);
        thingsDrawn.push({ x: s[0], y: s[1], r: size / 2, tip: { title,
          lines: [...(who.length ? [T('Who can spawn here:'), ...who] : []), sp.zone ? T('Zone:') + ' ' + zoneName(sp.zone) : '', sp.infil ? T('Entry:') + ' ' + sp.infil : ''] } });
      }

      // while searching, the extracts found by their name, each once
      if (looking) {
        const named = new Set();
        for (const e of shown.exits) {
          const name = e.text || e.name;
          if (!hits(name) && !hits(e.name)) continue;
          const key = name + '|' + Math.round(e.p[0] / 30) + '|' + Math.round(e.p[1] / 30);
          if (named.has(key)) continue;
          named.add(key);
          found++;
          note(name, T('Extract'), e.p, 'extracts');
          const s = onScreen(e.p[0], e.p[1]);
          if (!s) continue;
          const col = e.scav ? KINDS.Scav.col : '#8fe3a0';
          put(s, e.p, badge('', 'rgba(12,12,18,0.75)', col, col, 'diamond', size * 0.8));
          label(name, 11 * scale, s[0], s[1] + size * 0.6, s[1] - size * 0.6, col);
          ring(s, size * 0.85);
          thingsDrawn.push({ x: s[0], y: s[1], r: size / 2, tip: { title: name, lines: [e.scav ? T('Scav extract') : T('PMC extract')] } });
        }
      }

      // every extract of the location: the ones that aren't the player's this raid hollow, by name
      if (!(prefs.myExits && raidHere) && !looking && !isHidden('Extract')) {
        const theirs = new Set(raidHere ? live.filter(m => m.c === 'Extract').map(m => m.t) : []);
        const seen = new Set();
        const mine = raidHere ? live.filter(m => m.c === 'Extract' && Number.isFinite(m.cx)) : [];
        const merged = [];
        for (const e of shown.exits) {
          const key = e.name + '|' + e.scav;
          if (seen.has(key) || theirs.has(e.text)) continue;
          seen.add(key);
          // under one of the player's own: that one says it
          if (mine.some(m => Math.hypot(m.cx - e.p[0], m.cy - e.p[1]) < 12)) continue;
          // the PMCs' and the scavs' way out at the same place: one marker for both
          const twin = merged.find(o => (o.text || o.name) === (e.text || e.name) && Math.hypot(o.p[0] - e.p[0], o.p[1] - e.p[1]) < 30);
          if (twin) { if (twin.scav !== e.scav) twin.both = true; continue; }
          merged.push(Object.assign({}, e));
        }
        // the scavs' ones first, so a PMC one at the same place is drawn over it
        merged.sort((a, c) => (c.scav && !c.both ? 1 : 0) - (a.scav && !a.both ? 1 : 0));
        const pmcAt = merged.filter(o => !o.scav || o.both).map(o => toScreen(o.p[0], o.p[1]));
        for (const e of merged) {
          const s = onScreen(e.p[0], e.p[1]);
          if (!s) continue;
          // a scav one under a PMC one: its name over the marker, the PMC one's under it, so both can be read
          const crowded = e.scav && !e.both && pmcAt.some(q => Math.hypot(q[0] - s[0], q[1] - s[1]) < size * 2.2);
          const col = e.scav && !e.both ? KINDS.Scav.col : '#8fe3a0';
          put(s, e.p, badge('', 'rgba(12,12,18,0.75)', col, col, 'diamond', size * 0.8));
          label((e.text || e.name) + (e.both ? ' (PMC + scav)' : e.scav ? ' (scav)' : ''), 11 * scale, s[0], crowded ? s[1] - size * 0.6 - 11 * scale * 1.3 : s[1] + size * 0.6, s[1] - size * 0.6, col);
          thingsDrawn.push({ x: s[0], y: s[1], r: size / 2, tip: { title: e.text || e.name, lines: [e.both ? T('PMC and scav extract') : e.scav ? T('Scav extract') : T('PMC extract'), raidHere ? T('Not one of yours this raid') : ''] } });
        }
      }

      for (const l of shown.locks) {
        // a search for loot leaves the locks as they are (is what was found behind one?); a lock it finds is ringed
        const match = looking && (hits(nameOf(l.key)) || hits(l.kind));
        if (!match && (isHidden('Layer locks') || gone(l.p))) continue;
        if (match) found++;
        if (match) note(hits(nameOf(l.key)) ? nameOf(l.key) : lockName(l.kind), T('Lock'), l.p, 'objects');
        const s = onScreen(l.p[0], l.p[1]);
        if (!s) continue;
        const open = loot && loot.open.has(l.id);
        // its key: with the player (bright), in their stash (gold), or not had (dim); off (the default): one colour.
        // The whole badge says it, its edge as well as its picture, so it shows at any zoom
        const has = prefs.keyStates === true && quests ? myKeys[l.key] || 0 : -1;
        const ink = has === 1 ? KEY_WITH : has === 2 ? KEY_STASH : has === 0 ? KEY_NONE : SPAWN_INK;
        const rim = open ? '#3ddc5a' : has === 1 ? KEY_WITH : has === 2 ? KEY_STASH : has === 0 ? '#7c7f8f' : LAYERS.locks.col;
        put(s, l.p, badge(open ? 'i:unlocked' : LOCK_GLYPH[l.kind] || 'i:lock', '#1a1a24', rim, ink, 'hex', size));
        if (match) ring(s, size * 0.85);
        const keyLine = has === 1 ? T('You have the key with you') : has === 2 ? T('The key is in your stash') : has === 0 ? T("You don't have the key") : '';
        thingsDrawn.push({ x: s[0], y: s[1], r: size / 2, tip: { title: lockName(l.kind) + ' · ' + (open ? T('open now') : T('locked')), lines: [T('Key:') + ' ' + nameOf(l.key), keyLine].filter(Boolean) } });
      }

      // Switches: power switches, levers and the like (a room's light switches only when asked for). In a raid, or
      // played back, each as it stands then (the "switch" events): green once it's switched on. A search finds them
      // all, the light switches too, by what they are or by their own name ("lever").
      for (const w of shown ? shown.switches : []) {
        const [label, english] = switchKind(w);
        const plain = switchPlain(w);
        // (by "switch" too, whatever it is: a reader or a button is one in the game)
        const match = looking && (hits(label) || hits(english) || hits(plain) || hits(T('Switch')) || hits('switch'));
        if (!match && (isHidden('Layer switches') || (w.light && !prefs.lightSwitches) || gone(w.p))) continue;
        if (match) { found++; note(label, T('Switch'), w.p, 'objects'); }
        const s = onScreen(w.p[0], w.p[1]);
        if (!s) continue;
        const now = switchNow.get(w.id);
        const on = !!now && now.d.st === 'Open';
        const rim = on ? '#3ddc5a' : LAYERS.switches.col;
        put(s, w.p, badge(w.light ? 'i:bulb' : 'i:power', '#1a1a24', rim, on ? '#3ddc5a' : SPAWN_INK, 'square', size * 0.9));
        if (match) ring(s, size * 0.85);
        thingsDrawn.push({ x: s[0], y: s[1], r: size / 2, tip: { title: label + (now ? ' · ' + (on ? T('Switched on') : T('Not switched')) : ''), lines: [plain] } });
      }

      for (const b of shown.boxes) {
        if (boxHidden(b)) continue;
        if (prefs.loot === 'off') continue;
        // in a raid, only the containers the raid has (not while only what can be there is shown: every one, then)
        if (loot && lootReal() && loot.have && !loot.have.has(b.id)) continue;
        if (gone(b.p)) continue;
        // what's in it: only when it may be known (prefs.peek), and only of the kinds of loot shown
        const items = loot && peeking() ? loot.inside[b.id] || [] : null;
        // not known what's in it now (no raid here, or it's not shown): what one can hold, from the loot tables
        const table = !items && lootTable && sameMap(lootTable.loc, map.loc) && !isHidden('Layer lootSpawns') ? lootTable : null;
        const canHits = looking && table ? canHold(table, b.tpl) : [];
        const counted = items ? items.filter(i => kindOn(names, i[0])) : null;
        const total = counted ? counted.reduce((sum, i) => sum + worthOf(i[0], i[1]), 0) : 0;
        const forQuest = !!items && items.some(i => wantedFor(i[0]));
        const forFir = !!items && !forQuest && firOn && items.some(i => wants.fir.has(i[0]));
        const forWish = !!items && items.some(i => wished(i[0]));
        const match = looking && ((items || []).some(i => itemHits(i[0])) || itemHits(b.tpl) || canHits.length > 0);
        // in a raid: the ones worth looking in, and every one up close; out of a raid, where they stand, up close
        const worth = !!items && total >= minWorth() && total > 0;
        if (looking ? !match : isHidden('Layer boxes') || !(worth || close || forQuest || forFir || forWish)) continue;
        found++;
        if (worth && !looking) inBuilding(b, b.p, total, true);
        if (match) {
          for (const i of items || []) if (itemHits(i[0])) note(nameOf(i[0]), T('In a container'), b.p);
          if (itemHits(b.tpl)) note(nameOf(b.tpl), T('Container'), b.p, 'objects');
          for (const name of canHits) note(name, T('Can be in a container'), b.p);
        }
        const s = onScreen(b.p[0], b.p[1]);
        if (!s) continue;
        const rim = forQuest ? LAYERS.quest.col : forFir ? LAYERS.firItems.col : worth ? worthCol(total) : '#7c7f8f';
        const square = prefs.containerStyle === 'square';
        const markSize = size * prefs.containerScale * (square ? .4 : 1);
        const icon = square ? badge('', rim, rim, '', 'tile', markSize)
          : badge(BOX_GLYPH[(names[b.tpl] || {}).c] || 'i:boxCrate', '#1a1a24', rim, SPAWN_INK, 'square', markSize);
        put(s, b.p, icon);
        const ringRadius = Math.max(5, markSize * .85);
        if (match || forQuest) ring(s, ringRadius);
        else if (forFir) ring(s, ringRadius, LAYERS.firItems.col);
        else if (forWish) ring(s, ringRadius, WISH_COL);
        if (forWish) star(s, ringRadius);
        // (what the box by the pointer lists: worked out only when the container is pointed at)
        const listed = () => {
          const lines = (counted || []).slice().sort((a, c) => worthOf(c[0], c[1]) - worthOf(a[0], a[1])).slice(0, 10)
            .map(i => nameOf(i[0]) + (i[1] > 1 ? ' ×' + i[1] : '') + ' · ' + roubles(worthOf(i[0], i[1])) + tagOf(i[0]));
          if (counted && counted.length > 10) lines.push(T('…and {n} more', { n: counted.length - 10 }));
          if (items && !items.length) lines.push(T('Empty'));
          else if (items && items.length > counted.length) lines.push(notShown(items.length - counted.length));
          if (b.key) lines.push(T('Key:') + ' ' + nameOf(b.key));
          if (table && table.boxes[b.tpl]) {
            const tn = table.names, all = table.boxes[b.tpl], can = all.filter(i => kindOn(tn, i[0]))
              .sort((a, c) => ((tn[c[0]] || {}).p || 0) - ((tn[a[0]] || {}).p || 0));
            const there = table.boxChance[b.id];
            if (there !== undefined && there < 1) lines.push(T('There in {p} of raids', { p: percent(there) }));
            // (the kinds of loot left off in Options leave out what it can hold of them: say so, not an empty list)
            if (can.length) lines.push(T('Can hold:'));
            for (const i of can.slice(0, 12)) lines.push('   ' + ((tn[i[0]] || {}).s || (tn[i[0]] || {}).n || i[0]) + ' · ' + percent(i[1]) + ' · ' + canWorth(tn, i[0]));
            if (can.length > 12) lines.push('   ' + T('…and {n} more', { n: can.length - 12 }));
            if (all.length > can.length) lines.push(notShown(all.length - can.length));
          }
          return lines;
        };
        thingsDrawn.push({ x: s[0], y: s[1], r: Math.max(4, markSize / 2), tip: { title: nameOf(b.tpl) + (total ? ' · ' + roubles(total) : ''), tint: tintOf(b.tpl), get lines() { return listed(); } } });
      }

      // Where loose loot can spawn: a hollow ring each, in the colour of the dearest thing it can spawn of the kinds
      // shown, worth at least what's asked (however close); a search rings the points that can spawn what's searched for.
      if (lootTable && sameMap(lootTable.loc, map.loc) && !isHidden('Layer lootSpawns')) {
        const tn = lootTable.names;
        const pictures = Math.min(vw, vh) / zoom <= Math.max(prefs.closeSpan, SPAWN_PICTURES);
        const tnHits = tpl => hits((tn[tpl] || {}).n) || hits((tn[tpl] || {}).s);
        for (const pt of lootTable.points) {
          const can = pt.items.filter(i => kindOn(tn, i[0]));
          if (!can.length) continue;
          const best = (tn[can[0][0]] || {}).p || 0;
          const match = looking && can.some(i => tnHits(i[0]));
          // a quest item's: with the quest items' switch, whatever it's worth; only the player's quests' while those are asked for
          const wanted = pt.quest && mine ? can.map(i => wants.items.get(i[0]) || wants.fItems.get(i[0])).find(Boolean) : null;
          if (pt.quest && !looking && (isHidden('Layer quest') || (mine && !wanted))) continue;
          if (looking ? !match : (!pt.quest && best < minWorth()) || gone([pt.x, pt.y, pt.z])) continue;
          found++;
          if (match) for (const i of can) if (tnHits(i[0])) note((tn[i[0]] || {}).n || i[0], T('Can spawn'), [pt.x, pt.y]);
          const s = onScreen(pt.x, pt.y);
          if (!s) continue;
          // zoomed in: its kind's picture, rimmed in its worth's colour; from further out a ring of that colour
          const pictured = pt.quest || (pictures && !!SPAWN_GLYPH[pt.kind]);
          const mark = Math.max(size, 20 * scale);
          if (pictured) {
            // (a quest item's: the quest items' diamond, dark, since it's where one can be and not one seen there)
            if (pt.quest) put(s, [pt.x, pt.y, pt.z], badge('!', '#1a1a24', LAYERS.quest.col, LAYERS.quest.col, 'diamond', size));
            else put(s, [pt.x, pt.y, pt.z], badge(SPAWN_GLYPH[pt.kind], '#1a1a24', worthCol(best), SPAWN_INK, 'round', mark));
          } else {
            ctx.globalAlpha = away([pt.x, pt.y, pt.z]) ? Math.max(0.15, faint) : 0.9;
            ctx.beginPath();
            ctx.arc(s[0], s[1], r * 0.95, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(16,17,18,0.55)';
            ctx.fill();
            ctx.lineWidth = 3.2;
            ctx.strokeStyle = '#000';
            ctx.stroke();
            ctx.lineWidth = 1.8;
            ctx.strokeStyle = worthCol(best);
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
          if (match) ring(s, pictured ? mark * 0.9 : r + 5);
          // what the box by the pointer says of it: worked out only when it's pointed at (there are thousands of
          // these, drawn again every frame in a raid)
          thingsDrawn.push({
            x: s[0], y: s[1], r: pictured ? mark * 0.55 : r * 1.3, tip: {
              get title() { return T('{kind} spawn', { kind: spawnKindName(pt.kind) }) + ' · ' + T('spawns in {p} of raids', { p: percent(pt.chance) }); },
              get lines() {
                const lines = can.slice(0, 12).map(i => ((tn[i[0]] || {}).s || (tn[i[0]] || {}).n || i[0]) + ' · ' + percent(i[1]) + ' · ' + canWorth(tn, i[0]));
                if (can.length > 12) lines.push(T('…and {n} more', { n: can.length - 12 }));
                if (can.length < pt.items.length) lines.push(notShown(pt.items.length - can.length));
                return [wanted ? T('For {quest}', { quest: wanted[0].name }) : ''].concat([T('If it spawns, one of:')], lines);
              }
            }
          });
        }
      }

      // the places quests send you: the player's quests', or every quest's
      if (!isHidden('Layer questZones') && quests) {
        for (const z of shown.zones) {
          const want = wants.zones.get(z.id) || wants.fZones.get(z.id);
          const quest = want ? want[0].name + (want[2] ? ' · ' + want[2] : '') : minePlaces ? null : quests.zones[z.id];
          if (!quest) continue;
          const goal = want ? want[1].text : '';
          if (looking && !hits(quest) && !hits(goal)) continue;
          found++;
          note(quest, T('Quest'), z.p, 'quests');
          const s = onScreen(z.p[0], z.p[1]);
          if (!s) { if (want) questOff.push({ p: z.p, t: quest }); continue; }
          put(s, z.p, badge('i:star', LAYERS.quest.col, '#0c0c12', '#0c0c12', 'round', size * 1.1));
          if (want || zoom >= 3) label(quest, 11 * scale, s[0], s[1] + size * 0.7, s[1] - size * 0.7, LAYERS.quest.col, away(z.p) ? 0.5 : 1);
          thingsDrawn.push({ x: s[0], y: s[1], r: size * 0.6, tip: { title: quest, lines: [goal, want && want[2] ? T("{who}'s quest", { who: want[2] }) : '', want && want[0].trader ? T('From {trader}', { trader: want[0].trader }) : '', want ? '' : T('Not a quest you have started')] } });
        }
      }
    }

    if (loot) {
      // The corpses: each one ✕, the game's marker and the body it left (what it wears and carries) as one. What a
      // body carries shows when the ✕ is pointed at, only with "Corpse loot" on; a search finds it either way.
      const tipOn = !isHidden('Layer bodies');
      const free = new Set(loot.bodies);
      // the body a corpse marker left: the same person, or else the nearest within a few metres
      const linkOf = m => {
        let best = null, far = 4;
        for (const b of free) {
          if (m.pid && b.pid) { if (m.pid === b.pid) return b; continue; }
          if (m.t && b.who) { if (m.t === b.who) return b; continue; }
          const d = Math.hypot(m.p[0] - b.p[0], m.p[1] - b.p[1]);
          if (d < far) { far = d; best = b; }
        }
        return best;
      };
      const dress = (mark, b, kp) => {
        mark.body = b;
        mark.kpr = !!kp;
        mark.kp = !!kp || bodySeen(mark);
        // (a body the recording hasn't caught yet, as it's kept about once a minute: what they last carried)
        const carried = !b && mark.pid && loot.carried ? loot.carried[mark.pid] : null;
        if (!b && !carried) return mark;
        if (!b) b = { id: '', pid: mark.pid, who: mark.t || '', side: mark.sd || '', p: mark.p, was: mark.was || '' };
        const items = peeking() ? (carried || loot.inside[b.id] || []) : [];
        const counted = items.filter(i => kindOn(names, i[0]));
        const total = counted.reduce((sum, i) => sum + worthOf(i[0], i[1]), 0);
        mark.wish = items.some(i => wished(i[0]));
        const shownHere = !isHidden('Corpse') && (mark.kp || prefs.allCorpses);
        if (looking && shownHere && !carried && (items.some(i => itemHits(i[0])) || hits(b.who))) {
          mark.ring = true;
          found++;
          for (const i of items) if (itemHits(i[0])) note(nameOf(i[0]), T('On a body'), b.p);
          if (hits(b.who)) note(latin(b.who), T('Body'), b.p, 'objects');
        }
        if (tipOn) {
          const lines = counted.slice().sort((a, c) => worthOf(c[0], c[1]) - worthOf(a[0], a[1])).slice(0, 12)
            .map(i => nameOf(i[0]) + (i[1] > 1 ? ' ×' + i[1] : '') + ' · ' + roubles(worthOf(i[0], i[1])) + tagOf(i[0]));
          if (counted.length > 12) lines.push(T('…and {n} more', { n: counted.length - 12 }));
          if (peeking() && !items.length) lines.push(T('Nothing on it'));
          else if (items.length > counted.length) lines.push(notShown(items.length - counted.length));
          if (!mark.was && b.was) mark.was = b.was;
          const who = markerText(mark) || b.who || (b.side === 'Savage' ? T('A scav') : b.side ? T('A {side}', { side: b.side.toUpperCase() }) : T('A body'));
          const killer = killerLine(mark);
          if (killer) lines.unshift(killer);
          mark.tip = { title: who + (total ? ' · ' + roubles(total) : ''), lines };
        }
        return mark;
      };
      corpsesNow = [];
      for (const m of live) {
        if (m.c !== 'Corpse') continue;
        const b = linkOf(m);
        if (b) free.delete(b);
        corpsesNow.push(dress(Object.assign({}, m, b ? { cx: b.p[0], cy: b.p[1], cz: b.p[2] } : {}), b, m.kp || (b && b.kp)));
      }
      // bodies with no marker (they died while no page was open)
      for (const b of free) {
        corpsesNow.push(dress({ id: 'body:' + b.id, c: 'Corpse', t: b.who, was: b.was, pid: b.pid, p: b.p, cx: b.p[0], cy: b.p[1], cz: b.p[2], r: 0 }, b, b.kp));
      }

      // "Rough areas only": loose loot isn't drawn where it lies; what a square of LOOT_CELL metres holds is added up
      // and drawn as one circle in the square's middle (quest items, and what a search finds, are still shown)
      const cells = new Map();
      // quest items over the rest
      const order = loot.loose.slice().sort((a, b) => (a.q ? 1 : 0) - (b.q ? 1 : 0));
      for (const it of order) {
        const want = mine ? wants.items.get(it.tpl) || wants.fItems.get(it.tpl) : null;
        // a quest item of a quest the player (or a friend) hasn't started is left off, while only theirs are shown
        if (it.q && mine && !want) continue;
        const quest = it.q || !!want;
        if (!quest && !lootReal()) continue;
        // an ordinary item a started quest wants found in raid: marked in its own colour, whatever it's worth
        const fir = !quest && firOn ? wants.fir.get(it.tpl) : null;
        const onWish = !quest && wished(it.tpl);
        const match = looking && itemHits(it.tpl);
        if (looking ? !match : quest ? isHidden('Layer quest') : fir ? gone([it.x, it.y, it.z])
          : onWish ? isHidden('Layer loose') || gone([it.x, it.y, it.z])
          : isHidden('Layer loose') || it.worth < minWorth() || !kindOn(names, it.tpl) || gone([it.x, it.y, it.z])) continue;
        found++;
        note(nameOf(it.tpl), T('Loose'), [it.x, it.y]);
        if (!quest && !looking) inBuilding(it, [it.x, it.y, it.z], it.worth, false);
        if (!quest && !fir && !onWish && !match && prefs.lootArea) {
          const cx = Math.floor(it.x / LOOT_CELL), cy = Math.floor(it.y / LOOT_CELL), key = cx + ':' + cy;
          let cell = cells.get(key);
          if (!cell) cells.set(key, cell = { x: (cx + 0.5) * LOOT_CELL, y: (cy + 0.5) * LOOT_CELL, n: 0, worth: 0, best: 0 });
          cell.n++;
          cell.worth += it.worth;
          cell.best = Math.max(cell.best, it.worth);
          continue;
        }
        const s = onScreen(it.x, it.y);
        if (!s) { if (want) questOff.push({ p: [it.x, it.y], t: nameOf(it.tpl) }); continue; }
        if (quest) {
          put(s, [it.x, it.y, it.z], badge('!', LAYERS.quest.col, '#0c0c12', '#0c0c12', 'diamond', size * 1.05));
        } else if (fir) {
          put(s, [it.x, it.y, it.z], badge('i:fir', LAYERS.firItems.col, '#0c0c12', '#0c0c12', 'hex', size * 0.95));
        } else if (onWish) {
          // on the wishlist: a badge of its own, as a found-in-raid need has (one that's both keeps that one's, with
          // the wishlist's ring and star round it)
          put(s, [it.x, it.y, it.z], badge('i:star', WISH_COL, '#0c0c12', '#0c0c12', 'round', size * 0.95));
        } else {
          ctx.globalAlpha = away([it.x, it.y, it.z]) ? Math.max(0.15, faint) : 1;
          ctx.beginPath();
          ctx.arc(s[0], s[1], r, 0, Math.PI * 2);
          ctx.fillStyle = worthCol(it.worth);
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 1.4;
          ctx.fill();
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        const wishBadge = onWish && !fir, marked = quest || !!fir || wishBadge;
        if (match) ring(s, marked ? size * 0.9 : r + 4);
        else if (onWish && !wishBadge) ring(s, size * 0.9, WISH_COL);
        if (onWish && !wishBadge) star(s, size * 0.9);
        const short = (names[it.tpl] || {}).s || nameOf(it.tpl);
        const named = match || (marked && zoom >= 3) || (prefs.itemNames && close);
        if (named) write(short, 10 * scale, s[0], s[1] + (marked ? size * 0.7 : r * 1.3), quest ? LAYERS.quest.col : fir ? LAYERS.firItems.col : wishBadge ? WISH_COL : '#e8e9eb', away([it.x, it.y, it.z]) ? 0.5 : 0.95);
        // its worth beside its name, in its colour as a container's is (a quest item says whose quest instead)
        const whose = w => w && w[2] ? T("{who}'s quest", { who: w[2] }) : '';
        const why = want ? want[0].name + (want[1].text ? ': ' + want[1].text : '') : it.q ? T('Quest item') : '';
        const firWhy = fir ? T('Wanted found in raid for {quest}', { quest: fir[0].name }) + (fir[1].text ? ': ' + fir[1].text : '') : '';
        const wishWhy = wished(it.tpl) ? T('On your wishlist') + (WISH_GROUPS[wishGroup.get(it.tpl)] ? ': ' + WISH_GROUPS[wishGroup.get(it.tpl)] : '') : '';
        thingsDrawn.push({ x: s[0], y: s[1], r: marked ? size / 2 : r * 1.2, tip: { title: nameOf(it.tpl) + (it.n > 1 ? ' ×' + it.n : '') + (why ? '' : ' · ' + roubles(it.worth)), tint: tintOf(it.tpl), lines: [why, whose(want), firWhy, whose(fir), wishWhy] } });
      }
      for (const cell of cells.values()) {
        const s = toScreen(cell.x, cell.y), across = LOOT_CELL * 0.62 * zoom;
        if (s[0] < -across || s[1] < -across || s[0] > vw + across || s[1] > vh + across) continue;
        const col = worthCol(cell.best);
        ctx.save();
        ctx.beginPath();
        ctx.arc(s[0], s[1], across, 0, Math.PI * 2);
        ctx.globalAlpha = 0.13;
        ctx.fillStyle = col;
        ctx.fill();
        ctx.globalAlpha = 0.8;
        ctx.setLineDash([5 * scale, 5 * scale]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = col;
        ctx.stroke();
        ctx.restore();
        write(rough(cell.worth), 10 * scale, s[0], s[1] - 5 * scale, col, 0.95);
        thingsDrawn.push({ x: s[0], y: s[1], r: Math.min(across, 26 * scale), tip: { title: T('Loot somewhere here') + ' · ' + rough(cell.worth),
          lines: [cell.n <= 2 ? T('One or two things lying about in this area') : cell.n <= 6 ? T('A few things lying about in this area') : T('A lot of things lying about in this area')] } });
      }
      for (const [place, t] of roofs) {
        const bl = blds[place - BUILDING], bx = bl.box;
        // a bunker under the ground isn't a building to glance at from above: left out unless asked for
        if (!prefs.roofTotalsUnder && underOf(bl)) continue;
        const pts = [toScreen(bx.x0, bx.y0), toScreen(bx.x1, bx.y0), toScreen(bx.x1, bx.y1), toScreen(bx.x0, bx.y1)];
        const x0 = Math.min(...pts.map(p => p[0])), x1 = Math.max(...pts.map(p => p[0]));
        const y0 = Math.min(...pts.map(p => p[1])), y1 = Math.max(...pts.map(p => p[1]));
        // too small on the screen to write over, or off it
        if (x1 - x0 < 44 || x1 < 0 || y1 < 0 || x0 > vw || y0 > vh) continue;
        const said = prefs.lootArea ? rough(t.worth) : shortWorth(t.worth);
        // written over the middle of the building; where that's outside its walls (an L, a ring), at its topmost
        // corner, just inside
        let cx = (x0 + x1) / 2, top = y0 + 2, high = Infinity;
        const mx = (bx.x0 + bx.x1) / 2, my = (bx.y0 + bx.y1) / 2;
        if (inLoops(bl.l, mx, my)) {
          const s = toScreen(mx, my);
          cx = s[0];
          top = s[1] - 7 * scale;
        } else {
          for (const loop of bl.l) {
            for (let i = 0; i + 1 < loop.length; i += 2) {
              const s = toScreen(loop[i], loop[i + 1]);
              if (s[1] < high) { high = s[1]; cx = Math.min(x1 - 24, Math.max(x0 + 24, s[0])); top = s[1] + 4; }
            }
          }
        }
        write('⌂ ' + said, 11 * scale, cx, top, worthCol(t.best), 0.95);
        thingsDrawn.push({ x: cx, y: top + 7 * scale, r: 13 * scale, tip: { title: (underOf(bl) ? T('Under the ground here') : T('In this building')) + ' · ' + (prefs.lootArea ? rough(t.worth) : roubles(t.worth)),
          lines: prefs.lootArea ? [T('Press inside it to look in')] : [t.loose ? TP(t.loose, '{n} thing lying about', '{n} things lying about') : '',
            t.boxes ? TP(t.boxes, '{n} container worth looking in', '{n} containers worth looking in') : '', T('Press inside it to look in')] } });
      }
    }
    ctx.restore();
    tell();
  }

  // the name and worth of what's pointed at, by the pointer
  function showTip(found, sx, sy) {
    const tip = $('tip');
    if (!found) { if (!tip.hidden) tip.hidden = true; tipFor = null; return; }
    if (tipFor !== found.tip) {
      tipFor = found.tip;
      tip.textContent = '';
      // What it says comes as words with " · " between their parts ("Bitcoin ×2 · 1,520,000 ₽ · quest"). Set out
      // here: the name on the left, then a column each for a chance and a worth, the worth in its colour.
      const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
      const isWorth = t => /^[\d,]+ ₽$/.test(t), isChance = t => /^<?[\d.]+%$/.test(t);
      const worthOf = t => +t.replace(/[^\d]/g, '') || 0;
      const cells = (row, parts) => {
        for (const part of parts) {
          if (isWorth(part)) { const c = el('span', 'worth', part); c.style.color = worthCol(worthOf(part)); row.appendChild(c); }
          else if (isChance(part)) row.appendChild(el('span', 'chance', part));
          else if (part === 'quest') row.appendChild(el('span', 'tag', T('Quest')));
          else if (part === 'fir') { const t = el('span', 'tag fir', 'FIR'); t.title = T('Needed found in raid for a quest'); row.appendChild(t); }
          else if (part === 'wish') { const t = el('span', 'tag wish', '★'); t.title = T('On your wishlist'); row.appendChild(t); }
          else row.appendChild(el('span', 'more', part));
        }
      };
      // a tag (Quest, FIR) goes beside the name, so every worth stays in its column
      const TAGS = ['quest', 'fir', 'wish'];
      const tagFirst = parts => parts.filter(p => TAGS.includes(p)).concat(parts.filter(p => !TAGS.includes(p)));
      const head = found.tip.title.split(' · ');
      const title = el('div', 'tipHead');
      const named = title.appendChild(el('strong', '', head[0]));
      if (found.tip.tint) named.style.color = found.tip.tint;
      cells(title, head.slice(1));
      tip.appendChild(title);
      // a bot's: what it is and how it is on the left, what it wears and carries on the right (side), so the card is
      // wide rather than long; one column on a narrow screen
      const side = found.tip.side && found.tip.side.some(Boolean) ? found.tip.side : null;
      tip.classList.toggle('cols', !!side);
      const fill = (box, lines) => {
      let list = null;
      for (const line of lines) {
        if (!line) continue;
        const text = line.trim(), parts = text.split(' · ');
        const item = parts.length > 1 && parts.slice(1).some(p => isWorth(p) || isChance(p));
        if (!item) {
          list = null;
          // a heading ("Can hold:"), a key, or a line of plain words
          const cls = /[:：]$/.test(text) ? 'tipSub' : text.startsWith(T('Key:') + ' ') ? 'tipNote key' : 'tipNote';
          box.appendChild(el('div', cls, cls === 'tipSub' ? text.slice(0, -1) : text));
          continue;
        }
        if (!list) box.appendChild(list = el('div', 'tipList'));
        const row = el('div', 'tipRow');
        const price = parts.find(isWorth);
        const dot = el('i', 'dot');
        dot.style.background = price ? worthCol(worthOf(price)) : 'transparent';
        // how many of it, apart from its name
        const many = /^(.*?)( ×\d+)$/.exec(parts[0]);
        const name = el('span', 'name', many ? many[1] : parts[0]);
        if (many) name.appendChild(el('em', '', many[2]));
        row.append(dot, name);
        cells(row, tagFirst(parts.slice(1)));
        list.appendChild(row);
      }
      };
      if (side) {
        const cols = el('div', 'tipCols'), left = el('div', 'tipCol'), right = el('div', 'tipCol');
        fill(left, found.tip.lines);
        fill(right, side);
        cols.append(left, right);
        tip.appendChild(cols);
      } else fill(tip, found.tip.lines);
    }
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(sx + 14, vw - w - 8) + 'px';
    tip.style.top = (sy + 14 + h > vh - 8 ? Math.max(8, sy - h - 10) : sy + 14) + 'px';
  }

  // ---- drawing -------------------------------------------------------------------------------------------------
  // a wishlist item's mark: a small five-pointed star, rimmed dark, the colour of its ring
  const WISH_COL = '#6ec6ff';
  function wishStar(x, y, rad) {
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 5, far = i % 2 ? rad * 0.45 : rad;
      ctx.lineTo(x + far * Math.cos(a), y + far * Math.sin(a));
    }
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = '#000';
    ctx.stroke();
    ctx.fillStyle = WISH_COL;
    ctx.fill();
    ctx.restore();
  }
  // Words on the map are drawn once each into a small picture of their own, and copied onto the map from there.
  // Written straight onto the map every frame, a phone's browser keeps the letters on its graphics chip, and on some
  // phones that store breaks after a while (many names, distances changing as you walk): words turn into blocks and
  // flicker. These pictures are drawn without the graphics chip (willReadFrequently), so it isn't used for letters at
  // all. The last WORD_PICS words are kept.
  const WORD_PICS = 900;
  const wordPics = new Map();
  let wordRuler = null;
  function wordPic(text, px, col, ratio) {
    const key = ratio + '|' + px + '|' + col + '|' + text;
    let pic = wordPics.get(key);
    if (pic) {
      wordPics.delete(key);
      wordPics.set(key, pic);
      return pic;
    }
    const font = 'bold ' + px + 'px ' + FONT, line = Math.max(2, px * 0.28), pad = Math.ceil(line / 2 + 1);
    if (!wordRuler) wordRuler = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    wordRuler.font = font;
    wordRuler.textBaseline = 'top';
    const metrics = wordRuler.measureText(text);
    const w = Math.ceil(metrics.width + pad * 2), h = Math.ceil(px * 1.4 + pad * 2);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w * ratio));
    c.height = Math.max(1, Math.ceil(h * ratio));
    const g = c.getContext('2d', { willReadFrequently: true });
    g.scale(ratio, ratio);
    g.font = font;
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.lineJoin = 'round';
    g.lineWidth = line;
    g.strokeStyle = '#000';
    g.fillStyle = col;
    g.strokeText(text, w / 2, pad);
    g.fillText(text, w / 2, pad);
    // Bot label rows share the transparent sprite margins. Keep the visible outline
    // in the placement bounds, including accents and descenders at custom text sizes.
    const inkTop = Math.floor(-(metrics.actualBoundingBoxAscent ?? 0) - line / 2);
    const inkBottom = Math.ceil((metrics.actualBoundingBoxDescent ?? px) + line / 2);
    pic = { c, w, h, pad, inkTop, inkBottom };
    wordPics.set(key, pic);
    if (wordPics.size > WORD_PICS) wordPics.delete(wordPics.keys().next().value);
    return pic;
  }
  function write(text, px, x, y, col, alpha) {
    px *= prefs.textScale;
    const ratio = pixelRatio(), pic = wordPic(String(text), px, inkOf(col), ratio);
    // on whole screen pixels, so the words stay sharp
    const left = Math.round((x - pic.w / 2) * ratio) / ratio, top = Math.round((y - pic.pad) * ratio) / ratio;
    ctx.globalAlpha = alpha;
    ctx.drawImage(pic.c, left, top, pic.w, pic.h);
    ctx.globalAlpha = 1;
  }

  // What a marker is called: a body says what it was ("Scav · name") when asked to, a PMC their level.
  const ONE = { 'Enemy Player': T('PMC'), 'Friendly Player': T('Player'), 'Main Player': T('Player'), 'Sniper': T('Sniper scav'), 'Other AI': T('Bot'),
    Scav: T('Scav'), Smuggler: T('Smuggler'), Raider: T('Raider'), Rogue: T('Rogue'), 'Black Division': T('Black Division'), RUAF: T('RUAF'),
    'RUAF Remnant': T('RUAF remnant'), UNTAR: 'UNTAR', ISB: T('ISB'), 'ISB WT': 'ISB WT', Bloodhound: T('Bloodhound'), Mercenary: T('Mercenary'), Combine: T('Combine'), Civilian: T('Civilian'), Infected: T('Infected'), Guard: T('Guard'), Cultist: T('Cultist'), Goon: T('Goon'),
    Boss: T('Boss'), Corpse: T('Body'), Extract: T('Extract'), Transit: T('Transit'), Airdrop: T('Airdrop'), BTR: T('BTR') };
  const DROPS = { Common: T('Airdrop'), Supply: T('Supply airdrop'), Medical: T('Medical airdrop'), Weapon: T('Weapon airdrop') };
  // an airdrop's crate: what's in it and its worth, once the game tells (when container contents are shown)
  function dropTip(m) {
    if (m.c !== 'Airdrop') return null;
    const loot = inRaidHere() && things ? things : null;
    const items = loot && m.box && peeking() && !isHidden('Layer boxes') ? (loot.inside[m.box] || []).filter(i => kindOn(loot.names, i[0])) : [];
    const worthOf = i => ((loot.names[i[0]] || {}).p || 0) * (i[1] || 1);
    const nameOf = tpl => (loot.names[tpl] || {}).s || (loot.names[tpl] || {}).n || tpl;
    const sorted = items.slice().sort((a, b) => worthOf(b) - worthOf(a));
    const lines = sorted.slice(0, 14).map(i => nameOf(i[0]) + (i[1] > 1 ? ' ×' + i[1] : '') + ' · ' + roubles(worthOf(i)));
    if (sorted.length > 14) lines.push(T('…and {n} more', { n: sorted.length - 14 }));
    if (m.fall) lines.unshift(T('Coming down'));
    const total = items.reduce((sum, i) => sum + worthOf(i), 0);
    return { title: (DROPS[m.t] || T('Airdrop')) + (total ? ' · ' + roubles(total) : ''), lines };
  }
  const transitText = m => m.to ? T('Transit to {map}', { map: locationName(m.to) }) : T('Transit');
  // what an extract or a transit says under the pointer: what it is, and whether it can be taken
  function exitTip(m) {
    // (not by the game's name for it: that's an id such as "TRANSIT01")
    if (m.c === 'Transit') return { title: transitText(m), lines: [m.st === 0 ? T('Not open yet') : ''] };
    if (m.c !== 'Extract' || !m.sec) return null;
    return { title: m.t || T('Extract'), lines: [T('Secret extract'), m.st === 3 ? T('Not found yet: its note opens it') : ''] };
  }
  // A level worth saying: a player's or a PMC's, and any bot's above 1 (PBT gives its bots levels). Every other bot is
  // level 1 whatever it is, so that isn't said.
  const levelShown = (lv, kind) => lv > 1 || (lv > 0 && ['Main Player', 'Friendly Player', 'Enemy Player'].includes(kind));
  // the floor of a building somebody or something is on, by its name ("3rd floor"); '' out in the open
  function floorSaid(m) {
    if (!Number.isFinite(m.cz)) return '';
    const place = buildingAt(m.cx, m.cy, m.cz), n = place ? buildingFloor(place, m.cx, m.cy, m.cz) : 0;
    return n ? floorName(place, n) : '';
  }
  function markerText(m) {
    if (m.c === 'Transit') return transitText(m);
    if (m.c === 'Airdrop') return (DROPS[m.t] || T('Airdrop')) + (m.fall ? ' · ' + T('coming down') : '');
    if (m.c === 'Corpse') return prefs.corpseKind && m.was ? (ONE[m.was] || m.was) + (m.t ? ' · ' + m.t : '') : m.t || '';
    return m.t ? m.t + (levelShown(m.lv, m.c) ? ' · ' + T('Lv {n}', { n: m.lv }) : '') + teamText(m) : '';
  }
  // by the name of somebody who came in with others: their team's number (Settings > Team number by names)
  const teamOn = m => prefs.teamNames !== false && m.dyn && teamKey(m) && m.c !== 'Corpse' && squadOf(m);
  const teamText = m => teamOn(m) ? ' · #' + squadNo(teamKey(m)) : '';

  // What a bot is like and is up to, as the game's plugin tells it (when the server lets it): how hard it is, the
  // personality SAIN gave it, and who is deciding for it now: SAIN (it's in a fight), COMET (the move it's making in
  // that fight, or just after it), ORBIT (it's going about the map, or parked far from every player as a "ghost"),
  // or the game's own brain. Each only when that mod is in the game.
  const DIFFICULTY = { easy: T('difficulty|Easy'), normal: T('difficulty|Normal'), hard: T('difficulty|Hard'), impossible: T('difficulty|Impossible') };
  const SAIN_LAYERS = { 'Combat Layer': T('In a fight'), 'Squad Layer': T('In a fight, with its squad'), 'Extract': T('Leaving the raid'),
    'Avoid Threat': T('Getting away from a threat'), 'Flashed': T('Blinded'), 'SAIN Debug': T('Debug') };
  const COMET_MOVES = { Push: T('Pushing'), Hold: T('Holding'), KeepAngle: T('Holding an angle'), Search: T('Searching'), FallBack: T('Falling back'),
    Cover: T('Moving to cover'), Shoot: T('Shooting'), Flank: T('Flanking'), Crossfire: T('Crossfire'), PostCombat: T('After the fight') };
  const words = s => s.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  // "CrossfireMoving": "Crossfire · moving"; "Push": "Pushing"; one it doesn't know: as COMET has it, in words
  function cometMove(cm) {
    if (COMET_MOVES[cm]) return COMET_MOVES[cm];
    const part = /^(Crossfire|PostCombat)(.+)$/.exec(cm);
    if (part) return COMET_MOVES[part[1]] + ' · ' + words(part[2]);
    const said = words(cm);
    return said.charAt(0).toUpperCase() + said.slice(1);
  }
  // What COMET has a bot doing with its squad ("sq" on its marker, and each "comet.squad" event): the squad's tactic,
  // the bot's part in it, and whether COMET has it doing that yet or only means to.
  const SQUAD_TACTICS = { S01: T('Crossfire angles'), S02: T('Second way in'), S03: T('Support and flank'), S04: T('Covering a teammate'),
    S05: T("Answering a teammate's death"), S06: T('Squad assault'), S10: T('Grenade suppression'), S11: T('Siege') };
  const SQUAD_ANGLE = { planning: T('Planning'), ready: T('Ready'), moving: T('Moving to an angle'), holding: T('Holding an angle') };
  const SQUAD_DOOR = { planning: T('Planning'), moving: T('Moving to it'), watching: T('Watching it'), 'preparing-entry': T('About to go in'),
    opening: T('Opening it'), entering: T('Going in') };
  const squadTactic = q => SQUAD_TACTICS[q.f] || T('Squad tactic');
  const squadOver = q => q.s === 'ended' || q.u === 'ended';
  function squadPart(q) {
    // (a move the squad thought of and didn't make, or one cut short, as Raid Review says them)
    if (q.u === 'declined') return T('Declined');
    if (q.u === 'interrupted') return T('Interrupted');
    if (q.f === 'S03' && q.r === 'unassigned') return T('No role assigned');
    if (squadOver(q)) return T('Over');
    if (q.f === 'S03') return q.r === 'support' ? (q.x ? T('Suppressing') : T('Supporting')) : q.r === 'rear' ? T('Watching the rear') : q.s === 'moving' ? T('Flanking') : T('Holding the flank');
    if (q.f === 'S06') return q.a ? T('Going in') : T('Getting ready');
    if (q.f === 'S10') return q.r === 'throw' ? T('Throwing a grenade') : T('Holding an angle');
    if (q.f === 'S11') return T('Watching a way out');
    if (q.f === 'S05') return q.r === 'push' ? T('Pushing the killer') : q.s === 'moving' ? T('Moving to watch') : T('Watching where they fell');
    if (q.f === 'S04') return q.s === 'moving' ? T('Going to cover {who}', { who: q.m ? latin(q.m) : T('a teammate') }) : T('Covering {who}', { who: q.m ? latin(q.m) : T('a teammate') });
    if (q.f === 'S02') return SQUAD_DOOR[q.u] || SQUAD_ANGLE[q.s] || T('Second way in');
    return SQUAD_ANGLE[q.s] || T('Crossfire');
  }
  const squadSaid = q => squadTactic(q) + ' · ' + squadPart(q) + (q.a || squadOver(q) ? '' : ' (preparing)');
  // who a squad's tactic is against, by name, when that one is on the map
  function squadFoe(q) {
    if (!q.c) return '';
    const foe = live.find(x => x.pid === q.c);
    return foe ? (foe.t || ONE[foe.c] || foe.c) : me && me.pid === q.c ? 'you' : '';
  }
  // the bots acting together: the plan they share, else the group or band they go about in
  const squadKey = m => (m.sq && m.sq.p) || m.g || (m.bg ? 'bot:' + m.bg : 'solo:' + m.id);
  function brainOf(m) {
    if (m.gh) return { by: 'ORBIT', text: T('Ghost') + (m.ob ? ' · ' + m.ob : ''), ghost: true };
    const layer = m.ly || '';
    // COMET makes its moves through SAIN's layers and two of its own, so only then is the move still the bot's
    if (/^COMET/i.test(layer) && !modOn('COMET')) return null;
    if (/^SAIN/i.test(layer) && !m.cm && !modOn('SAIN')) return null;
    if (/^Orbit/i.test(layer) && !modOn('ORBIT')) return null;
    if (/^COMET/i.test(layer) || (m.cm && /^SAIN/i.test(layer))) {
      const after = /Post-combat/i.test(layer) || /^PostCombat/.test(m.cm || '');
      return { by: 'COMET', text: m.cm ? cometMove(m.cm) : layer.replace(/^COMET\s*:\s*/i, ''), fight: !after };
    }
    if (/^SAIN/i.test(layer)) {
      const name = layer.replace(/^SAIN\s*:\s*/i, '');
      return { by: 'SAIN', text: SAIN_LAYERS[name] || name, fight: name === 'Combat Layer' || name === 'Squad Layer' };
    }
    if (/^Orbit/i.test(layer)) return { by: 'ORBIT', text: m.ob || T('Going about the map') };
    // QuestingBots or Phobos sending it somewhere ("os": which)
    if (m.os && m.ob) return { by: m.os, text: m.ob };
    return layer ? { by: 'EFT', text: gameLayer(layer) } : null;
  }
  // The game's own brain layers, in plain words: the usual ones by name, the rest by what their name says (each
  // boss's has its own: PtrlBirdEye, KnightFight...), else the name split into words ("Loot patrol").
  const EFT_LAYERS = { LootPatrol: 'Patrolling, looking for loot', PatrolAssault: 'Patrolling', PatrolFollower: 'Following its leader',
    PmcBear: 'Going about the raid', PmcUsec: 'Going about the raid', StandBy: 'Standing by', AssaultHaveEnemy: 'Fighting',
    AssaultBuilding: 'Clearing a building', Pursuit: 'Chasing' };
  const EFT_LIKE = [[/Follow/i, 'Following its leader'], [/Fight|HaveEnemy|Attack|Combat/i, 'Fighting'], [/Pursuit|Chase/i, 'Chasing'],
    [/Heal/i, 'Healing'], [/Exfil|Leave/i, 'Leaving the raid'], [/Loot/i, 'Looting'], [/Sniper/i, 'Watching for targets'],
    [/^Ptrl|Patrol/i, 'Patrolling'], [/Stand|Wait|Idle/i, 'Standing by'], [/^Pmc/i, 'Going about the raid']];
  function gameLayer(name) {
    if (EFT_LAYERS[name]) return T(EFT_LAYERS[name]);
    for (const [test, said] of EFT_LIKE) if (test.test(name)) return T(said);
    const words = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').trim();
    return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
  }
  // Who killed a body: 'me' (the player shown), 'player' (somebody else playing), 'ai' (a bot, as the raid's kill
  // events say) or '' (not known, or they killed themselves). By the body's own "kb" (the killer's profile id), else by
  // the raid's kill events (an older plugin, an older recording, and every kill by a bot).
  let ownIds = [];
  const killOf = m => m.pid ? killEvents.find(k => k.p === m.pid) : null;
  function killedBy(m) {
    if (m.kb) return ownIds.includes(m.kb) ? 'me' : 'player';
    const e = killOf(m);
    if (e) {
      if (e.d.kk === 'Main Player') return 'me';
      if (e.d.kk === 'Friendly Player') return 'player';
      if (m.kpr) return 'player';
      return e.d.kk && e.d.k !== e.p ? 'ai' : '';
    }
    return m.kpr ? 'player' : '';
  }
  // the bot that killed a body, as the tip names it: its name, else what it was
  const botKiller = m => { const e = killOf(m); return e ? (e.d.kn ? latin(e.d.kn) : ONE[e.d.kk] || e.d.kk || '') : ''; };
  // a body that was a PMC's (a person playing or a PMC bot)
  const PMC_KINDS = ['Main Player', 'Friendly Player', 'Enemy Player'];
  const wasPmc = m => { const e = killOf(m); return PMC_KINDS.includes(m.was) || !!(e && PMC_KINDS.includes(e.d.vk)); };
  const likeOf = m => [DIFFICULTY[m.df] || m.df, m.ps].filter(Boolean).join(' · ');
  const hasDetails = m => prefs.botDetails && !!(m.df || m.ps || m.ly || m.gh);
  // What bots are like and are up to has a switch for each mod that says it: SAIN (personality, and that it's in a
  // fight), ORBIT (going about the map, or parked as a ghost), COMET (its move in a fight, and what its squad is doing
  // together). A switch is greyed, and can't be pressed, while the game hasn't that mod (remembered, so it's right
  // out of a raid too). With any of them on, a bot's difficulty and the game's own brain are shown as well.
  const BOT_MODS = { SAIN: "Each bot's SAIN personality, and when SAIN has it in a fight (a red ring round its marker).",
    ORBIT: 'What ORBIT has each bot heading for, and the bots it has parked as ghosts, far from every player.',
    COMET: "The move COMET has each bot making in a fight, and what its squad is doing together: tags in the Raid list, lines on the map to where each is sent, and the squad's events under the list." };
  // the line saying who killed a body, or '' when that's not known
  function killerLine(m) {
    const by = killedBy(m);
    // a bot is named only when its kind is shown on the map
    if (by === 'ai') { const e = killOf(m), k = botKiller(m); return k && e && !isHidden(e.d.kk) && !prefs.areaKinds.includes(e.d.kk) ? T('Killed by {who}', { who: k }) : ''; }
    return by === 'me' ? T('Killed by you') : by ? T('Killed by another player') : '';
  }
  // A body's tip when its loot isn't shown (corpse loot off, or no loot to hand): who it was and who killed them.
  // Kept while it says the same, so the tip isn't drawn again at every move of the pointer.
  let killTipKept = null;
  function killTip(m) {
    if (m.c !== 'Corpse') return null;
    const line = killerLine(m);
    if (!line) return null;
    const title = markerText(m) || m.t || T('A body');
    if (!killTipKept || killTipKept.title !== title || killTipKept.lines[0] !== line) killTipKept = { title, lines: [line] };
    return killTipKept;
  }
  const MOD_OPTIONS = [['optOrbitLines', 'ORBIT'], ['optOrbitTactics', 'ORBIT'], ['optOrbitMain', 'ORBIT'], ['optOrbitRush', 'ORBIT'], ['optOrbitField', 'ORBIT'], ['optOrbitNames', 'ORBIT'], ['optOrbitFights', 'ORBIT'], ['optOrbitHear', 'ORBIT'],
    ['optRosterGhosts', 'ORBIT'], ['optSquadParts', 'COMET'], ['optTacticWords', 'COMET'], ['optPhobosField', 'Phobos']];
  const modHere = n => (prefs.brains || []).includes(n);
  // (in a replay always: what SAIN, COMET and ORBIT had the bots doing is what a replay is watched for)
  const modOn = n => modHere(n) && (HIST || prefs['bot' + n] !== false);
  function nameBotDetails() {
    for (const n of Object.keys(BOT_MODS)) {
      const box = $('optBot' + n), row = $('optBot' + n + 'Row'), here = modHere(n);
      box.disabled = !here;
      box.checked = here && prefs['bot' + n] !== false;
      row.classList.toggle('unavailable', !here);
      row.title = here ? T(BOT_MODS[n]) + ' ' + T("With the bot's difficulty, in the Raid list and by the pointer.")
        : prefs.brains ? T("{mod} isn't loaded in this game.", { mod: n }) : T('No game has said which mods it has yet.');
    }
    // every other switch that only does something with one of these mods: greyed the same way while it's missing (or
    // switched off above), saying why
    for (const [id, n] of MOD_OPTIONS) {
      const box = $(id), row = box.closest('label');
      if (row.dataset.tip === undefined) row.dataset.tip = titleOf(row);
      const on = modOn(n);
      box.disabled = !on;
      row.classList.toggle('unavailable', !on);
      row.title = on ? row.dataset.tip : !modHere(n) && prefs.brains ? T("{mod} isn't loaded in this game.", { mod: n })
        : !modHere(n) ? T('No game has said which mods it has yet.') : row.dataset.tip;
    }
    squadPanePrint = '';
    if ($('squadPane')) showSquadPane();
    $('optBotDiff').checked = prefs.botDiff !== false;
    const on = prefs.botDiff !== false || Object.keys(BOT_MODS).some(modOn);
    if (prefs.botDetails !== on) { prefs.botDetails = on; save(); }
    dirty = true;
    rosterPrint = bestPrint = null;
    tipFor = null;
  }
  // a marker as the switches have it: what a mod says is left off while its switch is off
  function trimBrains(m) {
    if (prefs.botDiff === false) delete m.df;
    if (!modOn('SAIN')) delete m.ps;
    // (a bot ORBIT parked is drawn as a ghost whenever ORBIT is in the game, its details switch or not)
    if (!modOn('ORBIT') && !m.os) { if (!modHere('ORBIT')) delete m.gh; delete m.ob; delete m.og; }
    if (!modOn('COMET')) { delete m.cm; delete m.sq; }
  }
  // what a living bot wears and carries, when asked for (off unless switched on): its worth, and the dearest first
  // Each thing is [template, how many, slot]: the slot it's worn in ("Headwear", "Backpack"), when the game's plugin
  // says (a newer one does); nothing for what lies in the pockets, rig and bags. worn: its guns and what it has on,
  // in the order below. held: the rest, the dearest first. lines: all of it as text, for the pointer.
  const WORN = [['FirstPrimaryWeapon', T('Primary')], ['SecondPrimaryWeapon', T('Secondary')], ['Holster', T('Sidearm')], ['Headwear', T('Helmet')],
    ['Earpiece', T('Headset')], ['FaceCover', T('Face')], ['Eyewear', T('Eyes')], ['ArmorVest', T('Armour')], ['TacticalVest', T('Rig')],
    ['Backpack', T('Backpack')], ['Scabbard', T('Melee')]];
  // What can't be taken off somebody, so it's not counted in what they're worth: as the game has it for the item
  // ("u": "slot|sides", from the server), else (older servers and recordings) as the game has it for every item:
  // a PMC's melee, and an armband, a special slot's tool or the pockets themselves on anybody. Only what's worn in
  // that slot: the same knife in a backpack can be looted.
  const UNLOOTABLE_SLOTS = { Scabbard: ['Bear', 'Usec'], ArmBand: null, SpecialSlot: null, Pockets: null, SecuredContainer: null };
  function cantLoot(names, i, side) {
    if (!i[2]) return false;
    const u = (names[i[0]] || {}).u, who = side || 'Savage';
    if (typeof u === 'string') {
      const [slot, sides] = u.split('|');
      return slot === i[2] && (!sides || sides.split(',').includes(who));
    }
    if (!(i[2] in UNLOOTABLE_SLOTS)) return false;
    const sides = UNLOOTABLE_SLOTS[i[2]];
    return !sides || sides.includes(who);
  }
  function carriedBy(m) {
    // its own switch (Raid > Bot loot), with Show what's inside things: whatever the Loot tab shows on the map, which
    // is about loot lying about, not what bots carry
    const loot = prefs.botLoot && prefs.peek && m.pid && m.c !== 'Corpse' && inRaidHere() && things ? things : null;
    const items = loot ? loot.carried[m.pid] : null;
    if (!items || !items.length) return null;
    const worthOf = i => cantLoot(loot.names, i, m.sd) ? 0 : ((loot.names[i[0]] || {}).p || 0) * (i[1] || 1);
    const said = i => ((loot.names[i[0]] || {}).s || (loot.names[i[0]] || {}).n || i[0]) + (i[1] > 1 ? ' ×' + i[1] : '') + (cantLoot(loot.names, i, m.sd) ? ' (' + T('can\'t be looted') + ')' : '');
    const worn = [];
    for (const [slot, label] of WORN) for (const i of items) if (i[2] === slot) worn.push({ label, text: said(i), worth: worthOf(i) });
    const rest = items.filter(i => !i[2]).sort((a, b) => worthOf(b) - worthOf(a));
    const held = rest.slice(0, 12).map(i => ({ text: said(i), worth: worthOf(i) }));
    // (what's in its secure container: a newer game plugin says, the slot "SecuredContainer"; worth nothing to a looter)
    const price = i => ((loot.names[i[0]] || {}).p || 0) * (i[1] || 1);
    const secure = items.filter(i => i[2] === 'SecuredContainer' && prefs.secureShown).sort((a, b) => price(b) - price(a))
      .map(i => ({ text: ((loot.names[i[0]] || {}).s || (loot.names[i[0]] || {}).n || i[0]) + (i[1] > 1 ? ' ×' + i[1] : ''), worth: price(i) }));
    const more = rest.length - held.length;
    // (by the pointer, either part may be folded into one line: how many things and their worth, Settings > Gear in
    // full, What it carries in full)
    const sum = list => list.reduce((n, g) => n + g.worth, 0);
    const lines = prefs.tipGear === false ? (worn.length ? [T('Gear') + ' (' + worn.length + ') · ' + roubles(sum(worn))] : [])
      : worn.map(g => g.label + ': ' + g.text + (g.worth ? ' · ' + roubles(g.worth) : ''));
    if (prefs.tipCarry === false) {
      if (rest.length) lines.push(T('Carrying') + ' (' + rest.length + ') · ' + roubles(rest.reduce((n, i) => n + worthOf(i), 0)));
    } else {
      if (worn.length && held.length) lines.push(T('Carrying:'));
      for (const h of held) lines.push((worn.length ? '   ' : '') + h.text + ' · ' + roubles(h.worth));
      if (more > 0) lines.push((worn.length ? '   ' : '') + T('…and {n} more', { n: more }));
    }
    // what it picked up this raid and put in its secure container (each pick-up says, a newer game plugin's): said even
    // with the secure container itself left out, so a find that seems to vanish (the Mona Lisa) doesn't
    const stashed = prefs.secureShown ? [] : otherEvents.filter(e => e.k === 'loot' && e.p === m.pid && e.d && e.d.in === 'SecuredContainer');
    if (stashed.length) {
      lines.push(T('Put in its secure container (can\'t be looted):'));
      for (const e of stashed.slice(-8).reverse()) { const v = lootWorth(e.d); lines.push('   ' + e.d.i + (e.d.q > 1 ? ' ×' + e.d.q : '') + (Number.isFinite(v) ? ' · ' + roubles(v) : '')); }
    }
    if (secure.length) {
      lines.push(T('In its secure container (can\'t be looted):'));
      for (const k of secure.slice(0, 8)) lines.push('   ' + k.text + (k.worth ? ' · ' + roubles(k.worth) : ''));
      if (secure.length > 8) lines.push('   ' + T('…and {n} more', { n: secure.length - 8 }));
    }
    return { total: items.reduce((sum, i) => sum + worthOf(i), 0), lines, worn, held, more, secure, stashed };
  }
  // said by the pointer; made once for each report of a marker
  function botTip(m) {
    const carried = carriedBy(m);
    if (!hasDetails(m) && !carried && !m.ch && !m.psc) return null;
    // (made again once a part of it is folded or unfolded)
    const folds = (prefs.tipGear !== false) + '|' + (prefs.tipCarry !== false) + '|' + !!prefs.secureShown;
    if (!m.botTip || m.botTipFolds !== folds || m.botTipOrbit !== orbitMain?.n || m.botTipInventory !== things?.carried[m.pid]) {
      m.botTipFolds = folds;
      m.botTipOrbit = orbitMain?.n;
      m.botTipInventory = things?.carried[m.pid];
      const goal = hasDetails(m) ? orbitGoalOf(m.pid) : null;
      const brain = hasDetails(m) ? brainOf(m) : null, like = hasDetails(m) ? likeOf(m) : '';
      m.botTip = { title: (m.t || ONE[m.c] || m.c) + (carried && carried.total ? ' · ' + roubles(carried.total) : ''),
        lines: [(m.psc ? T('AI player scav') : ONE[m.c] || m.c) + (levelShown(m.bl, m.c) ? ' · ' + T('Lv {n}', { n: m.bl }) : '') + (like ? ' · ' + like : ''), m.dn ? T('Down: can be got up again') : '', brain ? brain.by + ': ' + brain.text : '',
          m.ch ? T('PBT cheater') + (m.chd ? ' · ' + cheatSaid(m.chd) : '') : '', ...(prefs.health && Array.isArray(m.hp) ? hpSaid(m).split('\n') : ['']),
          hasDetails(m) && m.sq ? T('Squad:') + ' ' + squadSaid(m.sq) + (squadFoe(m.sq) ? ' · ' + T('against {who}', { who: squadFoe(m.sq) }) : '') : '',
          hasDetails(m) && goal ? T('ORBIT goal:') + ' ' + goal.text : '',
          hasDetails(m) && m.xr ? T('Leaving the raid: {why}', { why: extractReason(m.xr) }) : ''], side: carried ? carried.lines : null };
    }
    return m.botTip;
  }

  // a name by a marker: always centred under it, fixed to it like the map itself, so it goes off the screen with its
  // marker (over: where it'd go above the marker, kept for the callers; no longer used)
  // (alpha: fainter for what's on another floor than the player)
  function label(text, px, x, under, over, col, alpha = 1) {
    write(text, px, x, under, col, alpha);
  }

  // a PMC who came in with others: their team's colour (Settings > Team colours), for their marker and trail
  const teamColOf = m => m.c === 'Enemy Player' && prefs.squadCols && teamKey(m) && squadOf(m) ? squadCol(squadNo(teamKey(m))) : null;
  const DOING_COL = { SAIN: '#ff8d84', COMET: '#ffc56e', ORBIT: '#9fd8ff', QuestingBots: '#b7e3a1', Phobos: '#b7e3a1' };
  // Living bot markers use pid. Human Fika players use u, including player scavs.
  function isMapBot(m, kind) {
    return kind.shape === 'arrow' && m.c !== 'Main Player' && (m.c !== 'Friendly Player' || !!m.pid);
  }
  function showBotName(mode, m, kind) {
    const pmc = m.c === 'Enemy Player' || (m.c === 'Friendly Player' && (m.sd === 'Usec' || m.sd === 'Bear'));
    if (mode === 'some' || mode === 'players') return kind.label || (mode === 'players' && pmc);
    return mode === 'all' || (mode === 'pmc' && pmc) || (mode === 'other' && !pmc);
  }
  // a colour as the canvas gives it back ("#rrggbb", or "rgba(..)" once it's see-through), at alpha a
  const seeThrough = (col, a) => {
    if (/^#[0-9a-f]{6}$/i.test(col)) return col + Math.round(a * 255).toString(16).padStart(2, '0');
    const m = /^rgba?\(([^,]+),([^,]+),([^,)]+)/.exec(col);
    return m ? 'rgba(' + m[1] + ',' + m[2] + ',' + m[3] + ',' + a + ')' : col;
  };
  // Lay out text in screen space after drawing the map. Pins, paths and hit tests stay at their world positions.
  const botLabels = [];
  function drawBotLabels(scale) {
    const blocks = botLabels;
    if (!blocks.length) return;
    const bounds = [], gap = 3 * scale, ratio = pixelRatio();
    blocks.sort((a, b) => b.priority - a.priority || a.id - b.id);
    const shared = new Map();
    for (const block of blocks) {
      const team = teamKey(block.marker);
      for (const line of block.lines) {
        if (team && line.objective && block.lines.length > 1) {
          const key = team + '|' + line.objective;
          const speakers = shared.get(key);
          if (speakers?.some(m => Math.hypot(m.x - block.x, m.y - block.y) < 48 * scale)) {
            line.hidden = true;
            continue;
          }
          if (speakers) speakers.push(block);
          else shared.set(key, [block]);
        }
        const pic = wordPic(line.text, line.px * prefs.textScale, inkOf(line.col), ratio);
        block.width = Math.max(block.width, pic.w);
        if (block.height) block.height += 1 / ratio;
        line.top = block.height - pic.inkTop;
        block.height += pic.inkBottom - pic.inkTop;
      }
    }
    function fits(box, block) {
      const overlaps = other => box.left < other.right + gap && box.right + gap > other.left
        && box.top < other.bottom + gap && box.bottom + gap > other.top;
      if (bounds.some(overlaps)) return false;
      return !blocks.some(other => other !== block && box.left < other.x + other.r && box.right > other.x - other.r
        && box.top < other.y + other.r && box.bottom > other.y - other.r);
    }
    for (const block of blocks) {
      const { x, y, width, height, r } = block;
      let place;
      function tryAt(cx, top) {
        if (place) return;
        const left = Math.max(2, Math.min(vw - width - 2, cx - width / 2));
        top = Math.max(2, Math.min(vh - height - 2, top));
        const box = { left, right: left + width, top, bottom: top + height };
        if (fits(box, block)) place = box;
      }
      if (block.lines[0].tactic) block.top = y - r - gap - height;
      tryAt(x, block.top);
      const reach = width / 2 + r + gap;
      for (let row = 0; !place && row <= 4; row++) {
        const shift = row * (height + gap);
        for (const dx of [reach, -reach, 0]) {
          tryAt(x + dx, block.top + shift);
          tryAt(x + dx, y - r - gap - height - shift);
        }
      }
      if (!place) continue;
      bounds.push(place);
      const cx = (place.left + place.right) / 2;
      drawn.push({ m: block.marker, x: cx, y: place.top + height / 2, w: width, h: height });
      if (Math.abs(cx - x) > r || Math.abs(place.top - block.top) > r) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(Math.max(place.left, Math.min(x, place.right)), Math.max(place.top, Math.min(y, place.bottom)));
        ctx.lineWidth = Math.max(1, scale);
        ctx.strokeStyle = 'rgba(210,224,239,0.7)';
        ctx.stroke();
      }
      for (const line of block.lines) if (!line.hidden) write(line.text, line.px, cx, place.top + line.top, line.col, line.alpha);
    }
  }
  function drawMarker(m, strong, scale) {
    const kind = KINDS[m.c] || OTHER;
    const at = toScreen(m.cx, m.cy);
    const x = at[0], y = at[1];
    if (x < -150 || y < -150 || x > vw + 150 || y > vh + 150) return;
    // (people and bots all one size, unless Bigger me, bosses and friends is on: then each kind's own size, and the
    // one followed bigger again)
    const even = prefs.sizeByKind !== true && PEOPLE_OR_BOTS(m.c);
    const r = 8 * scale * (even ? 1 : kind.size * (strong ? 1.2 : 1));
    const col = m.c === 'Extract' && m.st !== undefined ? EXIT_COL[m.st] || kind.col
      : m.c === 'Transit' && m.st === 0 ? EXIT_COL[0]
      : m.c === 'Corpse' && prefs.corpseKind && m.was && KINDS[m.was] ? KINDS[m.was].col
      : teamColOf(m) || kind.col;
    // on another floor than the player: fainter, with an arrow up or down (an extract or a transit too, as loot is, and
    // the floor it's on named under it: an elevator's on the 3rd floor)
    const apart = m.c !== 'Main Player' && m.c !== 'BTR' && m.c !== 'Airdrop' ? otherFloor(m.cx, m.cy, m.cz) : 0;
    const away = apart !== 0;

    const bot = isMapBot(m, kind);
    const effects = replay && bot && m.pid && !prefs.hpNoEvents;
    const hop = effects && !m.gh && prefs.hpGestures !== false && modOn('COMET')
      ? markerHop(gestureTrack(replay, m.pid, chased === m.id), replay.at, r) : 0;
    if (hop > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(x, y, r * 0.8, r * 0.35, 0, 0, 2 * Math.PI);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fill();
      ctx.restore();
    }
    ctx.save();
    ctx.translate(x, y - hop);
    ctx.globalAlpha = away && !strong ? 0.6 : 1;
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1.5, r * 0.22);
    ctx.strokeStyle = edgeOf(col);
    ctx.fillStyle = col;
    ctx.beginPath();
    const brain = kind.shape === 'arrow' && (m.gh || hasDetails(m)) ? brainOf(m) : null;
    if (brain && brain.ghost) {
      // parked by ORBIT: a ghost, not an arrow (it has no body to face any way)
      ctx.globalAlpha *= 0.8;
      ctx.moveTo(-r * 0.8, r * 0.95);
      ctx.lineTo(-r * 0.8, -r * 0.15);
      ctx.arc(0, -r * 0.15, r * 0.8, Math.PI, 0);
      ctx.lineTo(r * 0.8, r * 0.95);
      ctx.lineTo(r * 0.4, r * 0.6);
      ctx.lineTo(0, r * 0.95);
      ctx.lineTo(-r * 0.4, r * 0.6);
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(-r * 0.3, -r * 0.2, r * 0.17, 0, Math.PI * 2);
      ctx.arc(r * 0.3, -r * 0.2, r * 0.17, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind.shape === 'arrow' && HIST && prefs.hpNoFacing) {
      // (a replay with Facing arrows off: a dot, which way it faces left out)
      ctx.arc(0, 0, r * 0.8, 0, Math.PI * 2);
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
    } else if (kind.shape === 'arrow') {
      // in a fight (SAIN deciding for it): a red ring round it
      if (brain && brain.fight) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(0, 0, r * 1.55, 0, Math.PI * 2);
        ctx.lineWidth = Math.max(1.5, r * 0.2);
        ctx.strokeStyle = '#ff3b30';
        ctx.stroke();
        ctx.restore();
        ctx.beginPath();
      }

      // headings are from the game's north, which the map may have turned
      ctx.rotate(((m.cr || 0) - turn) * RAD);
      // the shape picked (Settings > Markers): one for bots, one for you and your friends; each within the arrow's
      // reach (r × 1.25), where the health bar, team badge and name are put
      const shape = m.c === 'Main Player' || m.c === 'Friendly Player' ? prefs.meShape : prefs.botShape;
      if (shape === 'disc' || shape === 'dart') {
        // a dot a little behind the middle, and just ahead of it, the way it faces, an arrowhead with its tip rounded
        // off: a broad one (Circle with a pointer), or a slim dart with a deep notch (Circle with a dart)
        const dart = shape === 'dart', tip = -r * (dart ? 1.25 : 1.2), wing = r * (dart ? 0.5 : 0.64);
        const back = -r * (dart ? 0.3 : 0.32), notch = -r * (dart ? 0.58 : 0.5);
        ctx.arc(0, r * (dart ? 0.3 : 0.28), r * (dart ? 0.54 : 0.56), 0, Math.PI * 2);
        ctx.closePath();
        ctx.moveTo(-r * 0.12, tip + r * 0.16);
        ctx.quadraticCurveTo(0, tip - r * 0.04, r * 0.12, tip + r * 0.16);
        ctx.lineTo(wing, back);
        ctx.lineTo(0, notch);
        ctx.lineTo(-wing, back);
        ctx.closePath();
        if (!dart) ctx.lineWidth *= 1.15;
        ctx.stroke();
        ctx.fill();
      } else if (shape === 'drop') {
        // a drop: a round body, narrowing to a point the way it faces (the body a little behind the middle, so the
        // whole of it stays within the arrow's reach)
        const cy = r * 0.15, R = r * 0.8, tip = -r * 1.25, side = Math.acos(R / (cy - tip));
        ctx.lineJoin = 'round';
        ctx.moveTo(0, tip);
        ctx.arc(0, cy, R, -Math.PI / 2 + side, Math.PI * 1.5 - side);
        ctx.closePath();
        ctx.stroke();
        ctx.fill();
      } else if (shape === 'chevron') {
        // slim arms, tapering to a sharp point
        ctx.moveTo(0, -r * 1.25);
        ctx.lineTo(r * 0.95, r * 0.78);
        ctx.lineTo(r * 0.5, r * 0.95);
        ctx.lineTo(0, -r * 0.12);
        ctx.lineTo(-r * 0.5, r * 0.95);
        ctx.lineTo(-r * 0.95, r * 0.78);
        ctx.closePath();
        ctx.stroke();
        ctx.fill();
      } else if (shape === 'cone') {
        // a small dot, and the way it looks: a cone in its colour, fading out with distance
        const fade = ctx.createRadialGradient(0, 0, r * 0.3, 0, 0, r * 2.3);
        fade.addColorStop(0, seeThrough(ctx.fillStyle, 0.5));
        fade.addColorStop(1, seeThrough(ctx.fillStyle, 0));
        ctx.save();
        ctx.fillStyle = fade;
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, r * 2.3, -Math.PI / 2 - 0.48, -Math.PI / 2 + 0.48);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.52, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fill();
      } else if (shape === 'dot') {
        ctx.arc(0, 0, r * 0.52, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fill();
      } else {
        ctx.moveTo(0, -r * 1.25);
        ctx.lineTo(r * 0.85, r * 0.9);
        ctx.lineTo(0, r * 0.4);
        ctx.lineTo(-r * 0.85, r * 0.9);
        ctx.closePath();
        ctx.stroke();
        ctx.fill();
      }
    } else if (kind.shape === 'cross') {
      ctx.lineCap = 'round';
      ctx.moveTo(-r * 0.7, -r * 0.7); ctx.lineTo(r * 0.7, r * 0.7);
      ctx.moveTo(r * 0.7, -r * 0.7); ctx.lineTo(-r * 0.7, r * 0.7);
      ctx.lineWidth = r * 0.7;
      ctx.stroke();
      ctx.lineWidth = r * 0.36;
      ctx.strokeStyle = col;
      ctx.stroke();
    } else if (kind.shape === 'btr') {
      // from above: an armoured hull on eight wheels, its turret and gun pointing the way it drives; true to its
      // size once zoomed in, never smaller than a marker
      ctx.rotate(((m.cr || 0) - turn) * RAD);
      const len = Math.max(r * 3.2, 7.6 * zoom), wide = len * 0.38;
      ctx.fillStyle = '#111';
      for (const side of [-1, 1]) {
        for (let k = 0; k < 4; k++) {
          const y = -len * 0.36 + k * len * 0.22;
          ctx.fillRect(side * wide / 2 - (side > 0 ? 0 : wide * 0.16), y, wide * 0.16, len * 0.13);
        }
      }
      ctx.beginPath();
      ctx.moveTo(0, -len / 2);
      ctx.lineTo(wide / 2, -len * 0.34);
      ctx.lineTo(wide / 2, len / 2);
      ctx.lineTo(-wide / 2, len / 2);
      ctx.lineTo(-wide / 2, -len * 0.34);
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -len * 0.05);
      ctx.lineTo(0, -len * 0.62);
      ctx.lineWidth = Math.max(2, wide * 0.1);
      ctx.strokeStyle = '#111';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, -len * 0.05, wide * 0.3, 0, Math.PI * 2);
      ctx.fillStyle = '#6f8a3c';
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, r * 0.18);
      ctx.stroke();
    } else if (kind.shape === 'drop') {
      // a crate with its straps; under a parachute while it's coming down
      if (m.fall) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(0, -r * 1.5, r * 1.1, Math.PI, 0);
        ctx.closePath();
        ctx.moveTo(-r * 1.1, -r * 1.5); ctx.lineTo(-r * 0.6, -r * 0.7);
        ctx.moveTo(r * 1.1, -r * 1.5); ctx.lineTo(r * 0.6, -r * 0.7);
        ctx.fillStyle = '#f2f3f4';
        ctx.stroke();
        ctx.fill();
        ctx.restore();
        ctx.beginPath();
      }
      ctx.rect(-r * 0.8, -r * 0.7, r * 1.6, r * 1.4);
      ctx.stroke();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-r * 0.8, 0); ctx.lineTo(r * 0.8, 0);
      ctx.moveTo(0, -r * 0.7); ctx.lineTo(0, r * 0.7);
      ctx.lineWidth = Math.max(1, r * 0.14);
      ctx.stroke();
    } else if (kind.shape === 'transit') {
      // a round sign with an arrow on it, pointing on to the next map
      ctx.arc(0, 0, r * 0.85, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-r * 0.45, 0); ctx.lineTo(r * 0.4, 0);
      ctx.moveTo(r * 0.05, -r * 0.38); ctx.lineTo(r * 0.45, 0); ctx.lineTo(r * 0.05, r * 0.38);
      ctx.lineWidth = Math.max(1.5, r * 0.2);
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#0c0c12';
      ctx.stroke();
    } else if (kind.shape === 'exit') {
      ctx.rotate(45 * RAD);
      ctx.rect(-r * 0.75, -r * 0.75, r * 1.5, r * 1.5);
      ctx.stroke();
      ctx.fill();
    } else {
      ctx.arc(0, 0, r * 0.7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fill();
    }
    ctx.restore();

    // the health bar: under the marker, over its name (above it, the rings round the marker cover it)
    let under = 0;
    if (prefs.health && Array.isArray(m.hp) && m.hp[1] > 0 && kind.shape === 'arrow' && (strong || prefs.healthAll || m.hp[0] < m.hp[1] * 0.98)) {
      const part = Math.max(0, Math.min(1, m.hp[0] / m.hp[1])), wide = r * 2.4, high = Math.max(3, 3 * scale), top = y + r * 1.3;
      under = high + 4;
      ctx.save();
      ctx.globalAlpha = away && !strong ? 0.6 : 1;
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(x - wide / 2 - 1, top - 1, wide + 2, high + 2);
      ctx.fillStyle = part > 0.6 ? '#4cd964' : part > 0.3 ? '#ffb13d' : '#ff5148';
      ctx.fillRect(x - wide / 2, top, wide * part, high);
      ctx.restore();
    }
    if (away) write(apart > 0 ? '▲' : '▼', 9 * scale, x + r * 1.5, y - r * 0.9, col, strong ? 1 : 0.6);
    const person = m.c === 'Enemy Player' || m.c === 'Friendly Player';
    const named = bot ? strong || showBotName(prefs.names, m, kind) : kind.label || strong || (prefs.names === 'players' && person)
      || (m.c === 'Main Player' && (prefs.myName || live.some(o => o.c === 'Friendly Player')))
      || (prefs.names === 'all' && m.c !== 'Corpse' && m.c !== 'Main Player' && m.c !== 'Extract' && m.c !== 'Transit');
    const floorSays = away && (m.c === 'Extract' || m.c === 'Transit') ? floorSaid(m) : '';
    // (names and what they're doing each sized on top of Text size: Settings > Names, What they're doing)
    const namePx = 12 * scale * prefs.nameScale;
    const lines = [];
    const alpha = away && !strong ? 0.6 : 1;
    const top = y + r * 1.35 + under;
    if (named && (m.t || m.c === 'Transit')) {
      const text = markerText(m) + (floorSays ? ' · ' + floorSays : '');
      if (bot) lines.push({ text, px: namePx, col, alpha });
      else label(text, namePx, x, top, y - r * 1.35, col, alpha);
    }
    if (bot && (m.psc || prefs.mapDifficulty || prefs.mapPersonality)) {
      const details = [];
      if (m.psc) details.push(T('AI player scav'));
      if (prefs.mapDifficulty && m.df) details.push(DIFFICULTY[m.df] || m.df);
      if (prefs.mapPersonality && m.ps) details.push(m.ps);
      if (details.length) lines.push({ text: details.join(' · '), px: 10 * scale, col: m.psc ? '#9ff4c8' : '#e1e5ec', alpha });
    }
    if (bot && m.ch) {
      const d = Math.max(6, r * 0.72), bx = x + r + d * 0.65, by = y - r * 0.7;
      const icon = badge('!', '#ffc857', '#221a10', '#221a10', 'diamond', d * 1.85);
      const size = icon.width / pixelRatio();
      ctx.globalAlpha = away && !strong ? 0.65 : 1;
      ctx.drawImage(icon, bx - size / 2, by - size / 2, size, size);
      ctx.globalAlpha = 1;
      drawn.push({ m, x: bx, y: by, w: d * 2, h: d * 2 });
    }
    // what it's doing, under its name ("What each bot is doing"): as a mod has it, not the game's own brain
    if (prefs.mapDoing && brain && !inArea(m)) {
      const said = brain.by === 'EFT' ? '' : currentAction(m, brain, true);
      const context = mapContext(m, brain);
      if (said) lines.push({ text: said.length > 30 ? said.slice(0, 29) + '…' : said, px: 9.5 * scale * prefs.doingScale,
        col: brain.ghost ? '#c2c5ca' : DOING_COL[brain.by] || '#dadcdf', alpha,
        objective: brain.by === 'ORBIT' ? said : null });
      if (context && context !== said) lines.push({ text: context.length > 40 ? context.slice(0, 39) + '…' : context,
        px: 9 * scale * prefs.doingScale, col: '#b4d5df', alpha });
    }
    const role = m.sq;
    if (bot && !m.gh && role?.a && prefs.tacticWords !== false && modOn('COMET') && !squadOver(role)
        && role.u !== 'declined' && role.u !== 'interrupted') {
      lines.unshift({ tactic: true, text: tacticWord(role), px: 9.5 * scale, col: '#ffc56e', alpha });
    }
    if (lines.length && x >= 0 && x <= vw && y >= 0 && y <= vh) botLabels.push({ marker: m, id: m.id, x, y, r, top, width: 0, height: 0, lines,
      priority: m.id === chased ? 2 : m.id === rosterOver ? 1 : 0 });
    if (replay && bot && m.pid && prefs.hpGestures !== false && !prefs.hpNoEvents && !inArea(m) && modOn('COMET'))
      drawGestures(m, replay, x, y - r * 2.5 - 10 * scale, scale);
    if (bot && m.pid && (!replay || effects) && prefs.actionIcons !== false) {
      const calls = replay?.signals.voices.get(m.pid);
      const voice = replay ? (calls && calls[lastAt(calls, replay.at)]) : liveVoices.get(m.pid);
      if (voice && (replay ? replay.at : performance.now()) - voice.t < SHARE_MS) {
        const pic = actionPic('voice', ACTION_RADIUS * scale);
        ctx.drawImage(pic.c, x - pic.w - 6 * scale, y - hop - pic.w - 6 * scale, pic.w, pic.w);
        if (!replay) dirty = true;
      }
      const contacts = replay?.sightings.get(m.pid);
      const last = contacts ? lastAt(contacts, replay.at) : -1;
      if (replay ? last >= 0 && replay.at - contacts[last].t < SIGHT_MS : performance.now() < liveSightUntil.get(m.pid)) {
        const pic = actionPic('sight', ACTION_RADIUS * scale);
        ctx.drawImage(pic.c, x - pic.w / 2, y - hop - r * 1.6 - pic.w, pic.w, pic.w);
        if (!replay) dirty = true;
      }
    }
    drawn.push({ m, x, y: y - hop / 2, w: r * 2.6, h: r * 2.6 + hop });
  }

  // The arrow points from the reporting bot to the squadmate who accepted the contact.
  function drawSharedContacts(scale) {
    if (!prefs.actionIcons || (replay && (prefs.hpNoPeople || prefs.hpNoEvents))) return;
    const now = replay ? replay.at : performance.now();
    if (!replay && liveShares.length) liveShares = liveShares.filter(s => now - s.t < SHARE_MS);
    const shares = replay ? recentSignals(replay.signals.shares, now, SHARE_MS) : liveShares;
    if (!shares.length) return;
    const visible = new Map();
    for (const m of live) if (m.pid && m.c !== 'Corpse' && !isHidden(m.c) && !inArea(m)
      && Number.isFinite(m.cx) && !offFloor(m.cx, m.cy, m.cz)) visible.set(m.pid, m);
    const sent = new Set();
    ctx.save();
    ctx.strokeStyle = '#d4a2ff'; ctx.fillStyle = '#d4a2ff'; ctx.lineWidth = 2 * scale;
    for (const share of shares) {
      const from = visible.get(share.from), to = visible.get(share.to);
      if (!from || !to) continue;
      const [x, y] = toScreen(from.cx, from.cy), [tx, ty] = toScreen(to.cx, to.cy);
      const angle = Math.atan2(ty - y, tx - x), length = Math.hypot(tx - x, ty - y);
      if (length > 9 * scale) {
        const dx = Math.cos(angle), dy = Math.sin(angle), tipX = tx - dx * 6 * scale, tipY = ty - dy * 6 * scale;
        ctx.setLineDash([4 * scale, 3 * scale]); ctx.beginPath();
        ctx.moveTo(x, y); ctx.lineTo(tipX, tipY); ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - (dx * 7 + dy * 4) * scale, tipY - (dy * 7 - dx * 4) * scale);
        ctx.lineTo(tipX - (dx * 7 - dy * 4) * scale, tipY - (dy * 7 + dx * 4) * scale);
        ctx.closePath(); ctx.fill();
      }
      if (!sent.has(share.from)) {
        sent.add(share.from);
        const pic = actionPic('share', ACTION_RADIUS * scale);
        ctx.drawImage(pic.c, x + 6 * scale, y - pic.w - 6 * scale, pic.w, pic.w);
      }
    }
    ctx.restore();
    if (!replay) dirty = true;
  }

  // slanting stripes in a colour, to fill a shape with
  const stripes = {};
  // A minefield's mines, as small red crosses strewn over where it kills. Each cross has its own spot on the ground
  // (a grid of metres, nudged a little by where it is) and its own size in metres, so the same crosses stay put and
  // grow with the map as it zooms in (up to a point). Zoomed out they'd be a noisy speckle, so they fade in only once
  // they're big enough to read; until then the field is a plain red.
  function drawMines(g, area, kill, trace) {
    if (!area.box) {
      const all = kill.flat();
      area.box = all.length ? [Math.min(...all.map(p => p[0])), Math.min(...all.map(p => p[1])),
        Math.max(...all.map(p => p[0])), Math.max(...all.map(p => p[1]))] : null;
    }
    const box = area.box;
    if (!box) return;
    // half a cross, in pixels: 0.9 m on the ground
    const arm = Math.min(12, zoom * 0.9);
    const fade = Math.min(1, Math.max(0, (arm - 3) / 3));
    if (fade <= 0) return;
    let gap = 7;
    while ((box[2] - box[0]) / gap * ((box[3] - box[1]) / gap) > 5000) gap *= 2;
    const nudge = (x, y, k) => {
      const v = Math.sin(x * 12.9898 + y * 78.233 + k * 37.719) * 43758.5453;
      return (v - Math.floor(v) - 0.5) * 2.4;
    };
    g.save();
    g.globalAlpha = fade;
    trace(kill);
    g.clip('nonzero');
    g.beginPath();
    for (let gx = Math.floor(box[0] / gap) * gap; gx <= box[2]; gx += gap) {
      for (let gy = Math.floor(box[1] / gap) * gap; gy <= box[3]; gy += gap) {
        const s = toScreen(gx + nudge(gx, gy, 1), gy + nudge(gx, gy, 2));
        if (s[0] < -arm || s[1] < -arm || s[0] > vw + arm || s[1] > vh + arm) continue;
        g.moveTo(s[0] - arm, s[1] - arm); g.lineTo(s[0] + arm, s[1] + arm);
        g.moveTo(s[0] + arm, s[1] - arm); g.lineTo(s[0] - arm, s[1] + arm);
      }
    }
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(20,0,0,0.7)';
    g.lineWidth = arm * 0.32 + 1.5;
    g.stroke();
    g.strokeStyle = '#ff5a4e';
    g.lineWidth = arm * 0.32;
    g.stroke();
    g.restore();
  }
  // Stripes laid on the ground, so they zoom with the map instead of sliding over it: a whole number of metres apart
  // (doubled or halved as the map zooms, so they stay 10 to 20 pixels apart), from a spot on the ground.
  function groundStripes(pattern, pin) {
    if (!pattern.setTransform) return;
    const metres = Math.pow(2, Math.ceil(Math.log2(10 / zoom)));
    const k = metres * zoom / 12;
    pattern.setTransform(new DOMMatrix([k, 0, 0, k, pin[0], pin[1]]));
  }
  function striped(col) {
    if (!stripes[col]) {
      const tile = document.createElement('canvas');
      tile.width = tile.height = 12;
      const t = tile.getContext('2d');
      t.strokeStyle = col;
      t.lineWidth = 3;
      t.beginPath();
      for (const shift of [-12, 0, 12]) { t.moveTo(shift - 2, 14); t.lineTo(shift + 14, -2); }
      t.stroke();
      stripes[col] = ctx.createPattern(tile, 'repeat');
    }
    return stripes[col];
  }

  // Each field of claymores as one danger area: the ground within reach of any of its mines, striped red with a rim,
  // named in the middle. Drawn first, on the empty canvas (the rim is cut out of it).
  function drawMineFields(scale, edge) {
    const look = ZONES.mine;
    const reach = Math.max(3, MINE_REACH * zoom);
    const rim = Math.min(3, Math.max(1.5, 0.5 * zoom));
    const circles = (field, r) => {
      ctx.beginPath();
      for (const p of field.mines) {
        const s = toScreen(p[0], p[1]);
        ctx.moveTo(s[0] + r, s[1]);
        ctx.arc(s[0], s[1], r, 0, Math.PI * 2);
      }
    };
    for (const field of map.fields) {
      const mid = toScreen(field.x, field.y);
      const far = reach + MINE_TOGETHER * field.mines.length * zoom;
      if (mid[0] < -far || mid[1] < -far || mid[0] > vw + far || mid[1] > vh + far) continue;
      // the rim: the area a little wider, with the area itself cut out of it
      circles(field, reach + rim);
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = look.col;
      ctx.fill();
      ctx.globalCompositeOperation = 'destination-out';
      circles(field, reach);
      ctx.globalAlpha = 1;
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      // the area: a red tint under red stripes that lie still on the ground
      ctx.globalAlpha = 0.22;
      ctx.fill();
      const pattern = striped(look.col);
      groundStripes(pattern, mid);
      ctx.fillStyle = pattern;
      ctx.globalAlpha = 0.6;
      ctx.fill();
      ctx.globalAlpha = 1;
      // each mine, once close enough to tell them apart
      if (zoom > 2.5) {
        ctx.fillStyle = '#000';
        for (const p of field.mines) {
          const s = toScreen(p[0], p[1]);
          ctx.beginPath();
          ctx.arc(s[0], s[1], Math.max(2, 0.35 * zoom), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      const px = 11 * scale;
      if (mid[0] > edge.left && mid[0] < edge.right && mid[1] > edge.top && mid[1] < edge.bottom) {
        write(look.label, px, mid[0], mid[1] - px * 0.55, look.col, 0.95);
      }
    }
  }

  // Minefields and sniper zones, each area of overlapping zones as one: the whole of it, where the game warns, faint
  // with a dashed rim; the part where it kills stronger, with a rim of its own. Drawn on a canvas of their own, so
  // the lines inside an area (where its zones overlap) can be cut out and only its outline is left.
  let zoneCanvas = null;
  function drawZones(scale) {
    const ratio = pixelRatio();
    if (!zoneCanvas) zoneCanvas = document.createElement('canvas');
    if (zoneCanvas.width !== canvas.width || zoneCanvas.height !== canvas.height) {
      zoneCanvas.width = canvas.width;
      zoneCanvas.height = canvas.height;
    }
    const g = zoneCanvas.getContext('2d');
    const trace = loops => {
      g.beginPath();
      for (const loop of loops) {
        loop.forEach((p, i) => {
          const s = toScreen(p[0], p[1]);
          if (i) g.lineTo(s[0], s[1]); else g.moveTo(s[0], s[1]);
        });
        g.closePath();
      }
    };
    // a rim round the outside of a path only: stroked, then everything inside the path taken away again
    const rim = (col, width, dash) => {
      g.globalCompositeOperation = 'source-over';
      g.setLineDash(dash || []);
      g.strokeStyle = col;
      g.lineWidth = width * 2;
      g.globalAlpha = 0.95;
      g.stroke();
      g.setLineDash([]);
      g.globalCompositeOperation = 'destination-out';
      g.globalAlpha = 1;
      g.fill('nonzero');
      g.globalCompositeOperation = 'source-over';
    };

    ctx.save();
    // nothing of a zone is drawn past the picture's edge
    const edge = mapBox();
    ctx.beginPath();
    ctx.rect(edge.left, edge.top, edge.right - edge.left, edge.bottom - edge.top);
    ctx.clip();
    ctx.lineJoin = 'round';
    if (!isHidden('Zone mine')) drawMineFields(scale, edge);
    const px = 11 * scale;
    for (const area of map.zones) {
      const look = ZONES[area.k];
      if (!look || isHidden('Zone ' + area.k)) continue;
      // only what's on the screen
      let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
      for (const z of area.zones) {
        for (const p of z.p) {
          const s = toScreen(p[0], p[1]);
          left = Math.min(left, s[0]); right = Math.max(right, s[0]);
          top = Math.min(top, s[1]); bottom = Math.max(bottom, s[1]);
        }
      }
      if (right < 0 || bottom < 0 || left > vw || top > vh) continue;
      g.setTransform(ratio, 0, 0, ratio, 0, 0);
      g.clearRect(0, 0, vw, vh);
      g.lineJoin = 'round';
      // a sniper the flare at an extract keeps quiet: lighter, its rim thinner (solid: dashes crawl as the map zooms)
      const soft = area.flare;
      // the whole zone: a sniper who has started on you fires anywhere in it; a mine only goes off where it kills
      const kill = area.zones.flatMap(z => z.kill);
      if (area.k === 'mine' && !kill.length) continue;
      if (area.k !== 'mine') {
        trace(area.zones.map(z => z.p));
        rim(look.col, 1, null);
        g.fillStyle = look.col;
        g.globalAlpha = soft ? 0.05 : 0.08;
        g.fill('nonzero');
        g.globalAlpha = 1;
      }
      trace(kill);
      rim(look.col, soft ? 1.2 : 1.6, null);
      if (look.hatch) {
        // the stripes lie still on the ground as the map moves
        const pin = toScreen(area.x, area.y);
        const pattern = striped(look.col, g);
        groundStripes(pattern, pin);
        g.fillStyle = pattern;
        g.globalAlpha = soft ? 0.3 : 0.55;
      } else {
        g.fillStyle = look.col;
        g.globalAlpha = 0.22;
      }
      g.fill('nonzero');
      g.globalAlpha = 1;
      // its name: in the middle of where it kills, or the nearest spot to that inside it (an area of zones that
      // overlap can have its middle outside all of them)
      let mid = toScreen(area.x, area.y);
      // (worked out again only when the zoom or the turn changes: it tries the shape at a few hundred spots)
      const labelKey = turn + '|' + Math.round(Math.log2(zoom) * 4);
      if (kill.length && area.labelAt && area.labelAt.key === labelKey) mid = toScreen(area.labelAt.x, area.labelAt.y);
      else if (kill.length) {
        trace(kill);
        const inside = (x, y) => g.isPointInPath(x * ratio, y * ratio, 'nonzero');
        if (!inside(mid[0], mid[1])) {
          let best = null;
          for (let r = 12; r <= 400 && !best; r += 12) {
            for (let a = 0; a < 16 && !best; a++) {
              const x = mid[0] + r * Math.cos(a * Math.PI / 8), y = mid[1] + r * Math.sin(a * Math.PI / 8);
              if (!inside(x, y)) continue;
              // on along the same way to the field's far side, and the label halfway across
              let far = r;
              while (far < r + 300 && inside(mid[0] + (far + 6) * Math.cos(a * Math.PI / 8), mid[1] + (far + 6) * Math.sin(a * Math.PI / 8))) far += 6;
              const half = (r + far) / 2;
              best = [mid[0] + half * Math.cos(a * Math.PI / 8), mid[1] + half * Math.sin(a * Math.PI / 8)];
            }
          }
          if (best) mid = best;
        }
        const at = toMap(mid[0], mid[1]);
        area.labelAt = { key: labelKey, x: at[0], y: at[1] };
      }
      if (area.k === 'mine') drawMines(g, area, kill, trace);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(zoneCanvas, 0, 0);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      if (mid[0] > edge.left && mid[0] < edge.right && mid[1] > edge.top && mid[1] < edge.bottom) {
        write(look.label + (soft ? ' · ' + T('flare') : ''), px, mid[0], mid[1] - px * 0.55, look.col, 0.95);
      }
    }
    ctx.restore();
  }

  // the scale, bottom left: a round number of metres and a bar as long as they are on the screen now
  let scalePrint = '';
  function showScale() {
    const bar = $('scaleBar');
    const want = map && zoom > 0 ? 120 / zoom : 0;
    let print = '';
    if (want > 0) {
      const pow = Math.pow(10, Math.floor(Math.log10(want)));
      const nice = [5, 2, 1].map(k => k * pow).find(v => v <= want) || pow;
      print = nice + ':' + Math.round(nice * zoom);
    }
    if (print === scalePrint) return;
    scalePrint = print;
    bar.hidden = !print;
    if (!print) return;
    const [nice, px] = print.split(':').map(Number);
    bar.style.width = px + 'px';
    bar.textContent = nice >= 1000 ? nice / 1000 + ' km' : nice + ' m';
  }

  // Who matters and is off the screen: an arrow at the edge of what can be seen of the map (clear of the bar, the
  // menu and the Raid list) points to each, in its kind's colour, with how far it is from the player. It can be
  // pointed at and pressed like the marker itself.
  // the kinds that have one unless picked otherwise (prefs.edgeKinds), and every kind that can
  const EDGE = ['Enemy Player', 'Friendly Player', 'Boss', 'Goon', 'Airdrop'];
  if (!Array.isArray(prefs.edgeKinds)) prefs.edgeKinds = EDGE.slice();
  // What's seen of the map: the screen inside the bar (and on a phone the menu over it), less the menu and the Raid
  // list where they stand over it. Those are only as tall as what's in them: below a short Raid list the map is seen
  // right to the screen's side, and arrows go there (covers: the panels, as boxes on the screen).
  function seen() {
    const bare = document.body.classList.contains('bare');
    const covers = [];
    if (!bare && !phone.matches) {
      for (const el of [$('panel'), $('side')]) {
        if (el.hidden || !el.offsetWidth) continue;
        const b = el.getBoundingClientRect();
        covers.push({ l: b.left - 8, t: b.top - 8, r: b.right + 8, b: b.bottom + 8 });
      }
    }
    return { l: 8, t: bare ? 8 : 50, r: vw - (phone.matches ? cover.r : 0) - 8, b: vh - (phone.matches ? cover.b : 0) - 8, covers };
  }
  const covered = (box, x, y, pad = 0) => box.covers.some(c => x > c.l - pad && x < c.r + pad && y > c.t - pad && y < c.b + pad);
  const inSight = (box, at) => at[0] >= box.l && at[0] <= box.r && at[1] >= box.t && at[1] <= box.b && !covered(box, at[0], at[1]);
  // Where an arrow to something off the map seen goes: on the line from the middle of what's seen to it, where that
  // line leaves the screen; or, when that's under a panel, where it reaches the panel's side.
  function edgeAt(box, at, pad) {
    // the middle of what's seen: the screen's, less the panels standing at its sides from top to bottom
    let l = box.l, r = box.r;
    for (const c of box.covers) {
      if (c.l <= box.l + 8 && c.r < box.r) l = Math.max(l, c.r);
      else if (c.r >= box.r - 8 && c.l > box.l) r = Math.min(r, c.l);
    }
    const cx = (l + r) / 2, cy = (box.t + box.b) / 2, dx = at[0] - cx, dy = at[1] - cy;
    const reach = (left, top, right, bottom) => {
      const kx = dx > 0 ? (right - cx) / dx : dx < 0 ? (left - cx) / dx : Infinity;
      const ky = dy > 0 ? (bottom - cy) / dy : dy < 0 ? (top - cy) / dy : Infinity;
      const k = Math.max(0, Math.min(kx, ky));
      return [cx + dx * k, cy + dy * k];
    };
    let p = reach(box.l + pad, box.t + pad, box.r - pad, box.b - pad);
    if (covered(box, p[0], p[1], pad)) p = reach(l + pad, box.t + pad, r - pad, box.b - pad);
    return [p[0], p[1], Math.atan2(dy, dx)];
  }
  // Where COMET sends the bots of a squad acting together: a dashed line from each to its place, amber once it's
  // doing it and pale while it only means to. Faint for all that are doing it; plain, and with the ones still
  // preparing, for the squad of whoever is pointed at, followed, or under the pointer in the Raid list.
  // ---- rough areas ----
  // Between showing where a PMC is and not showing them at all ("Rough area, not the exact place", under Enemy PMCs):
  // no marker, name, pointer or line; only a circle AREA_R metres across its middle that the PMC is somewhere in.
  // The circle's middle is not the PMC (it's put off to one side at random) and stays put until they near its edge,
  // so it can't be followed to them. It shows only for one that has been moving: it fades over AREA_FADE once they
  // stop, so somebody sitting still isn't given away. (The page still gets where they are; it only doesn't draw it.)
  const AREA_STEP = 4, AREA_FADE = 30000;
  const areas = new Map();
  // ---- bodies come across ----
  // A body the player has been right by (to look at it, or to loot it) is known to be dead, like one a player killed:
  // its ✕ is shown without "All corpses", and the Raid list says Dead of it while it hides who's alive. Kept for the
  // raid, in this browser tab. (Only while a page is open: a body passed with no page open isn't noticed.)
  const BODY_NEAR = 7;
  // ---- under the ground ----
  // The map's "buildings" are every roofed place, bunkers and tunnels under the ground among them, and nothing says
  // which is which. One is taken to be under the ground when things known to be in the open lie well over its top,
  // within its walls: spawn points, containers, extracts, where loot can spawn (two or more of them), or anybody
  // seen walking there this visit.
  const UNDER_BY = 1.5;
  const topOf = b => b.top === undefined ? (b.top = Math.max(...b.parts.map(p => p.t))) : b.top;
  const overIt = (b, x, y, z) => Number.isFinite(z) && z > topOf(b) + UNDER_BY && inBox(b.box, x, y) && inLoops(b.l, x, y);
  function underOf(b) {
    const shown = places && map && sameMap(places.loc, map.loc) ? places : null, table = lootTable && map && sameMap(lootTable.loc, map.loc) ? lootTable : null;
    const key = (shown ? 1 : 0) + ':' + (table ? table.points.length : 0);
    if (b.underKey !== key) {
      b.underKey = key;
      let n = 0;
      if (shown) for (const list of [shown.spawns, shown.boxes, shown.exits]) for (const o of list || []) if (Array.isArray(o.p) && overIt(b, o.p[0], o.p[1], o.p[2])) n++;
      if (table) for (const pt of table.points) if (overIt(b, pt.x, pt.y, pt.z)) n++;
      b.underSaid = n >= 2;
    }
    return b.underSaid || !!b.underSeen;
  }
  function trackUnder() {
    const list = map && map.floors && map.floors.buildings;
    if (!list || !inRaidHere()) return;
    for (const m of live) {
      if (m.c === 'Corpse' || !Array.isArray(m.p) || (KINDS[m.c] || OTHER).shape !== 'arrow') continue;
      for (const b of list) if (!b.underSeen && overIt(b, m.p[0], m.p[1], m.p[2])) { b.underSeen = true; dirty = true; }
    }
  }
  let seenBodies = new Set(), seenBodiesFor = null;
  const bodyKey = m => m.pid || (m.body && m.body.pid) || String(m.id);
  const bodySeen = m => prefs.seenDead !== false && seenBodies.has(bodyKey(m));
  function trackBodies() {
    if (!me || !inRaidHere()) return;
    const rid = report.rid || '';
    if (rid !== seenBodiesFor) {
      seenBodiesFor = rid;
      seenBodies = new Set();
      try { seenBodies = new Set(JSON.parse(sessionStorage.getItem('fumsBodies:' + rid) || '[]')); } catch (e) { /* none kept */ }
    }
    let added = false;
    const look = (key, p) => {
      if (!key || seenBodies.has(key) || !Array.isArray(p)) return;
      if (Math.hypot(p[0] - me.cx, p[1] - me.cy) > BODY_NEAR || Math.abs((p[2] || 0) - (me.cz || 0)) > 3.5) return;
      seenBodies.add(key);
      added = true;
    };
    for (const m of live) if (m.c === 'Corpse') look(bodyKey(m), m.p);
    if (things && Array.isArray(things.bodies)) for (const b of things.bodies) look(b.pid || 'body:' + b.id, b.p);
    if (!added) return;
    try { sessionStorage.setItem('fumsBodies:' + rid, JSON.stringify([...seenBodies])); } catch (e) { /* private window */ }
    rosterPrint = null;
    dirty = true;
  }
  const inArea = m => prefs.areaKinds.includes(m.c);
  function trackAreas(now) {
    const seen = new Set(), AREA_R = prefs.areaR;
    for (const m of live) {
      if (!inArea(m) || m.gh) continue;
      seen.add(m.id);
      let a = areas.get(m.id);
      if (!a) areas.set(m.id, a = { x: null, y: 0, lx: m.p[0], ly: m.p[1], moved: -1e9 });
      a.c = m.c;
      if (Math.hypot(m.p[0] - a.lx, m.p[1] - a.ly) > AREA_STEP) { a.lx = m.p[0]; a.ly = m.p[1]; a.moved = now; }
      // Never on it: the circle is put somewhere round it, and stays put while it moves about inside, until it's three
      // quarters of the way out. Where in the circle it is is even all over (the square root: as likely near the rim
      // as near the middle), so the middle doesn't give it away.
      if (a.x === null || Math.hypot(m.p[0] - a.x, m.p[1] - a.y) > AREA_R * 0.75) {
        const turn = Math.random() * Math.PI * 2, off = Math.sqrt(Math.random()) * AREA_R * 0.7;
        a.x = m.p[0] + Math.cos(turn) * off;
        a.y = m.p[1] + Math.sin(turn) * off;
      }
    }
    for (const id of areas.keys()) if (!seen.has(id)) areas.delete(id);
  }
  function drawAreas(scale) {
    if (!prefs.areaKinds.length) return;
    const now = performance.now(), AREA_R = prefs.areaR;
    for (const a of areas.values()) {
      const age = now - a.moved;
      if (a.x === null || age >= AREA_FADE || !prefs.areaKinds.includes(a.c) || isHidden(a.c)) continue;
      const col = inkOf((KINDS[a.c] || OTHER).col);
      const s = toScreen(a.x, a.y), r = AREA_R * zoom;
      if (s[0] < -r || s[1] < -r || s[0] > vw + r || s[1] > vh + r) continue;
      const strength = Math.min(1, 1.25 - age / AREA_FADE);
      ctx.save();
      ctx.beginPath();
      ctx.arc(s[0], s[1], r, 0, Math.PI * 2);
      ctx.globalAlpha = strength * 0.13;
      ctx.fillStyle = col;
      ctx.fill();
      ctx.globalAlpha = strength;
      ctx.setLineDash([8 * scale, 6 * scale]);
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = col;
      ctx.stroke();
      ctx.restore();
      write(T('{kind} about', { kind: ONE[a.c] || a.c }), 11 * scale, s[0], s[1] - 6 * scale, col, strength * 0.9);
      dirty = dirty || age > AREA_FADE * 0.25;
    }
  }

  // Where ORBIT has a bot heading ("og" on its marker): a thin blue line to the place, and a circle there. For the
  // one pointed at, followed or under the pointer in the Raid list; for every bot with "Lines to where all are heading".
  function drawHeadings(scale) {
    drawGhostEvents(scale);
    const focus = [pointed, rosterOver, chased];
    let labelled;
    for (const m of live) {
      if (!(m.os ? prefs.botDetails : modOn('ORBIT'))) continue;
      if (!Array.isArray(m.og) || m.c === 'Corpse' || inArea(m) || isHidden(m.c || 'None') || !Number.isFinite(m.cx)) continue;
      const strong = focus.includes(m.id);
      const tactical = orbitTacticalOrder(m);
      if (!strong && !prefs.orbitLines && !tactical) continue;
      if (tactical && (offFloor(m.cx, m.cy, m.cz) || offFloor(m.og[0], m.og[1], m.og[2]))) continue;
      const team = tactical && orbitSquadOf(m.pid);
      const tint = team && Number.isInteger(team.SquadId) && team.SquadId >= 0 ? squadCol(team.SquadId + 1) : '#6fbcff';
      const a = toScreen(m.cx, m.cy), b = toScreen(m.og[0], m.og[1]);
      if (!tactical && Math.hypot(a[0] - b[0], a[1] - b[1]) < 14 * scale) continue;
      const r = Math.max(5 * scale, 4 * zoom);
      ctx.save();
      ctx.globalAlpha = strong ? 1 : tactical ? .8 : .5;
      ctx.lineCap = 'round';
      ctx.setLineDash([2 * scale, 6 * scale]);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.lineWidth = strong ? 4 : 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.stroke();
      ctx.lineWidth = strong ? 2 : 1.3;
      ctx.strokeStyle = tint;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(b[0], b[1], r, 0, Math.PI * 2);
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.stroke();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = tint;
      ctx.stroke();
      ctx.fillStyle = 'rgba(111, 188, 255, 0.18)';
      ctx.fill();
      ctx.restore();
      if (tactical) {
        const action = m.ob.split(/\s*[:(]/, 1)[0].trim(), key = (team ? 's' + team.SquadId : 'b' + m.id) + '/' + action;
        if (strong || !labelled?.has(key)) {
          (labelled ??= new Set()).add(key);
          const caption = (team ? T('Squad {n}', { n: team.SquadId }) : m.t || m.c) + ' · ' + (strong || prefs.orbitNames ? m.ob : spaced(action));
          write(caption, 10 * scale, b[0], b[1] + r + 3 * scale, tint, strong ? .95 : .85);
        }
      } else if ((strong || prefs.orbitNames) && m.ob)
        write(m.ob, 10 * scale, b[0], b[1] + r + 3 * scale, '#9fd8ff', strong ? .95 : .7);
    }
  }

  // ---- shots ----
  // Each bullet ("sh" on a report: [the shooter's marker, east, north, east, north]): a thin line from the gun to
  // where it went, for SHOT_MS, in the shooter's colour.
  const SHOT_MS = 900;
  let tracers = [];
  function takeShots(list, now) {
    if (!Array.isArray(list)) return;
    if (prefs.shots || prefs.hitFlash !== false) for (const s of list) {
      if (!Array.isArray(s) || s.length < 5) continue;
      tracers.push({ who: s[0], a: [s[1], s[2]], b: [s[3], s[4]], at: now });
      // (a sixth: the marker of whoever it hit)
      if (s[5] && !replaySeeking) hitFlashes.push({ id: s[5], at: now });
    }
    if (hitFlashes.length > 60) hitFlashes.splice(0, hitFlashes.length - 60);
    // a grenade going off (its fragments, all from one spot): a burst there, and an arc to it from the thrower
    if (!replaySeeking && !replay?.scan?.done && prefs.grenades !== false) {
      for (const b of blastsOf(list, id => { const m = liveById.get(id); return m && Number.isFinite(m.cx) ? [m.cx, m.cy] : null; })) {
        const thrower = b.who ? liveById.get(b.who) : null;
        const inferred = { x: b.x, y: b.y, t: replay ? replay.at : now, pid: thrower?.pid, fx: thrower?.cx, fy: thrower?.cy };
        if (!blastMarks.some(mark => mark.confirmed && sameBurst(mark, inferred))) blastMarks.push(inferred);
      }
      if (blastMarks.length > 30) blastMarks.splice(0, blastMarks.length - 30);
    }
    if (tracers.length > 400) tracers.splice(0, tracers.length - 400);
    dirty = true;
  }
  function drawShots() {
    if (!tracers.length) return;
    const now = performance.now();
    tracers = tracers.filter(t => now - t.at < SHOT_MS);
    if (!prefs.shots) { tracers = []; return; }
    ctx.save();
    ctx.lineCap = 'round';
    for (const t of tracers) {
      const m = t.who ? liveById.get(t.who) : null;
      // a shooter not on the page (not known yet, or kept off it): no line to give them away
      if (!m || isHidden(m.c || 'None') || inArea(m)) continue;
      const a = toScreen(t.a[0], t.a[1]), b = toScreen(t.b[0], t.b[1]);
      ctx.globalAlpha = 0.85 * (1 - (now - t.at) / SHOT_MS);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.lineWidth = 2.6;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.stroke();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = m ? inkOf((KINDS[m.c] || OTHER).col) : '#ffe9a8';
      ctx.stroke();
    }
    ctx.restore();
    if (tracers.length) dirty = true;
  }
  // ---- the airdrop's plane ----
  // "plane" on a full report: where it is, its heading and the way it has come. Shown with the airdrops.
  let plane = null, planeV = null, planeAt = 0;
  function drawPlane(scale) {
    if (!plane || !Array.isArray(plane.p) || isHidden('Airdrop')) return;
    const path = plane.path || [];
    // where it is by now: on from where it was last told to be, at the speed it had, for a second and a half at most
    const flown = Math.min(1.5, (performance.now() - planeAt) / 1000);
    const pos = planeV ? [plane.p[0] + planeV[0] * flown, plane.p[1] + planeV[1] * flown] : plane.p;
    dirty = true;
    ctx.save();
    ctx.lineJoin = 'round';
    if (path.length >= 4) {
      ctx.beginPath();
      for (let k = 0; k + 1 < path.length; k += 2) {
        const s = toScreen(path[k], path[k + 1]);
        if (k) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]);
      }
      const end = toScreen(pos[0], pos[1]);
      ctx.lineTo(end[0], end[1]);
      ctx.setLineDash([10 * scale, 7 * scale]);
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.stroke();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = '#f2f3f4';
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const at = toScreen(pos[0], pos[1]), r = 11 * scale;
    ctx.translate(at[0], at[1]);
    ctx.rotate(((plane.r || 0) - turn) * RAD);
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.3);
    ctx.lineTo(r * 0.28, -r * 0.3);
    ctx.lineTo(r * 1.25, r * 0.35);
    ctx.lineTo(r * 0.28, r * 0.25);
    ctx.lineTo(r * 0.2, r * 0.95);
    ctx.lineTo(r * 0.6, r * 1.3);
    ctx.lineTo(-r * 0.6, r * 1.3);
    ctx.lineTo(-r * 0.2, r * 0.95);
    ctx.lineTo(-r * 0.28, r * 0.25);
    ctx.lineTo(-r * 1.25, r * 0.35);
    ctx.lineTo(-r * 0.28, -r * 0.3);
    ctx.closePath();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#000';
    ctx.stroke();
    ctx.fillStyle = '#f2f3f4';
    ctx.fill();
    ctx.restore();
    write(T('Airdrop plane'), 10 * scale, at[0], at[1] + r * 1.6, '#f2f3f4', 0.95);
  }
  // ---- what ORBIT's ghosts do ----
  // A fight ORBIT worked out between ghosts: crossed marks where it was, for FIGHT_MS. What a ghost heard: a ring
  // as wide as it hears, round where it was, and a line to the noise, for HEAR_MS.
  const FIGHT_MS = 30000, HEAR_MS = 5000;
  let ghostMarks = [];
  function drawGhostEvents(scale) {
    if (!ghostMarks.length) return;
    const now = performance.now();
    ghostMarks = ghostMarks.filter(g => now < g.until);
    if (!modOn('ORBIT')) return;
    for (const g of ghostMarks) {
      // each has its switch: the fights, and the (big) circles of what a ghost could hear
      if (g.k === 'fight' ? prefs.orbitFights === false : !prefs.orbitHear) continue;
      const left = Math.min(1, (g.until - now) / 1500);
      ctx.save();
      ctx.globalAlpha = left;
      if (g.k === 'fight') {
        const a = toScreen(g.a[0], g.a[1]), b = toScreen(g.b[0], g.b[1]), mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, r = 9 * scale;
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.setLineDash([3 * scale, 5 * scale]);
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#ff8d84';
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(mx, my, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(214, 58, 50, 0.85)';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#000';
        ctx.stroke();
        ctx.restore();
        write('⚔', 12 * scale, mx, my - 7 * scale, '#fff', left);
        write(T('Ghost fight') + (g.n ? ' · ' + T('{n} dead', { n: g.n }) : ''), 10 * scale, mx, my + r + 2 * scale, '#ff8d84', left);
        continue;
      }
      const l = toScreen(g.l[0], g.l[1]), s = toScreen(g.s[0], g.s[1]);
      ctx.beginPath();
      ctx.arc(l[0], l[1], Math.max(6 * scale, g.r * zoom), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(111, 188, 255, 0.06)';
      ctx.fill();
      ctx.lineWidth = 1.3;
      ctx.strokeStyle = 'rgba(111, 188, 255, 0.8)';
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(l[0], l[1]);
      ctx.lineTo(s[0], s[1]);
      ctx.setLineDash([2 * scale, 5 * scale]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(s[0], s[1], 3.5 * scale, 0, Math.PI * 2);
      ctx.fillStyle = '#ffe9a8';
      ctx.fill();
      ctx.restore();
      write(T('Heard shots'), 9 * scale, l[0], l[1] + 7 * scale, '#9fd8ff', left * 0.9);
      // going to look: an ear by it
      if (g.inv) {
        ctx.save();
        ctx.globalAlpha = left;
        ctx.font = Math.round(15 * scale) + 'px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('👂', l[0] + 12 * scale, l[1] - 12 * scale);
        ctx.restore();
      }
    }
    dirty = true;
  }

  function drawSquads(scale) {
    if (!modOn('COMET')) return;
    const focus = new Set();
    for (const id of [pointed, rosterOver, chased]) {
      const m = id !== null && id !== undefined ? liveById.get(id) : null;
      if (m && m.sq) focus.add(squadKey(m));
    }
    for (const m of live) {
      const q = m.sq;
      if (!q || !Array.isArray(q.g) || m.gh || m.c === 'Corpse' || inArea(m) || isHidden(m.c || 'None') || !Number.isFinite(m.cx)) continue;
      const strong = focus.has(squadKey(m));
      if (!strong && !q.a) continue;
      const a = toScreen(m.cx, m.cy), b = toScreen(q.g[0], q.g[1]);
      const r = (strong ? 5 : 4) * scale;
      ctx.save();
      ctx.globalAlpha = strong ? 1 : 0.6;
      ctx.lineCap = 'round';
      ctx.setLineDash([6 * scale, 5 * scale]);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.lineWidth = strong ? 4.5 : 3.5;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.stroke();
      ctx.lineWidth = strong ? 2 : 1.5;
      ctx.strokeStyle = q.a ? '#ffb13d' : '#ffe2a8';
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(b[0], b[1] - r);
      ctx.lineTo(b[0] + r, b[1]);
      ctx.lineTo(b[0], b[1] + r);
      ctx.lineTo(b[0] - r, b[1]);
      ctx.closePath();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.stroke();
      ctx.fillStyle = q.a ? '#ffb13d' : '#ffe2a8';
      ctx.fill();
      ctx.restore();
      // its part in it, at the place it's sent to
      if (strong && prefs.squadParts) label(squadPart(q), 11 * scale * prefs.doingScale, b[0], b[1] + r + 3, b[1] - r - 3, q.a ? '#ffb13d' : '#ffe2a8');
    }
  }

  function drawEdge(scale) {
    const box = seen();
    if (box.r - box.l < 120 || box.b - box.t < 120) return;
    const pad = 16 * scale;
    // The player's quests: off the screen, the quest's own sign at the edge (a yellow star in a round badge, not an
    // arrow, so it isn't taken for a player), with a small tip on the edge's side showing which way.
    if (prefs.edgeQuests && inRaidHere()) {
      const col = LAYERS.quest.col, r = 7.5 * scale;
      for (const q of questOff) {
        const at = toScreen(q.p[0], q.p[1]);
        if (inSight(box, at)) continue;
        const [x, y, turn] = edgeAt(box, at, pad);
        ctx.save();
        ctx.translate(x, y);
        ctx.lineJoin = 'round';
        // the tip, pointing out past the edge
        ctx.save();
        ctx.rotate(turn);
        ctx.beginPath();
        ctx.moveTo(r * 1.75, 0);
        ctx.lineTo(r * 0.7, -r * 0.62);
        ctx.lineTo(r * 0.7, r * 0.62);
        ctx.closePath();
        ctx.lineWidth = Math.max(2, r * 0.3);
        ctx.strokeStyle = '#000';
        ctx.stroke();
        ctx.fillStyle = col;
        ctx.fill();
        ctx.restore();
        // the badge, with the star in it
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fillStyle = '#14151b';
        ctx.fill();
        ctx.lineWidth = Math.max(1.5, r * 0.26);
        ctx.strokeStyle = col;
        ctx.stroke();
        ctx.fillStyle = col;
        const k = r * 1.5 / 24;
        ctx.translate(-12 * k, -12 * k);
        ctx.scale(k, k);
        ctx.fill(new Path2D(ICONS.star[0][0]));
        ctx.restore();
        const far = me ? Math.hypot(q.p[0] - me.cx, q.p[1] - me.cy) : NaN;
        if (Number.isFinite(far)) {
          // on the inner side, clear of the badge however long the number is
          const said = far >= 1000 ? (far / 1000).toFixed(1) + ' km' : Math.round(far) + ' m', px = 10 * scale;
          ctx.font = 'bold ' + px * prefs.textScale + 'px ' + FONT;
          const half = ctx.measureText(said).width / 2 + 4;
          const tx = x - Math.cos(turn) * (r * 1.4 + half), ty = y - Math.sin(turn) * (r * 1.4 + px * 0.9);
          write(said, px, tx, ty - px * 0.55, col, 1);
        }
        thingsDrawn.push({ x, y, r: r * 1.6, tip: { title: q.t, lines: [T('One of your quests, off the screen')] } });
      }
    }
    // The extracts shown on the map (yours only, unless Mine only is off), off the screen: the extract's own diamond
    // at the edge, in its colour (open, wants something first, closed), with a tip showing which way and how far.
    if (prefs.edgeExits !== false && inRaidHere() && !isHidden('Extract')) {
      const r = 6.5 * scale;
      for (const m of live) {
        if (m.c !== 'Extract' || !Number.isFinite(m.cx) || (m.st === 0 && !prefs.goneExits)) continue;
        const at = toScreen(m.cx, m.cy);
        if (inSight(box, at)) continue;
        const [x, y, turn] = edgeAt(box, at, pad);
        const col = m.st !== undefined ? EXIT_COL[m.st] || KINDS.Extract.col : KINDS.Extract.col;
        ctx.save();
        ctx.translate(x, y);
        ctx.lineJoin = 'round';
        ctx.save();
        ctx.rotate(turn);
        ctx.beginPath();
        ctx.moveTo(r * 1.9, 0);
        ctx.lineTo(r * 0.8, -r * 0.62);
        ctx.lineTo(r * 0.8, r * 0.62);
        ctx.closePath();
        ctx.lineWidth = Math.max(2, r * 0.3);
        ctx.strokeStyle = '#000';
        ctx.stroke();
        ctx.fillStyle = col;
        ctx.fill();
        ctx.restore();
        ctx.rotate(Math.PI / 4);
        ctx.beginPath();
        ctx.rect(-r * 0.8, -r * 0.8, r * 1.6, r * 1.6);
        ctx.lineWidth = Math.max(1.5, r * 0.3);
        ctx.strokeStyle = '#000';
        ctx.stroke();
        ctx.fillStyle = col;
        ctx.fill();
        ctx.restore();
        // on the inner side: its name, and under it how far (with ▲▼ and its floor when that's another than yours)
        const far = me ? Math.hypot(m.cx - me.cx, m.cy - me.cy) : NaN, up = otherFloor(m.cx, m.cy, m.cz), floor = up ? floorSaid(m) : '';
        const px = 10 * scale, name = m.t ? (m.t.length > 28 ? m.t.slice(0, 27) + '…' : m.t) : '';
        const said = (up ? (up > 0 ? '▲ ' : '▼ ') : '') + (Number.isFinite(far) ? (far >= 1000 ? (far / 1000).toFixed(1) + ' km' : Math.round(far) + ' m') : '') + (floor ? ' · ' + floor : '');
        ctx.font = 'bold ' + px * prefs.textScale + 'px ' + FONT;
        const half = Math.max(ctx.measureText(said).width, ctx.measureText(name).width) / 2 + 4;
        const tx = x - Math.cos(turn) * (r * 1.4 + half), ty = y - Math.sin(turn) * (r * 1.4 + px * 1.6);
        if (name) write(name, px, tx, ty - px * 1.1, col, 1);
        if (said) write(said, px, tx, ty + (name ? px * 0.1 : -px * 0.55), col, 1);
        thingsDrawn.push({ x, y, r: r * 1.6, tip: { title: m.t || T('Extract'), lines: [T('An extract, off the screen')].concat(floor ? [floor] : []) } });
      }
    }
    if (!prefs.edge) return;
    for (const m of live) {
      if (!prefs.edgeKinds.includes(m.c) && m.id !== chased) continue;
      if (m.c === 'Corpse' || m.c === 'Main Player' || inArea(m) || isHidden(m.c || 'None') || !Number.isFinite(m.cx)) continue;
      const at = toScreen(m.cx, m.cy);
      if (inSight(box, at)) continue;
      const [x, y, turn] = edgeAt(box, at, pad);
      const kind = KINDS[m.c] || OTHER, r = 7 * scale * kind.size;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(turn);
      ctx.beginPath();
      ctx.moveTo(r * 1.35, 0);
      ctx.lineTo(-r * 0.75, -r * 0.95);
      ctx.lineTo(-r * 0.3, 0);
      ctx.lineTo(-r * 0.75, r * 0.95);
      ctx.closePath();
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(2, r * 0.4);
      ctx.strokeStyle = edgeOf(kind.col);
      ctx.stroke();
      ctx.fillStyle = m.id === chased ? '#5fd4ff' : kind.col;
      ctx.fill();
      ctx.restore();
      // how far, written on the arrow's inner side
      const far = farOf(m);
      if (Number.isFinite(far)) {
        const tx = x - Math.cos(turn) * r * 2.9, ty = y - Math.sin(turn) * r * 2.2;
        write(far >= 1000 ? (far / 1000).toFixed(1) + ' km' : Math.round(far) + ' m', 10 * scale, tx, ty - 5 * scale, inkOf(kind.col), 1);
      }
      drawn.push({ m, x, y, w: r * 3.2, h: r * 3.2 });
    }
  }

  // the REC sign: the raid shown live is being recorded on the server (its reports say "rec"), not in a replay
  // a person or a bot (not an extract, a body, the BTR or an airdrop)
  const PEOPLE_OR_BOTS = c => !['Extract', 'Transit', 'Corpse', 'BTR', 'Airdrop'].includes(c);
  // Recording as the server has it: on (config.jsonc's history.record) and stopped (the REC button), asked at the start,
  // once a minute and when it's pressed
  let recState = { on: true, paused: false }, recPrint = '';
  // Prices as the server gives them (Loot > Filters > Prices): the most it sells for (the flea's or the best trader's),
  // the best trader's, the flea's, or the handbook's for a game without it. Changed, the page is loaded again, so everything already
  // priced is priced the new way. (A server older than 1.1.0 says only "handbook", and knows no "most".)
  async function askPrices(mode) {
    try {
      const r = await fetch('api/prices' + (mode === undefined ? '' : '?mode=' + mode + '&handbook=' + (mode === 'handbook' ? 1 : 0)), mode === undefined ? undefined : { method: 'POST' });
      const j = await answered(r).json();
      $('optPrices').value = ['most', 'trader', 'flea', 'handbook'].includes(j.mode) ? j.mode : j.handbook ? 'handbook' : 'flea';
      if (mode !== undefined) location.reload();
    } catch (e) { /* as it was */ }
  }
  $('optPrices').onchange = e => askPrices(e.target.value);
  askPrices();
  async function askRec(paused) {
    if (!RECORDING) return;
    try {
      const r = await fetch('api/history/pause' + (paused === undefined ? '' : '?paused=' + (paused ? 1 : 0)), paused === undefined ? undefined : { method: 'POST' });
      const j = await answered(r).json();
      recState = { on: j.on !== false, paused: !!j.paused };
    } catch (e) { /* as it was */ }
    showRec();
    if (HIST && paused !== undefined) loadHistory();
  }
  // REC: only while a raid is recorded (blinking), or, stopped, "REC off" (pressed, it starts again). Out of a raid
  // with recording on: not there. A raid recorded that ends says so once, in a toast.
  let recLiveSince = 0;
  function showRec() {
    const btn = $('recBtn');
    const off = !recState.on || recState.paused;
    const live = !off && !replay && !!report && report.rec === 1 && inRaidHere();
    const shown = RECORDING && !HIST && prefs.recSign !== false && (live || (off && recState.on));
    const print = [shown, off, live, recState.on].join();
    if (print === recPrint) return;
    recPrint = print;
    if (live && !recLiveSince) recLiveSince = performance.now();
    else if (!live && recLiveSince) {
      // (over, as this game says, and long enough for the server to keep it: 45 s)
      const kept = performance.now() - recLiveSince > 45000 && !off && !!report && report.raid === false;
      recLiveSince = 0;
      if (kept) toast(T('Raid recorded: in Raid history'), '#ff4b3e', () => window.open(ROOT + 'raids/', '_blank'));
    }
    btn.hidden = !shown;
    btn.classList.toggle('off', off);
    btn.classList.toggle('live', live);
    $('recText').textContent = off ? T('REC off') : 'REC';
    btn.title = !recState.on ? T('Raids aren\'t recorded: history.record is off in the server\'s config.jsonc.')
      : recState.paused ? T('Recording is stopped: no raid is recorded until this is pressed again.')
      : live ? T('This raid is being recorded. Press to stop recording: this raid and every one after, until pressed again.')
      : T('Raids are recorded. Press to stop recording, until pressed again.');
  }
  function draw() {
    showRec();
    const ratio = pixelRatio();
    if (canvas.width !== Math.round(vw * ratio) || canvas.height !== Math.round(vh * ratio)) {
      canvas.width = Math.round(vw * ratio);
      canvas.height = Math.round(vh * ratio);
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, vw, vh);
    drawn = [];
    showScale();
    if (!map) return;
    const scale = prefs.scale * zoomScale();
    drawZones(scale);
    drawHeat();
    drawFloorEdge();
    drawHovered();
    drawThings(scale);
    // the spot just gone to: rings widening from it, a few times over
    if (flash) {
      const age = performance.now() - flash.at;
      if (age > 2400) flash = null;
      else {
        const s = toScreen(flash.x, flash.y);
        ctx.save();
        for (let k = 0; k < 2; k++) {
          const t = ((age / 800) + k * 0.5) % 1;
          ctx.globalAlpha = 1 - t;
          ctx.beginPath();
          ctx.arc(s[0], s[1], 8 + t * 40, 0, Math.PI * 2);
          ctx.lineWidth = 3;
          ctx.strokeStyle = LAYERS.quest.col;
          ctx.stroke();
        }
        ctx.restore();
        dirty = true;
      }
    }
    drawMini();
    showKey();
    if (!inRaidHere()) return;
    // the player shown, by the ids a body's killer may be told by
    const mainNow = live.find(m => m.c === 'Main Player');
    ownIds = [replay ? replay.about.sid : sid, mainNow && mainNow.pid].filter(Boolean);
    drawOrbitField(scale);
    drawPhobosField(scale);
    drawSwitches(scale);
    drawOrbitMain(scale);
    drawTrails(scale);
    botLabels.length = 0;
    let top = null;
    // the corpses first, under everyone: the ones a player killed, or every one when asked
    if (!isHidden('Corpse')) {
      for (const m of corpsesNow || live.filter(k => k.c === 'Corpse')) {
        if (!m.kp && !prefs.allCorpses && !bodySeen(m)) continue;
        const by = killedBy(m);
        if (prefs.myCorpses && by !== 'me') continue;
        if (pointed === m.id) { top = m; continue; }
        drawMarker(m, false, scale);
        // a ring round the ones a person killed: gold for the player's own, white for somebody else's; and, with
        // "PMCs killed by bots" on, red round a PMC a bot killed
        if (by && (by !== 'ai' || (prefs.botKills && wasPmc(m)))) {
          const s = toScreen(m.cx, m.cy);
          ctx.beginPath();
          ctx.arc(s[0], s[1], 10.5 * scale, 0, Math.PI * 2);
          ctx.lineWidth = 3.6;
          ctx.strokeStyle = 'rgba(0,0,0,0.85)';
          ctx.stroke();
          ctx.lineWidth = 1.8;
          ctx.strokeStyle = by === 'me' ? '#ffc94d' : by === 'ai' ? '#ff5148' : '#f2f2f5';
          ctx.stroke();
        }
        if (m.ring || m.wish) {
          const s = toScreen(m.cx, m.cy);
          ctx.beginPath();
          ctx.arc(s[0], s[1], 14 * scale, 0, Math.PI * 2);
          ctx.lineWidth = 4;
          ctx.strokeStyle = '#000';
          ctx.stroke();
          ctx.lineWidth = 2;
          ctx.strokeStyle = m.ring ? LAYERS.quest.col : WISH_COL;
          ctx.stroke();
          // (one holding something on the wishlist: its star)
          if (m.wish) wishStar(s[0] + 10 * scale, s[1] - 10 * scale, 6 * scale);
        }
      }
    }
    // kills: under the living, so a killer stood by the one they killed isn't covered by its mark
    if (!(HIST && prefs.hpNoEvents)) drawKills(scale);
    for (const m of live) {
      if (m.c === 'Corpse' || isHidden(m.c || 'None')) continue;
      // an extract that isn't there this raid (a car that never came), when only the ones to be had are wanted
      if (m.c === 'Extract' && !prefs.goneExits && m.st === 0) continue;
      // a secret extract not found yet, unless those are wanted too
      if (m.c === 'Extract' && !prefs.secretExits && m.st === 3) continue;
      if (inArea(m)) continue;
      if (m.dyn && m.c !== 'Main Player' && offFloor(m.cx, m.cy, m.cz)) continue;
      // (a replay with Players off: nobody drawn, only what happened)
      if (HIST && prefs.hpNoPeople && m.dyn && PEOPLE_OR_BOTS(m.c)) continue;
      if (pointed === m.id) { top = m; continue; }
      drawMarker(m, false, scale);
    }
    drawBadges(scale);
    drawDoing(scale);
    drawAreas(scale);
    drawShots();
    // (a replay with Events off: no kills, hits, grenades or pick-ups drawn)
    if (!(HIST && prefs.hpNoEvents)) {
      drawHits(scale);
      drawBlasts(scale);
      drawMags(scale);
      drawFloats(scale);
    }
    drawPlane(scale);
    drawHeadings(scale);
    drawSquads(scale);
    if (prefs.edge || prefs.edgeQuests || prefs.edgeExits !== false) drawEdge(scale);
    // the one pointed at: bigger, named, over the others
    if (top) drawMarker(top, true, scale);
    drawBotLabels(scale);
    drawSharedContacts(scale);
    // the one the pointer is over in the Raid list: ringed; and the one followed, in blue
    // (Settings > Ring round the one followed: off, only the white one)
    for (const id of chased !== null && chased !== rosterOver && prefs.chaseRing !== false ? [rosterOver, chased] : [rosterOver]) {
      const over = id !== null ? liveById.get(id) : null;
      if (!over || !Number.isFinite(over.cx)) continue;
      const s = toScreen(over.cx, over.cy);
      ctx.beginPath();
      ctx.arc(s[0], s[1], 17 * scale, 0, Math.PI * 2);
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.stroke();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = id === chased ? '#5fd4ff' : '#fff';
      ctx.stroke();
    }
  }

  // ---- what the game says --------------------------------------------------------------------------------------
  const connected = () => (replay ? true : performance.now() - heard < 4500) && !!report;
  const inRaid = () => connected() && !!report.raid;
  const inRaidHere = () => inRaid() && !!map && map.loc === shownLoc(report.loc);

  // ---- Smooth over a slow connection (prefs.smooth) ----
  // Where things are is played back a moment late (HOLD_MS), at the pace the game sent it: reports that come late
  // or bunched up (over the internet, say) are then spread out as they were sent, instead of the map stopping and
  // jumping. Two lines of reports, each kept in order: the game's, and in a Fika raid shown from its host, where the
  // player is, from their own game ("own"). Unset: on when the page is opened from outside this network.
  const HOLD_MS = 120;
  const held = [[], []], heldNext = [0, 0], heldGap = [100, 100], heldTimes = [[], []];
  const nearby = h => /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|[^.]+$)/.test(h);
  const smoothing = () => typeof prefs.smooth === 'boolean' ? prefs.smooth : !nearby(location.hostname);
  function hold(message, now) {
    const which = message.d.own ? 1 : 0, q = held[which];
    // how often this line's reports are sent: how many came in the last two seconds, however bunched up they came
    const times = heldTimes[which];
    times.push(now);
    while (times.length && now - times[0] > 2000) times.shift();
    if (times.length >= 4) heldGap[which] = Math.min(1000, Math.max(15, (now - times[0]) / (times.length - 1)));
    let at = Math.max(now + HOLD_MS, heldNext[which] + heldGap[which]);
    // fallen far behind (the page was out of sight, or a long stall): caught up, not kept behind
    if (at - now > HOLD_MS * 4 || q.length > 60) {
      while (q.length) take(q.shift()[1], true);
      at = now + HOLD_MS;
    }
    heldNext[which] = at;
    q.push([at, message]);
  }
  function playHeld() {
    const now = performance.now();
    for (const q of held) while (q.length && q[0][0] <= now) take(q.shift()[1], true);
  }
  function dropHeld() {
    for (const q of held) q.length = 0;
    for (const times of heldTimes) times.length = 0;
    heldNext[0] = heldNext[1] = 0;
  }

  function take(message, replayed) {
    const now = performance.now();
    const d = message.d;
    if (!d || message.age > 5000) return;
    // while a recorded raid plays, only its reports are taken; the game's own wait until it's left
    if (replay ? !message.rp : message.rp) return;
    const known = sessions.get(message.sid) || {};
    known.heard = now;
    if (d.raid !== undefined) known.raid = d.raid;
    if (!message.rp) sessions.set(message.sid, known);
    if (message.rp) {
      if (sid !== message.sid) { forget(); sid = message.sid; }
    } else if (prefs.player) {
      // a player was picked: theirs and nobody else's, whenever they play
      if (message.sid !== prefs.player.sid) return;
      if (sid !== message.sid) { forget(); sid = message.sid; }
      if (message.name && message.name !== prefs.player.name) { prefs.player.name = message.name; save(); }
    } else if (!sid || (sid !== message.sid && known.raid && !(sessions.get(sid) || {}).raid)) {
      // nobody picked: the first game heard from, or one that's in a raid when the one shown isn't
      forget();
      sid = message.sid;
    }
    // from here on only that game is listened to: the others then needn't report at all
    if (!message.rp && streamFor !== (prefs.player ? prefs.player.sid : sid)) listen();
    if (message.sid !== sid) return;
    heard = now;
    const moving = d.t === 'fast' || d.t === 'full';
    if (moving && !replayed) speedHeard(now);
    if (!replayed && d.t === 'idle') dropHeld();
    if (moving && !replayed && smoothing()) { hold(message, now); return; }

    // what lies about in the raid changed: the stream brings it just before (streamThings); asked for only when it
    // hasn't come (an older server, or the stream down)
    if (d.t === 'things') {
      if (d.v !== thingsWanted) {
        thingsWanted = d.v;
        if (thingsHave === d.v) return;
        if (streamUp) setTimeout(() => { if (thingsHave !== thingsWanted) loadThings(); }, 2500);
        else loadThings();
      }
      return;
    }

    if (d.t === 'fast') {
      if (!report) return;
      // In a Fika raid shown from its host's game, where the player is comes from their own game, as it comes
      // ("own"): only they move by it, and how often the host reports (the others' timing) is left as it is
      const rows = d.m || [];
      if (d.own) {
        if (d.me) wantMe(d.me);
        for (const row of rows) {
          const m = liveById.get(row[0]);
          if (m) { m.p[0] = row[1]; m.p[1] = row[2]; m.p[2] = row[3]; m.r = row[4]; m.fx = m.cx; m.fy = m.cy; m.t0 = now; }
        }
        return;
      }
      // how often the game reports: things are moved from one report's place to the next's in that time
      if (now - told > 20 && now - told < 1000) period += (now - told - period) * 0.2;
      told = now;
      if (d.me) wantMe(d.me);
      takeShots(d.sh, now);
      for (const row of d.m || []) {
        const m = liveById.get(row[0]);
        if (m) { m.p[0] = row[1]; m.p[1] = row[2]; m.p[2] = row[3]; m.r = row[4]; m.fx = m.cx; m.fy = m.cy; m.t0 = now; }
      }
      return;
    }

    // "idle" is the game saying it's there before it knows a page is open: everything follows in a moment
    const was = report;
    report = d.t === 'idle' ? Object.assign({}, was && was.raid === d.raid ? was : {}, { raid: d.raid, loc: d.loc }) : d;
    if (d.t === 'full') {
      if (FAKE_TEAM && d.raid && Array.isArray(d.me)) d.markers = (d.markers || []).concat(fakeTeam(d.me, now));
      const before = liveById;
      liveById = new Map();
      live = (d.markers || []).map(m => {
        const old = before.get(m.id);
        // a marker that moves glides from where it was drawn
        const glide = old && m.dyn;
        m.cx = glide ? old.cx : m.p[0];
        m.cy = glide ? old.cy : m.p[1];
        m.cz = glide ? old.cz : m.p[2];
        m.cr = glide ? old.cr : m.r;
        m.fx = m.cx;
        m.fy = m.cy;
        m.t0 = now;
        if (m.t) { m.tn = m.t; m.t = latin(m.t); }
        trimBrains(m);
        liveById.set(m.id, m);
        return m;
      });
      const order = m => (KINDS[m.c] || OTHER).order;
      live.sort((a, b) => order(a) - order(b));
      if (d.me) wantMe(d.me); else me = null;
      takeEvents(d);
      takeShots(d.sh, now);
      // the plane is told of once a second: how fast it flies is worked out from the last two, and it's drawn on from
      // where it was told to be (see drawPlane), so it glides
      if (d.raid && d.plane && Array.isArray(d.plane.p)) {
        const since = (now - planeAt) / 1000;
        planeV = plane && Array.isArray(plane.p) && since > 0.2 && since < 4 ? [(d.plane.p[0] - plane.p[0]) / since, (d.plane.p[1] - plane.p[1]) / since] : planeV;
        plane = d.plane;
        planeAt = now;
      } else { plane = null; planeV = null; }
      trackAreas(now);
      trackBodies();
      trackUnder();
      // the kinds only a mod brings, for the mods this game has: remembered, so the switches are right out of a raid too
      if (Array.isArray(d.has) && d.has.join('|') !== (prefs.has || ['?']).join('|')) { prefs.has = d.has; save(); }
      if (Array.isArray(d.brains) && d.brains.join('|') !== (prefs.brains || ['?']).join('|')) { prefs.brains = d.brains; save(); nameBotDetails(); }
      if (!prefs.seenInfected && live.some(m => m.c === 'Infected')) { prefs.seenInfected = true; save(); }
      for (const kind of SEEN_KINDS) if (!list(prefs.seenKinds).includes(kind) && live.some(m => m.c === kind)) { prefs.seenKinds = list(prefs.seenKinds).concat(kind); save(); filtersPrint = null; }
      announce();
      remember();
      // a page opened in the middle of a raid: what lies about is there already
      if (d.raid && !things && !replay && performance.now() - thingsTriedAt > 5000) loadThings();
      if (!d.raid && things) things = null;
    }
    raidChanged();
    dirty = true;
  }

  // "The Goons have been spotted on the map": said once a raid for each kind asked for (each boss by name), whether
  // or not its markers are shown. Where they are isn't said.
  const ALERTS = ['Goon', 'Boss', 'Cultist', 'Black Division', 'RUAF', 'RUAF Remnant', 'UNTAR', 'ISB', 'ISB WT', 'Raider', 'Rogue', 'Enemy Player', 'Infected', 'Airdrop'];
  const spotted = new Set();
  let alertRaid = '';
  // a short two-note chime, made in the page (no sound file): only for alerts, and only when switched on
  let chimeAudio = null;
  function chime() {
    try {
      chimeAudio = chimeAudio || new (window.AudioContext || window.webkitAudioContext)();
      const now = chimeAudio.currentTime;
      for (const [freq, at] of [[880, 0], [1320, 0.14]]) {
        const osc = chimeAudio.createOscillator(), gain = chimeAudio.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + at);
        gain.gain.exponentialRampToValueAtTime(0.18, now + at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.32);
        osc.connect(gain).connect(chimeAudio.destination);
        osc.start(now + at);
        osc.stop(now + at + 0.35);
      }
    } catch (e) { /* no sound here */ }
  }
  function announce() {
    if (replay) return;
    const raid = report && report.raid ? sid + '|' + report.loc : '';
    if (raid !== alertRaid) { alertRaid = raid; spotted.clear(); }
    if (!raid) return;
    let rang = false;
    for (const m of live) {
      if (!prefs.alerts.includes(m.c) || !KINDS[m.c]) continue;
      const key = m.c === 'Boss' ? 'Boss:' + m.t : m.c === 'Airdrop' ? 'Airdrop:' + m.id : m.c;
      if (spotted.has(key)) continue;
      spotted.add(key);
      toast(m.c === 'Boss' && m.t ? T('{who} has been spotted on the map', { who: m.t })
        : m.c === 'Goon' ? T('The Goons have been spotted on the map')
        : m.c === 'Enemy Player' ? T('Enemy PMCs have been spotted on the map')
        : m.c === 'Airdrop' ? T('An airdrop is coming in')
        : T('{kind} have been spotted on the map', { kind: KINDS[m.c].name }), inkOf(KINDS[m.c].col));
      rang = true;
    }
    if (rang && prefs.alertSound) chime();
  }
  // Everyone the Raid list could name, as first seen this raid: kept after they die or go, for "who was in the raid"
  // without saying who's still alive (prefs.rosterFog).
  const seenRoster = new Map();
  let seenRaid = '';
  function remember() {
    const raid = report && report.raid ? sid + '|' + report.loc + '|' + report.raid : '';
    if (raid !== seenRaid) { seenRaid = raid; seenRoster.clear(); }
    if (!raid) return;
    for (const m of live) {
      if (!ROSTER.includes(m.c) || seenRoster.has(m.id)) continue;
      seenRoster.set(m.id, { id: m.id, c: m.c, t: m.t, lv: m.lv, g: m.g, df: m.df, ps: m.ps, pid: m.pid });
    }
  }
  // (go: what pressing it does, as well as putting it away)
  function toast(text, col, go) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'toast';
    item.style.borderColor = col;
    item.textContent = text;
    item.title = go ? T('Press to open it') : T('Press to dismiss');
    const gone = () => item.remove();
    item.onclick = () => { gone(); if (go) go(); };
    setTimeout(gone, 12000);
    $('toasts').appendChild(item);
    while ($('toasts').children.length > 5) $('toasts').firstChild.remove();
  }

  function wantMe(at) {
    if (!me) me = { cx: at[0], cy: at[1], cz: at[2] };
    me.x = at[0]; me.y = at[1]; me.z = at[2];
    me.fx = me.cx; me.fy = me.cy; me.t0 = performance.now();
    me.in = at.length > 4 ? !!at[4] : undefined;
  }
  // another game is shown from here on
  function forget() {
    dropHeld();
    report = null;
    live = [];
    liveById = new Map();
    me = null;
    raidKey = '';
    zoomState = null;
    things = null;
    thingsWanted = 0;
    thingsHave = -1;
    quests = null;
    wish = null;
    wishGroup = new Map();
    wishPrint = '';
    questsFor = '';
    questsAskedAt = -1e9;
    squadEvents = [];
    otherEvents = [];
    killEvents = [];
    eventsSeen = new Set();
    eventsRaid = '';
    liveSightUntil.clear(); liveLastSight.clear(); liveVoices.clear(); liveShares = [];
  }

  // a raid began, ended or moved on, or its location's map arrived: show that map
  function raidChanged() {
    const there = report && report.raid ? mapFor(report.loc) : null;
    const key = there ? there.loc + '|' + there.v : '';
    if (key === raidKey) return;
    const began = !raidKey;
    raidKey = key;
    // a raid began or ended: the quests may have moved on
    loadQuests(true);
    if (!there) return;
    const same = there === map;
    showMap(there, false);
    zoomState = null;
    if (began || !same) {
      zoom = zoomTarget = zoomMin + Math.min(1, Math.max(0, prefs.zoom)) * (zoomMax - zoomMin);
      if (me) centreOn(me.x, me.y);
    }
  }

  // Whose game: "whoever is playing", or one player by name, remembered here and shown whenever they play.
  // (hl: in a raid a Fika headless runs, which the map is shown from)
  const gameName = g => (g.name || T('Game') + ' …' + g.sid.slice(-4)) + (g.hl ? ' (' + T('headless') + ')' : '');
  function listGames() {
    const pick = $('session');
    // (every profile on the server is listed, the ones not playing too, so the page can be kept on one)
    const rows = games.map(g => ({ sid: g.sid, text: gameName(g) + (g.off ? ' · ' + T('not playing') : g.raid ? ' · ' + T('in raid') : '') }));
    if (prefs.player && !games.some(g => g.sid === prefs.player.sid)) {
      rows.push({ sid: prefs.player.sid, text: gameName(prefs.player) + ' · ' + T('not playing') });
    }
    pick.hidden = !rows.length;
    const wanted = prefs.player ? prefs.player.sid : '';
    const print = rows.map(r => r.sid + r.text).join('|');
    if (pick.dataset.print === print && pick.value === wanted) return;
    pick.dataset.print = print;
    pick.textContent = '';
    const anyone = document.createElement('option');
    anyone.value = '';
    anyone.textContent = T('Whoever is playing');
    pick.appendChild(anyone);
    for (const r of rows) {
      const o = document.createElement('option');
      o.value = r.sid;
      o.textContent = r.text;
      pick.appendChild(o);
    }
    pick.value = wanted;
  }
  // A server that doesn't answer the map (stopped, restarting, or started without Satellite, as when SPT loads no
  // mods): the page asks less and less often, up to once a minute, so it never fills the server's window with
  // requests nobody answers. One answer puts it back to asking as usual.
  let awayUntil = 0, awayFor = 0;
  const serverAway = () => performance.now() < awayUntil;
  const missed = () => { awayFor = Math.min(60000, awayFor ? awayFor * 2 : 5000); awayUntil = performance.now() + awayFor; };
  const answered = r => { if (!r.ok) { missed(); throw new Error('HTTP ' + r.status); } awayFor = 0; awayUntil = 0; return r; };
  async function askGames() {
    let answer = null;
    try {
      answer = await answered(await fetch('api/games')).json();
    } catch (e) { if (!(e instanceof Error && /^HTTP/.test(e.message))) missed(); }
    takeGames(answer);
  }
  // the games as api/games answers, asked for or brought by the stream (see listen)
  function takeGames(answer) {
    try {
      if (!answer) throw new Error('no answer');
      games = (answer.games || []).filter(g => g && typeof g.sid === 'string');
      const mine = prefs.player && games.find(g => g.sid === prefs.player.sid);
      if (mine && mine.name && mine.name !== prefs.player.name) { prefs.player.name = mine.name; save(); }
      // Nobody picked, and the game shown isn't in a raid (or has gone): another that is in one is shown instead.
      // (Told here, since only the game shown is listened to.)
      const playing = games.filter(g => !g.off);
      if (!prefs.player && playing.length) {
        const shownGame = playing.find(g => g.sid === sid);
        const better = shownGame && shownGame.raid ? null : playing.find(g => g.raid) || (shownGame ? null : playing[0]);
        if (better && better.sid !== sid) { forget(); sid = better.sid; listen(); }
      }
    } catch (e) { /* asked again in a moment */ }
    listGames();
  }

  // ---- what's shown here: marker kinds, on or off for this page only ---------------------------------------------
  // these start off on a page, and are on only where somebody ticked them (show); the rest start on (hide)
  const startOff = ['Layer spawnPmc', 'Layer spawnScav', 'Layer spawnBoss', 'Layer lootSpawns'];
  const shown = new Set(prefs.show);
  // as its switch has it
  const switchedOff = c => hidden.has(c) || (startOff.includes(c) && !shown.has(c));
  // The loot shown (prefs.loot): 'real', what's in this raid; 'can', where loot can spawn and what, never what's
  // there; 'both'; 'off'. A page from before this goes by the switches it had.
  if (!['real', 'can', 'both', 'off'].includes(prefs.loot)) {
    prefs.loot = !switchedOff('Layer lootSpawns') ? (hidden.has('Layer loose') ? 'can' : 'both') : 'real';
  }
  // The history page keeps its own (prefs.hpLootMap): the loot that lay there at the moment shown is on the map to
  // begin with, where loot can spawn only once asked for (+ Spawns, in the Loot fold beside the map: see sideLoot).
  // (hpLoot, an earlier one that started with no loot at all, is left behind)
  if (HIST) prefs.loot = ['real', 'both', 'off'].includes(prefs.hpLootMap) ? prefs.hpLootMap : 'real';
  const lootReal = () => prefs.loot === 'real' || prefs.loot === 'both';
  // (out of a raid nothing is really there: what can spawn is shown then, whichever of the two is picked; never on
  // the history page, where what lay there was recorded)
  const lootCan = () => prefs.loot === 'can' || prefs.loot === 'both' || (prefs.loot === 'real' && !HIST && !inRaidHere());
  // what's in containers, on bodies and on bots may be shown
  const peeking = () => !!prefs.peek && lootReal();
  // (the history page leaves the quests out: they'd be the quests the player has now, not those of the raid recorded)
  const HIST_NO = ['Layer quest', 'Layer questZones', 'Layer firItems'];
  const isHidden = c => HIST && HIST_NO.includes(c) ? true
    : c === 'Layer lootSpawns' ? !lootCan()
    : (c === 'Layer loose' || c === 'Layer bodies') && !lootReal() ? true
    : c === 'Layer boxes' && prefs.loot === 'off' ? true
    : switchedOff(c);
  function setHidden(category, hide) {
    if (hide) { hidden.add(category); shown.delete(category); } else { hidden.delete(category); shown.add(category); }
    prefs.hide = [...hidden];
    prefs.show = [...shown];
    save();
    dirty = true;
    rosterPrint = bestPrint = null;
    showModes();
  }
  // A kind only a mod brings has a switch only where that mod is installed (the game says which: "has"), and the
  // infected once they've been met. Never by who is in the raid: a switch that came and went would give them away.
  const MOD_KINDS = ['Black Division', 'RUAF', 'RUAF Remnant', 'UNTAR', 'ISB', 'ISB WT', 'Civilian'];
  // (the arena's fighters, mercenaries and the Combine: once one has been met, as the infected)
  const SEEN_KINDS = ['Bloodhound', 'Mercenary', 'Combine'];
  const available = c => MOD_KINDS.includes(c) ? !prefs.has || prefs.has.includes(c) : c === 'Infected' ? !!prefs.seenInfected
    : SEEN_KINDS.includes(c) ? list(prefs.seenKinds).includes(c) : true;
  let filtersPrint = null;      // nothing drawn yet: the first look always draws the list
  // the switches, in groups; a few have a switch of their own under them (a prefs key, and what it says)
  // who's shown, in sections with a title each: a section none of whose kinds this game has isn't listed
  const PEOPLE_SECTIONS = [
    [T('PMC'), ['Main Player', 'Friendly Player', 'Enemy Player']],
    [T('Scavs'), ['Scav', 'Sniper']],
    [T('Bosses'), ['Boss', 'Guard', 'Goon', 'Cultist']],
    // the rest of the game's own: raiders, rogues, smugglers, the infected (an event), and every bot not named
    // (event and arena bots, a mod's own)
    [T('Other'), ['Raider', 'Rogue', 'Smuggler', 'Bloodhound', 'Infected', 'Other AI']],
    [T('Modded bots'), ['Black Division', 'RUAF', 'RUAF Remnant', 'UNTAR', 'ISB', 'ISB WT', 'Mercenary', 'Combine', 'Civilian']],
    [T('Corpses'), ['Corpse']]
  ];
  const SECTION_OF = {};
  for (const [title, kinds] of PEOPLE_SECTIONS) for (const k of kinds) SECTION_OF[k] = title;
  const EDGE_ABLE = PEOPLE_SECTIONS.flatMap(s => s[1]).filter(k => k !== 'Main Player' && k !== 'Corpse').concat(['Airdrop']);
  // a section's title, across the grid, before the first of its kinds that is listed
  const sectionHead = (grid, kind, last) => {
    const title = SECTION_OF[kind];
    if (!title || title === last) return last;
    const head = document.createElement('div');
    head.className = 'filterHead sect';
    head.textContent = title;
    grid.appendChild(head);
    return title;
  };
  const FILTER_GROUPS = [
    ['filtersPeople', PEOPLE_SECTIONS.flatMap(s => s[1])],
    ['filtersMap', ['BTR', 'Airdrop', 'Layer btrRoad', 'Zone mine', 'Zone sniper', 'Layer locks', 'Layer switches', 'Layer spawnPmc', 'Layer spawnScav', 'Layer spawnBoss', 'Extract', 'Transit']],
    ['filtersLoot', ['Layer loose', 'Layer boxes', 'Layer bodies']]
  ];
  // the switches under another one that start on
  const SUB_ON = ['seenDead', 'corpseKind', 'allCorpses', 'myExits', 'botKills'];
  const FILTER_SUBS = {
    'Corpse': [['allCorpses', T('All corpses, not only player kills')], ['myCorpses', T('Only my kills'), T('Only the bodies of those you killed yourself. Bodies have a ring when a person killed them: gold for your kills, white for another player\'s.')],
      ['botKills', T('PMCs killed by bots'), T('A red ring round the body of a PMC a bot killed, so it stands apart from your kills (gold) and other players\' (white). Pointing at a body says who killed it.')], ['seenDead', T('Corpses I\'ve been close to')], ['corpseKind', T('Show what each corpse was')]],
    'Layer loose': [['lootArea', T('Rough areas only')]],
    'Layer locks': [['keyStates', T('My keys'), T("The lock's key: bright when you have it with you, gold when it's in your stash, dim when you don't have it.")]],
    'Layer switches': [['lightSwitches', T('Light switches'), T('The switches for the lights in a room. Off: only power switches, levers and the like.')]],
    'Extract': [['myExits', T('Mine only'), T('In a raid: only the extracts you can take this raid.')], ['goneExits', T('Closed ones'), T('Extracts that are no longer there this raid, such as a vehicle that has left, are shown in red. Off: they are hidden.')],
      ['secretExits', T('Secret ones not found yet'), T('Secret extracts show once you pick up their note. On: the ones not found yet are shown too, in purple.')]]
  };
  function listFilters(keepColors) {
    const all = Object.keys(KINDS).sort((a, b) => KINDS[b].order - KINDS[a].order);
    // kinds and layers the server's config.jsonc keeps off every page
    const layersOff = (report && Array.isArray(report.layersOff)) ? report.layersOff : [];
    const off = ((report && Array.isArray(report.off)) ? report.off : [])
      .concat(Object.keys(LAYERS).filter(k => layersOff.includes(LAYERS[k].server)).map(k => 'Layer ' + k));
    const print = off.join('|') + '#' + (prefs.has || ['?']).join('|') + '#' + prefs.seenInfected;
    if (print === filtersPrint) return;
    filtersPrint = print;
    const looks = {};
    for (const k of all) looks[k] = KINDS[k];
    for (const zone of Object.keys(ZONES)) looks['Zone ' + zone] = ZONES[zone];
    for (const layer of Object.keys(LAYERS)) looks['Layer ' + layer] = LAYERS[layer];
    listAlerts(off);
    if (!keepColors) listColors();
    // "Point to who's off the screen": a switch for each kind that can have an arrow
    {
      const grid = $('edgeKinds');
      grid.textContent = '';
      let section = '';
      for (const kind of EDGE_ABLE) {
        if (!available(kind) || off.includes(kind)) continue;
        section = sectionHead(grid, kind, section);
        const row = document.createElement('label'), input = document.createElement('input'), swatch = document.createElement('i'), span = document.createElement('span');
        row.className = 'row';
        input.type = 'checkbox';
        input.checked = prefs.edgeKinds.includes(kind);
        input.dataset.def = EDGE.includes(kind) ? '1' : '0';
        input.onchange = () => {
          prefs.edgeKinds = prefs.edgeKinds.filter(k => k !== kind).concat(input.checked ? [kind] : []);
          save();
          dirty = true;
        };
        swatch.className = 'swatch';
        paintSwatch(swatch, KINDS[kind].col);
        span.textContent = KINDS[kind].name;
        row.append(input, swatch, span);
        grid.appendChild(row);
      }
    }
    for (const [box, members] of FILTER_GROUPS) {
      const grid = $(box);
      grid.textContent = '';
      let section = '';
      for (const category of members) {
        const look = looks[category];
        if (!look || !available(category)) continue;
        section = sectionHead(grid, category, section);
        const main = grid.appendChild(box === 'filtersPeople' ? whoRow(category, look.name, look.col, off.includes(category)) : filterRow(category, look.name, look.col, off.includes(category)));
        // one or two short switches under another: on one line beside each other, under a row of its own
        const subs = FILTER_SUBS[category] || [];
        let line = grid;
        if (subs.length && subs.length <= 2) {
          main.classList.add('wide');
          line = document.createElement('div');
          line.className = 'subLine';
          grid.appendChild(line);
        }
        for (const sub of subs) {
          const row = document.createElement('label');
          row.className = 'row sub';
          if (sub[2]) row.title = sub[2];
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.checked = !!prefs[sub[0]];
          input.dataset.def = SUB_ON.includes(sub[0]) ? '1' : '0';
          input.onchange = () => { prefs[sub[0]] = input.checked; save(); dirty = true; rosterPrint = null; tipFor = null; listRoster(); };
          const span = document.createElement('span');
          span.textContent = sub[1];
          row.append(input, span);
          line.appendChild(row);
        }
      }
    }
  }
  // Settings, Colours: each kind of marker with its colour, picked or typed as a hex code, and a way back to the usual
  // one. Extracts aren't here: their colour says whether they can be taken.
  function colorGroups() {
    return [[T('The page'), ['Page primary', 'Page secondary']], [T('People and bots'), FILTER_GROUPS[0][1]],
      [T('On the map'), FILTER_GROUPS[1][1].filter(k => k !== 'Extract')],
      [T('Loot'), ['Layer quest', 'Layer questZones', 'Layer firItems'].concat(FILTER_GROUPS[2][1])]];
  }
  function setCol(key, col) {
    const look = colLook(key);
    if (!look) return;
    if (blackRefused(key, col)) col = null;
    if (!col || col === COL_HOME[key]) delete prefs.cols[key];
    else prefs.cols[key] = col;
    look.col = prefs.cols[key] || COL_HOME[key];
    save();
    recolored();
  }
  // everything that shows a marker colour drawn again (the map, the switches' swatches, the Raid list)
  function recolored() {
    paintPage();
    dirty = true;
    tipFor = null;
    rosterPrint = null;
    squadPanePrint = '';
    filtersPrint = null;
    listFilters(true);
    listRoster();
    feedPrint = '';
    showKills();
  }
  function listColors() {
    const box = $('colorList');
    box.textContent = '';
    for (const [head, keys] of colorGroups()) {
      const title = document.createElement('div');
      title.className = 'filterHead';
      title.textContent = head;
      box.appendChild(title);
      for (const key of keys) {
        const look = colLook(key);
        if (!look || !available(key)) continue;
        const row = document.createElement('div'), pick = document.createElement('input'), name = document.createElement('span');
        // the square of colour is ours, with the browser's picker unseen over it: drawn by the browser, a dark colour got a light rim
        const sw = document.createElement('i');
        sw.className = 'sw';
        sw.appendChild(pick);
        const text = document.createElement('input'), back = document.createElement('button');
        row.className = 'row colRow';
        pick.type = 'color';
        pick.setAttribute('aria-label', look.name);
        name.textContent = look.name;
        text.type = 'text';
        text.className = 'hex';
        text.maxLength = 7;
        text.spellcheck = false;
        text.autocomplete = 'off';
        text.setAttribute('aria-label', T('Hex code') + ': ' + look.name);
        back.type = 'button';
        back.className = 'linkBtn';
        back.textContent = '↺';
        back.title = T('Back to the usual colour');
        const show = typed => {
          pick.value = look.col;
          paintSwatch(sw, look.col);
          if (!typed) { text.value = look.col; text.classList.remove('bad'); }
          back.hidden = !prefs.cols[key];
          row.classList.toggle('changed', !!prefs.cols[key]);
        };
        // (kept only once the colour is picked: Firefox on Windows says black as its colour window opens, and says
        // nothing more when it's shut with nothing new picked, so what's said while it's open isn't kept)
        pick.onchange = () => { setCol(key, hex6(pick.value)); show(); };
        text.oninput = () => {
          const col = hex6(text.value);
          text.classList.toggle('bad', !col);
          if (col) { setCol(key, col); show(true); }
        };
        text.onchange = () => show();
        text.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') text.blur(); };
        back.onclick = () => { setCol(key, null); show(); };
        show();
        row.append(sw, name, text, back);
        box.appendChild(row);
      }
    }
  }
  // the page starting again by itself: it fades out, and the new one stays unseen until it's whole (see index.html),
  // so nothing is seen falling apart and coming back piece by piece
  function again(go) {
    try { sessionStorage.setItem('swap', '1'); } catch (e) { /* private window */ }
    document.body.style.opacity = '0';
    setTimeout(go, 170);
  }
  // everything the page remembers, forgotten: it starts again as a page opened for the first time
  $('resetAll').onclick = () => {
    if (!confirm(T('Put every setting on this page back to its default? Switches, colours and layout are all reset.'))) return;
    // (the player's own presets are kept: they're what they made, not a setting)
    try {
      if (myPresets().length) localStorage.setItem('livemap', JSON.stringify({ myPresets: myPresets(), tab: 'presets' }));
      else localStorage.removeItem('livemap');
    } catch (e) { /* private window */ }
    again(() => location.reload());
  };
  // every setting to a file, and back from one: the page then starts again with them, read the way they always are
  // (anything out of range is put right on the way in). Only the settings this page has are taken; not who's followed.
  $('prefsExport').onclick = () => {
    save();
    const kept = Object.assign({}, prefs);
    delete kept.player;
    const blob = new Blob([JSON.stringify({ satellite: 1, prefs: kept }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'satellite-settings.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('prefsImport').onclick = () => { $('prefsPick').value = ''; $('prefsPick').click(); };
  $('prefsPick').onchange = () => {
    const file = $('prefsPick').files && $('prefsPick').files[0];
    if (!file) return;
    const wrong = () => alert(T("That file isn't settings saved by Satellite."));
    file.text().then(text => {
      let got;
      try { got = JSON.parse(text); } catch (e) { wrong(); return; }
      const from = got && typeof got === 'object' && got.satellite === 1 ? got.prefs : null;
      if (!from || typeof from !== 'object' || Array.isArray(from)) { wrong(); return; }
      // every key the file has (some, like the language, are only kept once picked), if it's this page's at all
      const next = {};
      for (const key of Object.keys(from)) if (key !== 'player') next[key] = from[key];
      if (!Object.keys(next).some(key => key in prefs)) { wrong(); return; }
      if (prefs.player) next.player = prefs.player;
      try { localStorage.setItem('livemap', JSON.stringify(next)); } catch (e) { /* private window */ }
      again(() => location.reload());
    }, wrong);
  };

  // ---- Presets: ready-made sets of switches ------------------------------------------------------------------------
  // Each sets what's shown (every kind, layer and zone, on or off) and the switches that say more than that, and
  // leaves the rest alone: colours, layout, language, the map's view, whose game. Put on through the stored settings
  // and a reload, as Import does, so every switch in the menu reads them the way it always does. The settings from
  // before are kept (livemapBefore), so one press puts them back.
  const PRESET_ALL = () => Object.keys(KINDS).concat(Object.keys(LAYERS).map(k => 'Layer ' + k), Object.keys(ZONES).map(k => 'Zone ' + k));
  // what's shown: the ones listed on, every other one off
  const shownOnly = on => {
    const all = PRESET_ALL();
    return { hide: all.filter(c => !on.includes(c)), show: on.filter(c => startOff.includes(c)), areaKinds: [] };
  };
  // the switches that tell of bots, whichever preset: on for everything, off for the other two. What's for finding out
  // what a mod is doing (its fields, hearing circles, ghost fights, lines to where every bot is heading) is never put
  // on by a preset: turned on by hand only.
  const botSwitches = v => ({ mapDoing: v, squadParts: v, actionIcons: v, tacticWords: v, squadPane: v, orbitTactics: v, orbitMain: v, orbitRush: v,
    doorEvents: v, grenades: v, botLoot: v,
    orbitField: false, phobosField: false, orbitLines: false, orbitNames: false, orbitHear: false, orbitFights: false });
  const PRESETS = [
    { id: 'all', name: T('All info'), says: T('Everything Satellite can show: every bot and what it is doing, all the loot and where it can spawn, what is inside containers and bodies, every kill, doors, switches and spawn points.'),
      patch: () => Object.assign(shownOnly(PRESET_ALL()), botSwitches(true), {
        loot: 'both', peek: true, worth: 0, wishOnly: false, lootArea: false, itemNames: true, lootFloats: true,
        allCorpses: true, myCorpses: false, botKills: true, seenDead: true, corpseKind: true,
        myExits: false, goneExits: true, secretExits: true, switches: true, lightSwitches: true, keyStates: true,
        shots: true, hitFlash: true, killLines: true, health: true, healthAll: true, names: 'all', rosterFog: false,
        botDetails: true, botDiff: true,
        feed: true, feedMine: true, feedPmc: true, feedBoss: true, feedAi: true,
        edge: true, edgeKinds: EDGE_ABLE.slice(), edgeQuests: true, edgeExits: true }) },
    // Standard: the author's own page through the alphas: everybody and all that's in the raid, with what the mods say
    // of the bots, but none of the extras (spawn points, where loot can spawn, bots' plans, the squads pane)
    { id: 'std', name: T('Standard'), says: T('Everybody and everything in the raid, without the extras: every bot with its difficulty and what SAIN, COMET and ORBIT say of it, action icons and tactic words; all the loot and what is inside things; doors, switches, shots and grenades. No spawn points, no loot spawn chances, no bot plans.'),
      patch: () => ({ hide: [], show: [], areaKinds: [], mapDoing: false, squadParts: true, actionIcons: true, tacticWords: true, squadPane: false,
        orbitMain: false, orbitRush: false, orbitField: false, phobosField: false, orbitLines: false, orbitNames: false, orbitHear: false, orbitFights: false,
        doorEvents: true, grenades: true, botLoot: true, botDetails: true, botDiff: true,
        loot: 'real', peek: true, worth: 0, wishOnly: false, lootArea: false, itemNames: true, lootFloats: true,
        allCorpses: true, myCorpses: false, botKills: false, seenDead: true, corpseKind: true,
        myExits: true, goneExits: false, secretExits: false, switches: true, lightSwitches: false, keyStates: false,
        shots: true, hitFlash: true, killLines: true, health: true, healthAll: true, names: 'all', rosterFog: false,
        feed: true, feedMine: true, feedPmc: true, feedBoss: true, feedAi: true,
        edge: true, edgeKinds: EDGE.slice(), edgeQuests: true, edgeExits: true }) },
    { id: 'min', name: T('Minimal'), says: T('Only what matters, without the clutter: everybody in the raid, without what each is up to; loot worth 50,000 ₽ or more; your quests; your extracts and the airdrop. No bot plans, no shot lines.'),
      patch: () => Object.assign(shownOnly(Object.keys(KINDS).concat([
        'Layer quest', 'Layer questZones', 'Layer firItems', 'Layer loose', 'Layer boxes', 'Layer locks', 'Zone mine', 'Zone sniper'])), botSwitches(false), {
        loot: 'real', peek: true, worth: 50000, wishOnly: false, lootArea: false, itemNames: false, lootFloats: false,
        allCorpses: false, myCorpses: false, botKills: false, seenDead: true, corpseKind: true,
        myExits: true, goneExits: false, secretExits: false, switches: false, lightSwitches: false,
        shots: false, hitFlash: false, killLines: true, health: true, healthAll: false, names: 'players', rosterFog: false,
        feed: true, feedMine: true, feedPmc: true, feedBoss: true, feedAi: false,
        edge: true, edgeKinds: EDGE_ABLE.slice(), edgeQuests: true, edgeExits: true }) },
    { id: 'fair', name: T('Fair play'), says: T("Only what you'd know in the game: you, your friends, the kills you make, your extracts, quest places, power switches and the airdrop. No bots, no loot or what spawned, no quest items, no alerts, nothing that gives away where anybody else is."),
      patch: () => Object.assign(shownOnly(['Main Player', 'Friendly Player', 'Corpse', 'Extract', 'Transit', 'Airdrop',
        'Layer questZones', 'Layer btrRoad', 'Layer locks', 'Layer switches', 'Zone mine', 'Zone sniper']), botSwitches(false), {
        loot: 'off', peek: false, wishOnly: false, lootFloats: false,
        allCorpses: false, myCorpses: true, botKills: false, seenDead: true, corpseKind: true,
        myExits: true, goneExits: false, secretExits: false, switches: true, lightSwitches: false, heat: false,
        shots: true, hitFlash: true, killLines: true, names: 'some', rosterFog: false, alerts: [],
        feed: true, feedMine: true, feedPmc: false, feedBoss: false, feedAi: false,
        edge: true, edgeKinds: ['Friendly Player', 'Airdrop'], edgeQuests: true, edgeExits: true }) }
  ];
  // a preset is in use while every switch it sets is as it sets it (a list in any order)
  const sameVal = (a, b) => Array.isArray(a) || Array.isArray(b)
    ? Array.isArray(a) && Array.isArray(b) && a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|')
    : a === b;
  const presetOn = p => {
    const patch = p.patch(), now = Object.assign({}, prefs, { hide: [...hidden], show: [...shown] });
    return Object.keys(patch).every(k => patch[k] === undefined || sameVal(now[k], patch[k]));
  };
  // The player's own presets (prefs.myPresets: [{ name, patch }]): the switches the ready-made ones set, as they were
  // when saved. Kept with the rest of the settings, so Export and Import take them along.
  const MY_MAX = 20;
  const PRESET_KEYS = [...new Set([...PRESETS.flatMap(p => Object.keys(p.patch())), 'mapDifficulty', 'mapPersonality'])];
  const myPresets = () => (Array.isArray(prefs.myPresets) ? prefs.myPresets : []).filter(p => p && typeof p.name === 'string' && p.patch && typeof p.patch === 'object' && !Array.isArray(p.patch));
  const asPreset = mine => ({ name: mine.name, says: '', mine: true, patch: () => JSON.parse(JSON.stringify(mine.patch)) });
  function switchesNow() {
    const now = {};
    for (const k of PRESET_KEYS) {
      const v = k === 'hide' ? [...hidden] : k === 'show' ? [...shown] : prefs[k];
      if (v !== undefined) now[k] = JSON.parse(JSON.stringify(v));
    }
    return now;
  }
  $('presetSave').onclick = () => {
    const list = myPresets();
    const name = (prompt(T('A name for this preset:'), '') || '').trim().slice(0, 40);
    if (!name) return;
    const same = list.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
    if (same >= 0 && !confirm(T('There is a preset called {name} already. Put these switches in it instead?', { name: list[same].name }))) return;
    if (same < 0 && list.length >= MY_MAX) { alert(T('You can keep up to {n} presets. Delete one first.', { n: MY_MAX })); return; }
    const mine = { name, patch: switchesNow() };
    if (same >= 0) list[same] = mine; else list.push(mine);
    prefs.myPresets = list;
    save();
    listPresets();
  };
  function putPreset(p) {
    save();
    const now = read(), patch = p.patch();
    try {
      localStorage.setItem('livemapBefore', JSON.stringify({ name: p.name, prefs: now }));
      for (const k of Object.keys(patch)) if (patch[k] !== undefined) now[k] = patch[k];
      localStorage.setItem('livemap', JSON.stringify(now));
    } catch (e) { return; /* private window: nothing kept, so nothing to reload with */ }
    again(() => location.reload());
  }
  function listPresets() {
    const box = $('presetList');
    if (!box) return;
    const card = (p, into, del) => {
      const b = document.createElement('div'), head = document.createElement('b');
      const on = presetOn(p);
      b.className = 'presetCard' + (on ? ' on' : '');
      b.tabIndex = 0;
      b.setAttribute('role', 'button');
      head.appendChild(document.createTextNode(p.name));
      if (on) { const tag = document.createElement('i'); tag.textContent = T('In use'); head.appendChild(tag); }
      if (del) {
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'presetDel';
        x.textContent = '×';
        x.title = T('Delete this preset');
        x.setAttribute('aria-label', T('Delete this preset'));
        x.onclick = e => { e.stopPropagation(); del(); };
        head.appendChild(x);
      }
      b.appendChild(head);
      if (p.says) { const says = document.createElement('small'); says.textContent = p.says; b.appendChild(says); }
      b.onclick = () => putPreset(p);
      b.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); putPreset(p); } };
      into.appendChild(b);
    };
    box.textContent = '';
    for (const p of PRESETS) card(p, box);
    const own = $('myPresetList'), list = myPresets();
    own.textContent = '';
    if (!list.length) { const none = document.createElement('p'); none.textContent = T('None yet.'); own.appendChild(none); }
    list.forEach((mine, i) => card(asPreset(mine), own, () => {
      if (!confirm(T('Delete the preset {name}?', { name: mine.name }))) return;
      prefs.myPresets = myPresets().filter((_, k) => k !== i);
      save();
      listPresets();
    }));
    let before = null;
    try { before = JSON.parse(localStorage.getItem('livemapBefore') || 'null'); } catch (e) { /* private window */ }
    const undo = $('presetUndo');
    undo.hidden = !(before && before.prefs && typeof before.prefs === 'object');
    if (!undo.hidden) {
      undo.textContent = '↶ ' + T('Undo {name}', { name: before.name || T('the preset') });
      undo.title = T('The switches as they were before you pressed {name}.', { name: before.name || T('the preset') });
      undo.onclick = () => {
        try {
          const back = before.prefs;
          if (prefs.player) back.player = prefs.player;
          back.tab = 'presets';
          localStorage.setItem('livemap', JSON.stringify(back));
          localStorage.removeItem('livemapBefore');
        } catch (e) { return; }
        again(() => location.reload());
      };
    }
  }
  $('colorReset').onclick = () => {
    for (const key of Object.keys(prefs.cols)) { const look = colLook(key); if (look) look.col = COL_HOME[key]; }
    prefs.cols = {};
    save();
    recolored();
    listColors();
  };
  // the kinds that can be announced, each with its switch
  function listAlerts(off) {
    const box = $('alerts');
    box.textContent = '';
    for (const kind of ALERTS) {
      if (!available(kind) || off.includes(kind)) continue;
      const row = document.createElement('label');
      row.className = 'row';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = prefs.alerts.includes(kind);
      input.onchange = () => {
        prefs.alerts = prefs.alerts.filter(k => k !== kind).concat(input.checked ? [kind] : []);
        save();
        announce();
      };
      const swatch = document.createElement('i');
      swatch.className = 'swatch';
      paintSwatch(swatch, KINDS[kind].col);
      const span = document.createElement('span');
      span.textContent = kind === 'Boss' ? T('Bosses, by name') : KINDS[kind].name;
      row.append(input, swatch, span);
      box.appendChild(row);
    }
  }
  // Who's shown, under Raid: each kind Off (no marker, no row), Rough area (only a circle they're somewhere in, while
  // they move; see AREA_ABLE) or On. Kept as before: Off is the kind hidden, Rough area is it in prefs.areaKinds.
  const WHO_STATES = [['off', T('Off'), T('Not on the map, not in the Raid list.')],
    ['area', T('Area'), T('No marker, name or row saying where they are: only a circle they are somewhere in, while they have been moving. Area size sets how big.')],
    ['on', T('On'), T('On the map and in the Raid list.')]];
  const whoState = kind => switchedOff(kind) ? 'off' : prefs.areaKinds.includes(kind) ? 'area' : 'on';
  function setWho(kind, state) {
    if (state === 'area' && !AREA_ABLE.includes(kind)) state = 'on';
    if (state === whoState(kind)) return;
    prefs.areaKinds = prefs.areaKinds.filter(k => k !== kind).concat(state === 'area' ? [kind] : []);
    setHidden(kind, state === 'off');
    tipFor = null;
    squadPanePrint = '';
    const now = chased !== null ? liveById.get(chased) : null;
    if (now && (inArea(now) || isHidden(now.c))) chase(null);
    listRoster();
  }
  function whoRow(kind, name, col, barred) {
    const row = document.createElement('div');
    row.className = 'row who';
    row.dataset.kind = kind;
    const swatch = document.createElement('i');
    swatch.className = 'swatch';
    swatch.style.background = col;
    const span = document.createElement('span');
    span.textContent = name + (barred ? ' ' + T('(off on the server)') : '');
    const seg = document.createElement('div');
    seg.className = 'seg tri';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', name);
    const show = () => { for (const b of seg.children) b.classList.toggle('on', !barred && b.dataset.v === whoState(kind)); };
    for (const [v, text, title] of WHO_STATES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.v = v;
      b.textContent = text;
      b.title = title;
      // a kind that can't be shown as an area (the people playing with you, the corpses): no middle choice
      if (v === 'area' && !AREA_ABLE.includes(kind)) { b.disabled = true; b.classList.add('none'); b.textContent = '–'; b.title = T('Always shown where they are, or not at all.'); }
      if (barred) b.disabled = true;
      b.onclick = () => { setWho(kind, v); show(); };
      seg.appendChild(b);
    }
    if (barred) {
      row.classList.add('blocked');
      row.title = T('Turned off on the server, for every page: config.jsonc in the mod\'s folder');
    }
    // (the switches over the list: All on, All as areas, All off, Default)
    row.setTo = state => { if (!barred) { setWho(kind, state); show(); } };
    show();
    row.append(swatch, span, seg);
    return row;
  }
  function filterRow(category, name, col, barred) {
    {
      const row = document.createElement('label');
      row.className = 'row';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !barred && !switchedOff(category);
      input.disabled = barred;
      if (barred) {
        row.classList.add('blocked');
        row.title = T('Turned off on the server, for every page: config.jsonc in the mod\'s folder');
      }
      input.onchange = () => setHidden(category, !input.checked);
      input.dataset.def = startOff.includes(category) ? '0' : '1';
      const swatch = document.createElement('i');
      swatch.className = 'swatch';
      paintSwatch(swatch, col);
      const span = document.createElement('span');
      span.textContent = name + (barred ? ' ' + T('(off on the server)') : '');
      row.append(input, swatch, span);
      return row;
    }
  }

  // The player's started quests, in the options: each goal not done yet, and a button to the places on this map it
  // sends them to (the quest's place, or where an item it wants lies now).
  function listQuests() {
    const shownPlaces = map && places && sameMap(places.loc, map.loc) ? places : null;
    const loot = inRaidHere() && things && sameMap(things.loc, map.loc) ? things : null;
    const where = goal => {
      const at = [];
      for (const z of shownPlaces ? shownPlaces.zones : []) if (list(goal.zones).includes(z.id)) at.push(z.p);
      for (const it of loot ? loot.loose : []) if (list(goal.items).includes(it.tpl)) at.push([it.x, it.y, it.z]);
      for (const b of shownPlaces && loot ? shownPlaces.boxes : []) {
        if (boxHidden(b)) continue;
        if ((loot.inside[b.id] || []).some(i => list(goal.items).includes(i[0]))) at.push(b.p);
      }
      return at;
    };
    const all = quests ? quests.list.concat(prefs.friendQuests ? quests.friends.flatMap(f => f.list.map(q => Object.assign({}, q, { who: f.who }))) : []) : [];
    const rows = all.map(q => {
      const goals = q.goals.map(g => ({ g, at: where(g) }));
      const here = goals.some(x => x.at.length) || sameLoc(q.loc, map && map.base)
        || q.goals.some(g => list(g.locs).some(l => sameLoc(l, map && map.base)));
      return { q, goals, here };
    }).sort((a, b) => (b.here ? 1 : 0) - (a.here ? 1 : 0) || a.q.name.localeCompare(b.q.name));
    const print = JSON.stringify([!!quests, map && map.loc, inRaidHere(), rows.map(r => [r.q.id, r.q.who || '', r.goals.map(x => x.g.id + ':' + x.at.length)])]);
    if (print === questsPrint) return;
    questsPrint = print;
    const box = $('questList');
    box.textContent = '';
    if (!quests) { box.textContent = T('No quests: the game shown hasn\'t been heard from.'); return; }
    if (!rows.length) { box.textContent = T('No quests started.'); return; }
    for (const { q, goals, here } of rows) {
      const item = document.createElement('details');
      item.className = 'quest' + (here ? ' here' : '');
      item.open = here;
      const head = document.createElement('summary');
      const elsewhere = !here && q.loc ? locationName(q.loc) : '';
      head.textContent = q.name + (q.who ? ' · ' + T("{who}'s quest", { who: q.who }) : '') + (q.trader ? ' · ' + q.trader : '') + (here ? ' · ' + T('on this map') : elsewhere ? ' · ' + elsewhere : '');
      item.appendChild(head);
      for (const { g, at } of goals) {
        const row = document.createElement('div');
        row.className = 'goal';
        const text = document.createElement('span');
        text.textContent = g.text || T('A goal');
        row.appendChild(text);
        if (at.length) {
          const go = document.createElement('button');
          go.type = 'button';
          go.textContent = at.length > 1 ? T('Go to') + ' (' + at.length + ')' : T('Go to');
          go.title = at.length > 1 ? T('Each press goes to the next of them') : '';
          let next = 0;
          go.onclick = () => {
            const p = at[next++ % at.length];
            goTo(p[0], p[1]);
          };
          row.appendChild(go);
        } else {
          // why there's nowhere to go: another map, a place not seen yet, or an item not lying about
          const locs = list(g.locs).filter(l => PLACES[l] || maps.some(m => sameLoc(m.base, l)));
          const other = q.loc && map && !sameLoc(q.loc, map.base) ? q.loc : locs.find(l => !map || !sameLoc(l, map.base));
          const note = document.createElement('small');
          note.className = 'goalNote';
          note.textContent = other ? T('On {map}', { map: locationName(other) })
        : list(g.zones).length ? T('Place not found on this map')
        : list(g.items).length ? (inRaidHere() ? T('None lying about') : T('In a raid')) : '';
          if (note.textContent) row.appendChild(note);
        }
        item.appendChild(row);
      }
      box.appendChild(item);
    }
  }

  // ---- this raid, on the left: who is in it, and its best loot ---------------------------------------------------
  // Who is in the raid, of the kinds shown on this page only (the list tells no more than the map does): the people
  // playing, then bosses and their like, the PMCs by the group they came in with, and the scavs last.
  // the Raid list's order: the player, friends, then bosses (and the Goons), their guards, Black Division, PMCs,
  // Rogues, the kinds mods bring and the cultists, Raiders, and the scavs last
  const ROSTER = ['Main Player', 'Friendly Player', 'Boss', 'Goon', 'Guard', 'Black Division', 'ISB WT', 'ISB', 'Enemy Player', 'Rogue', 'RUAF', 'RUAF Remnant', 'UNTAR', 'Cultist',
    'Bloodhound', 'Mercenary', 'Combine', 'Smuggler', 'Civilian', 'Infected', 'Other AI', 'Raider', 'Scav', 'Sniper'];
  // the kinds that can be shown as a rough area only, each with its switch
  const AREA_ABLE = ROSTER.filter(k => k !== 'Friendly Player' && k !== 'Main Player');
  let rosterPrint = null, bestPrint = null;
  const sideRow = (text, note, col, go) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'sideRow';
    const swatch = document.createElement('i');
    swatch.className = 'swatch';
    paintSwatch(swatch, col);
    const name = document.createElement('span');
    name.textContent = text;
    row.append(swatch, name);
    if (note) {
      const small = document.createElement('small');
      small.textContent = note;
      row.appendChild(small);
    }
    row.onclick = go;
    return row;
  };
  // A bot's row, with what it's like and is up to under its name, each as a tag of its own colour: how hard it is,
  // its SAIN personality (the bold ones warm, the timid ones cool), who decides for it now (SAIN red, solid while it
  // fights; COMET amber, likewise; ORBIT blue; an ORBIT ghost dashed grey; the game's own brain plain) and what it
  // carries, in its worth's colour.
  const PS_HOT = ['wreckless', 'gigachad', 'chad', 'snappingturtle'], PS_MEEK = ['timmy', 'coward', 'rat'];
  // a bot's difficulty and SAIN personality, added to what its row says when pointed at
  const traitsSaid = (row, m) => {
    const lines = [];
    if (m.df && prefs.botDiff !== false) lines.push(T('Difficulty') + ': ' + (DIFFICULTY[m.df] || m.df));
    if (m.ps && prefs.botSAIN !== false) lines.push(T('SAIN personality') + ': ' + m.ps);
    if (lines.length) row.title = (row.title ? row.title + '\n' : '') + lines.join('\n');
  };
  const chip = (text, cls, title) => {
    const c = document.createElement('i');
    c.className = 'chip ' + cls;
    c.textContent = text;
    if (title) c.title = title;
    return c;
  };
  // How hurt somebody is: a bar along the row's foot and the number beside their name, in green, amber or red. Pointed
  // at: each part of the body ("hb", sent while hurt), and a person's energy and water ("eh").
  const HP_PARTS = [[T('Head'), 35], [T('Chest'), 85], [T('Stomach'), 70], [T('Left arm'), 60], [T('Right arm'), 60], [T('Left leg'), 65], [T('Right leg'), 65]];
  const hpCol = part => part > 0.6 ? '#4cd964' : part > 0.3 ? '#ffb13d' : '#ff5148';
  function hpSaid(m) {
    const lines = [T('Health {hp} / {max}', { hp: m.hp[0], max: m.hp[1] })];
    if (Array.isArray(m.hb) && m.hb.length === HP_PARTS.length) {
      HP_PARTS.forEach(([name, max], i) => { const v = m.hb[i]; lines.push('   ' + name + ' ' + Math.round(v) + ' / ' + max + (v <= 0 ? ' · ' + T('blacked out') : '')); });
    } else if (m.hp[0] >= m.hp[1]) lines.push('   ' + T('Not hurt'));
    if (Array.isArray(m.eh) && m.eh.length === 2) lines.push(T('Energy {e} · Water {w}', { e: Math.round(m.eh[0]), w: Math.round(m.eh[1]) }));
    return lines.join('\n');
  }
  const hpBar = (row, m) => {
    if (!prefs.rosterHp || !prefs.health || !Array.isArray(m.hp) || !(m.hp[1] > 0)) return;
    const part = Math.max(0, Math.min(1, m.hp[0] / m.hp[1]));
    const bar = document.createElement('u'), fill = document.createElement('b');
    bar.className = 'hpBar';
    fill.style.width = Math.round(part * 100) + '%';
    fill.style.background = hpCol(part);
    if (part >= 0.98) fill.style.opacity = '0.45';
    bar.appendChild(fill);
    row.appendChild(bar);
    // (no number by the name: the bar says it, and pointed at, the row gives it in full)
    row.title = (row.title ? row.title + '\n' : '') + hpSaid(m);
  };
  const botLine = (row, m) => {
    hpBar(row, m);
    const carried = carriedBy(m);
    if (!hasDetails(m) && !carried) return row;
    const details = hasDetails(m), brain = details ? brainOf(m) : null;
    if (brain && brain.fight) row.classList.add('fight');
    // what it's doing now, and its squad's part in what COMET has the squad doing
    const doingTags = () => {
      const tags = [];
      if (!details || prefs.rosterDoing === false) return tags;
      if (m.ch) tags.push(chip(T('Cheater'), 'cheat', T('One of PBT\'s cheaters') + (m.chd ? '\n' + cheatSaid(m.chd) : '')));
      if (brain) {
        // who decides for it is the tag's colour (and in its hint): the room is for what it's doing
        const text = brain.ghost ? m.ob || T('Idle') : brain.text;
        tags.push(chip(text, 'by' + brain.by + (brain.fight ? ' fight' : ''),
          (brain.ghost || brain.by === 'EFT' ? text : brain.by + ' · ' + text) + '\n' + (brain.ghost ? T('ORBIT has this bot parked, far from every player') : brain.by === 'EFT' ? T('The game\'s own brain decides for it now') : T('{mod} decides for it now', { mod: brain.by }))));
      }
      if (m.sq && !(brain && brain.ghost)) {
        const q = m.sq, foe = squadFoe(q);
        tags.push(chip('⚑ ' + squadPart(q), 'bySquad' + (q.a ? ' fight' : ''),
          squadTactic(q) + '\n' + squadPart(q) + (q.a ? '' : ' ' + T('(preparing: COMET has not got it doing this yet)')) + (foe ? '\n' + T('Against {who}', { who: foe }) : '')
            + (q.m && q.f !== 'S04' ? '\n' + T('With {who}', { who: latin(q.m) }) : '') + '\n' + T('COMET has its squad acting together')));
      }
      return tags;
    };
    if (prefs.rosterSlim) {
      // one line: the name, then what it's doing
      row.classList.add('slim');
      const before = row.querySelector('small');
      const tags = doingTags(), told = tags.find(t => !t.classList.contains('cheat'));
      for (const tag of [tags.find(t => t.classList.contains('cheat')), told]) if (tag) row.insertBefore(tag, before);
    } else {
      const chips = document.createElement('span');
      chips.className = 'chips';
      if (details) {
        // (how hard it is and its SAIN personality: said when it's pointed at, so the row holds only what it's doing
        // and what it's worth)
        traitsSaid(row, m);
        if (prefs.rosterDoing !== false) {
          // there for every bot, so the rows don't change as what they do comes and goes
          const doing = document.createElement('span');
          doing.className = 'doing';
          for (const tag of doingTags()) doing.appendChild(tag);
          if (doing.childNodes.length) chips.appendChild(doing);
        }
      }
      if (carried && carried.total) {
        // (pressed: what it has, set out under it; the row itself only follows it on the map)
        const loot = chip(shortWorth(carried.total) + (rosterOpen === m.id ? ' ▴' : ' ▾'), 'loot gearBtn', T('What it wears and carries is worth {worth}. Press for the list.', { worth: roubles(carried.total) }));
        loot.style.color = worthCol(carried.total);
        loot.onclick = e => { e.stopPropagation(); rosterOpen = rosterOpen === m.id ? null : m.id; rosterPrint = null; listRoster(); };
        chips.appendChild(loot);
      }
      if (chips.childNodes.length) {
        row.classList.add('two');
        row.appendChild(chips);
      }
    }
    // the one pressed: what it has on and carries, set out under it
    if (carried && rosterOpen === m.id) {
      const gear = document.createElement('span');
      gear.className = 'gear';
      const line = (label, text, worth) => {
        const a = document.createElement('i'), b = document.createElement('span'), c = document.createElement('em');
        a.textContent = label;
        b.textContent = text;
        b.title = text;
        c.textContent = worth ? roubles(worth) : '';
        c.style.color = worth ? worthCol(worth) : '';
        gear.append(a, b, c);
      };
      for (const g of carried.worn) line(g.label, g.text, g.worth);
      carried.held.forEach((h, i) => line(i ? '' : carried.worn.length ? T('Carrying') : T('Has'), h.text, h.worth));
      if (carried.more > 0) line('', T('…and {n} more', { n: carried.more }), 0);
      (carried.secure || []).forEach((k, i) => line(i ? '' : T('Secure container'), k.text + ' (' + T('can\'t be looted') + ')', 0));
      (carried.stashed || []).forEach((e, i) => line(i ? '' : T('Secure container'), e.d.i + (e.d.q > 1 ? ' ×' + e.d.q : '') + ' (' + T('picked up, can\'t be looted') + ')', 0));
      row.appendChild(gear);
    }
    return row;
  };
  // the one in the Raid list whose gear is set out
  let rosterOpen = null;
  // how far each one listed is from the player, kept up to date without making the list again
  let rosterFar = new Map();
  const farText = d => (d < 100 ? Math.round(d / 5) * 5 : Math.round(d / 10) * 10) + ' m';
  // (how far from the player: not said of the player)
  const farOf = m => me && inRaidHere() && m.c !== 'Main Player' && Number.isFinite(m.cx) ? Math.hypot(m.cx - me.cx, m.cy - me.cy) : NaN;
  function showFar() {
    for (const [id, el] of rosterFar) {
      const m = liveById.get(id);
      const d = m ? farOf(m) : NaN;
      const text = Number.isFinite(d) ? farText(d) : '';
      if (el.textContent !== text) el.textContent = text;
    }
  }
  // the one in the Raid list the pointer is over: ringed on the map
  let rosterOver = null;
  // a group's title in the Raid list: pressed, the group is folded away (and kept so)
  const rosterIsShut = key => prefs.rosterShut.includes(key);
  const foldRoster = key => {
    prefs.rosterShut = rosterIsShut(key) ? prefs.rosterShut.filter(k => k !== key) : prefs.rosterShut.concat([key]);
    save();
    rosterPrint = null;
    listRoster();
  };
  const sideHead = (text, key) => {
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'filterHead fold' + (rosterIsShut(key) ? ' shut' : '');
    head.textContent = text;
    head.title = rosterIsShut(key) ? T('Show these') : T('Fold these away');
    head.onclick = () => foldRoster(key);
    return head;
  };
  // The Raid list is a panel of its own beside the map; on a phone it's in the menu's Raid tab
  // (on the history page it's always the panel's, a sheet on a phone: see placeQuick)
  const rosterShown = () => phone.matches && !HIST ? !$('panel').hidden && tab === 'raid' : !$('side').hidden;
  function listRoster() {
    if (!rosterShown()) { showSquadPane(); return; }
    const raid = inRaid();
    // Without who's alive: everyone seen this raid, as first seen, and only the dead a player killed (their bodies
    // say so) are known to be dead; nothing that changes while they live is shown (where, how far, what they do).
    const fog = prefs.rosterFog && raid;
    const known = new Set();
    if (fog) {
      for (const c of corpsesNow || live.filter(k => k.c === 'Corpse')) {
        const pid = c.pid || (c.body && c.body.pid);
        if (pid && (c.kp || bodySeen(c))) known.add(pid);
      }
    }
    const rows = !raid ? [] : fog ? [...seenRoster.values()].filter(m => !isHidden(m.c)).map(m => Object.assign({}, m, { fogDead: !!m.pid && known.has(m.pid) }))
      : live.filter(m => ROSTER.includes(m.c) && !isHidden(m.c));
    // nearest first, when asked: the order is then part of what the list is
    const near = prefs.rosterNear && !!me && inRaidHere() && !fog;
    // ORBIT's ghosts (parked far from every player): with their kind, in a group of their own at the end, or left out
    const apart = !fog && prefs.rosterGhosts !== 'in';
    const ghosts = apart && prefs.rosterGhosts === 'own' ? rows.filter(m => m.gh) : [];
    const main = apart ? rows.filter(m => !m.gh) : rows;
    const hpOf = m => prefs.rosterHp && prefs.health && Array.isArray(m.hp) && m.hp[1] > 0 ? Math.round(m.hp[0] / m.hp[1] * 25) : '';
    if (near) for (const list of apart ? [rows, main] : [rows]) list.sort((a, b) => (inArea(a) ? 1e9 : farOf(a) || 0) - (inArea(b) ? 1e9 : farOf(b) || 0));
    const print = raid + '|' + near + '|' + fog + '|' + peeking() + '|' + prefs.botDetails + (prefs.botDiff !== false) + prefs.areaKinds.join('.') + Object.keys(BOT_MODS).map(n => modOn(n) ? 1 : 0).join('') + '|' + prefs.botLoot + thingsHave + '|' + rosterOpen + '|' + chased + '|' + prefs.rosterShut.join('.') + prefs.rosterGhosts + [prefs.rosterSlim, prefs.rosterDoing].join('') + '|' + rows.map(m => [m.id, hpOf(m), m.c, m.t, m.lv || 0, m.g || '', m.df || '', m.ps || '', m.ly || '', m.gh || 0, m.ob || '', m.cm || '', m.bg || '', m.os || '', m.ch || 0, m.sq ? [m.sq.f, m.sq.s, m.sq.a || 0, m.sq.r || '', m.sq.u || '', m.sq.x || 0, m.sq.p || '', m.sq.c || ''].join('~') : '', m.fogDead ? 1 : 0].join(':')).join(',')
      + '|' + squadLogOpen + '|' + (squadEvents.length ? squadEvents[squadEvents.length - 1].n : 0);
    if (print === rosterPrint) { showFar(); return; }
    rosterPrint = print;
    const box = $('roster');
    box.textContent = '';
    rosterFar = new Map();
    // how many of each kind, at the top: only while the list is nearest first (in groups, each group's title says)
    const sum = $('rosterSum');
    sum.textContent = '';
    for (const kind of near ? ROSTER : []) {
      const count = rows.filter(m => m.c === kind).length;
      if (!count) continue;
      const tag = chip((ONE[kind] || kind) + ' ' + count, 'count' + (rosterIsShut(kind) && !near ? ' shut' : ''), KINDS[kind].name + (near ? '' : '. ' + T('Press to fold these away, or show them')));
      if (!near) tag.onclick = () => foldRoster(kind);
      const swatch = document.createElement('b');
      paintSwatch(swatch, KINDS[kind].col);
      tag.prepend(swatch);
      sum.appendChild(tag);
    }
    // (out of a raid: said in the middle of the list's box)
    if (!raid) { box.textContent = ''; box.appendChild(mk('p', 'rosterNone', T('Not in a raid.'))); showSquadPane(); return; }
    if (!rows.length) { box.textContent = phone.matches ? T('Nobody to list. Who is listed is set under Who\'s shown, below.') : T('Nobody to list. Who is listed is set under Who\'s shown, in the menu\'s Raid tab.'); showSquadPane(); return; }
    // Pressing somebody: the map goes to them and stays on them (their gear is set out from the worth beside their
    // name, not by following them). A drag, or a press anywhere else, lets them go.
    const go = m => () => {
      const now = liveById.get(m.id);
      rosterPrint = null;
      // (the player pressed: the map follows them again)
      if (m.c === 'Main Player' && !HIST) { setFollow(true); listRoster(); return; }
      if (now && inRaidHere()) watch(now);
      listRoster();
    };
    // after the name: the team's number in its colour, as on the map
    const teamDot = (row, m) => {
      if (!teamOn(m)) return;
      const n = squadNo(teamKey(m)), dot = mk('i', 'squadDot', String(n));
      dot.style.background = squadCol(n);
      dot.title = T('Team {n}', { n });
      row.children[1].after(dot);
    };
    // beside the name: the level, and the kind too when the list isn't in groups (nearest first)
    const sub = m => near ? (ONE[m.c] || m.c) + (levelShown(m.lv, m.c) ? ' · ' + T('Lv {n}', { n: m.lv }) : '') : levelShown(m.lv, m.c) ? T('Lv {n}', { n: m.lv }) : ' ';
    const one = m => {
      if (fog || inArea(m)) {
        // a name, its kind's colour, its level, and alive or not as far as anyone can tell
        const row = sideRow(m.t || (ONE[m.c] || m.c), sub(m), KINDS[m.c].col, () => {});
        // not pressed, and not ringed on the map when pointed at: that would say where they are
        row.disabled = true;
        const state = document.createElement('small');
        state.className = 'far fog' + (m.fogDead ? ' dead' : '');
        state.textContent = m.fogDead ? T('Dead') : '?';
        state.title = m.fogDead ? T('Killed by a player, or you have been by its body') : T('Not known whether still alive');
        row.insertBefore(state, row.children[2] || null);
        teamDot(row, m);
        if (prefs.botDetails) traitsSaid(row, m);
        return row;
      }
      const row = sideRow(m.t || (ONE[m.c] || m.c), sub(m), KINDS[m.c].col, go(m));
      row.dataset.id = m.id;
      if (chased === m.id) row.classList.add('chased');
      if (rosterOpen === m.id) row.classList.add('open');
      const far = document.createElement('small');
      far.className = 'far';
      row.insertBefore(far, row.children[2] || null);
      teamDot(row, m);
      rosterFar.set(m.id, far);
      return botLine(row, m);
    };
    const listGhosts = () => {
      if (!ghosts.length) return;
      box.appendChild(sideHead(T('ORBIT ghosts') + ' · ' + ghosts.length, 'Ghosts'));
      if (rosterIsShut('Ghosts')) return;
      const order = m => (KINDS[m.c] || OTHER).order;
      for (const m of ghosts.slice().sort((a, b) => order(b) - order(a) || (a.t || '').localeCompare(b.t || ''))) box.appendChild(one(m));
    };
    if (near) {
      for (const m of main) { const row = one(m); row.title = (ONE[m.c] || m.c) + (row.title ? '\n' + row.title : ''); box.appendChild(row); }
      listGhosts();
      squadLog(box);
      showFar();
      return;
    }
    for (const kind of ROSTER) {
      const of = main.filter(m => m.c === kind).sort((a, b) => (a.t || '').localeCompare(b.t || ''));
      if (!of.length) continue;
      box.appendChild(sideHead(KINDS[kind].name + ' · ' + of.length, kind));
      if (rosterIsShut(kind)) continue;
      if (kind !== 'Enemy Player') { for (const m of of) box.appendChild(one(m)); continue; }
      // PMCs: each group that came in together, the biggest first, then the ones on their own
      const groups = new Map();
      for (const m of of) {
        const key = m.g || (m.bg ? 'bot:' + m.bg : 'solo:' + m.id);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(m);
      }
      const sets = [...groups.values()].sort((a, b) => b.length - a.length);
      for (const set of sets.filter(g => g.length > 1)) {
        const group = document.createElement('div');
        group.className = 'sideGroup';
        const title = document.createElement('small');
        title.textContent = T('Group of {n}', { n: set.length });
        group.appendChild(title);
        // what COMET has them doing together: each plan once
        const plans = new Map();
        for (const m of set) if (m.sq && hasDetails(m) && !inArea(m) && !plans.has(m.sq.p || m.sq.f)) plans.set(m.sq.p || m.sq.f, set.filter(o => o.sq && (o.sq.p || o.sq.f) === (m.sq.p || m.sq.f)));
        for (const of of plans.values()) {
          const going = of.some(o => o.sq.a), foe = squadFoe(of[0].sq);
          const plan = document.createElement('small');
          plan.className = 'tactic' + (going ? ' going' : '');
          plan.textContent = squadTactic(of[0].sq) + ' · ' + (going ? T('in progress') : T('preparing'));
          plan.title = T('{n} of {of} in it', { n: of.length, of: set.length }) + (foe ? ', ' + T('against {who}', { who: foe }) : '') + (going ? '' : '. ' + T('Preparing: COMET has not got them doing it yet'));
          group.appendChild(plan);
          group.classList.add('acting');
        }
        for (const m of set) group.appendChild(one(m));
        box.appendChild(group);
      }
      for (const set of sets.filter(g => g.length === 1)) box.appendChild(one(set[0]));
    }
    listGhosts();
    squadLog(box);
    showFar();
  }
  // ---- what happened in the raid ----
  // Beside where everybody is now, the game says what happened, each thing once: {"n","t","k","p","nm","d"} (its
  // number in the raid, when on the raid's clock in ms, its kind, whose, their name, the rest). They come with the
  // full reports ("rid" the raid, "ev" the new ones); a page opened later asks the server for the raid so far.
  // So far only "comet.squad": what COMET has a bot doing with its squad, whenever that changes.
  const SIGHT_MS = 1400, SIGHT_REARM_MS = 5000, SHARE_MS = 2400;
  const liveSightUntil = new Map(), liveLastSight = new Map();
  // A brief loss of visibility is still the same encounter. Remember the last report,
  // but only the start of a contact pulses the marker.
  function startsSightContact(lastSight, observer, target, time) {
    if (!observer || !target || !Number.isFinite(time)) return false;
    let targets = lastSight.get(observer);
    if (!targets) {
      targets = new Map();
      lastSight.set(observer, targets);
    }
    const last = targets.get(target);
    if (last !== undefined && time <= last) return false;
    targets.set(target, time);
    return last === undefined || time - last >= SIGHT_REARM_MS;
  }
  let liveShares = [];
  const liveVoices = new Map();
  let squadEvents = [], eventsRaid = '', eventsSeen = new Set(), squadLogOpen = false;
  function addEvents(list, fresh, clock) {
    let added = false, killed = false, others = false;
    for (const e of list || []) {
      if (!e || !Number.isFinite(e.n) || eventsSeen.has(e.n) || !e.d) continue;
      if (e.k === 'bot.share' || e.k === 'bot.voice' || e.k === 'grenade.blast') {
        eventsSeen.add(e.n);
        const age = clock - e.t, now = performance.now();
        if (!replay && fresh && age >= 0) {
          if (e.k === 'bot.share' && e.p && e.d.to && age < SHARE_MS) {
            liveShares = liveShares.filter(s => now - s.t < SHARE_MS);
            liveShares.push({ t: now - age, from: e.p, to: e.d.to });
            dirty = true;
          } else if (e.k === 'bot.voice' && e.p && e.d.phrase && age < SHARE_MS) {
            liveVoices.set(e.p, { t: now - age, phrase: e.d.phrase });
            dirty = true;
          } else if (e.k === 'grenade.blast' && Array.isArray(e.d.at) && age < BLAST_MS) {
            const b = blastEvent(e, now - age);
            const who = b.pid && live.find(m => m.pid === b.pid);
            b.fx = who?.cx; b.fy = who?.cy;
            blastMarks = blastMarks.filter(old => old.confirmed || !sameBurst(old, b));
            blastMarks.push(b);
            dirty = true;
          }
        }
        continue;
      }
      if (e.k === 'bot.sight') {
        eventsSeen.add(e.n);
        const age = clock - e.t;
        if (!replay && startsSightContact(liveLastSight, e.p, e.d.target, e.t) && fresh && age >= 0 && age < SIGHT_MS) {
          const until = performance.now() + SIGHT_MS - age;
          liveSightUntil.set(e.p, Math.max(liveSightUntil.get(e.p) || 0, until));
          dirty = true;
        }
        continue;
      }
      if (e.k === 'kill') {
        eventsSeen.add(e.n);
        // heard as it happened (not asked for afterwards): shown at the top of the map for a few seconds
        e.at = fresh ? performance.now() : -1e9;
        killEvents.push(e);
        killed = true;
        continue;
      }
      if (e.k === 'loot' || e.k === 'door' || e.k === 'orbit.wake' || e.k === 'orbit.fight' || e.k === 'orbit.hear' || e.k === 'orbit.leave') {
        eventsSeen.add(e.n);
        otherEvents.push(e);
        if (e.k === 'loot') fromAirdrop(e);
        if (fresh && (e.k === 'loot' || e.k === 'door')) floatLoot(e);
        if (otherEvents.length > 600) {
          // (doors go first: a busy map's doors aren't to push the pick-ups out)
          const doors = otherEvents.filter(x => x.k === 'door');
          if (doors.length > 200) { const old = new Set(doors.slice(0, doors.length - 200)); otherEvents = otherEvents.filter(x => !old.has(x)); }
          if (otherEvents.length > 600) otherEvents.splice(0, otherEvents.length - 600);
        }
        if (fresh && e.k === 'orbit.fight' && Array.isArray(e.d.a) && Array.isArray(e.d.b)) ghostMarks.push({ k: 'fight', a: e.d.a, b: e.d.b, n: e.d.n, until: performance.now() + FIGHT_MS });
        if (fresh && e.k === 'orbit.hear' && Array.isArray(e.d.l) && Array.isArray(e.d.s)) ghostMarks.push({ k: 'hear', l: e.d.l, s: e.d.s, r: e.d.r || 0, inv: !!e.d.inv, until: performance.now() + HEAR_MS });
        others = true;
        continue;
      }
      // (a room's light switch, as an older plugin told them too: left out)
      if (e.k === 'switch') { eventsSeen.add(e.n); if (e.d.id && !lightSwitch(e.d)) switchNow.set(e.d.id, e); dirty = true; continue; }
      // a magazine dropped in a quick reload, and a bot going back for it (COMET): the latest of each
      if (e.k === 'comet.mag') { eventsSeen.add(e.n); if (e.d.id) magNow.set(e.d.id, e); dirty = true; continue; }
      if (e.k === 'orbit.main') { eventsSeen.add(e.n); orbitMain = e; orbitReceivedAt = performance.now(); dirty = true; continue; }
      if (e.k === 'orbit.field') { eventsSeen.add(e.n); orbitField = e; dirty = true; continue; }
      if (e.k === 'phobos.field') { eventsSeen.add(e.n); phobosField = e; dirty = true; continue; }
      if (e.k === 'drop') { eventsSeen.add(e.n); if (fresh) floatLoot(e); continue; }
      if (e.k !== 'comet.squad') continue;
      eventsSeen.add(e.n);
      squadEvents.push(e);
      added = true;
    }
    if (killed) {
      killEvents.sort((a, b) => a.n - b.n);
      if (killEvents.length > 400) killEvents.splice(0, killEvents.length - 400);
      showKills();
    }
    if (others) { otherEvents.sort((a, b) => a.n - b.n); squadPanePrint = ''; showSquadPane(); dirty = true; }
    if (!added) return;
    squadEvents.sort((a, b) => a.n - b.n);
    if (squadEvents.length > 300) squadEvents.splice(0, squadEvents.length - 300);
    listRoster();
  }
  function takeEvents(d) {
    const rid = d.raid && d.rid ? d.rid : '';
    if (rid !== eventsRaid) {
      eventsRaid = rid;
      liveSightUntil.clear(); liveLastSight.clear(); liveVoices.clear(); liveShares = [];
      squadEvents = [];
      otherEvents = [];
      ghostMarks = [];
      killEvents = [];
      switchNow = new Map();
      magNow = new Map();
      orbitMain = orbitField = phobosField = null;
      huntSnapshot = null; huntsByMember.clear();
      indexedOrbitMain = null; orbitByMember.clear();
      eventsSeen = new Set();
      if (!replay) forgetSquads();
      showKills();
      if (rid && !replay) {
        fetch('api/events?after=0' + (sid ? '&session=' + encodeURIComponent(sid) : '')).then(r => r.json())
          .then(j => { if (j && j.rid === eventsRaid) addEvents(j.ev); }).catch(() => {});
      }
    }
    addEvents(d.ev, true, d.clk);
  }
  // ---- the kill feed ----
  // Who killed whom ("kill" events), in a corner of the map as it happens: the latest few (or each for FEED_MS). Its
  // count, pressed, folds the kills away and back (prefs.feedFolded); its × turns the feed off (Map > Kill feed turns
  // it back on). Which kills are told is chosen in the options: by who died, and whether it was the player's or a
  // friend's doing.
  let killEvents = [], feedPrint = '';
  const FEED_MS = 9000, FEED_BIG = ['Boss', 'Goon', 'Guard', 'Cultist'], FEED_OURS = ['Main Player', 'Friendly Player'];
  function killTold(e) {
    const d = e.d;
    if (FEED_OURS.includes(d.kk) || FEED_OURS.includes(d.vk)) return prefs.feedMine !== false;
    if (d.vk === 'Enemy Player') return prefs.feedPmc !== false;
    if (FEED_BIG.includes(d.vk)) return prefs.feedBoss !== false;
    return !!prefs.feedAi;
  }
  const PARTS = { Head: T('head'), Chest: T('chest'), Stomach: T('stomach'), LeftArm: T('arm'), RightArm: T('arm'), LeftLeg: T('leg'), RightLeg: T('leg') };
  function killRow(e, clock) {
    const d = e.d, row = document.createElement('div');
    row.className = 'kill';
    const name = (text, kind) => {
      const b = document.createElement('b');
      b.textContent = text;
      b.style.color = inkOf((KINDS[kind] || OTHER).col);
      b.title = ONE[kind] || kind || '';
      return b;
    };
    if (clock) { const t = document.createElement('time'); t.textContent = raidClock(e.t || 0); row.appendChild(t); }
    // whose names are given: everyone's, not the killer's, or nobody's (the player and their friends always)
    const bare = (kind, hide) => hide && !FEED_OURS.includes(kind);
    const victim = name(e.nm && !bare(d.vk, prefs.feedNames === 'kinds') ? latin(e.nm) : ONE[d.vk] || d.vk || T('Somebody'), d.vk);
    // a killer whose kind isn't shown on the map isn't named, nor how far they were: that would say where they are
    const killerSeen = d.kk === 'Main Player' || (!!d.kk && !isHidden(d.kk) && !prefs.areaKinds.includes(d.kk));
    if (d.k && killerSeen) {
      row.appendChild(name(d.kn && !bare(d.kk, prefs.feedNames !== 'all') ? latin(d.kn) : ONE[d.kk] || d.kk || T('Somebody'), d.kk));
      const how = document.createElement('i');
      how.textContent = d.w || T('killed');
      row.append(how, victim);
    } else {
      const how = document.createElement('i');
      how.textContent = d.self ? T('killed themselves') : d.k ? T('was killed') : T('died');
      row.append(victim, how);
    }
    // with nobody else to say it by, what did it (a grenade, a fall)
    const more = [d.k ? '' : d.w || '', PARTS[d.bp] || '', Number.isFinite(d.m) && d.k && killerSeen ? d.m + ' m' : ''].filter(Boolean).join(' · ');
    if (more) { const s = document.createElement('small'); s.textContent = more; row.appendChild(s); }
    // in a replay: a way to the fight it ended (as Raid Review's [VIEW])
    if (HIST && replay) {
      const view = document.createElement('button');
      view.type = 'button';
      view.className = 'killView';
      view.textContent = T('View');
      view.title = T('Play the fight that ended in this kill');
      view.onclick = () => viewKill(e);
      row.appendChild(view);
    }
    return row;
  }
  // in the bottom corner on the menu's side, beside the menu when it's open; on a phone, at the top (the stylesheet)
  function placeFeed(box) {
    document.body.style.setProperty('--feed-bg', String(prefs.feedBg / 100));
    if (phone.matches) { box.style.left = box.style.right = box.style.bottom = box.style.top = ''; box.classList.remove('toLeft', 'toTop', 'free'); return; }
    const swap = !!prefs.swap, panel = $('panel'), open = !panel.hidden && !document.body.classList.contains('bare');
    // where it was dragged to: kept to its edges, so it grows away from them as kills come in
    const at = prefs.feedPos === 'free' ? prefs.feedAt : null;
    box.classList.toggle('free', !!at);
    if (at) {
      const W = window.innerWidth, H = window.innerHeight;
      box.classList.toggle('toLeft', !!at.l);
      box.classList.toggle('toTop', !!at.t);
      const ax = Math.max(4, Math.round(at.x * W)), ay = Math.max(4, Math.round(at.y * H));
      box.style.left = at.l ? ax + 'px' : 'auto';
      box.style.right = at.l ? 'auto' : ax + 'px';
      box.style.top = at.t ? ay + 'px' : 'auto';
      box.style.bottom = at.t ? 'auto' : ay + 'px';
      return;
    }
    // the corner asked for (Map > Kill feed > Position), or the bottom one on the menu's side
    const pos = prefs.feedPos === 'auto' ? (swap ? 'bl' : 'br') : prefs.feedPos;
    const left = pos[1] === 'l', top = pos[0] === 't';
    // beside whatever panel is open on that side: the menu (the screen's whole height), the Raid list (the top only)
    let gap = 10;
    for (const el of [panel, $('side')]) {
      if (el.hidden || (el === panel && !open) || (el !== panel && (!top || document.body.classList.contains('bare')))) continue;
      const r = el.getBoundingClientRect();
      if (r.width && (r.left + r.width / 2 < window.innerWidth / 2) === left) gap = Math.max(gap, (left ? r.right : window.innerWidth - r.left) + 8);
    }
    box.classList.toggle('toLeft', left);
    box.classList.toggle('toTop', top);
    box.style.left = left ? gap + 'px' : 'auto';
    box.style.right = left ? 'auto' : gap + 'px';
    // clear of what else is in that corner: the bar (top), the scale and the pointer's place (bottom left), the keys' hint (bottom right)
    box.style.top = top ? Math.round($('bar').getBoundingClientRect().bottom + 8) + 'px' : 'auto';
    box.style.bottom = top ? 'auto' : (left ? $('readout').offsetHeight + 18 : gap > 10 ? 10 : 34) + 'px';
  }
  function showKills() {
    let box = $('killFeed');
    if (!box) {
      box = document.createElement('div');
      box.id = 'killFeed';
      box.innerHTML = '<div id="killList"></div><div id="killHead"><button id="killCount" type="button"></button><button id="killClose" type="button">×</button></div>';
      document.body.appendChild(box);
      $('killCount').onclick = () => { prefs.feedFolded = !prefs.feedFolded; save(); feedPrint = ''; showKills(); };
      $('killClose').onclick = () => { prefs.feed = false; $('optFeed').checked = false; save(); dirty = true; feedPrint = ''; showKills(); };
      // picked up anywhere and put down anywhere, on the grid (Map > Kill feed > Position: "Where I put it"); it then
      // grows away from the window's nearer edges
      draggable(box, box, (x, y, start) => {
        const s = snapPanel(box, x, y), W = window.innerWidth, H = window.innerHeight;
        const l = s[0] + start.width / 2 < W / 2, t = s[1] + start.height / 2 < H / 2;
        prefs.feedAt = { l, t, x: (l ? s[0] : W - s[0] - start.width) / W, y: (t ? s[1] : H - s[1] - start.height) / H };
        prefs.feedPos = 'free';
        $('optFeedPos').value = 'free';
        save(); feedPrint = ''; showKills();
      }, (x, y) => snapPanel(box, x, y));
    }
    const told = prefs.feed !== false && inRaid() ? killEvents.filter(killTold) : [];
    const now = performance.now();
    const folded = !!prefs.feedFolded;
    const rows = folded ? [] : told.filter(e => prefs.feedKeep || now - e.at < FEED_MS).slice(-prefs.feedRows);
    const print = folded + '|' + prefs.feedBox + '|' + prefs.feedNames + '|' + told.length + '|' + rows.map(e => e.n).join(',');
    box.hidden = !told.length;
    placeFeed(box);
    if (print === feedPrint) return;
    feedPrint = print;
    $('killCount').textContent = (folded ? '▸ ' : '▾ ') + T('Kills') + ' · ' + told.length;
    $('killCount').title = folded ? T('Show the kills') : T('Fold the kills away');
    $('killClose').title = T('Turn the kill feed off (Map > Kill feed turns it back on)');
    const list = $('killList');
    list.textContent = '';
    list.hidden = !rows.length;
    // a bubble round each kill, or all in one box with the raid time of each (Map > Kill feed > All in one box)
    list.classList.toggle('box', !!prefs.feedBox);
    for (const e of rows) list.appendChild(killRow(e, !!prefs.feedBox));
  }
  setInterval(() => { showKills(); sidesNow(); }, 1000);
  const raidClock = ms => Math.floor(ms / 60000) + ':' + String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  // the last dozen, the newest first, shut until asked for; pressing one goes to that bot, when it's still on the map
  // what's picked up, and what ORBIT's ghosts do: the other events the panel lists
  let otherEvents = [];
  const EVENT_KINDS = [['all', 'All'], ['tactic', 'Tactic', 'What each squad is doing together (COMET). Press one, or a bot in one, to see its members.'], ['squad', 'Squads'], ['loot', 'Loot'], ['door', 'Doors', 'Doors opened, shut and unlocked, and by whom (the one nearest the door).'], ['orbit', 'ORBIT']];
  const eventKind = e => e.k === 'comet.squad' ? 'squad' : e.k === 'loot' ? 'loot' : e.k === 'door' ? 'door' : 'orbit';
  // a door opened, shut or unlocked (the game's plugin says by whom: the one nearest it)
  // (a recording from before the plugin knew how a door last stood says "Interacting" for before: shut then could be
  // an unlock as well, so it isn't guessed)
  const doorSaid = d => d.was === 'Locked' ? T('Unlocked a door') : d.st === 'Open' ? T('Opened a door') : d.was === 'Open' ? T('Shut a door') : T('Used a door');
  // A pick-up from an airdrop's crate: one by an airdrop on the map as it's picked up (worked out once, then kept on
  // the event, so the lists say it later too)
  function fromAirdrop(e) {
    if (e.d.ad === undefined && Array.isArray(e.d.at)) {
      const drop = live.find(m => m.c === 'Airdrop' && !m.fall && Number.isFinite(m.cx) && Math.hypot(m.cx - e.d.at[0], m.cy - e.d.at[1]) < 4);
      if (drop || live.length) e.d.ad = drop ? 1 : 0;
    }
    return e.d.ad === 1;
  }
  const lootWorth = d => { const n = things && things.names ? things.names[d.tpl] : replay && replay.names ? replay.names[d.tpl] : null; return n && n.p ? n.p * (d.q || 1) : NaN; };
  // a bot's kind by its profile id: as it is now, or as it was first seen this raid (gone since, or dead); worked out
  // again only when the game has sent the markers anew
  let pidKinds = new Map(), pidKindsOf = null, pidKindsSeen = -1;
  function kindOfPid(pid) {
    if (pidKindsOf !== live || pidKindsSeen !== seenRoster.size) {
      pidKinds = new Map();
      for (const m of seenRoster.values()) if (m.pid) pidKinds.set(m.pid, m.c);
      for (const m of live) if (m.pid && m.c !== 'Corpse') pidKinds.set(m.pid, m.c);
      pidKindsOf = live;
      pidKindsSeen = seenRoster.size;
    }
    return pidKinds.get(pid) || null;
  }
  // whoever it was is shown (or isn't known): not of a kind switched off, nor shown only as a rough area
  const pidShown = pid => { const c = pid ? kindOfPid(pid) : null; return !c || (!isHidden(c) && !prefs.areaKinds.includes(c)); };
  // the events the panel can list
  const EVENT_KEPT = new Set(['comet.squad', 'loot', 'door', 'orbit.wake', 'orbit.fight', 'orbit.hear']);
  // (least: what loot must be worth to be told of; the map's Worth at least unless said)
  function eventListed(e, tab, least = prefs.worth) {
    const kind = eventKind(e);
    if (tab !== 'all' && tab !== kind) return false;
    // What a bot did (with its squad, or as one of ORBIT's ghosts) is told only while its kind is shown, so a kind
    // switched off isn't given away here either. Not knowing whose it is (a ghost fight): only while some bot is shown.
    if (kind === 'squad' || kind === 'orbit') {
      if (!(kind === 'squad' ? modOn('COMET') && !prefs.areaKinds.includes('Enemy Player') : modOn('ORBIT'))) return false;
      const c = e.p ? kindOfPid(e.p) : null;
      return c ? !isHidden(c) && !prefs.areaKinds.includes(c) : !ROSTER.every(k => k === 'Main Player' || k === 'Friendly Player' || isHidden(k));
    }
    // (a door, by who it was: not while their kind is switched off)
    if (kind === 'door') return prefs.doorEvents !== false && pidShown(e.p);
    if (prefs.areaKinds.includes(e.d.wk)) return false;
    if (e.d.wk && isHidden(e.d.wk)) return false;
    // what isn't worth showing as loot isn't worth telling of either (a quest item always is)
    const worth = lootWorth(e.d);
    return !!e.d.qi || !Number.isFinite(worth) || worth >= least;
  }
  function eventSaid(e) {
    const d = e.d;
    if (e.k === 'comet.squad') return ['', squadSaid(d), '#ffc56e'];
    if (e.k === 'loot') {
      const worth = lootWorth(d);
      return ['', T('Picked up {item}', { item: d.i }) + (d.q > 1 ? ' ×' + d.q : '') + (Number.isFinite(worth) ? ' · ' + roubles(worth) : '') + (d.qi ? ' · ' + T('quest item') : '')
        + (d.ad === 1 ? ' · ' + T('from the airdrop') : '') + (d.in === 'SecuredContainer' ? ' · ' + T('into its secure container') : ''), Number.isFinite(worth) ? worthCol(worth) : '#e8e9eb'];
    }
    if (e.k === 'door') return ['', doorSaid(d), '#d9c29a'];
    if (e.k === 'orbit.wake') return ['', T('Woke') + ' · ' + words(d.c || 'woken') + (d.by ? ' · ' + T('by {who}', { who: latin(d.by) }) : '') + (d.m ? ' · ' + d.m + ' m' : ''), '#9fd8ff'];
    if (e.k === 'orbit.fight') return [T('Ghost fight'), T('{n} dead', { n: d.n || 0 }) + ' · ' + (d.s || 0) + ' s', '#ff8d84'];
    if (e.k === 'orbit.leave') return ['', T('Heading out: {why}', { why: extractReason(d.why) || '' }), '#9fd8ff'];
    return [e.nm ? '' : T('A ghost'), (d.sh ? TP(d.sh, 'Heard {n} shot', 'Heard {n} shots') : T('Heard a noise')) + (d.m ? ' · ' + T('{n} m off', { n: d.m }) : '') + (d.inv ? ' · ' + T('going to look') : ''), '#9fd8ff'];
  }
  // (in a replay, pressing it plays the raid from a moment before it)
  const squadRow = e => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'squadEvent';
    const when = document.createElement('time'), who = document.createElement('b'), what = document.createElement('span');
    const said = eventSaid(e);
    when.textContent = raidClock(e.t || 0);
    who.textContent = said[0] || (e.nm ? latin(e.nm) : T('A bot'));
    what.textContent = said[1];
    what.style.color = said[2];
    row.append(when, who, what);
    row.title = who.textContent + '\n' + what.textContent;
    row.onclick = () => {
      if (replay && Number.isFinite(e.rt)) { seekReplay(Math.max(0, e.rt - 2000)); replay.playing = true; rvWas = true; replayShown = ''; showReplay(); squadPanePrint = ''; }
      if (!inRaidHere()) return;
      const m = e.p ? live.find(x => x.pid === e.p && x.c !== 'Corpse') : null;
      if (m && !inArea(m)) { watch(m); return; }
      // nobody to follow: the place it happened
      const at = Array.isArray(e.d.l) ? e.d.l : Array.isArray(e.d.a) && Array.isArray(e.d.b) ? [(e.d.a[0] + e.d.b[0]) / 2, (e.d.a[1] + e.d.b[1]) / 2] : null;
      if (at) { chase(null); roam(); goTo(at[0], at[1]); }
    };
    return row;
  };
  let squadPanePrint = '';
  // The squad tactic view (after Chazut's in Raid Review): the squad of the bot followed, pointed at or under the
  // pointer in the Raid list, kept until another is picked. Its tactics, each with how far along it is; then every
  // member with its part, who decides for it and what it's doing; then the squad's latest events.
  let tacticOf = null;
  // the bots followed, pointed at and under the pointer when one was last taken up: a squad is only taken from them
  // again once that changes, so "All squads" stays put while a bot is still followed
  let tacticFrom = '';
  const bandKey = m => m.g || (m.bg ? 'bot:' + m.bg : (m.sq && m.sq.p) || 'solo:' + m.id);
  function showTactic() {
    const body = $('squadBody');
    for (const b of $('squadKinds').children) b.classList.toggle('on', b.dataset.v === 'tactic');
    const from = [chased, pointed, rosterOver].join(',');
    if (from !== tacticFrom) {
      tacticFrom = from;
      for (const id of [chased, pointed, rosterOver]) {
        const m = id !== null && id !== undefined ? liveById.get(id) : null;
        if (m && m.c !== 'Corpse' && m.c !== 'Main Player' && (m.sq || m.g || m.bg)) { tacticOf = { key: bandKey(m), id: m.id }; break; }
      }
    }
    const shownOk = m => m.c !== 'Corpse' && !inArea(m) && !isHidden(m.c || 'None');
    const set = tacticOf && modOn('COMET') ? live.filter(m => shownOk(m) && bandKey(m) === tacticOf.key) : [];
    const pids = new Set(set.map(m => m.pid).filter(Boolean));
    const events = squadEvents.filter(e => pids.has(e.p)).slice(-8).reverse();
    const sqPrint = m => m.sq ? [m.sq.f, m.sq.s, m.sq.u, m.sq.r, m.sq.a, m.sq.x, m.sq.c].join('.') : '';
    // none picked: every squad with a tactic going, each a card that opens it
    const squads = new Map();
    if (!set.length && modOn('COMET')) {
      for (const m of live) {
        if (!shownOk(m) || m.c === 'Main Player' || !(m.sq || m.g || m.bg)) continue;
        const k = bandKey(m);
        if (!squads.has(k)) squads.set(k, []);
        squads.get(k).push(m);
      }
      // a squad is two or more; one alone counts only while COMET has it in a tactic
      for (const [k, of] of squads) if (of.length < 2 && !of.some(m => m.sq)) squads.delete(k);
    }
    const print = 'tactic|' + set.map(m => [m.id, m.t, m.ly, m.cm, sqPrint(m)].join(':')).join(',')
      + '|' + [...squads.values()].map(of => of.map(m => m.id + ':' + sqPrint(m)).join(',')).join(';')
      + '|' + (events.length ? events[0].n : 0) + '|' + (tacticOf ? tacticOf.id : '');
    if (print === squadPanePrint) return;
    squadPanePrint = print;
    body.textContent = '';
    const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text !== undefined) x.textContent = text; return x; };
    const nameOfBot = m => m.t ? latin(m.t) : ONE[m.c] || m.c;
    if (!set.length) {
      if (!squads.size) { body.appendChild(el('p', 'tacticNone', T('No squad tactic running.'))); return; }
      body.appendChild(el('div', 'filterHead', T('Squads in this raid')));
      // the ones with a tactic going first, then the ones with one over, then the rest
      const rank = of => of.some(m => m.sq && m.sq.a && !squadOver(m.sq)) ? 0 : of.some(m => m.sq) ? 1 : 2;
      for (const of of [...squads.values()].sort((a, b) => rank(a) - rank(b))) {
        const lead = of.find(m => m.sq) || of[0], q = lead.sq;
        // what the squad is: a boss's, by the boss's name; otherwise by the kind most of it is
        const boss = of.find(m => m.c === 'Boss' && m.t);
        const kinds = {};
        for (const m of of) kinds[m.c] = (kinds[m.c] || 0) + 1;
        const kind = Object.keys(kinds).sort((a, b) => kinds[b] - kinds[a])[0];
        const title = boss ? T("{name}'s squad", { name: nameOfBot(boss) }) : T('{kind} squad', { kind: ONE[kind] || kind });
        // who's in it: the first three by name, then how many more
        if (boss) of.sort((a, b) => (b === boss) - (a === boss));
        const names = of.slice(0, 3).map(nameOfBot).join(', ') + (of.length > 3 ? ' ' + T('+{n} more', { n: of.length - 3 }) : '');
        const card = el('button', 'tacticCard tacticSquad');
        card.type = 'button';
        card.title = of.map(nameOfBot).join('\n');
        if (q) {
          const over = of.filter(m => m.sq).every(m => squadOver(m.sq)), going = of.some(m => m.sq && m.sq.a), foe = squadFoe(q);
          if (going && !over) card.classList.add('going');
          card.append(el('b', '', title), el('span', '', over ? T('Over') : going ? T('in progress') : T('preparing')),
            el('small', '', names), el('small', 'plan', squadTactic(q) + (foe ? ' · ' + T('against {who}', { who: foe }) : '')));
        } else {
          card.append(el('b', '', title), el('span', '', ''), el('small', '', names), el('small', 'plan', T('No squad tactic running.')));
        }
        card.onclick = () => { tacticOf = { key: bandKey(lead), id: lead.id }; squadPanePrint = ''; showTactic(); };
        body.appendChild(card);
      }
      return;
    }
    const back = el('button', 'linkBtn tacticBack', '‹ ' + T('All squads'));
    back.type = 'button';
    back.onclick = () => { tacticOf = null; squadPanePrint = ''; showTactic(); };
    body.appendChild(back);
    const first = set.find(m => m.id === tacticOf.id) || set[0];
    body.appendChild(el('div', 'tacticWho', nameOfBot(first)));
    body.appendChild(el('div', 'tacticSum', TP(set.length, 'Squad · {n} member', 'Squad · {n} members')));
    // each tactic the squad has going, once
    const plans = new Map();
    for (const m of set) if (m.sq) { const k = m.sq.p || m.sq.f; if (!plans.has(k)) plans.set(k, []); plans.get(k).push(m); }
    if (!plans.size) body.appendChild(el('p', 'tacticNone', T('No squad tactic running.')));
    for (const of of plans.values()) {
      const q = of[0].sq, over = of.every(o => squadOver(o.sq)), going = of.some(o => o.sq.a), foe = squadFoe(q);
      const card = el('div', 'tacticCard' + (going && !over ? ' going' : ''));
      card.append(el('b', '', squadTactic(q)), el('span', '', over ? T('Over') : going ? T('in progress') : T('preparing')),
        el('small', '', T('{n} of {of} in it', { n: of.length, of: set.length }) + (foe ? ' · ' + T('against {who}', { who: foe }) : '')));
      body.appendChild(card);
    }
    // each member: its part, who decides for it, what it's doing
    for (const m of set) {
      const brain = brainOf(m), card = el('button', 'tacticBot' + (m.id === tacticOf.id ? ' on' : ''));
      card.type = 'button';
      const head = el('div', 'head');
      head.append(el('b', '', nameOfBot(m)), el('i', '', brain ? brain.by : ''));
      card.appendChild(head);
      if (m.sq) card.appendChild(el('span', 'part', '➚ ' + squadSaid(m.sq)));
      if (brain) card.appendChild(el('small', '', brain.text));
      const like = likeOf(m);
      if (like && prefs.botDiff) card.appendChild(el('small', '', like));
      card.onclick = () => { if (inRaidHere() && !inArea(m)) watch(m); };
      body.appendChild(card);
    }
    if (events.length) {
      body.appendChild(el('div', 'filterHead', T('Recent squad events')));
      for (const e of events) body.appendChild(squadRow(e));
    }
  }
  // Where the Raid events panel may stand (prefs.eventsPos): beside the Raid list ('auto', on the side of it the map
  // is), beside the menu ('menu'), or a corner of the map ('tl', 'tr', 'bl', 'br'), clear of the panels open there.
  // Each as [left, top] in pixels, for a panel of this size.
  function eventsSpots(pane) {
    const w = pane.offsetWidth, h = pane.offsetHeight, W = window.innerWidth, H = window.innerHeight;
    const bar = Math.round($('bar').getBoundingClientRect().bottom + 8);
    const open = el => !el.hidden && !document.body.classList.contains('bare') && el.getBoundingClientRect().width > 0;
    const side = $('side'), menu = $('panel');
    // how far in from each edge a corner spot starts: past the panel open on that side
    let inL = 10, inR = 10;
    for (const el of [side, menu]) {
      if (!open(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.left + r.width / 2 < W / 2) inL = Math.max(inL, r.right + 8); else inR = Math.max(inR, W - r.left + 8);
    }
    const spots = {};
    const beside = el => {
      const r = el.getBoundingClientRect();
      return [r.left + r.width / 2 < W / 2 ? r.right + 8 : r.left - 8 - w, r.top];
    };
    if (open(side)) spots.auto = beside(side);
    if (open(menu)) spots.menu = beside(menu);
    spots.tl = [inL, bar];
    spots.tr = [W - inR - w, bar];
    // above the kill feed when that's in the same bottom corner
    const feed = $('killFeed'), fr = feed && !feed.hidden ? feed.getBoundingClientRect() : null;
    const floor = (left, low) => fr && fr.height && (fr.left + fr.width / 2 < W / 2) === left && fr.top > H / 2 ? Math.min(low, fr.top - 8) : low;
    spots.bl = [inL, floor(true, H - 46) - h];
    spots.br = [W - inR - w, floor(false, H - 34) - h];
    for (const k of Object.keys(spots)) spots[k] = [Math.max(4, Math.min(W - w - 4, spots[k][0])), Math.max(4, Math.min(H - h - 4, spots[k][1]))];
    return spots;
  }
  // Put down anywhere: on a grid of GRID pixels, or on the edge of the screen or of a panel when let go within PULL of
  // one. Kept as where its top left corner is, as a share of the window's width and height (0 to 1, v: 2): it stays
  // put when what's in it makes it taller or shorter, and moves with the window when that changes size.
  const GRID = 20, PULL = 14;
  function snapPanel(pane, x, y) {
    const w = pane.offsetWidth, h = pane.offsetHeight, W = window.innerWidth, H = window.innerHeight;
    const xs = [8, W - w - 8], ys = [Math.round($('bar').getBoundingClientRect().bottom + 8), H - h - 34];
    for (const el of [$('side'), $('panel'), $('killFeed'), $('squadPane')]) {
      if (!el || el === pane || el.hidden || document.body.classList.contains('bare')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      xs.push(r.right + 8, r.left - 8 - w, r.left, r.right - w);
      ys.push(r.top, r.bottom - h, r.top - 8 - h, r.bottom + 8);
    }
    const pick = (v, lines) => {
      let best = null;
      for (const l of lines) if (Math.abs(l - v) <= PULL && (best === null || Math.abs(l - v) < Math.abs(best - v))) best = l;
      return best !== null ? best : Math.round(v / GRID) * GRID;
    };
    return [Math.max(4, Math.min(W - w - 4, pick(x, xs))), Math.max(4, Math.min(H - h - 4, pick(y, ys)))];
  }
  function placeEvents(pane) {
    const p = prefs.eventsPos;
    if (p && typeof p === 'object' && p.v === 2 && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      const w = pane.offsetWidth, W = window.innerWidth, H = window.innerHeight;
      // its top stays where it was put; when there's not room below for all of it, its list scrolls instead
      const top = Math.round(Math.max(4, Math.min(H - 120, p.y * H)));
      pane.style.left = Math.round(Math.max(4, Math.min(W - w - 4, p.x * W))) + 'px';
      pane.style.top = top + 'px';
      pane.style.right = 'auto';
      pane.style.maxHeight = Math.min(480, H - top - 8) + 'px';
      return;
    }
    pane.style.maxHeight = '';
    const spots = eventsSpots(pane);
    const at = spots[p] || spots.auto || spots.tl;
    pane.style.left = Math.round(at[0]) + 'px';
    pane.style.top = Math.round(at[1]) + 'px';
    pane.style.right = 'auto';
  }
  // A panel picked up by its head and put down somewhere else: it follows the pointer once moved a few pixels (less is
  // a press, left alone), and on letting go drop(x, y) is told where its top left corner was let go, to snap it into a
  // place of its own. A press that moved it isn't also taken as a press of what's under it. Not on a phone, where every
  // panel has its one place.
  // snap(x, y), when given: where the panel would stand for a top left corner there, shown while it's moved (on a grid
  // drawn faintly over the map meanwhile)
  function draggable(handle, box, drop, snap, allowTouch = false) {
    handle.classList.add('dragHandle');
    handle.addEventListener('pointerdown', e => {
      if ((!allowTouch && phone.matches) || e.button !== 0 || e.target.closest('input, select, #sideClose, #squadClose, #panelClose, #killClose')) return;
      if (allowTouch) e.preventDefault();
      const start = box.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY;
      let moved = false;
      const move = ev => {
        if (ev.pointerId !== e.pointerId) return;
        const dx = ev.clientX - x0, dy = ev.clientY - y0;
        if (!moved && Math.hypot(dx, dy) < 6) return;
        if (!moved) {
          moved = true;
          box.classList.add('panelMoving');
          if (snap) document.body.classList.add('gridOn');
          try { window.getSelection().removeAllRanges(); } catch (err) { /* none */ }
          try { handle.setPointerCapture(e.pointerId); } catch (err) { /* gone */ }
        }
        const at = snap ? snap(start.left + dx, start.top + dy) : null;
        box.style.transform = 'translate(' + (at ? at[0] - start.left : dx) + 'px, ' + (at ? at[1] - start.top : dy) + 'px)';
      };
      const up = ev => {
        if (ev.pointerId !== e.pointerId) return;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        if (!moved) return;
        box.classList.remove('panelMoving');
        document.body.classList.remove('gridOn');
        box.style.transform = '';
        if (ev.type === 'pointercancel') return;
        // the click that follows letting go is the drag's, not a press
        const eat = c => { c.stopPropagation(); c.preventDefault(); };
        window.addEventListener('click', eat, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', eat, { capture: true }), 0);
        drop(start.left + ev.clientX - x0, start.top + ev.clientY - y0, start);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  }
  // The Raid list and the menu: let go on the other half of the screen, the two swap sides (as Settings > Layout does)
  function swapByDrag(box) {
    return (x, y, start) => {
      const W = window.innerWidth, was = start.left + start.width / 2 < W / 2, now = x + start.width / 2 < W / 2;
      if (was === now) return;
      prefs.swap = !prefs.swap;
      $('optSwap').checked = prefs.swap;
      save(); sidesNow(); keepOnMap(); dirty = true;
      squadPanePrint = ''; showSquadPane();
    };
  }
  draggable($('sideHead'), $('side'), swapByDrag($('side')));
  draggable($('panelHead'), $('panel'), swapByDrag($('panel')));
  function showSquadPane() {
    let pane = $('squadPane'), button = $('squadBtn');
    if (!button) {
      button = document.createElement('button');
      button.id = 'squadBtn';
      button.type = 'button';
      button.textContent = T('Events');
      button.title = T('What has happened in the raid, in a panel beside this list: what squads did together (COMET), what was picked up, and what ORBIT\'s ghosts did.');
      button.onclick = () => { prefs.squadPane = !prefs.squadPane; save(); squadPanePrint = ''; showSquadPane(); };
      $('sideSort').before(button);
      pane = document.createElement('aside');
      pane.id = 'squadPane';
      pane.className = 'ui';
      pane.innerHTML = '<div id="squadHead"><b>' + T('Raid events') + '</b><button id="squadClose" type="button" aria-label="' + T('Close') + '">×</button></div><div class="seg" id="squadKinds"></div><div class="seg" id="squadSpan"></div><div id="squadBody"></div>';
      document.body.appendChild(pane);
      segment($('squadKinds'), EVENT_KINDS, kind => { prefs.eventsKind = kind; save(); squadPanePrint = ''; showSquadPane(); });
      // (a replay: what had happened by the moment shown, or the whole raid's, each with its time)
      segment($('squadSpan'), [['now', 'So far', 'What had happened by the moment shown. Tactic: the squads as they are at that moment.'],
        ['all', 'Whole raid', 'Everything of this kind in the whole raid, in order, each with its time in the raid. Press one to go to that moment. Tactic: every move COMET had a squad make.']],
      v => { prefs.hpEventsAll = v === 'all'; save(); squadPanePrint = ''; showSquadPane(); });
      $('squadSpan').hidden = !HIST;
      $('squadClose').onclick = () => { prefs.squadPane = false; save(); squadPanePrint = ''; showSquadPane(); };
      // picked up by its title: put down in the nearest of its places; its title pressed twice, back beside the Raid list
      draggable($('squadHead'), pane, (x, y) => {
        const at = snapPanel(pane, x, y), W = window.innerWidth, H = window.innerHeight;
        prefs.eventsPos = { x: at[0] / W, y: at[1] / H, v: 2 };
        save(); placeEvents(pane);
      }, (x, y) => snapPanel(pane, x, y));
      $('squadHead').ondblclick = e => { if (e.target.closest('button')) return; prefs.eventsPos = 'auto'; save(); placeEvents(pane); };
    }
    // there in every raid, so it's always where it was, though nothing may have happened yet
    const can = !phone.matches && inRaid();
    button.hidden = !can;
    button.classList.toggle('on', can && !!prefs.squadPane);
    // only beside a Raid list that lists somebody (a group folded away still counts): with nobody in it, nor is this.
    // (On the history page it's a fold of the panel down a replay's right, open or shut there: see sideEvents.)
    const onHistMap = HIST && document.body.classList.contains('hpMap');
    // (and only once it's in its fold: made, it's put loose on the page until the fold is first opened, and shown there
    // it'd sit at the top of the page, over everything)
    const open = HIST ? onHistMap && !!pane.closest('#hpSide') : can && !!prefs.squadPane && !$('side').hidden && !!$('roster').querySelector('.sideRow, .filterHead.fold');
    pane.hidden = !open;
    if (!open) return;
    // the tabs of a mod this game hasn't (or that's switched off) are left out; one left on such a tab sees All
    const tabOk = v => v === 'tactic' || v === 'squad' ? modOn('COMET') : v === 'orbit' ? modOn('ORBIT') : true;
    for (const b of $('squadKinds').children) b.hidden = !tabOk(b.dataset.v);
    // (the tab picked is kept, so it's back once the mod is: before the game has said which mods it has, say)
    const kind = tabOk(prefs.eventsKind) ? prefs.eventsKind : 'all';
    if (!HIST) placeEvents(pane);
    const whole = HIST && prefs.hpEventsAll !== false && !!replay;
    for (const b of $('squadSpan').children) b.classList.toggle('on', b.dataset.v === (whole ? 'all' : 'now'));
    if (kind === 'tactic' && !whole) { showTactic(); return; }
    // the whole raid: every event of the kind, oldest first (Tactic: COMET's squad moves); otherwise the latest 80 of
    // what had happened, newest first
    const listed = whole
      ? replay.events.filter(e => EVENT_KEPT.has(e.k) && eventListed(e, kind === 'tactic' ? 'squad' : kind)).slice(0, 1500)
      : squadEvents.concat(otherEvents).filter(e => eventListed(e, kind)).sort((a, b) => a.n - b.n).slice(-80).reverse();
    const print = kind + '|' + whole + '|' + listed.length + '|' + (listed.length ? listed[0].n : 0) + '|' + (things ? 1 : 0);
    if (print === squadPanePrint) return;
    squadPanePrint = print;
    for (const b of $('squadKinds').children) b.classList.toggle('on', b.dataset.v === kind);
    const body = $('squadBody');
    body.textContent = '';
    for (const e of listed) body.appendChild(squadRow(e, whole));
    if (!listed.length) body.textContent = whole ? T('Nothing of this kind in this raid.') : T('Nothing of this kind yet.');
  }
  function squadLog(box) {
    showSquadPane();
    if (!phone.matches || prefs.areaKinds.includes('Enemy Player')) return;
    const told = squadEvents.filter(e => eventListed(e, 'squad'));
    if (!modOn('COMET') || !told.length) return;
    const log = document.createElement('details');
    log.className = 'squadLog';
    log.open = squadLogOpen;
    log.ontoggle = () => { squadLogOpen = log.open; };
    const head = document.createElement('summary');
    head.textContent = T('Squad events') + ' · ' + told.length;
    head.title = T('What COMET had squads doing together, as it changed. Time is since the raid was first seen.');
    log.appendChild(head);
    for (const e of told.slice(-12).reverse()) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'squadEvent';
      const when = document.createElement('time'), who = document.createElement('b'), what = document.createElement('span');
      when.textContent = raidClock(e.t || 0);
      who.textContent = e.nm ? latin(e.nm) : T('A bot');
      what.textContent = squadSaid(e.d);
      row.append(when, who, what);
      row.title = who.textContent + '\n' + what.textContent;
      row.onclick = () => {
        const m = live.find(x => x.pid === e.p && x.c !== 'Corpse');
        if (m && inRaidHere()) watch(m);
      };
      log.appendChild(row);
    }
    box.appendChild(log);
  }
  // The raid's best loot: the dozen things worth the most, of what the page shows (loose loot, containers, and the
  // bodies whose loot it shows). Pressing one goes there.
  function listBest() {
    $('bestRealBox').hidden = !lootReal() || !inRaidHere();
    $('bestCanBox').hidden = !lootCan();
    $('bestNone').hidden = !($('bestRealBox').hidden && $('bestCanBox').hidden);
    if ($('panel').hidden || tab !== 'loot') return;
    listExplore();
    listBestCan();
    if (!lootReal()) return;
    const loot = inRaidHere() && things && sameMap(things.loc, map.loc) ? things : null;
    const shownPlaces = map && places && sameMap(places.loc, map.loc) ? places : null;
    const flags = ['Layer loose', 'Layer boxes', 'Layer bodies', 'Corpse'].map(isHidden).join('') + prefs.allCorpses;
    const print = [!!loot, thingsHave, !!shownPlaces, map && map.loc, flags, live.filter(m => m.c === 'Corpse').length, killEvents.length, prefs.bestMore, peeking(), prefs.loot, lootPrint()].join('|');
    if (print === bestPrint) return;
    bestPrint = print;
    const box = $('bestLoot');
    box.textContent = '';
    if (!loot) { box.textContent = inRaid() ? T('Nothing known of this raid\'s loot yet.') : T('Not in a raid.'); return; }
    const names = Object.assign({}, quests ? quests.names : {}, shownPlaces ? shownPlaces.names : {}, loot.names);
    const nameOf = tpl => (names[tpl] || {}).s || (names[tpl] || {}).n || tpl;
    const worthOf = (tpl, n) => ((names[tpl] || {}).p || 0) * (n || 1);
    // what a container or a body holds: its worth, and the dearest thing in it
    const held = id => {
      const items = (loot.inside[id] || []).filter(i => kindOn(names, i[0]));
      let total = 0, top = null, most = -1;
      for (const i of items) {
        const w = worthOf(i[0], i[1]);
        total += w;
        if (w > most) { most = w; top = i[0]; }
      }
      return { total, top, more: items.length - 1 };
    };
    const found = [];
    if (!isHidden('Layer loose')) {
      for (const it of loot.loose) if (!it.q && it.worth > 0 && kindOn(names, it.tpl)) found.push({ worth: it.worth, text: nameOf(it.tpl) + (it.n > 1 ? ' ×' + it.n : ''), note: T('Loose'), p: [it.x, it.y] });
    }
    // what's in containers and on bodies, only when it may be known
    if (!isHidden('Layer boxes') && shownPlaces && peeking()) {
      for (const b of shownPlaces.boxes) {
        if (boxHidden(b)) continue;
        if (loot.have && !loot.have.has(b.id)) continue;
        const h = held(b.id);
        if (h.total > 0) found.push({ worth: h.total, text: nameOf(h.top) + (h.more > 0 ? ' +' + h.more : ''), note: (names[b.tpl] || {}).n || T('Container'), p: b.p });
      }
    }
    if (!isHidden('Layer bodies') && !isHidden('Corpse') && peeking()) {
      for (const b of loot.bodies) {
        if (!b.kp && !prefs.allCorpses) continue;
        const h = held(b.id);
        if (h.total > 0) found.push({ worth: h.total, text: nameOf(h.top) + (h.more > 0 ? ' +' + h.more : ''), note: b.who || T('A body'), p: b.p });
      }
    }
    found.sort((a, b) => b.worth - a.worth);
    if (!found.length) { box.textContent = T('Nothing of worth is shown. See Kinds of loot and More, below.'); return; }
    const most = prefs.bestMore ? 30 : 12;
    for (const it of found.slice(0, most)) {
      const row = sideRow(it.text, roubles(it.worth), worthCol(it.worth), () => goTo(it.p[0], it.p[1]));
      row.title = it.note;
      row.querySelector('small').style.color = worthCol(it.worth);
      box.appendChild(row);
    }
    if (found.length > 12) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'moreBtn';
      more.textContent = prefs.bestMore ? T('Show fewer') : T('Show more') + ' (' + Math.min(30, found.length) + ')';
      more.onclick = () => { prefs.bestMore = !prefs.bestMore; save(); listBest(); };
      box.appendChild(more);
    }
  }
  // The best that can spawn on this map: the dearest things its spawn points can have, of the kinds shown. Pressing
  // one searches for it (every point that can spawn it is ringed) and goes to the nearest; again: the next.
  let bestCanPrint = null;
  const canNext = new Map();
  function listBestCan() {
    if (!lootCan()) return;
    const table = lootTable && map && sameMap(lootTable.loc, map.loc) ? lootTable : null;
    const print = [!!table, map && map.loc, lootPrint(), prefs.bestMore].join('|');
    if (print === bestCanPrint) return;
    bestCanPrint = print;
    const box = $('bestCan');
    box.textContent = '';
    if (!table) { box.textContent = map ? T('Nothing known yet of what can spawn on this map.') : T('No map.'); return; }
    const tn = table.names, by = new Map();
    for (const pt of table.points) {
      for (const i of pt.items) {
        if (!kindOn(tn, i[0])) continue;
        let e = by.get(i[0]);
        if (!e) by.set(i[0], e = { tpl: i[0], worth: (tn[i[0]] || {}).p || 0, spots: [], chance: 0 });
        e.spots.push([pt.x, pt.y]);
        e.chance = Math.max(e.chance, pt.chance * (+i[1] || 0));
      }
    }
    const found = [...by.values()].filter(e => e.worth > 0).sort((a, b) => b.worth - a.worth);
    if (!found.length) { box.textContent = T('Nothing of the kinds shown can spawn here. See Kinds of loot, below.'); return; }
    const most = prefs.bestMore ? 30 : 12;
    for (const e of found.slice(0, most)) {
      const full = (tn[e.tpl] || {}).n || e.tpl;
      const row = sideRow(((tn[e.tpl] || {}).s || full) + ' ×' + e.spots.length, roubles(e.worth), worthCol(e.worth), () => {
        $('find').value = full;
        setFind(full, true);
        findOpen = false;
        const mid = toMap(vw / 2, vh / 2);
        const order = e.spots.slice().sort((a, b) => Math.hypot(a[0] - mid[0], a[1] - mid[1]) - Math.hypot(b[0] - mid[0], b[1] - mid[1]));
        let seen = canNext.get(e.tpl);
        if (!seen) canNext.set(e.tpl, seen = new Set());
        let spot = order.find(p => !seen.has(p[0] + ',' + p[1]));
        if (!spot) { seen.clear(); spot = order[0]; }
        seen.add(spot[0] + ',' + spot[1]);
        goTo(spot[0], spot[1]);
      });
      row.title = full + ': ' + TP(e.spots.length, 'can spawn at {n} point, at best in {p} of raids. Press: the nearest; again: the next.', 'can spawn at {n} points, at best in {p} of raids. Press: the nearest; again: the next.', { p: percent(e.chance) });
      row.querySelector('small').style.color = worthCol(e.worth);
      box.appendChild(row);
    }
    if (found.length > 12) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'moreBtn';
      more.textContent = prefs.bestMore ? T('Show fewer') : T('Show more') + ' (' + Math.min(30, found.length) + ')';
      more.onclick = () => { prefs.bestMore = !prefs.bestMore; save(); bestPrint = null; listBest(); };
      box.appendChild(more);
    }
  }
  // The Loot tab's Explorer: every item on this map, once each with how many there are, to filter and sort. From this
  // raid (what's really there, of what the page may show: loose loot, and what's in containers and on bodies while
  // Show what's inside things is on) or from what can spawn. Pressing one searches the map for it by its whole name
  // (whatever the Kinds of loot switches say) and goes to the nearest; again: the next.
  const EX_FROM = [
    ['real', 'In this raid', 'What\'s really there now: loose, and in containers and on bodies while Show what\'s inside things is on.'],
    ['can', 'Can spawn', 'What the spawn points and containers of this map can have, with the best chance of each.']];
  const WISH_GROUPS = [T('Tasks'), T('Hideout'), T('Barter'), T('Equipment'), T('Other')];
  let explorePrint = null, exploreText = '', exploreHave = { key: null, all: null }, exploreOptions = '';
  const exploreNext = new Map();
  // the wishlist choice as it can be used now: none while the wishlist isn't known, the whole of it while its groups
  // aren't (the choice made is kept, and comes back once they are)
  const exploreWish = () => !wish ? '' : /^[0-4]$/.test(prefs.exWish) && !wishGroup.size ? 'all' : prefs.exWish;
  const EX_SORTS = [['worth', T('Worth, each')], ['total', T('Worth, all of them')], ['name', T('Name')], ['count', T('Most places')], ['chance', T('Best chance')]];
  // where the Explorer's items are from: the one picked, if the Loot shown has it
  const exploreFroms = () => (lootReal() && inRaidHere() ? ['real'] : []).concat(lootCan() ? ['can'] : []);
  // the items: tpl -> { tpl, name, short, worth (each), g (kind), q, spots [[east, north]..], n (how many), chance }
  function exploreItems(from) {
    const found = new Map();
    const shownPlaces = map && places && sameMap(places.loc, map.loc) ? places : null;
    const add = (names, tpl, n, p, chance) => {
      const entry = names[tpl] || {};
      let e = found.get(tpl);
      if (!e) found.set(tpl, e = { tpl, name: entry.n || tpl, short: entry.s || entry.n || tpl, worth: entry.p || 0, g: entry.g || 'other', q: !!entry.q, spots: [], n: 0, chance: 0 });
      e.spots.push([p[0], p[1]]);
      e.n += n || 1;
      if (chance) e.chance = Math.max(e.chance, chance);
    };
    if (from === 'real') {
      const loot = inRaidHere() && things && sameMap(things.loc, map.loc) ? things : null;
      if (!loot) return null;
      const names = Object.assign({}, quests ? quests.names : {}, shownPlaces ? shownPlaces.names : {}, loot.names);
      // as the map draws them (see drawThings), so each one pressed is found there
      const wants = questWants(), mine = prefs.myQuestItems && !!quests;
      for (const it of loot.loose) {
        if (it.q && mine && !wants.items.get(it.tpl) && !wants.fItems.get(it.tpl)) continue;
        add(names, it.tpl, it.n, [it.x, it.y]);
      }
      if (peeking() && shownPlaces && prefs.loot !== 'off') {
        for (const b of shownPlaces.boxes) {
          if (boxHidden(b) || (loot.have && !loot.have.has(b.id))) continue;
          for (const i of loot.inside[b.id] || []) add(names, i[0], i[1], b.p);
        }
      }
      if (peeking() && !isHidden('Corpse')) {
        for (const b of loot.bodies) {
          if (!b.kp && !prefs.allCorpses) continue;
          for (const i of loot.inside[b.id] || []) add(names, i[0], i[1], b.p);
        }
      }
      return found;
    }
    const table = lootTable && map && sameMap(lootTable.loc, map.loc) ? lootTable : null;
    if (!table) return null;
    const tn = table.names;
    for (const pt of table.points) for (const i of pt.items) add(tn, i[0], 1, [pt.x, pt.y], pt.chance * (+i[1] || 0));
    // the containers, where the map shows what they can hold (not while what's in them is shown)
    const loot = inRaidHere() && things && sameMap(things.loc, map.loc) ? things : null;
    if (shownPlaces && prefs.loot !== 'off' && !(loot && peeking())) {
      for (const b of shownPlaces.boxes) {
        if (boxHidden(b) || (loot && lootReal() && loot.have && !loot.have.has(b.id))) continue;
        const there = table.boxChance[b.id] === undefined ? 1 : table.boxChance[b.id];
        for (const i of table.boxes[b.tpl] || []) add(tn, i[0], 1, b.p, there * (+i[1] || 0));
      }
    }
    return found;
  }
  function listExplore() {
    const view = document.querySelector('section[data-tab="loot"] > .view[data-view="explore"]');
    if (!view || view.hidden) return;
    const froms = exploreFroms();
    const from = froms.includes(prefs.exFrom) ? prefs.exFrom : froms[0];
    // (what the items are worked out from: only when this changes are they worked out again, not as a name is typed)
    const have = [from, inRaidHere(), thingsHave, things && things.loc, things && things.bodies.length, lootTable && lootTable.loc, places && places.loc, map && map.loc,
      prefs.loot, peeking(), isHidden('Corpse'), prefs.allCorpses, prefs.boxOff.join(), prefs.myQuestItems, !!quests, quests ? quests.list.length : 0].join('|');
    const print = [have, froms.join(), wishPrint, wishGroup.size, prefs.exKind, prefs.exWish, prefs.exSort, prefs.exMore, exploreText, findExact].join('|');
    if (print === explorePrint) return;
    explorePrint = print;
    $('exFrom').hidden = froms.length < 2;
    for (const b of $('exFrom').children) b.classList.toggle('on', b.dataset.v === from);
    // the choices of the wishlist and the order, as they can be had now: the wishlist once it's known, its groups only
    // from a server that sends them, the best chance only of what can spawn (made again only when that changes)
    const wished = exploreWish(), sort = prefs.exSort === 'chance' && from !== 'can' ? 'worth' : prefs.exSort;
    const options = [!!wish, wishGroup.size > 0, from === 'can'].join();
    if (options !== exploreOptions) {
      exploreOptions = options;
      const wishes = $('exWish'), sorts = $('exSort');
      wishes.textContent = '';
      wishes.add(new Option(T('Any'), ''));
      if (wish) wishes.add(new Option(T('On my wishlist'), 'all'));
      if (wish && wishGroup.size) WISH_GROUPS.forEach((g, i) => wishes.add(new Option(T('Wishlist: {group}', { group: g }), String(i))));
      sorts.textContent = '';
      for (const [v, text] of EX_SORTS) if (v !== 'chance' || from === 'can') sorts.add(new Option(text, v));
    }
    $('exWishRow').hidden = !wish;
    $('exWish').value = wished;
    $('exKind').value = prefs.exKind;
    $('exSort').value = sort;
    $('exPeek').hidden = from !== 'real' || peeking();
    const box = $('exList'), sum = $('exSum');
    box.textContent = '';
    sum.textContent = '';
    if (!from) { box.textContent = T('Loot is switched off. Pick what\'s shown under Filters.'); return; }
    if (exploreHave.key !== have) exploreHave = { key: have, all: exploreItems(from) };
    const all = exploreHave.all;
    if (!all) {
      box.textContent = from === 'real' ? T('Nothing known of this raid\'s loot yet.') : map ? T('Nothing known yet of what can spawn on this map.') : T('No map.');
      return;
    }
    const words = plain(exploreText).split(' ').filter(Boolean);
    const rows = [...all.values()].filter(e => {
      if (prefs.exKind && (prefs.exKind === 'quest' ? !e.q : e.q || e.g !== prefs.exKind)) return false;
      if (wished === 'all' && !wish.has(e.tpl)) return false;
      if (/^[0-4]$/.test(wished) && wishGroup.get(e.tpl) !== +wished) return false;
      if (words.length) { const name = plain(e.name + ' ' + e.short); if (!words.every(w => name.includes(w))) return false; }
      return true;
    }).sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name)
      : sort === 'count' ? b.spots.length - a.spots.length || b.worth - a.worth
      : sort === 'total' ? b.worth * b.n - a.worth * a.n
      : sort === 'chance' ? b.chance - a.chance || b.worth - a.worth
      : b.worth - a.worth || a.name.localeCompare(b.name));
    sum.textContent = TP(rows.length, '{n} item', '{n} items') + (from === 'real' && rows.length ? ' · ' + roubles(rows.reduce((n, e) => n + e.worth * e.n, 0)) : '');
    if (!rows.length) { box.textContent = all.size ? T('Nothing here matches. Try another kind, or less of the name.') : T('Nothing found'); return; }
    const most = prefs.exMore ? 400 : 60;
    const picked = findExact;
    for (const e of rows.slice(0, most)) {
      const worth = sort === 'total' ? e.worth * e.n : e.worth;
      const row = sideRow(e.name + (e.n > 1 ? ' ×' + e.n : ''), worth ? roubles(worth) : '', e.q ? LAYERS.quest.col : worthCol(e.worth), () => exploreGo(e));
      row.classList.add('exRow');
      if (picked && plain(e.name) === picked) row.classList.add('on');
      const kind = e.q ? T('Quest item') : (LOOT_KINDS.find(k => k[0] === e.g) || LOOT_KINDS[LOOT_KINDS.length - 1])[1];
      const g = wishGroup.get(e.tpl);
      const lines = [e.name, kind + (e.worth ? ' · ' + roubles(e.worth) + (e.n > 1 ? ' ' + T('each') : '') : '')];
      lines.push(from === 'can' ? TP(e.spots.length, 'can spawn at {n} point, at best in {p} of raids. Press: the nearest; again: the next.', 'can spawn at {n} points, at best in {p} of raids. Press: the nearest; again: the next.', { p: percent(e.chance) })
        : TP(e.spots.length, 'In {n} place. Press: go there.', 'In {n} places. Press: the nearest; again: the next.'));
      if (wish && wish.has(e.tpl)) lines.push(T('On your wishlist') + (g !== undefined && WISH_GROUPS[g] ? ': ' + WISH_GROUPS[g] : ''));
      row.title = lines.join('\n');
      const small = row.querySelector('small');
      if (small) small.style.color = worthCol(e.worth);
      box.appendChild(row);
    }
    if (rows.length > 60) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'moreBtn';
      more.textContent = prefs.exMore ? T('Show fewer') : T('Show more') + ' (' + Math.min(400, rows.length) + ')';
      more.onclick = () => { prefs.exMore = !prefs.exMore; save(); listExplore(); };
      box.appendChild(more);
    }
  }
  // an item of the Explorer pressed: the search box finds it by its whole name, and the map goes to the one nearest
  // the middle of the screen; pressed again, to the next
  function exploreGo(e) {
    if (findExact !== plain(e.name)) {
      $('find').value = e.name;
      setFind(e.name, true);
      findOpen = false;
      dirty = true;
    }
    const mid = toMap(vw / 2, vh / 2);
    const order = e.spots.slice().sort((a, b) => Math.hypot(a[0] - mid[0], a[1] - mid[1]) - Math.hypot(b[0] - mid[0], b[1] - mid[1]));
    let seen = exploreNext.get(e.tpl);
    if (!seen || seen.n !== e.spots.length) exploreNext.set(e.tpl, seen = { n: e.spots.length, at: new Set() });
    let spot = order.find(p => !seen.at.has(p[0] + ',' + p[1]));
    if (!spot) { seen.at.clear(); spot = order[0]; }
    seen.at.add(spot[0] + ',' + spot[1]);
    goTo(spot[0], spot[1]);
    listExplore();
  }
  {
    segment($('exFrom'), EX_FROM, v => { prefs.exFrom = v; save(); listExplore(); });
    const kinds = $('exKind');
    for (const [v, text] of [['', T('Every kind')]].concat(LOOT_KINDS, [['quest', T('Quest items')]])) kinds.add(new Option(text, v));
    kinds.onchange = () => { prefs.exKind = kinds.value; save(); listExplore(); };
    // (the wishlist's and the order's choices are made in listExplore, as they can be had)
    const wishes = $('exWish');
    wishes.onchange = () => { prefs.exWish = wishes.value; save(); listExplore(); };
    const sorts = $('exSort');
    sorts.onchange = () => { prefs.exSort = sorts.value; save(); listExplore(); };
    const text = $('exFind');
    clearable(text);
    text.oninput = () => { exploreText = text.value; listExplore(); };
    // (typed letters are the item's name, not the page's keys)
    text.onkeydown = e => { e.stopPropagation(); if (e.key === 'Escape') { text.value = ''; exploreText = ''; listExplore(); } };
  }
  // ---- the menu's tabs ----
  // Settings > On your phone: this PC's address on its network, as a code to scan and as text, asked of the server
  // each time the tab is opened (a router may have handed out another since). The QR code library (qrcode.js, MIT,
  // Kazuhiko Arase) is only loaded then.
  let phoneLib = null;
  function needQr() {
    if (window.qrcode) return Promise.resolve();
    return phoneLib || (phoneLib = new Promise((ok, no) => {
      const s = document.createElement('script');
      s.src = 'qrcode.js';
      s.onload = ok;
      s.onerror = () => { phoneLib = null; no(); };
      document.head.appendChild(s);
    }));
  }
  function drawPhoneCode(url) {
    $('phoneUrl').textContent = url;
    $('phoneCopy').textContent = T('Copy');
    needQr().then(() => {
      const qr = window.qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      // dark squares on white, with the quiet border round it that phones need to find it
      const n = qr.getModuleCount(), cell = Math.max(3, Math.floor(168 / (n + 8)));
      const c = document.createElement('canvas');
      c.width = c.height = (n + 8) * cell;
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#000';
      for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (qr.isDark(r, k)) g.fillRect((k + 4) * cell, (r + 4) * cell, cell, cell);
      $('phoneCode').textContent = '';
      $('phoneCode').appendChild(c);
    }, () => { $('phoneCode').textContent = ''; });
  }
  async function showPhone() {
    // on a phone already: nothing to show
    $('phoneBox').closest('details').hidden = phone.matches;
    if (phone.matches) return;
    let lan;
    try { lan = await (await fetch('api/lan')).json(); } catch (e) { return; }
    const page = location.pathname.replace(/[^/]*$/, '');
    const addrs = Array.isArray(lan.addrs) ? lan.addrs.slice() : [];
    // Opened at an address other than this PC's own (a friend's game, playing with Fika over the internet, opens it at
    // the host's address): that address first, since it's the one that reaches the server from where they are.
    const here = location.hostname;
    const local = /^(127\.|localhost$|::1$|\[::1\]$)/i.test(here);
    if (!local) { const k = addrs.indexOf(here); if (k >= 0) addrs.splice(k, 1); addrs.unshift(here); }
    const open = lan.open || !local;
    // blurred until pressed, every time: an address isn't left showing on a stream or a screenshot
    $('phoneBox').classList.add('veiled');
    $('phoneShut').hidden = open;
    $('phoneNone').hidden = !open || addrs.length > 0;
    $('phoneBox').hidden = !open || !addrs.length;
    if (!open || !addrs.length) return;
    const urlOf = a => 'https://' + (a.includes(':') && !a.startsWith('[') ? '[' + a + ']' : a) + ':' + (location.port || lan.port || 6969) + page;
    drawPhoneCode(urlOf(addrs[0]));
    // more than one network (wired and Wi-Fi, say): each can be picked
    const others = $('phoneOthers');
    others.textContent = '';
    if (addrs.length > 1) {
      for (const a of addrs) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'linkBtn';
        b.textContent = a;
        b.onclick = () => drawPhoneCode(urlOf(a));
        others.appendChild(b);
      }
    }
  }
  $('phoneVeil').onclick = () => $('phoneBox').classList.remove('veiled');
  $('phoneCopy').onclick = () => {
    const text = $('phoneUrl').textContent;
    const done = () => { $('phoneCopy').textContent = T('Copied'); };
    try { navigator.clipboard.writeText(text).then(done, () => {}); } catch (e) { /* not allowed here */ }
  };
  function showTab(name, remember) {
    tab = TABS.includes(name) ? name : 'raid';
    if (tab === 'settings') showPhone();
    if (tab === 'history') loadHistory();
    if (tab === 'presets') listPresets();
    for (const b of $('tabs').children) b.classList.toggle('on', b.dataset.tab === tab);
    for (const part of $('panelBody').children) part.hidden = part.dataset.tab !== tab;
    $('panelBody').scrollTop = 0;
    rosterPrint = bestPrint = bestCanPrint = null;
    if (remember !== false) { prefs.tab = tab; save(); }
    listRoster();
    listBest();
  }
  // The Raid list beside the map: shown or not, and remembered
  function toggleSide(on, remember) {
    $('side').hidden = on === undefined ? !$('side').hidden : !on;
    $('listBtn').classList.toggle('on', !$('side').hidden);
    rosterPrint = null;
    if (remember !== false) { prefs.side = !$('side').hidden; save(); }
    sidesNow();
    listRoster();
  }
  // Which side has something open, for what sits in the bottom corners: the Raid list is on the left and the menu
  // on the right, or the other way round when they're swapped
  function sidesNow() {
    const menu = !$('panel').hidden, list = !phone.matches && !$('side').hidden, swap = !!prefs.swap && !phone.matches;
    const left = swap ? (menu ? $('panel') : null) : (list ? $('side') : null);
    document.body.classList.toggle('swap', !!prefs.swap);
    document.body.classList.toggle('rightOn', swap ? list : menu);
    // the scale and the pointer's place stand in the bottom left corner, moved clear of the panel on that side only
    // when the panel comes down that far (a short Raid list doesn't)
    const low = left && left.getBoundingClientRect().bottom > window.innerHeight - 70;
    document.body.style.setProperty('--left-cover', (low ? left.offsetWidth + 8 : 0) + 'px');
    edgeTabs();
  }
  // The live map's menu and Raid list, put away: a tab on the screen's edge brings each back, as Raid history's
  // Details does (the menu's on the right and the list on the left, or the other way round when they're swapped)
  function edgeTabs() {
    if (HIST) return;
    const swap = !!prefs.swap;
    for (const [id, open, label, right, go] of [
      ['edgeMenu', !$('panel').hidden, T('Menu'), !swap, () => togglePanel(true)],
      ['edgeList', !$('side').hidden, T('Raid list'), swap, () => toggleSide(true)]]) {
      let b = document.getElementById(id);
      if (!b) {
        b = document.createElement('button');
        b.id = id;
        b.type = 'button';
        b.onclick = go;
        document.body.appendChild(b);
      }
      b.className = 'ui edgeTab' + (right ? '' : ' left');
      b.textContent = right ? '« ' + label : label + ' »';
      b.hidden = open || phone.matches;
    }
  }
  // a tab's key: opens the menu on it; pressed again, shuts the menu
  function openTab(name) {
    if (!$('panel').hidden && tab === name) { togglePanel(false); return; }
    showTab(name);
    togglePanel(true);
  }
  // what the menu covers of a phone's screen (it's beside the map on a bigger one)
  function measureCover() {
    const p = $('panel');
    // beside the map on a bigger screen: what's laid over the map's middle (a replay's bar) keeps clear of it.
    // (On the history page that's the panel down the replay's right, and the Raid list down its left.)
    const right = HIST ? $('hpSide') : p, left = HIST && !$('side').hidden ? $('side') : null;
    document.body.style.setProperty('--menu-r', (!right || right.hidden || phone.matches ? 0 : right.offsetWidth + 14) + 'px');
    document.body.style.setProperty('--menu-l', (!left || phone.matches ? 0 : left.offsetWidth + 14) + 'px');
    const next = p.hidden || !phone.matches ? { r: 0, b: 0 }
      : window.innerWidth <= 700 ? { r: 0, b: Math.min(p.offsetHeight, vh * 0.6) } : { r: Math.min(p.offsetWidth, vw * 0.6), b: 0 };
    if (next.r === cover.r && next.b === cover.b) return;
    cover = next;
    document.body.style.setProperty('--cover-b', next.b + 'px');
    document.body.style.setProperty('--cover-r', next.r + 'px');
    dirty = true;
  }
  // On a phone: the map list, Buildings, Whole map and Full screen are round buttons down the map's right edge
  // (#mapTools), whose game it is is picked by pressing the status, and the language is in Settings. Otherwise they're
  // all along the top.
  function placeQuick() {
    const bar = $('bar');
    // the Raid list: in the menu's Raid tab on a phone, otherwise in its own panel beside the map
    // (the history page has no menu: its Raid list is always the panel's, a sheet on a phone)
    const home = phone.matches && !HIST ? $('panelBody').querySelector('section[data-tab="raid"]') : $('sideBody');
    if ($('roster').parentNode !== home) { home.prepend($('rosterTools'), $('roster')); rosterPrint = null; }
    // its buttons (Events, Nearest): in the panel's title bar beside the map, so the counts have the whole width;
    // on a phone, beside the counts in the menu
    const tools = phone.matches ? $('rosterTools') : $('sideHead');
    for (const id of ['squadBtn', 'sideSort']) {
      const el = $(id);
      if (!el || el.parentNode === tools) continue;
      if (phone.matches) tools.appendChild(el); else tools.insertBefore(el, $('sideClose'));
    }
    const phoneHome = { session: $('status'), map: $('mapPick'), fit: $('mapTools'), reveal: $('mapTools'), full: $('mapTools'), langBox: $('langHome') };
    for (const id of ['session', 'map', 'fit', 'reveal', 'full', 'langBox']) {
      // (the history page has these in the raid's row: see HIST)
      if (HIST && (id === 'fit' || id === 'full' || id === 'langBox')) continue;
      const el = $(id);
      if (phone.matches) { if (el.parentNode !== phoneHome[id]) phoneHome[id].appendChild(el); }
      else if (el.parentNode !== bar) bar.insertBefore(el, id === 'session' || id === 'map' ? $('findBox') : $('options'));
    }
  }
  // The language picker: each language by its own name. Picking one keeps it and starts the page again in it (every
  // word the page has written so far was written in the old one).
  {
    const pick = $('lang');
    for (const [value, name] of window.fumsLangs.list) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = name;
      pick.appendChild(o);
    }
    pick.value = window.fumsLangs.code;
    $('langCode').textContent = '🌐 ' + window.fumsLangs.code.toUpperCase();
    pick.onchange = () => {
      prefs.lang = pick.value;
      save();
      const url = new URL(location.href);
      url.searchParams.delete('lang');
      again(() => location.replace(url.href));
    };
  }
  // The menu's tabs, on one line whatever the language: their words a little smaller while they don't fit (looked at
  // whenever the row changes size, so also when the menu is first opened)
  {
    const nav = $('tabs');
    const fit = () => {
      if (!nav.clientWidth) return;
      for (const b of nav.children) b.style.fontSize = b.style.letterSpacing = '';
      let px = 11.5;
      while (nav.scrollWidth > nav.clientWidth + 1 && px > 8) {
        px -= 0.5;
        for (const b of nav.children) { b.style.fontSize = px + 'px'; b.style.letterSpacing = '0.02em'; }
      }
    };
    if (window.ResizeObserver) new ResizeObserver(fit).observe(nav);
  }
  // a row of buttons of which one is on: [[value, words, what it means]]
  function segment(box, options, pick) {
    box.textContent = '';
    for (const [value, text, title] of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = T(text);
      b.title = title ? T(title) : '';
      b.dataset.v = value;
      b.onclick = () => pick(value);
      box.appendChild(b);
    }
  }
  const LOOT_MODES = [
    ['real', 'What\'s there', 'In a raid: the loot that\'s really there, loose, in containers and on bodies. No spawn points, no chances.'],
    ['can', 'What can spawn', 'In a raid: where loot can spawn and what, with its chances. Never what\'s really there.'],
    ['both', 'Both', 'In a raid: what\'s really there, and every point loot can spawn at.'],
    ['off', 'None', 'No loot on the map, in a raid or out of one.']];
  const LOOT_IDLE = T('Not in a raid on this map, so it shows what can spawn here.') + ' ';
  function setLoot(mode) {
    prefs.loot = mode;
    save();
    rosterPrint = bestPrint = bestCanPrint = null;
    tipFor = null;
    dirty = true;
    loadSpawns();
    showModes();
    listBest();
  }
  function showModes() {
    for (const b of $('lootMode').children) b.classList.toggle('on', b.dataset.v === prefs.loot);
    const says = (prefs.loot !== 'off' && !inRaidHere() ? LOOT_IDLE : '') + T((LOOT_MODES.find(m => m[0] === prefs.loot) || [])[2] || '');
    if ($('lootModeSays').textContent !== says) $('lootModeSays').textContent = says;
  }

  function showStatus() {
    const box = $('status'), text = $('statusText');
    const shown = games.find(g => g.sid === (prefs.player ? prefs.player.sid : sid));
    const who = shown ? gameName(shown) : prefs.player ? gameName(prefs.player) : '';
    let kind = 'gone', says = prefs.player ? T('{who} isn\'t playing', { who }) : T('Game not connected');
    if (serverLost) says = T('Server not reachable');
    else if (replay && report) {
      kind = 'raid';
      says = T('Replay') + ' · ' + placeName(report.loc) + (replay.about.name ? ' · ' + latin(replay.about.name) : '');
    } else if (connected()) {
      kind = report.raid ? 'raid' : 'menu';
      says = report.raid ? T('In raid') + ' · ' + placeName(report.loc) : T('Not in a raid');
      if (who) says = who + ' · ' + says;
    }
    if (text.textContent !== says) { text.textContent = says; text.title = says; }
    box.className = kind;
    // looking at another map than the raid's: a way straight back (the status pressed does the same)
    const away = awayFromRaid();
    $('backRaid').hidden = !away;
    box.classList.toggle('away', away);

    // what stands in the way of a map, if anything
    const notice = $('notice');
    let message = '', soft = true;
    const raidMap = inRaid() ? mapFor(report.loc) : null;
    const capturing = !!(report && report.cap && report.cap[1] > 0);
    // (the maps come with the mod and in add-ons: one that isn't installed is on the Forge, or can be asked for there)
    // An add-on there is but isn't installed is named, with its zip; a map no add-on has is said to be unknown.
    // warn: the notice is about an add-on (or a version) the player can do something about, and is drawn so
    let missing = '', warn = false, warned = false;
    if (inRaid()) {
      const addon = addonFor(report.loc), here = placeName(report.loc);
      if (addon) {
        warn = true;
        missing = T('Add-on needed for {map}: get "{zip}" from the Satellite page on the Forge and extract it into your SPT folder. The map shows within a few seconds, no restart needed.', { map: here, zip: addon.zip || 'Satellite add-on' });
      } else if (unknownVersion(report.loc)) {
        warn = true;
        missing = T('This version of {map} (from another mod) has no Satellite map yet, and no add-on has one. Ask for it on the Satellite page on the Forge.', { map: locationName(baseOf(report.loc)) });
      } else {
        missing = T('Map not detected for {map}. Check the Forge for a Satellite add-on with it, or ask for it there if there isn\'t one.', { map: here });
      }
    }
    if (inRaid() && !raidMap) {
      soft = false;
      message = capturing ? T('Capturing the map of {map}…', { map: placeName(report.loc) }) + ' ' + Math.round(100 * report.cap[0] / report.cap[1]) + '%' : missing;
      warned = warn && !capturing;
    // (the raid's season map in place of its map is the right map, not another one)
    } else if (raidMap && noSnow(raidMap.loc) !== noSnow(report.loc) && !capturing) {
      message = missing + ' ' + (addonFor(report.loc) ? T('Showing {map} until then: markers may not line up with it.', { map: raidMap.name }) : T('Showing {map} instead: markers may not line up with it.', { map: raidMap.name }));
      warned = warn;
    } else if (inRaid() && report.cap && report.cap[1] > 0) {
      message = T('Capturing the map again…') + ' ' + Math.round(100 * report.cap[0] / report.cap[1]) + '%';
    } else if (!maps.length && mapsAsked) {
      soft = false;
      message = T('No maps yet. Start a raid with the game plugin installed: it captures the location\'s map a few seconds in, and the map shows here.');
    }
    notice.hidden = !message || noticeKey(message) === noticeShut;
    notice.className = [soft ? 'soft' : '', warned ? 'warn' : ''].filter(Boolean).join(' ');
    if ($('noticeText').textContent !== message) $('noticeText').textContent = message;

    const player = me && inRaidHere() ? T('Player:') + ' ' + me.x.toFixed(1) + ' ' + me.y.toFixed(1) + ' · ' + T('height') + ' ' + me.z.toFixed(1) : '';
    if ($('playerAt').textContent !== player) $('playerAt').textContent = player;
    $('follow').classList.toggle('on', following() && inRaidHere());
    $('follow').classList.toggle('paused', prefs.follow && roaming && inRaidHere());
    $('follow').disabled = !inRaidHere();
    $('follow').title = inRaidHere() ? (prefs.follow && roaming ? T('Set aside while you look about: it follows the player again once they move on, or press (;)') : T('Keep the player in the middle (;)')) : T('Follows the player once they\'re in a raid on this map');
    $('map').hidden = $('mapBtn').hidden = !maps.length;
    listFilters();
    loadQuests(false);
    listQuests();
    listRoster();
    listBest();
    showModes();
  }

  // ---- the page's own switches ---------------------------------------------------------------------------------
  function setFollow(on) {
    roaming = false;
    chase(null);
    roamFrom = null;
    dirty = true;
    if (prefs.follow === on) return;
    prefs.follow = on;
    $('optFollow').checked = on;
    save();
  }
  // shows a spot: the map moves there, close enough to see it, and the spot is ringed for a moment
  function goTo(x, y) {
    chase(null);
    roam();
    // gone to on purpose: the player moving on doesn't take the map back by itself
    roamFrom = null;
    zoom = zoomTarget = Math.min(zoomMax, Math.max(zoomTarget, Math.min(vw, vh) / 60));
    zoomAt = null;
    centreOn(x, y);
    flash = { x, y, at: performance.now() };
  }
  // Somebody pressed in a list (the Raid list, the kill feed, a squad): followed, as when pressed on the map, and
  // ringed. Not gone to as a spot (goTo): that sets following the player aside for good, so letting go of them (pressing
  // off them) left the map where it was, instead of going back to the player at the zoom they had.
  function watch(m) {
    chase(m.id);
    zoom = zoomTarget = Math.min(zoomMax, Math.max(zoomTarget, Math.min(vw, vh) / 60));
    zoomAt = null;
    centreOn(m.cx, m.cy);
    flash = { x: m.cx, y: m.cy, at: performance.now() };
    dirty = true;
  }
  function togglePanel(on, remember) {
    $('panel').hidden = on === undefined ? !$('panel').hidden : !on;
    $('options').classList.toggle('on', !$('panel').hidden);
    document.body.classList.toggle('menu', !$('panel').hidden);
    rosterPrint = bestPrint = bestCanPrint = null;
    if (remember !== false) { prefs.panel = !$('panel').hidden; save(); }
    sidesNow();
    measureCover();
    dirty = true;
  }
  function fullScreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => { });
  }

  // ---- every frame ---------------------------------------------------------------------------------------------
  // ---- keeping the screen on ------------------------------------------------------------------------------------
  // The browser is asked for it while the page is in front and "Keep the screen on" is set; it takes it back by
  // itself when the page is put away, so it's asked for again when the page comes back.
  let awake = null, awakeSays = 'no', awakeAsking = false;
  async function keepAwake() {
    if (!prefs.awake || document.visibilityState !== 'visible') {
      const held = awake;
      awake = null;
      awakeSays = prefs.awake ? 'no' : 'switched off';
      if (held) { try { await held.release(); } catch (e) { /* gone already */ } }
      return;
    }
    if (awake || awakeAsking) return;
    if (!navigator.wakeLock) { awakeSays = 'this browser can\'t' + (window.isSecureContext ? '' : ' (page not secure)'); return; }
    awakeAsking = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { if (awake === lock) { awake = null; awakeSays = 'no'; } });
      awake = lock;
      awakeSays = 'yes';
      // (put away, or switched off, while it was being asked for)
      if (!prefs.awake || document.visibilityState !== 'visible') keepAwake();
    } catch (e) {
      awakeSays = 'refused (' + e.name + ')';
    }
    awakeAsking = false;
  }
  document.addEventListener('visibilitychange', keepAwake);
  // (a browser that wants the page touched first: asked again at the first press, and after any refusal)
  window.addEventListener('pointerdown', keepAwake, { passive: true });
  keepAwake();

  // ---- speed numbers ("Show speed numbers") ---------------------------------------------------------------------
  // Once a second: frames drawn, the longest wait between two, how long the page worked on a frame (mean and most),
  // and the game's reports: how many came and the longest wait between two.
  const speed = { el: null, at: 0, lastFrame: 0, frames: 0, worst: 0, work: 0, workMost: 0, drawn: 0, heardAt: 0, gaps: 0, gapMost: 0 };
  function speedHeard(now) {
    if (speed.heardAt) {
      speed.gaps++;
      speed.gapMost = Math.max(speed.gapMost, now - speed.heardAt);
    }
    speed.heardAt = now;
  }
  function speedFrame(now, began, drew) {
    if (!prefs.speed) {
      if (speed.el && !speed.el.hidden) speed.el.hidden = true;
      speed.at = 0;
      return;
    }
    const worked = performance.now() - began;
    if (speed.lastFrame) speed.worst = Math.max(speed.worst, now - speed.lastFrame);
    speed.lastFrame = now;
    speed.frames++;
    speed.work += worked;
    speed.workMost = Math.max(speed.workMost, worked);
    if (drew) speed.drawn++;
    if (!speed.at) speed.at = now;
    if (now - speed.at < 1000) return;
    const secs = (now - speed.at) / 1000;
    if (!speed.el) {
      speed.el = document.createElement('div');
      speed.el.id = 'speedLine';
      document.body.appendChild(speed.el);
    }
    speed.el.hidden = false;
    speed.el.textContent = Math.round(speed.frames / secs) + ' frames/s (' + Math.round(speed.drawn / secs) + ' redrawn) · slowest ' + Math.round(speed.worst) + ' ms'
      + '\npage work ' + (speed.work / speed.frames).toFixed(1) + ' ms a frame · most ' + speed.workMost.toFixed(1) + ' ms'
      + '\nreports ' + Math.round(speed.gaps / secs) + '/s · longest wait ' + Math.round(speed.gapMost) + ' ms'
      + '\nscreen ' + vw + '×' + vh + ' ×' + (window.devicePixelRatio || 1).toFixed(2) + ' · drawn ×' + pixelRatio().toFixed(2)
      + '\n' + (live ? live.length : 0) + ' markers · ' + tiles.length + ' tiles · screen kept on: ' + awakeSays;
    speed.at = now;
    speed.frames = speed.drawn = speed.gaps = 0;
    speed.worst = speed.work = speed.workMost = speed.gapMost = 0;
  }

  // The map standing still: not moved, zoomed or turned, and nothing held on it (a finger, the mouse dragging), for
  // STILL_MS (longer on a phone, where a finger lifted and put down again is part of moving about). lookAt: the
  // building looked into by being in the middle of the screen, picked when the map was last still.
  const STILL_MS = 500, STILL_PHONE_MS = 800;
  let viewKey = '', viewMovedAt = 0, lookAt = 0;
  function viewStill(now) {
    const key = panX.toFixed(1) + ',' + panY.toFixed(1) + ',' + zoom.toFixed(4) + ',' + (prefs.turns && map ? prefs.turns[map.loc] || 0 : 0);
    if (key !== viewKey || dragging || pinch || fingers.size) { viewKey = key; viewMovedAt = now; }
    if (now - viewMovedAt >= (phone.matches ? STILL_PHONE_MS : STILL_MS)) return true;
    dirty = true;
    return false;
  }

  let last = performance.now();
  let sinceStatus = 1;
  const LOW_POWER_MS = 66;
  let drawnAt = -1e9, lowPowerOwed = false;
  let zoomSettle = 0;
  function frame(now) {
    playHeld();
    const began = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    // (a replay keeps time through a slow frame: it isn't held to a tenth of a second as the gliding is)
    playReplay(Math.min(1, Math.max(0, (now - last) / 1000)));
    last = now;
    if (map) {
      const raidHere = inRaidHere();
      // Markers that move, and the player, go at a steady pace from where they were drawn when the game last
      // reported to where it said they are, and get there as the next report is due.
      const ease = 1 - Math.exp(-dt / 0.07);
      const clock = performance.now();
      const glide = (o, x, y) => {
        const far = Math.abs(x - o.fx) + Math.abs(y - o.fy) > 40;
        // (past 1: the next report is late, which a phone on Wi-Fi gets often; it goes on the way it went for up to
        // one more report's time, instead of standing still until it comes)
        const k = far ? 1 : Math.min(2, Math.max(0, (clock - o.t0) / (period * 1.1)));
        // (still on its way: drawn again. Not once it's as far as it goes: a paused replay, or a game gone quiet, kept
        // the whole map drawn again sixty times a second with nothing moving)
        if (k > 1 && k < 2) dirty = true;
        o.cx = o.fx + (x - o.fx) * k;
        o.cy = o.fy + (y - o.fy) * k;
      };
      if (raidHere) {
        for (const m of live) {
          if (!m.dyn) continue;
          // drawn again only when it moved or turned this frame: its facing eases towards where it looks and never
          // quite gets there, and one gone past its last report stays where it went, so "not there yet" kept the map
          // drawn sixty times a second with nothing moving (a paused replay)
          const ox = m.cx, oy = m.cy, or = m.cr;
          glide(m, m.p[0], m.p[1]);
          m.cz = m.p[2];
          m.cr += ((((m.r - m.cr) % 360) + 540) % 360 - 180) * ease;
          if (!(Math.abs(m.cx - ox) < 0.002 && Math.abs(m.cy - oy) < 0.002 && Math.abs(m.cr - or) < 0.05)) dirty = true;
        }
      }
      if (me && raidHere) {
        glide(me, me.x, me.y);
        me.cz = me.z;
      }

      // The floor shown, of one building: the one the player has been on for a moment; or the floor picked, of the
      // building the player is in (or, out of a raid, the one in the middle of the screen).
      const f = map.floors;
      let wantPlace = 0, wantN = 0;
      if (f) {
        // whose floor: the player's, or the bot being followed (its building and floor, as the player's would be)
        const them = chased !== null && raidHere ? liveById.get(chased) : null;
        const who = them && Number.isFinite(them.cx) ? { x: them.cx, y: them.cy, z: Number.isFinite(them.cz) ? them.cz : them.p[2], in: them.in } : me;
        const here = who && raidHere ? [who.x, who.y] : null;
        const shut = opened && !(f.buildings && f.buildings[opened - BUILDING]);
        if (shut) opened = 0;
        if (opened) {
          // pressed on: the floor picked, else the player's floor when they're in it, else its biggest
          const has = floorsOf(opened);
          const mine = here ? placeInside(who) : 0;
          wantPlace = opened;
          wantN = +prefs.floor > 0 ? has[Math.min(+prefs.floor, has.length) - 1]
            : (opened === mine ? buildingFloor(opened, who.x, who.y, who.z) : 0) || mainFloor(opened);
        } else if (prefs.floor === 'auto') {
          // only where the player is indoors (not under an awning or an arcade), see placeInside
          const mine = here ? placeInside(who) : 0;
          // a map with buildings goes by them, one without by its squares
          const myFloor = place => f.buildings ? buildingFloor(place, who.x, who.y, who.z) : floorOf(place, who.z);
          // looking about (not following, or no raid here): the building in the middle of the screen, once close
          // enough to make it out; on the player's floor when it's the one they're in, else its ground floor. Picked
          // only once the map has stood still a moment (see viewStill): while it's dragged, pinched or gliding, the
          // building shown stays as it is, so roofs don't flick open as the middle passes over them.
          if (prefs.insideLook && (!here || !(following() || them)) && Math.min(vw, vh) / zoom <= prefs.lookSpan) {
            if (viewStill(now)) {
              const mid = toMap(vw / 2, vh / 2);
              lookAt = (f.buildings ? buildingAt(mid[0], mid[1]) : placeAt(mid[0], mid[1])) || 0;
            }
            if (lookShut && lookAt !== lookShut) lookShut = 0;
            if (lookAt && lookAt !== lookShut) {
              wantPlace = lookAt;
              wantN = (lookAt === mine ? myFloor(lookAt) : 0) || (f.buildings ? mainFloor(lookAt) : 1);
            }
          } else lookAt = 0;
          // the player's building pressed away (see pressed): the whole map until they leave it or press it again
          if (insideShut && insideShut !== mine) insideShut = 0;
          // or walk on: a few steps from where they stood when it was pressed away, and the inside is back
          if (insideShut && here && insideShutAt && Math.hypot(here[0] - insideShutAt[0], here[1] - insideShutAt[1]) > WALK_BACK) insideShut = 0;
          // (only while the map follows them, or a bot: looking about elsewhere, the player walking into a building
          // across the map doesn't grey the map round it)
          if (!wantPlace && mine && prefs.insideMine && insideShut !== mine && (following() || them)) {
            wantN = myFloor(mine);
            wantPlace = wantN ? mine : 0;
          }
        } else if (+prefs.floor > 0) {
          const at = here || toMap(vw / 2, vh / 2);
          wantPlace = f.buildings ? buildingAt(at[0], at[1], here ? who.z : undefined) : placeAt(at[0], at[1]);
          // the floors it has, lowest first: the one picked, or its top one
          const has = !wantPlace ? null : floorsOf(wantPlace);
          wantN = has && has.length ? has[Math.min(+prefs.floor, has.length) - 1] : 0;
          if (!wantN) wantPlace = 0;
        }
      }
      // a floor stepped to with the arrows, while it's that building that's shown
      if (floorPick && floorPick.place !== wantPlace) floorPick = null;
      if (floorPick) wantN = floorPick.n;
      const key = wantPlace + ':' + wantN;
      if (key !== floorWantKey) { floorWantKey = key; floorSince = now; }
      if (key !== floorShown.place + ':' + floorShown.n && (prefs.floor !== 'auto' || now - floorSince > 150)) setFloor(wantPlace, wantN);
      if (DEBUG && now - debugAt > 250) {
        debugAt = now;
        const line = $('debugLine');
        line.hidden = false;
        if (!me || !raidHere || !f) {
          line.textContent = !f ? 'no floors grid for this map' : 'no player in a raid on this map';
        } else {
          const at = placeAt(me.x, me.y), near = placeNear(me.x, me.y);
          const levels = near ? f.levels[near - 1] : null;
          line.textContent = 'at ' + me.x.toFixed(1) + ', ' + me.y.toFixed(1) + '  height ' + me.z.toFixed(2)
            + '\ngame says: ' + (me.in === undefined ? '?' : me.in ? 'indoor' : 'OUTDOOR')
            + '   place here ' + at + '   near ' + near + '   levels ' + JSON.stringify(levels)
            + '\nfloor by height ' + floorOf(near, me.z) + '   wanted ' + key + '   shown ' + floorShown.place + ':' + floorShown.n
            + '   option ' + prefs.floor + (prefs.insideMine ? '' : '   ("show the inside of the building I\'m in" is off)');
          if (f.buildings) {
            const b = buildingAt(me.x, me.y, me.z);
            line.textContent += '\nbuilding ' + (b ? (b - BUILDING) + '   its floors ' + JSON.stringify(f.buildings[b - BUILDING].parts.map(p => [p.n, p.h, p.t]))
              + '   on floor ' + buildingFloor(b, me.x, me.y, me.z) : 'none here') + '   (' + f.buildings.length + ' on this map)';
          } else {
            line.textContent += '\nthis map has no buildings worked out; the squares are gone by';
          }
        }
      }

      // auto zoom: closer under a roof, wider in the open, once the player has been there a moment
      if (autoZooming()) {
        const under = !!me.in || !!placeInside();
        if (under !== stateWanted) { stateWanted = under; stateSince = now; }
        if (zoomState !== stateWanted && (zoomState === null || now - stateSince > 200)) {
          zoomState = stateWanted;
          zoomTarget = stateZoom(zoomState);
          zoomAt = null;
        }
      } else {
        zoomState = null;
      }

      // (done within a fifth of a percent: what's left moves the map less than a pixel or two, and waiting out the
      // last of it kept the map soft for longer)
      const zooming = Math.abs(zoomTarget - zoom) > zoom * 0.002;
      if (zooming) {
        const hold = zoomAt || [vw / 2, vh / 2];
        const under = toMap(hold[0], hold[1]);
        zoom += (zoomTarget - zoom) * (1 - Math.exp(-dt * 10));
        const moved = toScreen(under[0], under[1]);
        panX += hold[0] - moved[0];
        panY += hold[1] - moved[1];
        dirty = true;
      } else if (zoom !== zoomTarget) {
        // (the last of it about the same spot, so it doesn't jump)
        const hold = zoomAt || [vw / 2, vh / 2];
        const under = toMap(hold[0], hold[1]);
        zoom = zoomTarget;
        const moved = toScreen(under[0], under[1]);
        panX += hold[0] - moved[0];
        panY += hold[1] - moved[1];
        dirty = true;
      }

      // set aside by a drag or by going to look at something, the map follows the player again once they have
      // walked on; somebody else being followed is kept in the middle instead
      // (walked: the player has gone on from where they were when the map was taken off them; a building pressed open
      // stays open until then, however long it's looked at)
      const walked = roamFrom && me && raidHere && Math.hypot(me.x - roamFrom[0], me.y - roamFrom[1]) > WALK_BACK;
      // (not by itself after a pause: standing still to look about the map, it kept being taken back)
      if (roaming && !dragging && walked && !replay) { roaming = false; roamFrom = null; zoomAt = null; opened = 0; dirty = true; backToPlayer(); }
      if (chased !== null) {
        const them = raidHere ? liveById.get(chased) : null;
        if (!them || !Number.isFinite(them.cx)) chase(null);
        else if (!dragging) centreOn(them.cx, them.cy);
      } else if (following() && me && raidHere && !dragging) centreOn(me.cx, me.cy);
      keepOnMap();
      // on whole screen pixels: a map moved by fractions of one shimmers as it goes. Not while it zooms: snapped to
      // a pixel at every size on the way, the picture would shake until the zoom settled.
      if (!zooming) {
        const pixel = pixelRatio();
        panX = Math.round(panX * pixel) / pixel;
        panY = Math.round(panY * pixel) / pixel;
      }
      layTiles();
      refreshTiles();
      layersEl.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')' + (turn ? ' rotate(' + -turn + 'deg)' : '');
      // While it zooms, the pictures as drawn are only stretched (smooth, a little soft); a moment after it stops,
      // drawn again sharp at the size it settled on. (Drawn again at every step of a zoom, the browser stuttered.)
      // That moment is long enough for a zoom stopped and started again (a wheel turned in bursts) to go on as one;
      // and the big pictures are ready by then (fetched while it zoomed, see refreshTiles), so being drawn sharp is
      // all there is to it.
      if (zooming) {
        layersEl.classList.add('zooming');
        clearTimeout(zoomSettle);
        zoomSettle = setTimeout(() => layersEl.classList.remove('zooming'), 350);
      }
    }

    sinceStatus += dt;
    if (sinceStatus > 0.25) {
      sinceStatus = 0;
      showStatus();
      // (drawn again four times a second for what fades by the clock, only while something can: a raid going on or a
      // replay playing. A paused replay or a map with no raid was drawn over and over for nothing: a quarter of a CPU
      // core on Woods, its minefields' crosses drawn each time.)
      if (replay ? replay.playing : inRaidHere()) dirty = true;
    }
    // the history page on a tab other than the map: nothing of the map is seen, so it isn't drawn
    if (HIST && !document.body.classList.contains('hpMap')) dirty = false;
    // performance mode (Settings > Screen): the map drawn at most 15 times a second; what's due waits for the next
    if (prefs.lowPower && dirty && now - drawnAt < LOW_POWER_MS) dirty = false, lowPowerOwed = true;
    else if (lowPowerOwed && now - drawnAt >= LOW_POWER_MS) { dirty = true; lowPowerOwed = false; }
    const drew = dirty;
    if (dirty) {
      dirty = false;
      drawnAt = now;
      draw();
    }
    speedFrame(now, began, drew);
    requestAnimationFrame(frame);
  }

  // ---- hands ---------------------------------------------------------------------------------------------------
  // A mouse drags the map and points by hovering. A finger drags it too, two fingers pinch it closer or further and
  // move it as they go, a tap points at what's under it (and the tip stays up until the next tap or drag), and a
  // double tap zooms in there.
  const fingers = new Map();
  let dragging = false;
  let pinch = 0;
  let pinchMid = null;
  let touching = false;
  let lastTap = null;
  // a finger has to move this far (pixels) before it's a drag rather than a tap
  const TAP_SLOP = 8;
  // and a mouse this far: a hand twitches as it presses, and a press isn't a drag
  const CLICK_SLOP = 4;
  let downAt = null;
  stage.addEventListener('pointerdown', e => {
    touching = e.pointerType !== 'mouse';
    stage.setPointerCapture(e.pointerId);
    fingers.set(e.pointerId, [e.clientX, e.clientY]);
    if (fingers.size === 1) downAt = [e.clientX, e.clientY];
    pinch = 0;
    pinchMid = null;
  });
  const startDrag = () => {
    if (dragging) return;
    dragging = true;
    stage.classList.add('dragging');
    // set aside first, so letting somebody else go doesn't take the map straight back to the player
    roam();
    chase(null);
    roamFrom = me ? [me.x, me.y] : null;
    zoomTarget = zoom;
    showTip(null);
    setHovered(0);
  };
  stage.addEventListener('pointermove', e => {
    if (e.pointerType === 'mouse') touching = false;
    const was = fingers.get(e.pointerId);
    if (!was) {
      // only pointing: not a hand on the map, which would keep it from going back to the player
      if (!touching) point(e.clientX, e.clientY);
      return;
    }
    fingers.set(e.pointerId, [e.clientX, e.clientY]);
    if (fingers.size === 1) {
      // a finger wobbles: not a drag until it has gone a little way
      if (!dragging && downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) < (touching ? TAP_SLOP : CLICK_SLOP)) return;
      const dx = e.clientX - was[0], dy = e.clientY - was[1];
      startDrag();
      panX += dx;
      panY += dy;
      dirty = true;
    } else if (fingers.size === 2) {
      const [a, b] = [...fingers.values()];
      const apart = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      startDrag();
      if (pinch && pinchMid) {
        // The map grows or shrinks about the fingers' middle and follows it: the ground that was under the middle
        // is under it still, wherever the fingers have got to.
        const under = toMap(pinchMid[0], pinchMid[1]);
        zoomBy(apart / pinch, mid[0], mid[1]);
        zoom = zoomTarget;
        const moved = toScreen(under[0], under[1]);
        panX += mid[0] - moved[0];
        panY += mid[1] - moved[1];
        zoomAt = null;
        // A pinch also says how close the player is followed from now on (a mouse has Shift and the wheel for that):
        // the map comes back to them at this zoom, not the one before.
        if (prefs.follow && chased === null && me && inRaidHere()) {
          if (prefs.autoZoom && !prefs.keepZoom) {
            const inside = stateWanted !== null ? !!stateWanted : !!me.in;
            const key = inside ? 'spanIn' : 'spanOut';
            prefs[key] = clampSpan(Math.min(vw, vh) / zoomTarget, inside ? SPAN_IN : SPAN_OUT, prefs[key]);
            showSpans();
          } else followZoom = zoomTarget;
        }
        dirty = true;
      }
      pinch = apart;
      pinchMid = mid;
    }
  });
  // A press on the map that wasn't a drag. On the player's own marker: follow the player. On somebody else's, while
  // the player isn't being followed: follow them. On nothing: nobody else is followed any more.
  // a press on loot, a container or a lock that is on another floor of the building shown: that floor is shown
  const floorTo = (sx, sy) => {
    const place = floorShown.place;
    if (!(place >= BUILDING) || !floorShown.n) return false;
    const slack = touching ? 10 : 2;
    for (let i = thingsPut.length - 1; i >= 0; i--) {
      const t = thingsPut[i];
      if (Math.hypot(sx - t.x, sy - t.y) > t.r + slack || !Array.isArray(t.p)) continue;
      const n = buildingFloor(place, t.p[0], t.p[1], t.p[2]);
      if (!n || n === floorShown.n) return false;
      floorPick = { place, n };
      setFloor(place, n);
      return true;
    }
    return false;
  };
  const pressed = (sx, sy) => {
    const slack = touching ? 10 : 0;
    let mark = null;
    for (let i = drawn.length - 1; i >= 0 && !mark; i--) {
      const d = drawn[i];
      if (Math.abs(sx - d.x) <= d.w / 2 + slack && Math.abs(sy - d.y) <= d.h / 2 + slack) mark = d.m;
    }
    if (mark && mark.c === 'Main Player') setFollow(true);
    else if (mark && ROSTER.includes(mark.c)) chase(mark.id);
    else if (floorTo(sx, sy)) dirty = true;
    else {
      chase(null);
      // on a building: look inside it (pressed inside the one open, or the one shown anyway, nothing changes); off
      // every building: the one open is shut
      const at = toMap(sx, sy);
      const b = buildingAt(at[0], at[1]);
      // where there are no buildings to press, the roofed place of the map's squares
      const spot = b || (map && map.floors && !map.floors.buildings ? placeAt(at[0], at[1]) : 0);
      if (spot && spot === insideShut) insideShut = 0;
      else if (spot && spot === lookShut) lookShut = 0;
      else if (b && prefs.pressOpen && b !== opened && b !== floorShown.place) { opened = b; revealSet(false); roam(); roamFrom = me && inRaidHere() ? [me.x, me.y] : null; }
      else if (!b && opened) opened = 0;
      // off the building shown (the one in the middle of the screen, or the one the player is in): the whole map
      // again, not dimmed
      else if (spot !== floorShown.place && floorShown.place && floorShown.n && prefs.floor === 'auto') {
        if (floorShown.place === lookAt) lookShut = lookAt;
        insideShut = floorShown.place;
        insideShutAt = me && inRaidHere() ? [me.x, me.y] : null;
      }
      setHovered(0);
      dirty = true;
    }
  };
  // the building under the pointer that a press would open, outlined and greyed over (see drawHovered)
  function setHovered(b) {
    if (b === hovered) return;
    hovered = b;
    stage.classList.toggle('canOpen', !!b && prefs.pressOpen);
    dirty = true;
  }
  const lift = e => {
    if (!fingers.delete(e.pointerId)) return;
    if (!dragging && e.pointerType === 'mouse' && e.type === 'pointerup') pressed(e.clientX, e.clientY);
    if (!dragging && e.pointerType !== 'mouse') {
      const now = performance.now();
      if (lastTap && now - lastTap.at < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
        // a double tap: in, about where it was
        lastTap = null;
        roam();
        zoomBy(2, e.clientX, e.clientY);
      } else {
        lastTap = { at: now, x: e.clientX, y: e.clientY };
        // a tap: point at what's under it, as a mouse does by hovering
        point(e.clientX, e.clientY);
        if (e.type === 'pointerup') pressed(e.clientX, e.clientY);
      }
    }
    // (one finger of two lifted: the other carries on dragging from where it is)
    if (!fingers.size) {
      dragging = false;
      stage.classList.remove('dragging');
    }
    pinch = 0;
    pinchMid = null;
  };
  stage.addEventListener('pointerup', lift);
  stage.addEventListener('pointercancel', lift);
  stage.addEventListener('pointerleave', e => {
    // a finger leaves when it lifts: what it tapped stays pointed at
    if (e.pointerType !== 'mouse') return;
    if (pointed !== null) { pointed = null; dirty = true; }
    setHovered(0);
    $('cursorAt').textContent = '';
    showTip(null);
  });
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    if (!map) return;
    // the zoom the player is followed at is kept: zooming takes the map off them, about the pointer, and it goes back
    // to them (and that zoom) as they walk on. With Shift held (or + and -), it's that zoom that changes.
    if (!e.shiftKey && following() && chased === null && inRaidHere()) roam();
    const notches = (e.deltaMode === 1 ? e.deltaY / 3 : e.deltaY / 100) || (e.deltaMode === 1 ? e.deltaX / 3 : e.deltaX / 100);
    zoomBy(Math.pow(1.175, -notches), e.clientX, e.clientY);
  }, { passive: false });

  function point(sx, sy) {
    if (!map) return;
    const at = toMap(sx, sy);
    $('cursorAt').textContent = T('Cursor:') + ' ' + at[0].toFixed(1) + ' ' + at[1].toFixed(1);
    let found = null, mark = null;
    // a finger is wider than a mouse pointer: markers are found a little further off by touch
    const slack = touching ? 10 : 0;
    for (let i = drawn.length - 1; i >= 0; i--) {
      const d = drawn[i];
      if (Math.abs(sx - d.x) <= d.w / 2 + slack && Math.abs(sy - d.y) <= d.h / 2 + slack) { found = d.m.id; mark = d.m; break; }
    }
    if (found !== pointed) { pointed = found; dirty = true; }
    // a building (not on a marker): outlined, to be pressed open, unless it's the one shown
    const b = found === null && !dragging ? buildingAt(at[0], at[1]) : 0;
    setHovered(b && b !== floorShown.place ? b : 0);
    // a marker with something to say (a corpse's loot) says it; not a marker: the nearest container, lock, item or
    // spawn point under the pointer says what it is
    const says = mark ? mark.tip || dropTip(mark) || exitTip(mark) || botTip(mark) || killTip(mark) : null;
    let near = says ? { tip: says } : null, best = Infinity;
    if (found === null) {
      for (const t of thingsDrawn) {
        const far = Math.hypot(sx - t.x, sy - t.y);
        if (far <= t.r + 4 + slack && far < best) { best = far; near = t; }
      }
    }
    showTip(near, sx, sy);
  }

  window.addEventListener('keydown', e => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.ctrlKey || e.metaKey || e.altKey) return;
    // the history page: the map's keys only on its Map tab, and none for the live map's menu or search
    if (HIST && (hp.tab !== 'map' || 'mMlLqQ/'.includes(e.key))) return;
    const step = 80;
    switch (e.key) {
      case ';': setFollow(true); break;
      case ' ': if (replay) { e.preventDefault(); $('replayPlay').click(); } break;
      case 'f': case 'F': fullScreen(); break;
      case 'h': case 'H': document.body.classList.toggle('bare'); break;
      case 'm': case 'M': togglePanel(); break;
      case 'p': case 'P': if (phone.matches) openTab('raid'); else toggleSide(); break;
      case 'l': case 'L': openTab('loot'); break;
      case 'q': case 'Q': openTab('quests'); break;
      case 'n': case 'N': setRosterNear(!prefs.rosterNear); break;
      case '/': $('find').focus(); $('find').select(); break;
      case '0': wholeMap(); break;
      case '=': case '+': zoomBy(1.4, vw / 2, vh / 2); break;
      case '-': case '_': zoomBy(1 / 1.4, vw / 2, vh / 2); break;
      case 'ArrowLeft': roam(); panX += step; dirty = true; break;
      case 'ArrowRight': roam(); panX -= step; dirty = true; break;
      case 'ArrowUp': roam(); panY += step; dirty = true; break;
      case 'ArrowDown': roam(); panY -= step; dirty = true; break;
      case 'b': case 'B': if (!e.repeat) revealDown(); break;
      case ']': case 'PageUp': stepFloor(1); break;
      case '[': case 'PageDown': stepFloor(-1); break;
      case 'Escape': if (opened) { opened = 0; dirty = true; } else if (find) { $('findClear').click(); } else togglePanel(false); break;
      default: return;
    }
    e.preventDefault();
  });

  function resized() {
    vw = stage.clientWidth || 1;
    vh = stage.clientHeight || 1;
    // the same share of the way between fully out and fully in
    const share = zoomMax > zoomMin ? (zoomTarget - zoomMin) / (zoomMax - zoomMin) : 0;
    setZoomLimits();
    zoom = zoomTarget = zoomMin + Math.min(1, Math.max(0, share)) * (zoomMax - zoomMin);
    dirty = true;
  }
  window.addEventListener('resize', resized);

  $('follow').onclick = () => setFollow(roaming ? true : !prefs.follow);
  // REC: stops recording (the raid going on, and every one after) or starts it again
  $('recBtn').onclick = () => { if (recState.on) askRec(!recState.paused); };
  if (RECORDING && !HIST) { askRec(); setInterval(() => { if (!serverAway()) askRec(); }, 60000); }
  $('fit').onclick = wholeMap;
  $('unbare').onclick = () => document.body.classList.remove('bare');
  $('options').onclick = () => togglePanel();
  // the name in the top bar: opens Settings at its foot, where the version, credits and map licence are
  // (and the maker's line under the scale, bottom left)
  $('brand').onclick = $('credit').onclick = () => {
    showTab('settings');
    togglePanel(true);
    // Settings > About, where the credits are
    const about = document.querySelector('section[data-tab="settings"] nav.subTabs button[data-view="about"]');
    if (about) about.click();
    requestAnimationFrame(() => { const b = $('panelBody'); b.scrollTop = b.scrollHeight; });
  };
  $('panelClose').onclick = () => togglePanel(false);
  $('sideClose').onclick = () => toggleSide(false);
  $('noticeClose').onclick = () => { noticeShut = noticeKey($('noticeText').textContent); $('notice').hidden = true; };
  $('listBtn').onclick = () => toggleSide();
  // the live map and the raid history: two pages, one switch between them at the top of both (links, so Ctrl or the
  // middle button opens the other in a tab of its own)
  $('modeLive').classList.toggle('on', !HIST);
  $('histRaids').classList.toggle('on', HIST);
  $('optSwap').checked = !!prefs.swap;
  $('optSwap').onchange = e => { prefs.swap = e.target.checked; save(); sidesNow(); keepOnMap(); dirty = true; };
  // (a tab pressed while searching: the search is put away and the tab shown, as it is)
  for (const b of $('tabs').children) b.onclick = () => { if (finding || $('setFind').value) { $('setFind').value = ''; findSettings(); } showTab(b.dataset.tab); };
  // a tab in parts (Loot: filters, best loot, legend): one part shown at a time, the one left open remembered
  for (const nav of document.querySelectorAll('nav.subTabs')) {
    const part = nav.parentNode, name = part.dataset.tab;
    const views = [...nav.children].map(b => b.dataset.view);
    const show = (view, remember) => {
      if (!views.includes(view)) view = views[0];
      for (const b of nav.children) b.classList.toggle('on', b.dataset.view === view);
      for (const v of part.querySelectorAll(':scope > .view')) v.hidden = v.dataset.view !== view;
      if (remember) { prefs.views = Object.assign({}, prefs.views, { [name]: view }); save(); $('panelBody').scrollTop = 0; }
      if (remember && name === 'loot') { explorePrint = null; listBest(); }
    };
    for (const b of nav.children) b.onclick = () => show(b.dataset.view, true);
    show((prefs.views || {})[name]);
  }
  // the Loot tab's key: made from what the map is drawn by, so the two can't differ
  {
    const entry = (box, mark, text) => {
      const row = document.createElement('span');
      row.append(mark, document.createTextNode(text));
      box.appendChild(row);
    };
    const mark = (text, cls, col) => {
      const b = document.createElement('b');
      b.textContent = text;
      if (cls) b.className = cls;
      if (col) b.style.setProperty('--col', col);
      return b;
    };
    entry($('keyForms'), mark('', 'dot', '#7fd36b'), T('Loot lying there now'));
    entry($('keyForms'), mark('', 'ring', '#7fd36b'), T('Loot can spawn here'));
    // one of the map's pictures on its badge, for a key
    const picture = (glyph, form, rim) => {
      const c = badge(glyph, '#1a1a24', rim, SPAWN_INK, form, 22);
      const b = mark('', 'pic'), img = document.createElement('img');
      img.src = c.toDataURL();
      img.width = img.height = Math.round(c.width / (pixelRatio()));
      img.alt = '';
      b.appendChild(img);
      return b;
    };
    entry($('keyForms'), picture('i:boxCrate', 'square', '#7c7f8f'), T('Container'));
    entry($('keyForms'), picture('i:lock', 'hex', LAYERS.locks.col), T('Lock'));
    entry($('keyForms'), (() => { const b = picture('i:star', 'round', '#0c0c12'); b.firstChild.src = badge('i:star', WISH_COL, '#0c0c12', '#0c0c12', 'round', 22).toDataURL(); return b; })(), T('On your wishlist'));
    // the Map tab's key was written with emoji: each is swapped for the picture the map draws (an emoji may or may
    // not carry a variation selector, U+FE0F, so they're matched without it)
    const plain = text => text.replace(/️/g, '');
    const drawn = {};
    for (const [emoji, glyph, form, rim] of [
      ['💰', 'i:boxSafe'], ['💵', 'i:boxRegister'], ['🗄️', 'i:boxDrawer'], ['👜', 'i:boxBag'], ['🧥', 'i:boxJacket'],
      ['🔧', 'i:boxTools'], ['💻', 'i:boxPc'], ['💊', 'i:boxMed'], ['🔫', 'i:boxWeapon'], ['💣', 'i:boxGrenade'],
      ['🥫', 'i:boxFood'], ['⛏️', 'i:boxCache'], ['💀', 'i:boxBody'], ['📦', 'i:boxCrate'],
      ['🔒', 'i:lock', 'hex', LAYERS.locks.col], ['🚙', 'i:trunk', 'hex', LAYERS.locks.col], ['💳', 'i:keycard', 'hex', LAYERS.locks.col],
      ['🚏', 'i:stop', 'round', LAYERS.btrRoad.col]
    ]) drawn[plain(emoji)] = [glyph, form || 'square', rim || '#7c7f8f'];
    for (const b of document.querySelectorAll('.legend b')) {
      const d = drawn[plain(b.textContent)];
      if (d) b.replaceWith(picture(d[0], d[1], d[2]));
    }
    entry($('keyForms'), mark('!', 'quest'), T('Quest item'));
    entry($('keyForms'), mark('!', 'quest can'), T('Quest item can spawn'));
    const k = v => v >= 1000 ? (v / 1000) + 'k' : String(v);
    WORTH.forEach(([under, col], i) => {
      const from = i ? WORTH[i - 1][0] : 0;
      entry($('keyWorth'), mark('', 'dot', col), (under === Infinity ? T('Over {a}', { a: k(from) }) : !from ? T('Under {a}', { a: k(under) }) : T('{a} to {b}', { a: k(from), b: k(under) })) + ' ₽');
    });
    for (const kind of Object.keys(SPAWN_GLYPH)) {
      const b = picture(SPAWN_GLYPH[kind], 'round', '#8a8c9a');
      entry($('keyKinds'), b, spawnKindName(kind));
    }
  }
  segment($('lootMode'), LOOT_MODES, setLoot);
  // every list of switches has "All on", "All off" and "Default" over it. All on and All off leave the switches
  // under another one as they are; Default puts those back too (a switch starts off unless it says otherwise)
  {
    const both = (before, inputs, every) => {
      const head = document.createElement('div');
      head.className = 'filterHead';
      head.append(T('Switch') + ' ');
      for (const [text, on] of [[T('All on'), true], [T('All off'), false]]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'linkBtn';
        button.textContent = text;
        button.onclick = () => { for (const input of inputs()) if (!input.disabled && input.checked !== on) input.click(); };
        head.append(button, ' ');
      }
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'linkBtn';
      back.textContent = T('Default');
      back.title = T('These switches back as they were the first time the page was opened');
      back.onclick = () => { for (const input of (every || inputs)()) if (!input.disabled && input.checked !== (input.dataset.def === '1')) input.click(); };
      head.append(back);
      before.before(head);
    };
    // Who's shown: each kind on, as an area or off, all at once; Default: every kind on, and the switches under them
    // as they were the first time
    {
      const grid = $('filtersPeople'), head = document.createElement('div');
      head.className = 'filterHead';
      head.append(T('Switch') + ' ');
      const rows = () => [...grid.querySelectorAll(':scope > .row.who')];
      for (const [text, state, title] of [[T('All on'), 'on'], [T('All as areas'), 'area', T('Every kind that can be shown as a rough area, as one. The rest are left as they are.')], [T('All off'), 'off']]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'linkBtn';
        button.textContent = text;
        if (title) button.title = title;
        button.onclick = () => { for (const row of rows()) if (state !== 'area' || AREA_ABLE.includes(row.dataset.kind)) row.setTo(state); };
        head.append(button, ' ');
      }
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'linkBtn';
      back.textContent = T('Default');
      back.title = T('These switches back as they were the first time the page was opened');
      back.onclick = () => {
        for (const row of rows()) row.setTo('on');
        for (const input of grid.querySelectorAll('label.row > input[type="checkbox"]')) if (!input.disabled && input.checked !== (input.dataset.def === '1')) input.click();
      };
      head.append(back);
      grid.before(head);
    }
    for (const id of ['boxKinds', 'edgeKinds', 'filtersMap', 'filtersLoot', 'alerts']) {
      both($(id), () => $(id).querySelectorAll(':scope > label.row:not(.sub) > input[type="checkbox"]'),
        () => $(id).querySelectorAll('label.row > input[type="checkbox"]'));
    }
    const feed = ['optFeedMine', 'optFeedPmc', 'optFeedBoss', 'optFeedAi'];
    for (const id of feed) $(id).dataset.def = '1';
    both($(feed[0]).closest('label'), () => feed.map(id => $(id)));
  }
  function setRosterNear(on) {
    prefs.rosterNear = on;
    $('sideSort').classList.toggle('on', on);
    save();
    rosterPrint = null;
    listRoster();
  }
  $('sideSort').classList.toggle('on', !!prefs.rosterNear);
  $('sideSort').onclick = () => setRosterNear(!prefs.rosterNear);
  // the one in the Raid list under the pointer (the rows are made again as the raid goes on, so the list is asked)
  $('roster').addEventListener('pointermove', e => {
    const row = e.target instanceof Element ? e.target.closest('.sideRow') : null;
    const id = row && row.dataset.id ? row.dataset.id : null;
    const found = id === null ? null : liveById.has(id) ? id : liveById.has(+id) ? +id : null;
    if (found !== rosterOver) { rosterOver = found; dirty = true; }
  });
  $('roster').addEventListener('pointerleave', () => { if (rosterOver !== null) { rosterOver = null; dirty = true; } });
  $('full').onclick = fullScreen;
  $('optFollow').checked = prefs.follow;
  $('optFollow').onchange = e => setFollow(e.target.checked);
  // one choice of three: auto zoom (autoZoom), the zoom put back after a look elsewhere, or never touched (keepZoom)
  {
    const sliders = () => { for (const id of ['optSpanIn', 'optSpanOut']) { const off = prefs.keepZoom || !prefs.autoZoom; $(id).disabled = off; $(id).closest('label').classList.toggle('unavailable', off); } };
    $('optZoomMode').value = prefs.keepZoom ? 'keep' : prefs.autoZoom ? 'auto' : 'back';
    $('optZoomMode').onchange = e => {
      prefs.keepZoom = e.target.value === 'keep';
      prefs.autoZoom = e.target.value === 'auto';
      followZoom = null;
      zoomState = null;
      save();
      sliders();
      dirty = true;
    };
    sliders();
  }
  $('optSpanIn').min = -SPAN_IN[1]; $('optSpanIn').max = -SPAN_IN[0];
  $('optSpanOut').min = -SPAN_OUT[1]; $('optSpanOut').max = -SPAN_OUT[0];
  showSpans();
  const spanChanged = (key, inside) => e => {
    prefs[key] = -e.target.value;
    showSpans();
    save();
    // seen at once while following in that state
    if (autoZooming() && zoomState === inside) { zoomTarget = stateZoom(inside); zoomAt = null; }
  };
  $('optSpanIn').oninput = spanChanged('spanIn', true);
  $('optSpanOut').oninput = spanChanged('spanOut', false);
  $('optWorth').value = String(prefs.worth);
  if ($('optWorth').value !== String(prefs.worth)) $('optWorth').value = '20000';
  $('optWorth').onchange = e => { prefs.worth = +e.target.value || 0; save(); dirty = true; };
  $('optFloatWorth').value = String(prefs.floatWorth);
  if ($('optFloatWorth').value !== String(prefs.floatWorth)) $('optFloatWorth').value = '0';
  $('optFloatWorth').onchange = e => { prefs.floatWorth = Math.max(0, +e.target.value || 0); save(); };
  // which way up this map is: as the maps people know have it, or turned by hand (kept for each map)
  $('optTurn').onchange = e => {
    if (!map) return;
    prefs.turns = Object.assign({}, prefs.turns);
    if (e.target.value === 'auto') delete prefs.turns[map.loc]; else prefs.turns[map.loc] = +e.target.value;
    save();
    setTurn(turnFor(map.loc));
  };
  for (const [id, key] of [['optBotShape', 'botShape'], ['optMeShape', 'meShape'], ['optContainerStyle', 'containerStyle']]) {
    $(id).value = prefs[key];
    $(id).onchange = e => { prefs[key] = e.target.value; save(); dirty = true; };
  }
  if (prefs.names === 'some' || prefs.names === 'players') {
    const legacy = new Option(prefs.names === 'some' ? T('Bosses and friends') : T('PMCs, bosses and friends'), prefs.names);
    legacy.hidden = true;
    $('optNames').add(legacy);
  }
  $('optNames').value = prefs.names;
  $('optNames').onchange = e => {
    prefs.names = e.target.value;
    save();
    dirty = true;
  };
  // the slider runs from far to near, like the zoom ones
  $('optClose').min = -CLOSE_SPAN[1];
  $('optClose').max = -CLOSE_SPAN[0];
  const showClose = () => { $('optClose').value = -prefs.closeSpan; $('closeText').textContent = Math.round(prefs.closeSpan) + ' m'; };
  showClose();
  $('optClose').oninput = e => { prefs.closeSpan = -e.target.value; showClose(); save(); dirty = true; };
  // the options' groups open or shut as they were left
  for (const group of document.querySelectorAll('details.group[data-group]')) {
    const name = group.dataset.group;
    if (prefs.groups && typeof prefs.groups[name] === 'boolean') group.open = prefs.groups[name];
    group.addEventListener('toggle', () => { if (finding) return; prefs.groups = Object.assign({}, prefs.groups, { [name]: group.open }); save(); });
  }
  // ---- finding a setting: the options of every tab at once, by what they say and do ------------------------------
  // A word also finds the words that go with it (PMC: players, USEC, BEAR, teams, friends), so a search shows all
  // that's to do with a thing, not only the rows that happen to name it. Every word typed must be found.
  const FIND_ALIKE = {
    pmc: ['pmc', 'player', 'usec', 'bear', 'team', 'squad', 'friend', 'people'],
    player: ['player', 'pmc', 'people', 'friend', 'team'], friend: ['friend', 'fika', 'team', 'player'],
    scav: ['scav', 'bot', 'ai'], bot: ['bot', 'ai', 'scav', 'sain', 'orbit', 'comet', 'phobos', 'questingbots', 'boss'], ai: ['ai', 'bot', 'scav'],
    boss: ['boss', 'guard', 'goon', 'follower'], loot: ['loot', 'item', 'container', 'crate', 'worth', 'wish'], item: ['item', 'loot'],
    quest: ['quest', 'task', 'found in raid', 'found-in-raid'], fir: ['found in raid', 'found-in-raid', 'fir'], kill: ['kill', 'death', 'dead', 'died', 'corpse', 'feed', 'body'],
    colour: ['colour', 'color'], color: ['colour', 'color'], name: ['name', 'label'], size: ['size', 'big', 'scale'],
    phone: ['phone', 'mobile', 'touch'], sound: ['sound', 'alert', 'beep'], alert: ['alert', 'sound', 'warn'],
    shot: ['shot', 'gun', 'bullet', 'hit', 'grenade'], door: ['door', 'lock', 'key', 'switch'], key: ['key', 'lock', 'door', 'keycard'],
    extract: ['extract', 'exit', 'transit'], building: ['building', 'roof', 'floor'], floor: ['floor', 'building', 'level']
  };
  const FIND_TABS = ['raid', 'loot', 'quests', 'map', 'presets', 'settings'], FIND_VIEWS = ['filters', 'options'];
  let finding = false;
  const findWasOpen = new Map();
  const findTerms = q => q.toLowerCase().split(/\s+/).filter(Boolean).map(w => FIND_ALIKE[w] || FIND_ALIKE[w.replace(/s$/, '')] || [w]);
  const findSays = (el, words) => { const text = (el.textContent + ' ' + titleOf(el)).toLowerCase(); return words.every(alike => alike.some(a => text.includes(a))); };
  // marks what of a part is shown: a row that says the words, or all of a group whose heading does; true: any is
  function findMark(part, words, all, inGroup) {
    let any = false;
    for (const el of part.children) {
      if (el.tagName === 'SUMMARY') continue;
      let shown = false;
      if (el.matches('.view')) shown = FIND_VIEWS.includes(el.dataset.view) && findMark(el, words, all, inGroup);
      // (the quests themselves aren't settings)
      else if (el.hidden || el.matches('nav.subTabs, #questList')) shown = false;
      else if (el.tagName === 'DETAILS') {
        const head = el.querySelector(':scope > summary');
        shown = findMark(el, words, all || (!!head && findSays(head, words)), true);
        if (shown) { if (!findWasOpen.has(el)) findWasOpen.set(el, el.open); el.open = true; }
      } else if (el.matches('.row')) shown = all || findSays(el, words);
      else if (el.querySelector('.row')) shown = findMark(el, words, all, inGroup);
      else shown = inGroup && (all || findSays(el, words));
      el.classList.toggle('findOut', !shown);
      any = any || shown;
    }
    // A switch under another (Secret ones not found yet, under Extracts) means nothing on its own: found, it brings the
    // row it's under; that row found brings the switches under it.
    const kids = [...part.children];
    const under = el => el.matches('.row.sub, .subLine');
    for (let i = 0; i < kids.length; i++) {
      if (!under(kids[i])) continue;
      let main = i - 1;
      while (main >= 0 && under(kids[main])) main--;
      if (main < 0 || !kids[main].matches('.row')) continue;
      if (!kids[i].classList.contains('findOut')) kids[main].classList.remove('findOut');
      else if (!kids[main].classList.contains('findOut') && !kids[main].hidden) {
        kids[i].classList.remove('findOut');
        for (const inner of kids[i].querySelectorAll('.findOut')) if (!inner.hidden) inner.classList.remove('findOut');
      }
    }
    return any;
  }
  function findSettings() {
    const words = findTerms($('setFind').value.trim());
    const body = $('panelBody');
    for (const el of body.querySelectorAll('.findOut, .findIn')) el.classList.remove('findOut', 'findIn');
    finding = words.length > 0;
    $('setFindClear').hidden = !$('setFind').value;
    $('panel').classList.toggle('finding', finding);
    if (!finding) {
      for (const [group, open] of findWasOpen) group.open = open;
      findWasOpen.clear();
      $('setFindNone').hidden = true;
      showTab(tab, false);
      return;
    }
    let any = false;
    for (const part of body.children) {
      const name = part.dataset.tab;
      const shown = FIND_TABS.includes(name) && findMark(part, words, false, false);
      part.classList.toggle('findIn', shown);
      if (shown) part.dataset.findName = $('tabs').querySelector('[data-tab="' + name + '"]').textContent;
      any = any || shown;
    }
    for (const view of body.querySelectorAll('.view')) view.classList.toggle('findIn', !view.classList.contains('findOut') && FIND_VIEWS.includes(view.dataset.view));
    $('setFindNone').hidden = any;
  }
  $('setFind').oninput = () => { $('panelBody').scrollTop = 0; findSettings(); };
  $('setFind').onkeydown = e => { if (e.key === 'Escape') { e.target.value = ''; findSettings(); } };
  $('setFindClear').onpointerdown = e => e.preventDefault();
  $('setFindClear').onclick = e => { e.preventDefault(); $('setFind').value = ''; findSettings(); $('setFind').focus(); };
  // the lists in the tabs are made again as the raid goes on: what's made while searching is searched too
  {
    let again = false;
    new MutationObserver(() => {
      if (!finding || again) return;
      again = true;
      requestAnimationFrame(() => { again = false; findSettings(); });
    }).observe($('panelBody'), { childList: true, subtree: true });
  }
  for (const [id, key] of [['optItemNames', 'itemNames'], ['optModTints', 'modTints'], ['optWishOnly', 'wishOnly'], ['optLootFloats', 'lootFloats'], ['optKillLines', 'killLines'], ['optFloorOnly', 'floorOnly'], ['optHitFlash', 'hitFlash'], ['optSwitches', 'switches'], ['optOrbitMain', 'orbitMain'], ['optOrbitTactics', 'orbitTactics'], ['optOrbitRush', 'orbitRush'], ['optOrbitField', 'orbitField'], ['optSquadMarks', 'squadMarks'], ['optSquadCols', 'squadCols'], ['optTeamNames', 'teamNames'], ['optDoorEvents', 'doorEvents'], ['optActionIcons', 'actionIcons'], ['optMapDifficulty', 'mapDifficulty'], ['optMapPersonality', 'mapPersonality'], ['optTacticWords', 'tacticWords'], ['optGrenades', 'grenades'], ['optPhobosField', 'phobosField'], ['optMinimap', 'minimap'], ['optKillKeep', 'killKeep'], ['optMyQuestItems', 'myQuestItems'], ['optMyQuestPlaces', 'myQuestPlaces'], ['optFriendQuests', 'friendQuests'],
    ['optInsideMine', 'insideMine'], ['optInsideLook', 'insideLook'], ['optPressOpen', 'pressOpen'], ['optEdge', 'edge'], ['optEdgeQuests', 'edgeQuests'], ['optEdgeExits', 'edgeExits'], ['optMyName', 'myName'], ['optRecSign', 'recSign'], ['optShots', 'shots'], ['optHealth', 'health'], ['optFeed', 'feed'], ['optPhoneLight', 'phoneLight'], ['optAwake', 'awake'], ['optLowPower', 'lowPower'], ['optSpeed', 'speed'], ['optFeedMine', 'feedMine'], ['optFeedPmc', 'feedPmc'], ['optFeedBoss', 'feedBoss'], ['optFeedAi', 'feedAi'], ['optOrbitLines', 'orbitLines'], ['optBotLoot', 'botLoot'],
    ['optPeek', 'peek'], ['optFog', 'rosterFog'], ['optRosterDoing', 'rosterDoing'], ['optRosterHp', 'rosterHp'],
    ['optRosterSlim', 'rosterSlim'], ['optHealthAll', 'healthAll'], ['optMapDoing', 'mapDoing'], ['optSquadParts', 'squadParts'], ['optOrbitNames', 'orbitNames'],
    ['optOrbitFights', 'orbitFights'], ['optOrbitHear', 'orbitHear'], ['optRoofLoot', 'roofLoot'], ['optRoofTotals', 'roofTotals'], ['optRoofTotalsUnder', 'roofTotalsUnder'], ['optAlertSound', 'alertSound'], ['optFeedKeep', 'feedKeep'], ['optFeedBox', 'feedBox'],
    ['optChaseRing', 'chaseRing'], ['optTipGear', 'tipGear'], ['optTipCarry', 'tipCarry'], ['optSecureShown', 'secureShown'], ['optWishMarks', 'wishMarks'], ['optModTeams', 'modTeams'], ['optWorldScale', 'worldScale'], ['optSizeByKind', 'sizeByKind']]) {
    $(id).checked = !!prefs[key];
    $(id).onchange = e => { prefs[key] = e.target.checked; save(); dirty = true; rosterPrint = bestPrint = null; tipFor = null; feedPrint = ''; listRoster(); showKills(); };
  }
  $('optAwake').addEventListener('change', keepAwake);
  $('optTrailMs').value = String(prefs.trailMs);
  $('optTrailMs').onchange = e => { prefs.trailMs = +e.target.value; save(); dirty = true; };
  // Smooth over a slow connection: as picked, else by where the page was opened from (see smoothing)
  $('optSmooth').checked = smoothing();
  $('optSmooth').onchange = e => { prefs.smooth = e.target.checked; dropHeld(); save(); };
  // the Raid list's health bars need the map's: greyed while those are off
  const healthDeps = () => { const off = !prefs.health; $('optRosterHp').disabled = off; $('optRosterHp').closest('label').classList.toggle('unavailable', off); };
  $('optHealth').addEventListener('change', healthDeps);
  healthDeps();
  // text size and map brightness
  $('optTextScale').value = prefs.textScale;
  $('optTextScale').oninput = e => { prefs.textScale = +e.target.value || 1; save(); sizesSaid(); dirty = true; };
  for (const [id, key] of [['optNameScale', 'nameScale'], ['optDoingScale', 'doingScale'], ['optContainerScale', 'containerScale']]) {
    $(id).value = prefs[key];
    $(id).oninput = e => { prefs[key] = +e.target.value || 1; save(); sizesSaid(); dirty = true; };
  }
  const mapLight = () => { $('layers').style.filter = prefs.mapLight < 100 ? 'brightness(' + prefs.mapLight / 100 + ')' : ''; $('mapLightText').textContent = prefs.mapLight + '%'; };
  $('optMapLight').value = prefs.mapLight;
  $('optMapLight').oninput = e => { prefs.mapLight = +e.target.value || 100; save(); mapLight(); };
  mapLight();
  // how close a building opens by itself: far to near, like the zoom sliders; put away while that's switched off
  $('optLookSpan').min = -LOOK_SPAN[1];
  $('optLookSpan').max = -LOOK_SPAN[0];
  const showLookSpan = () => {
    $('optLookSpan').value = -prefs.lookSpan;
    $('lookSpanText').textContent = Math.round(prefs.lookSpan) + ' m';
    $('lookSpanRow').hidden = !prefs.insideLook;
  };
  showLookSpan();
  $('optLookSpan').oninput = e => { prefs.lookSpan = -e.target.value; showLookSpan(); save(); dirty = true; };
  $('optInsideLook').addEventListener('change', showLookSpan);
  // pressing buildings switched off: the one open is shut, and the Buildings button goes
  $('optPressOpen').addEventListener('change', () => {
    if (!prefs.pressOpen) opened = 0;
    $('reveal').hidden = !(prefs.pressOpen && map && map.floors && map.floors.buildings);
  });
  for (const [id, key] of [['optRosterGhosts', 'rosterGhosts'], ['optFeedNames', 'feedNames'], ['optFeedRows', 'feedRows'], ['optFeedPos', 'feedPos']]) {
    $(id).value = prefs[key];
    $(id).onchange = e => { prefs[key] = key === 'feedRows' ? +e.target.value : e.target.value; save(); dirty = true; rosterPrint = null; feedPrint = ''; listRoster(); showKills(); };
  }
  for (const [id, key, text, unit] of [['optAreaR', 'areaR', 'areaRText', ' m'], ['optLootCell', 'lootCell', 'lootCellText', ' m'], ['optFeedBg', 'feedBg', 'feedBgText', '%']]) {
    const show = () => { $(id).value = prefs[key]; $(text).textContent = Math.round(prefs[key]) + unit; };
    show();
    $(id).oninput = e => {
      prefs[key] = +e.target.value || 0;
      show();
      save();
      dirty = true;
      if (key === 'areaR') areas.clear();
      if (key === 'feedBg') document.body.style.setProperty('--feed-bg', String(prefs.feedBg / 100));
    };
  }
  for (const n of Object.keys(BOT_MODS)) $('optBot' + n).onchange = e => { prefs['bot' + n] = e.target.checked; save(); nameBotDetails(); };
  $('optBotDiff').onchange = e => { prefs.botDiff = e.target.checked; save(); nameBotDetails(); };
  nameBotDetails();
  // names in Latin letters: the markers' names are put back as the game has them, or written again
  $('optLatin').checked = !!prefs.latin;
  $('optLatin').onchange = e => {
    prefs.latin = e.target.checked;
    save();
    for (const m of live) if (m.tn) m.t = latin(m.tn);
    if (things) for (const b of things.bodies) b.who = latin(b.whoRaw);
    for (const m of seenRoster.values()) { const now = liveById.get(m.id); if (now) m.t = now.t; }
    rosterPrint = bestPrint = null;
    dirty = true;
  };
  // the sorts of container: one switch each with its picture, all on to start with
  {
    const box = $('boxKinds');
    const SORTS = [['safe', T('Safe')], ['register', T('Cash register')], ['drawer', T('Drawer')], ['bag', T('Bag')], ['jacket', T('Jacket')],
      ['tools', T('Toolbox')], ['pc', T('PC block')], ['med', T('Medical')], ['weapon', T('Weapon box')], ['grenade', T('Grenade box')],
      ['food', T('Ration box')], ['cache', T('Buried cache')], ['body', T('Dead body')], ['crate', T('Crate')]];
    for (const [sort, text] of SORTS) {
      const row = document.createElement('label');
      row.className = 'row';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !prefs.boxOff.includes(sort);
      input.dataset.def = '1';
      input.onchange = () => {
        prefs.boxOff = SORTS.map(k => k[0]).filter(k => k === sort ? !input.checked : prefs.boxOff.includes(k));
        save();
        dirty = true;
        rosterPrint = bestPrint = bestCanPrint = null;
        listBest();
      };
      const img = document.createElement('img'), name = document.createElement('span');
      img.src = badge(BOX_GLYPH[sort], '#1a1a24', '#7c7f8f', SPAWN_INK, 'square', 48).toDataURL();
      img.width = img.height = 24;
      img.alt = '';
      name.textContent = text;
      row.append(input, img, name);
      box.appendChild(row);
    }
  }
  // the kinds of loot: one switch each, all on to start with
  {
    const box = $('lootKinds');
    for (const [kind, text] of LOOT_KINDS) {
      const row = document.createElement('label');
      row.className = 'row';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !prefs.lootOff.includes(kind);
      input.onchange = () => {
        prefs.lootOff = LOOT_KINDS.map(k => k[0]).filter(k => k === kind ? !input.checked : prefs.lootOff.includes(k));
        save();
        dirty = true;
        rosterPrint = bestPrint = null;
      };
      // its picture, as on the map's spawn points
      const img = document.createElement('img'), name = document.createElement('span');
      img.src = badge(SPAWN_GLYPH[kind] || '?', '#1a1a24', '#7c7f8f', SPAWN_INK, 'round', 48).toDataURL();
      img.width = img.height = 24;
      img.alt = '';
      name.textContent = text;
      row.append(input, img, name);
      box.appendChild(row);
    }
    const all = on => () => {
      prefs.lootOff = on ? [] : LOOT_KINDS.map(k => k[0]);
      for (const input of box.querySelectorAll('input')) input.checked = on;
      save();
      dirty = true;
      bestPrint = null;
    };
    $('lootKindsAll').onclick = all(true);
    $('lootKindsNone').onclick = all(false);
  }
  // quest items and quest places: each on or off, as the switches under "Show on this page" are
  for (const [id, category] of [['optQuestItems', 'Layer quest'], ['optQuestPlaces', 'Layer questZones'], ['optFirItems', 'Layer firItems']]) {
    $(id).checked = !isHidden(category);
    $(id).onchange = e => setHidden(category, !e.target.checked);
  }
  const showOther = () => { $('optOtherLoot').value = prefs.otherLoot; $('otherLootText').textContent = prefs.otherLoot > 0 ? Math.round(prefs.otherLoot) + '%' : 'hidden'; };
  showOther();
  $('optOtherLoot').oninput = e => { prefs.otherLoot = +e.target.value || 0; showOther(); save(); dirty = true; };
  // how dark the rest of the map is while a floor is shown
  const showFloorDim = () => {
    if (!Number.isFinite(prefs.floorDim)) prefs.floorDim = 70;
    $('optFloorDim').value = prefs.floorDim;
    $('floorDimText').textContent = prefs.floorDim > 0 ? Math.round(prefs.floorDim) + '%' : T('not darkened');
    document.body.style.setProperty('--floor-dim', String(Math.max(0, Math.min(0.95, prefs.floorDim / 100))));
  };
  showFloorDim();
  $('optFloorDim').oninput = e => { prefs.floorDim = +e.target.value || 0; showFloorDim(); save(); };
  // and grey: the rest of the map and the building's other floors without their colour, so the floor shown stands out
  const showFloorGrey = () => { $('optFloorGrey').checked = prefs.floorGrey !== false; document.body.classList.toggle('floorGrey', prefs.floorGrey !== false); };
  showFloorGrey();
  $('optFloorGrey').onchange = e => { prefs.floorGrey = e.target.checked; showFloorGrey(); save(); };
  // or hidden: only the floor shown is drawn of the building, the rest of it dark
  const showFloorHide = () => { $('optFloorHide').checked = !!prefs.floorHide; document.body.classList.toggle('floorHide', !!prefs.floorHide); };
  showFloorHide();
  $('optFloorHide').onchange = e => { prefs.floorHide = e.target.checked; showFloorHide(); save(); };
  // the search box: loot, keys and quests by name, as you type
  $('find').oninput = e => { setFind(e.target.value); findOpen = true; findNext.clear(); loadSpawns(); dirty = true; };
  $('find').onfocus = () => { findOpen = true; dirty = true; };
  const clearFind = () => { $('find').value = ''; setFind(''); findOpen = false; dirty = true; };
  $('findClear').onpointerdown = e => e.preventDefault();
  $('findClear').onclick = e => { e.preventDefault(); clearFind(); };
  $('find').onkeydown = e => {
    if (e.key === 'Escape') { clearFind(); e.target.blur(); }
    // Enter: the first one found
    if (e.key === 'Enter') { const first = $('findList').querySelector('.hit'); if (first) first.click(); }
  };
  // the list goes when the map is pressed (what was searched for stays ringed); the box brings it back
  stage.addEventListener('pointerdown', () => { if (findOpen) { findOpen = false; dirty = true; } });
  window.addEventListener('resize', () => { findShown = ''; dirty = true; });
  $('optScale').value = prefs.scale;
  // marker and text size, each with its size in percent beside it (100%: as usual)
  const sizesSaid = () => { $('scaleText').textContent = Math.round(prefs.scale * 100) + '%'; $('textScaleText').textContent = Math.round(prefs.textScale * 100) + '%';
    $('containerScaleText').textContent = Math.round(prefs.containerScale * 100) + '%';
    $('nameScaleText').textContent = Math.round(prefs.nameScale * 100) + '%'; $('doingScaleText').textContent = Math.round(prefs.doingScale * 100) + '%'; };
  $('optScale').oninput = e => { prefs.scale = +e.target.value || 1; save(); sizesSaid(); dirty = true; };
  sizesSaid();
  window.addEventListener('keyup', e => { if (e.key === 'b' || e.key === 'B') revealUp(); });
  window.addEventListener('blur', revealUp);
  $('reveal').addEventListener('pointerdown', e => { e.preventDefault(); $('reveal').setPointerCapture(e.pointerId); revealDown(); });
  $('reveal').addEventListener('pointerup', revealUp);
  $('reveal').addEventListener('pointercancel', revealUp);
  $('floorUp').onclick = () => stepFloor(1);
  $('floorDown').onclick = () => stepFloor(-1);
  // the floor it would show by itself again
  $('floorText').onclick = () => { if (floorPick) { floorPick = null; floorWantKey = ''; floorLabel(floorShown.n, floorsOf(floorShown.place)); dirty = true; } };
  $('optFloor').onchange = e => {
    prefs.floor = e.target.value === 'auto' ? 'auto' : +e.target.value || 0;
    save();
    // drawn again next frame, badge and all
    floorShown = { place: -1, n: -1 };
  };
  // in a raid, with another map picked to look at
  function awayFromRaid() {
    const there = inRaid() ? mapFor(report.loc) : null;
    return !!there && there !== map;
  }
  function backToRaid() {
    const there = inRaid() ? mapFor(report.loc) : null;
    if (!there) return;
    prefs.map = there.loc;
    save();
    showMap(there, false);
    zoomState = null;
    zoom = zoomTarget = zoomMin + Math.min(1, Math.max(0, prefs.zoom)) * (zoomMax - zoomMin);
    if (me) centreOn(me.x, me.y);
    setFollow(true);
    showStatus();
  }
  $('backRaid').onclick = backToRaid;
  $('status').onclick = () => { if (awayFromRaid()) backToRaid(); };
  const pickMap = next => { if (next) { prefs.map = next.loc; save(); showMap(next, false); showStatus(); } };
  $('map').onchange = e => pickMap(maps.find(m => m.loc === e.target.value));
  // ---- the map menu (wide screens): a row for each location; its versions and season maps beside the one pointed
  // at, so the list stays one line a location however many versions there are
  const seasonSays = m => isSnow(m.loc) ? ' · ' + SEASON_NAMES[seasonOf(m.loc)] : '';
  // a version by its own name: "Customs - Fums" under Customs is "Fums"
  const mapVariant = m => {
    // a season map is said as the map it's the season of, when there is that one
    const own = isSnow(m.loc) && maps.find(x => x.loc === noSnow(m.loc));
    let v = (own || m).vname || '';
    for (const name of [m.title, m.title.replace(/\s*\(.*\)$/, '')]) if (v.toLowerCase().startsWith(name.toLowerCase() + ' - ')) { v = v.slice(name.length + 3); break; }
    // the location's own map, captured before its version had a name: the game's own, as MapVariants calls it
    return (v || T('Vanilla')) + seasonSays(m);
  };
  // the maps by location, in the order of the list; in each, the location's own first, then each version, its season
  // maps after it
  function mapGroups() {
    const groups = new Map();
    for (const m of maps) {
      const key = String(m.base).toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    const order = m => [noSnow(m.loc).includes('~') ? 1 : 0, mapVariant(m).toLowerCase(), isSnow(m.loc) ? 1 : 0];
    for (const list of groups.values()) list.sort((a, b) => { const x = order(a), y = order(b); return x[0] - y[0] || x[1].localeCompare(y[1]) || x[2] - y[2]; });
    return [...groups.values()];
  }
  // the map picker's words: the map shown; before the maps have come, "Connecting…", as the status says, so the box
  // is there with words in it from the moment the page opens
  function mapBtnSays() {
    $('mapBtnText').textContent = map ? map.name + seasonSays(map) : T('Connecting…');
  }
  const mapRow = (text, note) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'mapRow';
    row.appendChild(document.createElement('b')).textContent = text;
    if (note) row.appendChild(document.createElement('small')).textContent = note;
    return row;
  };
  let mapSubFor = null, mapSubTimer = 0;
  function openMapSub(row, group) {
    clearTimeout(mapSubTimer);
    for (const r of $('mapMenu').children) r.classList.toggle('open', r === row && !!group);
    const sub = $('mapSub');
    mapSubFor = group ? row : null;
    if (!group) { sub.hidden = true; return; }
    sub.textContent = '';
    for (const m of group) {
      const pick = mapRow(mapVariant(m));
      pick.classList.toggle('on', !!map && m.loc === map.loc);
      pick.onclick = () => { openMapMenu(false); pickMap(m); };
      sub.appendChild(pick);
    }
    sub.hidden = false;
    // beside the row, kept on the screen
    const r = row.getBoundingClientRect(), w = sub.offsetWidth, h = sub.offsetHeight;
    sub.style.left = (r.right + w + 6 <= innerWidth ? r.right + 4 : Math.max(4, r.left - w - 4)) + 'px';
    sub.style.top = Math.max(4, Math.min(r.top - 5, innerHeight - h - 8)) + 'px';
  }
  function openMapMenu(open) {
    const menu = $('mapMenu');
    clearTimeout(mapSubTimer);
    $('mapSub').hidden = true;
    mapSubFor = null;
    $('mapBtn').setAttribute('aria-expanded', String(!!open));
    $('mapBtn').classList.toggle('on', !!open);
    if (!open) { menu.hidden = true; return; }
    menu.textContent = '';
    for (const group of mapGroups()) {
      const one = group.length === 1 ? group[0] : null;
      const row = mapRow(one ? one.name + seasonSays(one) : group[0].title, one ? '' : '›');
      row.classList.toggle('on', !!map && group.some(m => m.loc === map.loc));
      if (one) {
        row.onclick = () => { openMapMenu(false); pickMap(one); };
        row.onpointerenter = () => { clearTimeout(mapSubTimer); mapSubTimer = setTimeout(() => openMapSub(row, null), 150); };
      } else {
        row.onclick = () => openMapSub(row, group);
        // a short wait, so going across to the menu beside it over the rows between doesn't swap it
        row.onpointerenter = () => { clearTimeout(mapSubTimer); if (mapSubFor !== row) mapSubTimer = setTimeout(() => openMapSub(row, group), mapSubFor ? 150 : 0); };
      }
      menu.appendChild(row);
    }
    menu.hidden = false;
    const b = $('mapBtn').getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(b.left, innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = (b.bottom + 4) + 'px';
  }
  $('mapBtn').onclick = () => openMapMenu($('mapMenu').hidden);
  $('mapSub').onpointerenter = () => clearTimeout(mapSubTimer);
  document.addEventListener('pointerdown', e => {
    if (!$('mapMenu').hidden && !e.target.closest('#mapMenu, #mapSub, #mapBtn')) openMapMenu(false);
  }, true);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('mapMenu').hidden) { e.stopPropagation(); openMapMenu(false); }
  }, true);
  window.addEventListener('resize', () => { if (!$('mapMenu').hidden) openMapMenu(false); });
  $('session').onchange = e => {
    const game = games.find(g => g.sid === e.target.value);
    prefs.player = e.target.value ? { sid: e.target.value, name: game ? game.name : (prefs.player || {}).name || '' } : null;
    save();
    forget();
    sid = prefs.player ? prefs.player.sid : '';
    listen();
    listGames();
  };

  // ---- start ---------------------------------------------------------------------------------------------------
  // The maps the server has. Asked again every few seconds: a location is captured during its first raid.
  async function loadMaps() {
    let answer;
    try {
      // (with the mark of the ones had already: the server then only says they're the same. They run to over a
      // megabyte, which was fetched and read through every few seconds.)
      answer = await answered(await fetch('api/maps' + (mapsPrint ? '?have=' + encodeURIComponent(mapsPrint) : ''))).json();
    } catch (e) {
      if (!(e instanceof Error && /^HTTP/.test(e.message))) missed();
      return;
    }
    mapsAsked = true;
    if (answer.same) return;
    const print = answer.print || '';
    if (print === mapsPrint) return;
    mapsPrint = print;
    placesNone = lootNone = false;
    addons = (Array.isArray(answer.addons) ? answer.addons : []).filter(a => a && typeof a.loc === 'string' && a.loc);
    maps = (answer.maps || []).map(readMap).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
    const pick = $('map');
    pick.textContent = '';
    // every location a group under its name, with or without versions and season maps, so the list is all alike
    for (const group of mapGroups()) {
      const into = pick.appendChild(document.createElement('optgroup'));
      into.label = group[0].title;
      for (const m of group) {
        const o = document.createElement('option');
        o.value = m.loc;
        // a version by its own name ("Classic", "Vanilla"); a snow map said to be with snow
        o.textContent = mapVariant(m);
        into.appendChild(o);
      }
    }
    if (!$('mapMenu').hidden) openMapMenu(true);
    if (!maps.length) return;
    // the one shown, as it is now (it may have been captured again); else the raid's; else the one last looked at
    const shownNow = map && maps.find(m => m.loc === map.loc);
    if (shownNow) {
      const fresh = shownNow.v !== map.v;
      if (fresh) showMap(shownNow, true); else { map = shownNow; placeZones(); }
      $('map').value = map.loc;
    }
    // (the raid's map as it may be now: only a raid's map that's new or captured again counts as the raid changing. A
    // map written again, any of them, took the map back to the player and its starting zoom mid-raid.)
    if (report) raidChanged();
    if (!map) showMap(maps.find(m => m.loc === prefs.map) || maps[0], false);
  }

  // ?debug: made-up reports can be given to the page from the browser's console (fumsTake), to try things
  if (DEBUG) window.fumsTake = m => take(m);
  // every building of the map shown, with a spot inside its biggest part (debug only)
  if (DEBUG) window.fumsAll = () => (map && map.floors && map.floors.buildings || []).map(b => {
    const p = b.parts.reduce((big, q) => q.a > big.a ? q : big);
    let spot = [(p.box.x0 + p.box.x1) / 2, (p.box.y0 + p.box.y1) / 2];
    for (let k = 0; k < 400 && !inLoops(p.l, spot[0], spot[1]); k++) spot = [p.box.x0 + Math.random() * (p.box.x1 - p.box.x0), p.box.y0 + Math.random() * (p.box.y1 - p.box.y0)];
    return { in: spot, h: p.h, w: b.box.x1 - b.box.x0, d: b.box.y1 - b.box.y0 };
  });
  if (DEBUG) window.fumsState = () => ({ shown: floorShown, insideShut, insideShutAt, opened, mine: me && map ? placeInside() : 0, roaming, me, pan: [panX, panY, zoom],
    spots: map && map.floors && map.floors.buildings ? map.floors.buildings.slice(0, 40).map(b => ({ x: (b.box.x0 + b.box.x1) / 2, y: (b.box.y0 + b.box.y1) / 2, h: b.parts[0].h, w: b.box.x1 - b.box.x0, d: b.box.y1 - b.box.y0 })) : [], at: toScreen(me ? me.cx : 0, me ? me.cy : 0) });
  let source = null;
  // ---- raid history --------------------------------------------------------------------------------------------
  // The raids the server recorded (api/history), listed on the History tab. One played back is its reports, read
  // again by take() at the times they came: the page shows it as it showed the raid live, and the live game is set
  // aside until the replay is left. A recording is lines of "<ms since it began><tab><the report>".
  // replay: { about, times, lines, full (which lines are full reports), events (every event, "rt" when its report
  // came), total, at (ms played to), playing, speed, next (the line due next), heat }
  let historyRaids = null, historyOn = true, historyBusy = false, winsReady = false;
  const REPLAY_SPEEDS = [0.5, 1, 2, 4, 8, 16];
  const clockText = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

  async function loadHistory() {
    try {
      const j = await (await fetch('api/history')).json();
      historyRaids = list(j.raids).filter(r => r && typeof r.id === 'string');
      historyOn = j.on !== false;
      recState = { on: historyOn, paused: !!j.paused };
      historyInfo = { bytes: j.bytes || 0, keep: Number.isFinite(j.keep) ? j.keep : 30, mb: j.mb || 0, per: j.per === 'player' ? 'player' : 'all', held: new Set(list(j.held)), rr: !!j.rr, counting: j.counting || 0 };
      // older raids still being counted for the records: asked again in a while (the raids page only)
      clearTimeout(loadHistory.again);
      if (HIST && historyInfo.counting) loadHistory.again = setTimeout(() => { if (hp.tab === 'list') loadHistory(); }, 5000);
    } catch (e) { historyRaids = historyRaids || []; }
    listHistory();
  }
  function listHistory(note) {
    if (winsReady) showWins();
    const box = $('historyList');
    box.textContent = '';
    $('historyNote').textContent = note || (!historyRaids ? T('Loading…')
      : !historyOn && !historyRaids.length ? T('Raids aren\'t recorded: history.record is off in the server\'s config.jsonc.')
      : !historyRaids.length ? T('No raids recorded yet. Play one: it shows here once it has begun.') : '');
    $('historyNote').hidden = !$('historyNote').textContent;
    // (the live map's own list: the last few raids, each a way into it on the raid history page)
    for (const r of (historyRaids || []).slice(0, 12)) {
      const row = document.createElement('div');
      row.className = 'histRow';
      const look = document.createElement('a');
      look.className = 'histPlay';
      look.href = 'raids/' + encodeURIComponent(r.id);
      look.title = T('Look into this raid');
      const name = document.createElement('b'), when = document.createElement('small'), what = document.createElement('span');
      name.textContent = placeName(r.loc);
      when.textContent = new Date(r.began).toLocaleString(document.documentElement.lang || undefined, { dateStyle: 'medium', timeStyle: 'short' });
      what.textContent = [clockText(r.ms - (r.lead || 0)), r.name ? latin(r.name) + (r.hl ? ' (' + T('headless') + ')' : '') : '', TP(r.kills || 0, '{n} kill', '{n} kills') + (r.mine ? ' (' + T('{n} by the player', { n: r.mine }) + ')' : ''),
        r.exit ? (EXITS[r.exit] || r.exit) + (r.exitName && r.exit === 'Survived' ? ' (' + exitShown(r) + ')' : '') : r.died ? T('died') : '', r.live ? T('recording now') : '', r.imported ? T('imported') : ''].filter(Boolean).join(' · ');
      look.append(name, when, what);
      row.appendChild(look);
      box.appendChild(row);
    }
  }

  // A recording's text without the game's rich text that some mods put in item names ("<color=#ff8000>M4A1</color>"),
  // as JSON has it ("<" may be written <): the server and the game's plugin leave it out now, but a raid recorded
  // before kept it. Only the tags the game knows go (a name can hold a "<" of its own).
  const RICH_TAGS = new RegExp('(?:<|\\\\u003[cC])/?(?:(?:b|i|u|s|size|colou?r|alpha|mark|sup|sub|font|material|noparse|sprite|nobr|lowercase|uppercase|smallcaps|style|link|cspace|mspace|voffset|indent|line-height|pos|rotate|margin|gradient|width)'
    + '(?:\\s*=\\s*(?:\\\\"[^"<>\\\\]*\\\\"|\'[^\'"<>\\\\]*\'|[^<>\\s"\'\\\\]*)|\\s+(?:[^<>\\\\"]|\\\\")*)?|#[0-9a-fA-F]{3,8})(?:>|\\\\u003[eE])', 'gi');
  const untagged = text => text.indexOf('<') < 0 && !/\\u003[cC]/.test(text) ? text : text.replace(RICH_TAGS, '');

  // A raid recorded, loaded to be looked into on the history page: paused at its start (see hpRoute for what's shown).
  // True once it's loaded.
  async function startReplay(about) {
    if (historyBusy) return false;
    if (replay && replay.about.id === about.id) return true;
    historyBusy = true;
    hpFailed = '';
    hpShow();
    let text = '';
    try {
      const answer = await fetch('api/history/rec?id=' + encodeURIComponent(about.id));
      if (!answer.ok) throw new Error('gone');
      text = untagged(await answer.text());
    } catch (e) { historyBusy = false; hpFailed = about.id; hpShow(); return false; }
    historyBusy = false;
    if (replay) leaveReplay();
    const times = [], lines = [], full = [], events = [], loot = [];
    // (where each of the raid's containers stood, as it loaded: see addMore; an older recording has none)
    let spots = null, hasGestures = false;
    for (let from = 0; from < text.length;) {
      let end = text.indexOf('\n', from);
      if (end < 0) end = text.length;
      const tab = text.indexOf('\t', from);
      if (tab > from && tab < end) {
        const t = +text.slice(from, tab), line = text.slice(tab + 1, end);
        if (Number.isFinite(t) && line.startsWith('{"t":"th"')) loot.push([t, line]);
        else if (!spots && line.startsWith('{"t":"pl"')) {
          try { const d = JSON.parse(line).d; if (d && Array.isArray(d.boxes)) spots = { loc: shownLoc(d.loc), boxes: d.boxes }; } catch (err) { /* without them */ }
        }
        else if (Number.isFinite(t) && line.startsWith('{"t":"f')) {
          const whole = line.startsWith('{"t":"full"');
          if (whole && !hasGestures) hasGestures = line.includes('"gestures":1');
          let fine = true;
          if (whole && line.includes('"ev":[')) {
            try {
              const report = JSON.parse(line);
              for (const e of report.ev || []) if (e && e.d && Number.isFinite(e.n)) {
                // A gesture may have waited for the next full report. Both clocks include the loading screen here.
                e.rt = t;
                if ((e.k === 'bot.sight' || e.k === 'bot.share' || e.k === 'bot.voice' || e.k === 'grenade.blast' || e.k === 'comet.gesture' || e.k === 'comet.activity' || e.k === 'comet.mag' || e.k === 'orbit.main' || e.k === 'loot' || e.k === 'drop') && Number.isFinite(e.t) && Number.isFinite(report.clk))
                  e.performedAt = Math.max(0, t - Math.max(0, report.clk - e.t));
                events.push(e);
              }
            } catch (err) { fine = false; }
          }
          if (fine && !(whole && line.includes('"raid":false'))) { times.push(t); lines.push(line); full.push(whole); }
        }
      }
      from = end + 1;
    }
    if (!full.includes(true)) { hpFailed = about.id; hpShow(); return false; }
    // The wait before the raid began (loaded, nobody moving yet) is left out: the replay starts as the raid does.
    // What happened in it (switches as they stood) is kept, as of the start.
    const lead = Number.isFinite(about.lead) ? about.lead : leadOf(times, lines, full);
    if (lead > 0) {
      let keep = -1, to = 0;
      for (let i = 0; i < times.length && times[i] <= lead; i++) if (full[i]) keep = i;
      for (let i = 0; i < times.length; i++) {
        if (times[i] <= lead && i !== keep) continue;
        times[to] = Math.max(0, times[i] - lead); lines[to] = lines[i]; full[to] = full[i]; to++;
      }
      times.length = lines.length = full.length = to;
      for (const e of events) e.rt = Math.max(0, e.rt - lead);
      for (const l of loot) l[0] = Math.max(0, l[0] - lead);
    }
    // (a replay's clock is the recording's own: what the kill feed and the lists say goes by it)
    for (const e of events) e.t = e.rt;
    const mainTimes = new Map(), firstHunts = new Map();
    for (const e of events) {
      if (e.k !== 'orbit.main' || mainTimes.has(e.n)) continue;
      const t = e.performedAt == null ? e.rt : Math.max(0, e.performedAt - lead);
      mainTimes.set(e.n, t);
      // Older ORBIT recordings only say that a hunt has started. Keep the first observation
      // of each hunt as an estimate, independent of playback direction or later snapshots.
      for (const squad of list(e.d.s)) for (const goal of list(squad.MainObjectives)) {
        if (goal?.Type !== 'Kills' || goal.KillAmbush || !(goal.KillsRoamStartedAt > 0) || goal.Completed) continue;
        const key = huntKey(squad, goal);
        if (!firstHunts.has(key)) firstHunts.set(key, t);
      }
    }
    whyOf.clear();
    const r = replay = { about, lead, times, lines, full, events, total: Math.max(1, times[times.length - 1]), at: 0, playing: false, speed: REPLAY_SPEEDS.includes(prefs.hpSpeed) ? prefs.hpSpeed : 1,
      next: 0, mainTimes, firstHunts, sightings: indexSightings(events, lead), signals: indexMapSignals(events, lead), hasGestures, gestures: indexGestures(events, lead, hasGestures), activities: indexActivities(events, lead), scan: null, names: null, loot, lootAt: '', lootBaseAt: -2, lootBase: null, picks: null, spots };
    forgetSquads();
    blastMarks = [];
    // what the things picked up are worth: asked of the server (a recording doesn't hold prices)
    const asked = [...new Set(events.filter(e => (e.k === 'loot' || e.k === 'drop') && e.d.tpl).map(e => e.d.tpl))];
    if (asked.length) {
      fetch('api/history/names', { method: 'POST', body: JSON.stringify(asked) }).then(a => a.json())
        .then(j => { if (replay === r && j) { r.names = j; squadPanePrint = ''; showSquadPane(); hpPrint = ''; hpShow(); dirty = true; } }).catch(() => {});
    }
    forget();
    sid = REPLAY_SID;
    seekReplay(0);
    backToRaid();
    // the kills along the bar (their fights once the scan is done: see buildTicks)
    buildTicks(r);
    document.body.classList.add('replaying');
    showReplay();
    showStatus();
    return true;
  }
  // How long a recording that doesn't say (an older one) waited before anybody moved: when the first of them is
  // 2 m from where it stood. Nothing, when nobody has moved in its first three minutes.
  function leadOf(times, lines, full) {
    const first = new Map();
    const moved = (id, x, y) => {
      const was = first.get(id);
      if (!was) { first.set(id, [x, y]); return false; }
      return Math.hypot(x - was[0], y - was[1]) > 2;
    };
    for (let i = 0; i < times.length && times[i] < 180000; i++) {
      try {
        const d = JSON.parse(lines[i]);
        let go = false;
        if (full[i]) { for (const m of d.markers || []) if (m.dyn && m.c !== 'Airdrop' && Array.isArray(m.p) && moved(m.id, m.p[0], m.p[1])) go = true; }
        else for (const row of d.m || []) if (moved(row[0], row[1], row[2])) go = true;
        if (go) return Math.max(0, times[i] - 1500);
      } catch (e) { /* a line cut short */ }
    }
    return 0;
  }
  function feedReplay(i) {
    try { take({ sid: REPLAY_SID, name: replay.about.name || '', age: 0, rp: 1, d: JSON.parse(replay.lines[i]) }, true); } catch (e) { /* a line cut short */ }
  }
  // To a moment of the raid: the last full report before it, the fast ones since, and what had happened by then.
  function seekReplay(to) {
    const r = replay;
    if (!r) return;
    let t = Math.min(r.total, Math.max(0, to));
    let last = -1;
    for (let lo = 0, hi = r.times.length - 1; lo <= hi;) {
      const mid = (lo + hi) >> 1;
      if (r.times[mid] <= t) { last = mid; lo = mid + 1; } else hi = mid - 1;
    }
    let key = last;
    while (key >= 0 && !r.full[key]) key--;
    if (key < 0) { key = r.full.indexOf(true); last = key; t = r.times[key]; }
    replaySeeking = true;
    feedReplay(key);
    for (let i = key + 1; i <= last; i++) feedReplay(i);
    // what had happened by then, none of it told as news
    eventsSeen = new Set();
    killEvents = [];
    otherEvents = [];
    squadEvents = [];
    ghostMarks = [];
    lootFloats = [];
    switchNow = new Map();
    magNow = new Map();
    blastMarks = [];
    orbitMain = orbitField = phobosField = null;
    huntSnapshot = null; huntsByMember.clear();
    indexedOrbitMain = null; orbitByMember.clear();
    addEvents(r.events.filter(e => e.rt <= t), false);
    showKills();
    squadPanePrint = '';
    showSquadPane();
    replaySeeking = false;
    // the pick-ups of the last few seconds before it, as if just seen: rising and fading from where they'd be by now
    // (so dragging along the timeline shows them too; the latest 30 at most)
    const now = performance.now();
    for (const e of r.events.filter(x => (x.k === 'loot' || x.k === 'drop' || x.k === 'door') && x.rt <= t && t - x.rt < FLOAT_MS).slice(-30)) {
      const before = lootFloats.length;
      floatLoot(e);
      if (lootFloats.length > before) lootFloats[lootFloats.length - 1].at = now - (t - e.rt);
    }
    r.next = last + 1;
    r.paced = -1;
    r.at = t;
    r.lootAt = '';
    replayLoot(r);
    rosterPrint = null;
    listRoster();
    dirty = true;
  }
  // What lay about and what everybody carried at this moment of the replay: the last of it recorded by then (the
  // first, before any was), less what's been picked up since. The loot is kept about once a minute; every pick-up in
  // between is an event with the item and where the one picking it up stood, so the nearest such item lying there
  // (within a few metres), else in the nearest container, leaves the map then and not at the next minute. A raid
  // recorded before this was kept has none.
  const TAKEN_REACH = 4;
  function replayLoot(r) {
    let at = r.loot.length ? 0 : -1;
    for (let i = 1; i < r.loot.length && r.loot[i][0] <= r.at; i++) at = i;
    const since = at < 0 ? 0 : r.loot[at][0];
    if (!r.picks) {
      r.picks = [];
      const seen = new Set();
      for (const e of r.events) {
        if ((e.k !== 'loot' && e.k !== 'drop') || !e.d?.tpl || seen.has(e.n)) continue;
        seen.add(e.n);
        r.picks.push({ ...e, t: e.performedAt == null ? e.rt : Math.max(0, e.performedAt - r.lead) });
      }
      r.picks.sort((a, b) => a.t - b.t || a.n - b.n);
    }
    const taken = lastAt(r.picks, r.at) + 1;
    const key = at + '|' + taken;
    if (key === r.lootAt) return;
    const base = at === r.lootBaseAt ? r.lootBase : null;
    r.lootAt = key;
    try {
      if (!base) { r.lootBase = at < 0 ? null : readThings(JSON.parse(r.loot[at][1]).d); r.lootBaseAt = at; }
      things = r.lootBase ? takenAway(r.lootBase, r.picks.slice(lastAt(r.picks, since) + 1, taken)) : null;
    } catch (e) { things = null; }
    addMore();
    bestPrint = rosterPrint = null;
    tipFor = null;
    dirty = true;
  }
  // a copy of a loot snapshot less the pick-ups given (see replayLoot)
  function takenAway(base, picks) {
    if (!picks.length) return base;
    const loose = base.loose.slice(), inside = Object.assign({}, base.inside);
    const boxes = places && places.boxes ? places.boxes : [];
    const carried = { ...base.carried };
    let names = base.names;
    for (const e of picks) {
      const d = e.d;
      if (e.p) {
        const inventory = carried[e.p] || [];
        if (e.k === 'drop') {
          // Drops have no source slot. Subtract only when the rows agree on its location.
          const rows = inventory.filter(i => i[0] === d.tpl);
          if (rows.length && rows.every(i => i[2] === rows[0][2])) {
            let count = d.q || 1;
            carried[e.p] = inventory.flatMap(i => {
              if (i[0] !== d.tpl || count <= 0) return [i];
              const used = Math.min(count, i[1]); count -= used;
              return used === i[1] ? [] : [[i[0], i[1] - used, ...i.slice(2)]];
            });
          }
        } else if (['Backpack', 'Pockets', 'TacticalVest', 'SecuredContainer'].includes(d.in)) {
          const row = [d.tpl, d.q || 1];
          if (d.in === 'SecuredContainer') row.push(d.in);
          carried[e.p] = [...inventory, row];
          if (!names[d.tpl] && d.i) {
            if (names === base.names) names = { ...base.names };
            names[d.tpl] = { n: d.i, s: d.i };
          }
        }
      }
      if (e.k !== 'loot' || !Array.isArray(d.at)) continue;
      const [x, y] = e.d.at, tpl = e.d.tpl, far = (px, py) => Math.hypot(px - x, py - y);
      let best = -1, bestD = TAKEN_REACH;
      loose.forEach((it, i) => { if (it.tpl === tpl) { const d = far(it.x, it.y); if (d < bestD) { best = i; bestD = d; } } });
      if (best >= 0) { loose.splice(best, 1); continue; }
      // (not lying about: out of the nearest container with one in it)
      let box = null, boxD = TAKEN_REACH;
      for (const b of boxes) {
        const items = inside[b.id];
        if (!items || !items.some(i => i[0] === tpl)) continue;
        const d = far(b.p[0], b.p[1]);
        if (d < boxD) { box = b; boxD = d; }
      }
      if (box) {
        const items = inside[box.id].slice(), i = items.findIndex(k => k[0] === tpl);
        items.splice(i, 1);
        inside[box.id] = items;
      }
    }
    return Object.assign({}, base, { loose, inside, carried, names });
  }
  // each frame: the reports due by now
  function playReplay(dt) {
    const r = replay;
    if (!r || !r.playing) return;
    r.at += dt * 1000 * r.speed;
    // things glide from one report's place to the next's in the time between them, as fast as the replay goes. In a
    // Fika raid recorded from its host, the player's own reports ("own", their place from their own game) come between
    // the host's: they're left out of the timing, as on the live map, or every bot would glide in half its time
    for (; r.next < r.times.length && r.times[r.next] <= r.at; r.next++) {
      const i = r.next;
      feedReplay(i);
      if (r.lines[i].indexOf('"own":') >= 0) continue;
      if (r.paced >= 0 && r.paced < i) period = Math.min(1000, Math.max(16, (r.times[i] - r.times[r.paced]) / r.speed));
      r.paced = i;
    }
    if (r.at >= r.total) { r.at = r.total; r.playing = false; }
    replayLoot(r);
    showReplay();
    dirty = true;
  }
  let replaySeeking = false, replayDragging = false, replayShown = '';
  function showReplay() {
    const r = replay;
    if (!r) return;
    showActionOverlay(r);
    showBotLine();
    // the playhead and what's been played, every frame (not only as the rest is redone), so the dot moves smoothly
    const at = (100 * r.at / r.total) + '%';
    if ($('replayHead').style.left !== at) $('replayFill').style.width = $('replayHead').style.left = at;
    const said = (r.playing ? 1 : 0) + '|' + Math.floor(r.at / 250) + '|' + r.speed + '|' + (prefs.heat ? 1 : 0) + (prefs.trails === false ? 0 : 1) + (prefs.minimap === false ? 0 : 1)
      + (prefs.killKeep ? 1 : 0) + (prefs.hpSettings ? 1 : 0) + (prefs.hpNoPeople ? 1 : 0) + (prefs.hpNoEvents ? 1 : 0) + (prefs.shots ? 1 : 0)
      + (prefs.mapDoing ? 1 : 0) + (prefs.hpNoFacing ? 1 : 0) + (prefs.hpDebug ? '|' + r.next : '');
    if (said === replayShown) return;
    replayShown = said;
    $('replayPlay').textContent = r.playing ? '❚❚' : '▶';
    $('replayPlay').title = r.playing ? T('Pause (Space)') : T('Play (Space)');
    $('replayPlay').classList.toggle('on', r.playing);
    $('replayStop').classList.toggle('on', !r.playing);
    $('replayClock').textContent = clockText(r.at);
    $('replayTotal').textContent = clockText(r.total);
    if (!replayDragging) $('replaySeek').value = String(Math.round(1000 * r.at / r.total));
    for (const b of $('replaySpeeds').children) b.classList.toggle('on', +b.dataset.speed === r.speed);
    $('replayGear').classList.toggle('on', !!prefs.hpSettings);
    $('replayMore').hidden = !prefs.hpSettings;
    $('replayTrails').classList.toggle('on', prefs.trails !== false);
    $('replayKeep').classList.toggle('on', !!prefs.killKeep);
    $('replaySpree').classList.toggle('on', !!prefs.lootSprees);
    $('replayMini').classList.toggle('on', prefs.minimap !== false);
    $('replayPeople').classList.toggle('on', !prefs.hpNoPeople);
    $('replayEvents').classList.toggle('on', !prefs.hpNoEvents);
    $('replayShots').classList.toggle('on', !!prefs.shots);
    $('replayGestures').classList.toggle('on', prefs.hpGestures !== false);
    $('replayGestures').setAttribute('aria-pressed', String(prefs.hpGestures !== false));
    $('replayOverlayToggle').setAttribute('aria-pressed', String(!!prefs.hpActions));
    $('replayOverlayToggle').classList.toggle('on', !!prefs.hpActions);
    $('replayDoing').classList.toggle('on', !!prefs.mapDoing);
    $('replayFacing').classList.toggle('on', !prefs.hpNoFacing);
    for (const b of $('replayModes').children) b.classList.toggle('on', b.dataset.mode === replayMode());
    $('replayTicks').hidden = $('replayFights').hidden = !!prefs.hpNoEvents;
    $('replayColorPick').value = KINDS['Main Player'].col;
    $('replayColorBack').disabled = !prefs.cols['Main Player'];
    // Debug: how far through, how fast, and which report of the recording is shown
    $('replayDebug').hidden = !prefs.hpDebug;
    if (prefs.hpDebug) $('replayDebug').textContent = Math.round(100 * r.at / r.total) + '% · ' + r.speed + '× · ' + T('report {n} of {all}', { n: Math.min(r.next, r.times.length), all: r.times.length })
      + ' · ' + Math.round(r.at) + ' ms · ' + Math.round(period) + ' ms ' + T('between reports');
    // (the map's top bar has the Positions | Heat map switch, as Raid Review has it over its map)
    for (const b of $('hpView').children) b.classList.toggle('on', (b.dataset.v === 'heat') === !!prefs.heat);
    // the panel beside the map that follows the moment shown, every second or so while it plays
    if (!r.playing || performance.now() - hpSideAt > 1000) hpSideShow();
  }
  // The bot pressed (followed) in a replay: what it was doing over the raid, as a line of colours over the bar, a
  // colour for each mod that decided for it. Pointing at a stretch says what; pressing goes there.
  let botLinePrint = '';
  function showBotLine() {
    const r = replay, box = $('replayBot'), track = r && chased !== null && r.scan ? r.scan.tracks.get(chased) : null;
    const print = track ? chased + '|' + track.act.length + '|' + track.t.length : '';
    if (print === botLinePrint) return;
    botLinePrint = print;
    box.hidden = !track;
    if (!track) return;
    const strip = $('replayBotStrip'), end = track.t[track.t.length - 1];
    strip.setAttribute('aria-label', track.name || ONE[track.c] || track.c);
    strip.textContent = '';
    track.act.forEach((a, i) => {
      const until = i + 1 < track.act.length ? track.act[i + 1].t : end, part = document.createElement('i');
      part.style.left = (100 * a.t / r.total) + '%';
      part.style.width = Math.max(0.15, 100 * (until - a.t) / r.total) + '%';
      part.style.background = a.by ? DOING_COL[a.by] || '#8a8c9a' : '#3a3c48';
      part.title = clockText(a.t) + (a.by ? ' · ' + (a.by === 'EFT' ? '' : a.by + ': ') + a.text : '');
      strip.appendChild(part);
    });
  }
  $('replayBotStrip').onclick = e => {
    if (!replay) return;
    const box = $('replayBotStrip').getBoundingClientRect();
    seekReplay(replay.total * Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)));
    replayShown = '';
    showReplay();
  };
  function leaveReplay() {
    if (!replay) return;
    replay = null;
    $('actionDock').hidden = true;
    actionFrame = null;
    // (its containers back where places.json has them)
    addMore();
    replayShown = '';
    hpPrint = '';
    showBotLine();
    lootFloats = [];
    forget();
    sid = '';
    $('replayBar').hidden = true;
    forgetSquads();
    blastMarks = [];
    document.body.classList.remove('replaying');
    showStatus();
    dirty = true;
  }
  // how fast it plays: a button each, as Raid Review has them (with half speed as well)
  for (const speed of REPLAY_SPEEDS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.speed = String(speed);
    b.textContent = (speed === 0.5 ? '½' : speed) + '×';
    b.onclick = () => { if (!replay) return; replay.speed = speed; prefs.hpSpeed = speed; save(); showReplay(); };
    $('replaySpeeds').appendChild(b);
  }
  $('replayPlay').onclick = () => {
    if (!replay) return;
    if (!replay.playing && replay.at >= replay.total) seekReplay(0);
    replay.playing = !replay.playing;
    showReplay();
  };
  // stop: paused, back at the start
  // The replay's mode, along its bar: Performance (Performance mode: drawn at most 15 times a second), Normal, or
  // Debug (prefs.hpDebug: the line under the timeline, and anything a mod's debugging draws checks it)
  const replayMode = () => prefs.hpDebug ? 'debug' : prefs.lowPower ? 'perf' : 'normal';
  for (const b of $('replayModes').children) {
    b.onclick = () => {
      prefs.lowPower = b.dataset.mode === 'perf';
      prefs.hpDebug = b.dataset.mode === 'debug';
      $('optLowPower').checked = prefs.lowPower;
      if (prefs.hpDebug) { prefs.hpTab = 'bots'; prefs.hpSideOff = false; }
      save(); hpShow(); hpSideShow(); replayShown = ''; showReplay(); tipFor = null; dirty = true;
    };
  }
  $('replayStop').onclick = () => { if (!replay) return; replay.playing = false; seekReplay(0); replayShown = ''; showReplay(); };
  $('replayGear').onclick = () => { prefs.hpSettings = !prefs.hpSettings; save(); replayShown = ''; showReplay(); };
  $('replayKeep').onclick = () => { prefs.killKeep = !prefs.killKeep; $('optKillKeep').checked = prefs.killKeep; save(); replayShown = ''; showReplay(); dirty = true; };
  $('replaySpree').onclick = () => { prefs.lootSprees = !prefs.lootSprees; $('replaySpree').classList.toggle('on', prefs.lootSprees); save(); if (replay && replay.scan && replay.scan.done) buildSprees(replay); };
  // the cog's other switches: each flips one setting of the replay's map
  for (const [id, flip] of [['replayPeople', () => { prefs.hpNoPeople = !prefs.hpNoPeople; }], ['replayEvents', () => { prefs.hpNoEvents = !prefs.hpNoEvents; }],
    ['replayGestures', () => { prefs.hpGestures = prefs.hpGestures === false; }],
    ['replayOverlayToggle', () => { prefs.hpActions = !prefs.hpActions; actionFrame = null; }],
    ['replayShots', () => { prefs.shots = !prefs.shots; }], ['replayDoing', () => { prefs.mapDoing = !prefs.mapDoing; }],
    ['replayFacing', () => { prefs.hpNoFacing = !prefs.hpNoFacing; }]]) {
    $(id).onclick = () => { flip(); save(); replayShown = ''; showReplay(); tipFor = null; dirty = true; };
  }
  // (only once picked: Firefox on Windows says black as its colour window opens, see the Colours settings)
  $('replayColorPick').onchange = e => { setCol('Main Player', hex6(e.target.value)); replayShown = ''; showReplay(); };
  $('replayColorBack').onclick = () => { setCol('Main Player', null); replayShown = ''; showReplay(); };  $('replaySeek').oninput = e => { replayDragging = true; seekReplay(replay ? replay.total * (+e.target.value) / 1000 : 0); replayShown = ''; showReplay(); };
  $('replaySeek').onchange = () => { replayDragging = false; };
  $('historyRefresh').onclick = loadHistory;

  // One pass over a replay's full reports, a few at a time so the page stays quick: where everybody was (the heat
  // map and the trails), and how many of each side were alive (the charts).
  // groups: the sides the charts count, each in its kind's colour
  // on another floor than the one shown, while only that floor's people are wanted (Map > Selected floor only)
  const offFloor = (x, y, z) => !!prefs.floorOnly && Number.isFinite(z) && otherFloor(x, y, z) !== 0;
  const GROUPS = [['Friendly Player', ['Main Player', 'Friendly Player']], ['Enemy Player', ['Enemy Player']], ['Scav', ['Scav', 'Sniper']],
    ['Boss', ['Boss', 'Guard', 'Goon', 'Cultist']], ['Other AI', null]];
  const groupOf = kind => { const i = GROUPS.findIndex(g => g[1] && g[1].includes(kind)); return i < 0 ? GROUPS.length - 1 : i; };
  function scanReplay(r) {
    if (r.scan) return r.scan;
    // shotLog: every shot as [when, whose marker], in order (the fight before each kill: see fightsOf). drops: each
    // airdrop by its marker, when and where it was first seen down
    const s = r.scan = { i: 0, done: false, heat: new Map(), tracks: new Map(), ts: [], alive: GROUPS.map(() => []), botsAlive: [], peak: 0, mods: null, blasts: [], print: '', picture: null,
      shotLog: [], drops: new Map(), sentBy: new Set(), myHp: [], myE: [], myW: [], myKnown: false, myUpkeep: false };
    // every shot, by whose it was; a sixth number in one says it hit somebody (a newer plugin's)
    const whereNow = id => { const tr = s.tracks.get(id); return tr && tr.x.length ? [tr.x[tr.x.length - 1], tr.y[tr.y.length - 1]] : null; };
    const shotsOf = (rows, t) => {
      for (const b of blastsOf(rows, whereNow)) {
        const from = whereNow(b.who), inferred = { t, x: b.x, y: b.y, who: b.who, pid: s.tracks.get(b.who)?.pid, fx: from?.[0], fy: from?.[1] };
        const candidates = recentSignals(r.signals.blasts, t + 600, 1201);
        if (!candidates.some(mark => sameBurst(mark, inferred))) s.blasts.push(inferred);
      }
      for (const row of rows || []) {
        if (!Array.isArray(row) || row.length < 5) continue;
        s.shotLog.push([t, row[0]]);
        const track = s.tracks.get(row[0]);
        if (track) track.shots++;
        if (row.length >= 6) { s.hitsKnown = true; if (track) track.hits++; }
      }
    };
    const more = () => {
      if (replay !== r) return;
      const until = performance.now() + 10;
      while (s.i < r.lines.length && performance.now() < until) {
        if (r.full[s.i]) {
          try {
            const counts = GROUPS.map(() => 0), t = r.times[s.i];
            const d = JSON.parse(r.lines[s.i]);
            shotsOf(d.sh, t);
            if (Array.isArray(d.brains)) s.mods = d.brains;
            if (Array.isArray(d.has) && d.has.length) s.has = d.has;
            let bots = 0, mine = null;
            for (const m of d.markers || []) {
              if (m.c === 'Main Player') mine = m;
              if (m.c === 'Airdrop' && Array.isArray(m.p) && !s.drops.has(m.id)) s.drops.set(m.id, { t, x: m.p[0], y: m.p[1], name: m.t ? latin(m.t) : '' });
              if (!m.dyn || !Array.isArray(m.p) || m.c === 'BTR' || m.c === 'Airdrop') continue;
              let spots = s.heat.get(m.c);
              if (!spots) s.heat.set(m.c, spots = []);
              spots.push(m.p[0], m.p[1], m.p[2] || 0);
              let track = s.tracks.get(m.id);
              if (!track) s.tracks.set(m.id, track = { c: m.c, name: '', pid: '', shots: 0, hits: 0, hurt: [], t: [], x: [], y: [], z: [], act: [], beh: [], first: t, last: t, lv: 0, sd: '', g: '', df: '', ps: '', downs: 0, dn: false });
              track.c = m.c;
              // (each time its health went down: see fightsOf)
              if (Array.isArray(m.hp)) { if (track.hp0 !== undefined && m.hp[0] < track.hp0 - 0.5) track.hurt.push(t); track.hp0 = m.hp[0]; }
              track.t.push(t); track.x.push(m.p[0]); track.y.push(m.p[1]); track.z.push(m.p[2] || 0);
              // (which mods sent bots anywhere: QuestingBots has a fold of its own beside the map)
              if (m.os) s.sentBy.add(m.os);
              if (m.t) track.name = latin(m.t);
              if (!track.pid) track.pid = m.pid || m.u || (m.c === 'Main Player' ? r.about.sid || '' : '');
              // who they are, and what a bot was doing, each time that changed (see the Raid window)
              track.last = t;
              if (m.lv || m.bl) track.lv = m.lv || m.bl;
              if (m.sd) track.sd = m.sd;
              if (m.g || m.bg) track.g = m.g || 'b' + m.bg;
              if (m.df) track.df = m.df;
              if (m.ps) track.ps = m.ps;
              if (m.ch) track.ch = m.chd || track.ch || '-';
              if (m.dn && !track.dn) track.downs++;
              track.dn = !!m.dn;
              if (!PEOPLE.includes(m.c)) {
                bots++;
                const b = behaviourOf(m), saidB = b[0] + '|' + b[1] + (m.gh ? '|g' : '');
                if (!track.beh.length || track.beh[track.beh.length - 1].said !== saidB) track.beh.push({ t, k: b[0], text: b[1], said: saidB, gh: !!m.gh });
              }
              // what it was doing, each time that changed (see the bot's line over the replay's bar)
              const brain = hasDetails(m) ? brainOf(m) : null, said = brain ? brain.by + '|' + brain.text : '';
              if (!track.act.length || track.act[track.act.length - 1].said !== said) track.act.push({ t, said, by: brain ? brain.by : '', text: brain ? brain.text : '' });
              counts[groupOf(m.c)]++;
            }
            s.ts.push(t);
            // the player's health (as a share of whole) and energy and water, each report (the last known where a
            // report hasn't them)
            const last = list => list.length ? list[list.length - 1] : 0;
            if (mine && Array.isArray(mine.hp) && mine.hp[1] > 0) { s.myKnown = true; s.myHp.push(Math.round(100 * mine.hp[0] / mine.hp[1])); } else s.myHp.push(last(s.myHp) || 100);
            if (mine && Array.isArray(mine.eh)) { s.myUpkeep = true; s.myE.push(mine.eh[0]); s.myW.push(mine.eh[1]); } else { s.myE.push(last(s.myE)); s.myW.push(last(s.myW)); }
            s.botsAlive.push(bots);
            if (bots > s.peak) s.peak = bots;
            counts.forEach((n, g) => s.alive[g].push(n));
          } catch (e) { /* a line cut short */ }
        } else if (r.lines[s.i].includes('"sh":[')) {
          try { shotsOf(JSON.parse(r.lines[s.i]).sh, r.times[s.i]); } catch (e) { /* a line cut short */ }
        }
        s.i++;
      }
      s.done = s.i >= r.lines.length;
      dirty = true;
      if (!s.done) setTimeout(more, 0);
      else {
        const tracksByPid = new Map();
        for (const track of s.tracks.values()) if (track.pid) tracksByPid.set(track.pid, track);
        for (const b of r.signals.blasts) {
          const tr = tracksByPid.get(b.pid);
          if (tr) {
            const at = tr.t.findLastIndex(t => t <= b.t);
            if (at >= 0) { b.fx = tr.x[at]; b.fy = tr.y[at]; }
          }
          s.blasts.push(b);
        }
        s.blasts.sort((a, b) => a.t - b.t);
        buildTicks(r); hpPrint = ''; hpShow(); hpSideShow();
      }
    };
    more();
    return s;
  }

  // The fight each kill ended (worked out once the scan is done), as long as it lasted: back from the kill for as long
  // as the killer or the one killed kept fighting, by whichever of these goes back furthest:
  //  - the shots either fired, with no gap of more than FIGHT_GAP (the game only says the shots fired near the player,
  //    so far off there are none),
  //  - the times either was hurt, the same way,
  //  - what either was doing (as the Behaviour tab has it): the run of fighting each was in at the kill, a break of
  //    under 4 s in it not ending it.
  // At most FIGHT_MOST back. A kill with none of these before it (a one-tap, a grenade, a fall) has no fight: tap.
  // r.fights: kill event -> { a: when to play it from, from: when the fight began (the kill, for a tap), b: the kill,
  // tap, v: the marker of the one killed, k: the killer's }
  const FIGHT_GAP = 15000, FIGHT_MOST = 120000, FIGHT_TAP = 1500;
  const FIGHTING = new Set(['combat', 'cover', 'grenade', 'flee', 'cometPush', 'cometHold', 'cometCrossfire', 'cometCover', 'cometPatch']);
  function fightsOf(r) {
    if (r.fights) return r.fights;
    const s = r.scan;
    if (!s || !s.done) return null;
    const idOf = new Map();
    for (const [id, t] of s.tracks) if (t.pid) idOf.set(t.pid, id);
    const log = s.shotLog;
    r.fights = new Map();
    for (const e of r.events) {
      if (e.k !== 'kill') continue;
      const who = [idOf.get(e.d.k), idOf.get(e.p)].filter(id => id !== undefined), most = e.rt - FIGHT_MOST;
      let start = e.rt;
      // the shots (the last by the kill, a little after it for the one that did it)
      let i = -1;
      for (let lo = 0, hi = log.length - 1; lo <= hi;) { const mid = (lo + hi) >> 1; if (log[mid][0] <= e.rt + 500) { i = mid; lo = mid + 1; } else hi = mid - 1; }
      for (let at = e.rt; i >= 0; i--) {
        const [t, by] = log[i];
        if (at - t > FIGHT_GAP || t < most) break;
        if (who.includes(by)) { at = t; if (t < start) start = t; }
      }
      for (const id of who) {
        const track = s.tracks.get(id);
        if (!track) continue;
        // hurt
        let at = e.rt + 1000;
        for (let k = track.hurt.length - 1; k >= 0; k--) {
          const t = track.hurt[k];
          if (t > e.rt + 1000) continue;
          if (at - t > FIGHT_GAP || t < most) break;
          at = t;
        }
        if (at < start) start = at;
        // fighting, as it was at the kill
        const beh = track.beh;
        let k = beh.length - 1;
        while (k >= 0 && beh[k].t > e.rt) k--;
        if (k < 0 || !FIGHTING.has(beh[k].k)) continue;
        let from = beh[k].t;
        for (let j = k - 1; j >= 0 && from > most; j--) {
          if (FIGHTING.has(beh[j].k)) from = beh[j].t;
          else if (beh[j + 1].t - beh[j].t > 4000) break;
        }
        if (Math.max(from, most) < start) start = Math.max(from, most);
      }
      const tap = start > e.rt - FIGHT_TAP;
      // (far from the player ORBIT runs the bots, and settles a fight between them at once: no shots, nobody hurt
      // before it. Said so, rather than passed off as a one-shot kill.)
      const killer = e.d.k ? idOf.get(e.d.k) : undefined;
      const orbit = tap && !PEOPLE.includes(e.d.kk) && killer !== undefined && [killer].some(id => {
        const act = (s.tracks.get(id) || {}).act || [];
        let k = act.length - 1;
        while (k >= 0 && act[k].t > e.rt) k--;
        return k >= 0 && act[k].by === 'ORBIT';
      });
      r.fights.set(e, { a: tap ? Math.max(0, e.rt - 4000) : Math.max(0, start - 1000), from: tap ? e.rt : start, b: e.rt, tap, orbit, v: idOf.get(e.p), k: e.d.k ? idOf.get(e.d.k) : undefined });
    }
    return r.fights;
  }
  // The pins of the kills along the replay's timeline (see buildTicks)
  const SKULL_PIC = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M8 1.3C4.3 1.3 1.8 3.8 1.8 7c0 1.9.9 3.4 2.3 4.2v1.9c0 .6.4 1 1 1h.9v-1.5h1.3v1.5h1.4v-1.5h1.3v1.5h.9c.6 0 1-.4 1-1v-1.9c1.4-.8 2.3-2.3 2.3-4.2 0-3.2-2.5-5.7-6.2-5.7ZM5.5 6a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2Zm5 0a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2ZM8 9.4l1 1.7H7Z"/></svg>';
  const BURST_PIC = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="' + Array.from({ length: 16 }, (_, i) => {
    const a = Math.PI * i / 8, far = i % 2 ? 3.2 : 7;
    return (i ? 'L' : 'M') + (8 + far * Math.sin(a)).toFixed(2) + ' ' + (8 - far * Math.cos(a)).toFixed(2);
  }).join('') + 'Z"/></svg>';
  const killerSort = kind => PEOPLE.includes(kind) ? T('Player') : kind === 'Enemy Player' ? 'PMC' : ONE[kind] || kind || '';
  function buildTicks(r) {
    const skulls = $('replayTicks'), bands = $('replayFights'), grid = $('replayGrid'), fights = fightsOf(r);
    skulls.textContent = '';
    bands.textContent = '';
    grid.textContent = '';
    // a faint line each minute (or each two, five, ten: so their times are 44 px apart or more), so where a moment is
    // can be told at a glance
    const across = $('replayTrack').clientWidth || 900, step = [60000, 120000, 300000, 600000].find(t => across * t / r.total >= 44) || 600000;
    for (let t = step; t < r.total; t += step) {
      const line = mk('i');
      line.style.left = (100 * t / r.total) + '%';
      line.dataset.t = clockText(t);
      grid.appendChild(line);
    }
    // The kills, as Raid Review marks them: a skull on the bar's top edge at each (kills too close to tell apart at
    // this width share one, with how many), a thin line straight down the bar at each kill's moment, and behind it,
    // faint, the fight it ended, from its first moment (see fightsOf: none for a kill with no fight before it). One
    // colour, red: the player's own kills ringed in gold, the player's death a black skull, a gas death an orange burst.
    // Pointed at, a skull or a fight says who killed whom and how long the fight lasted; pressed, the fight plays from
    // its start, following the killer. (The bar made narrower or wider: worked out again, see below.)
    const kills = r.events.filter(e => e.k === 'kill').sort((x, y) => x.rt - y.rt), wide = $('replayTrack').clientWidth || 900;
    ticksWide = wide;
    $('replayTip').hidden = true;
    const pct = t => (100 * t / r.total) + '%', px = t => wide * t / r.total;
    const fightOf = e => fights ? fights.get(e) : null;
    const playFrom = e => { const f = fightOf(e); return f ? f.a : Math.max(0, e.rt - 4000); };
    const killerOf = e => { const f = fightOf(e); return f ? (f.k !== undefined ? f.k : f.v) : undefined; };
    const hide = () => { $('replayTip').hidden = true; };
    const press = e => ev => { ev.stopPropagation(); hide(); viewKill(e, playFrom(e), killerOf(e)); };
    const byLength = kills.slice().sort((x, y) => {
      const fx = fightOf(x), fy = fightOf(y);
      return (fy && !fy.tap ? y.rt - fy.from : 0) - (fx && !fx.tap ? x.rt - fx.from : 0);
    });
    for (const e of byLength) {
      const f = fightOf(e);
      if (f && !f.tap) {
        const band = mk('i', 'fightBand');
        band.style.left = pct(f.from);
        band.style.width = pct(e.rt - f.from);
        band.onmouseenter = () => killCard(band, r, [e], f.from, e.rt);
        band.onmouseleave = hide;
        // pressed: of the fights there (they can overlap), the one that began first, from its start
        band.onclick = ev => {
          const t = r.total * (ev.clientX - $('replayTrack').getBoundingClientRect().left) / wide;
          let first = e, firstFrom = f.from;
          for (const k of kills) { const g = fightOf(k); if (g && !g.tap && g.from <= t && k.rt >= t && g.from < firstFrom) { first = k; firstFrom = g.from; } }
          press(first)(ev);
        };
        bands.appendChild(band);
      }
    }
    for (const e of kills) {
      const line = mk('b', PEOPLE.includes(e.d.kk) ? 'mine' : PEOPLE.includes(e.d.vk) ? 'died' : '');
      line.style.left = pct(e.rt);
      bands.appendChild(line);
    }
    // A skull for each kill, over its own line, all on the bar's top edge: near ones overlap, as Raid Review's do; one
    // right over another (under NUDGE px apart) is nudged along so both show, its line staying at its kill.
    const NUDGE = 9;
    let lastX = -1e9, lastAt = -1e9;
    for (const e of kills) {
      const x = px(e.rt);
      const at = x - lastX < NUDGE ? lastAt + NUDGE : x;
      lastX = x;
      lastAt = at;
      const mine = PEOPLE.includes(e.d.kk), died = PEOPLE.includes(e.d.vk), gas = !!e.d.gas;
      const skull = mk('b', 'skull' + (mine ? ' mine' : '') + (died ? ' died' : '') + (gas ? ' gas' : ''));
      skull.innerHTML = gas ? BURST_PIC : SKULL_PIC;
      skull.style.left = (100 * at / wide) + '%';
      skull.onmouseenter = () => killCard(skull, r, [e]);
      skull.onmouseleave = hide;
      skull.onclick = press(e);
      skulls.appendChild(skull);
    }
    buildSprees(r);
  }
  // Loot sprees: somebody picking up SPREE_MOST things or more with no gap of over SPREE_GAP between them (a bot
  // clearing a marked room, a player going through a stash). A mark along the bar's foot over each, green for the
  // player's own; pointed at, who and how much; pressed, the map goes there following them. Replay cog > Loot sprees.
  const SPREE_GAP = 45000, SPREE_MOST = 5;
  function spreesOf(r) {
    if (r.sprees) return r.sprees;
    const by = new Map();
    for (const e of r.events) {
      if (e.k !== 'loot' || !e.d) continue;
      const key = e.p !== undefined ? e.p : e.nm;
      if (key === undefined) continue;
      if (!by.has(key)) by.set(key, []);
      by.get(key).push(e);
    }
    r.sprees = [];
    for (const list of by.values()) {
      list.sort((x, y) => x.rt - y.rt);
      let run = [];
      const close = () => { if (run.length >= SPREE_MOST) r.sprees.push(run); run = []; };
      for (const e of list) {
        if (run.length && e.rt - run[run.length - 1].rt > SPREE_GAP) close();
        run.push(e);
      }
      close();
    }
    return r.sprees;
  }
  function buildSprees(r) {
    const lane = $('replaySprees');
    lane.textContent = '';
    lane.hidden = !prefs.lootSprees;
    if (!prefs.lootSprees) return;
    // (the player's own sprees green)
    const mainKey = (raidPeople(r).find(p => p.kind === 'Main Player') || {}).key;
    // the marker a spree's picker is (its loot says their profile), to follow them; none known: the place instead
    const trackOf = pid => { if (pid !== undefined && r.scan && r.scan.tracks) for (const [id, t] of r.scan.tracks) if (t.pid === pid) return id; return null; };
    // Sprees at the same time (two bots clearing rooms at once) one over another, a row each, so none hides another:
    // each in the lowest row that's free by then (marks are 5 px at the least, and a little apart). Three rows at most.
    const ROWS = 3, wide = $('replayTrack').clientWidth || 900, least = r.total * 9 / wide, rowEnds = [];
    const runs = spreesOf(r).slice().sort((x, y) => x[0].rt - y[0].rt);
    let rows = 1;
    for (const run of runs) {
      const first = run[0], last = run[run.length - 1], end = Math.max(last.rt, first.rt + least);
      let row = rowEnds.findIndex(e => e <= first.rt);
      if (row < 0) row = rowEnds.length < ROWS ? rowEnds.length : rowEnds.indexOf(Math.min(...rowEnds));
      rowEnds[row] = end;
      rows = Math.max(rows, row + 1);
      const who = first.nm ? latin(first.nm) : T('Somebody');
      const worth = run.reduce((sum, e) => sum + (Number.isFinite(lootWorth(e.d)) ? lootWorth(e.d) : 0), 0);
      const mark = mk('i', mainKey !== undefined && first.p === mainKey ? 'mine' : '');
      mark.style.left = (100 * first.rt / r.total) + '%';
      mark.style.width = (100 * Math.max(0, last.rt - first.rt) / r.total) + '%';
      mark.style.bottom = (1 + row * 9) + 'px';
      mark.title = T('{who} picked up {n} things in {t}', { who, n: run.length, t: clockText(last.rt - first.rt) }) + (worth > 0 ? ' · ' + roubles(worth) : '')
        + ' · ' + clockText(first.rt);
      mark.onclick = ev => { ev.stopPropagation(); rvGo(first.rt, first.d.at, trackOf(first.p)); };
      lane.appendChild(mark);
    }
    // the lane as tall as its rows, and what sits over it moved up to match
    $('replayTrack').style.setProperty('--spree-h', (1 + rows * 9) + 'px');
  }
  let ticksWide = 0;
  if (window.ResizeObserver) new ResizeObserver(() => {
    const w = $('replayTrack').clientWidth;
    if (w && replay && replay.scan && replay.scan.done && Math.abs(w - ticksWide) > 4) buildTicks(replay);
  }).observe($('replayTrack'));
  // the card over a pin: for each kill on it, when, who killed whom (and what each was), with what; and that pressing
  // it plays the fight (the first one's, the player's own if one's there), following the killer
  // (start: where the fight of several kills begins, played from there)
  function killCard(skull, r, group, start, end) {
    const tip = $('replayTip'), fights = fightsOf(r), mine = group.find(e => PEOPLE.includes(e.d.kk)) || group[0];
    tip.textContent = '';
    for (const e of group) killLines(tip, e);
    // what a press does: the fight, from its start, following whoever killed
    const f = fights ? fights.get(mine) : null, first = start !== undefined ? start : f && !f.tap ? f.from : null;
    const from = first !== null ? first : null, who = mine.d.kn ? latin(mine.d.kn) : '';
    // how long it lasted (a one-tap: no fight)
    const last = (end !== undefined ? end : mine.rt) - (from !== null ? from : mine.rt);
    tip.appendChild(mk('div', 'kcHow', last >= FIGHT_TAP ? T('The fight lasted {t}', { t: clockText(last) })
      : f && f.orbit ? T('Settled by ORBIT away from the player: no fight to show') : T('No fight before it: one shot')));
    const go = from !== null ? T('Press to watch the fight, from {t}', { t: clockText(Math.max(0, from - 1000)) }) : T('Press to watch it');
    tip.appendChild(mk('div', 'kcGo', go + (who ? ' · ' + T('following {who}', { who }) : '')));
    tip.hidden = false;
    // over the pin, inside the bar
    const bar = $('replayBar').getBoundingClientRect(), at = skull.getBoundingClientRect(), w = tip.offsetWidth;
    tip.style.left = Math.min(bar.width - w - 8, Math.max(8, at.left + at.width / 2 - bar.left - w / 2)) + 'px';
    tip.style.bottom = (bar.bottom - at.top + 8) + 'px';
  }
  function killLines(tip, e) {
    const d = e.d, victim = e.nm ? latin(e.nm) : ONE[d.vk] || d.vk || '';
    if (tip.childElementCount) tip.appendChild(mk('div', 'kcSep'));
    const head = mk('div', 'kcHead');
    head.append(mk('b', 'kcSort', d.gas ? T('Gas explosion') : d.kn ? killerSort(d.kk) + ' ' + T('killed') + ' ' + killerSort(d.vk) : killerSort(d.vk) + ' ' + T('died')), mk('span', 'kcTime', clockText(e.rt)));
    tip.appendChild(head);
    const who = mk('div', 'kcWho');
    const name = (text, kind) => { const s = mk('span', '', text); s.style.color = (KINDS[kind] || OTHER).col; return s; };
    if (d.kn) who.append(name(latin(d.kn), d.kk), mk('i', '', ' → '), name(victim, d.vk));
    else who.appendChild(name(victim, d.vk));
    tip.appendChild(who);
    if (killSaid(d)) tip.appendChild(mk('div', 'kcHow', killSaid(d)));
  }
  // The bar itself: pressed or dragged anywhere along it, the replay goes to that moment; pointed at, it says when.
  (() => {
    const track = $('replayTrack'), frac = e => { const b = track.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)); };
    const seekTo = e => { if (!replay) return; seekReplay(replay.total * frac(e)); replayShown = ''; showReplay(); };
    // (a kill's pin and a loot spree's mark are pressed, not dragged from: theirs is the press)
    track.addEventListener('pointerdown', e => { if (e.button || e.target.closest('.skull, .fightBand, #replaySprees i')) return; track.setPointerCapture(e.pointerId); replayDragging = true; seekTo(e); });
    track.addEventListener('pointermove', e => {
      if (!replay) return;
      if (replayDragging && e.buttons) seekTo(e);
      const hover = $('replayHover');
      hover.hidden = false;
      hover.style.left = (100 * frac(e)) + '%';
      hover.textContent = clockText(replay.total * frac(e));
    });
    const done = () => { replayDragging = false; };
    track.addEventListener('pointerup', done);
    track.addEventListener('pointercancel', done);
    track.addEventListener('pointerleave', () => { $('replayHover').hidden = true; $('replayTip').hidden = true; });
  })();
  // to the fight a kill ended, on the map (the kill feed's View)
  // (start, follow: a fight of several kills on the timeline: from its start, following its lead killer)
  function viewKill(e, start, follow) {
    const r = replay;
    if (!r) return;
    const f = fightsOf(r), mine = f ? (f.get(e) || [...f.entries()].find(([k]) => k.n === e.n && k.rt === e.rt)) : null, fight = mine && mine.a !== undefined ? mine : mine ? mine[1] : null;
    // following the killer (the one killed, when nobody killed them or the killer wasn't recorded)
    const who = follow !== undefined ? follow : fight ? (fight.k !== undefined ? fight.k : fight.v) : null;
    const from = start !== undefined ? start : fight ? fight.a : null;
    rvGo(from !== null ? from + 2500 : e.rt, e.d.at, who === undefined ? null : who);
    // far enough out that the one killed is on the screen too, with the killer in the middle (where each stood at
    // the kill: "ka" and "at"); never closer than going there would have been
    const ka = e.d.ka, at = e.d.at;
    if (Array.isArray(ka) && Array.isArray(at)) {
      const apart = Math.hypot(ka[0] - at[0], ka[1] - at[1]);
      if (apart > 1) { zoom = zoomTarget = Math.max(zoomMin, Math.min(zoomTarget, 0.36 * Math.min(vw, vh) / apart)); zoomAt = null; dirty = true; }
    }
  }

  // The heat map: where people went over the whole raid, and how many of them. Each one's path is filled in between
  // the places recorded (so somebody running leaves a trail, not a row of dots), and each square metre counts each
  // person once, however long they stood there: a guard or a sniper camping one spot all raid is one person there,
  // not a red blot, and a route many took is what glows. Softened into a smooth field some metres wide and coloured
  // from blue (one went by) through green and yellow to red (the most of anywhere). It's softened by a few pixels on
  // the screen, not metres, so a way someone went reads as the same soft band however far in or out the map is: the
  // count of the whole map is made once (again when the kinds shown or the floor change), and a picture of it for
  // each step of zoom, kept, laid on the map as it moves; the map under it is dimmed. The minimap shows it too.
  const HEAT_PX = 4, HEAT_GAP = 6000, HEAT_JUMP = 40;
  // the softening, in squares, kept to a few sizes so zooming makes only a few pictures
  const HEAT_STEPS = [1, 2, 3, 4, 6, 8, 11, 16, 22, 32, 45];
  // how solid the heat is at its busiest (the map shows through everywhere)
  const HEAT_SEE = 0.6;
  let heatLut = null;
  function heatRamp() {
    if (heatLut) return heatLut;
    const strip = document.createElement('canvas');
    strip.width = 256;
    strip.height = 1;
    const sg = strip.getContext('2d'), ramp = sg.createLinearGradient(0, 0, 256, 0);
    for (const [at, col] of [[0, '#1b2bd6'], [0.3, '#1f8fff'], [0.48, '#19d3e6'], [0.62, '#36e05a'], [0.78, '#ffe52b'], [0.9, '#ff8a1c'], [1, '#ff2a1c']]) ramp.addColorStop(at, col);
    sg.fillStyle = ramp;
    sg.fillRect(0, 0, 256, 1);
    return heatLut = sg.getImageData(0, 0, 256, 1).data;
  }
  // three passes of a box blur, along the rows then the columns: as good as a gaussian, and quick
  function blurGrid(src, w, h, r) {
    if (r < 1) return src;
    let a = src, b = new Float32Array(src.length);
    const pass = (from, to, len, count, step, stride) => {
      for (let line = 0; line < count; line++) {
        const o = line * stride;
        let sum = 0;
        for (let i = -r; i <= r; i++) sum += from[o + Math.min(len - 1, Math.max(0, i)) * step];
        for (let i = 0; i < len; i++) {
          to[o + i * step] = sum / (2 * r + 1);
          sum += from[o + Math.min(len - 1, i + r + 1) * step] - from[o + Math.max(0, i - r) * step];
        }
      }
    };
    for (let k = 0; k < 3; k++) {
      pass(a, b, w, h, 1, w);
      pass(b, a, h, w, w, 1);
    }
    return a;
  }
  // the heat of a replay, as a picture of the whole map: { img, cell, print } (null while the scan isn't done)
  // (perMetre: how many pixels a metre is where it's laid)
  function heatPicture(perMetre) {
    const s = replay && scanReplay(replay);
    if (!s || !s.done || !map) return null;
    const kinds = new Set([...s.heat.keys()].filter(k => !isHidden(k) && !prefs.areaKinds.includes(k)));
    const print = [...kinds].join(',') + '|' + map.loc + '|' + (prefs.floorOnly ? floorShown.place + ':' + floorShown.n : '');
    if (!s.heatCount || s.heatCount.print !== print) s.heatCount = heatCount(s, kinds, print);
    const hc = s.heatCount, want = HEAT_PX / Math.max(1e-3, perMetre) / hc.cell;
    const r = HEAT_STEPS.reduce((best, n) => Math.abs(Math.log(n / want)) < Math.abs(Math.log(best / want)) ? n : best, HEAT_STEPS[0]);
    if (hc.pics.has(r)) return hc.pics.get(r);
    // (while the map is still zooming: the nearest picture made already, so zooming stays smooth; the right one is
    // made once it's settled)
    if (hc.pics.size && Math.abs(zoom - zoomTarget) > zoom * 0.01) {
      dirty = true;
      return [...hc.pics].reduce((best, p) => Math.abs(Math.log(p[0] / r)) < Math.abs(Math.log(best[0] / r)) ? p : best)[1];
    }
    hc.pics.set(r, heatShade(hc, r));
    return hc.pics.get(r);
  }
  // how many people went by each square of the map: { grid, w, h, cell, print, pics (softening -> picture) }
  function heatCount(s, kinds, print) {
    // a square a metre across, coarser on a big map (no more than about 1100 across)
    const spanX = map.max.x - map.min.x, spanY = map.max.y - map.min.y, cell = Math.max(1, Math.max(spanX, spanY) / 1100);
    const w = Math.max(1, Math.ceil(spanX / cell)), h = Math.max(1, Math.ceil(spanY / cell)), grid = new Float32Array(w * h);
    // (the squares the one being added has been in: each counts them once)
    let been = new Set();
    const add = (x, y, z) => {
      if (offFloor(x, y, z)) return;
      const cx = Math.floor((x - map.min.x) / cell), cy = Math.floor((y - map.min.y) / cell);
      if (cx < 0 || cy < 0 || cx >= w || cy >= h) return;
      const at = cy * w + cx;
      if (been.has(at)) return;
      been.add(at);
      grid[at] += 1;
    };
    for (const track of s.tracks.values()) {
      if (!kinds.has(track.c)) continue;
      been = new Set();
      const { t, x, y, z } = track;
      if (t.length) add(x[0], y[0], z[0]);
      for (let i = 1; i < t.length; i++) {
        const dt = t[i] - t[i - 1], d = Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
        // (a gap in the recording, or a jump across the map: not walked, so not filled in)
        if (dt > HEAT_GAP || d > HEAT_JUMP) { add(x[i], y[i], z[i]); continue; }
        const steps = Math.max(1, Math.ceil(d / (cell * 0.75)));
        for (let k = 1; k <= steps; k++) {
          const f = k / steps;
          add(x[i - 1] + (x[i] - x[i - 1]) * f, y[i - 1] + (y[i] - y[i - 1]) * f, z[i - 1] + (z[i] - z[i - 1]) * f);
        }
      }
    }
    return { grid, w, h, cell, print, pics: new Map() };
  }
  // the count softened by r squares and coloured: { img, cell, w, h }
  function heatShade(hc, r) {
    const { w, h, cell } = hc;
    const soft = blurGrid(Float32Array.from(hc.grid), w, h, r);
    // "the most" is what the busiest places have (the top one in two hundred of the squares anyone went by), and the
    // scale is eased (a square root) so one person's way is still plain to see beside a route everybody took
    const busy = new Float32Array(Math.ceil(soft.length / 3));
    let n = 0;
    for (let i = 0; i < soft.length; i += 3) if (soft[i] > 1e-6) busy[n++] = soft[i];
    const went = busy.subarray(0, n).sort();
    const top = n ? went[Math.min(n - 1, Math.floor(n * 0.995))] : 1;
    const img = document.createElement('canvas');
    img.width = w;
    img.height = h;
    const g = img.getContext('2d'), out = g.createImageData(w, h), px = out.data, lut = heatRamp();
    for (let i = 0; i < soft.length; i++) {
      if (soft[i] <= 1e-6) continue;
      const v = Math.sqrt(Math.min(1, soft[i] / top));
      if (v < 0.03) continue;
      const k = Math.min(255, Math.round(v * 255)) * 4, o = i * 4;
      px[o] = lut[k]; px[o + 1] = lut[k + 1]; px[o + 2] = lut[k + 2];
      // see-through: from nothing at the very edges, rising smoothly, to at most HEAT_SEE where it's busy
      const e = Math.min(1, (v - 0.03) / 0.5);
      px[o + 3] = Math.round(255 * HEAT_SEE * e * e * (3 - 2 * e));
    }
    g.putImageData(out, 0, 0);
    return { img, cell, w, h };
  }
  // the picture laid on the map: square by square onto the map's own metres, however it's turned
  function layHeat(g, pic, place) {
    const o = place(map.min.x, map.min.y), ex = place(map.min.x + pic.cell, map.min.y), ey = place(map.min.x, map.min.y + pic.cell);
    g.save();
    g.transform(ex[0] - o[0], ex[1] - o[1], ey[0] - o[0], ey[1] - o[1], o[0], o[1]);
    // (the browser's usual smoothing: "high" is slow on a picture this big, drawn every frame)
    g.imageSmoothingEnabled = true;
    g.drawImage(pic.img, 0, 0);
    g.restore();
  }
  function drawHeat() {
    if (!replay || !prefs.heat || !map) return;
    const pic = heatPicture(zoom);
    ctx.save();
    ctx.fillStyle = 'rgba(6, 6, 12, 0.55)';
    ctx.fillRect(0, 0, vw, vh);
    ctx.restore();
    if (pic) layHeat(ctx, pic, toScreen);
    else dirty = true;
  }

  // Trails, in a replay: where each one has been in the last minute, a line behind them in their kind's colour.
  const TRAIL_MS = 60000;
  // a step no one could walk or drive: over 30 m at more than 25 m/s (moved, not gone there)
  const trailJump = (track, i) => {
    const d = Math.hypot(track.x[i] - track.x[i - 1], track.y[i] - track.y[i - 1]);
    return d > 30 && d * 1000 / Math.max(1, track.t[i] - track.t[i - 1]) > 25;
  };
  // how far along a track (in metres, from its first place) its point i is: worked out once for each point, and on
  // from there as a raid still being recorded adds to the track
  function trailFrom(track, i) {
    const far = track.far || (track.far = []);
    for (let k = far.length; k < track.t.length; k++) far.push(k ? far[k - 1] + Math.hypot(track.x[k] - track.x[k - 1], track.y[k] - track.y[k - 1]) : 0);
    return far[i] || 0;
  }
  function drawTrails(scale) {
    if (!replay || prefs.trails === false) return;
    const s = scanReplay(replay), at = replay.at, span = prefs.trailMs === 0 ? Infinity : prefs.trailMs || TRAIL_MS;
    // (a dot every 6 px or so: round caps on a dash next to nothing)
    const dots = [0.01, 6 * scale];
    ctx.save();
    ctx.lineJoin = ctx.lineCap = 'round';
    for (const [id, track] of s.tracks) {
      if (isHidden(track.c) || prefs.areaKinds.includes(track.c)) continue;
      const here = liveById.get(id);
      if (here && offFloor(here.cx, here.cy, here.cz)) continue;
      const t = track.t;
      let hi = -1;
      for (let lo = 0, top = t.length - 1; lo <= top;) { const mid = (lo + top) >> 1; if (t[mid] <= at) { hi = mid; lo = mid + 1; } else top = mid - 1; }
      // (gone from the raid: no trail left behind)
      if (hi < 1 || at - t[hi] > 3000) continue;
      // (back to where it was put down: a bot moved there by the game, as RUAF are as they come in, isn't trailed
      // from where it was held before)
      let from = hi;
      while (from > 0 && t[from - 1] >= at - span && t[from] - t[from - 1] < 5000 && !trailJump(track, from)) from--;
      if (hi - from < 1) continue;
      ctx.beginPath();
      for (let i = from; i <= hi; i++) { const p = toScreen(track.x[i], track.y[i]); if (i === from) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]); }
      const now = liveById.get(id);
      if (now && Number.isFinite(now.cx)) { const p = toScreen(now.cx, now.cy); ctx.lineTo(p[0], p[1]); }
      // dotted and faint, so it stays behind the markers. The dots are laid from the track's start (how far along it
      // the trail begins), so they stay put on the ground as the trail's tail moves on, instead of crawling.
      ctx.setLineDash(dots);
      ctx.lineDashOffset = trailFrom(track, from) * zoom;
      ctx.globalAlpha = 0.3;
      ctx.lineWidth = 4.2 * scale;
      ctx.strokeStyle = '#000';
      ctx.stroke();
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 2.4 * scale;
      ctx.strokeStyle = (now && teamColOf(now)) || (KINDS[track.c] || OTHER).col;
      ctx.stroke();
    }
    ctx.restore();
  }

  // Kills on the map, live and in a replay: for a few seconds a line from where the killer stood to where the other
  // died, and a mark there with who it was. (An older plugin doesn't say where: nothing is drawn for its kills.)
  const KILL_MS = 12000;
  function drawKills(scale) {
    if (prefs.killLines === false) return;
    const now = performance.now();
    // (in a replay the marks can be left standing: every death so far)
    const keep = !!replay && !!prefs.killKeep;
    const list = replay ? replay.events.filter(e => e.k === 'kill' && replay.at >= e.rt && (keep || replay.at - e.rt < KILL_MS))
      : killEvents.filter(e => now - e.at < KILL_MS);
    if (!list.length) return;
    let fresh = false;
    ctx.save();
    ctx.lineCap = 'round';
    for (const e of list) {
      const d = e.d;
      // Never more than the map shows anyway: the line from the killer, and their name, only when their kind is shown
      // (the player always is); the kill itself when the one who died is shown, or the player or a friend shown
      // killed them.
      const seen = kind => !!kind && !isHidden(kind) && !prefs.areaKinds.includes(kind);
      const byUs = d.kk === 'Main Player' || (d.kk === 'Friendly Player' && seen(d.kk));
      const killerSeen = d.kk === 'Main Player' || seen(d.kk);
      if (!Array.isArray(d.at) || offFloor(d.at[0], d.at[1], d.at[2]) || !(seen(d.vk || 'None') || byUs)) continue;
      const age = replay ? replay.at - e.rt : now - e.at, old = age >= KILL_MS, s = toScreen(d.at[0], d.at[1]), r = (old ? 4 : 5.5) * scale;
      ctx.globalAlpha = old ? 0.6 : Math.min(1, (KILL_MS - age) / 2500);
      if (!old) fresh = true;
      if (killerSeen && Array.isArray(d.ka) && !old) {
        const k = toScreen(d.ka[0], d.ka[1]);
        for (const [width, col] of [[4.5, 'rgba(0,0,0,0.75)'], [2, inkOf((KINDS[d.kk] || OTHER).col)]]) {
          ctx.beginPath();
          ctx.moveTo(k[0], k[1]);
          ctx.lineTo(s[0], s[1]);
          ctx.setLineDash(width === 2 ? [7 * scale, 6 * scale] : []);
          ctx.lineWidth = width * scale;
          ctx.strokeStyle = col;
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }
      if (d.gas) {
        // killed by a gas explosion: an orange burst
        ctx.beginPath();
        for (let i = 0; i < 16; i++) { const a = i * Math.PI / 8, k = i % 2 ? 0.75 : 1.65; ctx.lineTo(s[0] + Math.cos(a) * r * k, s[1] + Math.sin(a) * r * k); }
        ctx.closePath();
        ctx.fillStyle = '#ff8a1c';
        ctx.fill();
        ctx.lineWidth = 1.8 * scale;
        ctx.strokeStyle = '#000';
        ctx.stroke();
      } else {
        // a small red disc with a white cross: somebody died here
        ctx.beginPath();
        ctx.arc(s[0], s[1], r * 1.3, 0, Math.PI * 2);
        ctx.fillStyle = '#c8322c';
        ctx.fill();
        ctx.lineWidth = 1.5 * scale;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(s[0] - r * 0.55, s[1] - r * 0.55); ctx.lineTo(s[0] + r * 0.55, s[1] + r * 0.55);
        ctx.moveTo(s[0] + r * 0.55, s[1] - r * 0.55); ctx.lineTo(s[0] - r * 0.55, s[1] + r * 0.55);
        ctx.lineWidth = 1.8 * scale;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
      }
      const text = old ? '' : (e.nm ? latin(e.nm) : ONE[d.vk] || '') + (d.kn && killerSeen ? '  ←  ' + latin(d.kn) : d.gas ? '  ·  ' + T('Gas explosion') : '');
      if (text) {
        // above the mark (under it is where the body's own name goes); with the killer close by, above the two of
        // them, clear of the killer's marker and its badges, so it never lies over a marker or the killer's name
        let top = s[1] - r * 1.3;
        if (killerSeen && Array.isArray(d.ka)) {
          const k = toScreen(d.ka[0], d.ka[1]);
          if (Math.abs(k[0] - s[0]) < 90 * scale && Math.abs(k[1] - s[1]) < 50 * scale && k[1] - 22 * scale < top) top = k[1] - 12 * scale;
        }
        ctx.font = '600 ' + Math.round(10.5 * scale) + 'px ' + FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.lineJoin = 'round';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.9)';
        ctx.strokeText(text, s[0], top - 5 * scale);
        ctx.fillStyle = '#ffd9d6';
        ctx.fillText(text, s[0], top - 5 * scale);
      }
    }
    ctx.restore();
    if (fresh) dirty = true;
  }

  // ---- a replay's numbers: the leaderboard and the charts ----
  // who did what, from the raid's events: [{ name, kind, kills, far, items, worth, died: { t, by } }]
  function raidPeople(r) {
    const people = new Map();
    const one = (key, name, kind) => {
      if (!key) return null;
      let p = people.get(key);
      if (!p) people.set(key, p = { key, id: null, name: '', kind: '', kills: 0, killList: [], far: 0, items: 0, drops: 0, worth: 0, died: null, left: null, end: null, shots: 0, hits: 0, gear: 0,
        sd: '', team: 0, lv: 0, df: '', ps: '', sain: '', spawn: null, downs: 0 });
      if (name) p.name = latin(name);
      if (kind) p.kind = kind;
      return p;
    };
    for (const e of r.events) {
      const d = e.d;
      if (e.k === 'kill') {
        const dead = one(e.p || 'n:' + e.nm, e.nm, d.vk), killer = d.k || d.kn ? one(d.k || 'n:' + d.kn, d.kn, d.kk) : null;
        if (dead) dead.died = { t: e.rt, by: d.kn ? latin(d.kn) : '', w: d.w, m: d.m, bp: d.bp, at: d.at, gas: !!d.gas, e };
        if (killer && killer !== dead) { killer.kills++; killer.killList.push(e); if (d.m > killer.far) killer.far = d.m; }
      } else if (e.k === 'loot') {
        const who = one(e.p || 'n:' + e.nm, e.nm, d.wk), worth = lootWorth(d);
        if (who) { who.items += d.q || 1; if (Number.isFinite(worth)) who.worth += worth; }
      } else if (e.k === 'drop') {
        const who = one(e.p || 'n:' + e.nm, e.nm, d.wk);
        if (who) who.drops += d.q || 1;
      } else if (e.k === 'left') {
        const who = one(e.p, e.nm, d.wk);
        if (who) who.left = { t: e.rt, x: d.x };
      } else if (e.k === 'end') {
        const who = one(e.p || r.about.sid, r.about.name, 'Main Player');
        if (who) who.end = { st: d.st, ex: d.ex, t: e.rt };
      }
    }
    // what each fired and hit, who they were, and what they came into the raid with (the first loot kept of the raid)
    let gear = null;
    try { gear = r.loot.length ? JSON.parse(r.loot[0][1]).d : null; } catch (e) { gear = null; }
    const mates = new Map();
    for (const track of r.scan ? r.scan.tracks.values() : []) if (track.g) mates.set(track.g, (mates.get(track.g) || 0) + 1);
    for (const [id, track] of r.scan ? r.scan.tracks : []) {
      const who = one(track.pid || 'n:' + track.name, track.name, track.c);
      if (!who) continue;
      who.id = id;
      who.shots += track.shots;
      who.hits += track.hits;
      who.sd = track.sd;
      // (a team: two or more who came in together, people or bots: a PMC squad, a boss and its guards, a scav group)
      who.team = track.g && mates.get(track.g) > 1 ? squadNo(track.g) : 0;
      who.lv = track.lv;
      who.df = track.df;
      who.ps = track.ps;
      who.sain = [track.df, track.ps].filter(Boolean).join(' ');
      if (track.ch) who.ch = track.ch;
      who.spawn = who.spawn === null ? track.first : Math.min(who.spawn, track.first);
      who.downs += track.downs;
      for (const i of gear && gear.carried && track.pid ? gear.carried[track.pid] || [] : []) if (!cantLoot(gear.names, i, track.sd)) who.gear += ((gear.names[i[0]] || {}).p || 0) * (i[1] || 1);
    }
    return [...people.values()].filter(p => p.name || p.kind);
  }
  // A line chart: series [{ name, col, v: [..] }] over times ts (ms), one axis. Pointing at it says each series'
  // number then; pressing it goes to that moment of the replay.
  const chartsToLay = [];
  function lineChart(box, title, ts, series, say) {
    const wrap = document.createElement('div');
    wrap.className = 'chart';
    const head = document.createElement('h4');
    head.textContent = title;
    wrap.appendChild(head);
    if (series.length > 1) {
      const legend = document.createElement('div');
      legend.className = 'chartLegend';
      for (const s of series) { const item = document.createElement('span'), dot = document.createElement('i'); dot.style.background = s.col; item.append(dot, s.name); legend.appendChild(item); }
      wrap.appendChild(legend);
    }
    const plot = document.createElement('div'), c = document.createElement('canvas'), tip = document.createElement('div');
    plot.className = 'chartPlot';
    tip.className = 'chartTip';
    tip.hidden = true;
    plot.append(c, tip);
    wrap.appendChild(plot);
    box.appendChild(wrap);
    // measured and drawn once every chart is in the page (see showStats): its width is known only then
    chartsToLay.push(() => {
    const total = replay.total, w = Math.max(240, plot.clientWidth), h = 150, pad = { l: 34, r: 10, t: 8, b: 20 }, ratio = window.devicePixelRatio || 1;
    c.width = Math.round(w * ratio);
    c.height = Math.round(h * ratio);
    c.style.width = w + 'px';
    c.style.height = h + 'px';
    let top = 1;
    for (const s of series) for (const v of s.v) if (v > top) top = v;
    const step = Math.pow(10, Math.floor(Math.log10(top))), nice = Math.ceil(top / step) * step;
    const X = t => pad.l + (w - pad.l - pad.r) * t / total, Y = v => h - pad.b - (h - pad.t - pad.b) * v / nice;
    const g = c.getContext('2d');
    const paint = at => {
      g.setTransform(ratio, 0, 0, ratio, 0, 0);
      g.clearRect(0, 0, w, h);
      g.font = '11px ' + FONT;
      g.fillStyle = '#8a8c9a';
      g.strokeStyle = 'rgba(200, 205, 255, 0.09)';
      g.lineWidth = 1;
      g.textBaseline = 'middle';
      g.textAlign = 'right';
      for (let k = 0; k <= 2; k++) {
        const v = nice * k / 2, y = Math.round(Y(v)) + 0.5;
        g.beginPath(); g.moveTo(pad.l, y); g.lineTo(w - pad.r, y); g.stroke();
        g.fillText(say ? say(v) : String(Math.round(v)), pad.l - 6, y);
      }
      g.textBaseline = 'top';
      for (let k = 0; k <= 4; k++) { g.textAlign = k === 0 ? 'left' : k === 4 ? 'right' : 'center'; g.fillText(clockText(total * k / 4), X(total * k / 4), h - pad.b + 5); }
      // where the replay is now
      g.strokeStyle = 'rgba(123, 156, 255, 0.55)';
      g.beginPath(); g.moveTo(X(replay.at), pad.t); g.lineTo(X(replay.at), h - pad.b); g.stroke();
      g.lineJoin = g.lineCap = 'round';
      g.lineWidth = 2;
      for (const s of series) {
        g.strokeStyle = s.col;
        g.beginPath();
        for (let i = 0; i < ts.length; i++) { if (i) g.lineTo(X(ts[i]), Y(s.v[i])); else g.moveTo(X(ts[i]), Y(s.v[i])); }
        g.stroke();
      }
      if (at >= 0) {
        g.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(X(ts[at]), pad.t); g.lineTo(X(ts[at]), h - pad.b); g.stroke();
        for (const s of series) {
          g.beginPath(); g.arc(X(ts[at]), Y(s.v[at]), 4, 0, Math.PI * 2);
          g.fillStyle = s.col; g.fill();
          g.lineWidth = 2; g.strokeStyle = '#14141c'; g.stroke();
        }
      }
    };
    const near = e => {
      const t = total * (e.clientX - c.getBoundingClientRect().left - pad.l) / (w - pad.l - pad.r);
      let best = 0;
      for (let i = 1; i < ts.length; i++) if (Math.abs(ts[i] - t) < Math.abs(ts[best] - t)) best = i;
      return best;
    };
    plot.onmousemove = e => {
      if (!ts.length) return;
      const at = near(e);
      paint(at);
      tip.textContent = '';
      const when = document.createElement('b');
      when.textContent = clockText(ts[at]);
      tip.appendChild(when);
      for (const s of series) {
        const row = document.createElement('span'), dot = document.createElement('i');
        dot.style.background = s.col;
        row.append(dot, (series.length > 1 ? s.name + ': ' : '') + (say ? say(s.v[at]) : s.v[at]));
        tip.appendChild(row);
      }
      tip.hidden = false;
      const x = X(ts[at]);
      tip.style.left = Math.min(w - 150, Math.max(0, x + (x > w / 2 ? -150 : 12))) + 'px';
    };
    plot.onmouseleave = () => { tip.hidden = true; paint(-1); };
    // (on the history page: that moment on the map, as a Timeline row or a kill on the bar goes there)
    plot.onclick = e => { if (!ts.length) return; if (HIST) { rvGo(ts[near(e)] + 2500, null, null); return; } seekReplay(ts[near(e)]); replayShown = ''; showReplay(); paint(near(e)); };
    paint(-1);
    });
  }
  $('replayTrails').onclick = () => { prefs.trails = prefs.trails === false; save(); replayShown = ''; showReplay(); dirty = true; };
  // a raid from somebody else: its zip, sent to the server (the raid history page's Import raid). What came of it is
  // said over the list, with a way into the raid.
  // hpImport: { busy, ok, had, id, bad }
  let hpImport = null;
  $('historyFile').onchange = async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    hpImport = { busy: true };
    hpPrint = '';
    hpShow();
    let answer = null;
    try { answer = await (await fetch('api/history/import', { method: 'POST', body: file })).json(); } catch (err) { /* said below */ }
    hpImport = answer && answer.ok ? { ok: true, had: !!answer.had, id: answer.id } : { bad: true };
    await loadHistory();
  };

  // ---- a raid looked into: the Raid window, the History window, and what they need ---------------------------
  // Everything Raid Review showed of a raid, in Satellite's own way: the raid's summary and leaderboard, its numbers
  // as charts, every event in a list, what each bot was doing as bars side by side, what ORBIT's squads were out to
  // do, the loot of the moment, and the upkeep of the recordings. All of it from the replay's own scan and events.
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; };
  const PEOPLE = ['Main Player', 'Friendly Player'];
  // the squads of a raid, numbered as they're first seen, each with a colour of its own
  const squadNos = new Map();
  const squadNo = g => { if (!g) return 0; let n = squadNos.get(g); if (!n) squadNos.set(g, n = squadNos.size + 1); return n; };
  const SQUAD_COLS = ['#4fc3f7', '#ffb74d', '#ba68c8', '#81c784', '#f06292', '#fff176', '#4db6ac', '#ff8a65', '#9fa8da', '#dce775'];
  const squadCol = n => SQUAD_COLS[(n - 1) % SQUAD_COLS.length];
  // who has been seen of each squad: one that came in alone is no team, and gets no number
  const squadSeen = new Map();
  // the team somebody came in with: a person's or PMC's group, else (a PMC bot, whose group the game leaves empty)
  // the band of bots it goes about with, keyed as the Raid window keys it
  // (kept for each once seen: a bot left the last of its band has none any more, and is still of that team)
  const teamOfId = new Map();
  // the mods' soldiers that go about in squads as PMCs do: numbered by their band too (Settings > Mod soldiers' teams)
  const MOD_TEAMS = ['ISB', 'ISB WT', 'Black Division', 'RUAF', 'RUAF Remnant', 'UNTAR', 'Mercenary'];
  const teamKey = m => {
    const pmc = m.c === 'Enemy Player' || m.c === 'Friendly Player' || (prefs.modTeams !== false && MOD_TEAMS.includes(m.c));
    const key = m.g || (m.bg && pmc ? 'b' + m.bg : '');
    if (key) { if (pmc) teamOfId.set(m.id, key); return key; }
    return pmc && teamOfId.get(m.id) || '';
  };
  const squadOf = m => { const key = teamKey(m); let set = squadSeen.get(key); if (!set) squadSeen.set(key, set = new Set()); set.add(m.id); return set.size > 1; };
  const forgetSquads = () => { squadNos.clear(); squadSeen.clear(); teamOfId.clear(); };

  // What a bot is doing, as one of a few sorts (the Behaviour tab's colours): from what it has decided ("dc": SAIN's
  // decision or the game's), else from the layer deciding for it and where a mod is sending it.
  const BEH = { combat: [T('Combat'), '#ef5350'], search: [T('Search'), '#f5a623'], movement: [T('Movement'), '#4f8ff7'], cover: [T('Cover'), '#26c6da'],
    patrol: [T('Patrol'), '#43c463'], orbit: [T('Orbiting'), '#9ccc65'], guard: [T('Guarding'), '#1f8f4e'], squadCover: [T('Waiting in cover'), '#ff8a3d'],
    ambush: [T('Ambush'), '#d9632b'], medical: [T('Medical'), '#ec5fa8'], loot: [T('Loot'), '#f7d046'], flee: [T('Flee'), '#b06cf0'],
    extract: [T('Extract'), '#2dd4bf'], grenade: [T('Grenade'), '#ff9d9d'], quest: [T('Quest'), '#f9c6e0'], idle: [T('Idle'), '#4a4f60'],
    // what COMET has a bot doing (its move, "cm"): sorts of their own, so its part shows apart from SAIN's
    cometPush: ['COMET · ' + T('Pushing'), '#e8577e'], cometHold: ['COMET · ' + T('Holding'), '#9575cd'], cometCrossfire: ['COMET · ' + T('Crossfire'), '#ce93d8'],
    cometCover: ['COMET · ' + T('Taking cover'), '#5c6bc0'], cometSearch: ['COMET · ' + T('Searching'), '#ffb38a'], cometPatch: ['COMET · ' + T('Reloading or healing'), '#d4e157'],
    cometAfter: ['COMET · ' + T('After the fight'), '#a1887f'],
    other: [T('Other'), '#858b9c'], pre: [T('Not spawned yet'), '#1d1f29'], dead: [T('Dead'), '#000000'], gone: [T('Extracted'), '#0f5f56'] };
  // COMET's move as one of its sorts ("CrossfireHolding": crossfire, "PostCombatWatch": after the fight)
  const COMET_SORT = { Push: 'cometPush', Storm: 'cometPush', Flank: 'cometPush', Hold: 'cometHold', KeepAngle: 'cometHold', Shoot: 'cometHold',
    Cover: 'cometCover', FallBack: 'cometCover', Search: 'cometSearch', Reload: 'cometPatch', FirstAid: 'cometPatch', Surgery: 'cometPatch', Stims: 'cometPatch' };
  const cometSort = cm => /^Crossfire/.test(cm) ? 'cometCrossfire' : /^PostCombat/.test(cm) ? 'cometAfter' : COMET_SORT[cm] || 'cometHold';
  const BEH_OF = {};
  for (const [key, names] of [
    ['combat', 'shootFromPlace shootFromCover shootToSmoke dogFight suppressFire suppressGrenade suppressStationary attackMoving attackMovingWithSuppress attackMovingFlank axeTarget oneMeleeAttack grenadeSuicide runToStationary shootFromStationary MoveToEngage StandAndShoot ShootDistantEnemy DogFight RushEnemy MeleeAttack FightZombies Freeze PushSuppressedEnemy Suppress Combat Squad'],
    ['search', 'search Search GroupSearch'],
    ['movement', 'goToPoint goToPointTactical holdPosition goToEnemy goToEnemyZigZag runToEnemy runToEnemyZigZag Help Regroup'],
    ['cover', 'goToCoverPoint goToCoverPointTactical runToCover runToCoverZigZag teleportToCover SeekCover ShiftCover Retreat'],
    ['patrol', 'simplePatrol followerPatrol alternativePatrol standBy peaceful peaceLook peaceHardAim Peace'],
    ['medical', 'heal healStimulators eatDrink healAnotherTarget FirstAid Surgery Stims'],
    ['loot', 'botTakeItem botDropItem deadBody goToLootPointNode LootPatrol'],
    ['flee', 'runAwayGrenade runAwayArtillery runAwayBTR flashed panicSitting turnAwayLight Run AvoidThreat'],
    ['extract', 'goToExfiltrationPointNode leaveMap Extract'],
    ['grenade', 'throwGrenadeFromPlace runAndThrowGrenadeFromPlace ThrowGrenade']]) for (const n of names.split(' ')) BEH_OF[n] = key;
  const BEH_EXITS = ['D-2', 'Bunker Hermetic Door', 'ZB-013', 'Saferoom extraction'];
  // a mod's objective ("ContainerLoot", "AmbushExtract (Moving)", "MultiStep: D-2 (1/3)") as a sort
  function goalSort(goal) {
    const op = /^MultiStep:\s+(.+?)\s+\(\d+\/\d+\)/.exec(goal);
    if (op && BEH_EXITS.includes(op[1])) return 'extract';
    if (/Ambush/.test(goal)) return 'ambush';
    if (/^(AirdropLoot|ContainerLoot|LooseLoot|Corpse)\b/.test(goal)) return 'loot';
    if (/^Quest\b/.test(goal)) return 'quest';
    if (/^Exfil\b/.test(goal)) return 'extract';
    if (/^Synthetic\b/.test(goal)) return 'orbit';
    if (/^Guarding\b/.test(goal)) return 'guard';
    if (/^SquadCover\b/.test(goal)) return 'squadCover';
    return 'movement';
  }
  const spaced = s => String(s).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
  // [sort, what it says]
  function behaviourOf(m) {
    const dc = m.dc || '', layer = m.ly || '';
    if (dc.startsWith('QB:')) return ['quest', dc.slice(3)];
    if (dc.startsWith('LootingBots:')) return ['loot', spaced(dc.slice(12))];
    if (dc.startsWith('BL:')) return ['movement', spaced(dc.slice(3))];
    if (dc.startsWith('Orbit:') || dc.startsWith('Phobos:')) { const goal = dc.slice(dc.indexOf(':') + 1); return [goalSort(goal), goal === 'Synthetic' ? '' : spaced(goal)]; }
    // COMET makes its moves through SAIN's layers (and two of its own): its move then is what the bot is doing, as the
    // map says it (see brainOf), over whatever SAIN has decided
    if (m.cm && (!layer || /^(SAIN|COMET)/i.test(layer))) return [cometSort(m.cm), 'COMET · ' + cometMove(m.cm)];
    const plain = dc.replace(/^SAIN:/, ''), idle = !dc || dc === 'peaceful' || dc === 'simplePatrol' || dc === 'standBy' || dc === 'SAIN:Peace' || /^\d+$/.test(dc);
    if (!idle) return [BEH_OF[plain] || 'other', (dc.startsWith('SAIN:') ? 'SAIN · ' : '') + spaced(plain)];
    // nothing of its own decided: by the layer, and where a mod is sending it
    if (layer !== 'LootPatrol' && /Loot/.test(layer)) return ['loot', spaced(layer)];
    if (/Follower|Regroup/.test(layer)) return ['movement', spaced(layer)];
    if (m.os === 'QuestingBots' && m.ob) return ['quest', m.ob];
    if (m.ob) return [goalSort(m.ob), (m.os || 'ORBIT') + ' · ' + m.ob];
    if (/^Orbit/i.test(layer)) return ['orbit', 'ORBIT'];
    if (dc) return [BEH_OF[plain] || 'patrol', spaced(plain)];
    // (a recording from before decisions were kept: the layer alone)
    if (/^COMET/i.test(layer) || m.cm) return [m.cm ? cometSort(m.cm) : /Post-combat/i.test(layer) ? 'cometAfter' : 'cometHold', 'COMET' + (m.cm ? ' · ' + cometMove(m.cm) : '')];
    if (/^SAIN/i.test(layer)) return [/Extract/.test(layer) ? 'extract' : /Avoid|Flashed/.test(layer) ? 'flee' : 'combat', layer];
    if (/Fight|HaveEnemy|Attack|Combat|Pursuit|Chase/i.test(layer)) return ['combat', spaced(layer)];
    if (/Heal/i.test(layer)) return ['medical', spaced(layer)];
    if (/Exfil|Leave/i.test(layer)) return ['extract', spaced(layer)];
    if (/Loot/i.test(layer)) return ['loot', spaced(layer)];
    if (/Ptrl|Patrol|^Pmc/i.test(layer)) return ['patrol', spaced(layer)];
    return [layer ? 'other' : 'idle', layer ? spaced(layer) : ''];
  }
  // Grenades going off, told by their fragments: many "shots" at once from one spot that isn't the gun of whoever
  // they're counted to. [{ who, x, y }]
  function blastsOf(rows, where) {
    if (!Array.isArray(rows) || rows.length < 6) return [];
    const from = new Map(), out = [];
    for (const r of rows) {
      if (!Array.isArray(r) || r.length < 5) continue;
      const key = r[0] + '|' + Math.round(r[1] / 2) + '|' + Math.round(r[2] / 2), g = from.get(key);
      if (g) g.n++; else from.set(key, { n: 1, who: r[0], x: r[1], y: r[2] });
    }
    for (const g of from.values()) {
      if (g.n < 6) continue;
      const at = g.who ? where(g.who) : null;
      if (at && Math.hypot(at[0] - g.x, at[1] - g.y) < 3) continue;
      out.push(g);
    }
    return out;
  }
  function sameBurst(a, b) {
    return Math.abs(a.t - b.t) <= 600 && (!a.pid || !b.pid || a.pid === b.pid)
      && Math.hypot(a.x - b.x, a.y - b.y) <= 2;
  }
  let blastMarks = [];
  const BLAST_MS = 2600;
  function drawBlasts(scale) {
    if (prefs.grenades === false) return;
    const now = replay ? replay.at : performance.now();
    if (!replay && blastMarks.length) blastMarks = blastMarks.filter(b => now - b.t < BLAST_MS);
    let marks = blastMarks;
    if (replay) {
      if (replay.scan?.done) marks = recentSignals(replay.scan.blasts, now, BLAST_MS);
      else {
        const known = recentSignals(replay.signals.blasts, now, BLAST_MS);
        blastMarks = blastMarks.filter(b => b.t <= now && now - b.t < BLAST_MS && !known.some(k => sameBurst(b, k)));
        marks = blastMarks.length ? known.concat(blastMarks) : known;
      }
    }
    if (!marks.length) return;
    ctx.save();
    for (const b of marks) {
      const k = (now - b.t) / BLAST_MS, s = toScreen(b.x, b.y), r = Math.max(12 * scale, 7 * zoom) * (0.35 + 0.65 * Math.min(1, k * 3));
      ctx.globalAlpha = 1 - k;
      if (Number.isFinite(b.fx)) {
        // thrown from here: an arc to where it went off
        const f = toScreen(b.fx, b.fy), mid = [(f[0] + s[0]) / 2, (f[1] + s[1]) / 2 - Math.hypot(s[0] - f[0], s[1] - f[1]) * 0.22];
        ctx.beginPath();
        ctx.moveTo(f[0], f[1]);
        ctx.quadraticCurveTo(mid[0], mid[1], s[0], s[1]);
        ctx.setLineDash([4 * scale, 5 * scale]);
        ctx.lineWidth = 1.8 * scale;
        ctx.strokeStyle = '#ffb74d';
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.beginPath();
      ctx.arc(s[0], s[1], r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 152, 0, 0.28)';
      ctx.fill();
      ctx.lineWidth = 2.4 * scale;
      ctx.strokeStyle = '#ffa726';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(s[0], s[1], 3.2 * scale, 0, Math.PI * 2);
      ctx.fillStyle = '#fff3e0';
      ctx.fill();
      if (b.name) {
        ctx.font = 'bold ' + Math.round(12 * scale) + 'px ' + FONT;
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.strokeStyle = '#23180b'; ctx.lineWidth = 3 * scale;
        ctx.strokeText(b.name, s[0], s[1] - r - 3 * scale);
        ctx.fillText(b.name, s[0], s[1] - r - 3 * scale);
      }
    }
    ctx.restore();
    dirty = true;
  }
  // Over the markers: a PMC's or a player's squad as a numbered disc in the squad's colour, and a ring round
  // somebody who is down and can be got up again.
  function drawBadges(scale) {
    const squads = prefs.squadMarks !== false;
    for (const m of live) if (m.dyn && teamKey(m) && m.c !== 'Corpse') squadOf(m);
    ctx.save();
    for (const m of live) {
      if (!m.dyn || m.c === 'Corpse' || isHidden(m.c) || inArea(m) || !Number.isFinite(m.cx)) continue;
      if (!m.dn && !(squads && teamKey(m) && squadOf(m))) continue;
      if (m.c !== 'Main Player' && offFloor(m.cx, m.cy, m.cz)) continue;
      const s = toScreen(m.cx, m.cy), r = 8 * scale * (KINDS[m.c] || OTHER).size;
      if (s[0] < -40 || s[1] < -40 || s[0] > vw + 40 || s[1] > vh + 40) continue;
      if (m.dn) {
        const beat = 0.5 + 0.5 * Math.sin(performance.now() / 220);
        ctx.beginPath();
        ctx.arc(s[0], s[1], r * (1.5 + 0.25 * beat), 0, Math.PI * 2);
        ctx.setLineDash([4 * scale, 3 * scale]);
        ctx.lineWidth = 2.2 * scale;
        ctx.strokeStyle = '#ff5252';
        ctx.stroke();
        ctx.setLineDash([]);
        dirty = true;
      }
      if (squads && teamKey(m) && squadOf(m)) {
        const n = squadNo(teamKey(m)), x = s[0] + r * 1.05, y = s[1] - r * 1.05, d = 5.6 * scale;
        ctx.beginPath();
        ctx.arc(x, y, d, 0, Math.PI * 2);
        ctx.fillStyle = squadCol(n);
        ctx.fill();
        ctx.lineWidth = 1.4 * scale;
        ctx.strokeStyle = '#000';
        ctx.stroke();
        ctx.font = '700 ' + Math.round(8.5 * scale) + 'px ' + FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#10121a';
        ctx.fillText(String(n), x, y + 0.5);
      }
    }
    ctx.restore();
  }
  // Over each bot, at a glance: a small badge by its marker for what it's doing this moment (pushing, falling back,
  // reloading, healing, throwing a grenade, getting to cover), as SAIN or COMET has it (Settings > Action icons); and
  // over it, a word for its part in its squad's COMET tactic while that's being carried out (Settings > Squad tactic
  // words). The badges are drawn once each, at the size wanted, and then only copied.
  const ACTION_OF_MOVE = { Push: 'push', Storm: 'push', Flank: 'push', FallBack: 'back', Reload: 'reload', PostCombatReload: 'reload',
    FirstAid: 'heal', PostCombatMedical: 'heal', Stims: 'heal', Cover: 'cover', PostCombatCover: 'cover' };
  const ACTION_OF_SAIN = { Reload: 'reload', FirstAid: 'heal', Surgery: 'heal', Stims: 'heal', ThrowGrenade: 'grenade', Retreat: 'back', RunAway: 'back',
    RushEnemy: 'push', MoveToEngage: 'push', SeekCover: 'cover', ShiftCover: 'cover' };
  const ACTION_RADIUS = 5.4;
  const ACTION_COL = { sight: '#baf4ff', voice: '#ffda8d', share: '#e1b8ff', push: '#e0483f', back: '#3d8bff', reload: '#e0a63a', heal: '#3fbf5f', grenade: '#ff8a1c', cover: '#7d8796' };
  function actionOf(m) {
    const sain = modOn('SAIN') && typeof m.dc === 'string' && m.dc.startsWith('SAIN:') ? ACTION_OF_SAIN[m.dc.slice(5)] : null;
    // (reloading, healing and a grenade say most, whatever the move is)
    if (sain === 'reload' || sain === 'heal' || sain === 'grenade') return sain;
    return (m.cm && ACTION_OF_MOVE[m.cm]) || sain || null;
  }
  const actionPics = new Map();
  function actionPic(kind, d) {
    const ratio = pixelRatio(), key = kind + '|' + Math.round(d * ratio);
    let pic = actionPics.get(key);
    if (pic) return pic;
    const size = Math.ceil((d * 2 + 4) * ratio), c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    g.scale(ratio, ratio);
    const o = d + 2;
    g.translate(o, o);
    g.beginPath();
    g.arc(0, 0, d, 0, Math.PI * 2);
    g.fillStyle = ACTION_COL[kind];
    g.fill();
    g.lineWidth = Math.max(1, d * 0.2);
    g.strokeStyle = '#000';
    g.stroke();
    const k = d * 0.55;
    g.strokeStyle = g.fillStyle = '#fff';
    g.lineWidth = Math.max(1.2, d * 0.24);
    g.lineCap = g.lineJoin = 'round';
    g.beginPath();
    if (kind === 'sight' || kind === 'voice') {
      g.fillStyle = kind === 'sight' ? '#0d3450' : '#533713';
      g.font = 'bold ' + d * 1.65 + 'px ' + FONT;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(kind === 'sight' ? '?' : '♪', 0, 0);
    } else if (kind === 'share') {
      g.strokeStyle = '#49235c';
      g.scale(d / 13, d / 13);
      g.translate(-12, -12);
      g.lineWidth = 2.6;
      for (const [path] of ICONS.special) g.stroke(new Path2D(path));
    } else if (kind === 'push' || kind === 'back') {
      // two chevrons: on (pointing up), or back (pointing down)
      const s = kind === 'push' ? 1 : -1;
      for (const y of [-0.35, 0.35]) { g.moveTo(-k * 0.8, (y + 0.45 * s) * k); g.lineTo(0, (y - 0.35 * s) * k); g.lineTo(k * 0.8, (y + 0.45 * s) * k); }
      g.stroke();
    } else if (kind === 'reload') {
      // a round arrow
      g.arc(0, 0, k * 0.75, -Math.PI * 0.35, Math.PI * 1.35);
      g.stroke();
      g.beginPath();
      const a = -Math.PI * 0.35, ex = Math.cos(a) * k * 0.75, ey = Math.sin(a) * k * 0.75;
      g.moveTo(ex - k * 0.5, ey - k * 0.15); g.lineTo(ex + k * 0.1, ey + k * 0.05); g.lineTo(ex - k * 0.05, ey + k * 0.6);
      g.stroke();
    } else if (kind === 'heal') {
      g.moveTo(0, -k * 0.85); g.lineTo(0, k * 0.85); g.moveTo(-k * 0.85, 0); g.lineTo(k * 0.85, 0);
      g.lineWidth = Math.max(1.5, d * 0.32);
      g.stroke();
    } else if (kind === 'grenade') {
      g.arc(0, k * 0.15, k * 0.6, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.moveTo(-k * 0.1, -k * 0.45); g.lineTo(k * 0.45, -k * 0.85);
      g.stroke();
    } else {
      // getting to cover: a shield
      g.moveTo(0, -k * 0.9); g.lineTo(k * 0.75, -k * 0.55); g.lineTo(k * 0.6, k * 0.35); g.lineTo(0, k * 0.95); g.lineTo(-k * 0.6, k * 0.35); g.lineTo(-k * 0.75, -k * 0.55);
      g.closePath();
      g.fill();
    }
    pic = { c, w: size / ratio, o };
    actionPics.set(key, pic);
    return pic;
  }
  function actionLegend() {
    const group = mk('details', 'actionLegend');
    group.appendChild(mk('summary', '', T('Action icon key')));
    const keys = mk('div');
    for (const [kind, word] of [['push', T('Pushing')], ['back', T('Falling back')], ['reload', T('Reloading')],
      ['heal', T('Healing')], ['grenade', T('Throwing a grenade')], ['cover', T('Taking cover')],
      ['sight', T('Spotted another bot')], ['voice', T('Voice call')], ['share', T('Contact shared')]]) {
      const item = mk('span'), icon = document.createElement('canvas'), pic = actionPic(kind, 8);
      icon.width = icon.height = pic.c.width;
      icon.getContext('2d').drawImage(pic.c, 0, 0);
      item.append(icon, word);
      keys.appendChild(item);
    }
    group.appendChild(keys);
    return group;
  }
  $('actionLegend').appendChild(actionLegend());
  // a bot's part in its squad's tactic, in a word or two
  function tacticWord(q) {
    if (q.f === 'S03') return q.r === 'support' ? T('Support') : q.r === 'rear' ? T('Rear') : T('Flank');
    if (q.f === 'S02') return T('Second way');
    if (q.f === 'S04') return T('Cover mate');
    if (q.f === 'S05') return squadPart(q);
    if (q.f === 'S06') return T('Squad assault');
    if (q.f === 'S10') return q.r === 'throw' ? T('Grenade') : T('Hold angle');
    if (q.f === 'S11') return T('Siege');
    if (q.f === 'S01') return T('Crossfire');
    return T('Squad tactic');
  }
  function drawDoing(scale) {
    if (prefs.actionIcons === false) return;
    const d = ACTION_RADIUS * scale;
    for (const m of live) {
      if (!m.dyn || m.c === 'Corpse' || m.gh || !Number.isFinite(m.cx) || isHidden(m.c) || inArea(m) || !hasDetails(m)) continue;
      if (HIST && prefs.hpNoPeople) return;
      if (m.c !== 'Main Player' && offFloor(m.cx, m.cy, m.cz)) continue;
      const kind = KINDS[m.c] || OTHER;
      if (kind.shape !== 'arrow') continue;
      const s = toScreen(m.cx, m.cy), r = 8 * scale * kind.size;
      if (s[0] < -40 || s[1] < -40 || s[0] > vw + 40 || s[1] > vh + 40) continue;
      const alpha = otherFloor(m.cx, m.cy, m.cz) !== 0 ? 0.55 : 1;
      const act = actionOf(m);
      if (act) {
        const pic = actionPic(act, d);
        ctx.globalAlpha = alpha;
        ctx.drawImage(pic.c, s[0] - r * 1.05 - pic.o, s[1] - r * 1.05 - pic.o, pic.w, pic.w);
        ctx.globalAlpha = 1;
      }
    }
  }
  // which letter an ORBIT squad's objective is drawn with: K kills, L loot, Q quest, E extract camp, A airdrop, and a
  // rush by where it's to: S spawns, B a boss, R a marked room, N a sniper's overwatch, C one of its own
  function orbitLetter(o) {
    if (o.AirdropStage) return 'A';
    const op = String(o.OperationName || ''), type = String(o.Type || '');
    if (type === 'Rush' || /Rush|Overwatch/i.test(op)) return /Spawn/i.test(op) ? 'S' : /Boss/i.test(op) ? 'B' : /Marked|Room/i.test(op) ? 'R' : /Sniper|Overwatch/i.test(op) ? 'N' : 'C';
    if (/Extract|Camp/i.test(type)) return 'E';
    return ORBIT_LETTER[type] || '•';
  }

  // ---- the minimap: the whole map small in a corner of a replay, where everybody is on it, where they have been
  // (the heat of the raid) and what the screen shows of it. Pressed or dragged, the map goes there.
  const mini = { el: null, base: null, basePrint: '', whole: false, heat: null, heatFor: null, at: 0, k: 1, ox: 0, oy: 0, v: null };
  function miniPlace(x, y) {
    const [a, b] = spin(x, y);
    return [mini.ox + mini.k * (a - mini.v.min.x), mini.oy + mini.k * (mini.v.max.y - b)];
  }
  function drawMini() {
    const on = !!replay && prefs.minimap !== false && !!map && !phone.matches;
    if (!mini.el) {
      if (!on) return;
      mini.el = mk('canvas');
      mini.el.id = 'miniMap';
      mini.el.title = T('The whole map: press or drag to go there.');
      document.body.appendChild(mini.el);
      const go = e => {
        if (!mini.v) return;
        const box = mini.el.getBoundingClientRect(), a = (e.clientX - box.left - mini.ox) / mini.k + mini.v.min.x, b = mini.v.max.y - (e.clientY - box.top - mini.oy) / mini.k;
        const [x, y] = unspin(a, b);
        chase(null);
        roam();
        centreOn(x, y);
      };
      mini.el.onpointerdown = e => { mini.el.setPointerCapture(e.pointerId); mini.held = true; go(e); };
      mini.el.onpointermove = e => { if (mini.held) go(e); };
      mini.el.onpointerup = mini.el.onpointercancel = () => { mini.held = false; };
    }
    if (mini.el.hidden === on) mini.el.hidden = !on;
    const now = performance.now();
    if (!on || now - mini.at < 200) return;
    mini.at = now;
    const W = 210, H = 160, ratio = pixelRatio(), v = view();
    if (mini.el.width !== Math.round(W * ratio)) { mini.el.width = Math.round(W * ratio); mini.el.height = Math.round(H * ratio); mini.el.style.width = W + 'px'; mini.el.style.height = H + 'px'; }
    mini.v = v;
    mini.k = Math.min((W - 8) / (v.max.x - v.min.x), (H - 8) / (v.max.y - v.min.y));
    mini.ox = (W - mini.k * (v.max.x - v.min.x)) / 2;
    mini.oy = (H - mini.k * (v.max.y - v.min.y)) / 2;
    // the map's picture, kept once every tile of it has come
    const print = map.loc + '|' + map.v + '|' + turn + '|' + ratio;
    if (mini.basePrint !== print || !mini.whole) {
      if (mini.basePrint !== print) { mini.base = mk('canvas'); mini.base.width = Math.round(W * ratio); mini.base.height = Math.round(H * ratio); mini.heatFor = null; }
      mini.basePrint = print;
      const g = mini.base.getContext('2d'), e1 = spin(1, 0), e2 = spin(0, 1), k = mini.k * ratio;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, mini.base.width, mini.base.height);
      g.setTransform(k * e1[0], -k * e1[1], k * e2[0], -k * e2[1], (mini.ox - mini.k * v.min.x) * ratio, (mini.oy + mini.k * v.max.y) * ratio);
      let whole = true;
      for (const t of tiles) {
        if (!t.img.complete || !t.img.naturalWidth) { whole = false; continue; }
        const x0 = map.min.x + t.col * map.tile, y0 = map.min.y + t.row * map.tile;
        try { g.drawImage(t.img, x0, y0 + map.tile, map.tile, -map.tile); } catch (e) { whole = false; }
      }
      mini.whole = whole;
    }
    // where everybody has been: the heat map's own picture, small (see heatPicture)
    const pic = heatPicture(W / Math.max(1, map.max.x - map.min.x));
    const g = mini.el.getContext('2d');
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#0c0c12';
    g.fillRect(0, 0, W, H);
    g.globalAlpha = pic ? 0.55 : 0.75;
    g.drawImage(mini.base, 0, 0, W, H);
    g.globalAlpha = 1;
    if (pic) layHeat(g, pic, miniPlace);
    for (const m of live) {
      if (!m.dyn || m.c === 'Corpse' || isHidden(m.c) || inArea(m) || !Number.isFinite(m.cx)) continue;
      const p = miniPlace(m.cx, m.cy), big = PEOPLE.includes(m.c);
      g.beginPath();
      g.arc(p[0], p[1], big ? 3.4 : 2.3, 0, Math.PI * 2);
      g.fillStyle = (KINDS[m.c] || OTHER).col;
      g.fill();
      g.lineWidth = 1;
      g.strokeStyle = '#000';
      g.stroke();
    }
    // What the screen shows: the rest dimmed, and its edge drawn, kept inside the minimap (zoomed far out, the
    // screen is bigger than the map: nothing's dimmed and the edge is the minimap's own)
    const corners = [toMap(0, 0), toMap(vw, 0), toMap(vw, vh), toMap(0, vh)].map(c => miniPlace(c[0], c[1]));
    g.save();
    g.beginPath();
    g.rect(0, 0, W, H);
    g.clip();
    g.beginPath();
    g.rect(0, 0, W, H);
    corners.forEach((c, i) => { if (i) g.lineTo(c[0], c[1]); else g.moveTo(c[0], c[1]); });
    g.closePath();
    g.fillStyle = 'rgba(8, 8, 14, 0.45)';
    g.fill('evenodd');
    g.beginPath();
    corners.forEach((c, i) => { if (i) g.lineTo(c[0], c[1]); else g.moveTo(c[0], c[1]); });
    g.closePath();
    g.lineWidth = 1.5;
    g.strokeStyle = 'rgba(123, 156, 255, 0.95)';
    g.stroke();
    g.restore();
  }

  // ---- the raid history page ------------------------------------------------------------------------------------
  // /satellite/raids/ is a page of its own (see HIST): the raids recorded, each looked into as Raid Review lays it out,
  // in Satellite's look. Every view has an address of its own, so it can be gone to straight away, kept or shared:
  //   raids/                 the raids recorded, the newest first (Recent raids)
  //   raids/<id>             one of them: its Overview
  //   raids/<id>/<tab>       its Stats, Timeline, Map (the raid played on the map), Behaviour or Settings
  // A raid opened is loaded once (startReplay) and stays loaded while its tabs are gone through. Its Map is the replay:
  // the Raid list down the left as its legend, what was going on at the moment shown down the right, and the timeline
  // under the map.
  const HP_TABS = [['overview', T('Overview')], ['stats', T('Stats')], ['timeline', T('Timeline')], ['map', T('Map')], ['behaviour', T('Behaviour')]];
  // (a raid's Settings tab is gone: Export and Delete are in its head. An address to it goes to the Overview.)
  const HP_ALL = HP_TABS.map(t => t[0]);
  // what the address says: the raid ('' for the list) and its tab ('list' for the list)
  const hp = { id: '', tab: 'list' };
  // hpPrint: the view last drawn (its scroll is kept while it's the same). hpFailed: the raid that couldn't be loaded.
  // rvWas: the replay was playing when its Map was left (it plays on when it's back)
  let hpPrint = '', hpFailed = '', hpSideAt = 0, rvWas = false, hpFrom = 'overview', hpMeasure = () => {};
  // how far down each view was scrolled, so going back to it (Close on the map) finds it as it was left
  const hpScroll = new Map();
  let rvSort = { key: 'kills', dir: -1 }, rvOpenRow = '', rvView = null, rvBehFocus = '', rvBehDrop = () => {};
  const rvFilter = { text: '', act: '' }, rvLoot = { min: 0, where: '', text: '', who: '' };
  const hpPage = mk('div', 'ui');
  hpPage.id = 'hp';
  hpPage.hidden = true;
  // A raid's head, one row the same on every tab (the Map's too, so a tab is where it was whichever is shown): back to
  // all the raids, which raid and how it went, its tabs, then on the right Export and Delete raid, or on the Map the
  // map's own tools in their place (the floors, Selected floor only, Positions | Heat map, Close map), so the map has
  // all the room under the one row. It's there, the same size, from the moment a raid is asked for, so nothing moves
  // once it's loaded.
  hpPage.innerHTML = '<div id="hpHead"><div id="hpTop"><a id="hpBack" class="btn ghost"></a><div id="hpTitleBox"><div id="hpTitle"></div><div id="hpSub"></div></div>'
    + '<nav id="hpTabs"></nav><span class="grow"></span>'
    + '<span id="hpMapBar"><span id="hpFloorHome"></span>'
    + '<label id="hpFloorOnly"><input type="checkbox" id="hpFloorOnlyBox"><span></span></label><span class="seg" id="hpView"></span>'
    + '<button id="hpLegendBtn" type="button"></button><button id="hpPanels" type="button"></button><a id="hpClose" class="btn close"></a></span>'
    + '<a id="hpExport" class="btn" download></a><button id="hpDelete" class="danger" type="button"></button></div></div>'
    + '<div id="hpBody"></div>';
  document.body.appendChild(hpPage);
  // beside the map, on the right: what was going on at the moment shown (see hpSideShow)
  const hpSide = mk('aside', 'ui');
  hpSide.id = 'hpSide';
  hpSide.hidden = true;
  document.body.appendChild(hpSide);
  // the map's legend, over the Raid list down the left (see showKey)
  const hpLegend = mk('details');
  hpLegend.id = 'hpLegend';
  hpLegend.open = prefs.hpOpen && prefs.hpOpen.legend === true;
  hpLegend.ontoggle = () => { prefs.hpOpen = Object.assign({}, prefs.hpOpen, { legend: hpLegend.open }); save(); };
  hpLegend.append(mk('summary', '', T('What the marks mean')), mk('div', '', ''));
  hpLegend.lastChild.id = 'hpLegendBody';
  const hpUrl = (id, tab) => 'raids/' + (id ? encodeURIComponent(id) + (tab && tab !== 'overview' && tab !== 'list' ? '/' + tab : '') : '');
  // a link to a view: gone to on the page itself, or in another tab as any link (Ctrl, the middle button)
  function hpLink(a, id, tab) {
    a.href = hpUrl(id, tab);
    a.onclick = e => { if (e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; e.preventDefault(); hpGo(id, tab); };
    return a;
  }
  function hpGo(id, tab, replace) {
    const url = new URL(hpUrl(id, tab), document.baseURI).href;
    if (url !== location.href) history[replace ? 'replaceState' : 'pushState'](null, '', url);
    hpRoute();
  }
  const hpAbout = id => replay && replay.about.id === id ? replay.about : (historyRaids || []).find(r => r.id === id) || null;
  // the view the address asks for: the raid it names loaded first, if it isn't
  async function hpRoute() {
    const rest = location.pathname.slice(ROOT.length).replace(/^raids\/?/, '').split('/').filter(Boolean).map(p => { try { return decodeURIComponent(p); } catch (e) { return ''; } });
    const id = /^[\w-]{1,80}$/.test(rest[0] || '') ? rest[0] : '';
    const tab = !id ? 'list' : HP_ALL.includes(rest[1]) ? rest[1] : 'overview';
    if (id && rest[1] && !HP_ALL.includes(rest[1])) { history.replaceState(null, '', new URL(hpUrl(id, tab), document.baseURI).href); }
    const was = hp.tab;
    // the tab the map was opened from: its Close goes back there
    if (tab === 'map' && was !== 'map') hpFrom = was !== 'list' && hp.id === id ? was : 'overview';
    // leaving the Map: the replay waits, and plays on when it's back
    if (was === 'map' && tab !== 'map' && replay) { rvWas = replay.playing; replay.playing = false; }
    if (was !== 'map' && tab === 'map' && replay && replay.about.id === id && rvWas) replay.playing = true;
    hp.id = id;
    hp.tab = tab;
    if (!id && (was !== 'list' || !historyRaids)) loadHistory();
    if (id && (!replay || replay.about.id !== id)) {
      if (!historyRaids) await loadHistory();
      if (hp.id !== id) return;
      const about = hpAbout(id);
      if (!about) { hpFailed = id; hpShow(); return; }
      rvWas = false;
      // (another raid asked for while this one loaded: that one, now this one's out of the way)
      if (historyBusy) { hpShow(); return; }
      await startReplay(about);
      if (hp.id !== id) { hpRoute(); return; }
    }
    hpShow();
  }
  window.addEventListener('popstate', () => { if (HIST) hpRoute(); });
  const hpToMap = () => { if (HIST && hp.tab !== 'map' && hp.id) hpGo(hp.id, 'map'); };
  for (const [key, name] of HP_TABS) {
    const a = hpLink(mk('a', 'tab', name), '', key);
    a.dataset.tab = key;
    $('hpTabs').appendChild(a);
  }
  $('hpBack').textContent = '‹ ' + T('All raids');
  $('hpBack').title = T('Back to every raid recorded');
  hpLink($('hpBack'), '', 'list');
  $('hpDelete').textContent = T('Delete raid');
  $('hpDelete').title = T('Delete the recording of this raid (press twice)');
  // pressed once it asks to be pressed again; a few seconds on, it's as it was
  $('hpDelete').onclick = async () => {
    const b = $('hpDelete'), id = hp.id;
    if (!b.classList.contains('sure')) {
      b.classList.add('sure');
      b.textContent = T('Press again to be sure');
      setTimeout(() => { b.classList.remove('sure'); b.textContent = T('Delete raid'); }, 3500);
      return;
    }
    b.classList.remove('sure');
    b.textContent = T('Delete raid');
    try { await fetch('api/history/delete?id=' + encodeURIComponent(id), { method: 'POST' }); } catch (e) { /* listed again all the same */ }
    leaveReplay();
    hpGo('', 'list', true);
  };
  $('hpExport').textContent = T('Export raid');
  $('hpExport').title = T('Export this raid as a zip, to share.');
  $('hpClose').textContent = '✕ ' + T('Close map');
  $('hpClose').title = T('Back to the raid (Escape)');
  $('hpFloorOnly').title = T('Only who and what is on the floor shown (Map > Selected floor only)');
  $('hpFloorOnly').querySelector('span').textContent = T('Selected floor only');
  $('hpFloorOnly').querySelector('span').dataset.short = T('This floor only');
  $('hpFloorOnlyBox').onchange = e => { prefs.floorOnly = e.target.checked; save(); squadPanePrint = ''; dirty = true; };
  for (const [v, text, title] of [['pos', T('Positions'), T('Everybody where they were at the moment shown')], ['heat', T('Heat map'), T('Where everybody was over the whole raid: hotter the longer. For the kinds of people switched on under Raid.')]]) {
    const b = mk('button', '', text);
    b.type = 'button';
    b.dataset.v = v;
    b.title = title;
    b.onclick = () => { prefs.heat = v === 'heat'; save(); replayShown = ''; showReplay(); dirty = true; };
    $('hpView').appendChild(b);
  }
  // (on a phone the panel beside the map is folded away, and comes up over the map from here)
  // (and the Raid list with the map's key, from Legend: one of the two at a time)
  $('hpPanels').textContent = T('Details');
  $('hpPanels').onclick = () => { document.body.classList.remove('hpLegend'); document.body.classList.toggle('hpPanes'); hpShow(); };
  $('hpLegendBtn').textContent = T('Legend');
  $('hpLegendBtn').onclick = () => { document.body.classList.remove('hpPanes'); document.body.classList.toggle('hpLegend'); keyPrint = ''; rosterPrint = null; hpShow(); };
  if (HIST) {
    $('hpFloorHome').appendChild($('floorBadge'));
    // one row at the top of the history page, not two: Satellite's own bar is folded into it (see placeQuick)
    $('hpTop').prepend($('brand'), $('modeNav'));
    $('hpMapBar').prepend($('fit'), $('full'));
    $('hpTop').appendChild($('langBox'));
    // the menu, as the live map's: here the panel beside the map, on its Settings (pressed again, put away)
    const hpMenu = mk('button', '', '☰ ' + T('Menu'));
    hpMenu.id = 'hpMenu';
    hpMenu.type = 'button';
    hpMenu.onclick = () => {
      const shown = phone.matches ? document.body.classList.contains('hpPanes') : !prefs.hpSideOff;
      const close = shown && prefs.hpTab === 'settings';
      prefs.hpTab = 'settings';
      if (phone.matches) { document.body.classList.remove('hpLegend'); document.body.classList.toggle('hpPanes', !close); } else prefs.hpSideOff = close;
      save();
      hpShow();
      hpSideShow();
    };
    $('hpTop').appendChild(hpMenu);
    document.documentElement.classList.add('oneBar');
    $('sideHead').querySelector('b').textContent = T('Legend');
    hpLink($('histRaids'), '', 'list');
    // whose work the raid history stands on, wherever Satellite's own name is
    $('credit').textContent = 'Satellite · © Fums · Raid Review © Chazut & Ekky';
    $('credit').title = T('Satellite by Fums. The raid history is built on Raid Review, by Chazut and Ekky.');
    // (the name in the bar and that line: the credits, on the page of every raid)
    $('brand').onclick = $('credit').onclick = () => { hpGo('', 'list'); requestAnimationFrame(() => { const c = $('hpCredits'); if (c) c.scrollIntoView({ block: 'center', behavior: 'smooth' }); }); };
    // what's laid over the map keeps clear of the head and the map's bar over it (--hp-under), and the kill feed of the
    // timeline under it (--bar-over), however tall either is: measured whenever one changes size
    const measureHp = () => {
      const st = document.body.style, head = hpPage.hidden ? 0 : hpPage.getBoundingClientRect().bottom;
      const bar = $('replayBar'), over = bar.hidden ? 0 : window.innerHeight - bar.getBoundingClientRect().top;
      st.setProperty('--hp-under', Math.round(head) + 'px');
      st.setProperty('--bar-over', Math.round(over) + 'px');
      const toolbar = $('hpMapBar');
      st.setProperty('--action-under', Math.ceil(Math.max(head, toolbar.getBoundingClientRect().bottom)) + 'px');
    };
    if (window.ResizeObserver) { const watchSize = new ResizeObserver(measureHp); watchSize.observe(hpPage); watchSize.observe($('hpMapBar')); watchSize.observe($('replayBar')); }
    window.addEventListener('resize', measureHp);
    hpMeasure = measureHp;
    // Behaviour: a sort picked out goes back to all of them on a press anywhere but the sorts and the bars
    document.addEventListener('pointerdown', e => {
      if (hp.tab !== 'behaviour' || !rvBehFocus || !(e.target instanceof Element) || e.target.closest('.behShare, .behPlot')) return;
      rvBehDrop();
    });
    // Escape on the map: back to the raid
    window.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || hp.tab !== 'map' || !hp.id || /^(INPUT|SELECT|TEXTAREA)$/.test((document.activeElement || {}).tagName || '')) return;
      hpGo(hp.id, hpFrom || 'overview');
    });
  }

  // what's shown: the view the address asks for
  function hpShow() {
    if (!HIST) return;
    const r = replay && replay.about.id === hp.id ? replay : null, onMap = hp.tab === 'map' && !!r;
    // (how far down the view shown was, kept for coming back to it: see hpScroll)
    if (!$('hpBody').hidden && hpPrint) hpScroll.set(hpPrint, $('hpBody').scrollTop);
    hpPage.hidden = false;
    document.body.classList.toggle('hpMap', onMap);
    // (on the raids page the row has only Satellite's logo, the switch and the language: there's no raid)
    $('hpHead').hidden = false;
    $('hpHead').classList.toggle('noRaid', !hp.id);
    $('hpMapBar').hidden = !onMap;
    $('hpBody').hidden = onMap;
    $('replayBar').hidden = !onMap;
    hpSide.hidden = !onMap || (!!prefs.hpSideOff && !phone.matches);
    hpSideTab.hidden = !onMap || !prefs.hpSideOff || phone.matches;
    if ($('hpMenu')) {
      $('hpMenu').hidden = !onMap;
      $('hpMenu').classList.toggle('on', onMap && prefs.hpTab === 'settings' && (phone.matches ? document.body.classList.contains('hpPanes') : !prefs.hpSideOff));
    }
    if (!onMap) document.body.classList.remove('hpPanes', 'hpLegend');
    $('hpPanels').classList.toggle('on', document.body.classList.contains('hpPanes'));
    $('hpLegendBtn').classList.toggle('on', document.body.classList.contains('hpLegend'));
    const a = hp.id ? hpAbout(hp.id) : null;
    const when = a ? new Date(a.began).toLocaleString(document.documentElement.lang || undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
    document.title = (a ? placeName(a.loc) + ' · ' + when : T('Raid history')) + ' · Satellite';
    if (hp.id && !a) {
      // (not known yet: the head as it'll be, so it doesn't grow once the raid's loaded)
      $('hpTitle').textContent = hpFailed === hp.id ? T('Raid not found') : T('Loading the raid…');
      $('hpSub').textContent = ' ';
      for (const b of $('hpTabs').children) { hpLink(b, hp.id, b.dataset.tab); b.classList.toggle('on', b.dataset.tab === hp.tab); }
      $('hpExport').hidden = $('hpDelete').hidden = true;
    }
    if (hp.id && a) {
      // which raid (the map, big) and how it went: the outcome as a tag, then when, how long and whose
      $('hpTitle').textContent = placeName(a.loc);
      const sub = $('hpSub'), out = outcomeOf(a);
      sub.textContent = '';
      const tag = mk('span', 'outTag ' + out.cls, out.text);
      if (out.tip) tag.title = out.tip;
      sub.append(tag, mk('span', '', [when, clockText(a.ms - (a.lead || 0)), a.name ? latin(a.name) + (sideOf(a) ? ' · ' + sideOf(a) : '') : ''].filter(Boolean).join('  ·  ')));
      $('hpTitleBox').title = placeName(a.loc) + '\n' + [when, clockText(a.ms - (a.lead || 0)), a.name ? latin(a.name) + (sideOf(a) ? ' · ' + sideOf(a) : '') : ''].filter(Boolean).join('  ·  ')
        + (out.tip ? '\n' + out.tip : '');
      for (const b of $('hpTabs').children) { hpLink(b, hp.id, b.dataset.tab); b.classList.toggle('on', b.dataset.tab === hp.tab); }
      hpLink($('hpClose'), hp.id, hpFrom || 'overview');
      // the zip named by when, the map and PMC or Scav: "Satellite-raid-20261126-155854-Customs-PMC.zip"
      const stamp = (/^\d{8}-\d{6}/.exec(hp.id) || [hp.id])[0], kind = a.side === 'Savage' ? 'Scav' : a.side ? 'PMC' : '';
      $('hpExport').href = 'api/history/export?id=' + encodeURIComponent(hp.id) + '&name=' + encodeURIComponent([stamp, placeName(a.loc), kind].filter(Boolean).join(' '));
      // (a raid still being recorded can't be exported or deleted yet)
      $('hpExport').hidden = $('hpDelete').hidden = !!a.live || onMap;
    }
    // the Raid list down the left, as the map's legend (on a phone, over the map from Legend)
    const listed = onMap && (!phone.matches || document.body.classList.contains('hpLegend'));
    if ($('side').hidden === listed) toggleSide(listed, false);
    if (onMap) {
      $('hpFloorOnlyBox').checked = !!prefs.floorOnly;
      measureCover();
      hpMeasure();
      replayShown = '';
      showReplay();
      hpSideShow();
      dirty = true;
      return;
    }
    const box = $('hpBody'), print = hp.id + '|' + hp.tab, keep = hpScroll.get(print) || 0;
    hpPrint = print;
    box.textContent = '';
    const wrap = mk('div', 'hpWrap');
    box.appendChild(wrap);
    if (!hp.id) hpList(wrap);
    else if (hpFailed === hp.id && !r) {
      wrap.appendChild(mk('p', 'winNote', hpAbout(hp.id) ? T('That raid couldn\'t be loaded.') : T('There\'s no raid recorded at this address: it may have been deleted.')));
      wrap.appendChild(hpLink(mk('a', 'btn', '‹ ' + T('Recent raids')), '', 'list'));
    } else if (!r) wrap.appendChild(mk('p', 'winNote', T('Loading the raid…')));
    else {
      const s = scanReplay(r);
      if (!s.done) wrap.appendChild(mk('p', 'winNote', T('Working it out…')));
      else ({ overview: rvOverview, stats: rvStats, timeline: rvTimeline, behaviour: rvBehaviour })[hp.tab](wrap, r, s);
    }
    for (const lay of chartsToLay.splice(0)) lay();
    box.scrollTop = keep;
  }
  // the raids page, after the list of raids came again
  function showWins() { if (HIST && hp.tab === 'list') hpShow(); }
  // what used to open the Raid window: the raid's view on the page (the whole raid looked into)
  function rvShow() { if (HIST && hp.tab !== 'map') hpShow(); }

  // to a moment of the raid on the map: a little before it, playing, at the place or following the one it's about
  function rvGo(t, at, id) {
    if (!replay) return;
    seekReplay(Math.max(0, t - 2500));
    replay.playing = true;
    rvWas = true;
    hpToMap();
    const m = id !== null && id !== undefined ? liveById.get(id) : null;
    if (m) watch(m); else if (Array.isArray(at)) goTo(at[0], at[1]);
    replayShown = '';
    showReplay();
  }

  // ---- Recent raids: every raid kept, as a table (as Raid Review's), with what's to be done with them all ----
  const sideOf = a => a.side === 'Savage' ? T('Scav') : a.side === 'Usec' ? T('PMC (USEC)') : a.side === 'Bear' ? T('PMC (BEAR)') : '';
  // How a raid went, as said everywhere: { text, cls (good, bad, live, cut), tip }. A raid whose end never came
  // (the game closed or crashed first) says so, rather than nothing.
  const outcomeOf = a => a.live ? { text: T('Recording now'), cls: 'live' }
    : a.exit ? { text: spaced(EXITS[a.exit] || a.exit) + (a.exitName && a.exit === 'Survived' ? ' · ' + exitShown(a) : ''), cls: a.exit === 'Survived' ? 'good' : a.exit === 'Killed' ? 'bad' : '' }
    : a.died ? { text: T('Killed in action'), cls: 'bad' }
    : { text: T('Ended abruptly'), cls: 'cut', tip: T('The end of this raid wasn\'t recorded: the game was closed or crashed before the raid was over.') };
  // the raids played: not the map scanner's runs ("Map scan" is how they end), which aren't listed or counted
  const isScan = r => r.exitName === 'Map scan';
  // a raid's extract by the name the game shows ("Courtyard", not "E8_yard"; the server says it), and an end event's
  // extract the same way when it's that raid's
  function exitShown(a) { return a.exitTitle || a.exitName || ''; }
  function exitSaid(ex, a) { return ex && a && ex === a.exitName && a.exitTitle ? a.exitTitle : ex; }
  function hpList(box) {
    const listed = historyRaids ? historyRaids.filter(r => !isScan(r)) : null;
    const tools = mk('div', 'winTools hpTools');
    tools.appendChild(mk('b', 'hpCount', listed ? TP(listed.length, '{n} raid recorded', '{n} raids recorded') : ''));
    tools.appendChild(mk('span', 'grow'));
    const again = mk('button', '', T('Refresh'));
    again.type = 'button';
    again.title = T('Look for new raids');
    again.onclick = () => { rrRaids = null; loadHistory(); };
    const add = mk('button', '', hpImport && hpImport.busy ? T('Importing…') : T('Import raid'));
    add.type = 'button';
    add.disabled = !!(hpImport && hpImport.busy);
    add.title = T('Add a raid exported from another Satellite, or from Raid Review (a zip).');
    add.onclick = () => $('historyFile').click();
    // what's to be done with all of them (delete them all, tidy up, Raid Review's own raids): put away until wanted
    const manage = mk('button', hpManage ? 'on' : '', T('Manage recordings'));
    manage.type = 'button';
    manage.onclick = () => { hpManage = !hpManage; hpPrint = ''; hpShow(); };
    tools.append(again, add, manage);
    box.appendChild(tools);
    if (hpManage) { const panel = mk('div', 'hpManage'); upkeep(panel); box.appendChild(panel); }
    // Raid Review beside Satellite: each raid is recorded twice. Said, with what to do (Satellite leaves other mods
    // as they are, so it doesn't turn Raid Review's recording off itself).
    if (historyInfo && historyInfo.rr) {
      const twice = mk('p', 'winNote', T('Raid Review is installed too, so every raid is recorded twice. Import its raids (Manage recordings > Raids from Raid Review), then remove Raid Review.') + ' ');
      if (!hpManage) {
        const open = mk('button', 'linkBtn', T('Manage recordings'));
        open.type = 'button';
        open.onclick = () => { hpManage = true; hpPrint = ''; hpShow(); };
        twice.appendChild(open);
      }
      box.appendChild(twice);
    }
    // recording stopped (the live map's REC button, or here): said, with a way to start it again
    if (historyOn && recState.paused) {
      const said = mk('p', 'winNote bad', T('Recording is stopped: no raid is recorded until it\'s started again.') + ' ');
      const start = mk('button', 'linkBtn', T('Start recording'));
      start.type = 'button';
      start.onclick = () => askRec(false);
      said.appendChild(start);
      box.appendChild(said);
    }
    // what came of an import
    if (hpImport && hpImport.busy) box.appendChild(mk('p', 'winNote', T('Uploading and checking the raid. A long recording may take a moment.')));
    else if (hpImport && hpImport.bad) box.appendChild(mk('p', 'winNote bad', T('That file isn\'t a raid exported by Satellite or Raid Review.')));
    else if (hpImport && hpImport.ok) {
      const said = mk('p', 'winNote', (hpImport.had ? T('This raid is here already.') : T('Raid imported.')) + ' ');
      if (hpImport.id) said.appendChild(hpLink(mk('a', 'linkBtn', T('Open raid')), hpImport.id, 'overview'));
      box.appendChild(said);
    }
    if (!historyRaids) { box.appendChild(mk('p', 'winNote', T('Loading…'))); return; }
    if (!listed.length) box.appendChild(mk('p', 'winNote', historyOn ? T('No raids recorded yet. Play one: it shows here once it has begun.') : T('Raids aren\'t recorded: history.record is off in the server\'s config.jsonc.')));
    else {
      hpRecords(box);
      rvSection(box, T('Every raid'));
      const table = mk('table', 'board raids'), head = table.createTHead().insertRow();
      for (const label of [T('Player'), T('Type'), T('Map'), T('Status'), T('Time in raid'), T('Date and time'), T('Kills'), T('Action')]) head.appendChild(mk('th', '', label));
      const body = table.createTBody();
      for (const r of listed) {
        const row = body.insertRow();
        row.className = 'pick';
        row.title = T('Look into this raid');
        const who = row.insertCell();
        who.textContent = (r.name ? latin(r.name) : '—');
        if (r.hl) who.appendChild(mk('small', '', T('headless')));
        if (r.rr || r.imported) who.appendChild(mk('small', '', r.rr ? T('Imported from Raid Review') : T('imported')));
        if (historyInfo.held && historyInfo.held.has(r.id)) { const tag = mk('small', 'recHeld', '★ ' + T('Record')); tag.title = T('Holds one of the records: kept, whatever the limits, until it\'s beaten'); who.appendChild(tag); }
        row.insertCell().textContent = sideOf(r) || '—';
        row.insertCell().textContent = placeName(r.loc);
        const out = row.insertCell(), said = outcomeOf(r);
        out.appendChild(mk('span', 'outTag ' + said.cls, said.text));
        if (said.tip) out.title = said.tip;
        row.insertCell().textContent = clockText(r.ms - (r.lead || 0));
        row.insertCell().textContent = new Date(r.began).toLocaleString(document.documentElement.lang || undefined, { dateStyle: 'medium', timeStyle: 'short' });
        // (the raid's kills, and how many of them the player whose game recorded it made)
        row.insertCell().textContent = (r.kills || 0) + (r.mine ? ' (' + T('{n} by {who}', { n: r.mine, who: r.name ? latin(r.name) : T('the player') }) + ')' : '');
        const acts = row.insertCell();
        acts.className = 'acts';
        acts.append(hpLink(mk('a', 'btn', T('View')), r.id, 'overview'), hpLink(mk('a', 'btn', T('Map')), r.id, 'map'));
        for (const link of acts.children) link.addEventListener('click', e => e.stopPropagation());
        row.onclick = e => { if (e.ctrlKey || e.metaKey) window.open(hpUrl(r.id, 'overview')); else hpGo(r.id, 'overview'); };
      }
      const roll = mk('div', 'tableRoll');
      roll.appendChild(table);
      box.appendChild(roll);
      box.appendChild(mk('p', 'winNote hpShowing', TP(listed.length, 'Showing {n} raid', 'Showing {n} raids')));
    }
    hpCredits(box);
  }
  let hpManage = false;
  // The records of every raid kept: how many, how long, and the best and worst of them, each a way into its raid.
  // (A raid recorded before these were counted is counted by the server once, in the background: see "counting".)
  // Each game that has Satellite records its own raids, as its own player: in a Fika raid every friend's game and the
  // headless record it too. The records are everybody's together to begin with (All), with a leaderboard of the
  // players, or one player's, picked in the tabs over them. A headless's raids aren't anybody's.
  const whoseRaid = r => r.sid || r.name || '';
  // what a raid got out with: what the player had on them as they extracted (newer recordings), else what they picked
  // up in it; nothing for a raid they didn't get out of (or the map scanner's runs)
  // What a raid got the player, extracted: what they got out with less what they went in with ("gain", the server
  // works it out). A raid from before that was kept: what was picked up ("out" was all they had on them, kit and all).
  const gotOut = r => r.exit === 'Survived' && r.exitName !== 'Map scan' ? (Number.isFinite(r.gain) ? r.gain : r.loot || 0) : 0;
  function hpRecords(box) {
    // (the map scanner's runs aren't raids anybody played: left out of the records)
    const all = historyRaids.filter(r => !r.live && !r.hl && !isScan(r)), players = new Map();
    for (const r of all) { const k = whoseRaid(r); if (!players.has(k)) players.set(k, { name: r.name ? latin(r.name) : T('Unknown'), raids: [] }); players.get(k).raids.push(r); }
    const order = [...players].sort((x, y) => y[1].raids.length - x[1].raids.length);
    const who = players.has(prefs.hpRecWho) ? prefs.hpRecWho : '';
    const raids = who ? players.get(who).raids : all, counted = raids.filter(r => r.st);
    const named = r => !who && players.size > 1 && r.name ? latin(r.name) + ' · ' : '';
    rvSection(box, T('Records'));
    // whose: tabs, All first, then each player with how many raids their game recorded
    if (order.length) {
      const tabs = mk('div', 'recTabs');
      for (const [k, label, n] of [['', T('All players'), all.length]].concat(order.map(([k, p]) => [k, p.name, p.raids.length]))) {
        const b = mk('button', k === who ? 'on' : '');
        b.type = 'button';
        b.append(mk('span', '', label), mk('small', '', String(n)));
        b.title = k ? T('{who}\'s records: the raids their game recorded', { who: label }) : T('Every player\'s raids together, and how each did');
        b.onclick = () => { prefs.hpRecWho = k; save(); hpShow(); };
        tabs.appendChild(b);
      }
      box.appendChild(tabs);
    }
    const tiles = mk('div', 'statTiles recTiles');
    const tile = (value, label, tip) => { const t = mk('div'); t.append(mk('b', '', value), mk('span', '', label)); if (tip) t.title = tip; tiles.appendChild(t); };
    const played = raids.reduce((n, r) => n + Math.max(0, r.ms - (r.lead || 0)), 0), ended = raids.filter(r => r.exit || r.died);
    const survived = ended.filter(r => r.exit === 'Survived').length;
    tile(String(raids.length), T('Raids'));
    tile(Math.floor(played / 3600000) + 'h ' + Math.floor(played % 3600000 / 60000) + 'm', T('Time in raid'));
    tile(ended.length ? Math.round(100 * survived / ended.length) + '%' : '—', T('Survived'), TP(ended.length, 'Of the {n} raid whose end was recorded', 'Of the {n} raids whose end was recorded'));
    tile(String(raids.reduce((n, r) => n + (r.mine || 0), 0)), T('Kills'));
    tile(counted.length ? shortWorth(counted.reduce((n, r) => n + (r.loot || 0), 0)) + ' ₽' : '—', T('Looted'));
    box.appendChild(tiles);
    // with more than one player: how each did, as a little leaderboard (pressed: that player's records; the player
    // picked lit). There on every tab, so picking one moves nothing under it.
    if (order.length > 1) {
      const table = mk('table', 'board recBoard'), head = table.createTHead().insertRow();
      for (const [label, num] of [[T('Player'), 0], [T('Raids'), 1], [T('Time in raid'), 1], [T('Survived'), 1], [T('Kills'), 1], [T('Looted'), 1], [T('Most got out with'), 1]]) head.appendChild(mk('th', num ? 'num' : '', label));
      const body = table.createTBody();
      const rows = order.map(([k, p]) => {
        const list = p.raids, ended = list.filter(r => r.exit || r.died), alive = ended.filter(r => r.exit === 'Survived').length;
        return { k, name: p.name, n: list.length, time: list.reduce((n, r) => n + Math.max(0, r.ms - (r.lead || 0)), 0), surv: ended.length ? alive / ended.length : -1,
          kills: list.reduce((n, r) => n + (r.mine || 0), 0), loot: list.reduce((n, r) => n + (r.loot || 0), 0), out: Math.max(0, ...list.map(gotOut)) };
      }).sort((x, y) => y.kills - x.kills || y.loot - x.loot);
      rows.forEach((x, i) => {
        const row = body.insertRow();
        row.className = 'pick' + (x.k === who ? ' on' : '');
        row.title = x.k === who ? T('Back to every player') : T('{who}\'s records', { who: x.name });
        row.onclick = () => { prefs.hpRecWho = x.k === who ? '' : x.k; save(); hpShow(); };
        const name = row.insertCell();
        name.append(mk('b', 'recRank', String(i + 1)), x.name);
        for (const [v, cls] of [[String(x.n)], [Math.floor(x.time / 3600000) + 'h ' + Math.floor(x.time % 3600000 / 60000) + 'm'], [x.surv < 0 ? '—' : Math.round(100 * x.surv) + '%'],
          [String(x.kills)], [x.loot ? shortWorth(x.loot) + ' ₽' : '—'], [x.out ? shortWorth(x.out) + ' ₽' : '—']]) { const c = row.insertCell(); c.className = 'num' + (cls ? ' ' + cls : ''); c.textContent = v; }
      });
      const roll = mk('div', 'tableRoll');
      roll.appendChild(table);
      box.appendChild(roll);
    }
    // the best of them: a card each, pressed to open that raid
    const cards = mk('div', 'recCards');
    const best = (list, of) => list.reduce((top, r) => !top || of(r) > of(top) ? r : top, null);
    const card = (title, r, value, said) => {
      const c = mk('a', 'recCard');
      c.append(mk('span', 'recTitle', title), mk('b', '', value), mk('small', '', said || ''));
      if (r) hpLink(c, r.id, 'overview'); else c.classList.add('none');
      cards.appendChild(c);
    };
    const when = r => new Date(r.began).toLocaleDateString(document.documentElement.lang || undefined, { day: 'numeric', month: 'short' });
    const where = r => named(r) + placeName(r.loc) + ' · ' + when(r);
    // the map played most (its own versions and seasons counted as it)
    const maps = new Map();
    for (const r of raids) { const base = placeName(String(r.loc).replace(/[@].*$/, '')); maps.set(base, (maps.get(base) || 0) + 1); }
    const top = [...maps].sort((x, y) => y[1] - x[1])[0];
    card(T('Most played map'), null, top ? top[0] : '—', top ? TP(top[1], '{n} raid', '{n} raids') : '');
    cards.lastChild.classList.remove('none');
    // the most got out of a raid with: what they had on them as they extracted (picked up, for older recordings)
    const rich = best(raids.filter(r => gotOut(r) > 0), gotOut);
    card(T('Most loot extracted'), rich, rich ? roubles(gotOut(rich)) : '—', rich ? where(rich) + (Number.isFinite(rich.gain) ? (Number.isFinite(rich.out) ? ' · ' + T('{n} with your kit', { n: shortWorth(rich.out) + ' ₽' }) : '') : ' · ' + T('picked up')) : T('No extract recorded yet'));
    const item = best(counted.filter(r => r.best && r.best.v > 0), r => r.best.v);
    card(T('Best loot'), item, item ? item.best.i : '—', item ? roubles(item.best.v) + ' · ' + where(item) : '');
    const killer = best(raids.filter(r => r.mine > 0), r => r.mine);
    card(T('Most kills'), killer, killer ? String(killer.mine) : '—', killer ? where(killer) : T('No kills yet'));
    const crowd = best(counted.filter(r => r.bots > 0), r => r.bots);
    card(T('Most bots'), crowd, crowd ? String(crowd.bots) : '—', crowd ? where(crowd) : '');
    const hurt = best(counted.filter(r => r.hurt > 0), r => r.hurt);
    card(T('Most damage taken'), hurt, hurt ? T('{n} HP', { n: hurt.hurt }) : '—', hurt ? where(hurt) : T('No damage taken yet'));
    // (the longest of the raids they got out of alive)
    // ("Map scan": the map scanner's own runs, not an extract)
    const long = best(raids.filter(r => r.exit === 'Survived' && r.exitName !== 'Map scan'), r => r.ms - (r.lead || 0));
    card(T('Longest raid extracted'), long, long ? clockText(long.ms - (long.lead || 0)) : '—', long ? where(long) + (long.exitName ? ' · ' + exitShown(long) : '') : T('No extract recorded yet'));
    box.appendChild(cards);
    if (historyInfo.counting) box.appendChild(mk('p', 'winNote', TP(historyInfo.counting, 'Counting {n} older raid for the records…', 'Counting {n} older raids for the records…')));
  }
  // what sort of team came in together, from who was in it: the player's own, a PMC squad (and its side), a boss and
  // its guards, the Goons, or a group of one kind (Scavs, Rogues, Raiders, RUAF...)
  function teamKind(members) {
    const kinds = new Set(members.map(p => p.kind)), boss = members.find(p => p.kind === 'Boss');
    if (members.some(p => p.kind === 'Main Player')) return T('Your team');
    // (a squad can be USEC and BEAR together: not said which)
    if ([...kinds].every(k => k === 'Enemy Player' || k === 'Friendly Player')) return T('PMC squad');
    if (boss && [...kinds].every(k => k === 'Boss' || k === 'Guard')) return members.length > 1 ? T('{boss} and guards', { boss: boss.name || ONE.Boss }) : boss.name || ONE.Boss;
    if (kinds.size === 1 && kinds.has('Goon')) return T('The Goons');
    if (kinds.size === 1) { const k = [...kinds][0]; return T('{kind} group', { kind: ONE[k] || k }); }
    return [...kinds].map(k => ONE[k] || k).join(' + ');
  }
  const sideName = p => p.sd === 'Usec' ? T('PMC (USEC)') : p.sd === 'Bear' ? T('PMC (BEAR)') : p.sd === 'Savage' ? T('Scav') : ONE[p.kind] || p.kind || '';
  const statusOf = p => p.died ? T('KIA') : p.left ? (p.left.x === 0 ? T('Left') : T('Extracted')) : p.end ? spaced(EXITS[p.end.st] || p.end.st) : T('Alive');
  const killSaid = d => d.gas ? T('Gas explosion') : [d.w || '', Number.isFinite(d.m) ? d.m + ' m' : '', PARTS[d.bp] || ''].filter(Boolean).join(', ');
  function rvSection(box, title) { const h = mk('h3', 'winSub', title); box.appendChild(h); return h; }

  // a card on the Overview: a title and what's in it
  function rvCard(box, title, cls) {
    const card = mk('section', 'ovCard' + (cls ? ' ' + cls : ''));
    if (title) card.appendChild(mk('h3', '', title));
    box.appendChild(card);
    return card;
  }
  function rvOverview(box, r, s) {
    const a = r.about, people = raidPeople(r), end = r.events.find(e => e.k === 'end'), kills = r.events.filter(e => e.k === 'kill');
    const persons = people.filter(p => PEOPLE.includes(p.kind)).length, bots = people.filter(p => p.id !== null && !PEOPLE.includes(p.kind)).length;
    const me = people.find(p => p.kind === 'Main Player') || null, out = outcomeOf(a);
    // the raid at a glance
    const tiles = mk('div', 'statTiles ovTiles');
    const tile = (value, label, cls, tip) => { const t = mk('div', cls || ''); t.append(mk('b', '', value), mk('span', '', label)); if (tip) t.title = tip; tiles.appendChild(t); return t; };
    // (how it went, big; the extract on the line under it, so the tile is as tall as the others whatever its name)
    const how = a.exit ? spaced(EXITS[a.exit] || a.exit) : out.text, via = a.exit === 'Survived' && a.exitName ? exitShown(a) : '';
    tile(how, via ? T('Outcome') + ' · ' + via : T('Outcome'), 'out ' + out.cls, [out.text, out.tip].filter(Boolean).join('\n'));
    tile(clockText(r.total), T('Time in raid'));
    // (whose game recorded it: theirs, by name, as in a Fika raid it may be a friend's)
    const whose = a.name ? latin(a.name) : T('Player');
    tile(me ? String(me.kills) : '—', T('Kills by {who}', { who: whose }));
    tile(String(kills.length), T('Kills in the raid'));
    tile(me && me.worth ? shortWorth(me.worth) + ' ₽' : me ? String(me.items) : '—', me && me.worth ? T('Looted by {who}', { who: whose }) : T('Items {who} picked up', { who: whose }));
    // (the hits and shots said on the tile itself, not only when pointed at)
    tile(me && s.hitsKnown && me.shots ? Math.round(100 * me.hits / me.shots) + '%' : '—', T('Accuracy of {who}', { who: whose }) + (me && s.hitsKnown && me.shots ? ' · ' + me.hits + '/' + me.shots : ''), '',
      me && me.shots ? T('{hits} of {shots} shots hit somebody', { hits: me.hits, shots: me.shots }) : '');
    tile(String(bots), T('Bots seen'));
    tile(String(s.peak || 0), T('Most bots at once'));
    box.appendChild(tiles);
    const cards = mk('div', 'ovCols');
    box.appendChild(cards);
    // the raid's facts
    const facts = rvCard(cards, T('The raid')), table = mk('table', 'facts');
    for (const [label, value] of [[T('Map'), placeName(a.loc)], [T('Extract'), exitShown(a) || (end && exitSaid(end.d.ex, a)) || (out.cls === 'cut' ? T('None (the raid didn\'t end)') : '—')],
      [T('Players'), persons], [T('Bots'), bots], [T('Mods seen'), (s.mods || []).concat((s.has || []).filter(k => k !== 'RUAF Remnant' && k !== 'ISB WT')).join(', ') || '—'],
      [T('Recorded by'), (a.name ? latin(a.name) : '—') + (a.hl ? ' (' + T('headless') + ')' : '')],
      [T('Source'), a.rr ? T('Imported from Raid Review') : a.imported ? T('Imported from another Satellite') : T('Recorded by Satellite')]]) {
      const row = table.insertRow();
      row.insertCell().textContent = label;
      row.insertCell().textContent = value;
    }
    facts.appendChild(table);
    const watchBtn = mk('a', 'btn ovMap', '▶ ' + T('Watch it on the map'));
    hpLink(watchBtn, a.id, 'map');
    facts.appendChild(watchBtn);
    // every kill, in order: the player's own lit; each a way to that fight on the map
    const feed = rvCard(cards, T('Kills') + ' · ' + kills.length, 'ovFeed');
    if (!kills.length) feed.appendChild(mk('p', 'hpNone', T('Nobody was killed in this raid.')));
    for (const e of kills) {
      const d = e.d, line = mk('button', 'ovKill' + (PEOPLE.includes(d.kk) ? ' mine' : '') + (PEOPLE.includes(d.vk) ? ' died' : ''));
      line.type = 'button';
      const name = (text, kind) => { const n = mk('b', '', text); n.style.color = (KINDS[kind] || OTHER).col; return n; };
      line.append(mk('span', 'ovT', clockText(e.rt)));
      const who = mk('span', 'ovWho');
      if (d.kn) who.append(name(latin(d.kn), d.kk), mk('i', '', ' ' + T('killed') + ' '));
      who.appendChild(name(e.nm ? latin(e.nm) : ONE[d.vk] || d.vk || '', d.vk));
      if (!d.kn) who.appendChild(mk('i', '', ' ' + T('died')));
      line.append(who, mk('small', '', killSaid(d)));
      line.title = T('Watch this fight on the map');
      line.onclick = () => viewKill(e);
      feed.appendChild(line);
    }
    // the player's own raid: what they did, and the best of what they picked up
    if (me) {
      const mine = rvCard(cards, T('{who}\'s raid', { who: whose }), 'ovMine');
      const said = mk('div', 'ovLines');
      const line = (label, value) => { const l = mk('div'); l.append(mk('span', '', label), mk('b', '', value)); said.appendChild(l); };
      line(T('Kills'), String(me.kills) + (me.far ? ' · ' + T('longest {m} m', { m: me.far }) : ''));
      line(T('Shots'), me.shots ? (s.hitsKnown ? T('{hits} of {shots} hit', { hits: me.hits, shots: me.shots }) : String(me.shots)) : '—');
      line(T('Picked up'), me.items ? TP(me.items, '{n} item', '{n} items') + (me.worth ? ' · ' + roubles(me.worth) : '') : '—');
      line(T('How it ended'), out.text);
      mine.appendChild(said);
      const best = r.events.filter(e => e.k === 'loot' && (e.p === me.key || (e.nm && latin(e.nm) === me.name))).map(e => ({ e, v: lootWorth(e.d) })).filter(x => Number.isFinite(x.v))
        .sort((x, y) => y.v - x.v).slice(0, 6);
      if (best.length) {
        mine.appendChild(mk('h4', '', T('Best loot')));
        for (const { e, v } of best) {
          const row = mk('div', 'ovLoot');
          row.append(mk('span', '', (e.d.i || '') + (e.d.q > 1 ? ' ×' + e.d.q : '')), mk('b', '', roubles(v)));
          row.lastChild.style.color = worthCol(v);
          mine.appendChild(row);
        }
      }
    }
    // who came in together (people, and bots that came as a group)
    const teams = new Map();
    for (const p of people) if (p.team) { if (!teams.has(p.team)) teams.set(p.team, []); teams.get(p.team).push(p); }
    if (teams.size) {
      rvSection(box, T('Teams'));
      const wrap = mk('div', 'teams');
      for (const [n, members] of [...teams].sort((x, y) => x[0] - y[0])) {
        const team = mk('div', 'team'), badge = mk('i', '', String(n));
        badge.style.background = squadCol(n);
        team.append(badge, mk('span', 'teamKind', teamKind(members)));
        for (const p of members) {
          const b = mk('button', 'linkBtn', p.name || ONE[p.kind] || p.kind);
          b.type = 'button';
          b.style.color = (KINDS[p.kind] || OTHER).col;
          // (from when they came into the raid: its start, for one there from the start)
          b.title = T('Follow on the map, from when they came in');
          b.onclick = () => rvGo((p.spawn || 0) + 2500, null, p.id);
          team.appendChild(b);
        }
        wrap.appendChild(team);
      }
      box.appendChild(wrap);
    }
    rvSection(box, T('Leaderboard'));
    // [key, heading, numbers (sorted biggest first), what it means]; Team only when anybody came in with others
    const anyTeam = people.some(p => p.team);
    const cols = [['name', T('Name'), 0, ''], ['side', T('Side'), 0, T('PMC (USEC or BEAR), Scav, or what sort of bot')], ['team', T('Team'), 1, T('Who came into the raid together: the same number, the same team')],
      ['lv', T('Level'), 1, ''], ['status', T('Status'), 0, T('Alive at the end, killed in action (KIA), or left the raid')],
      ['df', T('Difficulty'), 0, T('How hard the bot was set to be (SAIN or the game)')], ['ps', T('Personality'), 0, T('How SAIN has the bot behave')],
      ['kills', T('Kills'), 1, ''], ['items', T('Looted'), 1, T('Items picked up')], ['worth', T('Looted value'), 1, T('What the items picked up are worth')],
      ['gear', T('Gear value'), 1, T('What they came into the raid wearing and carrying')], ['acc', T('Accuracy'), 1, T('Of the shots they fired, how many hit somebody')],
      ['far', T('Longest kill'), 1, ''], ['spawn', T('Came in'), 1, T('When they came into the raid')]].filter(c => c[0] !== 'team' || anyTeam);
    const value = (p, key) => key === 'side' ? sideName(p) : key === 'status' ? statusOf(p) : key === 'acc' ? (s.hitsKnown && p.shots ? p.hits / p.shots : p.shots ? p.shots / 1e6 : -1) : key === 'spawn' ? (p.spawn === null ? 1e12 : p.spawn) : p[key];
    const sorted = people.slice().sort((x, y) => {
      const u = value(x, rvSort.key), w = value(y, rvSort.key);
      return (typeof u === 'number' && typeof w === 'number' ? u - w : String(u || '').localeCompare(String(w || ''))) * rvSort.dir || y.kills - x.kills || y.worth - x.worth;
    });
    const board = mk('table', 'board sortable leader'), head = board.createTHead().insertRow();
    for (const [key, label, numeric, tip] of cols) {
      const th = mk('th', (rvSort.key === key ? 'sorted' : '') + (key === 'team' ? ' mid' : numeric ? ' num' : ''), label + (rvSort.key === key ? (rvSort.dir < 0 ? ' ▾' : ' ▴') : ''));
      th.title = (tip ? tip + '. ' : '') + T('Press to sort by it');
      th.onclick = () => { rvSort = { key, dir: rvSort.key === key ? -rvSort.dir : numeric ? -1 : 1 }; rvShow(); };
      head.appendChild(th);
    }
    const body = board.createTBody();
    for (const p of sorted) {
      const key = p.key, row = body.insertRow();
      row.className = 'pick' + (rvOpenRow === key ? ' open' : '');
      const name = row.insertCell(), dot = mk('i');
      dot.style.background = (KINDS[p.kind] || OTHER).col;
      name.append(dot, p.name || ONE[p.kind] || p.kind);
      // one of PBT's cheaters: said, with what PBT made of it (personality, cheats) when pointed at
      if (p.ch) { const badge = mk('span', 'cheatTag', T('PBT cheater')); badge.title = cheatSaid(p.ch === '-' ? '' : p.ch) || T('One of PBT\'s cheaters'); name.appendChild(badge); }
      if (p.died) name.appendChild(mk('small', '', p.died.by ? T('by {who}', { who: p.died.by }) + (killSaid(p.died) ? ' (' + killSaid(p.died) + ')' : '') : p.died.gas ? T('Gas explosion') : T('died')));
      row.insertCell().textContent = sideName(p);
      if (anyTeam) {
        const team = row.insertCell();
        if (p.team) { const b = mk('i', 'squadDot', String(p.team)); b.style.background = squadCol(p.team); b.title = T('Team {n}', { n: p.team }); team.appendChild(b); }
      }
      row.insertCell().textContent = levelShown(p.lv, p.kind) ? p.lv : '';
      const status = row.insertCell();
      status.textContent = statusOf(p) + (p.downs ? ' · ' + TP(p.downs, 'downed {n} time', 'downed {n} times') : '');
      status.className = p.died ? 'bad' : p.left || (p.end && p.end.st === 'Survived') ? 'good' : '';
      row.insertCell().textContent = DIFFICULTY[p.df] || p.df || '';
      row.insertCell().textContent = p.ps || '';
      row.insertCell().textContent = p.kills || '';
      row.insertCell().textContent = p.items || '';
      row.insertCell().textContent = p.worth ? shortWorth(p.worth) + ' ₽' : '';
      row.insertCell().textContent = p.gear ? shortWorth(p.gear) + ' ₽' : '';
      // how many of their shots hit: the share as a bar and a number, the count beside it
      const acc = row.insertCell();
      if (s.hitsKnown && p.shots) {
        const share = p.hits / p.shots, bar = mk('div', 'accBar'), fill = mk('i');
        fill.style.width = Math.max(2, Math.round(100 * share)) + '%';
        fill.style.background = share >= 0.4 ? '#43c463' : share >= 0.2 ? '#f5a623' : '#ef5350';
        bar.appendChild(fill);
        acc.append(bar, mk('b', 'accPct', Math.round(100 * share) + '%'), mk('small', 'dim', p.hits + '/' + p.shots));
        acc.title = T('{hits} of {shots} shots hit somebody', { hits: p.hits, shots: p.shots });
      } else acc.textContent = p.shots ? TP(p.shots, '{n} shot', '{n} shots') : '';
      row.insertCell().textContent = p.far ? p.far + ' m' : '';
      row.insertCell().textContent = p.spawn === null ? '' : clockText(p.spawn);
      // (each cell lined up as its column's heading: numbers to the right, the team's dot in the middle)
      cols.forEach((c, i) => { const cell = row.cells[i]; if (cell && c[0] === 'team') cell.className = 'mid'; else if (cell && c[2]) cell.classList.add('num'); });
      row.onclick = () => { rvOpenRow = rvOpenRow === key ? '' : key; rvShow(); };
      if (rvOpenRow !== key) continue;
      // pressed: their kills, how they went, and a way to them on the map
      const more = body.insertRow(), cell = more.insertCell();
      more.className = 'detail';
      cell.colSpan = cols.length;
      const follow = mk('button', 'linkBtn follow', '▶ ' + T('Follow on the map'));
      follow.type = 'button';
      follow.onclick = e => { e.stopPropagation(); rvGo(Math.max(p.spawn || 0, 0) + 2500, null, p.id); };
      if (p.id !== null) cell.appendChild(follow);
      if (!p.killList.length && !p.died) cell.appendChild(mk('div', 'dim noKills', T('No kills.')));
      for (const e of p.killList) {
        const b = mk('button', 'linkBtn killLine', clockText(e.rt) + '  ' + T('killed') + ' ' + (e.nm ? latin(e.nm) : ONE[e.d.vk] || e.d.vk || '') + (killSaid(e.d) ? ' · ' + killSaid(e.d) : ''));
        b.type = 'button';
        b.onclick = ev => { ev.stopPropagation(); viewKill(e); };
        cell.appendChild(b);
      }
      if (p.died) {
        const b = mk('button', 'linkBtn killLine bad', clockText(p.died.t) + '  ' + (p.died.by ? T('killed by {who}', { who: p.died.by }) : T('died')) + (killSaid(p.died) ? ' · ' + killSaid(p.died) : ''));
        b.type = 'button';
        b.onclick = ev => { ev.stopPropagation(); if (p.died.e) viewKill(p.died.e); else rvGo(p.died.t, p.died.at, null); };
        cell.appendChild(b);
      }
    }
    // (wide: scrolls sideways in its own box on a narrow screen, not the page)
    const roll = mk('div', 'tableRoll');
    roll.appendChild(board);
    box.appendChild(roll);
    box.appendChild(mk('p', 'winNote', T('Press a column to sort by it, a row for that one\'s kills.')));
    hpCredits(box);
  }
  // Whose work the raid history stands on: on the raids page and under every raid's Overview
  function hpCredits(box) {
    const card = mk('div', 'hpCredits');
    card.id = 'hpCredits';
    const text = mk('div');
    text.append(mk('b', '', T('Built on Raid Review')),
      mk('span', '', T('Satellite\'s raid history is built on Raid Review, by Chazut and Ekky. Thank you both.')));
    const link = mk('a', '', 'github.com/Chazut/SPT-RaidReview');
    link.href = 'https://github.com/Chazut/SPT-RaidReview';
    link.target = '_blank';
    link.rel = 'noopener';
    text.appendChild(link);
    card.append(mk('i', '', '♥'), text);
    box.appendChild(card);
  }

  // a ring of shares: [[name, n, colour]], the biggest first, with what each is beside it
  function donut(box, title, parts) {
    const wrap = mk('div', 'chart donut');
    wrap.appendChild(mk('h4', '', title));
    const total = parts.reduce((n, p) => n + p[1], 0);
    if (!total) { wrap.appendChild(mk('p', 'winNote', T('Nothing to show.'))); box.appendChild(wrap); return; }
    const row = mk('div', 'donutRow'), c = mk('canvas'), ratio = window.devicePixelRatio || 1, size = 132, legend = mk('div', 'donutLegend');
    c.width = c.height = Math.round(size * ratio);
    c.style.width = c.style.height = size + 'px';
    const g = c.getContext('2d');
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    let from = -Math.PI / 2;
    const gap = parts.length > 1 ? 0.035 : 0;
    for (const [name, n, col] of parts) {
      const sweep = Math.PI * 2 * n / total;
      g.beginPath();
      g.arc(size / 2, size / 2, size / 2 - 12, from + gap / 2, from + Math.max(gap / 2 + 0.01, sweep - gap / 2));
      g.lineWidth = 20;
      g.strokeStyle = col;
      g.stroke();
      from += sweep;
      const item = mk('div'), dot = mk('i');
      dot.style.background = col;
      item.append(dot, mk('span', '', name), mk('b', '', n + ' · ' + Math.round(100 * n / total) + '%'));
      legend.appendChild(item);
    }
    g.font = '700 22px ' + FONT;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#f2f2f5';
    g.fillText(String(total), size / 2, size / 2 + 1);
    row.append(c, legend);
    wrap.appendChild(row);
    box.appendChild(wrap);
  }
  const SHARE_COLS = ['#4f8ff7', '#f5a623', '#43c463', '#ec5fa8', '#26c6da', '#b06cf0', '#f7d046', '#ff8a65'];
  // the most of them by name, the rest as one
  function shares(counts, colOf) {
    const sorted = [...counts].sort((x, y) => y[1] - x[1]), top = sorted.slice(0, 7), rest = sorted.slice(7).reduce((n, p) => n + p[1], 0);
    const parts = top.map(([name, n], i) => [name, n, colOf ? colOf(name, i) : SHARE_COLS[i % SHARE_COLS.length]]);
    if (rest) parts.push([T('Other'), rest, '#858b9c']);
    return parts;
  }
  function barsOf(box, title, rows, say) {
    const most = Math.max(1, ...rows.map(x => x[1])), bars = mk('div', 'bars');
    bars.appendChild(mk('h4', '', title));
    for (const [name, n, col] of rows) {
      const row = mk('div'), track = mk('div'), bar = mk('i');
      bar.style.width = (100 * n / most) + '%';
      bar.style.background = col;
      track.appendChild(bar);
      row.append(mk('span', '', name), track, mk('b', '', say ? say(n) : String(n)));
      bars.appendChild(row);
    }
    box.appendChild(bars);
  }
  function rvStats(box, r, s) {
    const people = raidPeople(r), kills = r.events.filter(e => e.k === 'kill'), loot = r.events.filter(e => e.k === 'loot');
    const tiles = mk('div', 'statTiles');
    for (const [label, value] of [[T('Length'), clockText(r.total)], [T('Kills'), kills.length], [T('People seen'), s.tracks.size], [T('Most bots at once'), s.peak || 0],
      [T('Items picked up'), loot.reduce((n, e) => n + (e.d.q || 1), 0)], [T('Shots fired'), [...s.tracks.values()].reduce((n, t) => n + t.shots, 0)]]) {
      const tile = mk('div');
      tile.append(mk('b', '', value), mk('span', '', label));
      tiles.appendChild(tile);
    }
    box.appendChild(tiles);
    const bots = [...s.tracks.values()].filter(t => !PEOPLE.includes(t.c));
    const count = (list, of) => { const m = new Map(); for (const x of list) { const k = of(x); if (k) m.set(k, (m.get(k) || 0) + 1); } return m; };
    const rings = mk('div', 'charts');
    box.appendChild(rings);
    donut(rings, T('Bots by faction'), shares(count(bots, t => (KINDS[t.c] || {}).name || t.c), null).map(p => { const kind = Object.keys(KINDS).find(k => KINDS[k].name === p[0]); return [p[0], p[1], kind ? KINDS[kind].col : p[2]]; }));
    donut(rings, T('PMC personalities'), shares(count(bots.filter(t => t.c === 'Enemy Player'), t => t.ps), null));
    const DIFF_COL = { easy: '#43c463', normal: '#4f8ff7', hard: '#f5a623', impossible: '#ef5350' };
    donut(rings, T('Bots by difficulty'), ['easy', 'normal', 'hard', 'impossible'].map(d => [DIFFICULTY[d], bots.filter(t => t.df === d).length, DIFF_COL[d]]).filter(p => p[1]));
    const looters = people.filter(p => p.items).sort((x, y) => y.worth - x.worth || y.items - x.items).slice(0, 12);
    const priced = looters.some(p => p.worth);
    if (looters.length) barsOf(box, T('Looting by player'), looters.map(p => [p.name || ONE[p.kind] || p.kind, priced ? p.worth : p.items, (KINDS[p.kind] || OTHER).col]), priced ? v => shortWorth(v) + ' ₽' : null);
    const killers = people.filter(p => p.kills).sort((x, y) => y.kills - x.kills).slice(0, 12);
    if (killers.length) barsOf(box, T('Kills by player'), killers.map(p => [p.name || ONE[p.kind] || p.kind, p.kills, (KINDS[p.kind] || OTHER).col]));
    const seen = count([...s.tracks.values()], t => t.c);
    barsOf(box, T('Who was in the raid'), [...seen].sort((x, y) => y[1] - x[1]).map(([kind, n]) => [(KINDS[kind] || {}).name || kind, n, (KINDS[kind] || OTHER).col]));
    const charts = mk('div', 'charts');
    box.appendChild(charts);
    const stride = Math.max(1, Math.ceil(s.ts.length / 600)), pick = list => list.filter((v, i) => i % stride === 0), ts = pick(s.ts);
    lineChart(charts, T('Active bots over time'), ts, [{ name: T('Bots'), col: '#4f8ff7', v: pick(s.botsAlive) }]);
    const sides = GROUPS.map((g, i) => ({ name: KINDS[g[0]].name, col: KINDS[g[0]].col, v: pick(s.alive[i]) })).filter(side => side.v.some(v => v > 0));
    lineChart(charts, T('Alive over time'), ts, sides);
    const sum = (events, worth) => { let i = 0, n = 0; return ts.map(t => { while (i < events.length && events[i].rt <= t) n += worth(events[i++]); return n; }); };
    lineChart(charts, T('Kills over time'), ts, [{ name: T('Kills'), col: '#ff5148', v: sum(kills, () => 1) }]);
    const worthy = loot.some(e => Number.isFinite(lootWorth(e.d)));
    lineChart(charts, T('Loot picked up over time'), ts, [{ name: T('Picked up'), col: '#7fd36b', v: sum(loot, e => worthy ? lootWorth(e.d) || 0 : e.d.q || 1) }], worthy ? shortWorth : null);
    // the player's health (a share of whole), and their energy and water where the recording has them (newer plugins)
    if (s.myKnown) {
      const mine = [{ name: T('Health %'), col: '#4cd964', v: pick(s.myHp) }];
      if (s.myUpkeep) mine.push({ name: T('Energy'), col: '#f5a623', v: pick(s.myE) }, { name: T('Water'), col: '#4f8ff7', v: pick(s.myW) });
      lineChart(charts, s.myUpkeep ? T('Your health, energy and water') : T('Your health'), ts, mine);
    }
    box.appendChild(mk('p', 'winNote', T('Press a chart to go to that moment.')));
  }

  // every event of the raid as a row: [{ t, who, kind, act, text, at, id }]
  function raidRows(r) {
    const s = r.scan, rows = [], idOf = pid => { for (const [id, t] of s.tracks) if (t.pid === pid) return id; return null; };
    // how each switch last stood: a row only when that changes (each is told as it stands when the raid begins, by an
    // older plugin twice, and room lights then too)
    const switchStood = new Map();
    for (const e of r.events) {
      const d = e.d, name = e.nm ? latin(e.nm) : '';
      if (e.k === 'kill') {
        rows.push({ t: e.rt, who: d.kn ? latin(d.kn) : name || ONE[d.vk] || '', kind: d.kn ? d.kk : d.vk, act: 'killed',
          text: d.kn ? (name || ONE[d.vk] || d.vk || '') + (killSaid(d) ? ' · ' + killSaid(d) : '') : T('died'), at: d.at, id: null });
      } else if (e.k === 'loot' || e.k === 'drop') {
        const worth = lootWorth(d);
        rows.push({ t: e.rt, who: name || ONE[d.wk] || '', kind: d.wk, act: e.k === 'loot' ? 'looted' : d.g ? 'threw' : 'dropped',
          text: (d.i || '') + (d.q > 1 ? ' ×' + d.q : '') + (Number.isFinite(worth) && worth ? ' · ' + roubles(worth) : '') + (d.ad === 1 ? ' · ' + T('from the airdrop') : ''), at: d.at, id: e.p ? idOf(e.p) : null });
      } else if (e.k === 'door') {
        rows.push({ t: e.rt, who: name, kind: '', act: 'door', text: doorSaid(d), at: d.at, id: e.p ? idOf(e.p) : null });
      } else if (e.k === 'left') {
        rows.push({ t: e.rt, who: name || ONE[d.wk] || '', kind: d.wk, act: 'left', text: d.x === 0 ? T('Left the raid') : T('Extracted'), at: d.at, id: null });
      } else if (e.k === 'end') {
        rows.push({ t: e.rt, who: r.about.name ? latin(r.about.name) : T('Player'), kind: 'Main Player', act: 'left', text: spaced(EXITS[d.st] || d.st || '') + (d.ex ? ' · ' + exitSaid(d.ex, r.about) : ''), at: d.at, id: null });
      } else if (e.k === 'switch') {
        if (!lightSwitch(d) && switchStood.has(d.id) && switchStood.get(d.id) !== d.st)
          rows.push({ t: e.rt, who: '', kind: '', act: 'switch', text: String(d.nm || T('Switch')).replace(/_+/g, ' ') + ' · ' + (d.st === 'Open' ? T('Switched on') : T('Switched off')), at: d.at, id: null });
        switchStood.set(d.id, d.st);
      } else if (e.k === 'orbit.wake') {
        rows.push({ t: e.rt, who: name, kind: 'Other AI', act: 'ghost', text: T('Woke') + ' · ' + [d.c, d.by ? T('by {who}', { who: latin(d.by) }) : '', d.m ? d.m + ' m' : ''].filter(Boolean).join(' · '), at: null, id: e.p ? idOf(e.p) : null });
      } else if (e.k === 'orbit.fight') {
        rows.push({ t: e.rt, who: 'ORBIT', kind: 'Other AI', act: 'ghost', text: T('Ghost fight') + (d.n ? ' · ' + TP(d.n, '{n} dead', '{n} dead') : ''), at: d.a, id: null });
      } else if (e.k === 'comet.mag') {
        // a magazine dropped in a quick reload, and going back for it (COMET)
        rows.push({ t: e.rt, who: name, kind: '', act: 'mag', text: (MAG_SAID[d.st] || d.st || '') + (d.i ? ' · ' + d.i : ''), at: d.at, id: e.p ? idOf(e.p) : null });
      }
    }
    for (const [pid, calls] of r.signals.voices) {
      const id = idOf(pid), bot = s.tracks.get(id);
      for (const call of calls) rows.push({ t: call.t, who: bot?.name || pid, kind: bot?.c || '', act: 'voice',
        text: spaced(call.phrase.replace(/^On(?=[A-Z])/, '')), at: null, id });
    }
    for (const share of r.signals.shares) {
      const id = idOf(share.from), from = s.tracks.get(id), to = s.tracks.get(idOf(share.to));
      rows.push({ t: share.t, who: from?.name || share.from, kind: from?.c || '', act: 'share',
        text: (from?.name || share.from) + ' → ' + (to?.name || share.to), at: null, id });
    }
    for (const b of s.blasts) {
      const track = s.tracks.get(b.who) || (b.pid && s.tracks.get(idOf(b.pid)));
      rows.push({ t: b.t, who: track ? track.name || ONE[track.c] || track.c : '', kind: track ? track.c : '', act: 'grenade', text: b.name ? T('Grenade went off') + ' · ' + b.name : T('Grenade went off'), at: [b.x, b.y], id: null });
    }
    return rows.sort((x, y) => x.t - y.t);
  }
  const ACTS = { voice: T('Voice call'), share: T('Contact shared'), killed: T('killed'), looted: T('looted'), dropped: T('dropped'), threw: T('threw'), grenade: T('grenade'), left: T('left'), switch: T('switch'), door: T('door'), ghost: T('ghost'), mag: T('magazine') };
  // what PBT made of one of its cheaters ("personality|cheat,cheat"), said
  const cheatSaid = s => {
    if (!s) return '';
    const [p, c] = String(s).split('|');
    return [p ? T('Personality: {p}', { p: spaced(p) }) : '', c ? T('Cheats: {c}', { c: c.split(',').map(spaced).join(', ') }) : T('No cheats')].filter(Boolean).join(' · ');
  };
  const ACT_COL = { killed: '#ef5350', looted: '#7fd36b', dropped: '#f5a623', threw: '#ffb74d', grenade: '#ff8a65', left: '#2dd4bf', switch: '#3ddc5a', ghost: '#9fd8ff', mag: '#e0a63a', door: '#d9c29a' };
  function rvTimeline(box, r) {
    const all = raidRows(r), tools = mk('div', 'winTools'), text = mk('input'), chips = mk('div', 'actChips'), count = mk('small');
    // The raid's events over its length: a lane for each sort, a dot for each event (a player's own bigger); pointed
    // at, it says what; pressed, the map goes there
    const lanes = mk('div', 'tlLanes'), axis = mk('div', 'tlAxis');
    const step = r.total > 1200000 ? 300000 : r.total > 300000 ? 60000 : 30000;
    for (let t = 0; t <= r.total; t += step) { const tick = mk('span', '', clockText(t)); tick.style.left = (100 * t / r.total) + '%'; axis.appendChild(tick); }
    lanes.appendChild(axis);
    for (const act of Object.keys(ACTS)) {
      const rows = all.filter(x => x.act === act);
      if (!rows.length) continue;
      const lane = mk('div', 'tlLane'), label = mk('span', 'tlName', ACTS[act]), track = mk('div', 'tlTrack');
      label.appendChild(mk('b', '', String(rows.length)));
      label.style.color = ACT_COL[act];
      for (const x of rows) {
        const dot = mk('i', PEOPLE.includes(x.kind) ? 'mine' : '');
        dot.style.left = (100 * x.t / r.total) + '%';
        dot.style.background = ACT_COL[act];
        dot.title = clockText(x.t) + ' · ' + (x.who ? x.who + ' ' : '') + (ACTS[x.act] || '') + (x.text ? ' · ' + x.text : '');
        dot.onclick = () => rvGo(x.t, x.at, x.id);
        track.appendChild(dot);
      }
      lane.append(label, track);
      lanes.appendChild(lane);
    }
    box.appendChild(lanes);
    text.type = 'search';
    text.placeholder = T('Filter by name or detail…');
    text.value = rvFilter.text;
    // a chip for each sort of event, with how many: pressed, only those (pressed again: all of them)
    const chipFor = (act, label, n) => {
      const c = mk('button', 'actChip' + (rvFilter.act === act ? ' on' : ''));
      c.type = 'button';
      if (act) { const dot = mk('i'); dot.style.background = ACT_COL[act]; c.appendChild(dot); }
      c.append(label, mk('b', '', String(n)));
      c.onclick = () => { rvFilter.act = rvFilter.act === act ? '' : act; for (const o of chips.children) o.classList.toggle('on', o === c && !!rvFilter.act || !rvFilter.act && o === chips.firstChild); fill(); };
      chips.appendChild(c);
    };
    chipFor('', T('Everything'), all.length);
    for (const act of Object.keys(ACTS)) { const n = all.filter(x => x.act === act).length; if (n) chipFor(act, ACTS[act], n); }
    if (!rvFilter.act) chips.firstChild.classList.add('on');
    tools.append(clearable(text), count);
    box.append(chips, tools);
    const table = mk('table', 'board timeline'), head = table.createTHead().insertRow();
    for (const label of [T('Time'), T('Name'), T('Action'), T('Detail')]) head.appendChild(mk('th', '', label));
    const body = table.createTBody();
    box.appendChild(table);
    const fill = () => {
      body.textContent = '';
      const want = rvFilter.text.trim().toLowerCase();
      const rows = all.filter(x => (!rvFilter.act || x.act === rvFilter.act) && (!want || (x.who + ' ' + x.text).toLowerCase().includes(want)));
      count.textContent = TP(rows.length, '{n} event', '{n} events') + (rows.length > 1500 ? ' · ' + T('the first {n} shown', { n: 1500 }) : '');
      for (const x of rows.slice(0, 1500)) {
        const row = body.insertRow(), who = row.insertCell(-1);
        row.className = 'pick act-' + x.act + (PEOPLE.includes(x.kind) ? ' mine' : '');
        who.before(mk('td', '', clockText(x.t)));
        const dot = mk('i');
        dot.style.background = (KINDS[x.kind] || OTHER).col;
        if (x.who) who.append(dot, x.who);
        const tag = mk('span', 'actTag', ACTS[x.act] || x.act);
        tag.style.color = ACT_COL[x.act];
        tag.style.background = (ACT_COL[x.act] || '#888') + '22';
        row.insertCell().appendChild(tag);
        row.insertCell().textContent = x.text;
        row.title = T('Go to this moment on the map');
        row.onclick = () => rvGo(x.t, x.at, x.id);
      }
    };
    text.oninput = () => { rvFilter.text = text.value; fill(); };
    fill();
  }

  // What every bot was doing, side by side: a bar each over the raid, coloured by the sort of thing. The wheel
  // zooms in on a stretch of time, a drag moves along it, a press goes there on the map with that bot followed.
  function rvBehaviour(box, r, s) {
    const fate = new Map();
    for (const e of r.events) if (e.p && (e.k === 'kill' || e.k === 'left')) fate.set(e.p, { k: e.k === 'kill' ? 'dead' : 'gone', t: e.rt });
    const bots = [...s.tracks.entries()].filter(([, t]) => !PEOPLE.includes(t.c) && t.beh.length)
      .sort((x, y) => (KINDS[y[1].c] || OTHER).order - (KINDS[x[1].c] || OTHER).order || x[1].first - y[1].first);
    if (!bots.length) { box.appendChild(mk('p', 'winNote', T('No bots were recorded in this raid.'))); return; }
    const used = new Set(['pre']);
    for (const [, t] of bots) { for (const b of t.beh) used.add(b.k); const end = fate.get(t.pid); if (end) used.add(end.k); }
    // how long all the bots together spent on each sort of thing, while alive in the raid
    const spent = new Map(), each = new Map();
    for (const [id, t] of bots) {
      const end = fate.get(t.pid), until = end ? Math.min(end.t, t.last + 4000) : t.last, own = new Map();
      t.beh.forEach((b, i) => { const to = Math.max(0, (i + 1 < t.beh.length ? t.beh[i + 1].t : until) - b.t); spent.set(b.k, (spent.get(b.k) || 0) + to); own.set(b.k, (own.get(b.k) || 0) + to); });
      each.set(id, own);
    }
    const alive = [...spent.values()].reduce((n, v) => n + v, 0) || 1;
    // A sort pressed (in the bar of shares or the key): it alone stands out in every bot's bar, the rest faded;
    // pressed again, all of them again.
    const focus = key => { rvBehFocus = rvBehFocus === key ? '' : key; for (const el of box.querySelectorAll('[data-beh]')) el.classList.toggle('on', el.dataset.beh === rvBehFocus); box.classList.toggle('behFocus', !!rvBehFocus); paint(); };
    rvBehDrop = () => { if (rvBehFocus) focus(rvBehFocus); };
    const share = mk('div', 'behShare');
    share.appendChild(mk('h4', '', T('What the bots spent their time doing')));
    const strip = mk('div', 'behStrip'), legend = mk('div', 'behLegend');
    for (const key of Object.keys(BEH)) {
      if (!used.has(key)) continue;
      const part = spent.get(key) || 0, pct = Math.round(100 * part / alive);
      if (part > 0) {
        const seg = mk('i');
        seg.dataset.beh = key;
        seg.style.flex = String(part);
        seg.style.background = BEH[key][1];
        seg.title = BEH[key][0] + ' · ' + pct + '%';
        seg.onclick = () => focus(key);
        strip.appendChild(seg);
      }
      const item = mk('button', 'behKey'), dot = mk('i');
      item.type = 'button';
      item.dataset.beh = key;
      dot.style.background = BEH[key][1];
      item.append(dot, BEH[key][0]);
      if (part > 0) item.appendChild(mk('b', '', pct + '%'));
      item.title = T('Press to pick these out in every bar (again: all of them)');
      item.onclick = () => focus(key);
      legend.appendChild(item);
    }
    share.append(strip, legend);
    box.appendChild(share);
    if (rvBehFocus) { for (const el of box.querySelectorAll('[data-beh]')) el.classList.toggle('on', el.dataset.beh === rvBehFocus); box.classList.add('behFocus'); }
    // (the rows as tall as the window allows, so a raid with few bots still fills it)
    const ROW = Math.max(26, Math.min(44, Math.floor(($('hpBody').clientHeight - 300) / bots.length))), AXIS = 24;
    const wrap = mk('div', 'behWrap'), names = mk('div', 'behNames'), plot = mk('div', 'behPlot'), c = mk('canvas'), tip = mk('div', 'chartTip');
    tip.hidden = true;
    names.style.paddingTop = AXIS + 'px';
    for (const [id, t] of bots) {
      const b = mk('button'), dot = mk('i');
      b.type = 'button';
      dot.style.background = (KINDS[t.c] || OTHER).col;
      b.append(dot, mk('span', '', t.name || ONE[t.c] || t.c), mk('small', '', ONE[t.c] || t.c));
      b.style.height = ROW + 'px';
      b.title = (t.name || ONE[t.c] || t.c) + ' · ' + T('Follow on the map');
      b.onclick = () => rvGo(Math.max(t.first + 2500, Math.min(r.at, t.last)), null, id);
      names.appendChild(b);
    }
    plot.append(c, tip);
    wrap.append(names, plot);
    box.appendChild(wrap);
    box.appendChild(mk('p', 'winNote', T('Scroll over the bars to zoom in on a stretch of time, drag to move along it, press to go there on the map. Press a sort above to pick it out.')));
    // each bot's time, as shares of the sorts that took the most of everybody's
    const topSorts = [...spent].filter(([k]) => k !== 'pre').sort((x, y) => y[1] - x[1]).slice(0, 8).map(x => x[0]);
    if (topSorts.length) {
      rvSection(box, T('Each bot\'s time'));
      const table = mk('table', 'board behTable'), head = table.createTHead().insertRow();
      head.appendChild(mk('th', '', T('Name')));
      for (const k of topSorts) { const th = mk('th', 'num', BEH[k][0]); th.style.color = BEH[k][1]; head.appendChild(th); }
      head.appendChild(mk('th', 'num', T('Alive')));
      const body = table.createTBody();
      for (const [id, t] of bots) {
        const own = each.get(id), total = [...own.values()].reduce((n, v) => n + v, 0) || 1, row = body.insertRow(), name = row.insertCell(), dot = mk('i');
        dot.style.background = (KINDS[t.c] || OTHER).col;
        name.append(dot, t.name || ONE[t.c] || t.c);
        for (const k of topSorts) {
          const share = (own.get(k) || 0) / total, cell = row.insertCell();
          cell.className = 'num';
          if (share >= 0.005) {
            cell.textContent = Math.round(100 * share) + '%';
            cell.style.background = BEH[k][1] + Math.round(Math.min(0.55, share) * 255).toString(16).padStart(2, '0');
          }
        }
        const alive = row.insertCell();
        alive.className = 'num';
        alive.textContent = clockText(total);
        row.className = 'pick';
        row.title = T('Follow on the map');
        row.onclick = () => rvGo(Math.max(t.first + 2500, Math.min(r.at, t.last)), null, id);
      }
      box.appendChild(table);
    }
    if (!rvView || rvView.id !== r.about.id) rvView = { id: r.about.id, a: 0, b: r.total };
    let w = 600, over = null;
    const h = AXIS + bots.length * ROW, ratio = window.devicePixelRatio || 1;
    const X = t => (t - rvView.a) / (rvView.b - rvView.a) * w, at = x => rvView.a + (rvView.b - rvView.a) * x / w;
    const parts = t => {
      const end = fate.get(t.pid), until = end ? Math.min(end.t, t.last + 4000) : t.last, list = [{ a: 0, b: t.first, k: 'pre', text: '' }];
      t.beh.forEach((b, i) => list.push({ a: b.t, b: i + 1 < t.beh.length ? t.beh[i + 1].t : until, k: b.k, text: b.text, gh: b.gh }));
      if (end) list.push({ a: until, b: r.total, k: end.k, text: '' });
      return list;
    };
    const paint = () => {
      w = Math.max(200, plot.clientWidth);
      c.width = Math.round(w * ratio);
      c.height = Math.round(h * ratio);
      c.style.width = w + 'px';
      c.style.height = h + 'px';
      const g = c.getContext('2d');
      g.setTransform(ratio, 0, 0, ratio, 0, 0);
      g.clearRect(0, 0, w, h);
      g.font = '11px ' + FONT;
      g.textBaseline = 'middle';
      const span = rvView.b - rvView.a, step = [5000, 10000, 30000, 60000, 120000, 300000, 600000].find(v => span / v <= 10) || 1200000;
      for (let t = Math.ceil(rvView.a / step) * step; t <= rvView.b; t += step) {
        const x = Math.round(X(t)) + 0.5;
        g.strokeStyle = 'rgba(200, 205, 255, 0.1)';
        g.beginPath(); g.moveTo(x, AXIS - 4); g.lineTo(x, h); g.stroke();
        g.fillStyle = '#8a8c9a';
        g.textAlign = x < 20 ? 'left' : x > w - 20 ? 'right' : 'center';
        g.fillText(clockText(t), x, 9);
      }
      bots.forEach(([, t], i) => {
        const y = AXIS + i * ROW;
        // (a row's own faint band, so the rows read across)
        if (i % 2) { g.fillStyle = 'rgba(255, 255, 255, 0.02)'; g.fillRect(0, y, w, ROW); }
        for (const p of parts(t)) {
          if (p.b <= rvView.a || p.a >= rvView.b) continue;
          const x0 = Math.max(0, X(p.a)), x1 = Math.min(w, X(p.b));
          // (a sort picked out: the rest faded)
          g.globalAlpha = rvBehFocus && p.k !== rvBehFocus && p.k !== 'pre' && p.k !== 'dead' ? 0.14 : 1;
          g.fillStyle = BEH[p.k][1];
          g.fillRect(x0, y + 3, Math.max(1, x1 - x0), ROW - 6);
          // (parked by ORBIT as a ghost for this stretch: paler)
          if (p.gh) { g.fillStyle = 'rgba(12, 12, 18, 0.45)'; g.fillRect(x0, y + 3, Math.max(1, x1 - x0), ROW - 6); }
        }
        g.globalAlpha = 1;
      });
      // where the replay is, and the bar under the pointer
      const now = X(r.at);
      if (now >= 0 && now <= w) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(now, AXIS - 6); g.lineTo(now, h); g.stroke(); g.lineWidth = 1; }
      if (over) { g.strokeStyle = 'rgba(255,255,255,0.7)'; g.strokeRect(0.5, AXIS + over.i * ROW + 1.5, w - 1, ROW - 3); }
    };
    const under = e => {
      const box2 = c.getBoundingClientRect(), x = e.clientX - box2.left, y = e.clientY - box2.top, i = Math.floor((y - AXIS) / ROW);
      if (i < 0 || i >= bots.length) return null;
      const t = at(x), part = parts(bots[i][1]).find(p => t >= p.a && t < p.b);
      return { i, t, x, y, part, id: bots[i][0], track: bots[i][1] };
    };
    let drag = null;
    c.onwheel = e => {
      e.preventDefault();
      const box2 = c.getBoundingClientRect(), mid = at(e.clientX - box2.left), k = e.deltaY > 0 ? 1.3 : 1 / 1.3, span = Math.min(r.total, Math.max(8000, (rvView.b - rvView.a) * k));
      let a = mid - (mid - rvView.a) * span / (rvView.b - rvView.a);
      a = Math.min(r.total - span, Math.max(0, a));
      rvView.a = a;
      rvView.b = a + span;
      paint();
    };
    c.onpointerdown = e => { c.setPointerCapture(e.pointerId); drag = { x: e.clientX, a: rvView.a, moved: false }; };
    c.onpointermove = e => {
      if (drag) {
        const span = rvView.b - rvView.a, a = Math.min(r.total - span, Math.max(0, drag.a - (e.clientX - drag.x) * span / w));
        if (Math.abs(e.clientX - drag.x) > 4) drag.moved = true;
        rvView.a = a;
        rvView.b = a + span;
        tip.hidden = true;
        paint();
        return;
      }
      over = under(e);
      paint();
      if (!over || !over.part) { tip.hidden = true; return; }
      tip.textContent = '';
      tip.append(mk('b', '', (over.track.name || ONE[over.track.c] || over.track.c) + ' · ' + clockText(over.t)), mk('span', '', BEH[over.part.k][0] + (over.part.gh ? ' · ' + T('Ghost') : '')),
        mk('span', '', over.part.text || ''), mk('span', 'dim', clockText(over.part.a) + ' – ' + clockText(over.part.b)),
        mk('span', 'dim', over.part.k === 'pre' || over.part.k === 'dead' || over.part.k === 'gone' ? '' : T('Press: watch it from {t}', { t: clockText(over.part.a) })));
      tip.hidden = false;
      tip.style.width = '220px';
      tip.style.left = Math.min(w - 230, Math.max(0, over.x + (over.x > w / 2 ? -232 : 14))) + 'px';
      tip.style.top = Math.max(0, over.y - 30) + 'px';
    };
    c.onpointerup = e => {
      const was = drag;
      drag = null;
      if (was && was.moved) return;
      const hit = under(e);
      if (!hit) return;
      // (on a stretch of what it was doing: from that stretch's start; before it came in or after it died: then)
      const from = hit.part && hit.part.k !== 'pre' && hit.part.k !== 'dead' && hit.part.k !== 'gone' ? Math.max(hit.part.a, hit.track.first) : hit.t;
      rvGo(from + 2500, null, hit.id);
    };
    c.onpointerleave = () => { over = null; tip.hidden = true; if (!drag) paint(); };
    chartsToLay.push(paint);
    // ORBIT's ghosts that were woken, and why
    const wakes = r.events.filter(e => e.k === 'orbit.wake');
    if (wakes.length) {
      const fold = mk('details', 'winFold'), find = mk('input'), list = mk('div', 'wakeList');
      fold.appendChild(mk('summary', '', T('Ghost wake diagnostics') + ' (' + wakes.length + ')'));
      find.type = 'search';
      find.placeholder = T('Filter by name or detail…');
      fold.append(clearable(find), list);
      const fill = () => {
        list.textContent = '';
        const want = find.value.trim().toLowerCase();
        for (const e of wakes) {
          const d = e.d, said = [clockText(e.rt), e.nm ? latin(e.nm) : T('A ghost'), d.c || '', d.dt || '', d.by ? T('by {who}', { who: latin(d.by) }) : '', d.m ? d.m + ' m' : ''].filter(Boolean).join(' · ');
          if (want && !said.toLowerCase().includes(want)) continue;
          const b = mk('button', 'linkBtn', said);
          b.type = 'button';
          b.onclick = () => rvGo(e.rt, null, (() => { for (const [id, t] of s.tracks) if (t.pid === e.p) return id; return null; })());
          list.appendChild(b);
        }
      };
      find.oninput = fill;
      fill();
      box.appendChild(fold);
    }
  }

  // ---- beside the replay's map, on the right: what was going on at the moment shown -------------------------------
  // In four tabs, so nothing is a long scroll away: the raid's events, the bots (what they carry, where they're sent,
  // ORBIT's plans), the loot, and every setting of what a replay shows. Within a tab, a fold for each sort of thing, open
  // or shut as it was left (prefs.hpOpen); a tab with one fold has it open, without its title. Only the tab shown is
  // worked out again as the replay goes, about once a second while it plays; never the fold being typed in.
  const SIDE_TABS = [['events', T('Events')], ['bots', T('Bots')], ['loot', T('Loot')], ['settings', T('Settings')]];
  // [key, title, fill, open to begin with, tab]
  const HP_SECTIONS = [
    ['events', T('Raid events'), sideEvents, true, 'events'],
    ['drops', T('Airdrops'), sideDrops, true, 'events'],
    ['switches', T('Switches'), sideSwitches, false, 'events'],
    ['cometDebug', T('COMET event inspector'), sideCometDebug, false, 'bots'],
    ['cometReports', T('COMET raid reports'), sideCometReports, false, 'bots'],
    ['why', T('Why it does what it does'), sideWhy, true, 'bots'],
    ['inv', T('Bot inventory'), sideInv, true, 'bots'],
    ['quests', T('Bot quests'), sideQuests, true, 'bots'],
    ['sent', T('Bot objectives'), sideSent, false, 'bots'],
    ['orbit', T('ORBIT main objectives'), sideOrbit, false, 'bots'],
    ['hear', T('Ghost hearing'), sideHear, false, 'bots'],
    ['fields', T('Fields'), sideFields, false, 'bots'],
    ['loot', T('Loot'), sideLoot, true, 'loot'],
    ['settings', T('Settings'), sideSettings, true, 'settings']];
  if (!prefs.hpOpen || typeof prefs.hpOpen !== 'object' || Array.isArray(prefs.hpOpen)) prefs.hpOpen = {};
  if (!SIDE_TABS.some(x => x[0] === prefs.hpTab)) prefs.hpTab = 'events';
  // its head: what it is, and a way to put it away (the map then has the width; a tab on the edge brings it back)
  const hpSideHead = mk('div', 'hpSideHead');
  const hpSideHide = mk('button', '', '»');
  hpSideHide.type = 'button';
  hpSideHide.title = T('Put this panel away');
  // the tabs, in the head: they stay at the top as the tab's folds scroll under them
  const hpTabs = mk('nav', 'hpTabs');
  for (const [key, title] of SIDE_TABS) {
    const b = mk('button', '', title);
    b.type = 'button';
    b.dataset.k = key;
    b.onclick = () => { if (prefs.hpTab === key) return; prefs.hpTab = key; save(); hpSide.scrollTop = 0; hpSideShow(); };
    hpTabs.appendChild(b);
  }
  hpSideHead.append(hpTabs, hpSideHide);
  hpSide.appendChild(hpSideHead);
  const hpSideTab = mk('button', 'ui', '« ' + T('Details'));
  hpSideTab.id = 'hpSideTab';
  hpSideTab.type = 'button';
  hpSideTab.title = T('Show the panel of what was going on at this moment');
  hpSideTab.hidden = true;
  document.body.appendChild(hpSideTab);
  const hpSideSet = off => { prefs.hpSideOff = off; save(); hpShow(); };
  hpSideHide.onclick = () => hpSideSet(true);
  hpSideTab.onclick = () => hpSideSet(false);
  for (const [key, title, , open, tab] of HP_SECTIONS) {
    const fold = mk('details', 'hpSec');
    fold.dataset.k = key;
    fold.dataset.tab = tab;
    fold.open = key in prefs.hpOpen ? !!prefs.hpOpen[key] : open;
    const sum = mk('summary', '', title);
    sum.appendChild(mk('small', 'hpSecCount', ''));
    fold.append(sum, mk('div', 'hpSecBody'));
    // (a tab's only fold is opened by the page, not by a press: not kept)
    fold.ontoggle = () => { if (fold.classList.contains('solo')) return; prefs.hpOpen[key] = fold.open; save(); if (fold.open) hpSideShow(); };
    hpSide.appendChild(fold);
  }
  // a fold with nothing in it this raid: says so, plainly
  const sideNone = (box, text) => box.appendChild(mk('p', 'hpNone', text));
  // the number beside a fold's name (nothing when there's nothing to count)
  const sideCount = (box, n) => { const c = box.parentNode.querySelector('.hpSecCount'); if (c) c.textContent = n ? String(n) : ''; box.parentNode.classList.toggle('empty', !n); };
  function hpSideShow() {
    const r = replay;
    if (!HIST || !r || hpSide.hidden) return;
    hpSideAt = performance.now();
    const s = scanReplay(r), orbit = (s.mods || []).includes('ORBIT') || r.events.some(e => String(e.k).startsWith('orbit.'));
    for (const b of hpTabs.children) b.classList.toggle('on', b.dataset.k === prefs.hpTab);
    const folds = [...hpSide.querySelectorAll('.hpSec')];
    // (one with nothing in this raid isn't there at all)
    const hasOf = k => k === 'cometDebug' || k === 'cometReports' ? prefs.hpDebug
      : k === 'hear' || k === 'orbit' ? orbit
      : k === 'switches' ? (r.hasSwitch !== undefined ? r.hasSwitch : (r.hasSwitch = switchFlipped(r)))
      : k === 'fields' ? r.events.some(e => e.k === 'orbit.field' || e.k === 'phobos.field')
      : k === 'quests' ? s.sentBy.has('QuestingBots') : k === 'drops' ? s.drops.size > 0
      : k === 'why' ? whyBot() !== null : true;
    const shown = folds.filter(f => f.dataset.tab === prefs.hpTab && hasOf(f.dataset.k));
    for (const fold of folds) {
      fold.hidden = !shown.includes(fold);
      if ((fold.hidden || !fold.open) && fold.lastChild.cometInspector) {
        fold.lastChild.cometInspector.abort();
        delete fold.lastChild.cometInspector;
        fold.lastChild.replaceChildren();
      }
      const solo = shown.length === 1 && shown[0] === fold;
      fold.classList.toggle('solo', solo);
      if (solo && !fold.open) fold.open = true;
    }
    for (const fold of shown) {
      const section = HP_SECTIONS.find(x => x[0] === fold.dataset.k);
      // (not while something in it is being typed in or slid; its name pressed to open it is no reason to wait)
      const busy = document.activeElement && fold.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)
        && !['checkbox', 'button', 'color'].includes(document.activeElement.type);
      if (!fold.open || busy) continue;
      section[2](fold.lastChild, r, s);
    }
  }
  // a switch of what's drawn on the map: the live map's own setting of the same name
  function sideCheck(box, key, label, byDefault, title) {
    const row = mk('label', 'row'), tick = mk('input');
    tick.type = 'checkbox';
    tick.checked = byDefault ? prefs[key] !== false : !!prefs[key];
    tick.onchange = () => {
      prefs[key] = tick.checked;
      const setting = $('opt' + key[0].toUpperCase() + key.slice(1));
      if (setting?.type === 'checkbox') setting.checked = tick.checked;
      save(); squadPanePrint = ''; tipFor = null; dirty = true;
    };
    row.append(tick, mk('span', '', label));
    if (title) row.title = title;
    box.appendChild(row);
  }
  // the Raid events panel (what squads did together, pick-ups, ORBIT's ghosts), as the live map has it beside its Raid
  // list: here in a fold of its own, as Raid Review keeps its bot decisions down the right
  function sideEvents(box) {
    const was = $('squadPane');
    if (!was || was.parentNode !== box) squadPanePrint = '';
    showSquadPane();
    const pane = $('squadPane');
    if (pane && pane.parentNode !== box) box.appendChild(pane);
  }
  // The settings tab: every setting of the live map's menu (which this page hasn't) that changes what a replay shows,
  // in groups. Each is the menu's own control, mirrored: changed through it, so both pages keep the same, with its
  // name and its explanation as the menu has them. Made once; brought up to date each time it's shown.
  const SIDE_SETTINGS = [
    ['markers', T('Markers and names'), ['optBotShape', 'optMeShape', 'optScale', 'optWorldScale', 'optSizeByKind', 'optTextScale', 'optNameScale', 'optDoingScale', 'optChaseRing', 'optNames', 'optMapDifficulty', 'optMapPersonality', 'optMyName', 'optLatin', 'optHealth', 'optHealthAll']],
    ['people', T('People and bots'), ['optSquadMarks', 'optModTeams', 'optTeamNames', 'optSquadCols', 'optMapDoing', 'optActionIcons', 'optTacticWords', 'optSquadParts', 'optDoorEvents']],
    ['onMap', T('On the map'), ['optShots', 'optLootFloats', 'optFloatWorth', 'optHitFlash', 'optKillLines', 'optGrenades', 'optSwitches', 'optKillKeep', 'optTrailMs', 'optMinimap']],
    ['orbit', T('ORBIT on the map'), ['optOrbitMain', 'optOrbitRush', 'optOrbitTactics', 'optOrbitLines', 'optOrbitNames', 'optOrbitFights', 'optOrbitHear', 'optOrbitField', 'optPhobosField']],
    ['floors', T('Floors'), ['optFloorOnly', 'optFloorDim', 'optFloorGrey', 'optFloorHide', 'optOtherLoot']],
    ['loot', T('Loot'), ['optContainerStyle', 'optContainerScale', 'optPrices', 'optWorth', 'optPeek', 'optWishMarks', 'optTipGear', 'optTipCarry', 'optSecureShown', 'optItemNames', 'optModTints', 'optRoofLoot', 'optRoofTotals', 'optRoofTotalsUnder']],
    ['feed', T('Kill feed'), ['optFeed', 'optFeedMine', 'optFeedPmc', 'optFeedBoss', 'optFeedAi', 'optFeedNames', 'optFeedRows', 'optFeedKeep', 'optFeedBox', 'optFeedBg']],
    ['screen', T('Screen'), ['optMapLight', 'optTurn', 'optLowPower']],
    ['colours', T('Colours'), []]];
  // ---- copying settings over from the other page --------------------------------------------------------------
  // The live map and Raid history keep their settings apart (see read); either can take groups of them from the
  // other, ticked by what they're about (as the history page's settings panel groups them), then loads again.
  const COPY_GROUPS = [
    ['markers', T('Markers and names'), ['botShape', 'meShape', 'scale', 'worldScale', 'sizeByKind', 'textScale', 'nameScale', 'doingScale', 'chaseRing', 'names', 'mapDifficulty', 'mapPersonality', 'myName', 'latin', 'health', 'healthAll']],
    ['people', T('People and bots'), ['squadMarks', 'modTeams', 'teamNames', 'squadCols', 'mapDoing', 'actionIcons', 'tacticWords', 'squadParts', 'doorEvents']],
    ['onMap', T('On the map'), ['shots', 'lootFloats', 'floatWorth', 'hitFlash', 'killLines', 'grenades', 'switches', 'killKeep', 'trailMs', 'minimap']],
    ['orbit', T('ORBIT on the map'), ['orbitMain', 'orbitRush', 'orbitTactics', 'orbitLines', 'orbitNames', 'orbitFights', 'orbitHear', 'orbitField', 'phobosField']],
    ['floors', T('Floors'), ['floorOnly', 'floorDim', 'floorGrey', 'floorHide', 'otherLoot']],
    ['loot', T('Loot'), ['containerStyle', 'containerScale', 'worth', 'peek', 'wishMarks', 'tipGear', 'tipCarry', 'secureShown', 'itemNames', 'modTints', 'roofLoot', 'roofTotals', 'roofTotalsUnder']],
    ['feed', T('Kill feed'), ['feed', 'feedMine', 'feedPmc', 'feedBoss', 'feedAi', 'feedNames', 'feedRows', 'feedKeep', 'feedBox', 'feedBg']],
    ['screen', T('Screen'), ['mapLight', 'turns', 'lowPower']],
    ['colours', T('Colours'), ['cols']]];
  // the ticks, the copy button and what it says: into box
  function copyFromOther(box) {
    const picked = new Set(Array.isArray(prefs.copyPick) ? prefs.copyPick : ['colours']);
    box.appendChild(mk('p', '', HIST ? T("Take settings from the live map: the ticked groups replace this page's own, and the page loads again.")
      : T("Take settings from Raid history: the ticked groups replace this page's own, and the page loads again.")));
    const grid = mk('div', 'filterGrid');
    for (const [key, title] of COPY_GROUPS) {
      const row = mk('label', 'row'), tick = mk('input');
      tick.type = 'checkbox';
      tick.checked = picked.has(key);
      tick.onchange = () => { if (tick.checked) picked.add(key); else picked.delete(key); prefs.copyPick = [...picked]; save(); };
      row.append(tick, mk('span', '', title));
      grid.appendChild(row);
    }
    box.appendChild(grid);
    const go = mk('button', 'linkBtn', HIST ? T('Copy from the live map') : T('Copy from Raid history')), said = mk('p', 'dim');
    go.type = 'button';
    go.onclick = () => {
      let from = null;
      try { from = JSON.parse(localStorage.getItem(HIST ? 'livemap' : 'satelliteHistory') || 'null'); } catch (e) { /* none */ }
      if (!from || typeof from !== 'object') {
        said.textContent = HIST ? T("Nothing to copy yet: the live map hasn't been opened in this browser.") : T("Nothing to copy yet: Raid history hasn't been opened in this browser.");
        return;
      }
      if (!picked.size) { said.textContent = T('Tick what to copy first.'); return; }
      for (const [key, , keys] of COPY_GROUPS) {
        if (!picked.has(key)) continue;
        for (const k of keys) if (k in from) prefs[k] = JSON.parse(JSON.stringify(from[k]));
      }
      save();
      location.reload();
    };
    box.append(go, said);
  }
  if (!HIST && $('copyFrom')) copyFromOther($('copyFrom'));
  const sideTwins = [];
  // one of the menu's controls, mirrored: a switch, a list to pick from or a slider, named as in the menu
  function sideTwin(id) {
    const own = $(id), home = own && own.closest('label');
    if (!home) return null;
    const name = home.querySelector('span'), said = name && name.querySelector('small');
    const row = mk('label', own.type === 'checkbox' ? 'row' : 'row range');
    row.title = home.dataset.tip !== undefined ? home.dataset.tip : home.title;
    if (home.classList.contains('sub')) row.classList.add('sub');
    let twin, text = null;
    if (own.tagName === 'SELECT') twin = own.cloneNode(true);
    else { twin = mk('input'); twin.type = own.type; for (const k of ['min', 'max', 'step']) if (own[k] !== '') twin[k] = own[k]; }
    twin.removeAttribute('id');
    const word = mk('span', '', (name ? (name.firstChild && name.firstChild.nodeType === 3 ? name.firstChild.textContent : name.textContent) : '').trim());
    if (said) { text = mk('small'); word.append(' ', text); }
    if (own.type === 'checkbox') row.append(twin, word); else row.append(word, twin);
    const sync = () => {
      if (own.type === 'checkbox') twin.checked = own.checked; else if (document.activeElement !== twin) twin.value = own.value;
      twin.disabled = own.disabled;
      row.classList.toggle('unavailable', home.classList.contains('unavailable'));
      if (home.classList.contains('unavailable')) row.title = home.title;
      if (text) text.textContent = said.textContent;
    };
    const pass = kind => () => {
      if (own.type === 'checkbox') own.checked = twin.checked; else own.value = twin.value;
      own.dispatchEvent(new Event(kind, { bubbles: true }));
      replayShown = '';
      showReplay();
      dirty = true;
      for (const t of sideTwins) t();
    };
    if (own.type === 'range') twin.oninput = pass('input'); else twin.onchange = pass('change');
    sync();
    sideTwins.push(sync);
    return row;
  }
  function sideSettings(box) {
    if (!box.childElementCount) {
      // (first: taking settings from the live map, folded to begin with)
      const copy = mk('details', 'setGroup');
      copy.dataset.k = 'copy';
      copy.open = prefs.hpOpen['set:copy'] === true;
      copy.ontoggle = () => { prefs.hpOpen['set:copy'] = copy.open; save(); };
      copy.appendChild(mk('summary', '', T('Copy from the live map')));
      copyFromOther(copy);
      box.appendChild(copy);
      for (const [key, title, ids] of SIDE_SETTINGS) {
        const group = mk('details', 'setGroup');
        group.dataset.k = key;
        group.open = prefs.hpOpen['set:' + key] !== false;
        group.ontoggle = () => { prefs.hpOpen['set:' + key] = group.open; save(); };
        group.appendChild(mk('summary', '', title));
        for (const id of ids) {
          const row = sideTwin(id);
          if (row) group.appendChild(row);
          if (id === 'optActionIcons') group.appendChild(actionLegend());
        }
        if (key === 'colours') {
          // every colour: the menu's own list, brought here, and its way back to the usual ones
          const cols = $('colorList');
          if (cols) group.appendChild(cols);
          const back = mk('button', 'linkBtn', $('colorReset').textContent);
          back.type = 'button';
          back.onclick = () => { $('colorReset').click(); listColors(); dirty = true; };
          group.appendChild(back);
        }
        box.appendChild(group);
      }
      // (filled once it's on the page: it finds its list by its id)
      if ($('colorList')) listColors();
    }
    for (const t of sideTwins) t();
    // (ORBIT's group only where ORBIT or Phobos was in the raid: every switch in it greyed otherwise)
    const orbitGroup = box.querySelector('.setGroup[data-k="orbit"]');
    if (orbitGroup) orbitGroup.hidden = [...orbitGroup.querySelectorAll('input')].every(i => i.disabled);
  }

  // what lies about and in containers at the moment shown, the best first
  function sideLoot(box) {
    box.textContent = '';
    // what of it is drawn on the map: nothing, what lay there (as it starts), or that and where loot can spawn
    const seg = mk('div', 'seg hpSeg');
    for (const [v, label, tip] of [['off', T('Off'), T('No loot on the map')], ['real', T('On the map'), T('What lay about and in containers at this moment')],
      ['both', T('+ Spawns'), T('That, and where loot can spawn')]]) {
      const b = mk('button', prefs.loot === v ? 'on' : '', label);
      b.type = 'button';
      b.title = tip;
      b.onclick = () => { prefs.loot = prefs.hpLootMap = v; save(); bestPrint = rosterPrint = null; tipFor = null; loadSpawns(); dirty = true; sideLoot(box); };
      seg.appendChild(b);
    }
    box.appendChild(seg);
    const loot = things;
    if (!loot) { sideCount(box, 0); sideNone(box, T('This recording has no loot (it was made before loot was kept, or loot is switched off on the server).')); return; }
    const nameOf = tpl => (loot.names[tpl] || {}).s || (loot.names[tpl] || {}).n || tpl, priceOf = tpl => (loot.names[tpl] || {}).p || 0;
    const rows = loot.loose.map(i => ({ name: nameOf(i.tpl), n: i.n, worth: i.worth, where: 'ground', at: [i.x, i.y] }));
    // (what's in a container or on a body: where that container or body is, so it can be gone to as well)
    const spotOf = new Map();
    for (const b of (places && places.boxes) || []) if (b.id && Array.isArray(b.p)) spotOf.set(b.id, b.p);
    for (const b of loot.bodies) spotOf.set(b.id, b.p);
    for (const key of Object.keys(loot.inside)) {
      const p = spotOf.get(key);
      for (const i of loot.inside[key] || []) rows.push({ name: nameOf(i[0]), n: i[1] || 1, worth: priceOf(i[0]) * (i[1] || 1), where: 'box', at: p ? [p[0], p[1]] : null });
    }
    const tools = mk('div', 'winTools'), text = mk('input'), min = mk('input'), pick = mk('select'), count = mk('small');
    text.type = 'search';
    text.placeholder = T('Filter by name…');
    text.value = rvLoot.text;
    min.type = 'number';
    min.min = '0';
    min.step = '5000';
    min.placeholder = T('Least worth (₽)');
    min.value = rvLoot.min ? String(rvLoot.min) : '';
    min.title = T('Only loot worth at least this much.');
    for (const [value, label] of [['', T('Ground and containers')], ['ground', T('On the ground')], ['box', T('In containers')]]) pick.appendChild(new Option(label, value));
    pick.value = rvLoot.where;
    tools.append(clearable(text), min, pick, count);
    box.appendChild(tools);
    const table = mk('table', 'board slim'), body = table.createTBody();
    box.appendChild(table);
    const fill = () => {
      body.textContent = '';
      const want = rvLoot.text.trim().toLowerCase();
      const shown = rows.filter(x => x.worth >= rvLoot.min && (!rvLoot.where || x.where === rvLoot.where) && (!want || x.name.toLowerCase().includes(want))).sort((x, y) => y.worth - x.worth);
      count.textContent = TP(shown.length, '{n} item', '{n} items') + ' · ' + roubles(shown.reduce((n, x) => n + x.worth, 0));
      sideCount(box, rows.length);
      for (const x of shown.slice(0, 150)) {
        const row = body.insertRow(), name = row.insertCell(), dot = mk('i');
        dot.style.background = worthCol(x.worth);
        name.append(dot, x.name + (x.n > 1 ? ' ×' + x.n : ''));
        row.insertCell().textContent = roubles(x.worth);
        row.title = x.where === 'ground' ? T('On the ground') : T('In a container');
        if (x.at) { row.className = 'pick'; row.title = titleOf(row) + ' · ' + T('Show it on the map'); row.onclick = () => goTo(x.at[0], x.at[1]); }
      }
    };
    text.oninput = () => { rvLoot.text = text.value; fill(); };
    min.oninput = () => { rvLoot.min = Math.max(0, +min.value || 0); fill(); };
    pick.onchange = () => { rvLoot.where = pick.value; fill(); };
    fill();
  }

  // the switches of the map as they stood: the ones switched on by then, and when
  function sideSwitches(box) {
    box.textContent = '';
    sideCount(box, switchNow.size);
    if (!switchNow.size) { sideNone(box, T('No switches were recorded in this raid.')); return; }
    sideCheck(box, 'switches', T('Show on map'), true);
    const on = [...switchNow.values()].filter(e => e.d && e.d.st === 'Open' && !NOT_A_SWITCH.test(e.d.nm || ''));
    box.appendChild(mk('p', 'winNote', TP(switchNow.size, '{n} switch recorded', '{n} switches recorded') + ' · ' + TP(on.length, '{n} switched on', '{n} switched on')));
    for (const e of on) {
      const b = mk('button', 'linkBtn', String(e.d.nm || T('Switch')).replace(/_+/g, ' ') + (e.t ? ' · ' + clockText(e.t) : ''));
      b.type = 'button';
      if (Array.isArray(e.d.at)) b.onclick = () => goTo(e.d.at[0], e.d.at[1]);
      box.appendChild(b);
    }
  }

  // where ORBIT's ghosts heard somebody from (the live map's own switch)
  function sideHear(box, r) {
    if (box.childElementCount) return;
    const heard = r.events.filter(e => e.k === 'orbit.hear').length;
    sideCount(box, heard);
    if (!heard) { sideNone(box, T('No ghost heard anyone in this raid.')); return; }
    sideCheck(box, 'orbitHear', T('Show on map'), false, T('Where ORBIT\'s parked bots heard somebody, as an ear on the map.'));
    box.appendChild(mk('p', 'winNote', TP(heard, 'A ghost heard somebody {n} time.', 'Ghosts heard somebody {n} times.')));
  }

  // the bots QuestingBots had on a quest at the moment shown: who, and the quest
  function sideQuests(box) {
    box.textContent = '';
    const on = live.filter(m => m.dyn && m.ob && m.os === 'QuestingBots' && m.c !== 'Corpse');
    sideCount(box, on.length);
    if (!on.length) { sideNone(box, T('No bot was on a quest at this moment.')); return; }
    const table = mk('table', 'board slim'), body = table.createTBody();
    for (const m of on) {
      const row = body.insertRow(), name = row.insertCell(), dot = mk('i');
      row.className = 'pick';
      dot.style.background = (KINDS[m.c] || OTHER).col;
      name.append(dot, m.t || ONE[m.c] || m.c);
      name.appendChild(mk('small', '', ONE[m.c] || m.c));
      row.insertCell().textContent = m.ob;
      row.title = T('Follow on the map');
      row.onclick = () => watch(m);
    }
    box.appendChild(table);
  }

  // the airdrops down by the moment shown: when each landed, and a way to it
  function sideDrops(box, r, s) {
    box.textContent = '';
    const down = [...s.drops.values()].filter(x => x.t <= r.at).sort((x, y) => x.t - y.t);
    sideCount(box, down.length);
    if (!down.length) { sideNone(box, TP(s.drops.size, 'No airdrop yet: {n} lands later in the raid.', 'No airdrop yet: {n} land later in the raid.')); return; }
    for (const x of down) {
      const b = mk('button', 'linkBtn', clockText(x.t) + ' · ' + (x.name || T('Airdrop')));
      b.type = 'button';
      b.title = T('Show it on the map');
      b.onclick = () => goTo(x.x, x.y);
      box.appendChild(b);
    }
  }

  // every bot a mod was sending somewhere at the moment shown (QuestingBots' quests have a fold of their own)
  function sideSent(box) {
    box.textContent = '';
    const sent = live.filter(m => m.dyn && m.ob && m.os !== 'QuestingBots' && m.c !== 'Corpse');
    sideCount(box, sent.length);
    if (!sent.length) { sideNone(box, T('No bot was being sent anywhere at this moment.')); return; }
    const table = mk('table', 'board slim'), body = table.createTBody();
    for (const m of sent) {
      const row = body.insertRow(), name = row.insertCell(), dot = mk('i');
      row.className = 'pick';
      dot.style.background = (KINDS[m.c] || OTHER).col;
      // (one cell: who, then where they're being sent under it, so a long objective wraps in the panel's width)
      name.className = 'sentCell';
      name.append(dot, m.t || ONE[m.c] || m.c);
      name.appendChild(mk('small', '', (ONE[m.c] || m.c) + ' · ' + (m.os || 'ORBIT')));
      name.appendChild(mk('span', 'sentGoal', m.ob + (m.gh ? ' · ' + T('Ghost') : '')));
      row.title = T('Follow on the map');
      row.onclick = () => watch(m);
    }
    box.appendChild(table);
  }

  // ORBIT's and Phobos's fields: what their bots are drawn along, and their zones
  function sideFields(box, r) {
    if (box.childElementCount) return;
    if (r.events.some(e => e.k === 'orbit.field')) sideCheck(box, 'orbitField', T('ORBIT field'), false, T('The arrows ORBIT\'s bots are drawn along, and its zones.'));
    if (r.events.some(e => e.k === 'phobos.field')) sideCheck(box, 'phobosField', T('Phobos field'), false, T('The arrows Phobos\'s bots are drawn along, and its zones.'));
    box.appendChild(mk('p', 'winNote', T('The field shown is the one recorded last before the moment shown.')));
  }

  // Keep the squad's reported objective order, independently of which goals are in progress.
  function sideOrbit(box, r, s) {
    box.textContent = '';
    sideCheck(box, 'orbitMain', T('Show on map'), false, T('Where each ORBIT squad is headed, and what for.'));
    sideCheck(box, 'orbitRush', T('Rush points'), false, T('The places an ORBIT squad is to sweep, as rings.'));
    sideCheck(box, 'orbitTactics', T('Squad tactical routes'), true, T('Show the reported destinations of all squads on tactical assignments.'));
    const squads = modOn('ORBIT') && orbitMain ? list(orbitMain.d.s) : [];
    sideCount(box, squads.length);
    if (!squads.length) sideNone(box, T('ORBIT had no squad objectives at this moment (or wasn\'t in this raid).'));
    const selected = orbitSquadOf(liveById.get(chased)?.pid);
    const names = new Map();
    for (const t of s.tracks.values()) if (t.pid) names.set(t.pid, t.name || ONE[t.c] || t.c);
    for (const squad of selected ? [selected, ...squads.filter(team => team !== selected)] : squads) {
      const row = mk('div', 'squadRow' + (squad === selected ? ' selected' : ''));
      const members = list(squad.MemberProfileIds).map(pid => names.get(pid)).filter(Boolean);
      row.dataset.squad = squad.SquadId;
      row.appendChild(mk('b', '', T('Squad {n}', { n: squad.SquadId ?? '?' }) + (members.length ? ' · ' + members.join(', ') : '')));
      const chain = mk('div', 'goalChain');
      for (const o of list(squad.MainObjectives)) {
        if (!o) continue;
        const state = orbitGoalState(o, squad), chip = mk('button', 'goal ' + state);
        chip.type = 'button';
        chip.append(mk('i', '', orbitLetter(o)), mk('span', '', orbitGoalName(o) + orbitStepCount(o)),
          mk('small', '', orbitStateText(o, state, squad)));
        const phase = o.OperationState || o.CampState || o.AirdropStage;
        if (state === 'active' && phase && phase !== 'active') chip.lastChild.prepend(words(String(phase)) + ' · ');
        chip.title = [o.OperationStep, o.OperationState, o.CampState, o.CampFailure, o.AirdropStage].filter(Boolean).join(' · ');
        if (Number.isFinite(o.X) && Number.isFinite(o.Z)) chip.onclick = () => goTo(o.X, o.Z);
        chain.appendChild(chip);
      }
      if (!chain.childElementCount) chain.appendChild(mk('span', 'dim', T('Nothing planned')));
      row.appendChild(chain);
      box.appendChild(row);
    }
    box.appendChild(mk('p', 'winNote', 'K ' + T('Kills') + ' · L ' + T('Loot') + ' · Q ' + T('Quest') + ' · E ' + T('Extract camp') + ' · A ' + T('Airdrop')
      + ' · S ' + T('Spawn rush') + ' · B ' + T('Boss rush') + ' · R ' + T('Marked room rush') + ' · N ' + T('Sniper overwatch') + ' · C ' + T('Custom rush')));
  }

  // Every bot and what it has at the moment shown, as Raid Review lists them: the dearest first, each with what it's
  // worth; pressed, what it wears and carries is set out under it (pressed again: put away). The dead are there too,
  // as their bodies hold it. Following one on the map is a press on its name in the list beside the map.
  // ---- Why: what the bot followed is doing and why, as the mods running it said at the moment shown ----------------
  // Who's in control of it (COMET in a fight, ORBIT, asleep as ORBIT's ghost, getting unstuck), ORBIT's goal and why
  // it's leaving, COMET's move with every option it weighed (each one's score, and why it could or couldn't), what
  // else COMET has it doing (medical, reloads, searching, its squad's plan), and its moves before, each pressed to go
  // there. COMET's choices come from the raid's recording of them (history.comet), one bot's at a time, asked for as
  // it's followed. COMET's own words for its reasons are shown as it says them, in English.
  const whyOf = new Map();
  let whyPrint = '';
  function whyLoad(r, pid) {
    const raid = r.about.id, key = raid + '|' + pid;
    if (whyOf.has(key)) return whyOf.get(key);
    const got = { state: 'loading', ev: [] };
    whyOf.set(key, got);
    fetch('api/history/comet?id=' + encodeURIComponent(raid) + '&p=' + encodeURIComponent(pid)).then(a => {
      if (!a.ok) throw new Error(String(a.status));
      return a.json();
    }).then(j => {
      // The server timestamps these rows from recording start. The map trims the loading screen.
      got.ev = j && Array.isArray(j.ev) ? j.ev.filter(e => e && e.d && Number.isFinite(e.t))
        .map(e => ({ t: Math.max(0, e.t - r.lead), d: e.d })).sort((x, y) => x.t - y.t) : [];
      got.choices = got.ev.filter(e => e.d.stage === 'selected' && /^A\d\d$/.test(e.d.feature) && e.d.decision);
      got.state = j && j.none ? 'none' : got.ev.length ? 'ok' : 'empty';
    }).catch(() => { got.state = 'error'; }).then(() => { if (replay === r) { whyPrint = ''; dirty = true; hpSideShow(); if (prefs.hpActions) showActionOverlay(r); } });
    return got;
  }
  // COMET's word for a reason ("zzap-ranked-selection", "native-push:incompletePath") as plain words
  const codeSaid = c => {
    const said = String(c || '').replace(/^zzap-/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').replace(/\s*:\s*/g, ': ').replace(/\s+/g, ' ').trim().toLowerCase();
    return said.charAt(0).toUpperCase() + said.slice(1);
  };
  const WHY_OWNERS = { combat: T('Combat'), orbit: T('ORBIT'), sleep: T('Asleep (ORBIT ghost)'), recovery: T('Getting unstuck'), other: T('The game\'s own brain') };
  const WHY_SEEN = 60000;
  // Who's in control of a bot as its marker has it now (the brain layer, "ly", in every report): "COMET : Post-combat"
  // is "COMET · Post-combat", ORBIT's layer "ORBIT · Orbit Brain Layer", a ghost "Asleep (ORBIT ghost)", the rest by
  // their layer's name. Null without one (COMET's own word for it, T04, is said then: it only comes now and then).
  function whyControl(m) {
    if (m.gh) return WHY_OWNERS.sleep;
    const layer = m.ly || '';
    if (!layer) return null;
    const owned = /^(\w+)\s*:\s*(.+)$/.exec(layer);
    if (owned) return owned[1].toUpperCase() + ' · ' + owned[2];
    return (/^Orbit/i.test(layer) ? 'ORBIT · ' : '') + spaced(layer);
  }
  function lastAt(events, at) {
    let lo = 0, hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (events[mid].t <= at) lo = mid + 1; else hi = mid;
    }
    return lo - 1;
  }
  // Keep evidence from the same action together. An unnamed release never inherits an unrelated decision.
  function recentMove(events, last, at) {
    let event = null, choice = null;
    for (let i = last; i >= 0 && at - events[i].t <= WHY_SEEN; i--) {
      const e = events[i], d = e.d;
      if (!/^A\d\d$/.test(d.feature) || !['started', 'selected', 'accepted', 'rejected', 'released'].includes(d.stage)) continue;
      if (!event) event = e;
      else if (d.feature !== event.d.feature || ['released', 'rejected'].includes(d.stage) || (event.d.decision && d.decision !== event.d.decision)) break;
      if (d.stage === 'selected') { choice = e; break; }
    }
    return { event, choice };
  }
  function phaseName(d) {
    if (d.stage === 'released') return T('Ended');
    if (d.stage === 'rejected') return T('Declined');
    if (d.stage === 'started') return d.reason === 'native-action-observed' ? T('Observed') : T('Started');
    if (d.stage === 'accepted') return T('Accepted');
    return T('Selected');
  }
  function moveReason(d) {
    const c = (d.candidates || []).find(c => c && c.decision === d.decision);
    const reason = c && c.reason && c.reason !== 'available' ? c.reason : d.reason;
    if (!reason || ['zzap-ranked-selection', 'zzap-capability-refreshed', 'native-action-observed', 'available'].includes(reason)) return '';
    if (reason === 'hidden-contact-handoff') return T('Switched to tracking a hidden target');
    if (reason === 'visible-contact-handoff') return T('Switched to a visible target');
    return codeSaid(reason);
  }
  const SAMPLED_SAIN_ACTIONS = { 'SAIN:Reload': T('Reloading'), 'SAIN:SeekCover': T('Moving to cover'), 'SAIN:RushEnemy': T('Pushing') };
  function currentAction(m, brain, compact = false) {
    if (!brain) return '';
    if (brain.by === 'ORBIT') {
      if (m.ob === 'Synthetic (Moving)') return T('Moving');
      if (m.ob === 'AmbushHotspot (Moving)') return T('Ambush') + ' · ' + T('Moving to it');
      return brain.ghost ? (m.ob || T('Ghost')) : brain.text;
    }
    const dc = m.dc || '';
    if (!brain.ghost && /^(SAIN|COMET)/i.test(m.ly || '') && modOn('SAIN') && /^SAIN:(?!None$|Peace$).+/.test(dc))
      return SAMPLED_SAIN_ACTIONS[dc] || cometMove(dc.slice(5));
    if (brain.fight && brain.by === 'SAIN') return 'SAIN · ' + T('Combat');
    if (brain.by === 'COMET' && m.cm) {
      const label = m.cm === 'Storm' ? T('Squad assault') : brain.text;
      if (!compact) return T('Selected') + ' · ' + label;
      return m.cm.startsWith('PostCombat') && m.cm.length > 10 ? cometMove(m.cm.slice(10)) : label;
    }
    return brain.text;
  }
  const orbitGoalName = o => o.Type === 'LootValue' ? T('Loot value') : o.Type === 'Kills' ? (o.KillAmbush ? T('Kill ambush') : T('Looking for kills')) : spaced(String(o.OperationName || o.QuestTitle || o.Type || ''));
  // A hunt timer belongs to the squad. Several main objectives can be pending at the same time.
  let huntSnapshot;
  const huntsByMember = new Map();
  function squadHunt(m) {
    if (!orbitMain || !m.pid || !modOn('ORBIT') || !/^(Synthetic \(Moving\)|AmbushHotspot\b)/.test(m.ob || '')) return '';
    if (huntSnapshot !== orbitMain) {
      huntSnapshot = orbitMain;
      huntsByMember.clear();
      for (const squad of list(orbitMain.d.s)) {
        const active = list(squad.MainObjectives).filter(o => o && o.Type === 'Kills' && !o.Completed &&
          (o.KillAmbush ? ['approach', 'holding'].includes(o.CampState) : o.KillsRoamStartedAt > 0));
        for (const pid of list(squad.MemberProfileIds)) huntsByMember.set(pid, active);
      }
    }
    const ambush = m.ob.startsWith('AmbushHotspot');
    const active = (huntsByMember.get(m.pid) || []).find(o => !!o.KillAmbush === ambush);
    return active ? orbitGoalName(active) : '';
  }
  function mapContext(m, brain) {
    const activity = replay && m.pid && modOn('COMET') && activityAt(replay, m.pid);
    const context = movementContext(m, brain);
    return activity ? (context ? activity + ' · ' + context : activity) : context;
  }
  function extractReason(reason) {
    return /^all mains done$/i.test(reason || '') ? T('All objectives done') : reason;
  }
  function movementContext(m, brain) {
    if (!brain) return '';
    const q = m.sq;
    if (q && q.f === 'S06' && q.a && modOn('COMET') && !brain.ghost && !squadOver(q) &&
        q.u !== 'interrupted' && q.u !== 'declined' && (brain.by === 'SAIN' || brain.by === 'COMET')) {
      if (q.why === 'hurt') return T('Target looks badly hurt');
      if (q.why === 'extract') return T('Target is extracting');
      if (q.why === 'reload') return T('Target is reloading');
      if (q.why === 'heal') return T('Target is healing');
      if (q.why === 'loot') return T('Target is looting');
      if (q.why === 'grenade') return T('Target has a grenade out');
      if (q.why === 'alone') return T('Target appears isolated');
      if (q.why === 'vulnerable') return T('Target looks vulnerable');
    }
    if (brain.by !== 'ORBIT') return '';
    if (m.xr && /^Exfil\b/.test(m.ob || '')) return extractReason(m.xr);
    return squadHunt(m);
  }
  // A proposal, a requested animation or crossing time while scrubbing is never evidence of execution.
  const GESTURE_LABELS = new Map([
    ['CornerPeek', T('Corner peek')], ['Prefire', T('Prefire')], ['Zigzag', T('Zigzag')],
    ['TacticalJump', T('Tactical jump')], ['DoorwayJump', T('Doorway jump')], ['CoverFeint', T('Cover feint')],
    ['FakeReload', T('Fake reload')], ['DoorwayPeek', T('Doorway peek')], ['FakeGrenade', T('Fake grenade')],
    ['FakeHeal', T('Fake heal')], ['EnteredRoom', T('Entered room')],
    ['DrewPistolEmpty', T('Drew pistol · primary empty')], ['DrewPistol', T('Drew pistol')],
    ['BackToPrimary', T('Back to primary weapon')], ['SwitchedForRange', T('Switched guns for range')], ['SwitchedPrimary', T('Switched primary weapon')],
    ['LeftExposedCover', T('Left cover · taking hits')], ['ReachedNewCover', T('Reached new cover')],
    ['InterruptedSurgery', T('Interrupted surgery')], ['InterruptedSurgeryHit', T('Interrupted surgery · hit')],
    ['InterruptedSurgeryThreat', T('Interrupted surgery · enemy nearby')], ['RepairedLimb', T('Repaired a limb')],
    ['StoppedHeavyBleed', T('Stopped heavy bleeding')], ['StoppedLightBleed', T('Stopped light bleeding')], ['TreatedFracture', T('Treated fracture')],
    ['SprintedPastDoor', T('Sprinted past doorway')], ['ThrewIntoRoom', T('Threw grenade into room')],
    ['ScatteredFromGrenade', T('Split from squad · grenade')], ['FledGrenade', T('Fled grenade')], ['DroppedProneGrenade', T('Went prone · grenade')],
    ['SwitchedDevicesOff', T('Switched tactical devices off')]
  ]);
  const GESTURE_MS = 3000, reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  function indexMapSignals(events, lead) {
    const shares = [], voices = new Map(), blasts = [], seen = new Set();
    for (const e of events) {
      if ((e.k !== 'bot.share' && e.k !== 'bot.voice' && e.k !== 'grenade.blast') || seen.has(e.n)) continue;
      const t = e.performedAt == null ? e.rt : Math.max(0, e.performedAt - lead);
      if (e.k === 'bot.share' && e.p && e.d.to && e.p !== e.d.to) shares.push({ t, from: e.p, to: e.d.to });
      if (e.k === 'bot.voice' && e.p && e.d.phrase) {
        if (!voices.has(e.p)) voices.set(e.p, []);
        voices.get(e.p).push({ t, phrase: e.d.phrase });
      }
      if (e.k === 'grenade.blast' && Array.isArray(e.d.at)) blasts.push(blastEvent(e, t));
      seen.add(e.n);
    }
    shares.sort((a, b) => a.t - b.t);
    blasts.sort((a, b) => a.t - b.t);
    for (const calls of voices.values()) calls.sort((a, b) => a.t - b.t);
    return { shares, voices, blasts };
  }

  function blastEvent(e, t) {
    return { t, pid: e.p, x: e.d.at[0], y: e.d.at[1], name: e.d.i || '', confirmed: true };
  }

  const noSignals = Object.freeze([]);
  function recentSignals(track, time, duration) {
    if (!track.length) return noSignals;
    const end = lastAt(track, time);
    if (end < 0 || time - track[end].t >= duration) return noSignals;
    let first = end;
    while (first >= 0 && time - track[first].t < duration) first--;
    return track.slice(first + 1, end + 1);
  }

  function indexSightings(events, lead) {
    const tracks = new Map(), seen = new Set();
    for (const e of events) {
      if (e.k !== 'bot.sight' || !e.p || !e.d?.target || seen.has(e.n)) continue;
      seen.add(e.n);
      if (!tracks.has(e.p)) tracks.set(e.p, []);
      tracks.get(e.p).push({ t: e.performedAt == null ? e.rt : Math.max(0, e.performedAt - lead), target: e.d.target });
    }
    const lastSight = new Map();
    for (const [observer, track] of tracks) {
      track.sort((a, b) => a.t - b.t);
      tracks.set(observer, track.filter(e => startsSightContact(lastSight, observer, e.target, e.t)));
    }
    return tracks;
  }
  function markerHop(track, time, radius) {
    if (!track || reducedMotion.matches) return 0;
    const duration = 650;
    for (let i = lastAt(track, time); i >= 0 && time - track[i].t < duration; i--) {
      if (track[i].jump) {
        const phase = (time - track[i].t) / duration;
        return 2 * radius * 4 * phase * (1 - phase);
      }
    }
    return 0;
  }
  function indexGestures(events, lead, hasGestures) {
    const tracks = new Map(), seen = new Set(), mags = new Set();
    for (const e of events) {
      if (!e.p || !e.d || seen.has(e.n)) continue;
      let name;
      if (e.k === 'comet.gesture') name = GESTURE_LABELS.get(e.d.action);
      else if (hasGestures && e.k === 'comet.mag') {
        if (e.d.st === 'queued') name = T('Dropped magazine');
        if (e.d.st === 'completed') name = T('Recovered magazine');
        if (name && e.d.id) {
          const key = e.p + '/' + e.d.id;
          if (e.d.st === 'queued') {
            if (mags.has(key)) continue;
            mags.add(key);
          } else mags.delete(key);
        }
      }
      if (!name) continue;
      seen.add(e.n);
      if (!tracks.has(e.p)) tracks.set(e.p, []);
      tracks.get(e.p).push({ t: e.performedAt == null ? e.rt : Math.max(0, e.performedAt - lead), name,
        jump: e.k === 'comet.gesture' && (e.d.action === 'TacticalJump' || e.d.action === 'DoorwayJump') });
    }
    for (const track of tracks.values()) track.sort((a, b) => a.t - b.t);
    return tracks;
  }
  const ACTIVITY_LABELS = new Map([
    ['PerformingSurgery', T('Performing surgery')], ['UsingStim', T('Using a stim')], ['UsingFirstAid', T('Using first aid')],
    ['TreatingFracture', T('Treating a fracture')], ['TreatingHeavyBleed', T('Treating heavy bleeding')],
    ['TreatingLightBleed', T('Treating light bleeding')], ['FlashAffected', T('Blinded by flash')], ['InsideGas', T('Inside CS gas')]
  ]);
  function indexActivities(events, lead) {
    const bots = new Map(), times = [], seen = new Set();
    for (const e of events) {
      if (e.k !== 'comet.activity' || !e.p || !ACTIVITY_LABELS.has(e.d.action) || typeof e.d.active !== 'boolean' || seen.has(e.n)) continue;
      seen.add(e.n);
      if (!bots.has(e.p)) bots.set(e.p, new Map());
      const tracks = bots.get(e.p), action = e.d.action;
      if (!tracks.has(action)) tracks.set(action, []);
      const edge = { t: e.performedAt == null ? e.rt : Math.max(0, e.performedAt - lead), on: e.d.active, n: e.n };
      tracks.get(action).push(edge);
      times.push(edge);
    }
    const order = (a, b) => a.t - b.t || a.n - b.n;
    for (const tracks of bots.values()) for (const track of tracks.values()) track.sort(order);
    return { bots, times: times.sort(order) };
  }
  function activityAt(r, pid) {
    const tracks = r.activities.bots.get(pid);
    if (!tracks) return '';
    let label = '';
    for (const [action, track] of tracks) {
      const i = lastAt(track, r.at);
      // Require both recorded edges. An incomplete archive cannot establish how long this lasted.
      if (i >= 0 && track[i].on && track[i + 1]?.on === false) {
        const next = ACTIVITY_LABELS.get(action);
        label = label ? label + ' · ' + next : next;
      }
    }
    return label;
  }
  function gestureTrack(r, pid, loadOld) {
    if (r.hasGestures || r.gestures.size) return r.gestures.get(pid);
    if (!loadOld) return r.legacyGestures?.get(pid);
    // Older formats kept detailed evidence per bot. Reuse evidence already loaded, and load a followed bot on demand.
    const got = whyLoad(r, pid);
    if (got.state !== 'ok') return null;
    if (r.legacyGestures?.has(pid)) return r.legacyGestures.get(pid);
    const track = actionTrack(got.ev);
    (r.legacyGestures ||= new Map()).set(pid, track);
    return track;
  }
  function drawGestures(m, r, x, y, scale) {
    const track = gestureTrack(r, m.pid, chased === m.id);
    if (!track || !track.length) return;
    const last = lastAt(track, r.at);
    let row = 0;
    for (let i = last; i >= 0 && r.at - track[i].t < GESTURE_MS; i--) {
      // Two sources in an older debug recording may describe the same door jump.
      let repeated = false;
      for (let k = i + 1; k <= last; k++) if (track[k].name === track[i].name) { repeated = true; break; }
      if (repeated) continue;
      const age = (r.at - track[i].t) / GESTURE_MS;
      const rise = reducedMotion.matches ? 0 : 15 * age;
      write(track[i].name, 12 * scale, x, y - (rise + row * 16) * scale, '#ffd17c', Math.min(1, (1 - age) * 3));
      row++;
    }
  }
  const actionTrackOf = new WeakMap();
  function actionTrack(events) {
    if (actionTrackOf.has(events)) return actionTrackOf.get(events);
    const track = [], previous = new Map();
    let weave = null;
    for (const { t, d } of events) {
      if (d.stage !== 'evaluated') continue;
      const f = d.feature;
      const edge = (key, ok, identity, name) => {
        if (!ok) { previous.delete(key); return; }
        if (previous.has(key) && previous.get(key) === identity) return;
        previous.set(key, identity);
        track.push({ t, name, jump: f === 'M12' || f === 'D02' });
      };
      if (f === 'M03' && d.cornerPeek) {
        const q = d.cornerPeek;
        edge(f, q.openObserved && q.peeks > 0, q.episode + '/' + q.peeks, T('Corner peek'));
      } else if (f === 'M06' && d.cornerPrefire) {
        const q = d.cornerPrefire;
        edge(f, q.actualShots > 0, q.episode, T('Prefire'));
      } else if (f === 'M11' && d.retreatWeave) {
        const q = d.retreatWeave;
        const turn = x => Math.abs(x) >= 5 && Math.abs(x) <= 85 ? Math.sign(x) : 0;
        const dir = turn(q.yaw);
        if (q.state !== 'evading' || !q.moveRequested || !(q.speed > 0) || !dir || dir !== turn(q.observedYaw)) continue;
        if (weave && t - weave.t <= 2000 && weave.context === q.context && weave.dir !== dir)
          track.push({ t, name: T('Zigzag') });
        weave = { t, context: q.context, dir };
      } else if (f === 'M12' && d.tacticalJump) {
        const q = d.tacticalJump;
        edge(f, q.takeoffObserved, q.attempt, q.sourceFeature === 'D02' ? T('Doorway jump') : T('Tactical jump'));
      } else if (f === 'M14' && d.coverFeint) {
        const q = d.coverFeint;
        edge('mag', q.animationObserved && q.magazineAccepted, q.episode, T('Fake reload'));
        edge(f, q.exposedObserved && q.movementObserved, q.episode, T('Cover feint'));
      } else if (f === 'D02' && d.doorJumpPeek) {
        const q = d.doorJumpPeek;
        edge(f, q.takeoffObserved, q.door + '/' + q.target, T('Doorway jump'));
      } else if (f === 'D04' && d.doorStepPeek) {
        const q = d.doorStepPeek;
        edge(f, q.arrived && q.looking, q.door + '/' + q.peek, T('Doorway peek'));
      } else if (f === 'D05' && d.doorFakeGrenade) {
        const q = d.doorFakeGrenade;
        edge(f, q.state === 'completed' && q.handsObserved, q.opportunity, T('Fake grenade'));
      } else if (f === 'D06' && d.doorFakeMedical) {
        const q = d.doorFakeMedical, med = q.medical;
        edge(f, q.state === 'completed' && q.handsObserved && med && med.consumptionObserved === false && !med.medicalHandoff, q.opportunity, T('Fake heal'));
      } else if ((f === 'D07' || f === 'D08') && d.doorRoomClear) {
        const q = d.doorRoomClear;
        edge(f, q.thresholdCrossed && q.movementObserved, q.door + '/' + q.target, T('Entered room'));
      }
    }
    actionTrackOf.set(events, track);
    return track;
  }

  const actionDock = $('actionDock'), actionBox = $('actionOverlay');
  let actionFrame = null, actionPrint = '';
  const fraction = v => Math.max(0, Math.min(1, v));
  function placeActionOverlay() {
    if (actionDock.hidden) return;
    const x = Number.isFinite(prefs.hpActionX) ? fraction(prefs.hpActionX) : 1;
    const y = Number.isFinite(prefs.hpActionY) ? fraction(prefs.hpActionY) : 0;
    actionBox.style.left = Math.round(x * Math.max(0, actionDock.clientWidth - actionBox.offsetWidth)) + 'px';
    actionBox.style.top = Math.round(y * Math.max(0, actionDock.clientHeight - actionBox.offsetHeight)) + 'px';
  }
  draggable($('actionHandle'), actionBox, (x, y) => {
    const r = actionDock.getBoundingClientRect();
    prefs.hpActionX = fraction((x - r.left) / Math.max(1, r.width - actionBox.offsetWidth));
    prefs.hpActionY = fraction((y - r.top) / Math.max(1, r.height - actionBox.offsetHeight));
    save(); placeActionOverlay();
  }, null, true);
  if (window.ResizeObserver) {
    const observer = new ResizeObserver(placeActionOverlay);
    observer.observe(actionDock); observer.observe(actionBox);
  }
  const overlayBot = m => m && m.pid && isMapBot(m, KINDS[m.c] || OTHER) && !isHidden(m.c) && !inArea(m);
  const activeRole = m => !m.gh && modOn('COMET') && m.sq && m.sq.a && !squadOver(m.sq) &&
    m.sq.u !== 'interrupted' && m.sq.u !== 'declined' ? m.sq : null;

  function showActionOverlay(r) {
    if (!prefs.hpActions || prefs.hpNoPeople || chased === null) {
      if (!actionDock.hidden) actionDock.hidden = true;
      actionFrame = null;
      return;
    }
    const m = liveById.get(chased);
    if (!r.about || !overlayBot(m)) {
      if (!actionDock.hidden) actionDock.hidden = true;
      actionFrame = null;
      return;
    }
    const track = (modOn('COMET') && gestureTrack(r, m.pid, true)) || [];
    const last = lastAt(track, r.at), recent = [];
    for (let i = last; i >= 0 && r.at - track[i].t < GESTURE_MS; i--) {
      if (!recent.some(a => a.name === track[i].name)) recent.push(track[i]);
    }
    const printTime = Math.floor(r.at / 1000) + '/' + lastAt(r.activities.times, r.at) + '/' + recent.map(a => a.t).join(',');
    if (actionFrame && actionFrame.raid === r && actionFrame.next === r.next && actionFrame.m === m &&
        actionFrame.time === printTime && actionFrame.goals === orbitMain && !actionDock.hidden) return;
    actionFrame = { raid: r, next: r.next, m, time: printTime, goals: orbitMain };
    const plans = orbitMain && modOn('ORBIT') ? list(orbitMain.d.s) : [];
    const squad = plans.find(s => list(s.MemberProfileIds).includes(m.pid));
    const memberIds = squad && list(squad.MemberProfileIds);
    const role = activeRole(m), team = teamKey(m);
    const others = live.filter(x => {
      if (x.id === m.id || !overlayBot(x)) return false;
      if (memberIds) return memberIds.includes(x.pid);
      if (plans.some(s => list(s.MemberProfileIds).includes(x.pid))) return false;
      const otherRole = activeRole(x);
      return (role && otherRole && role.p && role.p === otherRole.p) || (team && team === teamKey(x));
    });
    const members = [m, ...others], inSquad = members.length > 1 || !!role;
    const title = inSquad ? T('Squad') : T('Bot');
    const rows = members.map((x, i) => {
      const brain = brainOf(x), q = activeRole(x);
      return { name: latin(x.t || x.c), action: currentAction(x, brain), context: mapContext(x, brain),
        role: q ? squadTactic(q) + ' · ' + squadPart(q) : '',
        moments: i ? [] : recent.map(a => clockText(a.t) + ' · ' + a.name) };
    });
    if (actionDock.hidden) actionDock.hidden = false;
    const objectives = [];
    for (const goal of list(squad?.MainObjectives)) {
      const state = orbitGoalState(goal, squad);
      if (state !== 'active' && state !== 'paused') continue;
      const detail = orbitGoalDetail(goal, state, squad);
      if (!detail) continue;
      objectives.push(orbitGoalName(goal) + ' · ' + (state === 'paused' ? orbitStateNames.paused + ' · ' : '') + detail);
    }
    const print = JSON.stringify([title, rows, objectives]);
    if (print !== actionPrint) {
      actionPrint = print;
      $('actionTitle').textContent = title;
      const body = $('actionRows'); body.replaceChildren();
      for (const objective of objectives) body.appendChild(mk('div', 'actionMember', objective));
      for (const row of rows) {
        const el = mk('div', 'actionMember');
        el.appendChild(mk('strong', '', row.name));
        for (const detail of [row.action, row.context]) if (detail) el.appendChild(mk('small', '', detail));
        if (row.role) el.appendChild(mk('small', 'actionRole', row.role));
        for (const moment of row.moments) el.appendChild(mk('small', 'actionMoment', moment));
        body.appendChild(el);
      }
      placeActionOverlay();
    }
  }
  // the bot followed, when it's one (not a person)
  function whyBot() {
    const m = chased !== null ? liveById.get(chased) : null;
    return m && m.pid && !PEOPLE.includes(m.c) ? m : null;
  }
  function sideWhy(box, r) {
    const bot = whyBot();
    const got = bot ? whyLoad(r, bot.pid) : null, at = r.at;
    // (made again only when something in it changes)
    const last = got ? lastAt(got.ev, at) : -1;
    const brain = bot && brainOf(bot), action = bot && currentAction(bot, brain), context = bot && mapContext(bot, brain);
    const tactic = bot && bot.sq && bot.sq.a && !squadOver(bot.sq) && !['declined', 'interrupted'].includes(bot.sq.u) ? squadSaid(bot.sq) : '';
    const print = [r.about.id, bot && bot.pid, got && got.state, last, action, context, tactic, bot && bot.ly,
      bot && bot.cm, bot && bot.ob, bot && bot.xr, bot && bot.gh, Math.floor(at / 1000)].join('|');
    if (print === whyPrint && box.childElementCount) return;
    whyPrint = print;
    const detailsOpen = box.dataset.pid === (bot && bot.pid) && !!box.querySelector('.whyDetails[open]');
    box.dataset.pid = bot ? bot.pid : '';
    box.textContent = '';
    if (!bot) { sideNone(box, T('Follow a bot (press it on the map or in the list) to see why it does what it does.')); return; }
    const head = mk('div', 'whyHead'), name = mk('b', '', markerText(bot) || bot.t || ONE[bot.c] || bot.c);
    name.style.color = (KINDS[bot.c] || OTHER).col;
    head.append(name, mk('small', '', ONE[bot.c] || bot.c));
    box.appendChild(head);
    const ago = t => at - t < 1000 ? T('just now') : T('{t} ago', { t: clockText(at - t) });
    const line = (label, text, cls, parent = box) => { const row = mk('div', 'whyLine' + (cls ? ' ' + cls : '')); row.append(mk('i', '', label), mk('span', '', text)); parent.appendChild(row); return row; };
    // the latest of a feature (or features) at the moment shown, no older than WHY_SEEN
    const latest = (test, within = WHY_SEEN) => { for (let i = last; i >= 0; i--) { const e = got.ev[i]; if (at - e.t > within) return null; if (test(e.d)) return e; } return null; };
    if (action) box.appendChild(mk('div', 'whyAction', action));
    if (context) line(T('Why'), context);
    if (tactic) line(T('Squad'), tactic);
    // Who owns the sampled action can differ from the last COMET decision.
    const control = whyControl(bot);
    const ctl = !control && got && got.state === 'ok' ? latest(d => d.feature === 'T04' && d.controlJournal, Infinity) : null;
    if (control) {
      const row = line(T('In control'), control);
      if (/^SAIN\s*:\s*(Combat|Squad) Layer$/i.test(bot.ly || '')) row.title = T('SAIN is handling combat. Check the shot events to see when the bot fired.');
    }
    else if (ctl) {
      const c = ctl.d.controlJournal;
      line(T('In control'), (WHY_OWNERS[c.owner] || codeSaid(c.owner)) + (c.layer ? ' · ' + spaced(c.layer) : ''));
    }
    // ORBIT
    if (bot.ob && brain && brain.by !== 'ORBIT') line('ORBIT', bot.ob);
    if (bot.xr && bot.xr !== context) line(T('Leaving'), bot.xr, 'hot');
    if (!got || got.state === 'loading') { box.appendChild(mk('p', 'hpNone', T('Loading…'))); return; }
    if (!got.ev.length) { sideNone(box, got.state === 'error' ? T('Could not load decision details.') : T('No decision details recorded.')); return; }
    const { event: move, choice } = recentMove(got.ev, last, at);
    const d = move && move.d, selected = choice && choice.d;
    const decision = d && (d.decision || (selected && selected.decision));
    if (move) {
      const title = mk('div', 'whyMove' + (d.stage === 'released' ? ' over' : ''));
      title.append(mk('b', '', [phaseName(d), decision && cometMove(decision)].filter(Boolean).join(' · ')), mk('small', '', ago(move.t)));
      rvSection(box, T("COMET's move"));
      box.appendChild(title);
      const reason = moveReason(d) || (d.stage !== 'released' && selected && moveReason(selected));
      if (reason) line(T('Why'), reason);
      const mistake = ((selected || d).mixing || {}).mistake;
      if (mistake && mistake.state === 'mistake-selected') line(T('Note'), T('Picked a worse option on purpose, as its personality allows ({best} was best)', { best: cometMove(mistake.best || '') }), 'hot');
    }
    if (last < 0) return;
    const details = mk('details', 'whyDetails');
    details.appendChild(mk('summary', '', T('Decision details')));
    const fill = () => {
      if (!details.open || details.childElementCount > 1) return;
      if (move) {
        details.appendChild(mk('p', 'winNote', [d.feature, d.stage, d.reason].filter(Boolean).join(' · ')));
        const options = ((selected || d).candidates || []).filter(c => c && c.decision);
        if (options.length) {
          const table = mk('table', 'whyOptions');
          const top = table.createTHead().insertRow();
          for (const [text, cls] of [[T('Option'), ''], [T('Score'), 'num'], [T('Why'), '']]) top.appendChild(mk('th', cls, text));
          const body = table.createTBody();
          for (const c of options.slice().sort((x, y) => (Number.isFinite(y.score) ? y.score : -1e9) - (Number.isFinite(x.score) ? x.score : -1e9))) {
            const row = body.insertRow();
            row.className = (c.decision === decision ? 'on' : '') + (c.eligible ? '' : ' no');
            row.insertCell().textContent = cometMove(c.decision);
            const score = row.insertCell();
            score.className = 'num';
            score.textContent = Number.isFinite(c.score) ? String(Math.round(c.score * 10) / 10) : '–';
            row.insertCell().textContent = c.eligible ? (c.reason && c.reason !== 'available' ? codeSaid(c.reason) : T('Could')) : codeSaid(c.reason || '');
          }
          details.appendChild(table);
        }
      }
      // what else COMET has it doing
      const also = [];
      const med = latest(d => d.feature === 'H01' && d.medicalChoice, 30000);
      if (med) also.push([T('Medical'), cometMove(med.d.medicalChoice.choice || '') + ' · ' + codeSaid(med.d.medicalChoice.reason || med.d.reason)]);
      const reload = latest(d => d.feature === 'W04' && d.quickReload, 30000);
      if (reload) also.push([T('Reload'), codeSaid(reload.d.quickReload.choice || '') + ' · ' + codeSaid(reload.d.quickReload.reason || reload.d.reason)]);
      const search = latest(d => d.feature === 'P09' && d.searchAbandonment, 30000);
      if (search) also.push([T('Searching'), codeSaid(search.d.searchAbandonment.state || '') + ' · ' + codeSaid(search.d.searchAbandonment.reason || search.d.reason)]);
      const squad = latest(d => /^S\d\d$/.test(d.feature) && d.stage === 'evaluated', 30000);
      if (squad) {
        const q = squad.d, part = q.crossfire || q[Object.keys(q).find(k => q[k] && typeof q[k] === 'object' && 'state' in q[k])] || {};
        also.push([T('Squad'), codeSaid(q.decision || q.feature) + (part.state ? ' · ' + codeSaid(part.state) : '') + (part.execution ? ' · ' + part.execution : '') + (q.reason ? ' · ' + codeSaid(q.reason) : '')]);
      }
      const learnt = latest(d => d.feature === 'E04' && d.tacticalOutcome && d.tacticalOutcome.result && !['pending', 'neutral'].includes(d.tacticalOutcome.result), 30000);
      if (learnt) also.push([T('Learnt'), cometMove(learnt.d.tacticalOutcome.action || '') + ' · ' + codeSaid(learnt.d.tacticalOutcome.result)]);
      if (also.length) {
        rvSection(details, T('Also'));
        for (const [label, text] of also) line(label, text, '', details);
      }
      // its moves before: the newest first, each pressed to go there (the same move chosen again and again, as COMET
      // weighs it anew every moment, once: when it was first chosen)
      const before = [];
      for (let i = lastAt(got.choices, at); i >= 0 && before.length < 12; i--) {
        const e = got.choices[i];
        if (before.length && before[before.length - 1].d.decision === e.d.decision) before[before.length - 1] = e;
        else before.push(e);
      }
      if (before.length) {
        rvSection(details, T('Before'));
        const list = mk('div', 'whyBefore');
        for (const e of before) {
          const b = mk('button', '', '');
          b.type = 'button';
          const best = (e.d.candidates || []).find(c => c.decision === e.d.decision);
          b.append(mk('i', '', clockText(e.t)), mk('b', '', cometMove(e.d.decision)), mk('small', '', best && Number.isFinite(best.score) ? String(Math.round(best.score * 10) / 10) : ''));
          b.title = T('Go to this moment on the map');
          b.onclick = () => { seekReplay(e.t); replayShown = ''; showReplay(); whyPrint = ''; };
          list.appendChild(b);
        }
        details.appendChild(list);
      }
      if (details.childElementCount === 1) sideNone(details, T('No decision details recorded.'));
    };
    details.ontoggle = fill;
    details.open = detailsOpen;
    fill();
    box.appendChild(details);
  }

  // Debug panels stay on the page they were opened at while the replay runs. Only the explicit
  // playhead button starts a new archive lookup. Expanding one field builds just its children.
  function cometFields(parent, data) {
    for (const [key, value] of Object.entries(data)) {
      if (value !== null && typeof value === 'object') {
        const group = mk('details', 'cometFields'), count = Object.keys(value).length;
        group.appendChild(mk('summary', '', key + ' (' + count + ')'));
        group.ontoggle = () => {
          if (group.open && group.childElementCount === 1) cometFields(group, value);
        };
        parent.appendChild(group);
      } else {
        const row = mk('div', 'whyLine');
        row.append(mk('i', '', key), mk('span', '', value === '' ? '""' : String(value)));
        parent.appendChild(row);
      }
    }
  }

  function cometButton(label, action) {
    const b = mk('button', '', label);
    b.type = 'button'; b.onclick = action;
    return b;
  }

  function cometEventRow(parent, r, event, names) {
    const d = event.d, time = Math.max(0, event.t - r.lead);
    const fold = mk('details', 'cometDebugRow');
    const stamp = clockText(time) + '.' + String(Math.floor(time % 1000)).padStart(3, '0');
    const heading = mk('summary', '', [stamp, d.feature, d.decision, d.stage, d.name || names.get(event.p)].filter(Boolean).join(' · '));
    fold.appendChild(heading);
    fold.ontoggle = () => {
      if (!fold.open || fold.childElementCount > 1) return;
      if (d.name || d.reason) fold.appendChild(mk('p', 'winNote', [d.name, d.reason].filter(Boolean).join(' · ')));
      fold.appendChild(cometButton(T('Go to this moment on the map'), () => { seekReplay(time); showReplay(); }));
      if (Array.isArray(d.candidates) && d.candidates.length) {
        const table = mk('table', 'whyOptions'), head = table.createTHead().insertRow();
        for (const label of [T('Option'), T('Score'), T('Why')]) head.appendChild(mk('th', '', label));
        const body = table.createTBody();
        for (const c of d.candidates) {
          if (!c || typeof c !== 'object') continue;
          const row = body.insertRow();
          row.className = (c.decision === d.decision ? 'on' : '') + (c.eligible === false ? ' no' : '');
          for (const value of [c.decision, c.score, c.reason]) row.insertCell().textContent = value ?? '';
        }
        fold.appendChild(table);
      }
      cometFields(fold, d);
    };
    parent.appendChild(fold);
  }

  const reportNames = { T01: T('Combat journal'), T02: T('Decision counters'), T03: T('Weapon journal'), T04: T('Control transitions') };
  function cometReports(parent, events) {
    const groups = new Map();
    for (const { d } of events) {
      const page = d.tacticCounters || d.journalReport;
      if (!reportNames[d.feature] || !page || !d.session) continue;
      const key = d.session + '|' + d.feature;
      if (!groups.has(key)) groups.set(key, { code: d.feature, pages: [] });
      groups.get(key).pages.push({ data: d, page });
    }
    if (!groups.size) { sideNone(parent, T('No COMET reports were recorded.')); return; }
    const present = new Set([...groups.values()].map(g => g.code));
    for (const code of Object.keys(reportNames)) if (!present.has(code))
      sideNone(parent, code + ' · ' + reportNames[code] + ' · ' + T('No COMET reports were recorded.'));
    for (const { code, pages } of [...groups.values()].sort((a, b) => a.code.localeCompare(b.code))) {
      pages.sort((a, b) => a.page.part - b.page.part);
      const header = pages.find(p => p.page.part === 0)?.page;
      const expected = header?.parts ?? pages[0].page.parts;
      const valid = new Map();
      for (const { page } of pages) if (Number.isInteger(page.part) && page.part >= 0 && page.part < expected &&
        page.parts === expected && !valid.has(page.part)) valid.set(page.part, page);
      const complete = header && Number.isInteger(expected) && expected > 0 && valid.size === expected &&
        pages.every(({ page }) => page.version === 1 && page.parts === expected && Number.isInteger(page.part) &&
          page.part >= 0 && page.part < expected && page.complete === true);
      const fold = mk('details', 'cometDebugRow');
      fold.appendChild(mk('summary', '', code + ' · ' + reportNames[code] + ' · ' + valid.size + '/' + (expected ?? '?') +
        ' · ' + (header?.enabled === false ? T('Off') : complete ? T('Complete') : T('Partial'))));
      fold.ontoggle = () => {
        if (!fold.open || fold.childElementCount > 1) return;
        if (valid.size !== expected || !header) fold.appendChild(mk('p', 'winNote', T('Some report pages are missing.')));
        if (header) {
          const counters = {};
          for (const field of ['recordedOpportunities', 'queueDropped', 'capacitySkipped', 'invalidEvents', 'omittedEvents', 'oversizeEvents', 'observationGaps'])
            if (header[field] > 0) counters[codeSaid(field)] = header[field];
          cometFields(fold, counters);
        }
        const records = [...valid.values()].flatMap(p => list(p.rows)).filter(row => row && typeof row === 'object');
        const listBox = mk('div', 'cometReportRows');
        if (records.length > 1) {
          const search = mk('input');
          search.type = 'search'; search.placeholder = T('Search'); search.setAttribute('aria-label', reportNames[code] + ' · ' + search.placeholder);
          search.oninput = () => {
            const term = search.value.trim().toLowerCase();
            for (const item of listBox.children) item.hidden = !item.firstChild.textContent.toLowerCase().includes(term);
          };
          fold.appendChild(search);
        }
        fold.appendChild(listBox);
        for (const row of records) {
          const entry = mk('details', 'cometFields');
          entry.appendChild(mk('summary', '', [row.name || row.feature || row.profileId, row.decision || row.action || row.owner, row.personality].filter(Boolean).join(' · ') || T('Details')));
          entry.ontoggle = () => { if (entry.open && entry.childElementCount === 1) cometFields(entry, row); };
          listBox.appendChild(entry);
        }
        const original = mk('details', 'cometFields');
        original.appendChild(mk('summary', '', T('Recorded pages')));
        original.ontoggle = () => {
          if (original.open && original.childElementCount === 1) cometFields(original, pages.map(p => p.data));
        };
        fold.appendChild(original);
      };
      parent.appendChild(fold);
    }
  }

  function sideCometDebug(box, r) { cometInspector(box, r, false); }
  function sideCometReports(box, r) { cometInspector(box, r, true); }
  function cometInspector(box, r, reports) {
    const bot = whyBot(), pid = reports ? '' : bot?.pid || '';
    const key = r.about.id + '|' + pid;
    if (box.cometInspector?.key === key) return;
    box.cometInspector?.abort(); box.replaceChildren();
    const state = { key, controller: null, abort: () => state.controller?.abort() };
    box.cometInspector = state;
    const nav = mk('div', 'cometDebugTools'), results = mk('div', 'cometDebugResults');
    const text = mk('input'), scope = mk('input');
    const search = mk('form', 'cometDebugTools');
    let from = 0, cursor = 0, previous = [], term = '';
    function reset(at) { from = at; cursor = 0; previous = []; term = text.value.trim(); load(); }
    if (!reports) {
      text.type = 'search'; text.maxLength = 80; text.placeholder = T('Bot, feature, stage or reason');
      text.setAttribute('aria-label', text.placeholder);
      const submit = mk('button', '', T('Search')); submit.type = 'submit';
      search.append(text, submit);
      search.onsubmit = ev => { ev.preventDefault(); reset(0); };
      if (pid) {
        const label = mk('label', 'row'); scope.type = 'checkbox'; scope.checked = true;
        label.append(scope, mk('span', '', bot.t || pid)); scope.onchange = () => reset(from);
        nav.appendChild(label);
      }
      nav.append(cometButton(T('From playhead'), () => reset(r.at + r.lead)), cometButton(T('From raid start'), () => reset(0)));
      box.append(search, nav);
    }
    box.appendChild(results);
    async function load() {
      state.abort();
      const controller = state.controller = new AbortController();
      const params = new URLSearchParams({ id: r.about.id, debug: '1' });
      if (reports) params.set('sum', '1');
      else {
        if (scope.checked) params.set('p', pid);
        if (term) params.set('filter', term);
        if (from) params.set('at', from);
        if (cursor) params.set('cursor', cursor);
      }
      results.replaceChildren(mk('p', 'winNote', T('Loading…')));
      try {
        const response = await fetch('api/history/comet?' + params, { signal: controller.signal });
        if (!response.ok) throw new Error(String(response.status));
        const page = await response.json();
        if (controller.signal.aborted || box.cometInspector !== state || replay !== r) return;
        results.replaceChildren();
        if (page.partial || page.unresolved || page.malformed) sideNone(results, T('Some recorded data could not be read.'));
        const rows = list(page.ev);
        if (reports) cometReports(results, rows);
        else {
          if (!rows.length) sideNone(results, T('No matching COMET events.'));
          const names = new Map();
          for (const track of scanReplay(r).tracks.values()) if (track.pid) names.set(track.pid, track.name);
          for (const row of rows) cometEventRow(results, r, row, names);
          if (previous.length || page.next != null) {
            const pages = mk('div', 'cometDebugTools');
            if (previous.length) pages.appendChild(cometButton('← ' + T('Previous'), () => { cursor = previous.pop(); load(); }));
            if (page.next != null) pages.appendChild(cometButton(T('Next') + ' →', () => { previous.push(cursor); cursor = page.next; load(); }));
            results.appendChild(pages);
          }
        }
        if (reports && !rows.length || !reports && (!rows.length || rows.every(e => e.d.schema == null)))
          results.appendChild(mk('p', 'winNote', T('For full diagnostics, enable COMET Extended replay data and Satellite history.cometDebug before recording.')));
      } catch (err) {
        if (controller.signal.aborted || box.cometInspector !== state) return;
        results.replaceChildren(cometButton(T('Retry'), load));
      }
    }
    load();
  }

  function sideInv(box, r, s) {
    box.textContent = '';
    const loot = things;
    const priceOf = tpl => loot && (loot.names[tpl] || {}).p || 0, nameOf = tpl => loot && ((loot.names[tpl] || {}).s || (loot.names[tpl] || {}).n) || tpl;
    const worth = (items, side) => (items || []).reduce((n, i) => n + (cantLoot(loot.names, i, side) ? 0 : priceOf(i[0]) * (i[1] || 1)), 0);
    const byPid = new Map();
    for (const [id, t] of s.tracks) if (t.pid) byPid.set(t.pid, [id, t]);
    const holders = [];
    if (loot) {
      for (const pid of Object.keys(loot.carried)) {
        const found = byPid.get(pid);
        if (found && !PEOPLE.includes(found[1].c)) holders.push({ pid, id: found[0], t: found[1], items: loot.carried[pid] || [], dead: false });
      }
      // (the dead: their bodies, by whose they were)
      for (const b of loot.bodies) {
        const found = b.pid ? byPid.get(b.pid) : null, items = loot.inside[b.id];
        if (found && items && items.length && !PEOPLE.includes(found[1].c) && !holders.some(h => h.pid === b.pid)) holders.push({ pid: b.pid, id: found[0], t: found[1], items, dead: true });
      }
    }
    for (const h of holders) h.total = worth(h.items, h.t.sd);
    holders.sort((x, y) => y.total - x.total);
    sideCount(box, holders.length);
    if (!holders.length) { sideNone(box, loot ? T('No bot\'s gear was recorded by this moment: it\'s kept about once a minute.') : T('This recording has no inventories (it was made before they were kept, or loot is switched off on the server).')); return; }
    const listEl = mk('div', 'invList');
    for (const h of holders) {
      const open = rvLoot.who === h.pid, row = mk('button', 'invRow' + (open ? ' open' : '') + (h.dead ? ' dead' : '')), dot = mk('i');
      row.type = 'button';
      dot.style.background = (KINDS[h.t.c] || OTHER).col;
      const name = mk('span', 'invName', h.t.name || ONE[h.t.c] || h.t.c);
      name.appendChild(mk('small', '', (ONE[h.t.c] || h.t.c) + (h.dead ? ' · ' + T('dead') : '')));
      const value = mk('b', '', shortWorth(h.total) + ' ₽');
      value.style.color = worthCol(h.total);
      row.append(dot, name, value, mk('em', '', open ? '▴' : '▾'));
      row.title = open ? T('Put the list away') : T('What it wears and carries');
      row.onclick = () => { rvLoot.who = open ? '' : h.pid; sideInv(box, r, s); };
      listEl.appendChild(row);
      if (!open) continue;
      const gear = mk('div', 'invGear');
      const items = h.items.filter(i => i[2] !== 'SecuredContainer' || prefs.secureShown).sort((x, y) => (y[2] ? 1 : 0) - (x[2] ? 1 : 0) || priceOf(y[0]) * (y[1] || 1) - priceOf(x[0]) * (x[1] || 1));
      for (const i of items) {
        // (what can't be looted: listed, faint, and not counted)
        const slot = WORN.find(w => w[0] === i[2]), no = cantLoot(loot.names, i, h.t.sd), line = mk('div', 'invItem' + (no ? ' noLoot' : '')), v = no ? 0 : priceOf(i[0]) * (i[1] || 1);
        line.append(mk('i', '', slot ? slot[1] : i[2] ? spaced(i[2]) : ''), mk('span', '', nameOf(i[0]) + (i[1] > 1 ? ' ×' + i[1] : '')), mk('em', '', no ? T('can\'t be looted') : v ? roubles(v) : ''));
        line.lastChild.style.color = v ? worthCol(v) : '';
        gear.appendChild(line);
      }
      const follow = mk('button', 'linkBtn', T('Follow on the map'));
      follow.type = 'button';
      follow.onclick = () => { const m = liveById.get(h.id); if (m) watch(m); };
      if (!h.dead) gear.appendChild(follow);
      listEl.appendChild(gear);
    }
    box.appendChild(listEl);
  }

  // ---- the recordings' upkeep: this raid, all of them, and the raids Raid Review left behind ----
  let historyInfo = { bytes: 0, keep: 30, mb: 0, per: 'all', held: new Set(), rr: false }, rrRaids = null, rrBusy = false;
  const bytesSaid = n => n >= 1 << 30 ? (n / (1 << 30)).toFixed(1) + ' GB' : n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' kB';
  const twice = (b, act) => { b.type = 'button'; b.onclick = () => { if (!b.classList.contains('sure')) { b.classList.add('sure'); b.dataset.was = b.textContent; b.textContent = T('Press again to be sure'); setTimeout(() => { b.classList.remove('sure'); b.textContent = b.dataset.was; }, 3500); return; } b.classList.remove('sure'); b.textContent = b.dataset.was; act(); }; return b; };
  async function loadRr() {
    try { const j = await (await fetch('api/history/rr')).json(); rrRaids = j && j.found ? list(j.raids) : []; } catch (e) { rrRaids = []; }
    showWins();
  }
  async function importRr(id) {
    if (rrBusy) return;
    rrBusy = true;
    showWins();
    try { await fetch('api/history/rr/import?id=' + encodeURIComponent(id), { method: 'POST' }); } catch (e) { /* listed again all the same */ }
    rrBusy = false;
    await loadHistory();
    loadRr();
  }
  // Trimming the recordings: every raid that matches any of the ticked (the player's own: no kills, died, ran
  // through, ended abruptly, short) deleted at once, after a second press. A raid holding a record stays unless asked,
  // and the one being recorded always does. What's ticked stays while the page is open (rvTrim).
  const rvTrim = { noKills: false, died: false, runner: false, abrupt: false, short: false, scan: false, keepHeld: true };
  const TRIM_SHORT = 5 * 60000;
  const mbSaid = b => b < 0.05 * 1048576 ? '<0.1 MB' : (b / 1048576).toFixed(b < 10 * 1048576 ? 1 : 0) + ' MB';
  const raidDied = a => !!a.died || a.exit === 'Killed' || a.exit === 'MissingInAction';
  function trimmed(a) {
    if (a.live || (rvTrim.keepHeld && historyInfo.held.has(a.id))) return false;
    return (rvTrim.noKills && a.mine === 0) || (rvTrim.died && raidDied(a)) || (rvTrim.runner && a.exit === 'Runner')
      || (rvTrim.abrupt && !a.exit && !a.died) || (rvTrim.short && (a.ms || 0) < TRIM_SHORT) || (rvTrim.scan && isScan(a));
  }
  function trimTools(box) {
    rvSection(box, T('Trim recordings'));
    box.appendChild(mk('p', 'winNote', T('Delete every raid that matches any of these at once. The raid being recorded is never deleted.')));
    const form = mk('div', 'trimForm'), said = mk('p', 'winNote'), tools = mk('div', 'winTools');
    let go = null;
    const update = () => {
      const hit = (historyRaids || []).filter(trimmed), size = hit.reduce((n, a) => n + (a.size || 0), 0);
      said.textContent = hit.length ? TP(hit.length, '{n} raid matches', '{n} raids match') + (size ? ' · ' + mbSaid(size) : '') : T('No raid matches.');
      tools.textContent = '';
      if (!hit.length) return;
      go = twice(mk('button', 'danger', TP(hit.length, 'Delete {n} raid', 'Delete {n} raids')), async () => {
        go.disabled = true;
        for (const a of hit) {
          try { await fetch('api/history/delete?id=' + encodeURIComponent(a.id), { method: 'POST' }); } catch (e) { /* listed again all the same */ }
          if (replay && replay.about && replay.about.id === a.id) leaveReplay();
        }
        loadHistory();
      });
      tools.appendChild(go);
    };
    for (const [key, label, tip] of [['noKills', T('I got no kills'), T('Raids where you killed nobody')], ['died', T('I died'), T('Raids you were killed in, or went missing in')],
      ['runner', T('Run-through'), T('Raids that ended as a run-through')], ['abrupt', T('Ended abruptly'), T('Raids whose end wasn\'t recorded: the game was closed or crashed first')],
      ['short', T('Shorter than 5 minutes'), T('Raids that lasted less than 5 minutes')], ['scan', T('Map scanner runs'), T('The map scanner\'s own runs, which end as “Map scan”')], ['keepHeld', T('Keep raids that hold a record (★)'), T('A raid holding one of the records stays, whatever else it matches')]]) {
      const row = mk('label', 'row'), tick = mk('input');
      tick.type = 'checkbox';
      tick.checked = rvTrim[key];
      tick.onchange = () => { rvTrim[key] = tick.checked; update(); };
      row.title = tip;
      row.append(tick, mk('span', '', label));
      if (key === 'keepHeld') row.classList.add('keepHeld');
      form.appendChild(row);
    }
    box.append(form, said, tools);
    update();
  }
  // Every raid kept, with what it takes on the disk, in the order picked: a press on a column's head sorts by it
  // (pressed again: the other way). Each can be deleted on its own (pressed twice).
  const rvOrder = { key: 'began', down: true };
  const RV_SORTS = {
    loc: a => placeName(a.loc), began: a => a.began || 0, out: a => outcomeOf(a).text, mine: a => a.mine !== undefined ? a.mine : -1,
    ms: a => a.ms || 0, size: a => a.size || 0
  };
  function everyRaid(box) {
    const raids = (historyRaids || []).slice();
    if (!raids.length) return;
    rvSection(box, T('Every raid'));
    const by = RV_SORTS[rvOrder.key] || RV_SORTS.began;
    raids.sort((x, y) => {
      const p = by(x), q = by(y), d = typeof p === 'string' ? p.localeCompare(q) : p - q;
      return (rvOrder.down ? -d : d) || (y.began || 0) - (x.began || 0);
    });
    const table = mk('table', 'board sizes');
    const top = table.createTHead().insertRow();
    for (const [key, text, cls] of [['loc', T('Map'), ''], ['began', T('When'), ''], ['out', T('How it ended'), ''], ['mine', T('Kills'), 'num'], ['ms', T('Length'), 'num'], ['size', T('Size'), 'num'], ['', '', '']]) {
      const th = mk('th', cls);
      if (key) {
        const b = mk('button', 'sortBtn' + (rvOrder.key === key ? ' on' : ''), text + (rvOrder.key === key ? (rvOrder.down ? ' ▾' : ' ▴') : ''));
        b.type = 'button';
        b.title = T('Sort by this (again: the other way)');
        // (words A to Z first; numbers and dates the biggest and newest first)
        b.onclick = () => { if (rvOrder.key === key) rvOrder.down = !rvOrder.down; else { rvOrder.key = key; rvOrder.down = key !== 'loc' && key !== 'out'; } showWins(); };
        th.appendChild(b);
      }
      top.appendChild(th);
    }
    const body = table.createTBody();
    for (const a of raids) {
      const row = body.insertRow(), out = outcomeOf(a);
      row.insertCell().textContent = placeName(a.loc) + (historyInfo.held.has(a.id) ? ' ★' : '');
      row.insertCell().textContent = a.began ? new Date(a.began).toLocaleString(document.documentElement.lang || undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
      const ended = row.insertCell();
      ended.textContent = out.text;
      ended.className = 'out ' + (out.cls || '');
      const kills = row.insertCell();
      kills.className = 'num';
      kills.textContent = a.mine !== undefined ? String(a.mine) : '';
      const len = row.insertCell();
      len.className = 'num';
      len.textContent = clockText(a.ms || 0);
      const size = row.insertCell();
      size.className = 'num';
      size.textContent = a.size ? mbSaid(a.size) : '';
      const act = row.insertCell();
      if (!a.live) {
        act.appendChild(twice(mk('button', 'linkBtn danger', T('Delete')), async () => {
          try { await fetch('api/history/delete?id=' + encodeURIComponent(a.id), { method: 'POST' }); } catch (e) { /* listed again all the same */ }
          if (replay && replay.about && replay.about.id === a.id) leaveReplay();
          loadHistory();
        }));
      }
    }
    box.appendChild(table);
  }
  function upkeep(box) {
    rvSection(box, T('All recordings'));
    const n = (historyRaids || []).length;
    box.appendChild(mk('p', 'winNote', TP(n, '{n} raid kept', '{n} raids kept') + ' · ' + bytesSaid(historyInfo.bytes)));
    // recording on or stopped (as the live map's REC button; on a phone, only here)
    if (historyOn) {
      const rec = mk('p', 'winNote', (recState.paused ? T('Recording is stopped.') : T('Raids are recorded.')) + ' ');
      const flip = mk('button', 'linkBtn', recState.paused ? T('Start recording') : T('Stop recording'));
      flip.type = 'button';
      flip.onclick = () => askRec(!recState.paused);
      rec.appendChild(flip);
      box.appendChild(rec);
    }
    // what's kept: the newest so many raids and/or so much on the disk, for every raid together or each player's own;
    // the oldest go first. Never deleted to make room: a raid holding a record (until it's beaten), imported raids.
    rvSection(box, T('What\'s kept'));
    const form = mk('div', 'winTools keepForm');
    const field = (label, value, tip, unit) => {
      const l = mk('label', 'keepField'), input = mk('input');
      input.type = 'number';
      input.min = '0';
      input.value = String(value || 0);
      l.title = tip;
      l.append(mk('span', '', label), input, mk('small', '', unit));
      form.appendChild(l);
      return input;
    };
    const keepIn = field(T('Raids'), historyInfo.keep, T('The newest this many raids are kept; older ones are deleted. 0: no limit.'), T('newest (0: no limit)'));
    const mbIn = field(T('Size on disk'), historyInfo.mb, T('The oldest raids are deleted while the history takes more than this. 0: no limit.'), T('MB (0: no limit)'));
    const per = mk('span', 'seg recPer');
    let perV = historyInfo.per;
    for (const [v, label, tip] of [['all', T('For everyone'), T('The limits are for every raid together')], ['player', T('For each player'), T('Each player\'s raids have the limits to themselves (in a Fika raid every friend\'s game records too)')]]) {
      const b = mk('button', perV === v ? 'on' : '', label);
      b.type = 'button';
      b.title = tip;
      b.onclick = () => { perV = v; for (const x of per.children) x.classList.toggle('on', x === b); };
      per.appendChild(b);
    }
    form.appendChild(per);
    const saveB = mk('button', '', T('Save'));
    saveB.type = 'button';
    saveB.onclick = async () => {
      const keep = Math.max(0, Math.round(+keepIn.value || 0)), mb = Math.max(0, Math.round(+mbIn.value || 0));
      saveB.disabled = true;
      try { await fetch('api/history/keep?keep=' + keep + '&mb=' + mb + '&per=' + perV, { method: 'POST' }); } catch (e) { /* listed again all the same */ }
      saveB.disabled = false;
      loadHistory();
    };
    form.appendChild(saveB);
    box.appendChild(form);
    box.appendChild(mk('p', 'winNote', T('A raid that holds one of the records (★ in the list) is kept until another raid beats it, and imported raids are never deleted to make room.')));
    const row = mk('div', 'winTools');
    row.appendChild(twice(mk('button', 'danger', T('Delete all recordings')), async () => {
      try { await fetch('api/history/deleteAll', { method: 'POST' }); } catch (e) { /* listed again all the same */ }
      leaveReplay();
      loadHistory();
    }));
    const tidy = mk('button', '', T('Delete temporary files'));
    tidy.type = 'button';
    tidy.title = T('Files a stopped import, export or recording left behind.');
    tidy.onclick = async () => {
      let done = null;
      try { done = await (await fetch('api/history/tidy', { method: 'POST' })).json(); } catch (e) { /* said below */ }
      tidy.textContent = done && done.ok ? TP(done.n, '{n} file deleted', '{n} files deleted') : T('Couldn\'t do that');
      loadHistory();
    };
    row.appendChild(tidy);
    box.appendChild(row);
    trimTools(box);
    everyRaid(box);
    if (!historyInfo.rr) return;
    rvSection(box, T('Raids from Raid Review'));
    if (rrRaids === null) { box.appendChild(mk('p', 'winNote', T('Loading…'))); loadRr(); return; }
    const todo = rrRaids.filter(x => !x.have);
    box.appendChild(mk('p', 'winNote', T('Raid Review is installed beside Satellite and has raids of its own. Imported, they play here like any other; Raid Review\'s own files are left as they are.')));
    // (every one already here: said so, the button greyed)
    const tools = mk('div', 'winTools'), all = mk('button', '', rrBusy ? T('Importing…') : todo.length ? TP(todo.length, 'Import {n} raid', 'Import all {n} raids') : T('No raids to import'));
    all.type = 'button';
    all.disabled = rrBusy || !todo.length;
    all.onclick = () => importRr('all');
    tools.appendChild(all);
    box.appendChild(tools);
    const table = mk('table', 'board');
    for (const x of rrRaids) {
      const row2 = table.insertRow();
      row2.insertCell().textContent = placeName(x.loc);
      row2.insertCell().textContent = x.began ? new Date(x.began).toLocaleString(document.documentElement.lang || undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
      row2.insertCell().textContent = clockText(x.ms || 0);
      const cell = row2.insertCell();
      if (x.have) cell.textContent = T('imported');
      else {
        const b = mk('button', 'linkBtn', T('Import'));
        b.type = 'button';
        b.disabled = rrBusy;
        b.onclick = () => importRr(x.rid);
        cell.appendChild(b);
        if (!x.pos) cell.appendChild(mk('small', 'dim', ' ' + T('(no positions: events only)')));
      }
    }
    box.appendChild(table);
  }

  // ---- the map's key, in a replay: over the Raid list down the left, as Raid Review's legend: who is on the map now
  // by kind and by team, and what the marks mean ----
  let keyPrint = '';
  function showKey() {
    if (!HIST || !replay || hp.tab !== 'map' || $('side').hidden) { keyPrint = ''; return; }
    const home = $('sideBody');
    if (home.firstChild !== hpLegend) home.prepend(hpLegend);
    const box = $('hpLegendBody');
    const here = live.filter(m => m.dyn && m.c !== 'Corpse' && m.c !== 'BTR' && m.c !== 'Airdrop');
    const print = here.map(m => m.id + (m.g || '')).join(',');
    if (print === keyPrint) return;
    keyPrint = print;
    box.textContent = '';
    // (who's on the map, by kind and by team, the Raid list under it says: here only what the marks mean)
    for (const [cls, label] of [['kKill', T('Somebody died here')], ['kHit', T('Hit by a bullet')], ['kBlast', T('A grenade went off')], ['kDown', T('Down, can be got up')],
      ['kSwitch', T('Switch (green: on)')], ['kGoal', T('ORBIT squad objective')], ['kGhost', T('Parked by ORBIT as a ghost')]]) {
      const row = mk('div', 'keyRow');
      row.append(mk('i', 'mark ' + cls), mk('span', '', label));
      box.appendChild(row);
    }
  }

  $('replayMini').onclick = () => { prefs.minimap = prefs.minimap === false; $('optMinimap').checked = prefs.minimap; save(); replayShown = ''; showReplay(); dirty = true; };
  winsReady = true;

  // ---- what a raid has beyond its markers: switches, hits, what ORBIT's squads are out to do ----
  // Each comes as an event (see Recorded in the game's plugin), live and in a replay.
  //   switchNow: every switch as it stands, by its id (the latest "switch" event of each)
  //   orbitMain, orbitField: ORBIT's latest snapshot of each ("s": as ORBIT gives it, places as the game's x, y, z)
  let switchNow = new Map(), orbitMain = null, orbitField = null, phobosField = null, hitFlashes = [], magNow = new Map();
  // COMET's magazine stages, as said (Raid Review's words)
  const MAG_SAID = { queued: T('Magazine dropped in a quick reload'), started: T('Going back for a dropped magazine'), arrived: T('Getting ready to pick up a magazine'),
    'pickup-wait': T('Getting ready to pick up a magazine'), 'pickup-started': T('Picking up a magazine'), 'pickup-ready': T('Picking up a magazine'),
    completed: T('Magazine picked up'), failed: T('Couldn\'t pick the magazine up'), interrupted: T('Going back for the magazine was cut short'), unavailable: T('The magazine was gone') };
  const MAG_ACTIVE = ['started', 'arrived', 'pickup-wait', 'pickup-started', 'pickup-ready'];
  // The magazines lying where they were dropped (gone once picked up, or gone), live and in a replay: a small
  // magazine, amber, with a ring while a bot is on its way to it. Pointed at: whose, and what's happening to it.
  function drawMags(scale) {
    if (!magNow.size || prefs.hpNoEvents && replay) return;
    ctx.save();
    for (const e of magNow.values()) {
      const d = e.d;
      if (!Array.isArray(d.at) || d.st === 'completed' || d.st === 'unavailable' || offFloor(d.at[0], d.at[1], d.at[2])) continue;
      const s = toScreen(d.at[0], d.at[1]), w = 5 * scale, h = 9 * scale;
      if (s[0] < -20 || s[1] < -20 || s[0] > vw + 20 || s[1] > vh + 20) continue;
      ctx.save();
      ctx.translate(s[0], s[1]);
      ctx.rotate(-0.35);
      ctx.fillStyle = '#e0a63a';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1.4 * scale;
      ctx.beginPath();
      ctx.rect(-w / 2, -h / 2, w, h);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      if (MAG_ACTIVE.includes(d.st)) {
        ctx.beginPath();
        ctx.arc(s[0], s[1], 9 * scale, 0, Math.PI * 2);
        ctx.setLineDash([3 * scale, 3 * scale]);
        ctx.lineWidth = 1.6 * scale;
        ctx.strokeStyle = '#ffd27a';
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ctx.restore();
  }
  const HIT_MS = 450;
  function drawHits(scale) {
    if (!hitFlashes.length) return;
    const now = performance.now();
    hitFlashes = hitFlashes.filter(h => now - h.at < HIT_MS);
    if (prefs.hitFlash === false) { hitFlashes = []; return; }
    ctx.save();
    for (const h of hitFlashes) {
      const m = liveById.get(h.id);
      if (!m || !Number.isFinite(m.cx) || isHidden(m.c) || inArea(m) || offFloor(m.cx, m.cy, m.cz)) continue;
      const k = (now - h.at) / HIT_MS, s = toScreen(m.cx, m.cy);
      ctx.globalAlpha = 1 - k;
      ctx.beginPath();
      ctx.arc(s[0], s[1], (9 + 13 * k) * scale, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 60, 48, 0.35)';
      ctx.fill();
      ctx.lineWidth = 2.5 * scale;
      ctx.strokeStyle = '#ff3b30';
      ctx.stroke();
    }
    ctx.restore();
    if (hitFlashes.length) dirty = true;
  }
  function drawSwitches(scale) {
    if (prefs.switches === false || !switchNow.size || isHidden('Layer switches')) return;
    // the ones the map's places have are drawn with them (see drawThings); these are the rest, from a map whose
    // places were sent before switches were
    const listed = places && map && sameMap(places.loc, map.loc) && places.switches.length ? new Set(places.switches.map(w => w.id)) : null;
    const r = 5.5 * scale;
    for (const e of switchNow.values()) {
      if ((listed && listed.has(e.d.id)) || NOT_A_SWITCH.test(e.d.nm || '')) continue;
      if (!prefs.lightSwitches && LIGHT_SWITCH.test((e.d.id || '') + ' ' + (e.d.nm || ''))) continue;
      const at = e.d.at;
      if (!Array.isArray(at) || offFloor(at[0], at[1], at[2])) continue;
      const s = toScreen(at[0], at[1]);
      if (s[0] < -20 || s[1] < -20 || s[0] > vw + 20 || s[1] > vh + 20) continue;
      const on = e.d.st === 'Open';
      ctx.save();
      ctx.globalAlpha = otherFloor(at[0], at[1], at[2]) !== 0 ? 0.45 : 1;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(s[0] - r, s[1] - r, r * 2, r * 2, r * 0.45); else ctx.rect(s[0] - r, s[1] - r, r * 2, r * 2);
      ctx.fillStyle = on ? '#3ddc5a' : '#59606e';
      ctx.fill();
      ctx.lineWidth = 1.6 * scale;
      ctx.strokeStyle = '#000';
      ctx.stroke();
      // its lever: up once switched
      ctx.beginPath();
      ctx.moveTo(s[0], s[1] + (on ? r * 0.5 : -r * 0.5));
      ctx.lineTo(s[0], s[1] + (on ? -r * 0.55 : r * 0.55));
      ctx.lineCap = 'round';
      ctx.lineWidth = 2 * scale;
      ctx.strokeStyle = on ? '#0c0c12' : '#e5e6ec';
      ctx.stroke();
      ctx.restore();
      thingsDrawn.push({ x: s[0], y: s[1], r: r + 3, tip: { title: T('Switch') + (e.d.nm ? ' · ' + String(e.d.nm).replace(/[_]+/g, ' ').slice(0, 40) : ''),
        lines: [on ? T('Switched on') : T('Not switched'), e.t ? raidClock(e.t) : ''] } });
    }
  }
  // ORBIT objectives and the individual points of a rush share the squad's recorded progress.
  const ORBIT_LETTER = { Kills: 'K', LootValue: 'L', Quest: 'Q' };
  // Snapshot-local membership. ORBIT's squad id and the native game group are separate identifiers.
  let indexedOrbitMain, orbitByMember = new Map(), orbitReceivedAt = 0;
  function orbitSquadOf(pid) {
    if (!pid || !orbitMain || !modOn('ORBIT')) return null;
    if (indexedOrbitMain !== orbitMain) {
      indexedOrbitMain = orbitMain;
      orbitByMember.clear();
      for (const squad of list(orbitMain.d.s)) for (const member of list(squad.MemberProfileIds)) {
        if (orbitByMember.has(member) && orbitByMember.get(member) !== squad) orbitByMember.set(member, null);
        else orbitByMember.set(member, squad);
      }
    }
    return orbitByMember.get(pid) || null;
  }
  const activeOrbitStages = new Set(['approach', 'holding', 'searching cover', 'planning route', 'entering room',
    'returning to room', 'opening door', 'unlocking door', 'looting', 'searching', 'interacting', 'extracting',
    'waiting', 'loot', 'approaching camp cover', 'camping', 'finding camp cover', 'looting area', 'returning to camp',
    'approaching site', 'leaving post', 'looting own kill', 'returning to post', 'surveying another post',
    'surveying corrected site', 'surveying post', 'waiting for transfer']);
  function orbitGoalState(o, squad) {
    const stage = String(o.OperationState || o.CampState || o.AirdropStage || '').toLowerCase();
    if (/^(failed|aborted|cancelled)(?:\b|:)/.test(stage)) return 'failed';
    if (o.Completed) return 'done';
    if (stage === 'paused' || o.LootValueInterrupted) return 'paused';
    if (activeOrbitStages.has(stage) || o.CampHolding || o.Type === 'LootValue' && o.LootValueEnteredAt > 0 ||
        o.Type === 'Kills' && !o.KillAmbush && o.KillsRoamStartedAt > 0) return 'active';
    // A recorded Quest order has only a destination. Match its rounded coordinates to a unique quest in this squad.
    if (squad && o.Type === 'Quest' && Number.isFinite(o.X) && Number.isFinite(o.Z)) {
      const near = (x, z) => Math.abs(x - o.X) <= .26 && Math.abs(z - o.Z) <= .26;
      const member = live.find(m => m.c !== 'Corpse' && (!m.os || m.os === 'ORBIT') && orbitSquadOf(m.pid) === squad &&
        m.ob === 'Quest (Moving)' && Array.isArray(m.og) && near(m.og[0], m.og[1]) &&
        (!Number.isFinite(m.og[2]) || !Number.isFinite(o.Y) || Math.abs(m.og[2] - o.Y) <= .26) &&
        (m.gh || /^orbit/i.test(m.ly || '')));
      if (member && !list(squad.MainObjectives).some(g => g !== o && g?.Type === 'Quest' && !g.Completed && near(g.X, g.Z)))
        return 'active';
    }
    return 'planned';
  }
  const orbitStateNames = { active: T('In progress'), paused: T('Paused'), done: T('Done'), failed: T('Failed'), planned: T('Planned') };
  const orbitStateColors = { active: '#65dec4', paused: '#f5bd62', done: '#94aa9d', failed: '#ef8982', planned: '#8db8e0' };
  function orbitStepCount(o) {
    return o.OperationStepIndex > 0 && o.OperationStepCount > 0 ? ' ' + o.OperationStepIndex + '/' + o.OperationStepCount : '';
  }
  function huntKey(squad, goal) {
    return [squad.SquadId, goal.X, goal.Z, goal.Y, goal.KillsRoamStartedAt].join('/');
  }
  function orbitGoalDetail(o, state, squad) {
    if (o.Type === 'LootValue' && Number.isFinite(o.LootValueTotal)) return roubles(o.LootValueTotal);
    if (state === 'done' || state === 'failed') return '';
    const at = replay ? replay.mainTimes.get(orbitMain?.n) : orbitReceivedAt;
    const age = at == null ? 0 : Math.max(0, ((replay ? replay.at : performance.now()) - at) / 1000);
    let remaining, approximate = false;
    if (state === 'active' || state === 'paused') {
      if (o.CampUntilTimeExtract && Number.isFinite(o.CampExtractRemainingSeconds))
        remaining = o.CampExtractRemainingSeconds - age;
      else if (o.CampTargetDuration > 0 && Number.isFinite(o.CampElapsed) && (o.CampHolding || state === 'paused'))
        remaining = o.CampTargetDuration - o.CampElapsed - (state === 'active' && o.CampHolding ? age : 0);
      else if (o.Type === 'Kills' && !o.KillAmbush && o.KillsRoamStartedAt > 0) {
        if (Number.isFinite(o.KillsRoamRemainingSeconds))
          remaining = o.KillsRoamRemainingSeconds - (o.KillsRoamTimerRunning ? age : 0);
        else if (replay && squad && o.KillsRoamTargetDuration > 0) {
          const first = replay.firstHunts.get(huntKey(squad, o));
          if (first != null) {
            remaining = o.KillsRoamTargetDuration - Math.max(0, replay.at - first) / 1000;
            approximate = true;
          }
        }
      }
    }
    if (remaining != null) return (approximate ? '~' : '') + T('{t} left', { t: clockText(Math.max(0, Math.ceil(remaining)) * 1000) });
    return o.Type === 'Kills' && o.KillsRoamTargetDuration > 0 ? T('Target duration {t}', { t: clockText(o.KillsRoamTargetDuration * 1000) }) : '';
  }
  function orbitStateText(o, state, squad) {
    const detail = orbitGoalDetail(o, state, squad);
    return detail ? orbitStateNames[state] + ' · ' + detail : orbitStateNames[state];
  }
  function orbitGoalOf(pid) {
    const squad = orbitSquadOf(pid);
    if (!squad) return null;
    const active = list(squad.MainObjectives).filter(o => o && orbitGoalState(o, squad) === 'active');
    return active.length ? { text: active.map(o => {
      const goal = orbitGoalName(o) + orbitStepCount(o);
      return o.Type === 'LootValue' && Number.isFinite(o.LootValueTotal) ? goal + ' · ' + roubles(o.LootValueTotal) : goal;
    }).join(' · ') } : null;
  }
  function orbitTacticalOrder(m) {
    if (!replay || prefs.orbitTactics === false || (m.os && m.os !== 'ORBIT') || !m.ob || !Array.isArray(m.og) || !modOn('ORBIT')) return false;
    const squad = orbitSquadOf(m.pid);
    if ((!m.gh && m.ly && !/^ORBIT/i.test(m.ly)) || /\((?:Failed|paused|interrupted)\)/i.test(m.ob)) return false;
    const operation = squad && list(squad.MainObjectives).find(o => o?.OperationName && m.ob.startsWith(o.OperationName + ':'));
    if (operation) return orbitGoalState(operation) === 'active';
    return /^(?:Ambush|Airdrop|SquadCover|MultiStep:|(?:Spawn|Boss|Marked|Custom) rush\b|Sniper overwatch\b)/i.test(m.ob);
  }
  function drawOrbitMain(scale) {
    const plans = !!prefs.orbitMain, rush = !!prefs.orbitRush;
    if (!orbitMain || !modOn('ORBIT')) return;
    const selected = orbitSquadOf(liveById.get(chased)?.pid);
    const focus = selected || orbitSquadOf(liveById.get(rosterOver)?.pid) || orbitSquadOf(liveById.get(pointed)?.pid);
    if (!(plans || rush || focus)) return;
    const squads = list(orbitMain.d.s), visible = new Map();
    for (const m of live) {
      if (m.c === 'Corpse' || isHidden(m.c) || inArea(m)) continue;
      const squad = orbitSquadOf(m.pid);
      if (!squad || !(plans || rush || squad === focus)) continue;
      if (!visible.has(squad)) visible.set(squad, []);
      visible.get(squad).push(m);
    }
    ctx.save();
    for (const squad of squads) {
      const shown = squad === focus;
      const here = visible.get(squad);
      if (!here) continue;
      const goals = list(squad.MainObjectives).filter(o => o && Number.isFinite(o.X) && Number.isFinite(o.Z));
      goals.forEach(o => {
        if (offFloor(o.X, o.Z, o.Y)) return;
        const s = toScreen(o.X, o.Z), r = (shown ? 10 : 8) * scale, state = orbitGoalState(o, squad);
        const what = orbitGoalName(o), status = orbitStateNames[state], detail = orbitGoalDetail(o, state, squad);
        ctx.globalAlpha = focus && !shown ? .38 : shown || state === 'active' ? 1 : .74;
        // the places the squad is to sweep (a rush), each a ring named over its top: what for, and by whom
        for (const p of rush ? list(o.RushPoints) : []) {
          if (!p || !Number.isFinite(p.X) || !Number.isFinite(p.Z)) continue;
          const at = toScreen(p.X, p.Z), rr = Math.max(4 * scale, (p.Radius || 0) * zoom);
          if (at[0] + rr < 0 || at[1] + rr < 0 || at[0] - rr > vw || at[1] - rr > vh) continue;
          const done = /done|visited|complete/i.test(p.State || ''), current = p.State === 'current';
          ctx.beginPath();
          ctx.arc(at[0], at[1], rr, 0, Math.PI * 2);
          ctx.lineWidth = 1.3 * scale;
          ctx.strokeStyle = current ? orbitStateColors[state] : done ? '#94aa9d' : '#7999bd';
          ctx.stroke();
          const label = T('Squad {n}', { n: squad.SquadId }) + ' · ' + (p.Name || what || T('Rush point')) + (current ? ' · ' + status : '');
          ctx.font = Math.round(10.5 * scale) + 'px ' + FONT;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.lineWidth = 3 * scale;
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
          ctx.strokeText(label, at[0], at[1] - rr - 2 * scale);
          ctx.fillStyle = current ? orbitStateColors[state] : '#bfe0ff';
          ctx.fillText(label, at[0], at[1] - rr - 2 * scale);
        }
        if (!plans && !shown) return;
        if (s[0] < -30 || s[1] < -30 || s[0] > vw + 30 || s[1] > vh + 30) return;
        ctx.beginPath();
        ctx.moveTo(s[0], s[1] - r * 1.25); ctx.lineTo(s[0] + r * 1.25, s[1]); ctx.lineTo(s[0], s[1] + r * 1.25); ctx.lineTo(s[0] - r * 1.25, s[1]);
        ctx.closePath();
        ctx.fillStyle = '#12314d';
        ctx.fill();
        ctx.lineWidth = (shown ? 3 : 2) * scale;
        ctx.strokeStyle = orbitStateColors[state];
        ctx.stroke();
        ctx.font = 'bold ' + Math.round(10 * scale) + 'px ' + FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#d7ecff';
        ctx.fillText(orbitLetter(o), s[0], s[1] + 0.5);
        const captionVisible = shown || state === 'active' || state === 'paused';
        if (captionVisible) {
          const caption = T('Squad {n}', { n: squad.SquadId }) + ' · ' + status;
          ctx.font = Math.round(11 * scale) + 'px ' + FONT;
          ctx.lineWidth = 3 * scale; ctx.strokeStyle = '#101622';
          ctx.strokeText(caption, s[0], s[1] + r * 2.1); ctx.fillStyle = orbitStateColors[state];
          ctx.fillText(caption, s[0], s[1] + r * 2.1);
        }
        if (detail) {
          const y = s[1] + r * 2.1 + (captionVisible ? 13 * scale : 0);
          ctx.font = Math.round(11 * scale) + 'px ' + FONT;
          ctx.lineWidth = 3 * scale; ctx.strokeStyle = '#101622';
          ctx.strokeText(detail, s[0], y); ctx.fillStyle = orbitStateColors[state];
          ctx.fillText(detail, s[0], y);
        }
        thingsDrawn.push({ x: s[0], y: s[1], r: r * 1.4, tip: { title: 'ORBIT · ' + what,
          lines: [status, detail, o.OperationStep ? words(o.OperationStep) + orbitStepCount(o) : '',
            o.QuestTitle || '', o.CampFailure || o.OperationState || o.CampState || o.AirdropStage || '',
            T('Squad:') + ' ' + here.map(m => m.t || ONE[m.c] || m.c).join(', ')] } });
      });
    }
    ctx.restore();
  }
  // ORBIT's field: the arrows its bots are drawn along (one for each of its squares, thinned out from afar), and
  // its zones as circles.
  // (ORBIT gives a zone's place in squares of its field, fractions too, a square's middle at a whole number, and its
  // radius in metres)
  const drawOrbitField = scale => drawFieldOf(scale, orbitField && prefs.orbitField && modOn('ORBIT') ? orbitField.d.s : null, '111, 188, 255', true);
  // (Phobos's field is the same sort of thing, with the arrows of where its bots are drawn together as well)
  const drawPhobosField = scale => drawFieldOf(scale, phobosField && prefs.phobosField && modHere('Phobos') ? phobosField.d.s : null, '183, 227, 161');
  function drawFieldOf(scale, f, rgb, orbit) {
    if (!f || !Number.isFinite(f.CellSize) || !(f.CellSize > 0)) return;
    const size = f.CellSize * zoom, every = Math.max(1, Math.ceil(18 * scale / size));
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(' + rgb + ', 0.7)';
    ctx.lineWidth = 1.3 * scale;
    ctx.beginPath();
    for (const c of list(f.Advection).concat(list(f.Convergence))) {
      if (!c || c.X % every || c.Y % every) continue;
      const force = Math.hypot(c.Fx, c.Fz);
      if (!(force > 0.001)) continue;
      const x = f.WorldMinX + (c.X + 0.5) * f.CellSize, y = f.WorldMinZ + (c.Y + 0.5) * f.CellSize, len = f.CellSize * every * 0.4;
      const a = toScreen(x, y);
      if (a[0] < -20 || a[1] < -20 || a[0] > vw + 20 || a[1] > vh + 20) continue;
      const b = toScreen(x + c.Fx / force * len, y + c.Fz / force * len), back = Math.atan2(a[1] - b[1], a[0] - b[0]), barb = 4 * scale;
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.moveTo(b[0] + Math.cos(back + 0.5) * barb, b[1] + Math.sin(back + 0.5) * barb);
      ctx.lineTo(b[0], b[1]);
      ctx.lineTo(b[0] + Math.cos(back - 0.5) * barb, b[1] + Math.sin(back - 0.5) * barb);
    }
    ctx.stroke();
    for (const z of list(f.Zones)) {
      if (!z || !Number.isFinite(z.X) || !Number.isFinite(z.Y)) continue;
      // (a zone's place is a square of the field, or the game's own x and z: an ORBIT says which by how big they are)
      const inCells = orbit || (z.X < f.GridCols && z.Y < f.GridRows && z.X >= 0 && z.Y >= 0 && Number.isInteger(z.X) && Number.isInteger(z.Y));
      const s = inCells ? toScreen(f.WorldMinX + (z.X + 0.5) * f.CellSize, f.WorldMinZ + (z.Y + 0.5) * f.CellSize) : toScreen(z.X, z.Y);
      ctx.beginPath();
      ctx.arc(s[0], s[1], Math.max(4, (z.Radius || 0) * (inCells && !orbit ? f.CellSize : 1) * zoom), 0, Math.PI * 2);
      ctx.fillStyle = z.Force < 0 ? 'rgba(255, 110, 100, 0.07)' : 'rgba(' + rgb + ', 0.07)';
      ctx.fill();
      ctx.strokeStyle = z.Force < 0 ? 'rgba(255, 110, 100, 0.6)' : 'rgba(' + rgb + ', 0.6)';
      ctx.stroke();
    }
    ctx.restore();
  }
  // how a raid ended for its player, as the list of raids and the leaderboard say it
  const EXITS = { Survived: T('survived'), Killed: T('died'), Runner: T('run-through'), Left: T('left the raid'), MissingInAction: T('missing in action'), Transit: T('went through a transit') };

  // ---- pick-ups on the map ----
  // What somebody picks up ("loot" events, as they happen) is written where they stood: it rises and fades. An older
  // plugin doesn't say where: then it's where their marker is.
  let lootFloats = [];
  const FLOAT_MS = 6000;
  function floatLoot(e) {
    if (e.k === 'door' && (prefs.doorEvents === false || replaySeeking || !pidShown(e.p))) return;
    if (e.k === 'door') {
      const at = e.d.at;
      if (!Array.isArray(at)) return;
      const now = performance.now();
      lootFloats = lootFloats.filter(f => now - f.at < FLOAT_MS);
      lootFloats.push({ x: at[0], y: at[1], z: at[2], at: now, row: lootFloats.filter(f => Math.hypot(f.x - at[0], f.y - at[1]) < 5).length,
        text: doorSaid(e.d), who: e.nm ? latin(e.nm) : '', col: '#d9c29a' });
      if (lootFloats.length > 40) lootFloats.shift();
      dirty = true;
      return;
    }
    // (a grenade thrown isn't a drop: its arc and burst show it, Settings > Grenades)
    if (prefs.lootFloats === false || replaySeeking || (e.k === 'loot' && !eventListed(e, 'loot', prefs.floatWorth)) || (e.k === 'drop' && (e.d.g || isHidden(e.d.wk || 'None') || prefs.areaKinds.includes(e.d.wk)))) return;
    let at = Array.isArray(e.d.at) ? e.d.at : null;
    if (!at) {
      const m = e.p ? live.find(o => o.pid === e.p && o.c !== 'Corpse') : null;
      if (m && Number.isFinite(m.cx)) at = [m.cx, m.cy, m.cz];
    }
    if (!at) return;
    const worth = lootWorth(e.d), now = performance.now();
    lootFloats = lootFloats.filter(f => now - f.at < FLOAT_MS);
    const row = lootFloats.filter(f => Math.hypot(f.x - at[0], f.y - at[1]) < 5).length;
    lootFloats.push({ x: at[0], y: at[1], z: at[2], at: now, row,
      text: (e.k === 'drop' ? '− ' : '+ ') + e.d.i + (e.d.q > 1 ? ' ×' + e.d.q : '') + (e.d.ad === 1 ? ' · ' + T('airdrop') : ''), who: e.d.wk === 'Main Player' || !e.nm ? '' : latin(e.nm),
      col: e.k === 'drop' ? '#b9bcc8' : e.d.qi ? LAYERS.quest.col : Number.isFinite(worth) ? worthCol(worth) : '#e8e9eb' });
    if (lootFloats.length > 40) lootFloats.shift();
    dirty = true;
  }
  function drawFloats(scale) {
    if (!lootFloats.length) return;
    const now = performance.now();
    lootFloats = lootFloats.filter(f => now - f.at < FLOAT_MS);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineJoin = 'round';
    for (const f of lootFloats) {
      if (offFloor(f.x, f.y, f.z)) continue;
      const age = now - f.at, s = toScreen(f.x, f.y);
      if (s[0] < -80 || s[1] < -80 || s[0] > vw + 80 || s[1] > vh + 80) continue;
      const y = s[1] - (16 + 26 * age / FLOAT_MS + 13 * f.row) * scale;
      ctx.globalAlpha = Math.min(1, age / 250, (FLOAT_MS - age) / 1500);
      ctx.font = '600 ' + Math.round(11.5 * scale) + 'px ' + FONT;
      const text = f.who ? f.who + '  ' + f.text : f.text;
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = 'rgba(0,0,0,0.9)';
      ctx.strokeText(text, s[0], y);
      ctx.fillStyle = f.col;
      ctx.fillText(text, s[0], y);
    }
    ctx.restore();
    if (lootFloats.length) dirty = true;
  }

  function listen() {
    if (source) source.close();
    // One game's reports only: the player picked, or with nobody picked the game being shown. The other games on
    // the server then aren't asked for their markers. (Every game, only until the first is heard from.)
    streamFor = prefs.player ? prefs.player.sid : sid;
    streamUp = false;
    source = new EventSource('api/stream' + (streamFor ? '?session=' + encodeURIComponent(streamFor) : ''));
    source.onopen = () => { serverLost = false; };
    // (a server without the map answers the stream "not found", and the browser gives it up: asked again later, see
    // the timers at the end)
    source.onerror = () => { serverLost = true; streamUp = false; if (source.readyState === 2) missed(); };
    source.onmessage = e => {
      serverLost = false;
      try { take(JSON.parse(e.data)); } catch (err) { console.warn(err); }
    };
    // What the page would otherwise keep asking for, brought by the stream when it changes. While a server sends
    // these the page stops asking (streamUp); one that doesn't (older) is asked as before.
    const news = (name, use) => source.addEventListener(name, e => {
      streamUp = true;
      try { use(JSON.parse(e.data)); } catch (err) { console.warn(err); }
    });
    news('games', takeGames);
    news('maps', d => { if (d && d.print !== mapsPrint) loadMaps(); });
    news('things', streamThings);
    news('quests', d => { streamQuests(d); listQuests(); });
  }

  resized();
  // the options are open to begin with where there's room for them beside the map
  // on a phone the panel would cover the map: it starts shut there whatever it was left as
  placeQuick();
  showTab(tab, false);
  showModes();
  // (the history page has no menu, and the Raid list only beside a replay's map: see hpShow)
  togglePanel(HIST || phone.matches ? false : prefs.panel !== undefined ? !!prefs.panel : window.innerWidth >= 900, false);
  toggleSide(HIST ? false : prefs.side !== undefined ? !!prefs.side : window.innerWidth >= 900, false);
  // the page's address ending in ?menu=loot (or raid, quests, map, settings): the menu starts open on that tab.
  // ?menu=history (the address of the raid history before it had a page of its own) goes to that page.
  const asked = new URLSearchParams(location.search).get('menu');
  if (asked === 'history' && RECORDING && !HIST) location.replace('raids/');
  else if (TABS.includes(asked) && !HIST) { showTab(asked, false); togglePanel(true, false); }
  phone.addEventListener('change', () => { placeQuick(); sidesNow(); measureCover(); findShown = ''; listRoster(); });
  // started again by itself (see again): whole now, so it's shown
  // (the bar is whole once the list of maps has come and one is shown: until then it would be seen shuffling about)
  {
    const from = performance.now();
    const look = () => {
      if (!$('map').hidden && map || performance.now() - from > 2500) requestAnimationFrame(() => window.swapDone && window.swapDone());
      else requestAnimationFrame(look);
    };
    if (document.documentElement.classList.contains('swap')) requestAnimationFrame(look);
  }
  // the sheet is as tall as what's in it: measured again whenever that changes
  if (window.ResizeObserver) new ResizeObserver(measureCover).observe($('panel'));
  // what sits under the bar starts under it, however many rows the bar takes in a narrow window (--bar-b)
  const fitBar = () => document.documentElement.style.setProperty('--bar-b', Math.round($('bar').getBoundingClientRect().bottom + 10) + 'px');
  if (window.ResizeObserver) new ResizeObserver(fitBar).observe($('bar'));
  addEventListener('resize', fitBar);
  fitBar();
  // full screen can't be had on some phones (an iPhone's browser): no button for it there
  if (!document.documentElement.requestFullscreen) $('full').hidden = true;
  loadMaps();
  setInterval(() => { if (serverAway()) return; if (!streamUp) loadMaps(); loadPlaces(false); loadSpawns(); }, 4000);
  if (HIST) {
    // the raid history page: no live game at all (no stream, no games asked for), only the raid the address names
    hpRoute();
  } else {
    listen();
    askGames();
    setInterval(() => {
      if (serverAway()) return;
      // the stream given up on (the server didn't have the map): opened again once it's time to ask again
      if (source && source.readyState === 2) listen();
      if (!streamUp) askGames();
    }, 3000);
  }
  requestAnimationFrame(frame);
})();
