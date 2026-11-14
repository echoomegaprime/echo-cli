// Registers the ECHO Prime service worker (installability + offline fallback).
// External on purpose: the page CSP allows scripts from 'self' only, never inline.
// Registration is best-effort and never blocks or breaks the app.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
