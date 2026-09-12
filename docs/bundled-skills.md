# Preinstalled skills

The eight packages in `assets/skills` are application assets, available to new and existing profiles without a network download or a one-time data migration. The original data-directory builtins, private skills, shared `.agents/skills`, and explicitly selected directories keep their existing behavior.

`electron/main.ts` provides the bundle directory to `Integrations`. Development reads the source assets; packaged builds read `resources/app.asar.unpacked/assets/skills`. The package file list and ASAR unpack rule both include the bundle. Python bytecode caches are excluded. Distribution assets are read-only in SkillLibrary, and per-Bot pin/archive/read state uses the stable `metadata.aelion-id`, independent of the installation path. Updates replace application assets, not user-owned skill files.

Only names/descriptions enter the skill catalog. Bodies and references are read on demand. `skill_materialize` copies the selected package, including its helpers and licenses, into the current Bot's VM workspace using the existing content digest. It does not scan other agents' private skill folders or install external services.

## Sources and adaptation

`assets/skills/manifest.json` records immutable upstream commits, source URLs and SHA-256 values, and license-file hashes. Each package carries its original upstream license and an explicit modification notice. OpenAI PDF and Anthropic frontend-design use Apache-2.0; OpenAI role-specific analytical workflows, superpowers, and the selected K-Dense literature-review skill use MIT. Check each individual skill's license, not merely the repository license, before adding a new source.

The office scripts and templates are original AelionBot implementations. No Anthropic DOCX/PPTX/XLSX skill content is distributed. Upstream runtime-specific tools and services have been replaced with actual Aelion tools, Writer/Calc/Impress, the real browser, and message attachments. Instructions use one English body and do not impose an output language.

## Verification

- `node --import tsx --test tests/bundled-skills.test.ts tests/integrations.test.ts tests/skill-catalog.test.ts`
- `python tests/bundled_skill_helpers_test.py` with openpyxl and python-pptx available.
- `npm run typecheck` and `npm run build`.
- Smoke-test Writer PDF/DOCX export, Impress PPTX/PDF export, Calc formula recalculation, and rendered pages with an isolated LibreOffice profile. Do not use a user's active VM or office profile for fixture tests.

The runtime already supplies LibreOffice, Poppler, openpyxl, pypdf, and python-pptx in its office profile. Skills check availability on older VMs; optional packages such as python-docx, pandas, Matplotlib, and ReportLab are not assumed installed. Helper scripts refuse output overwrite. Skills instruct the model to inspect actual document/browser output and attach selected final deliverables rather than exposing every intermediate file.
