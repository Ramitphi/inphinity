# Readability pass

Goal: keep the retro look (DSEG7 LCD hero figures, Doto headlines, VT323 text, black on white paper) but make every number and label readable at a glance, including in a screen recording, at 1280px and 390px.

Screenshots: `before/` and `after/`, one per page (`markets`, `indices`, `fund`, `create`, `portfolio`, `bridge`) at `-desktop` (1280×800) and `-mobile` (390×844), full page, motion reduced.

| Area | Before | After | Why |
|---|---|---|---|
| Table prices and NAVs (`td .lcd`) | DSEG7 at 19px (16px on phone) with "8" ghosts at 7% opacity | VT323 at 26px (23px on phone), tabular, light stroke, no ghosts | A 7-segment "1" over a ghost "8" read as "8" ("181.60" looked like "18 1.60" and "115.16" like "885.16"). The decimal point was nearly invisible. |
| Hero LCD (big NAV, amount input) | DSEG7, ghosts at 7% | DSEG7 kept, ghosts at 3% (big) and 5% (input) | NAV "1.00" read as "8.00" |
| Muted grey `--muted` | `#6b6b6b` (4.85:1 on wash) | `#5c5c5c` (6.7:1 on white, 6.0:1 on wash) | WCAG AA with headroom |
| Green `--up` | `#0a8a3a`, 4.0:1 on the badge tint (fails AA) | `#0a7a33`, 4.9:1 on the tint, 5.4:1 on white | AA |
| Red `--down` | `#d0151b` (4.7:1 on its tint) | `#c0141a` (about 5.3:1) | More headroom on its tint |
| Input placeholders | Tailwind default `#9ca3af` (2.5:1) | `#767676` (4.5:1) | AA |
| Labels (`.eyebrow`, `.stat`, `.lbl`, table headers) | 16px VT323 | 18px (17px on phone), table-header tracking .08→.06em | VT323 renders about 30% smaller than a normal font at the same px |
| Box headers, names, sub, notes, dateline, footer, units, small buttons | 16–19px | 18–21px; note line-height 1.4, body 1.3 | Minimum size and line spacing |
| Change badges | 19px (16px on phone) | 20px (18px on phone); text uses the AA colours | Glanceable |
| Ticker tape | 18px, fixed 50s loop (~71px/s with 19 items) | 21px; duration is 5s per item (~40px/s) | It smeared in recordings |
| Inline small text (fund symbol 13px, ENS line 12px) | 12–13px | 17–19px | Was the smallest text in the app |
| Doto | Masthead and page titles only (28–68px) | Unchanged | Already large enough to read |

No horizontal page scroll at 390px on any page (`scrollWidth` = 390), before or after.

All changes are in one appended block at the end of `src/index.css`, plus 5 inline font sizes and the tape duration in `Header.tsx`/`Indices.tsx`/`Portfolio.tsx`. No changes to behaviour, data or copy.
