import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { VmController, shQuote } from '../electron/core/vm';

// Independent verification of the synthetic office/code task entered through the UI.
// This script does not generate or repair the Bot's deliverables.
const dataDir=resolve('.local/app');
const saved=JSON.parse(readFileSync(join(dataDir,'state.json'),'utf8'));
const botId=process.argv[2];
const bot=saved.bots.find((item:{id:string})=>item.id===botId);
if(!bot)throw new Error('Pass the existing acceptance Bot ID');
const runs=saved.runs.filter((item:{botId:string})=>item.botId===botId);
const run=process.argv[3]?runs.find((item:{id:string})=>item.id===process.argv[3]):runs.at(-1);
if(!run||run.status!=='completed'||run.toolCalls<1)throw new Error('The UI task has not completed with real tool calls');
const vm=new VmController({dataDir,runtimeDir:resolve('release/win-unpacked/resources/qemu'),cacheDir:join(dataDir,'downloads')});
const proof:{checkedAt:string;botId:string;run:unknown;model:unknown;status:string;result?:unknown;error?:string}={checkedAt:new Date().toISOString(),botId,run,model:{model:saved.model.model,endpointHost:new URL(saved.model.baseUrl).hostname},status:'running'};
const program=String.raw`import csv, json, hashlib, pathlib, subprocess, sys, tempfile, re
root = pathlib.Path.cwd()
rows = list(csv.DictReader((root / 'input.csv').open()))
assert rows == [{'team':'Design','amount':'120'}, {'team':'Engineering','amount':'80'}, {'team':'Design','amount':'50'}, {'team':'Operations','amount':'40'}], rows
by_team = {}
for row in rows:
    by_team[row['team']] = by_team.get(row['team'], 0) + int(row['amount'])
expected = {'byTeam':by_team, 'total':sum(by_team.values())}
report = json.loads((root / 'report.json').read_text())
assert report == expected and report['total'] == 290, report
tests = subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-v'], capture_output=True, text=True, timeout=30)
test_output = tests.stdout + tests.stderr
count = re.search(r'Ran (\d+) tests?', test_output)
assert tests.returncode == 0 and count and int(count.group(1)) >= 3, test_output
negative = []
with tempfile.TemporaryDirectory(prefix='aelion-independent-') as temporary:
    temp = pathlib.Path(temporary)
    for label, body in [('noninteger', 'team,amount\nDesign,nope\n'), ('missing-column', 'team,value\nDesign,12\n')]:
        source = temp / (label + '.csv')
        source.write_text(body)
        result = subprocess.run([sys.executable, str(root / 'summarize.py'), str(source), str(temp / (label+'.json'))], capture_output=True, text=True, timeout=10)
        assert result.returncode != 0 and (result.stdout + result.stderr).strip(), (label, result.returncode)
        negative.append({'case':label,'exitCode':result.returncode,'message':(result.stdout+result.stderr).strip()})
files = {name:hashlib.sha256((root / name).read_bytes()).hexdigest() for name in ['input.csv','report.json','summarize.py','README.md']}
print(json.dumps({'verified':True,'report':report,'testCount':int(count.group(1)),'testOutput':test_output,'negativeCases':negative,'files':files}, ensure_ascii=False))
`;
try {
  await vm.refresh();
  const result=await vm.execute(`python3 -c ${shQuote(program)}`,botId);
  proof.result=result;
  if(result.exitCode!==0)throw new Error('Independent guest verification failed');
  const checked=JSON.parse(result.stdout);
  if(!checked.verified)throw new Error('Missing verification result');
  proof.status='passed';
}catch(error){proof.status='failed';proof.error=(error as Error).message;process.exitCode=1;}
finally{vm.dispose();mkdirSync(resolve('.local/proof'),{recursive:true});writeFileSync(resolve(`.local/proof/workflow-verification-${botId}.json`),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));}
