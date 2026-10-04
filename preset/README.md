# Generated preset patch

`../cordis.patch.yml` is generated from the DSH 0.2.0-rc.2 web bundle presets:

- `@deepseek-ai/dsh-web-app/presets/standard.patch.yml`
- `@deepseek-ai/dsh-web-app/presets/cordis.patch.yml`

It inserts the host plugin row and overrides `preset-standard` / `preset-cordis` by id, replacing the `compaction-basic` row with `dsh-compaction-fidelity/engine` and widening the tool-result pruner.

Regenerate after a DSH upgrade:

```powershell
$env:DSH_APP_NODE_MODULES="D:\DSH\DSH Desktop\resources\app\node_modules"
node ..\scripts\generate-preset-patch.mjs
```

