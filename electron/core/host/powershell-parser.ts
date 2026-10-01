import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { windowsPwsh } from './host-platform';
import { win32 } from 'node:path';

/** One node of the PowerShell syntax tree, as emitted by PARSER_SCRIPT. Unknown node types arrive as `Unsupported`. */
export interface PsNode {
  t: string;
  [key: string]: unknown;
}
export type PsParse = { ok: true; ast: PsNode } | { ok: false; reason: string };

// Parses with [System.Management.Automation.Language.Parser] and converts the tree to plain JSON. Nothing is
// executed: the command is parsed exactly as host_execute wraps it (inside `. { ... }`), so text that would
// escape that block fails to parse here. Every node type the policy does not understand becomes `Unsupported`.
const PARSER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 serializes arrays returned from functions as {"value":[...],"Count":n} otherwise.
Remove-TypeData System.Array -ErrorAction SilentlyContinue
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function C($items) { if ($null -eq $items) { return 0 }; return @($items).Count }
function L($items, $depth) { $out = New-Object System.Collections.ArrayList; if ($null -ne $items) { foreach ($item in $items) { [void]$out.Add((N $item $depth)) } }; return ,$out.ToArray() }
function N($a, $d) {
  if ($null -eq $a) { return $null }
  if ($d -gt 60) { return [ordered]@{ t = 'Unsupported'; type = 'depth' } }
  $d++
  switch ($a.GetType().Name) {
    'ScriptBlockAst' { return [ordered]@{ t = 'ScriptBlock'; param = ($null -ne $a.ParamBlock); dynamic = ($null -ne $a.DynamicParamBlock); begin = ($null -ne $a.BeginBlock); process = ($null -ne $a.ProcessBlock); using = (C $a.UsingStatements); requires = ($null -ne $a.ScriptRequirements); end = (N $a.EndBlock $d) } }
    'NamedBlockAst' { return [ordered]@{ t = 'NamedBlock'; traps = (C $a.Traps); statements = (L $a.Statements $d) } }
    'StatementBlockAst' { return [ordered]@{ t = 'StatementBlock'; traps = (C $a.Traps); statements = (L $a.Statements $d) } }
    'PipelineAst' { return [ordered]@{ t = 'Pipeline'; background = [bool]$a.Background; elements = (L $a.PipelineElements $d) } }
    'PipelineChainAst' { return [ordered]@{ t = 'PipelineChain'; op = [string]$a.Operator; background = [bool]$a.Background; lhs = (N $a.LhsPipelineChain $d); rhs = (N $a.RhsPipeline $d) } }
    'CommandAst' { return [ordered]@{ t = 'Command'; invocation = [string]$a.InvocationOperator; elements = (L $a.CommandElements $d); redirections = (L $a.Redirections $d) } }
    'CommandExpressionAst' { return [ordered]@{ t = 'CommandExpression'; expression = (N $a.Expression $d); redirections = (L $a.Redirections $d) } }
    'CommandParameterAst' { return [ordered]@{ t = 'Parameter'; name = [string]$a.ParameterName; text = $a.Extent.Text; argument = (N $a.Argument $d) } }
    'StringConstantExpressionAst' { return [ordered]@{ t = 'String'; value = [string]$a.Value; kind = [string]$a.StringConstantType; text = $a.Extent.Text } }
    'ExpandableStringExpressionAst' { return [ordered]@{ t = 'Expandable'; value = [string]$a.Value; kind = [string]$a.StringConstantType; text = $a.Extent.Text; nested = (L $a.NestedExpressions $d) } }
    'ConstantExpressionAst' { return [ordered]@{ t = 'Constant'; value = [string]$a.Value; type = $a.StaticType.Name; text = $a.Extent.Text } }
    'VariableExpressionAst' { return [ordered]@{ t = 'Variable'; name = [string]$a.VariablePath.UserPath; splatted = [bool]$a.Splatted; text = $a.Extent.Text } }
    'MemberExpressionAst' { return [ordered]@{ t = 'Member'; static = [bool]$a.Static; nullConditional = [bool]$a.NullConditional; target = (N $a.Expression $d); member = (N $a.Member $d) } }
    'InvokeMemberExpressionAst' { return [ordered]@{ t = 'Invoke'; static = [bool]$a.Static; target = (N $a.Expression $d); member = (N $a.Member $d); args = (L $a.Arguments $d) } }
    'IndexExpressionAst' { return [ordered]@{ t = 'Index'; target = (N $a.Target $d); index = (N $a.Index $d) } }
    'ArrayLiteralAst' { return [ordered]@{ t = 'ArrayLiteral'; elements = (L $a.Elements $d) } }
    'ArrayExpressionAst' { return [ordered]@{ t = 'ArrayExpression'; body = (N $a.SubExpression $d) } }
    'SubExpressionAst' { return [ordered]@{ t = 'SubExpression'; body = (N $a.SubExpression $d) } }
    'ParenExpressionAst' { return [ordered]@{ t = 'Paren'; pipeline = (N $a.Pipeline $d) } }
    'BinaryExpressionAst' { return [ordered]@{ t = 'Binary'; op = [string]$a.Operator; left = (N $a.Left $d); right = (N $a.Right $d) } }
    'UnaryExpressionAst' { return [ordered]@{ t = 'Unary'; op = [string]$a.TokenKind; child = (N $a.Child $d) } }
    'ConvertExpressionAst' { return [ordered]@{ t = 'Convert'; type = [string]$a.Type.TypeName.FullName; child = (N $a.Child $d) } }
    'HashtableAst' { $pairs = New-Object System.Collections.ArrayList; foreach ($pair in $a.KeyValuePairs) { [void]$pairs.Add([ordered]@{ key = (N $pair.Item1 $d); value = (N $pair.Item2 $d) }) }; return [ordered]@{ t = 'Hashtable'; pairs = $pairs.ToArray() } }
    'ScriptBlockExpressionAst' { return [ordered]@{ t = 'Block'; body = (N $a.ScriptBlock $d) } }
    'AssignmentStatementAst' { return [ordered]@{ t = 'Assignment'; op = [string]$a.Operator; left = (N $a.Left $d); right = (N $a.Right $d) } }
    'IfStatementAst' { $clauses = New-Object System.Collections.ArrayList; foreach ($clause in $a.Clauses) { [void]$clauses.Add([ordered]@{ condition = (N $clause.Item1 $d); body = (N $clause.Item2 $d) }) }; return [ordered]@{ t = 'If'; clauses = $clauses.ToArray(); else = (N $a.ElseClause $d) } }
    'ForEachStatementAst' { return [ordered]@{ t = 'ForEach'; flags = [string]$a.Flags; parallel = ($null -ne $a.ThrottleLimit); variable = (N $a.Variable $d); condition = (N $a.Condition $d); body = (N $a.Body $d) } }
    'FileRedirectionAst' { if ($a.Location -is [System.Management.Automation.Language.VariableExpressionAst] -and $a.Location.VariablePath.UserPath -eq 'null' -and -not $a.Append) { return [ordered]@{ t = 'NullRedirect'; from = [string]$a.FromStream } }; return [ordered]@{ t = 'Unsupported'; type = 'FileRedirectionAst' } }
    'MergingRedirectionAst' { return [ordered]@{ t = 'MergeRedirect'; from = [string]$a.FromStream; to = [string]$a.ToStream } }
    'ExitStatementAst' { return [ordered]@{ t = 'Exit'; pipeline = (N $a.Pipeline $d) } }
    'ReturnStatementAst' { return [ordered]@{ t = 'Return'; pipeline = (N $a.Pipeline $d) } }
    default { return [ordered]@{ t = 'Unsupported'; type = $a.GetType().Name } }
  }
}
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $id = ''
  try {
    $request = $line | ConvertFrom-Json
    $id = [string]$request.id
    $command = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$request.command))
    $tokens = $null; $errors = $null
    $wrapped = [System.Management.Automation.Language.Parser]::ParseInput(". {\n" + $command + "\n}", [ref]$tokens, [ref]$errors)
    if ($errors.Count) { $out = [ordered]@{ id = $id; ok = $false; reason = 'parse error' } }
    else {
      $inner = [System.Management.Automation.Language.Parser]::ParseInput($command, [ref]$tokens, [ref]$errors)
      if ($errors.Count) { $out = [ordered]@{ id = $id; ok = $false; reason = 'parse error' } }
      else { $out = [ordered]@{ id = $id; ok = $true; ast = (N $inner 0) } }
    }
  } catch { $out = [ordered]@{ id = $id; ok = $false; reason = 'parser failure' } }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Depth 100 -Compress))
  [Console]::Out.Flush()
}
`.replace(/\\n/g, '`n');

const TIMEOUT_MS = 3000,
  MAX_FAILURES = 3;

/**
 * A long-lived PowerShell process that only parses: one request per line, base64 command in, syntax tree out.
 * It runs the same PowerShell host_execute uses, so the tree matches what would run. Any failure answers
 * `ok: false`, which sends the operation to normal review; after repeated failures it stops trying.
 */
export class PowerShellParser {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = '';
  private pending = new Map<string, (result: PsParse) => void>();
  private next = 0;
  private failures = 0;
  constructor(
    private executable = process.platform === 'win32'
      ? windowsPwsh() ||
        win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : undefined,
  ) {}
  parse(command: string): Promise<PsParse> {
    if (!this.executable || this.failures >= MAX_FAILURES)
      return Promise.resolve({ ok: false, reason: 'parser unavailable' });
    if (command.length > 6000) return Promise.resolve({ ok: false, reason: 'too long' });
    const child = this.start();
    if (!child) return Promise.resolve({ ok: false, reason: 'parser unavailable' });
    const id = String(++this.next);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.fail();
        resolve({ ok: false, reason: 'parser timeout' });
      }, TIMEOUT_MS);
      // This timer (not the idle child) keeps the process alive while a parse is outstanding.
      this.pending.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      child.stdin.write(JSON.stringify({ id, command: Buffer.from(command, 'utf8').toString('base64') }) + '\n');
    });
  }
  private start() {
    if (this.child) return this.child;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        this.executable!,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(PARSER_SCRIPT, 'utf16le').toString('base64'),
        ],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch {
      this.fail();
      return;
    }
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line) as { id: string; ok: boolean; ast?: PsNode; reason?: string };
          const done = this.pending.get(message.id);
          if (!done) continue;
          this.pending.delete(message.id);
          this.failures = 0;
          done(
            message.ok && message.ast && typeof message.ast === 'object'
              ? { ok: true, ast: message.ast }
              : { ok: false, reason: message.reason || 'parse error' },
          );
        } catch {}
      }
    });
    child.stderr.on('data', () => {});
    const gone = () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.buffer = '';
      for (const done of this.pending.values()) done({ ok: false, reason: 'parser exited' });
      this.pending.clear();
    };
    child.on('error', () => {
      this.fail();
      gone();
    });
    child.on('exit', gone);
    // The parser must never keep the app (or a test run) alive.
    child.unref();
    (child.stdin as unknown as { unref?: () => void }).unref?.();
    (child.stdout as unknown as { unref?: () => void }).unref?.();
    (child.stderr as unknown as { unref?: () => void }).unref?.();
    return child;
  }
  private fail() {
    this.failures++;
    const child = this.child;
    this.child = undefined;
    try {
      child?.kill();
    } catch {}
  }
  dispose() {
    this.failures = MAX_FAILURES;
    try {
      this.child?.kill();
    } catch {}
    this.child = undefined;
  }
}
