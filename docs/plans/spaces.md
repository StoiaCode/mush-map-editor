# Plan: Spaces (pocket maps for non-euclidean areas)

Status: planned, not started. Written 2026-10-02.

## The problem

Mappers increasingly hit "non-euclidean" layouts. An apartment block fronts the
street at (3,3) z0, but its UP exit leads to rooms the mapper had to put at
(50,50) z1, because multi-room floors don't fit next to the compact street
tiles. The editor can already represent this: exits are links by room id, so
position never affected connectivity. The trouble is reading the map. Nothing
tells you that (50,50) z1 is "upstairs at the apartment block", and the far-off
rooms clutter the main grid.

## The idea in one paragraph

A **space** is a named, separate grid with its own layers. Every room belongs
to exactly one space: the main map, or a named one. Exits stay exactly as they
are, so an exit can cross from the main map into a space and back. A space's
**anchors** (its "doors") aren't stored; they're computed as the rooms outside
the space that have exits into it. A space with one door is the classic pocket
building. Two doors, front and back, need nothing special. A space that links
two distant streets also just works. Rooms that were mapped in the wrong place
can be **captured** into a space after the fact, with a preview, and
**released** back to the main map.

## Non-negotiable: you always know where you are

The biggest risk is UX, not code. A mapper must never be confused about which
map they're looking at, think a room got deleted when it's really in another
space, or edit the wrong grid. Every phase below follows these rules, and
Phase 2 (orientation) ships **before** anything that creates spaces through
the UI.

1. **Location is always on screen.** The topbar's `Layer 0` label becomes a
   breadcrumb: `Main map › Layer 0`, or `Main map › Highrise Apts › Layer 1`.
   It's never hidden, collapsed, or abbreviated to an icon.
2. **Spaces look different from the main map.** Each space has an accent color.
   Inside a space, the viewport gets a solid frame in that color with the space
   name pinned in the top-left corner, and the grid is tinted. The main map has
   no frame. One glance tells you which one you're in, even with the breadcrumb
   scrolled out of view on a phone.
3. **Every switch is announced.** Entering or leaving a space (door click,
   search jump, undo, path step, go-to-room) shows a short toast: "Now in
   Highrise Apts · Layer 1". There are no silent teleports.
4. **Nothing is ever unreachable.** A Spaces panel lists every space with room
   counts and doors, including spaces with **no doors left** ("orphaned"), which
   get a warning badge. Search covers all spaces and labels results with where
   they are. "My rooms vanished" should always have a one-click answer.
5. **Destructive confirms name the location.** "Delete 'Lobby' (in Highrise
   Apts, Layer 0)?" Deleting a room that is a space's only door warns
   separately: "This is the only door into Highrise Apts (14 rooms). Those rooms
   will not be deleted; the space will show as orphaned in the Spaces panel."
6. **Selection never spans spaces.** Switching spaces clears the selection.
   Bulk delete and bulk edit can't reach rooms you can't see.
7. **Undo says where it happened.** The undo snapshot already includes
   `currentLayer`, and `currentSpace` goes in the same place. If an undo or redo
   changes the space you're viewing, show the toast from rule 3 so the change
   doesn't look like the map jumped around for no reason.

## Data model

```js
// map
{
  version: 3,
  rooms: { ... },
  spaces: [ { id, name, color } ],     // new; main map is implicit
  currentSpace: null,                  // new; null = main map
  currentLayer: 0,
  areas: [ { ..., space: null } ],     // areas belong to one space
  ...
}

// room
{ ..., x, y, z, space: null }          // null/absent = main map
```

- `x, y, z` stay local to the room's space. A space reuses the same
  `GRID_N` grid internally, so there's no 20x20 cap and no clamping surprises.
  The size the user sees is just the bounding box of its rooms.
- Anchors and doors are derived, never stored:
  `doorsOf(spaceId)` = every exit `(fromRoom, dir, toRoom)` where exactly one
  side is in the space.
- `normalize()` backfills `spaces: []`, `currentSpace: null`, `room.space =
  null`, `area.space = null`, and drops `room.space` values that point at
  missing spaces (those rooms fall back to main; this only matters for corrupt
  data).
- Version bumps to 3. An older client that loads a v3 map ignores `space` and
  stacks space rooms on top of main-map rooms. That's acceptable because the app
  is served from one place, but it's worth a line in the release notes for
  anyone keeping old exported JSON around.

## Phase 1: Scope the map by space (no new UI)

Purely internal. When it's done, a map with no spaces behaves exactly as it
does today.

- `model.js`: add `S.map.currentSpace`. Make every occupancy and layer helper
  take a space:
  - `roomAtCell(space, z, x, y)`
  - `roomsOnLayer(z)` becomes `roomsOnLayer(z, space = S.map.currentSpace)`
  - `layersPresent(space = S.map.currentSpace)`
- Call sites to update. This is the full list from a grep; recheck before
  starting:
  - `model.js`: `createRoom` (stamp `space`), `deleteRoom` layer fallback,
    `changeRoomLayer`, `carve` (both branches), `areaAtCell`, `roomsInArea`.
  - `render-flat.js`: layer label, room rendering, onion skin (`z ± 1` must stay
    in the same space), exit connector pairing at ~line 116 (only pair if same
    space **and** same layer; otherwise it's a stub), transit edges at ~line 202
    (same rule).
  - `render-3d.js`: render only the current space for now.
  - `interactions.js`: click-to-create at ~298, group drag occupancy at ~261,
    marquee/select pool at ~206.
  - `inspector.js` `gotoRoom`: also set `currentSpace = r.space`.
  - `toolbar.js` ~321: recenter logic.
  - `app.js` `fitInitial`.
  - `export-import.js`: occupancy set at ~132 must key on `space:z:x:y`; "add"
    import must remap space ids the way it remaps room ids.
  - `stats-legend.js`: per-layer counts become per-space-per-layer.
  - `persistence.js`: `normalize`, `afterRestore` (validate `currentSpace` too).
- Pathfinder and search need no logic changes (they're id-based), only the
  display changes in Phase 2.

**Done when:** all existing behavior is identical on current maps, and a
hand-edited JSON with a space in it renders the two grids separately.

## Phase 2: Orientation and navigation

Implements the "always know where you are" rules. Ships before any UI that
creates spaces.

- **Breadcrumb** replaces `#layerLabel`: `Main map › Highrise Apts › Layer 1`.
  The "Main map" crumb is clickable and goes back. The layer arrows keep working
  inside the current space.
- **Space frame and tint** on `#viewport` when `currentSpace` is set, in the
  space's accent color, with the name pinned top-left. Check both light and
  dark themes and phone width.
- **Toasts** on every space change (rule 3). Use one shared helper so no code
  path can forget it: route every change through `setSpace(id, {reason})`.
- **Door rendering:**
  - On the side you're viewing, an exit that leaves the space draws as a door
    stub, styled differently from off-layer stubs (a door glyph plus the space
    name or "Main map"). Rooms that are anchors get a small badge with the
    target space's room count, e.g. `⧉ 14`.
  - Clicking a door stub or badge enters the other side and centers on the
    connected room, with the toast.
- **Inspector:** the room header shows its location ("Highrise Apts ·
  Layer 1"). In the exit list, exits that cross spaces show the destination's
  location and a "Go" button.
- **Search:** results list their location; jumping across spaces goes through
  `setSpace` (toast).
- **Pathfinder:** when the route crosses spaces, the directions list marks the
  hand-off ("→ enters Highrise Apts"), and clicking a step goes to it.
  Highlighting only covers rooms in the current view, which is fine.
- **Selection:** clear it on space change (rule 6).
- **Confirms:** update the delete dialogs in `inspector.js` and
  `interactions.js` to name the location (rule 5), and add the only-door
  warning.

## Phase 3: Spaces panel

A toolbar button `⧉ Spaces` opens a panel like the Transit and Traits ones.

- One row per space: name, accent color, room count, layer count, and its
  doors ("Main St (3,3) · Layer 0 ↑"). Each door links to that room.
- Orphaned spaces (no doors) get a warning badge and sort to the top.
- Actions per space: rename, recolor, **Enter**, **Release to main map**
  (Phase 5), **Delete space** (only enabled when empty; to delete the rooms, the
  user enters the space and deletes them the normal way, so the existing
  confirms and undo apply).
- "New empty space" button, for mappers who know up front that a building is
  non-euclidean. It creates the space and enters it. Linking it to a door uses
  the existing Link mode, which needs to allow picking a target in another
  space. Link mode already lets you change layers mid-link, so this extends
  that to changing spaces mid-link.

## Phase 4: Capture ("move into a space")

Two entry points that end in the same preview.

**A. Through a door (the common case).** Select the street room, and the
inspector offers "Move what's behind this exit into a space…" on each exit.
Picking UP on (3,3) means: start from the room UP leads to, flood-fill along
exits, and never cross back through that one exit. That exit is the **cut**.

**B. From a selection (the escape hatch).** Multi-select rooms by hand and
choose "Move selection into a space…". No flood fill: exactly those rooms.
Boundary exits are computed from the selection.

**Fill rules (A only):**
- Never cross the cut.
- Never enter rooms that are already in a different space. They're boundaries
  automatically.
- If the fill reaches the anchor room itself by another path, that's a **hard
  leak**. The building connects back to the street some other way. Capture is
  blocked until it's resolved in the preview.
- Soft warning when the fill is suspiciously big (over 50 rooms, or over 25% of
  the source space's rooms). It's probably leaked into the street grid through
  a side door the mapper forgot.

**Preview (capture mode):** a modal map state like path mode, with a banner
that can't be missed and Esc to cancel. Map editing is disabled while it's
active.
- Captured rooms are highlighted in the target space's accent color, and
  everything else is dimmed. The preview switches layers so you can check every
  floor; the layer arrows show a count per layer of captured rooms.
- Boundary exits (the cut plus any other exits that leave the captured set) are
  drawn as red door markers and listed in the banner: "3 doors will connect
  this space to the main map: Main St (3,3) ↑, Back Alley (4,7) ↓, …". Usually
  you expect one, so an unexpected second door is the clearest warning sign
  that something leaked.
- **Click a highlighted room to exclude it.** That adds a cut in front of it
  and re-runs the fill, so it drops out along with everything reachable only
  through it. Click again to put it back. This is how the mapper fixes a leak
  without starting over.
- The banner shows the totals and the target: "Move **14 rooms** on **3
  layers** into [new space: name field] / [existing space ▾]". The button
  label repeats the number: **Move 14 rooms**. No triple confirm. A clear
  preview plus one-step undo is safer than dialogs people learn to click
  through.

**Applying:**
- Keep the layout. Translate the captured rooms' bounding box so it sits
  centered on the space grid, and shift z so the lowest captured layer becomes
  layer 0. (Optionally keep the original z, as a checkbox. Some mappers may want
  "floor 1" to stay layer 1.)
- If capturing into an existing space, place the block next to the space's
  current contents so nothing overlaps; if it can't fit without overlap, put it
  on fresh layers.
- Areas: rooms move, area rectangles don't. If an area ends up empty because
  everything in it moved, mention it in the result toast rather than deleting
  it.
- Transit lines keep working (id-based); stations in the space get door-style
  stubs on the main map.
- One `commit()` for the whole operation, so one Ctrl+Z restores it. Then
  enter the new space and show the toast.

## Phase 5: Release ("move back to the main map")

From the Spaces panel, or from inside a space.

- Enters a placement mode on the main map: a ghost of the space's footprint
  follows the cursor and shows red where it would overlap existing rooms. Click
  to drop. z placement defaults to "the door's layer + 1" for an UP door,
  otherwise the original layers.
- Releasing part of a space (for example, one floor got captured by mistake):
  multi-select inside the space, then "Move selection to main map", same ghost
  placement.
- A fully released space is left empty, and the panel offers to delete it.
- One commit, toast, done.

## Phase 6: Polish (optional)

- Carving UP/DOWN from a room could offer "into a new space" as an alternative
  to the same-cell carve.
- 3D view: render a space floating above its first door, faded, toggleable.
- Export filter: choose spaces as well as layers and areas.
- Sync/URL preview: no protocol change (whole-map JSON), but the preview should
  open on the main map regardless of the sender's `currentSpace`.

## Testing

There's no test harness in the repo, so verification is manual in the browser
preview, plus a fixture map checked into `docs/plans/fixtures/` that has:
- the apartment case (one door, 3 floors),
- a two-door building (front and back),
- a building with a fire escape back to a different street tile (must produce
  a leak in capture A),
- a transit line with a station inside a space,
- a space whose only door has been deleted (orphan).

Checks for each phase: load the fixture, walk every door both ways, undo and
redo across a space switch, delete an anchor room, search for a room in a
space from the main map, capture and release round-trip (positions restored by
undo), and an old v2 map loading unchanged.

## Decisions

- **Layer labels inside a space default to floors relative to the door.** The
  space's first door (doors sorted by outside room id, then direction) sets the
  reference: if room B at space layer `zb` is reached by going `dir` from a
  room outside, then layer `z` is shown as `Floor (z - zb + dz)`, where `dz` is
  +1 for UP, -1 for DOWN, 0 for compass exits. The apartment reached by UP
  reads "Floor +1, Floor +2, …"; a building you walk into reads "Floor 0" for
  the ground floor. A space with no doors falls back to "Layer n". Tooltips
  still show the raw layer number. A per-space setting can come later.
- **Capture through a door takes one cut only.** Click-to-exclude in the
  preview handles the rest. Multiple cuts up front can come later if mappers
  ask for them.
