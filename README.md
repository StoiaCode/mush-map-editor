# MUSH Map Editor

A web app for hand-documenting the layout of tile-based MUSHes that have
multiple vertical levels. No build step, no accounts — it saves to your
browser. An optional self-hosted sync API lets you move a map between devices
or share it with someone else via a short code.

## Usage

Serve the folder with any static web server and open `mush-map-editor.html`
(it loads its JS as ES modules, so it needs `http://` or `https://`, not a bare
`file://` double-click). Your map auto-saves locally, and you can export or
import it as JSON for backups.

## Features

- Flat grid view, one layer at a time, with pan and zoom.
- Per-tile vertical model: UP and DOWN are real links to other rooms, so layers
  are an organizational tag rather than a fixed global height.
- Carve rooms in 8 compass directions plus up and down using the QWE/ASD/ZXC rose.
- Link rooms across layers and gaps, including non-adjacent connections.
- Rotatable 3D view of the whole map.
- Area rectangles for marking zones that span every layer.
- Color tags with an editable legend, onion-skin of neighbouring layers,
  multi-select with bulk edits, search, shortest-path finder, and a stats panel.
- Undo and redo, plus JSON export and import.
- Sync panel: upload a map to a short code, load it elsewhere, or delete it.
  Temporary only, unused maps are purged after 7 days. Requires the optional
  API described below; without it the panel just shows a connection error.

## Self-hosting (Docker)

The included `Dockerfile` serves the app with busybox httpd (a tiny ~1.5 MB base
image). The `compose.yaml` publishes no ports and instead joins an external
network named `pangolin`, so a reverse proxy on that network reaches the
container by name on port 80. Adjust or remove the network block to suit your
setup.

```bash
docker compose up -d --build
```

Maps are stored per browser via localStorage, so each visitor keeps their own
data. Use the JSON export for backups.

## Sync API (optional)

`compose.yaml` also defines `mush-map-api`, a small Flask + sqlite service
backing the Sync panel. It has no accounts: a map gets a random 6-character
code on upload, and that code is the only thing needed to load, overwrite, or
delete it. Maps untouched for 7 days are deleted automatically.

To enable it:

1. Copy `stack.env.example` to `stack.env` and set `CLIENT_KEY` to a random
   value (e.g. `openssl rand -hex 24`). This is not real authentication, since
   it ships readable in the frontend JS. It just filters out generic spam
   bots that probe for open POST endpoints.
2. Point your reverse proxy at `mush-map-api` on port 8000 as well (for
   example `/api/*` on the same domain as the frontend).

Skip both steps if you don't want the sync feature; the rest of the app works
the same without it.

## License

MIT. See [LICENSE](LICENSE).
