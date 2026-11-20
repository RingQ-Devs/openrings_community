// Apply the saved light/dark choice before the page paints (same key as openrings.org).
(function () {
  try {
    var t = localStorage.getItem('or-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}
})();
