export interface OperationDenial {
 source:'user'|'model';reason:string;operation?:string;command?:string;cwd?:string;path?:string;tool?:string;server?:string;content?:string;arguments?:string;
}
