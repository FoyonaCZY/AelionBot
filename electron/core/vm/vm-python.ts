import { VmController, shQuote } from './vm';
// Keep data off the command line. The compatibility branch supports lightweight test adapters.
export function vmPython(
  vm: VmController,
  botId: string,
  args: unknown,
  code: string,
  signal: AbortSignal,
  outputLimit = 2_000_000,
  env?: Record<string, string>,
) {
  if (env && Object.keys(env).length) {
    const input = Buffer.from(JSON.stringify({ a: args, env }), 'utf8');
    const preamble = "import json,os,sys\n_p=json.load(sys.stdin)\nos.environ.update(_p['env'])\na=_p['a']\ndel _p\n";
    if (typeof vm.executePython === 'function')
      return vm.executePython(preamble + code, input, botId, signal, outputLimit);
    return vm.execute('python3 -c ' + shQuote(preamble + code), botId, signal, outputLimit, { inputBytes: input });
  }
  const input = Buffer.from(JSON.stringify(args), 'utf8');
  if (typeof vm.executePython === 'function')
    return vm.executePython('import json,sys\na=json.load(sys.stdin)\n' + code, input, botId, signal, outputLimit);
  return vm.execute(
    'python3 -c ' +
      shQuote(`import json,base64\na=json.loads(base64.b64decode('${input.toString('base64')}'))\n${code}`),
    botId,
    signal,
    outputLimit,
  );
}
