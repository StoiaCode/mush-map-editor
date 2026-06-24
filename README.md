# MUSH Map Editor

A single-file web app for hand-documenting the layout of tile-based MUSHes that
have multiple vertical levels. Everything runs from one HTML file and saves to your browser.

## Usage

Open `mush-map-editor.html` in any modern browser. Your map auto-saves locally,
and you can export or import it as JSON for backups.

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

## License

MIT. See [LICENSE](LICENSE).
