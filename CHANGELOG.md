## 1.3.0

- Lives where it belongs: Projects → Publish – no own sidebar entry any more (Hostwerk 3.0+); the full page stays under Extensions → Open and can be pinned in the sidebar settings. / Steckt jetzt dort, wo sie hingehört: Projekte → Veröffentlichen – kein eigener Seitenleisten-Eintrag mehr (Hostwerk 3.0+); die ganze Seite bleibt unter Erweiterungen → Öffnen und lässt sich in den Seitenleisten-Einstellungen anheften.

## 1.2.0

- The site check uses Hostwerk's own one (SDK 3.1, `host.service('sitecheck')`): Hostwerk serves the built folder for a moment and goes through it like a visitor – the same check as for projects, also finding var_dump output and framework debug pages. On older Hostwerk the built-in check on the files stays. / Seiten-Check nutzt Hostwerks eigenen (SDK 3.1): Ordner kurz bereitgestellt und wie ein Besucher abgerufen; auf älterem Hostwerk bleibt der eingebaute.
- The report says how it was checked; a missing output folder gives a clear message instead of an error. / Bericht sagt, wie geprüft wurde; fehlender Ausgabeordner mit klarer Meldung.

## 1.1.0

- Own domain: CNAME for GitHub Pages, custom domain at Cloudflare, .domains for Codeberg. / Eigene Domain.
- Site check before publishing, right on the built files: broken links, missing pictures/CSS/JS, root links that break on GitHub project pages, missing titles, http:// content, left-over error messages – "only warn", "stop on problems" or off; also as a "Check" button. / Seiten-Check vor dem Veröffentlichen.
- History with "Go back": GitHub gets a new commit with the earlier files, Cloudflare rolls back to the earlier deployment. / Zurück auf frühere Veröffentlichung.
- New targets: Codeberg Pages (one commit with only the changes) and your own server per SFTP (login sealed, stale files removed). / Weitere Ziele: Codeberg Pages, eigener Server per SFTP.
- Tests for the GitHub upload with own domain, rollback, Cloudflare, Codeberg and SFTP against stand-ins. / Tests für Upload und alle Ziele.
- Error state with "Try again", dates in Hostwerk's language, place in the sidebar (Develop), other extensions may add tabs. / Fehlerzustand, Datum in Hostwerks Sprache, Seitenleiste.

## 1.0.0

- First release. / Erste Fassung.
