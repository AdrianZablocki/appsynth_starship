# Starship: launch and return

Interactive 3D simulation of a Starship flight test, ported from `mock/` (design export) to Next.js 16 + React 19 + TypeScript + Three.js r147. Super Heavy launches from Starbase, boosts back and is caught by the tower; Starship coasts on a suborbital trajectory, deploys eight Starlink simulators, re-enters and splashes down in the Indian Ocean at sunset. Static export, no server.

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # static site in out/
npm run lint && npm run typecheck
```

## Structure

- `src/sim/mission.ts` – ascent profile (four passes tune the final flight-path angle for the target trajectory), Super Heavy return (boostback cutoff found by bisection so the landing burn ends over the tower) and the Starship coast, lifting entry and landing burn. Pure data, no DOM.
- `src/sim/vehicleShape.ts` – Starship hull profile (barrel and ogive nose) and lathe-profile helpers.
- `src/sim/shaders.ts` – GLSL: Earth and cloud bake, atmosphere scattering, sky, Starbase terrain cap, splashdown ocean, stars, particles, plumes, re-entry plasma.
- `src/sim/createSim.ts` – scene, mission events, hot-stage ring debris, particles, cameras and the frame loop. Returns a `Sim` handle and reports `Snapshot`s (keys and raw numbers, no copy).
- `src/i18n/dictionary.ts` – EN/PL/DE/FR copy; locale from the browser until the visitor picks one. Numbers use the locale's decimal separator.
- `src/components/` – `LaunchSimulator` (lifecycle, overlays, toast), `MissionHud` (mission card and event log), `Telemetry` (per-vehicle engine maps), `ControlConsole`.

Three.js is pinned to 0.147: the scene relies on the pre-r152 colour pipeline (`sRGBEncoding`, `ColorManagement.legacyMode`). It loads as a separate chunk after the page renders. Touch devices and small screens get the `balanced` quality (lower pixel ratio, 2K shadows and Earth bake, fewer particles). `prefers-reduced-motion` turns off camera shake and lift-off vibration.
