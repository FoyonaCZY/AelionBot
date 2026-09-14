import test from 'node:test';
import assert from 'node:assert/strict';
import {resizeElementBox,translateComponents} from '../src/preview-element-geometry';
test('resizing keeps the opposite edge fixed and prevents negative sizes',()=>{
 const start={width:200,height:100};
 assert.deepEqual(resizeElementBox(start,'nw',30,20),{width:170,height:80,x:30,y:20});
 assert.deepEqual(resizeElementBox(start,'e',50,80),{width:250,height:100,x:0,y:0});
 const clamped=resizeElementBox(start,'w',500,0);assert.equal(clamped.width,4);assert.equal(clamped.width+clamped.x,start.width);
});
test('corner aspect lock preserves proportions and existing translation expressions',()=>{
 const result=resizeElementBox({width:200,height:100},'nw',-40,-10,true);assert.equal(result.width/result.height,2);assert.equal(result.width+result.x,200);assert.equal(result.height+result.y,100);
 assert.deepEqual(translateComponents('none'),['0px','0px','']);assert.deepEqual(translateComponents('calc(10% + 4px) 20px'),['calc(10% + 4px)','20px','']);assert.deepEqual(translateComponents('10px 20% 3px'),['10px','20%','3px']);
});
