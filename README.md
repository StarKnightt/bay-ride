# Bay Ride

A small painted seaside bay in late summer. Walk the wooden pier and the beach, then take the little motorboat out across the bay towards the lighthouse island, under six times of day: morning, noon, golden hour, sunset, dusk and a moonlit night.

**Play:** https://starknightt.github.io/bay-ride/ (a desktop browser with a keyboard; click anywhere to start)

## Controls

On foot
- **W A S D** or the **arrow keys**: walk
- **Shift**: run
- **Space**: jump
- **Mouse**: look around
- **F** at the end of the pier: step down into the boat

In the boat
- **W / S**: throttle ahead and astern
- **A / D**: steer
- **Shift**: full speed
- **F** at the berth: step back up onto the pier
- **C**: change camera (chase, front, side); **V**: first person

Any time
- **T**: next time of day
- **M**: music on or off; **Shift + M**: mute everything
- **H** or **F1**: show or hide the controls card

The screen stays clean while you play; the controls card only appears when you ask for it.

## How it is made

Everything is generated in code; the heroine is modelled by script in Blender. The sea, sky, town, plants, birds, every sound and the music are built at runtime, and nothing is downloaded. The heroine is the one authored model: a Python script in `tools/character/` builds, rigs and animates her in Blender and exports `public/models/heroine.glb`, which the game draws with its own toon shading and outlines.

Built with three.js, TypeScript, Vite and pnpm.

## Run it locally

```sh
pnpm install
pnpm dev      # http://localhost:5431
pnpm build    # static site in dist/
```
