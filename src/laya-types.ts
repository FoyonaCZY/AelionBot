export type LayaVariant='mlx'|'standard';
export const DECISION_MODELS:ReadonlyArray<{id:LayaVariant;name:string;packageName:string;modelId:string}>=[
  {id:'standard',name:'Laya 标准版',packageName:'laya',modelId:'convaiinnovations/laya-multilingual'},
  {id:'mlx',name:'Laya Mac 版',packageName:'laya-mlx==0.2.0',modelId:'aac6fef/laya-multilingual-mlx'},
];
export interface LayaFeatureState {phase:'not-installed'|'preparing'|'installing'|'loading'|'cancelling'|'ready'|'disabled'|'error';installed:LayaVariant[];enabled:boolean;active?:LayaVariant;recommended?:LayaVariant;downloading?:LayaVariant;error?:string;supported:boolean;}
