import test from 'node:test';import assert from 'node:assert/strict';
import {groupEventPrompt,GROUP_STATE_EVENT_PROMPT} from '../electron/core/group-prompt';
import {groupContributionContext} from '../electron/core/group-response';import type {GroupRoom} from '../src/group-types';
test('group instructions stay English without imposing a reply language',()=>{
 const prompt=groupEventPrompt('Team','g','Bot',[],'Build a project.')+GROUP_STATE_EVENT_PROMPT+groupContributionContext({messages:[]} as unknown as GroupRoom,'r','b',[]);
 assert.doesNotMatch(prompt.replaceAll('[群聊静默]',''),/[\u3400-\u9fff]/);assert.doesNotMatch(prompt,/response language|interface language|latestHumanMessage/i);
});
