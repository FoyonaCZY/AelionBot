import type {WireMessage} from './shared';
export type BotType='general'|'designer';
export function botType(value:unknown):BotType{if(value===undefined||value==='general')return 'general';if(value==='designer')return value;throw Error('无效 Bot 类型');}
export type DesignTaskKind='prototype'|'ppt'|'clone';
export type DesignOrigin={kind:'bot';id:string}|{kind:'group';id:string}|{kind:'peer';id:string};
export interface DesignSystemSummary{id:string;name:string;category:string;description:string;version:string;bytes:number;colors:string[];source:string;license:string;}
export interface DesignSystemFile{path:string;sha256:string;bytes:number;}
export interface DesignSystemManifest extends DesignSystemSummary{files:DesignSystemFile[];}
export interface DesignSystemCatalog{version:1;sourceCommit:string;sourceUrl:string;systems:DesignSystemManifest[];}
export interface DesignArtifact{path:string;name:string;kind:'html'|'pptx'|'pdf'|'other';revision:string;bytes:number;verifiedAt:string;}
export interface DesignUserEdit{id:string;path:string;revision:string;time:string;summary:string;}
export interface DesignCheck{id:string;label:string;status:'pending'|'passed'|'failed';executionId?:string;detail?:string;}
export interface DesignSession{
 location?:'host'|'vm';workspaceDir?:string;workflowVersion?:string;
 id:string;botId:string;origin:DesignOrigin;title:string;kind:DesignTaskKind;brief:string;
 engineVersion:'designer-v1';systemId:string|null;systemVersion:string|null;
 status:'draft'|'running'|'awaiting-input'|'review'|'completed'|'paused'|'failed';
 stage:'brief'|'build'|'verify'|'delivery';revision:number;createdAt:string;updatedAt:string;
 designSpec:string;constraints:string[];artifacts:DesignArtifact[];userEdits:DesignUserEdit[];checks:DesignCheck[];
 runIds:string[];activeRunId?:string;workspacePath:string;lastError?:string;
}
export interface DesignSessionInput{botId:string;origin?:DesignOrigin;kind:DesignTaskKind;title?:string;brief:string;systemId?:string|null;}
export interface DesignSessionUpdate{id:string;revision:number;title?:string;systemId?:string|null;designSpec?:string;constraints?:string[];}
export interface DesignerSnapshot{systems:DesignSystemSummary[];sessions:DesignSession[];}
export interface DesignHistory{messages:WireMessage[];summary:string;}
export interface DesignSystemDetail extends DesignSystemSummary{design:string;tokens:string;components:string;}
