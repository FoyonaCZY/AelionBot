import {useLayoutEffect,useRef,type SelectHTMLAttributes} from 'react';
import './select.css';

export function Select({className='',onKeyDown,...props}:SelectHTMLAttributes<HTMLSelectElement>){
  const root=useRef<HTMLSelectElement>(null);
  useLayoutEffect(()=>{
    const select=root.current;if(!select||!CSS.supports('appearance','base-select'))return;
    // React 19 validates the legacy select content model. Let the browser own
    // this new native part while React continues to manage the options.
    const button=document.createElement('button'),content=document.createElement('selectedcontent');
    button.type='button';button.tabIndex=-1;button.append(content);select.prepend(button);
    return()=>button.remove();
  },[]);
  return <select {...props} ref={root} className={`aelion-select ${className}`} onKeyDown={event=>{
    // Let the picker handle these keys before the surrounding dialog does.
    if((event.key==='Escape'||event.key==='Tab')&&event.currentTarget.matches(':open'))event.stopPropagation();
    onKeyDown?.(event);
  }}/>;
}
