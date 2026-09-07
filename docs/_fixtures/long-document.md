---
title: "Layout Stress Fixture"
slug: layout-stress-fixture
lang: en
created: 2026-09-07
tags:
  - fixture
  - layout
summary: "A long document used to stress-test scrolling and the docked player."
---

# The Layout Stress Fixture

This document exists to be long. Not meaningful — long. It exercises the
scroll container, the docked player, and everything that breaks when content
exceeds the viewport. Read it aloud if you must; it will not be offended.

## 1. Why Length Matters

A layout that works with a hundred characters is not a layout. It is a
screenshot of a layout. Real documents have sections, and sections have a
nasty habit of continuing past the bottom of the window, where the docked
things live.

> "The scroll container is the first thing a document tests and the last
> thing a developer checks."

The reader should scroll. The player should stay. The sidebar should mind
its own business. These are not aspirations; they are the acceptance criteria.

## 2. The Anatomy of a Broken Page

When the wrong element scrolls, everything appears to work — until you look
at the bottom. The player, which should be docked, has quietly left the
building, trailing somewhere below the fold like a caboose that lost its train.

### 2.1 Symptoms

- The outermost container grows a scrollbar it was never meant to have.
- The content column, which should scroll, sits smugly still.
- The player exists in the DOM but not in the viewport, which amounts to
  the same thing as not existing.
- The file tree's wrapper scrolls while its contents watch from above.

### 2.2 Causes

Absolute positioning applied to the wrong ancestor. A `main` that is not a
`nui-main`. A height computed from nothing, arriving at nothing, containing
nothing. These are the usual suspects, and they are usually guilty.

## 3. Tables, Because Documents Have Them

| Element | Should scroll? | Actually scrolled? |
|---------|---------------|--------------------|
| `nui-main` | Yes | Only if it exists |
| `nui-content` | No | No — it clips |
| The viewport | No | Only when things go wrong |
| `.tts-player` | Never | It must dock |
| `nui-file-tree` | Its own list | Not its wrapper |

## 4. Code Blocks Are Non-Negotiable

```javascript
// The whole bug, in one expression
const scrollContainer = document.querySelector('nui-main');
if (!scrollContainer) {
	throw new Error('You used <main>. The scroll went to the viewport. Fix it.');
}
```

```css
/* The fix, in four declarations */
nui-content { display: flex; flex-direction: column; }
nui-main { flex: 1; min-height: 0; }  /* overflow-y: auto comes with NUI */
#tts-mount { flex: none; }
```

## 5. Lists in Various Flavors

1. First, the document must be long enough to scroll.
2. Second, the scroll must happen in the right container.
3. Third, the player must remain visible at all times.
4. Fourth, the test must use a real document, not a hundred polite characters.

- Unordered lists are paragraphs with commitment issues.
- They still take up vertical space, which is what we need here.
- More items mean more scrolling, and more scrolling means more truth.

## 6. The Middle of the Document

This is the part nobody reads. It exists so that the beginning and the end
are far apart. If you are reading this in the middle of a scroll test, note
whether the player is still docked at the bottom of the viewport. If it is,
the middle has done its job.

### 6.1 A Subsection for Good Measure

Depth is important. A flat document is a short document wearing a trench
coat. Subsections give the eye places to stop and give the scroll bar
something to do between the interesting parts.

### 6.2 Another Subsection

The second subsection is like the first, but with the confidence that comes
from having been preceded. It contains exactly one insight: length is a
feature, not an accident.

## 7. On Docks and Docking

A docked element does not scroll. This sounds trivial until you implement it
wrong. The dock is not "at the bottom of the content"; it is *outside* the
content, looking in. The content scrolls past it. The dock remains.

The player is a dock. The status bar is a dock. The header is a dock. The
document is the water. When the water rises, the docks do not get wet.

## 8. Extended Filler With Structural Variety

Lorem ipsum is for cowards. Real filler has opinions. This filler believes
that scroll containers should be explicit, that heights should come from
flex layout rather than arithmetic on rem values, and that `calc(100% - 6.5rem)`
is a cry for help dressed as a stylesheet.

It further believes that a test document should contain sentences long
enough to wrap several times on a reasonably wide viewport, because
wrapping is where height comes from, and height is where scrolling comes
from, and scrolling is the entire reason this document exists, so let this
sentence do its part with dignity and verbosity.

## 9. A Second Table, Longer

| # | Claim | Verdict |
|---|-------|---------|
| 1 | Short tests find short bugs | True |
| 2 | Mock content hides layout failures | True |
| 3 | The viewport should never scroll in app mode | True |
| 4 | The player belongs in the scroll flow | False |
| 5 | Flexbox beats calc() for docking | True |
| 6 | One fixture beats ten guesses | True |
| 7 | Hidden tabs pause rAF | True, and irrelevant here |
| 8 | Absolute positioning composes with flex | Only with overrides |
| 9 | The wrapper should scroll for the list | False |
| 10 | Real documents are the only real test | True |

## 10. Approaching the End

The end of the document is where the player lives, if the layout is broken.
By the time you scroll here — and you should have scrolled — the player
should have been visible the entire journey, pinned below the content like
a good dock, indifferent to the water level.

If it was not, the fixture has earned its keep. Fix the layout. Scroll again.

## 11. The Final Section

This is the last section. It is short, because endings should be. The
document's only remaining duty is to stop — which it now does, having been
long enough for long enough.
