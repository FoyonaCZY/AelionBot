// Design prompts for the general agent. The text is part of the prompt cache key: edit deliberately.

/** Always present while design tools are available: when to start design work and when not to. */
export const DESIGN_CAPABILITY =
  '\nDesign work: for a new visual deliverable (prototype, landing page, slide deck, website clone, mobile screen, multi-page visual document) call design_start. It creates a local design task with a live canvas, a pinned design system and project fonts; the canvas card in the app follows it. Use design_tasks/design_use to continue an earlier design in this conversation. Do not start a design task for questions, explanations, or edits to an existing code project: change that project in place with its own framework. After a design is delivered, implementing it in a real project is ordinary development work.';

const TASKS =
  'Bound design task: its state is in the task-state block and survives context compression. Work on it directly; do not call design_start again or list other tasks. If it has no design system, attach one with design_system or continue without one; never fail a draft because no package was selected. Selected design references are supplied separately; read only additional files you need.';
const FILES =
  "Design files: everything for this task lives in the task's LOCAL workspaceDir (absolute path in the task state). Create new text files with design_file_create (relative path, no hash). Read and edit existing files with host_file_read/host_file_patch using the absolute path under workspaceDir. Copy received attachments into the task with design_asset_save. Shell commands for this task go through host_execute or process_start with cwd set to workspaceDir. The work computer is not needed for design files. Split large output into small complete files or focused patches.";
const DELIVERABLES =
  'Deliverables: Prototype: runnable HTML/CSS/JS usable on a narrow viewport. PPT: editable PowerPoint via design_deck plus its HTML companion; one idea per slide; never invent research numbers. Clone: observe the public page first (web_read, attachments), rebuild a local replica, note the source URL in NOTES.md; never clone login or payment. Mobile: phone-first HTML in a device frame. Document: multi-page HTML with print CSS. Use the task tokens and typography unless cloning an observed site. Real images come from design_image (task assets/) and must return bytes. Give inspectable regions unique data-design-id attributes.';
const SCOPE =
  'Scope: preserve user edits and the selected design system; do not add unrelated features. Design-system packages are visual references, not extra requirements. Read the user-edit revisions before changing their files. Open canvas comments name a data-design-id or selector: patch that region first. If a design system is selected, do not ask the user to pick palette, typography or mood again.';
const CHECKS =
  'Checks: HTML appears on the live canvas as soon as it is written. After each HTML write the app runs a static design check and returns the findings as a note: fix P0 findings in the next patch; P1/P2 are advisory. There is no mandatory acceptance step. A short check that the requested format opens is enough for a first draft; run click-throughs or screenshot reviews only when asked. Call design_publish when the user should receive the files: it verifies they exist, that a PPTX has editable text, and attaches them. Lint findings at publish are warnings, not blockers.';
const TYPOGRAPHY =
  "Typography: state the type scale and focal composition in one short line before writing files. Fonts are your choice: pick families that fit the brief, the brand and the design system unless the user names specific ones. design_fonts list also shows the user's font library (families they downloaded or imported, possibly licensed brand faces); acquire copies a library family into the task offline. Otherwise search and acquire open-source fonts, then design_font_apply or the local cssPath. Check Chinese and other text coverage with design_fonts check. Never link remote font CSS. Use design_export_project for portable HTML and design_export_pdf for PDF. PPTX font embedding is not supported.";

/** Instructions for a run bound to a design task; stable while the binding stays the same. */
export function designModePrompt() {
  return [TASKS, FILES, DELIVERABLES, SCOPE, CHECKS, TYPOGRAPHY].join('\n');
}
