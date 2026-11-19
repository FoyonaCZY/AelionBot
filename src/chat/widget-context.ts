import { createContext } from 'react';
import type { PinnedWidget, WidgetScope } from '../../shared/types/widget-types';

export interface WidgetHostValue {
  scope: WidgetScope;
  pinnedWidgets: PinnedWidget[];
}

export const WidgetHostContext = createContext<WidgetHostValue | undefined>(undefined);
export const WidgetMessageContext = createContext<string | undefined>(undefined);
