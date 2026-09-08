import {createContext,useContext} from 'react';

export const PreviewLayoutContext=createContext(false);
export const useImmersivePreview=()=>useContext(PreviewLayoutContext);
