import type { WireMessage } from '../types/core';
export function visibleImages(messages: WireMessage[]) {
  // ContextView owns archival. Protocol conversion must not rewrite old input
  // merely because another image has been appended.
  return messages.flatMap((message) => message.images || []);
}
