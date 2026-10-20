import { readableContent } from './activity';
import { stripBlockMarkers } from './message-blocks';

const controls = ['[群聊静默]', '[表情静默]'];
const tags = ['<think>', '</think>', '<thinking>', '</thinking>', '<analysis>', '</analysis>'];
// A partial control token or reasoning delimiter is never user-facing text.
export function streamingReplyText(raw: string) {
  const at = raw.lastIndexOf('<');
  if (at >= 0 && tags.some((tag) => tag.startsWith(raw.slice(at).toLowerCase()))) raw = raw.slice(0, at);
  let text = readableContent(raw);
  if (controls.some((control) => control.startsWith(text))) return '';
  for (const control of controls) text = text.replaceAll(control, '');
  const controlAt = text.lastIndexOf('[');
  if (controlAt >= 0 && controls.some((control) => control.startsWith(text.slice(controlAt))))
    text = text.slice(0, controlAt);
  // Placement markers are for the block renderer; a half-streamed one is not user-facing text.
  text = stripBlockMarkers(text);
  const blockAt = text.lastIndexOf('[[');
  if (blockAt >= 0 && !text.slice(blockAt).includes(']]')) text = text.slice(0, blockAt);
  return text.replace(/@\{[^}]*$/, '').trim();
}
