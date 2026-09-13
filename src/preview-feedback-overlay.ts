export interface FeedbackOverlayState {id:string;editVersion:number;text:string;pending:boolean;status:string;failed:boolean;language:string;fontFamily:string;fontSize:string;fontWeight:string;}
export interface FeedbackOverlayLayout {state:FeedbackOverlayState;rect:{x:number;y:number;width:number;height:number};visible:boolean;}
export interface FeedbackOverlayInput {id:string;editVersion:number;kind:'change'|'send'|'escape';text:string;}
