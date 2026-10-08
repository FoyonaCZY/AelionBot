// Native dialogs make the rest of the document inert without adding [inert].
const modalSelector = 'dialog[open],.modal-backdrop,.group-editor-layer,.scheduled-layer';

export function previewBlockedByModal(doc: Document = document): boolean {
  return Boolean(doc.querySelector(modalSelector));
}

/** Watch mounted overlays and dialogs that open/close without being remounted. */
export function observePreviewModal(change: () => void, doc: Document = document): () => void {
  let blocked = previewBlockedByModal(doc);
  const observer = new MutationObserver(() => {
    const next = previewBlockedByModal(doc);
    if (next !== blocked) {
      blocked = next;
      change();
    }
  });
  observer.observe(doc.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['open', 'class'],
  });
  return () => observer.disconnect();
}
