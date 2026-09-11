import {useEffect,useRef} from 'react';
import {Compartment,EditorState} from '@codemirror/state';
import {EditorView,drawSelection,highlightActiveLine,highlightActiveLineGutter,keymap,lineNumbers} from '@codemirror/view';
import {defaultKeymap,history,historyKeymap,indentWithTab} from '@codemirror/commands';
import {HighlightStyle,StreamLanguage,syntaxHighlighting} from '@codemirror/language';
import {tags} from '@lezer/highlight';
import {python} from '@codemirror/legacy-modes/mode/python';
import {javascript,typescript,json} from '@codemirror/legacy-modes/mode/javascript';
import {c,cpp,csharp,java} from '@codemirror/legacy-modes/mode/clike';
import {rust} from '@codemirror/legacy-modes/mode/rust';
import {go} from '@codemirror/legacy-modes/mode/go';
import {css} from '@codemirror/legacy-modes/mode/css';
import {xml} from '@codemirror/legacy-modes/mode/xml';
import {shell} from '@codemirror/legacy-modes/mode/shell';
import {yaml} from '@codemirror/legacy-modes/mode/yaml';
import {powerShell} from '@codemirror/legacy-modes/mode/powershell';
import {sourceLanguage} from './source-language';
import {useI18n} from './i18n';
import './source-editor.css';

const modes={python,javascript,typescript,json,c,cpp,csharp,java,rust,go,css,xml,bash:shell,yaml,powershell:powerShell};
const highlight=HighlightStyle.define([{tag:tags.keyword,color:'#c4a2de'},{tag:[tags.string,tags.regexp],color:'#abd1ad'},{tag:[tags.number,tags.bool],color:'#dfb893'},{tag:tags.comment,color:'#92969f'},{tag:[tags.function(tags.variableName),tags.typeName],color:'#9bbce4'}]);
export default function SourceEditor({name,content,lineSeparator,readOnly,onChange,onSave}:{name:string;content:string;lineSeparator:'\n'|'\r\n';readOnly:boolean;onChange:(text:string)=>void;onSave:()=>void}){
  const {t}=useI18n();
  const host=useRef<HTMLDivElement>(null),view=useRef<EditorView|undefined>(undefined),editable=useRef(new Compartment()),change=useRef(onChange),save=useRef(onSave);change.current=onChange;save.current=onSave;
  useEffect(()=>{
    if(!host.current)return;const mode=modes[sourceLanguage(name) as keyof typeof modes];
    const editor=new EditorView({parent:host.current,state:EditorState.create({doc:content,extensions:[
      lineNumbers(),history(),drawSelection(),highlightActiveLine(),highlightActiveLineGutter(),EditorState.tabSize.of(4),EditorState.lineSeparator.of(lineSeparator),
      keymap.of([{key:'Mod-s',run:()=>{save.current();return true;}},indentWithTab,...defaultKeymap,...historyKeymap]),
      editable.current.of([EditorState.readOnly.of(readOnly),EditorView.editable.of(!readOnly)]),
      EditorView.contentAttributes.of({'aria-label':t('编辑 {name}',{name}),spellcheck:'false'}),
      EditorView.updateListener.of(update=>{if(update.docChanged)change.current(update.state.sliceDoc());}),
      ...(mode?[StreamLanguage.define(mode)]:[]),syntaxHighlighting(highlight),
      EditorView.theme({'&':{height:'100%',backgroundColor:'#202125',color:'#d8d9e1'},'.cm-scroller':{fontFamily:'var(--font-code)',fontSize:'var(--text-code,13px)',fontWeight:'var(--weight-body)',lineHeight:'1.85',overflow:'auto'},'.cm-content':{padding:'106px 0 86px',caretColor:'#d8d9e1'},'.cm-line':{padding:'0 22px 0 16px'},'.cm-gutters':{backgroundColor:'#202125',color:'#737783',borderRight:'1px solid #ffffff0c'},'.cm-gutterElement':{padding:'0 12px',minWidth:'48px'},'.cm-activeLine,.cm-activeLineGutter':{backgroundColor:'#ffffff05'},'&.cm-focused .cm-selectionBackground,.cm-selectionBackground':{backgroundColor:'#5c486c66'},'.cm-cursor':{borderLeftColor:'#e1d9eb'}},{dark:true}),
    ]})});view.current=editor;editor.focus();return()=>{view.current=undefined;editor.destroy();};
  },[]);
  useEffect(()=>{view.current?.dispatch({effects:editable.current.reconfigure([EditorState.readOnly.of(readOnly),EditorView.editable.of(!readOnly)])});},[readOnly]);
  return <div className="fp-editor-host" ref={host}/>;
}
