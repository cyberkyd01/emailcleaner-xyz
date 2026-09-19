/* Shared site behaviour: theme, mobile nav, TOC highlighting, footer year. */
(function () {
  'use strict';

  // --- Theme -------------------------------------------------------------
  // Stored per browser only; it is a convenience, never state the server needs.
  var THEME_KEY = 'ec-theme';

  function readTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
  }
  function writeTheme(value) {
    try { localStorage.setItem(THEME_KEY, value); } catch (e) { /* private mode */ }
  }

  var stored = readTheme();
  if (stored === 'light' || stored === 'dark') {
    document.documentElement.setAttribute('data-theme', stored);
  }

  document.addEventListener('click', function (event) {
    var toggle = event.target.closest('[data-theme-toggle]');
    if (!toggle) return;
    var current = document.documentElement.getAttribute('data-theme');
    if (!current) {
      current = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    var next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    writeTheme(next);
  });

  // --- Mobile navigation -------------------------------------------------
  var navToggle = document.querySelector('.nav-toggle');
  var nav = document.getElementById('site-nav');
  if (navToggle && nav) {
    navToggle.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      navToggle.setAttribute('aria-expanded', String(open));
      navToggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    });
    nav.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') {
        nav.classList.remove('open');
        navToggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // --- Footer year -------------------------------------------------------
  var year = String(new Date().getFullYear());
  document.querySelectorAll('[data-year]').forEach(function (el) { el.textContent = year; });

  // --- Call-to-action wording --------------------------------------------
  // While the service is invite-only, "Get started" would lead to a form that
  // refuses; point people at the access request instead.
  (function () {
    var cfg = window.__EC__;
    if (!cfg || cfg.registrationOpen !== false) return;
    document.querySelectorAll('a[href*="mode=register"]').forEach(function (a) {
      var t = (a.textContent || '').trim().toLowerCase();
      if (a.classList.contains('btn-primary') && t.indexOf('choose') === 0) return;
      if (t.indexOf('start') === 0 || t.indexOf('get started') === 0 ||
          t.indexOf('create') === 0 || t.indexOf('clean my') === 0) {
        a.textContent = 'Request access';
      }
    });
  })();

  // --- Legal page table of contents --------------------------------------
  var tocLinks = document.querySelectorAll('.toc a[href^="#"]');
  if (tocLinks.length && 'IntersectionObserver' in window) {
    var byId = {};
    tocLinks.forEach(function (link) { byId[link.getAttribute('href').slice(1)] = link; });

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var link = byId[entry.target.id];
        if (!link) return;
        if (entry.isIntersecting) {
          tocLinks.forEach(function (l) { l.classList.remove('active'); });
          link.classList.add('active');
        }
      });
    }, { rootMargin: '-80px 0px -70% 0px', threshold: 0 });

    Object.keys(byId).forEach(function (id) {
      var heading = document.getElementById(id);
      if (heading) observer.observe(heading);
    });
  }
})();
