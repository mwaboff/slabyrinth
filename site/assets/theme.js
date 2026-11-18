/* global document, window, localStorage, matchMedia */
// Theme: follows prefers-color-scheme until the visitor picks one with the toggle (remembered locally).
// Runs in <head> so a saved choice applies before first paint. The page works without it.
(function () {
  "use strict";
  var KEY = "slabyrinth-site-theme";
  var root = document.documentElement;
  var saved = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch (e) {
    saved = null;
  }
  if (saved === "dark" || saved === "light") root.setAttribute("data-theme", saved);

  function current() {
    var t = root.getAttribute("data-theme");
    if (t === "dark" || t === "light") return t;
    return window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }

  document.addEventListener("DOMContentLoaded", function () {
    var btn = document.getElementById("theme-btn");
    if (!btn) return;
    var label = btn.querySelector(".sr-only");
    function sync() {
      var light = current() === "light";
      btn.setAttribute("aria-pressed", light ? "true" : "false");
      if (label) label.textContent = "Light mode";
      btn.title = light ? "Switch to dark mode" : "Switch to light mode";
    }
    btn.hidden = false;
    sync();
    btn.addEventListener("click", function () {
      var next = current() === "light" ? "dark" : "light";
      root.setAttribute("data-theme", next);
      try {
        localStorage.setItem(KEY, next);
      } catch (e) {
        /* private mode: the choice lasts for this page view */
      }
      sync();
    });
    if (window.matchMedia) {
      matchMedia("(prefers-color-scheme: light)").addEventListener("change", sync);
    }
  });
})();
