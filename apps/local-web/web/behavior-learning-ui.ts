import {parsePermissionJson} from './wallet-ui.js';

/** The JSON remains the only submitted source of truth, including restored drafts. */
export function habitLearningPreference(text:string):boolean {
 const parameters=parsePermissionJson(text);
 const value=parameters['learn_confirmed_habits'];
 if(value===undefined)return false;
 if(typeof value!=='boolean')throw Error('learn_confirmed_habits must be true or false.');
 return value;
}

export function setHabitLearningPreference(text:string,enabled:boolean):string {
 const parameters=parsePermissionJson(text);
 return JSON.stringify({...parameters,learn_confirmed_habits:enabled},null,2);
}
