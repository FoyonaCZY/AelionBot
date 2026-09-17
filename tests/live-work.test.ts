import test from 'node:test';
import assert from 'node:assert/strict';
import {liveWorkTitle,summarizeCommand,type LiveWorkItem} from '../src/live-work';

test('live work titles stay short and prefer the command',()=>{
  assert.equal(summarizeCommand('npm  test\n --watch'),'npm test --watch');
  const item:LiveWorkItem={id:'1',botId:'bot',runId:'run',kind:'process',command:'npm test',cwd:'/repo',location:'host',purpose:'task',createdAt:'2026-09-17T00:00:00Z'};
  assert.equal(liveWorkTitle(item),'npm test');
  assert.equal(liveWorkTitle({...item,command:''}),'后台任务');
});
