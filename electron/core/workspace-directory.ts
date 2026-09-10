export const WORKSPACE_DIRECTORY_SCRIPT=String.raw`
import os,sys,json,pathlib,datetime
a=json.load(sys.stdin)
root=pathlib.Path.cwd().resolve()
folder=(root/a['path']).resolve()
assert folder.is_relative_to(root) and folder.is_dir(), 'Directory is outside workspace or missing'
entries=[]
with os.scandir(folder) as iterator:
    for entry in iterator:
        if entry.is_symlink(): continue
        try:
            directory=entry.is_dir(follow_symlinks=False)
            if not directory and not entry.is_file(follow_symlinks=False): continue
            stat=entry.stat(follow_symlinks=False)
            entries.append({'name':entry.name,'path':str((folder/entry.name).relative_to(root)).replace(os.sep,'/'),'kind':'directory' if directory else 'file','size':0 if directory else stat.st_size,'modifiedAt':datetime.datetime.fromtimestamp(stat.st_mtime,datetime.timezone.utc).isoformat()})
            if len(entries)>500: break
        except OSError: continue
entries.sort(key=lambda e:(e['kind']!='directory',e['name'].casefold()))
print(json.dumps({'path':a['path'],'entries':entries[:500],'truncated':len(entries)>500},ensure_ascii=False))
`;
