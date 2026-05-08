// Single source of truth for the app's release version.
// Both index.html (footer) and sw.js (cache key) read from here, so
// bumping a release is a one-line change.
//
// `self` is the global in both window contexts and service workers,
// so this file works for both via `<script src>` and `importScripts()`.
self.APP_VERSION = 'v290';
