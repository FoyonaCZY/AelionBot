import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,cpSync,readdirSync,existsSync} from 'node:fs';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Store} from '../electron/core/store';
import {SkillLibrary} from '../electron/core/skill-library';
import type {IntegrationPaths} from '../electron/core/integration-paths';

const bundled=resolve('assets/skills');
const manifest=JSON.parse(readFileSync(join(bundled,'manifest.json'),'utf8')) as {skills:Array<{id:string;directory:string;sources:Array<{commit:string;sha256:string;licenseFile:string;licenseSha256:string;license:string}>}>};
function fixture(t:test.TestContext){
  const root=mkdtempSync(join(tmpdir(),'aelion-bundled-skills-'));
  t.after(()=>{assert.equal(dirname(root),resolve(tmpdir()));assert.ok(basename(root).startsWith('aelion-bundled-skills-'));rmSync(root,{recursive:true,force:true});});
  const paths:IntegrationPaths={homeDir:join(root,'home'),projectDir:join(root,'project'),dataDir:join(root,'data'),configDir:join(root,'config'),env:{},bundledSkillDir:bundled};
  for(const dir of [paths.homeDir,paths.projectDir,paths.dataDir,paths.configDir])mkdirSync(dir,{recursive:true});
  const store=new Store(paths.dataDir);t.after(()=>store.close());
  return {root,paths,store};
}

test('preinstalled skills are available in new and migrated profiles without replacing user skills',t=>{
  const {paths,store}=fixture(t),bot=store.data.bots[0];
  // Simulate an old installation which already completed the one-time seed migration.
  new SkillLibrary(store,{...paths,bundledSkillDir:undefined});
  assert.equal(store.data.skillFilesMigrated,true);
  const userDir=join(paths.dataDir,'skills','builtin','custom');mkdirSync(userDir,{recursive:true});
  const custom='---\nname: custom\ndescription: My existing workflow\n---\n\nKeep my instructions.\n';
  writeFileSync(join(userDir,'SKILL.md'),custom);
  const library=new SkillLibrary(store,paths);
  const installed=library.list(bot.id).filter(s=>s.id.startsWith('aelion-'));
  assert.equal(installed.length,8);
  assert.deepEqual(new Set(installed.map(s=>s.id)),new Set(manifest.skills.map(s=>s.id)));
  assert.ok(installed.every(s=>s.body===''&&s.source?.readonly&&s.source.scope==='builtin'));
  assert.equal(readFileSync(join(userDir,'SKILL.md'),'utf8'),custom);
  assert.ok(library.list(bot.id).some(s=>s.name==='custom'));
  for(const skill of installed){
    const full=library.read(bot.id,skill.id);assert.ok(full.body.length>1000);
    assert.equal(library.externalPath(bot.id,skill.id),undefined);
    const bundle=library.bundle(bot.id,skill.id);
    assert.ok(bundle.files.some(f=>f.path==='SKILL.md'&&f.bytes.length>0));
    assert.ok(bundle.files.some(f=>f.path==='NOTICE.md'));
    assert.ok(bundle.files.every(f=>!f.path.includes('..')));
    assert.throws(()=>library.writeResource(bot.id,skill.id,'scripts/change.py','x'),/私有/);
  }
  const added=store.createBot('New Bot','test');
  assert.equal(library.list(added.id).filter(s=>s.id.startsWith('aelion-')).length,8);
});

test('stable builtin identities preserve per-Bot state across installation paths and upgrades',t=>{
  const {root,paths,store}=fixture(t),bot=store.data.bots[0],other=store.createBot('Other','test');
  const oldDir=join(root,'app-v1','assets','skills');cpSync(bundled,oldDir,{recursive:true});
  const old=new SkillLibrary(store,{...paths,bundledSkillDir:oldDir});
  old.manage(bot.id,'aelion-pdf-workbench','archive');old.manage(bot.id,'aelion-presentation-design','pin');
  const newDir=join(root,'app-v2','assets','skills');cpSync(bundled,newDir,{recursive:true});
  const file=join(newDir,'presentation-design','SKILL.md');writeFileSync(file,readFileSync(file,'utf8')+'\nUpdated built-in workflow.\n');
  const upgraded=new SkillLibrary(store,{...paths,bundledSkillDir:newDir});
  assert.ok(!upgraded.list(bot.id).some(s=>s.id==='aelion-pdf-workbench'));
  assert.ok(upgraded.list(other.id).some(s=>s.id==='aelion-pdf-workbench'));
  assert.equal(upgraded.list(bot.id)[0].id,'aelion-presentation-design');
  assert.match(upgraded.read(bot.id,'aelion-presentation-design').body,/Updated built-in/);
  assert.notEqual(old.fingerprint(bot.id,'aelion-presentation-design'),upgraded.fingerprint(bot.id,'aelion-presentation-design'));
});

test('every bundled source retains pinned provenance and full license; helpers ship outside ASAR',()=>{
  assert.equal(new Set(manifest.skills.map(s=>s.id)).size,8);
  assert.deepEqual(readdirSync(bundled,{withFileTypes:true}).filter(f=>f.isDirectory()).map(f=>f.name).sort(),manifest.skills.map(s=>s.directory).sort());
  for(const skill of manifest.skills){
    const dir=join(bundled,skill.directory);
    assert.ok(existsSync(join(dir,'AELION-LICENSE.txt')));
    for(const source of skill.sources){
      assert.match(source.commit,/^[a-f0-9]{40}$/);assert.match(source.sha256,/^[a-f0-9]{64}$/);
      assert.ok(['MIT','Apache-2.0'].includes(source.license));
      assert.equal(createHash('sha256').update(readFileSync(join(dir,source.licenseFile))).digest('hex'),source.licenseSha256);
    }
  }
  const config=JSON.parse(readFileSync(resolve('package.json'),'utf8')).build;
  assert.ok(config.files.includes('assets/skills/**'));
  assert.ok(config.asarUnpack.includes('assets/skills/**'));
});


test('ASAR layout exposes portable bundles at the packaged application lookup path',async t=>{
  const {root,paths,store}=fixture(t);
  const staging=join(root,'staging'),source=join(staging,'assets','skills');
  cpSync(bundled,source,{recursive:true,filter:path=>!path.includes('__pycache__')&&!path.endsWith('.pyc')});
  const {createPackageWithOptions}=await import('@electron/asar');
  const archive=join(root,'resources','app.asar');mkdirSync(dirname(archive),{recursive:true});
  await createPackageWithOptions(staging,archive,{unpackDir:join('assets','skills')});
  const deployed=join(root,'resources','app.asar.unpacked','assets','skills');
  const library=new SkillLibrary(store,{...paths,bundledSkillDir:deployed});
  const bot=store.data.bots[0];
  assert.equal(library.list(bot.id).filter(s=>s.id.startsWith('aelion-')).length,8);
  const files=library.bundle(bot.id,'aelion-presentation-design').files;
  assert.ok(files.some(f=>f.path==='scripts/create_deck.py'&&f.bytes.length>0));
  assert.ok(files.some(f=>f.path==='assets/deck.json'));
});


test('shared skills can be read without a Bot and never expose private skills',t=>{
  const {paths,store}=fixture(t),library=new SkillLibrary(store,paths),bot=store.data.bots[0];
  const privateSkill=library.save(bot.id,'Private-only instructions','private','Private body');
  assert.throws(()=>library.read(undefined,privateSkill.id),/不存在|无权/);
  assert.ok(library.read(undefined,'aelion-pdf-workbench').body.includes('PDF workbench'));
  store.deleteBot(bot.id);library.forgetBot(bot.id);
  assert.equal(store.data.bots.length,0);
  library.refresh();
  assert.equal(library.all().filter(s=>s.id.startsWith('aelion-')).length,8);
  assert.ok(library.read(undefined,'aelion-presentation-design').availableFiles?.includes('scripts/create_deck.py'));
  assert.throws(()=>library.read('missing-bot','aelion-pdf-workbench'),/Bot 不存在/);
});
