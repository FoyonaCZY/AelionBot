/**
 * Options for one short call to a Bot's own model for persona bookkeeping: the birth estimate, relationship
 * appraisal and the character check. The answers are a few dozen tokens, but a model that reasons first spends
 * its output budget on that reasoning (OpenAI reasoning models, Claude adaptive thinking), and the 15-facet birth
 * estimate is longer still; a tight cap left them with no answer. Only generated tokens are billed. The timeout
 * allows for the same reasoning.
 */
export const personaCallOptions = (botId: string, purpose: string) => ({
  botId,
  purpose,
  maxOutputTokens: 4096,
  timeoutMs: 60000,
  retries: 1,
});
