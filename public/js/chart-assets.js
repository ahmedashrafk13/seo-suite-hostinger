// On-demand loader for the charting libraries.
//
// WHAT THIS REPLACES
// head.ejs used to load ApexCharts (522 KB), jsVectorMap (33 KB), its world
// map (102 KB) and the country-code table on EVERY page — around 660 KB of
// JavaScript on all ~60 views, when only two of them draw a chart at all and
// only one draws a map. The login page paid for it. So did every settings,
// task, brand and audit page. That is the single largest thing standing
// between this app and its own 2.5s LCP target.
//
// Now nothing chart-related is requested until a chart partial asks for it,
// and each library is fetched at most once per page no matter how many charts
// are on it (performance.ejs has fourteen).
//
// WHY A LOADER RATHER THAN A PER-PAGE FLAG
// The obvious alternative is a `needsCharts` local set by the routes that
// render charts. That works until someone adds a chart partial to a third
// view and gets a blank card with no clue why. Making the partial itself
// declare the dependency means a chart can be dropped into any view and just
// works, and no view can pay for a library it does not use.
//
// SUBRESOURCE INTEGRITY
// The CDN is a third party that can execute script in a page holding Google
// OAuth sessions. The hashes below pin the exact bytes of each pinned version,
// so a compromised or substituted file is refused by the browser rather than
// run. They must be regenerated if a version above is ever bumped:
//   curl -sfL <url> | openssl dgst -sha384 -binary | openssl base64 -A
(function (global) {
  'use strict';

  var ASSETS = {
    apex: {
      js: [{
        url: 'https://cdn.jsdelivr.net/npm/apexcharts@3.45.1/dist/apexcharts.min.js',
        sri: 'sha384-PAhCwijXI5R/wFUO0uUXQYk6uq3qqIPdnCeMpuolYcrCtcoEhH/zl8ZGjd4RPzIt'
      }],
      css: [],
      ready: function () { return Boolean(global.ApexCharts); }
    },
    map: {
      js: [
        {
          url: 'https://cdn.jsdelivr.net/npm/jsvectormap@1.5.3/dist/js/jsvectormap.min.js',
          sri: 'sha384-dUo4VnkPwa5iJ/udOYY1SRDya6+2CVXYRfing32kyXbeB6HePV/YmJ3EPPvYz/Sb'
        },
        // The world map registers itself against jsVectorMap, so it must load
        // after it — hence a sequential chain rather than a parallel batch.
        {
          url: 'https://cdn.jsdelivr.net/npm/jsvectormap@1.5.3/dist/maps/world.js',
          sri: 'sha384-QCoiowLYPphJpiHouJIJOUCcg6AxqnLAAyEjkZnJ7RQCpC3YY1kEX0PaOant/8kx'
        },
        { url: '/js/country-codes.js', sri: null }
      ],
      css: [{
        url: 'https://cdn.jsdelivr.net/npm/jsvectormap@1.5.3/dist/css/jsvectormap.min.css',
        sri: 'sha384-3RT6/aAL0nKpqF8ldMoIrxz8OmRcPrKbR8MYXgvv2iKryEvn2vbfoI+FJbcpl+VW'
      }],
      ready: function () { return Boolean(global.jsVectorMap && global.CountryCodes); }
    }
  };

  // A blocked CDN (a corporate proxy, an ad blocker with a wide filter list, a
  // region where jsdelivr is unreachable) used to leave the old partials in a
  // `setTimeout(render, 60)` loop that retried forever and rendered nothing
  // but an empty box. A load error or a stalled request now rejects, and the
  // caller draws a message saying so.
  var TIMEOUT_MS = 12000;
  var pending = {};

  function loadCss(asset) {
    if (document.querySelector('link[data-chart-asset="' + asset.url + '"]')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = asset.url;
    link.setAttribute('data-chart-asset', asset.url);
    if (asset.sri) { link.integrity = asset.sri; link.crossOrigin = 'anonymous'; }
    document.head.appendChild(link);
  }

  function loadScript(asset) {
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-chart-asset="' + asset.url + '"]');
      if (existing) {
        if (existing.getAttribute('data-loaded') === '1') return resolve();
        existing.addEventListener('load', function () { resolve(); });
        existing.addEventListener('error', function () { reject(new Error('failed: ' + asset.url)); });
        return;
      }
      var el = document.createElement('script');
      el.src = asset.url;
      el.async = false;
      el.setAttribute('data-chart-asset', asset.url);
      if (asset.sri) {
        el.setAttribute('integrity', asset.sri);
        el.setAttribute('crossorigin', 'anonymous');
      }
      el.onload = function () { el.setAttribute('data-loaded', '1'); resolve(); };
      // Fires for a network failure AND for an SRI mismatch, which is the
      // point: a tampered file is treated as an unavailable one.
      el.onerror = function () {
        // The failed element must not be left behind. The de-duplication check
        // above matches on the URL, so a dead <script> that will never fire
        // another event would make every later attempt attach listeners to it
        // and wait for the timeout instead of retrying.
        if (el.parentNode) el.parentNode.removeChild(el);
        reject(new Error('failed: ' + asset.url));
      };
      document.head.appendChild(el);
    });
  }

  function withTimeout(promise) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error('timed out'));
      }, TIMEOUT_MS);
      promise.then(function (v) {
        if (done) return;
        done = true; clearTimeout(timer); resolve(v);
      }, function (e) {
        if (done) return;
        done = true; clearTimeout(timer); reject(e);
      });
    });
  }

  // Returns a promise that settles once the named bundle is usable. Repeated
  // calls share one promise, so fourteen charts on a page trigger one download
  // and one parse, and a failure is reported to all fourteen.
  function need(name) {
    var spec = ASSETS[name];
    if (!spec) return Promise.reject(new Error('unknown chart asset: ' + name));
    if (spec.ready()) return Promise.resolve();
    if (pending[name]) return pending[name];

    spec.css.forEach(loadCss);
    var chain = spec.js.reduce(function (p, asset) {
      return p.then(function () { return loadScript(asset); });
    }, Promise.resolve());

    pending[name] = withTimeout(chain).then(function () {
      if (!spec.ready()) throw new Error(name + ' loaded but did not initialise');
    }).catch(function (err) {
      // Cleared so a later chart (a tab swapped in by fetch, say) gets a fresh
      // attempt instead of inheriting a stale rejection from a blip.
      delete pending[name];
      throw err;
    });
    return pending[name];
  }

  // Standard "this chart could not be drawn" state, so a CDN failure reads as
  // a specific explanation instead of a blank card. The surrounding data table
  // is always rendered server-side, so the numbers themselves are never lost
  // with the chart.
  function unavailable(mountSelector, what) {
    var el = document.querySelector(mountSelector);
    if (!el) return;
    el.innerHTML = '';
    var box = document.createElement('div');
    box.className = 'empty';
    box.style.cssText = 'padding:18px 0;font-size:12.5px;color:var(--text-3)';
    box.setAttribute('role', 'status');
    box.textContent = (what || 'This chart') + ' could not be loaded. '
      + 'The figures are in the table below.';
    el.appendChild(box);
  }

  global.ChartAssets = { need: need, unavailable: unavailable };
}(window));
