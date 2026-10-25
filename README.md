![Publish static sites](banner.svg)

# Publish static sites

> **Since 2.0 with history:** this also contains the former extension “Deploy log”. Under Projects → Publish you switch between **Sites** and **History** – every publish, every Git pull and every published site with time, commit, snapshot and result, one click back. The history per project stays a tab on every project, plus the tile. Anyone who had the deploy log gets this version automatically; data and settings stay.

Put a project online with one click – on GitHub Pages or Cloudflare Pages, free and with HTTPS. With a build command (e.g. npm run build), a check of the folder and history per site.

[Deutsch](README.de.md) · An official [Hostwerk](https://github.com/Passimoritz/hostwerk-public) extension (native extension, Hostwerk 2.10 or newer)

![Screenshot](docs/screenshot.png)

## What it does

- **Where:** Projects → Publish – no own sidebar entry since 1.3.0; the full page stays under Extensions → Open
- GitHub Pages without a local git: upload through GitHub's API into the branch gh-pages, Pages switched on, repository created on request
- Cloudflare Pages through Cloudflare's own tool (wrangler)
- Codeberg Pages (one commit with only the changes) and your own server per SFTP (stale files are removed)
- Own domain for every target (CNAME, Cloudflare custom domain, Codeberg .domains)
- Optional build command before every publish, with log
- Checks before uploading: index.html present, no .git, node_modules or .env, size limits
- Site check before publishing with Hostwerk's own site check (Hostwerk 3.0+, otherwise right on the built files): broken links, missing pictures/CSS/JS, root links that break on GitHub project pages, missing titles, left-over error messages – only warn, stop on problems or off; also as a “Check” button
- Tokens and SFTP logins sealed on this PC; history of the last 10 publishes per site with “Go back” (GitHub, Cloudflare)

## Install

In Hostwerk: **Extensions → Discover** and click “Install”.

Native extensions run as part of Hostwerk (own server and interface part). That is why Hostwerk only installs them from the official catalogue (with checksum) or in developer mode.

## Data

`data/static-publish` – sites and sealed tokens. Removing the extension keeps them; published pages stay online.

## Develop

```bash
node --test tests/*.test.js          # tests
node build-native.js .               # build the interface (sdk/build-native.js from hostwerk-public)
node check.js . --strict             # same check as the catalogue (sdk/check.js)
```

Interface source in `ui/src`, server part in `server/`. Texts in the code are English, German is in `locales/de.json`.

## License

MIT
