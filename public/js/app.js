/* ==========================================================================
   SEO Suite - application shell behaviour
   --------------------------------------------------------------------------
   Everything in here is progressive enhancement. The app is fully usable with
   this file blocked: the sidebar renders expanded, menus are <details> that
   open on click natively, the command palette is replaced by the nav's own
   links, and every "filter" input simply does nothing. Nothing below is
   required to read data or submit a form.

   No dependencies. Runs deferred, after parse.
   ========================================================================== */
(function () {
  'use strict';

  var STORE = {
    rail: 'seosuite:rail',
    theme: 'seosuite:theme',
    density: 'seosuite:density',
    section: 'seosuite:navsection:',
  };

  function read(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  function write(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  var app = document.querySelector('.app');
  var sidebar = document.querySelector('.sidebar');

  /* ------------------------------------------------------- sidebar rail */
  /* The rail state is read in <head> (as .boot-rail on <html>) so the sidebar
     never paints wide and then snaps narrow. Here we move it onto .app, where
     the CSS actually wants it, and drop the boot flag. */

  if (app && document.documentElement.classList.contains('boot-rail')) {
    app.classList.add('is-rail');
    document.documentElement.classList.remove('boot-rail');
  }

  var railToggle = document.querySelector('.rail-toggle');
  if (railToggle && app) {
    railToggle.addEventListener('click', function () {
      var railed = app.classList.toggle('is-rail');
      write(STORE.rail, railed ? '1' : '0');
      railToggle.setAttribute('aria-expanded', railed ? 'false' : 'true');
      railToggle.setAttribute('aria-label', railed ? 'Expand sidebar' : 'Collapse sidebar');
    });
  }

  /* ------------------------------------------------ mobile nav drawer */

  var navOpen = document.querySelector('.nav-open-btn');
  var backdrop = document.querySelector('.nav-backdrop');

  function setNav(open) {
    if (!app) return;
    app.classList.toggle('nav-open', open);
    if (navOpen) navOpen.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.body.style.overflow = open ? 'hidden' : '';
    if (open && sidebar) {
      var first = sidebar.querySelector('.nav-link');
      if (first) first.focus({ preventScroll: true });
    }
  }

  if (navOpen) navOpen.addEventListener('click', function () { setNav(!app.classList.contains('nav-open')); });
  if (backdrop) backdrop.addEventListener('click', function () { setNav(false); });

  // Following a link inside the drawer should close it, not leave it hanging
  // over the page the user just navigated to.
  if (sidebar) {
    sidebar.addEventListener('click', function (e) {
      if (e.target.closest('.nav-link') && window.matchMedia('(max-width: 920px)').matches) setNav(false);
    });
  }

  /* ------------------------------------------- collapsible nav sections */
  /* Each <details class="nav-section"> remembers its own open state, so a
     person who never touches the AI SEO group can fold it away permanently. */

  Array.prototype.forEach.call(document.querySelectorAll('.nav-section[data-key]'), function (sec) {
    var key = STORE.section + sec.getAttribute('data-key');
    var saved = read(key, null);
    if (saved === '0') sec.open = false;
    if (saved === '1') sec.open = true;
    sec.addEventListener('toggle', function () { write(key, sec.open ? '1' : '0'); });
  });

  /* ------------------------------------------------ nav scroll position */
  /* Every page is a fresh server render, so the nav column was scrolled back
     to the top on each navigation. If you were working out of the AI search
     group, which sits well down a 34-item list, every click threw you back to
     "Dashboard" and you had to scroll down again to reach the next page.
     Restoring the position makes the nav feel like it stayed put while the
     page beside it changed, which is what a persistent sidebar implies.

     sessionStorage, not localStorage: this is the state of one browsing
     session, and it should not still be applied in a week's time. Restored
     before paint where possible so there is no visible jump. */
  var navScroll = document.getElementById('nav-scroll');
  if (navScroll) {
    var SCROLL_KEY = 'seosuite:navscroll';
    try {
      var saved = parseInt(sessionStorage.getItem(SCROLL_KEY), 10);
      if (saved > 0) navScroll.scrollTop = saved;
    } catch (e) {}

    var scrollTimer = null;
    navScroll.addEventListener('scroll', function () {
      if (scrollTimer) return;
      scrollTimer = setTimeout(function () {
        scrollTimer = null;
        try { sessionStorage.setItem(SCROLL_KEY, String(navScroll.scrollTop)); } catch (e) {}
      }, 120);
    }, { passive: true });

    // Persist immediately on the click that navigates away, so the position
    // is correct even if the throttle above has not fired yet.
    navScroll.addEventListener('click', function (e) {
      if (!e.target.closest('.nav-link')) return;
      try { sessionStorage.setItem(SCROLL_KEY, String(navScroll.scrollTop)); } catch (err) {}
    });
  }

  /* -------------------------------------------------------- nav filter */

  var navFilter = document.getElementById('nav-filter');
  if (navFilter) {
    var allLinks = Array.prototype.slice.call(document.querySelectorAll('.sidebar .nav-link'));
    navFilter.addEventListener('input', function () {
      var q = navFilter.value.trim().toLowerCase();
      Array.prototype.forEach.call(document.querySelectorAll('.nav-section'), function (sec) {
        var group = sec.querySelector('.nav-group');
        if (!group) return;
        var links = Array.prototype.slice.call(group.querySelectorAll('.nav-link'));
        var shown = 0;
        links.forEach(function (a) {
          var hit = !q || (a.getAttribute('data-label') || a.textContent).toLowerCase().indexOf(q) !== -1;
          a.hidden = !hit;
          if (hit) shown++;
        });
        sec.hidden = q && shown === 0;
        // While filtering, force every surviving section open so matches are
        // never hidden inside a collapsed group. Restore on clear.
        if (q) { sec.open = true; } else { sec.hidden = false; }
      });
      if (!q) allLinks.forEach(function (a) { a.hidden = false; });
    });
    // Escape clears rather than blurring, which is what people expect here.
    navFilter.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && navFilter.value) {
        e.stopPropagation();
        navFilter.value = '';
        navFilter.dispatchEvent(new Event('input'));
      }
    });
  }

  /* ------------------------------------------------------------- menus */
  /* <details> menus: close on outside click, on Escape, and when another one
     opens. Native <details> does none of this on its own. */

  var menus = Array.prototype.slice.call(document.querySelectorAll('details.menu'));

  document.addEventListener('click', function (e) {
    menus.forEach(function (m) { if (m.open && !m.contains(e.target)) m.open = false; });
  });

  menus.forEach(function (m) {
    m.addEventListener('toggle', function () {
      if (!m.open) return;
      menus.forEach(function (o) { if (o !== m) o.open = false; });
    });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var openMenu = menus.filter(function (m) { return m.open; })[0];
    if (openMenu) {
      openMenu.open = false;
      var s = openMenu.querySelector('summary');
      if (s) s.focus();
      return;
    }
    if (app && app.classList.contains('nav-open')) setNav(false);
    if (palette && palette.classList.contains('is-open')) closePalette();
  });

  /* ------------------------------------------------------------- theme */
  /* Three states, not a binary flip: Light, Dark, and System.
     LIGHT is the default. "System" is still one of the three, but it is now
     STORED as 'system' rather than represented by an absent key - otherwise
     "no preference yet" and "follow my OS" are the same state, and every
     first-time visitor on a dark-mode machine gets a dark app by accident.
     The matching boot script in partials/head.ejs reads it the same way. */

  function applyTheme(mode) {
    if (mode === 'system') {
      document.documentElement.removeAttribute('data-theme');
      write(STORE.theme, 'system');
    } else {
      document.documentElement.setAttribute('data-theme', mode);
      write(STORE.theme, mode);
    }
    syncThemeUI(mode);
  }

  function syncThemeUI(mode) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-theme-set]'), function (el) {
      el.classList.toggle('is-current', el.getAttribute('data-theme-set') === mode);
      el.setAttribute('aria-checked', el.getAttribute('data-theme-set') === mode ? 'true' : 'false');
    });
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-theme-set]');
    if (!t) return;
    e.preventDefault();
    applyTheme(t.getAttribute('data-theme-set'));
  });

  syncThemeUI(read(STORE.theme, 'light') || 'light');

  /* ----------------------------------------------------------- density */

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-density-set]');
    if (!t) return;
    e.preventDefault();
    var mode = t.getAttribute('data-density-set');
    if (mode === 'compact') {
      document.documentElement.setAttribute('data-density', 'compact');
      write(STORE.density, 'compact');
    } else {
      document.documentElement.removeAttribute('data-density');
      try { localStorage.removeItem(STORE.density); } catch (err) {}
    }
    Array.prototype.forEach.call(document.querySelectorAll('[data-density-set]'), function (el) {
      el.classList.toggle('is-current', el.getAttribute('data-density-set') === mode);
    });
  });

  /* -------------------------------------------------- tab overflow bar */
  /* A tab strip with 21 items used to wrap onto four lines and push the table
     below the fold. It now scrolls on one line; these are the affordances
     that make a scrolling strip discoverable rather than a trap. */

  Array.prototype.forEach.call(document.querySelectorAll('.tabbar'), function (bar) {
    var strip = bar.querySelector('.tabs');
    if (!strip) return;
    var prev = bar.querySelector('.tab-scroll.prev');
    var next = bar.querySelector('.tab-scroll.next');

    function sync() {
      var overflowing = strip.scrollWidth > strip.clientWidth + 2;
      bar.classList.toggle('can-scroll', overflowing);
      if (!overflowing) return;
      if (prev) prev.disabled = strip.scrollLeft <= 1;
      if (next) next.disabled = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1;
    }

    function nudge(dir) { strip.scrollBy({ left: dir * Math.max(180, strip.clientWidth * 0.7), behavior: 'smooth' }); }
    if (prev) prev.addEventListener('click', function () { nudge(-1); });
    if (next) next.addEventListener('click', function () { nudge(1); });
    strip.addEventListener('scroll', sync, { passive: true });
    window.addEventListener('resize', sync);
    sync();

    // Bring the active tab into view on load; with 21 tabs the selected one is
    // regularly off-screen, which makes the page look like it ignored the click.
    var active = strip.querySelector('.tab.active');
    if (active) {
      var off = active.offsetLeft - (strip.clientWidth / 2) + (active.offsetWidth / 2);
      strip.scrollLeft = Math.max(0, off);
    }
  });

  /* -------------------------------------------------- command palette */
  /* The real answer to a 30-destination product. Cmd/Ctrl+K anywhere. */

  var palette = document.getElementById('cmdk');
  var paletteInput = palette && palette.querySelector('input');
  var paletteList = palette && palette.querySelector('.cmdk-list');
  var lastFocus = null;

  function paletteItems() {
    return Array.prototype.slice.call(paletteList.querySelectorAll('.cmdk-item:not([hidden])'));
  }

  function openPalette() {
    if (!palette) return;
    lastFocus = document.activeElement;
    palette.classList.add('is-open');
    palette.removeAttribute('hidden');
    document.body.style.overflow = 'hidden';
    paletteInput.value = '';
    filterPalette();
    paletteInput.focus();
  }

  function closePalette() {
    if (!palette) return;
    palette.classList.remove('is-open');
    palette.setAttribute('hidden', '');
    document.body.style.overflow = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function filterPalette() {
    var q = paletteInput.value.trim().toLowerCase();
    var any = false;
    Array.prototype.forEach.call(paletteList.querySelectorAll('.cmdk-item'), function (it) {
      var hay = (it.getAttribute('data-search') || it.textContent).toLowerCase();
      var hit = !q || hay.indexOf(q) !== -1;
      it.hidden = !hit;
      it.classList.remove('is-active');
      if (hit) any = true;
    });
    Array.prototype.forEach.call(paletteList.querySelectorAll('.cmdk-group'), function (g) {
      g.hidden = !g.querySelector('.cmdk-item:not([hidden])');
    });
    var empty = palette.querySelector('.cmdk-empty');
    if (empty) empty.hidden = any;
    var first = paletteItems()[0];
    if (first) first.classList.add('is-active');
  }

  function movePalette(dir) {
    var items = paletteItems();
    if (!items.length) return;
    var i = items.findIndex(function (x) { return x.classList.contains('is-active'); });
    items.forEach(function (x) { x.classList.remove('is-active'); });
    var n = (i + dir + items.length) % items.length;
    items[n].classList.add('is-active');
    items[n].scrollIntoView({ block: 'nearest' });
  }

  if (palette) {
    paletteInput.addEventListener('input', filterPalette);
    palette.addEventListener('click', function (e) { if (e.target === palette) closePalette(); });
    paletteInput.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); movePalette(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); movePalette(-1); }
      else if (e.key === 'Enter') {
        var act = paletteList.querySelector('.cmdk-item.is-active');
        if (act) { e.preventDefault(); act.click(); }
      }
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-cmdk-open]'), function (b) {
      b.addEventListener('click', function (e) { e.preventDefault(); openPalette(); });
    });
  }

  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (palette) { palette.classList.contains('is-open') ? closePalette() : openPalette(); }
      else if (navFilter) navFilter.focus();
    }
    // "/" focuses search, but not while the user is typing into something.
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || '')) && !e.target.isContentEditable) {
      if (palette) { e.preventDefault(); openPalette(); }
    }
  });

  /* --------------------------------------------------- submit feedback */
  /* Any form marked data-busy disables its submit button and shows a spinner,
     so a slow crawl or sync cannot be double-submitted by an impatient click. */

  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form.hasAttribute('data-busy')) return;
    var btn = form.querySelector('button[type=submit], button:not([type])');
    if (btn && !btn.classList.contains('is-loading')) {
      btn.classList.add('is-loading');
      btn.disabled = true;
      // Re-enable if the browser restores this page from bfcache on Back.
      window.addEventListener('pageshow', function () {
        btn.classList.remove('is-loading');
        btn.disabled = false;
      }, { once: true });
    }
  }, true);

  /* ---------------------------------------------------- flash dismissal */

  document.addEventListener('click', function (e) {
    var x = e.target.closest('.flash-close');
    if (!x) return;
    var n = x.closest('.notice');
    if (n) n.remove();
  });

  /* -------------------------------------------- auto-submitting filters */
  /* Replaces the inline onchange="this.form.submit()" that was repeated
     across a dozen views. */

  Array.prototype.forEach.call(document.querySelectorAll('[data-autosubmit] select, select[data-autosubmit]'), function (sel) {
    sel.addEventListener('change', function () { if (sel.form) sel.form.submit(); });
  });

  /* ------------------------------------------------------ sortable tables */
  /* Click a column heading to sort the rows under it. Applied to every
     table.data in the app rather than to a chosen few - there are 41 of them
     and "why can this one sort and that one not" is a worse answer than
     "they all do".

     THIS IS AN ENHANCEMENT, NOT A REPLACEMENT.
     Several tables already sort on the SERVER, via links in their headings
     (see table.data th.sorted in the stylesheet). Those sort the whole result
     set, not just the page you can see, which is strictly better - so a
     heading that already contains a link is left alone rather than fought
     over. Everything here operates only on rows already in the DOM, which is
     exactly what it claims to do.

     Values come from a data-sort attribute when a view supplies one, and
     otherwise from the cell's text with currency, thousands separators and
     percent signs stripped. Blanks and dashes always sort last in both
     directions: "no data" is not a small number, and letting it float to the
     top of an ascending sort buries the rows someone actually wants. */

  function cellValue(row, index) {
    var cell = row.cells[index];
    if (!cell) return { n: null, s: '' };
    var explicit = cell.getAttribute('data-sort');
    var text = (explicit != null ? explicit : cell.textContent) || '';
    text = text.replace(/\s+/g, ' ').trim();
    if (!text || text === '-' || text === '–' || text === '···') return { n: null, s: '' };
    // Strip currency symbols, thousands separators, percent and a leading +.
    var cleaned = text.replace(/[$£€,%]/g, '').replace(/^\+/, '').trim();
    var n = cleaned === '' ? NaN : Number(cleaned);
    return { n: isFinite(n) ? n : null, s: text.toLowerCase() };
  }

  function sortableColumns(table) {
    var head = table.tHead;
    if (!head || !head.rows.length) return null;
    var body = table.tBodies[0];
    if (!body || body.rows.length < 2) return null;
    // Grouped or spanning rows have no single row order to restore, so they
    // are left alone rather than scrambled.
    for (var r = 0; r < body.rows.length; r++) {
      for (var c = 0; c < body.rows[r].cells.length; c++) {
        var cell = body.rows[r].cells[c];
        if (cell.colSpan > 1 || cell.rowSpan > 1) return null;
      }
    }
    return { head: head.rows[head.rows.length - 1], body: body };
  }

  Array.prototype.forEach.call(document.querySelectorAll('table.data'), function (table) {
    var parts = sortableColumns(table);
    if (!parts) return;
    var headRow = parts.head;
    var body = parts.body;

    Array.prototype.forEach.call(headRow.cells, function (th, index) {
      // Server-sorted columns own their own heading - do not take it over.
      if (th.querySelector('a')) return;
      if (!th.textContent.trim()) return;
      th.classList.add('is-sortable');
      th.setAttribute('tabindex', '0');
      th.setAttribute('role', 'button');
      th.setAttribute('aria-sort', 'none');

      function apply() {
        var current = th.getAttribute('aria-sort');
        // First click on a numeric column sorts DESCENDING. On a table of
        // search volumes and bids, "biggest first" is what every reader means
        // by "sort by this", and making them click twice for it is friction.
        var probe = cellValue(body.rows[0], index);
        var numeric = probe.n !== null;
        var dir;
        if (current === 'none') dir = numeric ? 'descending' : 'ascending';
        else dir = current === 'ascending' ? 'descending' : 'ascending';

        Array.prototype.forEach.call(headRow.cells, function (other) {
          other.setAttribute('aria-sort', 'none');
          other.classList.remove('sort-asc', 'sort-desc');
        });
        th.setAttribute('aria-sort', dir);
        th.classList.add(dir === 'ascending' ? 'sort-asc' : 'sort-desc');

        var rows = Array.prototype.slice.call(body.rows);
        var sign = dir === 'ascending' ? 1 : -1;
        rows.sort(function (a, b) {
          var va = cellValue(a, index);
          var vb = cellValue(b, index);
          var aEmpty = va.n === null && !va.s;
          var bEmpty = vb.n === null && !vb.s;
          if (aEmpty && bEmpty) return 0;
          if (aEmpty) return 1;   // blanks last, whichever direction
          if (bEmpty) return -1;
          if (va.n !== null && vb.n !== null) return (va.n - vb.n) * sign;
          return va.s.localeCompare(vb.s) * sign;
        });
        var frag = document.createDocumentFragment();
        rows.forEach(function (row) { frag.appendChild(row); });
        body.appendChild(frag);
      }

      th.addEventListener('click', apply);
      th.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); apply(); }
      });
    });
  });
})();
