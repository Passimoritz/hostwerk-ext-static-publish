## 1.1.0

- Own domain: CNAME for GitHub Pages, custom domain at Cloudflare, .domains for Codeberg. / Eigene Domain.
- Site check before publishing, right on the built files: broken links, missing pictures/CSS/JS, root links that break on GitHub project pages, missing titles, http:// content, left-over error messages – "only warn", "stop on problems" or off; also as a "Check" button. / Seiten-Check vor dem Veröffentlichen.
- History with "Go back": GitHub gets a new commit with the earlier files, Cloudflare rolls back to the earlier deployment. / Zurück auf frühere Veröffentlichung.
- New targets: Codeberg Pages (one commit with only the changes) and your own server per SFTP (login sealed, stale files removed). / Weitere Ziele: Codeberg Pages, eigener Server per SFTP.
- Tests for the GitHub upload with own domain, rollback, Cloudflare, Codeberg and SFTP against stand-ins. / Tests für Upload und alle Ziele.
- Error state with "Try again", dates in Hostwerk's language, place in the sidebar (Develop), other extensions may add tabs. / Fehlerzustand, Datum in Hostwerks Sprache, Seitenleiste.

## 1.0.0

- First release. / Erste Fassung.
