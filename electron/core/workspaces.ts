import type {AttachmentScope} from '../../src/attachment-types';
import {workspaceKey} from '../../src/work-types';
import type {Store} from './store';
import type {HostComputer} from './host';

export function assertWorkspaceScope(store:Store,scope:AttachmentScope){
  if(!scope||typeof scope.id!=='string'||!['bot','group'].includes(scope.kind))throw Error('无效会话');
  if(scope.kind==='bot')store.bot(scope.id);
  else if(!store.data.groups.some(group=>group.id===scope.id))throw Error('群聊不存在');
  return scope;
}
export function conversationWorkspace(store:Store,scope:AttachmentScope){return store.data.conversationWorkspaces?.[workspaceKey(scope)];}
export function setConversationWorkspace(store:Store,host:HostComputer,scope:AttachmentScope,value:string|null){
  assertWorkspaceScope(store,scope);
  const path=value===null?undefined:host.validateWorkspace(value);
  const settings=store.data.conversationWorkspaces||={};
  if(path)settings[workspaceKey(scope)]=path;else delete settings[workspaceKey(scope)];
  store.save();return path||null;
}
