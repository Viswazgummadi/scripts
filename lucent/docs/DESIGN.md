# Design

## One token file

`design/tokens.json` holds every colour, opacity, radius, space, type size, duration and shadow.
Nothing else in the repository may contain a colour: `make check` rejects a `#hex` or `rgb()` in a
stylesheet template.

| Group | What it is |
|---|---|
| `color.dark`, `color.light` | The two sides. Colours are `[r, g, b]`; opacity is given where the colour is used. `fill` is the ink of a side (white on dark, black on light). |
| `material` | Named opacities: `popover` 0.88, `card` 0.06, `hairline` 0.08, `hover` 0.15, `smoke` 0.45 and its lighter and heavier steps. |
| `radius` | 6 / 12 / 20 / 28 / 36 px. |
| `space`, `type`, `motion` | Spacing steps, font sizes, durations in milliseconds. |
| `elevation` | Three shadows. |
| `contrast` | Promises, checked on every build (below). |

In a template (`stylesheet.in.css`):

```css
background: @{rgba:surface,material.popover};   /* a colour at a named opacity */
color: @{rgb:text-body};
border-radius: @{radius.md}px;
box-shadow: @{elevation.2};
```

The build writes `stylesheet-dark.css` and `stylesheet-light.css`; GNOME Shell loads the one that
matches the current style. Extensions that draw from JavaScript get a generated `tokens.js`
(`"tokens": true` in the extension's `build.json`).

## Two sides in one file

Some extensions cannot let the shell pick the side. Lucent Glass chooses per surface while it runs,
and the launcher has its own dark/light setting. For those, a block between `/* @sides */` and
`/* @end */` is written twice into a single `stylesheet.css`, with `@side` in its selectors replaced
by `dark` and `light` and the colours taken from that side:

```css
/* @sides */
.lucent-menus-@side .popup-menu-content { background: @{rgba:surface,material.popover}; }
/* @end */
```

## Contrast is calculated

A glass surface has no fixed background: whatever window is behind it shows through. So each
material is specified against the worst case. An entry under `contrast` names a text colour, a
material and the worst backdrop (a white window behind a dark material, a black one behind a light
material); the build composites them, computes the WCAG ratio and fails below the minimum.

| Pair | Ratio | Needs |
|---|---|---|
| Popover title, dark material over a white window | 7.33 | 7.0 |
| Popover body, dark material over a white window | 4.85 | 4.5 |
| Popover title, light material over a black window | 11.86 | 7.0 |
| Popover body, light material over a black window | 7.71 | 4.5 |
| Bar text over a bright wallpaper, medium smoke | 5.81 | 4.5 |

The bar numbers were also measured on screen: white text over the brightest part of a wallpaper was
2.0:1 with clear glass, 4.0:1 with the light smoke, 5.9:1 with the medium one, 9.0:1 with the heavy one.

## The glass recipe

Blur behind, a slight saturation boost, a low-opacity tint, a one-pixel highlight along the inner
top edge, a hairline outer stroke, and a soft layered shadow. The blur and saturation come from the
compositor (Blur my Shell for shell surfaces, the launcher's own effect for its panel); the rest is
in these stylesheets.

What this does not do: real refraction. St and Mutter cannot bend the image behind an arbitrary
shape. Blur my Shell's Liquid Glass pipeline approximates a rim on rectangles; Lucent does not fake more.

## Which side a surface gets

Themes do not always follow the light/dark setting, and some mix light and dark text within one
menu. Lucent Glass therefore asks the theme: it builds a hidden stand-in for a typical piece of text
on each surface (a menu item, a Quick Settings toggle label, a calendar day, a notification body),
reads the colour St resolves for it, and gives the surface the dark material if that text is light
and the light material if it is dark. In the calendar it also sets every text colour itself, so text
and material cannot disagree.

## Control Centre and Notification Centre

Quick Settings and the calendar panel follow a phone's Control Centre (Lucent Glass, setting
`panel-style`: `glass`):

- **Behind:** while either is open, everything behind it is blurred and dimmed 35 %, as a phone
  does. This is what allows the panel itself to be see-through: the dim lowers the worst-case
  backdrop (a white window) and the blur turns sharp text behind into a soft field.
- **Panel:** 66 % tint (80 % when the dim is switched off), a bright hairline edge, a deep shadow.
  Corners are 36 px for Quick Settings and 30 px for the calendar, the same radii Blur my Shell
  gives their blur, so the two never disagree at the corners.
- **Cards:** every control sits on its own card (8 % ink, 18 px corners). With 18 px of padding inside
  a 36 px panel, inner and outer corners are concentric.
- **Toggles:** the icon sits in a circle that takes the accent colour when the toggle is on; the
  arrow of a toggle with a menu is part of the same card.
- **Sliders:** a 30 px bar on a card that fills with white.
- **Text:** titles at 95 % ink, subtitles at 78 %. The contrast gates in `tokens.json` compute the
  whole stack (white window, dim, panel, card, text) and fail the build below 4.5:1.

What it does not change: GNOME's own layout of Quick Settings. Regrouping its toggles into separate
modules would mean moving shell widgets around, which breaks across GNOME updates.
