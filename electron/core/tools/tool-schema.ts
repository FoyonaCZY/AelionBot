import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { ToolDefinition } from '../model/model';
const provider = new AjvJsonSchemaValidator();
const validators = new Map<string, ReturnType<AjvJsonSchemaValidator['getValidator']>>();
export function validateToolArguments(tool: ToolDefinition, args: unknown) {
  const properties = tool.function.parameters.properties as Record<string, unknown> | undefined;
  const value =
    args &&
    typeof args === 'object' &&
    !Array.isArray(args) &&
    properties &&
    !Object.hasOwn(properties, 'reason') &&
    Object.hasOwn(args, 'reason')
      ? Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'reason'))
      : args;
  validateSchema(tool.function.parameters, value, tool.function.name);
}
export function validateSchema(schema: Record<string, unknown>, args: unknown, label: string) {
  const key = JSON.stringify(schema);
  let validator = validators.get(key);
  if (!validator) {
    if (validators.size > 500) validators.clear();
    validator = provider.getValidator(schema);
    validators.set(key, validator);
  }
  const result = validator(args);
  if (!result.valid) throw Error(`${label} 参数不符合 schema：${result.errorMessage.slice(0, 800)}`);
}
