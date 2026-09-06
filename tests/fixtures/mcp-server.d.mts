import type {Server} from '@modelcontextprotocol/sdk/server/index.js';
export function fixtureServer():Server;
export function httpFixture():Promise<{url:string;close:()=>Promise<void>}>;
