export function previewHistoryShortcut(event:Pick<KeyboardEvent,'key'|'ctrlKey'|'metaKey'|'altKey'|'shiftKey'|'isComposing'>):'undo'|'redo'|undefined{
 if(!(event.ctrlKey||event.metaKey)||event.altKey||event.isComposing)return;
 const key=event.key.toLowerCase();if(key==='z')return event.shiftKey?'redo':'undo';if(key==='y'&&!event.shiftKey)return 'redo';
}
/** Let native inputs, rich text and source editors own their text undo history. */
export function previewTextInput(event:Pick<KeyboardEvent,'composedPath'>){return event.composedPath().some(target=>target instanceof HTMLElement&&(target.isContentEditable||target.matches('input,textarea,select,[role="textbox"],.cm-editor')));}
