# Kokoro2D

Kokoro2D is an experimental, browser-native 2D VTuber maker and viewer. It uses
an original JSON model format and a small WebGL2 mesh renderer with no runtime
dependencies.

This first milestone is intentionally focused: it proves that layered artwork,
deformable meshes, parameter keyforms, procedural performance, microphone lip
sync, and portable model files can live in one understandable codebase.

## Try it

```bash
cd /Users/ethan/playground/kokoro2D
npm start
```

Open <http://localhost:5173> for the Maker or
<http://localhost:5173/viewer.html> for the standalone Viewer.

Running from `file://` is not supported because the application uses browser ES
modules.

## Maker workflow

1. Import separated PNG, WebP, JPEG, or SVG layers with the **+** button.
2. Select a layer and adjust its base transform.
3. Choose a parameter and move it away from its default value.
4. Create a keyform at that value.
5. Adjust the transform or drag mesh vertices on the stage.
6. Animate the preview and export a `.kokoro2d` model.

The editor autosaves to browser local storage. `Cmd/Ctrl+Z`, redo, and
`Cmd/Ctrl+S` are supported.

## Viewer features

- WebGL2 textured triangle meshes
- Additive parameter/keyform evaluation
- Procedural head, body, eye, mouth, blink, and secondary hair motion
- Pointer-directed gaze
- Optional microphone-driven mouth movement
- Loading portable `.kokoro2d` files
- Transparent rendering canvas suitable for future OBS integration

## Model format

Version 1 `.kokoro2d` files are UTF-8 JSON. Layer images are embedded as data
URLs, making each exported puppet self-contained. A model contains:

- metadata and canvas settings;
- canonical parameter definitions;
- ordered image layers;
- grid meshes with UVs and triangle indices;
- additive transform and vertex-offset keyforms; and
- declarative physics settings reserved for the runtime.

The schema implementation and validation live in `src/model.js`. Version 1 is
an alpha format and may change before the first stable release.

## Development

```bash
npm test
npm run check
```

There is no dependency installation step. Node is used only for static checks
and tests; the application itself runs directly in a modern browser.

## Current boundaries

This alpha does not yet include PSD import, masks, blend modes, automatic mesh
generation around opaque pixels, a timeline, face tracking, or Inochi model
import. It also does not read Live2D `.moc3` files.

The next production milestone should add masking and blend modes, a versioned
ZIP container, deterministic physics, image-aware mesh generation, browser
integration tests, and an adapter for the VTuber agency's performance intents.

## License

MIT. The bundled Kokoro-chan sample is declared CC0 in its model metadata.
