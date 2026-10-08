import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { observePreviewModal, previewBlockedByModal } from '../src/preview/preview-modal';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('game dialog blocks previews while open, and releases queued work on close', async () => {
  const { document, MutationObserver } = parseHTML('<html><body><dialog class="gg-dialog"></dialog></body></html>');
  const previous = globalThis.MutationObserver;
  globalThis.MutationObserver = MutationObserver;
  const states: boolean[] = [];
  const stop = observePreviewModal(() => states.push(previewBlockedByModal(document)), document);
  try {
    const dialog = document.querySelector('dialog')!;
    assert.equal(previewBlockedByModal(document), false);
    dialog.setAttribute('open', '');
    await tick();
    assert.deepEqual(states, [true]);
    dialog.appendChild(document.createElement('p'));
    await tick();
    assert.deepEqual(states, [true], 'game updates must not retrigger queued previews');
    dialog.removeAttribute('open');
    await tick();
    assert.deepEqual(states, [true, false]);
    stop();
    dialog.setAttribute('open', '');
    await tick();
    assert.deepEqual(states, [true, false], 'unmounted preview must stop observing');
  } finally {
    stop();
    globalThis.MutationObserver = previous;
  }
});

test('nested overlays remain blocked until all close, including removal of an open dialog', async () => {
  const { document, MutationObserver } = parseHTML('<html><body></body></html>');
  const previous = globalThis.MutationObserver;
  globalThis.MutationObserver = MutationObserver;
  const states: boolean[] = [];
  const stop = observePreviewModal(() => states.push(previewBlockedByModal(document)), document);
  try {
    const overlay = document.createElement('div');
    document.body.appendChild(overlay);
    overlay.className = 'modal-backdrop';
    await tick();
    const wrapper = document.createElement('div');
    wrapper.innerHTML = '<dialog open class="gg-dialog"></dialog>';
    document.body.appendChild(wrapper);
    await tick();
    overlay.remove();
    await tick();
    assert.deepEqual(states, [true]);
    wrapper.remove();
    await tick();
    assert.deepEqual(states, [true, false]);
    for (const name of ['group-editor-layer', 'scheduled-layer']) {
      overlay.className = name;
      document.body.appendChild(overlay);
      await tick();
      assert.equal(previewBlockedByModal(document), true);
      overlay.remove();
      await tick();
    }
    assert.deepEqual(states, [true, false, true, false, true, false]);
  } finally {
    stop();
    globalThis.MutationObserver = previous;
  }
});
