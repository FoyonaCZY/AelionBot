import {createContext,useContext,useMemo,type ReactNode} from 'react';
import {conversationTimeLabels,type TimedMessage} from './conversation-time';
import './message-replies.css';

const Context=createContext<ReadonlyMap<string,string>>(new Map());
export function ConversationTimeProvider({messages,children}:{messages:readonly TimedMessage[];children:ReactNode}){
  const labels=useMemo(()=>conversationTimeLabels(messages),[messages]);
  return <Context.Provider value={labels}>{children}</Context.Provider>;
}
export function MessageTime({id,time}:{id:string;time:string}){
  const label=useContext(Context).get(id);
  return label?<div className="conversation-time"><time dateTime={time}>{label}</time></div>:null;
}
