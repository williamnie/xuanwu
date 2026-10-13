import assert from 'node:assert/strict';
import test from 'node:test';
import { projectMappingRows, updateProjectMapping, removeProjectMapping, appendProjectMapping } from './projectMappingsModel.js';

test('structured mapping edits keep unrecognized raw segments and other mappings unchanged',()=>{
  const value='unknown:future=value, chat:-100=old\nuser:42=keep';const rows=projectMappingRows(value);
  assert.equal(rows.length,2);
  const next=updateProjectMapping(value,rows[0],{project:'new'});
  assert.equal(next,'unknown:future=value, chat:-100=new\nuser:42=keep');
  assert.equal(projectMappingRows(next)[0].project,'new');
});
test('add and remove affect only the explicitly selected mapping',()=>{
  const value='chat:-100=one,user:42=two';const rows=projectMappingRows(value);
  assert.equal(removeProjectMapping(value,rows[0]),',user:42=two');
  assert.equal(appendProjectMapping(value,'chat:-200','three'),'chat:-100=one,user:42=two,chat:-200=three');
});
