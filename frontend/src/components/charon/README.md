# Charon hero scene

`CharonScene.tsx` owns the lazy-loaded Three.js scene in `scene.js`. The original
143-card staggered layout, card textures, avatars, lantern, Solana mark, shaders,
and radial privacy wave are retained. Three.js r169 and its MIT license are kept
in `vendor/`; that upstream source is excluded from application linting.

Only browser runtime code lives here. There are no video exports, FFmpeg tools,
audio tracks, or dependencies on a separate animation package. Artwork is reused
from `frontend/public`; Inter and its license live in `public/fonts`.

The camera opens on one transaction and pulls back over 3.2 seconds. The landing
page then reveals its frosted panel. Moving over the background, tapping a card,
or dragging hides the panel; it returns after 1.7 seconds of inactivity. Holding
a drag keeps it hidden. The visible panel retains pointer events so the waitlist
button can be reached without dismissing it. Clicking Charon or the scene's
lantern toggles privacy. The waitlist button is deliberately unwired.

The scene resizes to its container, caps rendering at 30fps and pixel ratio at
1.5, and pauses offscreen or in a hidden tab. Reduced motion skips the opening
zoom and continuous motion. A static grid covers loading and WebGL failures.
Observers, listeners, frames, GPU resources, and pending initialization are
cleaned up on unmount, including React Strict Mode cleanup.

Layout and the panel's visibility timer live in `pages/Landing.tsx` and
`pages/Landing.css`. Adjust `introTime` in the scene and the idle timeout in the
page to tune the two timings.
