import { resetTestDOM } from "../../../test-support/boot-dom";
import {beforeEach, afterEach, expect, test} from 'bun:test';
import {act,createElement} from 'react';
import {app,state,showStatus,clearNotice} from '../../state';
import {setRenderer} from '../../paint';
import {setLang,t} from '../../lib/i18n';
import {acceptDaemonVersion,checkDaemonRelease,refreshDaemonUpdate} from '../../daemon-update';
import {renderReactScreen,leaveReactScreen} from './root';
import {DaemonUpdate,ManualUpdateHelp} from './daemon-update';
import {SettingsScreen} from './settings';
import type {LiveSession} from '../../lib/protocol/session-types';

beforeEach(resetTestDOM);

const originalFetch=globalThis.fetch;
const storageProto=Object.getPrototypeOf(localStorage);
const originalSet=Object.getOwnPropertyDescriptor(storageProto,'setItem')!;
let serial=0;
const render=(component: typeof ManualUpdateHelp | typeof SettingsScreen | typeof DaemonUpdate,props={})=>renderReactScreen(createElement(component,props));
async function connect(){
 state.phase='live';state.screen='settings';state.credential={daemonId:`review-${++serial}`} as typeof state.credential;
 state.live={isConnected:()=>true,daemonUpdateStatus:async()=>({available:true,phase:'idle',target:'',operation_id:''})} as LiveSession;
 globalThis.fetch=(async()=>new Response('1.1.0')) as typeof fetch;
 await act(async()=>{acceptDaemonVersion({build:'1.0.0'});await checkDaemonRelease(true);await refreshDaemonUpdate();});
}
afterEach(()=>{
 act(()=>leaveReactScreen());setRenderer(()=>{});state.live=null;state.credential=null;
 globalThis.fetch=originalFetch;Object.defineProperty(storageProto,'setItem',originalSet);
 setLang('zh');clearNotice();
});

test('persistent manual copy label follows language repaint',()=>{
 setLang('zh');act(()=>render(ManualUpdateHelp));
 const before=app.querySelector('button')!;expect(before.textContent).toBe(t('update.copyCommand'));
 setLang('en');act(()=>render(ManualUpdateHelp));
 expect(app.querySelector('button')===before).toBeTrue();
 expect(before.textContent).toBe(t('update.copyCommand'));
});

test('compact later hides even if browser storage is unavailable',async()=>{
 await connect();const paint=()=>render(DaemonUpdate,{compact:true});setRenderer(paint);
 act(paint);expect(app.querySelector('section.daemon-update')).not.toBeNull();
 Object.defineProperty(storageProto,'setItem',{...originalSet,value(){throw new Error('storage unavailable');}});
 const later=[...app.querySelectorAll('button')].find(b=>b.textContent===t('update.later'))!;
 act(()=>later.click());
 expect(app.querySelector('section.daemon-update')===null).toBeTrue();
 expect(app.querySelector<HTMLElement>('.daemon-update-host')?.hidden).toBeTrue();
});

test('persistent settings notice updates and clears through real subscription',()=>{
 state.screen='settings';state.live=null;clearNotice();
 setRenderer(()=>render(SettingsScreen));act(()=>render(SettingsScreen));
 const page=app.firstElementChild;
 act(()=>showStatus('review status'));
 expect(app.querySelector('[data-react-notice]')?.textContent).toBe('review status');
 expect(app.firstElementChild===page).toBeTrue();
 act(()=>clearNotice());expect(app.querySelector('[data-react-notice]')).toBeNull();
});

test('daemon release check updates the mounted subtree without repainting the app',async()=>{
 await connect();let paints=0;setRenderer(()=>{paints++;render(DaemonUpdate);});act(()=>render(DaemonUpdate));
 const host=app.firstElementChild,button=app.querySelector<HTMLButtonElement>('.daemon-update-check')!;
 let finish!:(r:Response)=>void;
 globalThis.fetch=(()=>new Promise(r=>{finish=r;})) as typeof fetch;
 act(()=>button.click());
 expect(app.firstElementChild===host).toBeTrue();
 expect(button.disabled).toBeTrue();expect(button.textContent).toContain(t('update.checking'));
 await act(async()=>{finish(new Response('1.1.0'));await checkDaemonRelease();await refreshDaemonUpdate();});
 expect(app.firstElementChild===host).toBeTrue();expect(app.querySelector('.daemon-update-check')===button).toBeTrue();
 expect(button.disabled).toBeFalse();expect(app.querySelector('.daemon-update-feedback')?.textContent).toContain('1.1.0');
 expect(paints).toBe(0);
});
