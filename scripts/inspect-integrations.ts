import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {mkdirSync,writeFileSync} from 'node:fs';
import {Store} from '../electron/core/store';
import {SkillLibrary} from '../electron/core/skill-library';
import {discoverMcp,publicEndpoint} from '../electron/core/mcp-config';
const homeDir=process.argv[2]||homedir();
const proofDir=resolve('.local/proof/integration-inspection');mkdirSync(proofDir,{recursive:true});
// Only the inspector's private fixture data is written. Existing agent directories are read-only.
const paths={homeDir,projectDir:resolve('.'),dataDir:join(proofDir,'data'),configDir:join(homeDir,'.aelion'),env:{...process.env}};
const skills=new SkillLibrary(new Store(paths.dataDir),paths);const mcp=discoverMcp(paths);
const report={checkedAt:new Date().toISOString(),skillCount:skills.all().length,skillSources:skills.sources.filter(source=>source.exists),mcpSources:mcp.sources.filter(source=>source.exists),mcpServers:mcp.configs.map(server=>({name:server.name,id:server.id,source:server.source.label,transport:server.transport,endpoint:publicEndpoint(server),enabledBySource:server.enabledBySource,issue:server.issue}))};
writeFileSync(join(proofDir,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
