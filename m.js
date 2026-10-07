/* Meranie návštev — anonymné a bez cookies.
 *
 * Čo sa posiela do PostHogu (EÚ): ktorá stránka sa otvorila, odkiaľ človek
 * prišiel (`?s=bezci-ke` alebo `utm_source`), typ zariadenia a ťuknutia na
 * obchody. Nič sa neukladá do prehliadača (žiadne cookies, žiadny
 * localStorage) a identifikátor žije len do zavretia stránky, takže návštevník
 * sa medzi stránkami ani dňami nedá spojiť. Preto netreba lištu so súhlasom.
 *
 * Z adresy sa NEPOSIELA nič okrem cesty: `/g/` a `/i/` nesú kódy pozvánok
 * a `/auth/` prihlasovacie tokeny (tam sa tento skript nenačíta vôbec).
 *
 * `?s=` je zdroj návštevy (príspevok, skupina, leták). `?z=` je obsadené:
 * nesie miesto v appke, z ktorého odišla pozvánka (pozri /stiahnut/).
 */
(function () {
  'use strict';
  var KEY = 'phc_oP2PChs68vXUshCabqTytRc5mzQAo8pEj3n9CkaGK39c';
  var URL = 'https://eu.i.posthog.com/i/v0/e/';

  var ua = navigator.userAgent || '';
  var robot = /bot|crawl|spider|headless|lighthouse|preview/i.test(ua);
  var nesledovat = navigator.doNotTrack === '1' || window.doNotTrack === '1';
  var lokalne = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

  function param(meno) {
    try {
      var m = location.search.match(new RegExp('[?&]' + meno + '=([^&#]+)'));
      if (!m) return '';
      return decodeURIComponent(m[1]).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
    } catch (e) { return ''; }
  }

  var zdroj = param('s') || param('utm_source');
  window.mbZdroj = zdroj;

  var odkial = '';
  var odkialDomena = '';
  try {
    if (document.referrer) {
      var r = new window.URL(document.referrer);
      odkialDomena = r.hostname;
      odkial = r.origin + r.pathname;   // bez parametrov
    }
  } catch (e) { /* referrer nemusí byť adresa */ }

  var zariadenie = /Android/i.test(ua) ? 'android'
    : (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && typeof document.ontouchend !== 'undefined')) ? 'ios'
    : 'pocitac';

  var id = 'web-' + Math.random().toString(36).slice(2) + Date.now().toString(36);

  var spolocne = {
    $lib: 'web',
    $current_url: location.origin + location.pathname,
    $pathname: location.pathname,
    $host: location.hostname,
    $referrer: odkial || '$direct',
    $referring_domain: odkialDomena || '$direct',
    $process_person_profile: false,
    zdroj: zdroj || null,
    utm_medium: param('utm_medium') || null,
    utm_campaign: param('utm_campaign') || null,
    zariadenie: zariadenie,
    jazyk: (navigator.language || '').slice(0, 5)
  };

  /** Pošle udalosť. Nikdy nevyhodí chybu — meranie nesmie pokaziť stránku. */
  window.mb = function (udalost, vlastnosti) {
    try {
      if (robot || nesledovat) return;
      var p = {};
      var k;
      for (k in spolocne) p[k] = spolocne[k];
      for (k in (vlastnosti || {})) p[k] = vlastnosti[k];
      var telo = JSON.stringify({
        api_key: KEY, event: udalost, distinct_id: id, properties: p,
        timestamp: new Date().toISOString()
      });
      if (lokalne) { if (window.console) console.log('[meranie]', udalost, p); return; }
      // text/plain, aby prehliadač neposielal predbežnú požiadavku (CORS).
      if (navigator.sendBeacon && navigator.sendBeacon(URL, new Blob([telo], { type: 'text/plain' }))) return;
      fetch(URL, { method: 'POST', body: telo, keepalive: true, headers: { 'Content-Type': 'text/plain' } });
    } catch (e) { /* ticho */ }
  };

  window.mb('$pageview');

  /** Kde na stránke odkaz stojí — id najbližšej sekcie, inak hlavička/pätička. */
  function miesto(el) {
    var s = el.closest && el.closest('section[id],header,footer,nav,[data-miesto]');
    if (!s) return 'stranka';
    return s.getAttribute('data-miesto') || s.id || s.tagName.toLowerCase();
  }

  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var h = a.getAttribute('href') || '';
    if (h.indexOf('apps.apple.com') >= 0) window.mb('store_click', { obchod: 'app_store', miesto: miesto(a) });
    else if (h.indexOf('play.google.com') >= 0) window.mb('store_click', { obchod: 'google_play', miesto: miesto(a) });
    else if (h.indexOf('/stiahnut') === 0) window.mb('download_click', { miesto: miesto(a) });
    else if (h.indexOf('mailto:') === 0) window.mb('contact_click', { miesto: miesto(a) });
    else if (h.indexOf('mecbal://') === 0) window.mb('open_app_click', { miesto: miesto(a) });
  }, true);

  // Zdroj musí prežiť cestu ďalej: na ďalšiu našu stránku (inak by sme pri
  // ťuknutí na obchod nevedeli, odkiaľ človek prišiel) a do Google Play, kde
  // sa ukáže v prehľade akvizícií. App Store kampaňový odkaz bez tokenu
  // poskytovateľa nepozná, tam ostáva len naše počítanie ťuknutí.
  if (zdroj) {
    document.addEventListener('DOMContentLoaded', function () {
      [].forEach.call(document.querySelectorAll('a[href]'), function (a) {
        var h = a.getAttribute('href') || '';
        if (h.charAt(0) === '/' && h.indexOf('/auth') !== 0 && !/[?&]s=/.test(h)) {
          var kotva = '';
          var i = h.indexOf('#');
          if (i >= 0) { kotva = h.slice(i); h = h.slice(0, i); }
          a.setAttribute('href', h + (h.indexOf('?') >= 0 ? '&' : '?') + 's=' + zdroj + kotva);
        } else if (h.indexOf('play.google.com/store/apps/details') >= 0 && h.indexOf('referrer=') < 0) {
          a.setAttribute('href', h + '&referrer=' + encodeURIComponent('utm_source=' + zdroj + '&utm_medium=web'));
        }
      });
    });
  }
})();
