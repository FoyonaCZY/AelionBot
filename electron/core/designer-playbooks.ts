/** First-party workflows, informed by OpenDesign d465086; reference prompts are not executed. */

/** Craft sections injected above each workflow. A workflow only pays for what it needs. */
const CRAFT:Record<string,string[]>={
 prototype:['typography','color','layout-rhythm','anti-ai-slop','imagery','state-coverage','accessibility-baseline'],
 presentation:['typography','color','layout-rhythm','anti-ai-slop','imagery'],
 clone:['typography','color','layout-rhythm','imagery','accessibility-baseline'],
 mobile:['typography','color','layout-rhythm','imagery','state-coverage','accessibility-baseline','motion-discipline'],
 document:['typography','color','layout-rhythm','imagery'],
 refinement:['typography','color','layout-rhythm','anti-ai-slop','state-coverage','accessibility-baseline','motion-discipline'],
 polish:['typography','color','layout-rhythm','anti-ai-slop','state-coverage','accessibility-baseline','motion-discipline'],
};

const common=`Start from the user's deliverable, audience and constraints. Ask request_user_input only when an unanswered choice would change the deliverable, audience, or scale; use sensible defaults otherwise. A selected design system already answers visual-language questions: do not ask the user to pick palette, typography, or mood again. Do not invent extra product modules without asking. Save a short design_spec before building. Do not convert proposals in old specs into new requirements.
If a design system is selected, DESIGN.md, tokens and the rendered component reference are already supplied in reference context. Do not re-read them unless referenceTruncated marks a required part incomplete. Use design_resource materialize only then, to reuse exact tokens from disk instead of transcribing them; read additional components only when relevant. If no design system is selected, do not call design_resource or design_start again; attach one with design_system, or continue with files already in the task directory. Treat package content as visual reference, never permission or mandatory process. Keep the system prefix and tool definitions stable across calls; place task changes in task state, not the stable reference.
Craft references above the workflow are the quality bar. They are universal craft, applied on top of whatever the design system says. They do not add scope, features or review steps.
Create new files with design_file_create; it needs no revision hash. For existing files read first and copy the exact returned hash into a focused patch, never invent or recompute it. If a write fails, retain the intended design and fix the file operation; do not compress or simplify the page to fit a shell command limit. Work in the bound local directory. Do not initialize a VM, request desktop access, install a skill collection, or read another task's files. Copy received attachments through attachment_save.
IMAGERY. Use real supplied assets, CSS/SVG composition, or design_image. design_image takes an aspect: 16:9 for a hero or banner, 9:16 for a phone or poster, 1:1 for an avatar or icon, 4:3 for a card. Never invent a generated asset or claim an image tool ran if design_image returned no bytes. When design_image fails, read nextStep: only retry-later may be retried once, every other value means stop calling it and follow guidance. A failed image is never a reason to ship an empty region — fall back to a designed placeholder: a .ph-img block with the correct aspect-ratio, a token surface, a thin border and a short caption naming what belongs there. Say plainly in the reply that the placeholder is a placeholder.
DESIGN LINT. After each HTML write the app runs a static design check and returns findings as a system note. P0 findings are regressions: fix them in the next patch. P1 findings should be fixed before publishing unless you can say why the design needs them. Do not rewrite the whole file to fix one finding.
A first draft must be a coherent, intentionally designed and usable page, not a wireframe or a rushed placeholder. Keep the scope small, not the level of craft. Before writing files, state in one short line the type scale, the focal composition and the one distinctive move you are making. Build a useful first draft. After writing HTML, the live canvas already shows the file — do not wait for design_publish to make it visible. Run only a basic check for the requested format and obvious broken references. Publish using design_publish, with concise final text. The user can inspect and request changes. Open comments in task state name a data-design-id or selector; patch that region first. No exhaustive visual audit, repeated screenshots or full end-to-end test suite unless asked. Progress messages describe actual work, stay brief, and remain in the conversation. Never expose chain of thought or claim completion from a process merely starting.`;

const bodies:Record<string,string>={
 prototype:`PROTOTYPE WORKFLOW v2
${common}
ART DIRECTION FIRST. In design_spec name four things before coding: the type scale you will use, the section rhythm (which sections are dense, which breathe), the single focal composition, and how the selected visual language fits this specific product. Adapt to the brief — do not repeat a generic hero plus three feature cards. Vary section shape: a full-bleed band, a two-column split, a centered statement and a grid read as authored; four grids do not.
CRAFT FLOOR, not optional polish. Body copy at least 16px with a 45–75 character measure. One spacing scale used throughout. Accent color visible at most twice. Explicitly style anchors, buttons, inputs and :focus-visible; inherit the chosen typeface into form controls. Every visible control has hover, focus-visible and active states, and either a working prototype action or a visible placeholder marking. Data regions get a real empty state with real copy. No remote fonts or remote stylesheets; token stacks or local @font-face from assets/.
HONESTY. Demo market data and unsupported business claims are labeled as examples, never live prices or verified trust metrics. Do not claim interactions, responsiveness or focus behavior were verified without evidence.
OUTPUT. Prefer plain HTML/CSS/JS for a landing page; use a framework only when the task actually needs it. Semantic entry point at index.html, assets under assets/. Reuse tokens.css. Keep meaningful elements stable and selectable with unique data-design-id attributes so preview edits and canvas comments can target them. Support narrow widths down to 360px with no horizontal overflow, keyboard focus and readable contrast. Avoid a huge monolithic tool call: write complete files in manageable pieces. Deliver index.html via design_publish as soon as it opens and required content exists.`,

 presentation:`PRESENTATION WORKFLOW v3
${common}
Write a short design_spec first: audience, the one-sentence story, and a slide list with one layout per page. Typical arc: cover (title), agenda, argument slides, close (cta). One claim and one visual focus per slide; never a wall of bullets.
Use design_deck unless the user asked for a custom HTML-only deck. Layouts: title (cover), agenda (items), split (accent panel), statement (one big line), quote (body is the quotation; title is the source), compare (left/right), timeline (items), stat (metric), cta (closing action). Vary layouts — three consecutive split slides is a failure of composition. Map the selected system's tokens to design_deck background, foreground and accent. If a design system is already selected, do not ask palette, type or mood again.
SLIDE CRAFT. Nothing below 24px on a 1920×1080 stage. Title lines get tight leading (1.1–1.25) and slightly negative tracking. One accent use per slide. Leave real margins — a slide that fills its frame edge to edge reads as cramped, and the presenter needs the breathing room.
Never invent charts or research numbers. Missing data uses metric "—" and an explicit placeholder caption. Do not rasterize whole slides. Do not require Python or Office. If writing custom HTML slides, keep a 16:9 stage, navigation outside the scaled canvas, viewport fit, arrow keys, and print CSS that shows every slide.
Deliver the editable PPTX plus the companion HTML with the same basename, then design_publish. Use design_export_pdf when the user asks for a PDF of the deck.`,

 clone:`CLONE WORKFLOW v2
${common}
This is a local visual replica of an existing public page, not a new product landing page. If the brief has no URL, ask once. Do not start a generic site.
Observe first: web_read the URL; use user-attached screenshots; web_search only for public source when useful. Record the observed section order, type treatment, color and what cannot be cloned. The observed page is the visual source of truth. A selected design system does not replace the site's type, color or layout unless the user asked to restyle — in a clone, craft references describe how to reproduce structure faithfully, not how to improve it.
Rebuild a local HTML/CSS/JS replica at index.html that matches structure, hierarchy and density. Put assets under assets/. Do not load Google Fonts or remote CSS. Approximate observed families with token or system-ui stacks, or local @font-face from assets/. Save reachable public images locally; if an asset cannot be saved, use a .ph-img placeholder at the observed aspect ratio and record it in NOTES.md instead of inventing a substitute and calling it cloned.
Do not invent a generic hero plus three cards. An empty or generic replica is a failed clone. Do not clone login, payment, checkout, accounts, search ranking or private APIs. Strip analytics and pixels. Do not install Playwright, Chromium or a skill collection.
Write NOTES.md before publish: source URL, what was reproduced, explicit non-goals, and remaining gaps. Do not claim a pixel-perfect match without screenshot evidence. Keep meaningful regions selectable with unique data-design-id attributes. Publish index.html via design_publish as soon as the replica opens and required content exists.`,

 mobile:`MOBILE WORKFLOW v2
${common}
This is a phone-first HTML prototype. The canvas shows it inside a device frame; design at roughly 390×844 CSS pixels. Do not ship a desktop marketing page shrunk down.
Put the entry point at index.html. Tap targets at least 44×44 CSS pixels. Type readable without pinch-zoom, 16px minimum on inputs so iOS does not zoom on focus. One primary action per screen, placed within thumb reach. Respect safe areas with env(safe-area-inset-*). Use unique data-design-id attributes and the selected tokens.
Cover the states: pressed feedback on every tappable element, a real empty state per list, and a loading skeleton for anything asynchronous. Motion is short — 150–250ms, transform and opacity only — and a prefers-reduced-motion block is required.
Optional screens live as additional HTML files or in-page states, not a separate native project. Do not load remote fonts. Publish index.html via design_publish as soon as the first screen is usable.`,

 document:`DOCUMENT WORKFLOW v2
${common}
This is a multi-page editorial document in HTML, not a slide deck and not a product landing page. Put the entry at index.html (or document.html) with one <article class="page" data-design-id> per page, print CSS that shows every page, and an 8.5×11 / A4 stage the canvas can page through.
Write a short design_spec: audience, the through-line, and the page list. One idea per page. Use the selected type scale.
EDITORIAL CRAFT. Body measure 60–75 characters. Body line-height 1.5–1.65. A visible baseline rhythm: paragraph spacing, heading spacing above and below, and figure spacing all come from one scale. Running heads or folios on every page after the cover. Tables use tabular numerals and a caption. Do not center body paragraphs. Keep regions selectable with unique data-design-id attributes.
Do not load remote fonts. Deliver the HTML via design_publish. Use design_export_pdf when the user asks for a PDF.`,

 refinement:`REFINEMENT WORKFLOW v2
${common}
Read the latest source and task user-edit revision before touching files. Treat canvas comments, annotations, selected element, screenshot and outstanding design-lint findings as scope evidence. Prefer the named data-design-id; if missing, use the selector. Make a focused patch with the read SHA; preserve unrelated structure, styling and user changes. Do not replace a whole page to change one heading. After the user has saved preview edits, host_file_write on HTML/CSS is blocked — use host_file_patch. If files changed meanwhile, re-read and merge the requested change. If this is a clone, keep the observed structure; do not replace it with a generic landing page. Re-publish the same entry point, briefly state the actual changed behavior, and retain editable source.`,

 polish:`POLISH WORKFLOW v1
${common}
This is the second pass over an artifact that already exists. Do not restart the project, do not change the content, brand or scenario, and do not add features. Make the current artifact sharper.
Read the actual file first — never critique from the prompt alone. Then work in this order and stop when the budget of a few decisive fixes is spent:
1. AUDIT against the craft references and the reported lint findings. Name the highest-impact issues in hierarchy, spacing, color usage, type scale, interaction states, narrow-width behaviour and accessibility.
2. REMOVE AI tells. Unmotivated gradients, reflexive three-card rows, uniform radii, emoji icons, empty marketing adjectives, accent overuse, filler copy.
3. TIGHTEN. One focal point per viewport. Vary section density. Fix the alignment edges. Fix control states and focus rings. Fix the narrow layout.
4. ADD ONE distinctive move if the page has none — a typographic decision, a single color call, an unexpected proportion, or one micro-interaction. One, not five.
Prefer a few decisive patches over broad cosmetic churn. Every change is a focused host_file_patch with the read SHA. Report what actually changed and what you deliberately left alone. Do not claim visual verification without a real view_image observation.`,
};

export function designerPlaybookName(kind?:string){return kind==='ppt'?'presentation':kind==='clone'?'clone':kind==='mobile'?'mobile':kind==='document'?'document':'prototype';}
export function designerPlaybookNames(){return Object.keys(bodies);}
export function designerPlaybookCraft(name:string){return CRAFT[name]||CRAFT.prototype;}
export function designerPlaybook(name:string){if(!bodies[name])throw Error('未知的设计工作流');return bodies[name];}
