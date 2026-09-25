# Mammotion Map Card

[![CI](https://github.com/leonardpitzu/lovelace-mammotion-map-card/actions/workflows/ci.yml/badge.svg)](https://github.com/leonardpitzu/lovelace-mammotion-map-card/actions/workflows/ci.yml)

A [Home Assistant](https://www.home-assistant.io/) dashboard card that draws the
mowing map of a [Mammotion](https://mammotion.com/) robot mower - zones, obstacles,
paths, mow progress, dock and live mower position - as plain SVG on a flat card
background.  No tile server, no Leaflet, no satellite imagery.

At the zoom a lawn needs, an aerial photo is the only basemap with anything on it
and a road map is an empty grey rectangle, so this card skips the basemap entirely
and renders the geometry the [Mammotion integration](https://github.com/mikey0000/Mammotion-HA)
already exposes through its `mammotion.get_*_geojson` services.

Written for my own garden.  It is not in the HACS default store and no support is
offered - fork it or install it by hand.

## Features

| Feature | Description |
|---|---|
| Zone rendering | Mowing areas, obstacles and connecting paths, using the colours, weights and opacities the integration supplies per feature |
| Mow progress | The mown path from `mammotion.get_mow_progress_geojson`, refreshed on a timer that **survives a failed poll** instead of cancelling itself |
| Live mower | Position and heading from the mower's `device_tracker`, drawn as a rotating arrow, with a GPS-accuracy halo when the mower reports one |
| Feature hiding | Drop features by `type_name` or by name - the escape hatch for NetRTK models, which report a phantom `RTK Base` sitting on top of the dock |
| Auto framing | Bounds are recomputed from the data on every render, so the plot fills the card and the mower is never clipped if it strays outside the mapped zones |
| Plot-shaped card | The card's aspect ratio follows the shape of the actual garden, clamped to sane limits |
| Theme-aware | Labels, dock and mower follow the Home Assistant theme rather than a hardcoded palette |
| Pixel-space rendering | Geometry is projected to screen pixels against a `ResizeObserver`, so stroke widths and label sizes stay honest at any card width |
| No dependencies | Single bundle, no Leaflet, no external image assets |

## Installation

1. Copy `dist/mammotion-map-card.js` into your Home Assistant `config/www/` directory.
2. Add it under **Settings** -> **Dashboards** -> **⋮** -> **Resources** as
   `/local/mammotion-map-card.js`, type **JavaScript module**.
3. Hard-refresh the browser - the old bundle is cached aggressively.

HACS works too, as a custom repository of type **Dashboard** pointing at this repo.

## Configuration

### Requirements

The [Mammotion integration](https://github.com/mikey0000/Mammotion-HA) must be
installed and the mower must have a **synced map**.  Confirm there is something to
draw before adding the card:

```yaml
action: mammotion.get_geojson
target:
  entity_id: lawn_mower.mower
```

An empty response means the map has not been synced from the Mammotion app yet.

### Custom card

Substitute your own entity ids; the Mammotion integration names them after the
mower, and the `device_tracker` slug is doubled.

```yaml
type: custom:mammotion-map-card
entity: lawn_mower.mower
tracker: device_tracker.mower_mower
title: Garden
hide_names:
  - RTK Base
```

### Hiding the phantom RTK base

On mowers positioned by **NetRTK** - corrections over the network, with no physical
base station in the box - the integration still emits an `RTK Base` station feature,
placed a couple of centimetres from the dock.  It is a placeholder, not a reading,
and it renders as a second icon underneath the dock.  `hide_names: ["RTK Base"]`
removes it.

Mowers with a real RTK antenna should leave it visible.

## Options

| Name | Type | Default | Description |
|---|---|---|---|
| `entity` | string | **required** | The `lawn_mower.*` entity.  Used as the target for the `mammotion.*` GeoJSON services. |
| `tracker` | string | `null` | The mower's `device_tracker.*` entity.  Omit to hide the mower marker. |
| `title` | string | `null` | Card header.  No header is rendered when unset. |
| `hide_types` | list | `[]` | Hide features by `type_name`: `area`, `obstacle`, `path`, `station`. |
| `hide_names` | list | `[]` | Hide features by name, e.g. `RTK Base`. |
| `show_labels` | boolean | `true` | Draw zone names and their area in m². |
| `show_progress` | boolean | `true` | Draw the mown path.  Disabling it also stops the progress service call. |
| `progress_interval` | number | `180` | Seconds between progress refreshes.  Clamped to a minimum of 30.  Static geometry is re-fetched every 10th tick. |
| `padding` | number | `18` | Pixels of breathing room between the plot and the card edge. |

## Credits

- [mikey0000/Mammotion-HA](https://github.com/mikey0000/Mammotion-HA) for the
  integration and the GeoJSON services this card renders.

## License

MIT - see [LICENSE](LICENSE).
