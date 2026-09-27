import type { InteractionRequest } from '../../../shared/types/core';
import type { HostPermissionMode } from '../../../shared/types/permission-types';
export type HostPermissionRequest = Extract<InteractionRequest, { kind: 'host_permission' }>;
export interface ApprovalAssessment {
  kind: 'allow' | 'ask' | 'review';
  mode: HostPermissionMode;
  reason: string;
  source?: 'full' | 'low-risk' | 'rule';
  ruleId?: string;
  reviewer?: string;
}
export interface ModelApproval {
  decision: 'allow' | 'deny' | 'ask';
  reason: string;
  reviewer?: string;
}
export interface HostApprovalPolicy {
  modeFor(request: HostPermissionRequest): HostPermissionMode;
  assess(request: HostPermissionRequest): ApprovalAssessment;
  review(request: HostPermissionRequest, signal: AbortSignal): Promise<ModelApproval>;
}
